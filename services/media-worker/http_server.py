"""Loopback-only authenticated HTTP wrapper for the local control plane."""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import ipaddress
import json
import re
import threading
from typing import Any, Callable

from contracts import ContractError, UUID_TEXT_PATTERN, parse_run_envelope
from control_plane import (
    IdempotencyConflict,
    JobNotFound,
    LocalAsyncControlPlane,
    WorkerCapacityExceeded,
)


MAX_REQUEST_BYTES = 32 * 1024
_STATUS_PATH = re.compile(rf"^/status/({UUID_TEXT_PATTERN})$", re.IGNORECASE)
_CANCEL_PATH = re.compile(rf"^/cancel/({UUID_TEXT_PATTERN})$", re.IGNORECASE)


def _reject_json_constant(_value: str) -> None:
    raise ValueError("non-finite numbers are not valid JSON")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate object key")
        result[key] = value
    return result


def _json_loads_strict(raw: bytes) -> object:
    return json.loads(
        raw.decode("utf-8"),
        parse_constant=_reject_json_constant,
        object_pairs_hook=_unique_object,
    )


def _error_body(code: str, message: str, retryable: bool = False) -> dict[str, object]:
    return {"error": {"code": code, "message": message, "retryable": retryable}}


def _handler_factory(
    control_plane: LocalAsyncControlPlane,
    service_token: str,
) -> type[BaseHTTPRequestHandler]:
    class WorkerRequestHandler(BaseHTTPRequestHandler):
        server_version = "YeeyooMediaWorker/1"
        sys_version = ""

        def version_string(self) -> str:
            return self.server_version

        def log_message(self, _format: str, *_args: object) -> None:
            # Intentionally silent. Request bodies/prompts and authorization
            # headers must never enter default HTTP logs.
            return

        def _authorized(self) -> bool:
            authorization = self.headers.get("Authorization", "")
            prefix = "Bearer "
            if not authorization.startswith(prefix):
                return False
            presented = authorization[len(prefix) :]
            return hmac.compare_digest(presented, service_token)

        def _write_json(self, status: int, body: object) -> None:
            encoded = json.dumps(
                body,
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(encoded)

        def _require_auth(self) -> bool:
            if self._authorized():
                return True
            self._write_json(
                401,
                _error_body("UNAUTHORIZED", "Valid service authentication is required"),
            )
            return False

        def _read_json_body(self) -> object:
            content_type = self.headers.get("Content-Type", "")
            if content_type.split(";", 1)[0].strip().lower() != "application/json":
                raise ContractError("Content-Type must be application/json")
            raw_length = self.headers.get("Content-Length")
            if raw_length is None:
                raise ContractError("Content-Length is required")
            try:
                length = int(raw_length)
            except ValueError as exc:
                raise ContractError("Content-Length is invalid") from exc
            if length < 0:
                raise ContractError("Content-Length is invalid")
            if length > MAX_REQUEST_BYTES:
                raise OverflowError()
            raw = self.rfile.read(length)
            try:
                return _json_loads_strict(raw)
            except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
                raise ContractError("request body must contain valid JSON") from exc

        def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
            if not self._require_auth():
                return
            match = _STATUS_PATH.fullmatch(self.path)
            if match is None:
                self._write_json(404, _error_body("NOT_FOUND", "Resource not found"))
                return
            try:
                body = control_plane.get_status(match.group(1))
            except JobNotFound:
                self._write_json(404, _error_body("NOT_FOUND", "Job not found"))
                return
            self._write_json(200, body)

        def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
            if not self._require_auth():
                return
            if self.path == "/run":
                self._run()
                return
            match = _CANCEL_PATH.fullmatch(self.path)
            if match is not None:
                try:
                    body = control_plane.cancel(match.group(1))
                except JobNotFound:
                    self._write_json(404, _error_body("NOT_FOUND", "Job not found"))
                    return
                self._write_json(200, body)
                return
            self._write_json(404, _error_body("NOT_FOUND", "Resource not found"))

        def _run(self) -> None:
            try:
                envelope = self._read_json_body()
                request = parse_run_envelope(envelope)
                body = control_plane.submit(request)
            except OverflowError:
                self._write_json(
                    413,
                    _error_body("PAYLOAD_TOO_LARGE", "Request body is too large"),
                )
                return
            except ContractError as exc:
                self._write_json(400, {"error": exc.as_error()})
                return
            except IdempotencyConflict:
                self._write_json(
                    409,
                    _error_body(
                        "IDEMPOTENCY_CONFLICT",
                        "jobRef is already bound to a different request",
                    ),
                )
                return
            except WorkerCapacityExceeded:
                self._write_json(
                    503,
                    _error_body(
                        "WORKER_CAPACITY",
                        "Worker capacity is temporarily exhausted",
                        True,
                    ),
                )
                return
            except Exception:
                self._write_json(
                    500,
                    _error_body("INTERNAL_ERROR", "Request could not be processed"),
                )
                return
            self._write_json(202, body)

        def do_PUT(self) -> None:  # noqa: N802 - stdlib handler API
            if not self._require_auth():
                return
            self._write_json(405, _error_body("METHOD_NOT_ALLOWED", "Method not allowed"))

        do_DELETE = do_PUT
        do_PATCH = do_PUT
        do_HEAD = do_PUT
        do_OPTIONS = do_PUT

    return WorkerRequestHandler


class WorkerHttpServer:
    def __init__(
        self,
        control_plane: LocalAsyncControlPlane,
        *,
        service_token: str,
        host: str = "127.0.0.1",
        port: int = 0,
    ) -> None:
        try:
            address = ipaddress.ip_address(host)
        except ValueError as exc:
            raise ValueError("host must be a numeric loopback address") from exc
        if not address.is_loopback:
            raise ValueError("local HTTP server may bind only to loopback")
        if (
            not service_token
            or len(service_token) < 16
            or service_token.strip() != service_token
        ):
            raise ValueError("a service token of at least 16 characters is required")
        self._control_plane = control_plane
        self._httpd = ThreadingHTTPServer(
            (host, port),
            _handler_factory(control_plane, service_token),
        )
        self._thread: threading.Thread | None = None

    @property
    def address(self) -> tuple[str, int]:
        host, port = self._httpd.server_address[:2]
        return str(host), int(port)

    def start_in_thread(self) -> threading.Thread:
        if self._thread is not None:
            raise RuntimeError("server has already been started")
        self._thread = threading.Thread(
            target=self._httpd.serve_forever,
            name="yeeyoo-media-worker-http",
            daemon=True,
        )
        self._thread.start()
        return self._thread

    def serve_forever(self) -> None:
        self._httpd.serve_forever()

    def close(self) -> None:
        if self._thread is not None:
            self._httpd.shutdown()
            self._thread.join(timeout=5)
        self._httpd.server_close()
        self._control_plane.close()

    def __enter__(self) -> "WorkerHttpServer":
        self.start_in_thread()
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()
