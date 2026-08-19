"""Authenticated benchmark client for the hardened Yeeyoo media-worker.

Dry-run is limited to loopback. Any non-loopback target requires both HTTPS and
an explicit --allow-paid switch; this repository never invokes that path.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import statistics
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from contracts import make_valid_envelope  # noqa: E402

TERMINAL = {"COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "RESULT_EXPIRED"}


def _request(url: str, token: str, method: str, path: str, body=None):
    encoded = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    request = urllib.request.Request(
        url + path, method=method, data=encoded,
        headers={"Authorization": f"Bearer {token}", **({"Content-Type": "application/json"} if encoded else {})},
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.loads(response.read())


def run_one(url: str, token: str, prompt: str, seed: int):
    started = time.monotonic()
    envelope = make_valid_envelope(prompt=prompt, seed=seed, jobRef=f"00000000-0000-4000-8000-{seed:012d}")
    submitted = _request(url, token, "POST", "/run", envelope)
    while True:
        status = _request(url, token, "GET", f"/status/{submitted['id']}")
        if status["status"] in TERMINAL:
            usage = status.get("usage") or {}
            return {"wall_s": time.monotonic() - started, "status": status["status"], "gpu_s": usage.get("gpu_seconds", 0), "billable": usage.get("billable") is True}
        time.sleep(0.1)


def _validate_target(url: str, *, dry_run: bool, allow_paid: bool) -> str:
    parsed = urllib.parse.urlsplit(url.rstrip("/"))
    loopback = parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    if dry_run and not loopback:
        raise SystemExit("--dry-run accepts only a loopback worker")
    if not dry_run and (not allow_paid or parsed.scheme != "https"):
        raise SystemExit("real benchmark requires HTTPS and --allow-paid")
    return url.rstrip("/")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8099")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--allow-paid", action="store_true")
    parser.add_argument("--warm-count", type=int, default=50)
    parser.add_argument("--parallel-count", type=int, default=20)
    parser.add_argument("--gpu-usd-per-hour", type=float, default=1.75)
    args = parser.parse_args()
    token = os.environ.get("MEDIA_WORKER_SERVICE_TOKEN", "")
    if len(token) < 16:
        raise SystemExit("MEDIA_WORKER_SERVICE_TOKEN must contain at least 16 characters")
    url = _validate_target(args.url, dry_run=args.dry_run, allow_paid=args.allow_paid)
    prompts = ("Nordic fintech office, natural light", "Fintech app on a smartphone")
    sequential = [run_one(url, token, prompts[i % 2], 1000 + i) for i in range(args.warm_count)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        parallel = list(executor.map(lambda i: run_one(url, token, prompts[i % 2], 2000 + i), range(args.parallel_count)))
    results = sequential + parallel
    completed = [item for item in results if item["status"] == "COMPLETED"]
    walls = sorted(item["wall_s"] for item in completed)
    gpu_total = sum(item["gpu_s"] for item in results if item["billable"])
    usd_total = gpu_total * args.gpu_usd_per_hour / 3600
    report = {
        "n": len(results), "completed": len(completed),
        "fail_rate": round(1 - len(completed) / max(1, len(results)), 4),
        "wall_p50_s": round(statistics.median(walls), 3) if walls else None,
        "wall_p95_s": round(walls[max(0, int(len(walls) * 0.95) - 1)], 3) if walls else None,
        "billable_gpu_seconds_total": round(gpu_total, 4),
        "usd_total": round(usd_total, 6),
        "usd_per_image": round(usd_total / max(1, len(completed)), 8),
        "basis": "dry-run" if args.dry_run else "measured",
    }
    output = Path(__file__).with_name("RESULT.dryrun.json" if args.dry_run else "RESULT.json")
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
