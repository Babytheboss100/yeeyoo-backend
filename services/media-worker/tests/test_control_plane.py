from __future__ import annotations

import threading
import time
import unittest

from contracts import make_valid_envelope, parse_run_envelope
from control_plane import (
    IdempotencyConflict,
    LocalAsyncControlPlane,
    STATUSES,
    WorkerCapacityExceeded,
)
from handler import ExecutionContext, FakeInferenceHandler, InferenceHandler


def wait_for_status(
    control_plane: LocalAsyncControlPlane,
    job_id: str,
    expected: set[str],
    timeout: float = 3.0,
) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = control_plane.get_status(job_id)
        if status["status"] in expected:
            return status
        time.sleep(0.005)
    raise AssertionError(f"job did not reach one of {expected}")


class GateHandler(InferenceHandler):
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()
        self.delegate = FakeInferenceHandler()

    def handle(self, request, context: ExecutionContext):
        self.started.set()
        while not self.release.wait(0.005):
            context.checkpoint()
        return self.delegate.handle(request, context)


class ControlPlaneTests(unittest.TestCase):
    def test_all_declared_statuses_are_present(self) -> None:
        self.assertEqual(
            STATUSES,
            {
                "IN_QUEUE",
                "IN_PROGRESS",
                "COMPLETED",
                "FAILED",
                "CANCELLED",
                "TIMED_OUT",
                "RESULT_EXPIRED",
            },
        )

    def test_submit_complete_and_deduplicate(self) -> None:
        request = parse_run_envelope(make_valid_envelope())
        with LocalAsyncControlPlane(FakeInferenceHandler()) as control_plane:
            submitted = control_plane.submit(request)
            final = wait_for_status(control_plane, submitted["id"], {"COMPLETED"})
            duplicate = control_plane.submit(request)
            self.assertEqual(duplicate["id"], submitted["id"])
            self.assertEqual(duplicate["status"], "COMPLETED")
            self.assertIn("output", final)
            self.assertIn("delayTime", final)
            self.assertIn("executionTime", final)
            self.assertEqual(final["usage"], {"gpu_seconds": 0.0, "billable": False})
            self.assertIn("timings", final)

    def test_same_job_ref_changed_valid_payload_conflicts(self) -> None:
        original = parse_run_envelope(make_valid_envelope(prompt="one"))
        changed = parse_run_envelope(make_valid_envelope(prompt="two"))
        with LocalAsyncControlPlane(FakeInferenceHandler()) as control_plane:
            control_plane.submit(original)
            with self.assertRaises(IdempotencyConflict):
                control_plane.submit(changed)

    def test_queue_progress_and_cancel_transitions(self) -> None:
        gate = GateHandler()
        first = parse_run_envelope(make_valid_envelope())
        second = parse_run_envelope(
            make_valid_envelope(jobRef="22222222-2222-4222-8222-222222222222")
        )
        control_plane = LocalAsyncControlPlane(gate, max_workers=1)
        try:
            first_job = control_plane.submit(first)
            self.assertTrue(gate.started.wait(1))
            self.assertEqual(
                control_plane.get_status(first_job["id"])["status"], "IN_PROGRESS"
            )
            second_job = control_plane.submit(second)
            self.assertEqual(
                control_plane.get_status(second_job["id"])["status"], "IN_QUEUE"
            )
            cancelled = control_plane.cancel(second_job["id"])
            self.assertEqual(cancelled["status"], "CANCELLED")
            self.assertEqual(
                control_plane.get_status(second_job["id"])["error"]["code"],
                "JOB_CANCELLED",
            )
            gate.release.set()
            wait_for_status(control_plane, first_job["id"], {"COMPLETED"})
        finally:
            gate.release.set()
            control_plane.close()

    def test_failure_and_timeout_are_sanitized(self) -> None:
        prompt = "RAW-PROMPT-MUST-STAY-PRIVATE"
        request = parse_run_envelope(make_valid_envelope(prompt=prompt))
        with LocalAsyncControlPlane(FakeInferenceHandler(fail_rate=1.0)) as control_plane:
            job = control_plane.submit(request)
            failed = wait_for_status(control_plane, job["id"], {"FAILED"})
            self.assertEqual(failed["error"]["code"], "INFERENCE_FAILED")
            self.assertNotIn(prompt, str(failed))

        with LocalAsyncControlPlane(
            FakeInferenceHandler(delay_ms=100), job_timeout_ms=5
        ) as control_plane:
            job = control_plane.submit(request)
            timed_out = wait_for_status(control_plane, job["id"], {"TIMED_OUT"})
            self.assertEqual(timed_out["error"]["code"], "WORKER_TIMEOUT")
            self.assertTrue(timed_out["error"]["retryable"])

    def test_billable_execution_preserves_usage_on_failure_and_timeout(self) -> None:
        request = parse_run_envelope(make_valid_envelope())
        with LocalAsyncControlPlane(
            FakeInferenceHandler(fail_rate=1.0, delay_ms=5),
            billable_execution=True,
        ) as control_plane:
            job = control_plane.submit(request)
            failed = wait_for_status(control_plane, job["id"], {"FAILED"})
            self.assertTrue(failed["usage"]["billable"])
            self.assertGreater(failed["usage"]["gpu_seconds"], 0)

        with LocalAsyncControlPlane(
            FakeInferenceHandler(delay_ms=100),
            job_timeout_ms=5,
            billable_execution=True,
        ) as control_plane:
            job = control_plane.submit(request)
            timed_out = wait_for_status(control_plane, job["id"], {"TIMED_OUT"})
            self.assertTrue(timed_out["usage"]["billable"])
            self.assertGreater(timed_out["usage"]["gpu_seconds"], 0)

    def test_completed_result_expires_and_is_removed(self) -> None:
        request = parse_run_envelope(make_valid_envelope())
        with LocalAsyncControlPlane(
            FakeInferenceHandler(), result_ttl_ms=10
        ) as control_plane:
            job = control_plane.submit(request)
            wait_for_status(control_plane, job["id"], {"COMPLETED"})
            time.sleep(0.02)
            expired = control_plane.get_status(job["id"])
            self.assertEqual(expired["status"], "RESULT_EXPIRED")
            self.assertNotIn("output", expired)
            self.assertEqual(expired["error"]["code"], "RESULT_EXPIRED")
            self.assertTrue(expired["error"]["retryable"])
            self.assertEqual(expired["usage"], {"gpu_seconds": 0.0, "billable": False})

    def test_registry_capacity_is_bounded_and_terminal_records_are_evicted(self) -> None:
        gate = GateHandler()
        first = parse_run_envelope(make_valid_envelope())
        second = parse_run_envelope(
            make_valid_envelope(jobRef="22222222-2222-4222-8222-222222222222")
        )
        now = [0.0]
        control_plane = LocalAsyncControlPlane(
            gate,
            max_workers=1,
            max_jobs=1,
            result_ttl_ms=10,
            monotonic=lambda: now[0],
        )
        try:
            first_job = control_plane.submit(first)
            self.assertTrue(gate.started.wait(1))
            with self.assertRaises(WorkerCapacityExceeded):
                control_plane.submit(second)
            self.assertEqual(control_plane.cancel(first_job["id"])["status"], "CANCELLED")
            now[0] = 0.02
            second_job = control_plane.submit(second)
            self.assertNotEqual(second_job["id"], first_job["id"])
        finally:
            gate.release.set()
            control_plane.close()


if __name__ == "__main__":
    unittest.main()
