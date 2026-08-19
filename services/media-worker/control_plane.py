"""Process-local asynchronous control plane for the local worker HTTP mode."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
import threading
import time
from typing import Callable
import uuid

from contracts import InferenceRequestV1
from handler import (
    ExecutionContext,
    InferenceCancelled,
    InferenceFailed,
    InferenceHandler,
    InferenceTimedOut,
    InferenceUnavailable,
)


STATUSES = frozenset(
    {
        "IN_QUEUE",
        "IN_PROGRESS",
        "COMPLETED",
        "FAILED",
        "CANCELLED",
        "TIMED_OUT",
        "RESULT_EXPIRED",
    }
)
TERMINAL_STATUSES = frozenset(
    {"COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "RESULT_EXPIRED"}
)


class IdempotencyConflict(RuntimeError):
    pass


class JobNotFound(LookupError):
    pass


class WorkerCapacityExceeded(RuntimeError):
    pass


@dataclass(slots=True)
class _Job:
    id: str
    request: InferenceRequestV1
    status: str = "IN_QUEUE"
    submitted_at: float = 0.0
    started_at: float | None = None
    finished_at: float | None = None
    output: dict[str, object] | None = None
    error: dict[str, object] | None = None
    usage: dict[str, object] | None = None
    timings: dict[str, object] | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event)


def _safe_error(code: str, message: str, retryable: bool) -> dict[str, object]:
    return {"code": code, "message": message, "retryable": retryable}


class LocalAsyncControlPlane:
    """Bounded in-memory control plane; not a durable production queue."""

    def __init__(
        self,
        handler: InferenceHandler,
        *,
        max_workers: int = 2,
        job_timeout_ms: int = 30_000,
        result_ttl_ms: int = 15 * 60 * 1000,
        max_jobs: int = 1_000,
        billable_execution: bool = False,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        if max_workers < 1:
            raise ValueError("max_workers must be positive")
        if job_timeout_ms < 1 or result_ttl_ms < 1:
            raise ValueError("timeouts must be positive")
        if max_jobs < 1 or max_jobs > 100_000:
            raise ValueError("max_jobs is outside its allowed range")
        self._handler = handler
        self._job_timeout_ms = job_timeout_ms
        self._result_ttl_ms = result_ttl_ms
        self._max_jobs = max_jobs
        if not isinstance(billable_execution, bool):
            raise ValueError("billable_execution must be boolean")
        self._billable_execution = billable_execution
        self._monotonic = monotonic
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="yeeyoo-media-fake",
        )
        self._lock = threading.RLock()
        self._jobs: dict[str, _Job] = {}
        self._job_ref_index: dict[str, str] = {}
        self._closed = False

    def submit(self, request: InferenceRequestV1) -> dict[str, str]:
        now = self._monotonic()
        with self._lock:
            if self._closed:
                raise RuntimeError("control plane is closed")
            self._purge_locked(now)
            existing_id = self._job_ref_index.get(request.job_ref)
            if existing_id is not None:
                existing = self._jobs[existing_id]
                if existing.request.request_hash != request.request_hash:
                    raise IdempotencyConflict()
                return {"id": existing.id, "status": existing.status}
            if len(self._jobs) >= self._max_jobs:
                raise WorkerCapacityExceeded()

            job_id = str(uuid.uuid4())
            job = _Job(id=job_id, request=request, submitted_at=now)
            self._jobs[job_id] = job
            self._job_ref_index[request.job_ref] = job_id
            self._executor.submit(self._execute, job_id)
            return {"id": job_id, "status": job.status}

    def _expire_completed_locked(self, job: _Job, now: float) -> None:
        if (
            job.status == "COMPLETED"
            and job.finished_at is not None
            and (now - job.finished_at) * 1000 >= self._result_ttl_ms
        ):
            job.status = "RESULT_EXPIRED"
            job.output = None
            job.error = _safe_error(
                "RESULT_EXPIRED",
                "Result is no longer available",
                True,
            )
            job.finished_at = now

    def _purge_locked(self, now: float) -> None:
        remove: list[str] = []
        for job_id, job in self._jobs.items():
            self._expire_completed_locked(job, now)
            if (
                job.status in TERMINAL_STATUSES
                and job.status != "COMPLETED"
                and job.finished_at is not None
                and (now - job.finished_at) * 1000 >= self._result_ttl_ms
            ):
                remove.append(job_id)
        for job_id in remove:
            job = self._jobs.pop(job_id)
            self._job_ref_index.pop(job.request.job_ref, None)

    def _execute(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs[job_id]
            if job.status == "CANCELLED":
                return
            job.status = "IN_PROGRESS"
            job.started_at = self._monotonic()
            deadline = job.started_at + self._job_timeout_ms / 1000.0

        context = ExecutionContext(job.cancel_event, deadline)
        try:
            output = self._handler.handle(job.request, context)
        except InferenceCancelled:
            self._finish(
                job_id,
                "CANCELLED",
                error=_safe_error("JOB_CANCELLED", "Job was cancelled", False),
            )
        except InferenceTimedOut:
            self._finish(
                job_id,
                "TIMED_OUT",
                error=_safe_error("WORKER_TIMEOUT", "Image generation timed out", True),
            )
        except InferenceFailed:
            self._finish(
                job_id,
                "FAILED",
                error=_safe_error("INFERENCE_FAILED", "Image generation failed", True),
            )
        except InferenceUnavailable:
            self._finish(
                job_id,
                "FAILED",
                error=_safe_error("PROVIDER_PERMANENT", "Image model is unavailable", False),
            )
        except Exception:
            # No stack, exception detail or provider payload crosses this boundary.
            self._finish(
                job_id,
                "FAILED",
                error=_safe_error("INTERNAL_ERROR", "Image generation failed", False),
            )
        else:
            with self._lock:
                job = self._jobs[job_id]
                if job.cancel_event.is_set() or job.status == "CANCELLED":
                    self._finish_locked(
                        job,
                        "CANCELLED",
                        error=_safe_error("JOB_CANCELLED", "Job was cancelled", False),
                    )
                else:
                    self._finish_locked(job, "COMPLETED", output=output)

    def _finish(
        self,
        job_id: str,
        status: str,
        *,
        output: dict[str, object] | None = None,
        error: dict[str, object] | None = None,
    ) -> None:
        with self._lock:
            self._finish_locked(self._jobs[job_id], status, output=output, error=error)

    def _finish_locked(
        self,
        job: _Job,
        status: str,
        *,
        output: dict[str, object] | None = None,
        error: dict[str, object] | None = None,
    ) -> None:
        if job.status == "CANCELLED" and status != "CANCELLED":
            return
        finished_at = self._monotonic()
        queue_ms = None if job.started_at is None else max(0, round((job.started_at - job.submitted_at) * 1000))
        execution_seconds = 0.0 if job.started_at is None else max(0.0, finished_at - job.started_at)
        output_timings = output.get("timings") if isinstance(output, dict) else None
        observed_gpu = output_timings.get("gpuActiveSeconds") if isinstance(output_timings, dict) else None
        gpu_seconds = float(observed_gpu) if isinstance(observed_gpu, (int, float)) and observed_gpu >= 0 else (execution_seconds if self._billable_execution else 0.0)
        billable = self._billable_execution and job.started_at is not None and gpu_seconds > 0
        job.status = status
        job.output = output
        job.error = error
        job.finished_at = finished_at
        job.usage = {"gpu_seconds": round(gpu_seconds, 6), "billable": billable}
        job.timings = {
            "queue_ms": queue_ms,
            "inference_ms": round(execution_seconds * 1000),
            "total_ms": max(0, round((finished_at - job.submitted_at) * 1000)),
        }

    def get_status(self, job_id: str) -> dict[str, object]:
        with self._lock:
            now = self._monotonic()
            self._purge_locked(now)
            job = self._jobs.get(job_id)
            if job is None:
                raise JobNotFound()

            result: dict[str, object] = {"id": job.id, "status": job.status}
            if job.started_at is not None:
                result["delayTime"] = max(
                    0, round((job.started_at - job.submitted_at) * 1000)
                )
            if job.started_at is not None and job.finished_at is not None:
                result["executionTime"] = max(
                    0, round((job.finished_at - job.started_at) * 1000)
                )
            if job.output is not None and job.status == "COMPLETED":
                result["output"] = job.output
            if job.error is not None:
                result["error"] = job.error
            if job.usage is not None:
                result["usage"] = dict(job.usage)
            if job.timings is not None:
                result["timings"] = dict(job.timings)
            return result

    def cancel(self, job_id: str) -> dict[str, str]:
        with self._lock:
            self._purge_locked(self._monotonic())
            job = self._jobs.get(job_id)
            if job is None:
                raise JobNotFound()
            if job.status not in TERMINAL_STATUSES:
                job.cancel_event.set()
                self._finish_locked(
                    job,
                    "CANCELLED",
                    error=_safe_error("JOB_CANCELLED", "Job was cancelled", False),
                )
            return {"id": job.id, "status": job.status}

    def close(self) -> None:
        with self._lock:
            self._closed = True
        self._executor.shutdown(wait=True, cancel_futures=True)

    def __enter__(self) -> "LocalAsyncControlPlane":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()
