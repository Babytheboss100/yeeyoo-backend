# Durable video lease runner

The `video.render` worker is disabled unless PostgreSQL job storage and a durable runner mode are selected explicitly.

## Standalone process

```bash
MEDIA_JOB_STORE=postgres \
MEDIA_VIDEO_RUNNER_MODE=standalone \
node src/mediaEngine/runner.js
```

The process uses the canonical backend PostgreSQL pool, claims one eligible `video.render` row with `FOR UPDATE SKIP LOCKED`, heartbeats its lease while Composer runs, and stops cleanly on `SIGINT` or `SIGTERM`.

## Embedded web-service sweep

```bash
MEDIA_JOB_STORE=postgres \
MEDIA_VIDEO_RUNNER_MODE=embedded \
node src/index.js
```

Embedded mode schedules the same runner through `node-cron`. The default six-field schedule is once per second. Override it with `MEDIA_VIDEO_CRON`.

## Relevant configuration

- `MEDIA_VIDEO_RUNNER_MODE`: `disabled` (default), `embedded`, or `standalone`.
- `MEDIA_VIDEO_LEASE_WORKER_ID`: optional stable worker identity; defaults to hostname and PID.
- `MEDIA_VIDEO_LEASE_SECONDS`: 5–3600, default 90.
- `MEDIA_VIDEO_HEARTBEAT_MS`: shorter than the lease, default one third of the lease.
- `MEDIA_VIDEO_CRON`: node-cron expression, default `*/1 * * * * *`.
- `MEDIA_VIDEO_WORKSPACE_ROOT`: narrow absolute temporary workspace root.
- `MEDIA_LOCAL_STORAGE_ROOT`: StorageAdapter root used by the local implementation.

`MEDIA_VIDEO_LEASE_RUNNER_ENABLED=true` remains a compatibility alias for embedded mode. New deployments should use `MEDIA_VIDEO_RUNNER_MODE`.

## Safety properties

- A live lease owner is required for heartbeat, completion, and retry transitions.
- Expired leases are re-queued only within canonical `max_retries`.
- A heartbeat already in flight is awaited before terminal persistence.
- Cancellation or lease loss aborts Composer/FFmpeg and prevents stale completion.
- Each job has a UUID-scoped workspace. Reclaim removes stale partial files from a dead process before rendering and terminal cleanup removes the workspace.
- Client-supplied object references are rejected. `resolveVideoInput` maps approved tenant/project-owned artifact IDs to checksum-bound StorageAdapter references.

The PostgreSQL integration tests run only when `YEEYOO_TEST_DATABASE_URL` names exactly `yeeyoo_phase13_test`. They never fall back to `DATABASE_URL`.
