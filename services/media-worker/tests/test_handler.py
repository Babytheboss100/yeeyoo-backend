from __future__ import annotations

import base64
import hashlib
import json
import struct
import threading
import time
import unittest

from contracts import make_valid_envelope, parse_run_envelope
from handler import (
    ExecutionContext,
    FakeInferenceHandler,
    InferenceCancelled,
    InferenceFailed,
    InferenceUnavailable,
    InferenceTimedOut,
    MAX_INLINE_IMAGE_BYTES,
    RealInferenceHandler,
)


def context(timeout_seconds: float = 5.0) -> ExecutionContext:
    return ExecutionContext(threading.Event(), time.monotonic() + timeout_seconds)


class HandlerTests(unittest.TestCase):
    def test_deterministic_png_and_exact_metadata(self) -> None:
        request = parse_run_envelope(make_valid_envelope(prompt="sensitive prompt"))
        handler = FakeInferenceHandler()
        first = handler.handle(request, context())
        second = handler.handle(request, context())

        self.assertEqual(first["output"]["dataBase64"], second["output"]["dataBase64"])
        png = base64.b64decode(first["output"]["dataBase64"], validate=True)
        self.assertTrue(png.startswith(b"\x89PNG\r\n\x1a\n"))
        width, height = struct.unpack(">II", png[16:24])
        self.assertEqual((width, height), (request.width, request.height))
        self.assertEqual(first["output"]["mimeType"], "image/png")
        self.assertEqual(first["output"]["sizeBytes"], len(png))
        self.assertEqual(first["output"]["sha256"], hashlib.sha256(png).hexdigest())
        self.assertLessEqual(len(png), MAX_INLINE_IMAGE_BYTES)
        self.assertEqual(first["provenance"]["runtime"], "fake-v1")
        self.assertEqual(first["provenance"]["modelRevision"], "fake")
        self.assertEqual(first["timings"]["queueMs"], None)
        self.assertEqual(first["timings"]["gpuActiveSeconds"], 0)
        self.assertEqual(
            first["timings"]["sources"]["gpuActiveSeconds"],
            "worker_observed",
        )
        self.assertNotIn("sensitive prompt", json.dumps(first))

    def test_full_canonical_request_drives_png_without_rendering_prompt(self) -> None:
        first_request = parse_run_envelope(make_valid_envelope(prompt="alpha", seed=7))
        second_request = parse_run_envelope(make_valid_envelope(prompt="beta", seed=7))
        handler = FakeInferenceHandler()
        first = handler.handle(first_request, context())
        second = handler.handle(second_request, context())
        self.assertNotEqual(
            first["output"]["dataBase64"], second["output"]["dataBase64"]
        )

    def test_cancellation_is_cooperative(self) -> None:
        cancel_event = threading.Event()
        cancel_event.set()
        request = parse_run_envelope(make_valid_envelope())
        with self.assertRaises(InferenceCancelled):
            FakeInferenceHandler(delay_ms=20).handle(
                request,
                ExecutionContext(cancel_event, time.monotonic() + 1),
            )

    def test_deadline_and_forced_timeout(self) -> None:
        request = parse_run_envelope(make_valid_envelope())
        with self.assertRaises(InferenceTimedOut):
            FakeInferenceHandler(delay_ms=20).handle(
                request,
                ExecutionContext(threading.Event(), time.monotonic() + 0.001),
            )
        with self.assertRaises(InferenceTimedOut):
            FakeInferenceHandler(forced_timeout_ms=1).handle(request, context())

    def test_failure_injection_is_deterministic(self) -> None:
        request = parse_run_envelope(make_valid_envelope())
        with self.assertRaises(InferenceFailed):
            FakeInferenceHandler(fail_rate=1.0).handle(request, context())

    def test_real_mode_is_fail_closed_without_pinned_weights(self) -> None:
        request = parse_run_envelope(make_valid_envelope())
        with self.assertRaises(InferenceUnavailable):
            RealInferenceHandler().handle(request, context())


if __name__ == "__main__":
    unittest.main()
