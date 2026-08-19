"""Versioned synchronous inference-handler contract and fake implementation."""

from __future__ import annotations

from abc import ABC, abstractmethod
import base64
from dataclasses import dataclass
import hashlib
import threading
import time
from typing import Callable

from contracts import InferenceRequestV1, MODEL_REVISION, SCHEMA_VERSION
from fake import deterministic_png


MAX_INLINE_IMAGE_BYTES = 6 * 1024 * 1024


class InferenceCancelled(RuntimeError):
    pass


class InferenceTimedOut(RuntimeError):
    pass


class InferenceFailed(RuntimeError):
    """Internal inference failure. Its detail must never cross the boundary."""


class InferenceUnavailable(RuntimeError):
    """Real execution is unavailable without approved, pinned model bytes."""


@dataclass(frozen=True, slots=True)
class ExecutionContext:
    cancel_event: threading.Event
    deadline_monotonic: float

    def checkpoint(self, monotonic: Callable[[], float] = time.monotonic) -> None:
        if self.cancel_event.is_set():
            raise InferenceCancelled()
        if monotonic() >= self.deadline_monotonic:
            raise InferenceTimedOut()


class InferenceHandler(ABC):
    """RunPod-compatible synchronous boundary, independent of local job state."""

    schema_version = SCHEMA_VERSION

    @abstractmethod
    def handle(
        self,
        request: InferenceRequestV1,
        context: ExecutionContext,
    ) -> dict[str, object]:
        raise NotImplementedError


class FakeInferenceHandler(InferenceHandler):
    def __init__(
        self,
        *,
        delay_ms: int = 0,
        fail_rate: float = 0.0,
        forced_timeout_ms: int = 0,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        if delay_ms < 0 or forced_timeout_ms < 0:
            raise ValueError("fake timing values must not be negative")
        if fail_rate < 0.0 or fail_rate > 1.0:
            raise ValueError("fake failure rate must be between zero and one")
        self._delay_ms = delay_ms
        self._fail_rate = fail_rate
        self._forced_timeout_ms = forced_timeout_ms
        self._sleep = sleep
        self._monotonic = monotonic

    def _interruptible_wait(self, milliseconds: int, context: ExecutionContext) -> None:
        remaining = milliseconds / 1000.0
        while remaining > 0:
            context.checkpoint(self._monotonic)
            interval = min(remaining, 0.01)
            self._sleep(interval)
            remaining -= interval
        context.checkpoint(self._monotonic)

    def _should_fail(self, request: InferenceRequestV1) -> bool:
        if self._fail_rate <= 0.0:
            return False
        sample = int(request.request_hash[:8], 16) / 0xFFFFFFFF
        return sample < self._fail_rate

    def handle(
        self,
        request: InferenceRequestV1,
        context: ExecutionContext,
    ) -> dict[str, object]:
        handler_started = self._monotonic()
        context.checkpoint(self._monotonic)

        if self._forced_timeout_ms:
            self._interruptible_wait(self._forced_timeout_ms, context)
            raise InferenceTimedOut()

        if self._delay_ms:
            self._interruptible_wait(self._delay_ms, context)

        if self._should_fail(request):
            raise InferenceFailed()

        load_started = self._monotonic()
        # Fake runtime has no model or weights to load.
        load_ms = max(0, round((self._monotonic() - load_started) * 1000))

        inference_started = self._monotonic()
        png = deterministic_png(request.canonical_json, request.width, request.height)
        inference_ms = max(0, round((self._monotonic() - inference_started) * 1000))
        context.checkpoint(self._monotonic)

        if len(png) > MAX_INLINE_IMAGE_BYTES:
            raise InferenceFailed()
        data_base64 = base64.b64encode(png).decode("ascii")

        handler_total_ms = max(0, round((self._monotonic() - handler_started) * 1000))
        return {
            "schemaVersion": SCHEMA_VERSION,
            "jobRef": request.job_ref,
            "requestHash": request.request_hash,
            "output": {
                "transport": "inline_base64",
                "mimeType": "image/png",
                "dataBase64": data_base64,
                "width": request.width,
                "height": request.height,
                "sizeBytes": len(png),
                "sha256": hashlib.sha256(png).hexdigest(),
            },
            "provenance": {
                "model": request.model,
                "modelRevision": MODEL_REVISION,
                "seed": request.seed,
                "steps": request.steps,
                "runtime": "fake-v1",
            },
            "timings": {
                "queueMs": None,
                "loadMs": load_ms,
                "inferenceMs": inference_ms,
                "handlerTotalMs": handler_total_ms,
                "gpuActiveSeconds": 0,
                "sources": {
                    "queueMs": "provider",
                    "loadMs": "worker_observed",
                    "inferenceMs": "worker_observed",
                    "handlerTotalMs": "worker_observed",
                    "gpuActiveSeconds": "worker_observed",
                },
            },
        }


class RealInferenceHandler(InferenceHandler):
    """Fail-closed real-mode boundary; no downloader exists in this worker."""

    def handle(
        self,
        request: InferenceRequestV1,
        context: ExecutionContext,
    ) -> dict[str, object]:
        context.checkpoint()
        from inference import RealModeLocked, run_real

        try:
            run_real(request)
        except RealModeLocked as exc:
            raise InferenceUnavailable() from exc
        raise InferenceUnavailable()


def select_inference_handler(*, fake_execution: bool) -> InferenceHandler:
    return FakeInferenceHandler() if fake_execution else RealInferenceHandler()


def _serve_cli() -> None:
    """Small local-only hook used by Node cross-language contract tests."""

    import argparse
    import json
    import os
    import sys

    parser = argparse.ArgumentParser(description="Run the local fake image worker")
    parser.add_argument("--serve", action="store_true", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()

    token = os.environ.get("MEDIA_WORKER_SERVICE_TOKEN")
    if not token or len(token) < 16:
        raise SystemExit("MEDIA_WORKER_SERVICE_TOKEN must contain at least 16 characters")

    # Avoid loading this source a second time as module ``handler`` when the
    # control-plane module imports the handler contract.
    sys.modules.setdefault("handler", sys.modules[__name__])
    from control_plane import LocalAsyncControlPlane
    from http_server import WorkerHttpServer

    control_plane = LocalAsyncControlPlane(
        select_inference_handler(fake_execution=os.environ.get("FAKE_EXECUTION") == "1")
    )
    server = WorkerHttpServer(
        control_plane,
        service_token=token,
        host=args.host,
        port=args.port,
    )
    _host, actual_port = server.address
    print(
        "READY " + json.dumps({"port": actual_port}, separators=(",", ":")),
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.close()


if __name__ == "__main__":
    _serve_cli()
