"""Local fake-worker entry point. No outbound network or model access."""

from __future__ import annotations

import os

from control_plane import LocalAsyncControlPlane
from handler import FakeInferenceHandler, RealInferenceHandler
from http_server import WorkerHttpServer


def _env_int(name: str, default: int, *, minimum: int = 0) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise SystemExit(f"{name} must be an integer") from exc
    if value < minimum:
        raise SystemExit(f"{name} is outside its allowed range")
    return value


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise SystemExit(f"{name} must be numeric") from exc
    if value < 0.0 or value > 1.0:
        raise SystemExit(f"{name} is outside its allowed range")
    return value


def main() -> None:
    service_token = os.environ.get("MEDIA_WORKER_SERVICE_TOKEN")
    if not service_token or len(service_token) < 16:
        raise SystemExit("MEDIA_WORKER_SERVICE_TOKEN must contain at least 16 characters")

    fake_execution = os.environ.get("FAKE_EXECUTION") == "1"
    handler = FakeInferenceHandler(
        delay_ms=_env_int("FAKE_DELAY_MS", 0),
        fail_rate=_env_float("FAKE_FAIL_RATE", 0.0),
        forced_timeout_ms=_env_int("FAKE_TIMEOUT_MS", 0),
    ) if fake_execution else RealInferenceHandler()
    control_plane = LocalAsyncControlPlane(
        handler,
        max_workers=_env_int("MEDIA_WORKER_MAX_WORKERS", 2, minimum=1),
        job_timeout_ms=_env_int("MEDIA_WORKER_JOB_TIMEOUT_MS", 30_000, minimum=1),
        result_ttl_ms=_env_int("MEDIA_WORKER_RESULT_TTL_MS", 900_000, minimum=1),
        max_jobs=_env_int("MEDIA_WORKER_MAX_JOBS", 1_000, minimum=1),
    )
    server = WorkerHttpServer(
        control_plane,
        service_token=service_token,
        host=os.environ.get("MEDIA_WORKER_HOST", "127.0.0.1"),
        port=_env_int("MEDIA_WORKER_PORT", 8099),
    )
    host, port = server.address
    # Safe operational log: no token, prompt, jobRef or payload.
    mode = "fake" if fake_execution else "real-locked"
    print(f"Yeeyoo {mode} media worker listening on http://{host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.close()


if __name__ == "__main__":
    main()
