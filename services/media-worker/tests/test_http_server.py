from __future__ import annotations

import json
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from contracts import make_valid_envelope
from control_plane import LocalAsyncControlPlane
from handler import FakeInferenceHandler
from http_server import WorkerHttpServer


TOKEN = "local-contract-test-token"


def request_json(
    base_url: str,
    method: str,
    path: str,
    *,
    body: object | None = None,
    token: str | None = TOKEN,
) -> tuple[int, dict[str, object]]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = Request(base_url + path, data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=3) as response:
            return response.status, json.loads(response.read())
    except HTTPError as error:
        return error.code, json.loads(error.read())


class HttpServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.control_plane = LocalAsyncControlPlane(FakeInferenceHandler(), max_jobs=1)
        self.server = WorkerHttpServer(
            self.control_plane,
            service_token=TOKEN,
            host="127.0.0.1",
            port=0,
        )
        self.server.start_in_thread()
        host, port = self.server.address
        self.base_url = f"http://{host}:{port}"

    def tearDown(self) -> None:
        self.server.close()

    def test_requires_bearer_service_token(self) -> None:
        status, body = request_json(self.base_url, "POST", "/run", body={}, token=None)
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "UNAUTHORIZED")

        status, body = request_json(self.base_url, "PUT", "/anything", token=None)
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "UNAUTHORIZED")

        status, body = request_json(
            self.base_url, "POST", "/run", body={}, token="wrong"
        )
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "UNAUTHORIZED")

    def test_run_status_and_deduplication(self) -> None:
        envelope = make_valid_envelope(prompt="never echo this prompt")
        status, submitted = request_json(
            self.base_url, "POST", "/run", body=envelope
        )
        self.assertEqual(status, 202)
        self.assertEqual(set(submitted), {"id", "status"})

        deadline = time.monotonic() + 3
        current = None
        while time.monotonic() < deadline:
            status, current = request_json(
                self.base_url, "GET", f"/status/{submitted['id']}"
            )
            self.assertEqual(status, 200)
            if current["status"] == "COMPLETED":
                break
            time.sleep(0.005)
        self.assertIsNotNone(current)
        self.assertEqual(current["status"], "COMPLETED")
        self.assertNotIn("never echo this prompt", json.dumps(current))

        status, duplicate = request_json(
            self.base_url, "POST", "/run", body=envelope
        )
        self.assertEqual(status, 202)
        self.assertEqual(duplicate["id"], submitted["id"])

    def test_changed_payload_conflicts_and_error_is_sanitized(self) -> None:
        first = make_valid_envelope(prompt="first secret")
        changed = make_valid_envelope(prompt="second secret")
        request_json(self.base_url, "POST", "/run", body=first)
        status, body = request_json(self.base_url, "POST", "/run", body=changed)
        self.assertEqual(status, 409)
        self.assertEqual(body["error"]["code"], "IDEMPOTENCY_CONFLICT")
        serialized = json.dumps(body)
        self.assertNotIn("first secret", serialized)
        self.assertNotIn("second secret", serialized)

    def test_cancel_and_not_found(self) -> None:
        status, body = request_json(
            self.base_url,
            "POST",
            "/cancel/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        )
        self.assertEqual(status, 404)
        self.assertEqual(body["error"]["code"], "NOT_FOUND")

    def test_rejects_unknown_and_duplicate_json_fields(self) -> None:
        envelope = make_valid_envelope()
        envelope["input"]["unexpected"] = 1
        status, body = request_json(self.base_url, "POST", "/run", body=envelope)
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "INVALID_REQUEST")

        raw = b'{"input":{},"input":{}}'
        request = Request(
            self.base_url + "/run",
            data=raw,
            headers={
                "Authorization": f"Bearer {TOKEN}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with self.assertRaises(HTTPError) as caught:
            urlopen(request, timeout=3)
        self.assertEqual(caught.exception.code, 400)

    def test_non_loopback_bind_is_refused(self) -> None:
        control_plane = LocalAsyncControlPlane(FakeInferenceHandler())
        try:
            with self.assertRaisesRegex(ValueError, "only to loopback"):
                WorkerHttpServer(
                    control_plane,
                    service_token=TOKEN,
                    host="0.0.0.0",
                    port=0,
                )
        finally:
            control_plane.close()

    def test_short_service_token_is_refused(self) -> None:
        control_plane = LocalAsyncControlPlane(FakeInferenceHandler())
        try:
            with self.assertRaisesRegex(ValueError, "at least 16"):
                WorkerHttpServer(
                    control_plane,
                    service_token="too-short",
                    host="127.0.0.1",
                    port=0,
                )
        finally:
            control_plane.close()

    def test_status_and_cancel_paths_require_real_uuid_shape(self) -> None:
        invalid_version = "aaaaaaaa-aaaa-9aaa-8aaa-aaaaaaaaaaaa"
        status, body = request_json(
            self.base_url, "GET", f"/status/{invalid_version}"
        )
        self.assertEqual(status, 404)
        self.assertEqual(body["error"]["code"], "NOT_FOUND")

    def test_capacity_error_is_sanitized_and_retryable(self) -> None:
        first = make_valid_envelope()
        second = make_valid_envelope(
            jobRef="22222222-2222-4222-8222-222222222222"
        )
        self.assertEqual(
            request_json(self.base_url, "POST", "/run", body=first)[0],
            202,
        )
        status, body = request_json(self.base_url, "POST", "/run", body=second)
        self.assertEqual(status, 503)
        self.assertEqual(body["error"]["code"], "WORKER_CAPACITY")
        self.assertTrue(body["error"]["retryable"])


if __name__ == "__main__":
    unittest.main()
