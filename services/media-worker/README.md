# Yeeyoo self-host image worker — Phase A fake runtime

This directory contains a DB-free, network-free Python 3.11/3.12 fake worker.
It uses only the standard library. It does not download or execute an ML model.

## Frozen v1 boundary

`POST /run` accepts exactly:

```json
{
  "input": {
    "schemaVersion": "yeeyoo.media.worker.v1",
    "operation": "image.generate",
    "jobRef": "11111111-1111-4111-8111-111111111111",
    "requestHash": "<sha256>",
    "model": "z-image-turbo",
    "prompt": "...",
    "width": 1024,
    "height": 1024,
    "seed": 0,
    "steps": 8
  }
}
```

`steps` defaults to 8 and accepts only integer values from 1 through 12.

`negativePrompt` is the only optional input field. `requestHash` is SHA-256 of
the canonical JSON for every input field except `requestHash`: UTF-8, keys sorted
lexicographically, no insignificant whitespace. Duplicate or unknown fields are
rejected. The exact allowed dimension pairs are 1024×1024, 896×1152, 1152×896,
768×1344 and 1344×768.

Endpoints:

- `POST /run` → `{ "id", "status" }`
- `GET /status/{id}` → normalized status and optional output/error
- `POST /cancel/{id}` → `{ "id", "status" }`

Every endpoint requires `Authorization: Bearer <service-token>`. The server
refuses non-loopback bind addresses. `jobRef` provides idempotency: the same
valid `jobRef` + `requestHash` returns the original job; a changed valid request
for that `jobRef` returns HTTP 409.

The synchronous `InferenceHandler` contract is separate from the local
asynchronous control plane. A later serverless wrapper can call it without
reusing the in-memory registry.

Prompts are NFC-normalized and ECMAScript-trimmed before hashing. Each prompt
field is limited to 2,000 UTF-16 code units and 8,000 UTF-8 bytes, and forbidden
control characters are rejected. TAB, LF and CR remain allowed.

## Local run

```bash
MEDIA_WORKER_SERVICE_TOKEN='replace-with-local-secret' python server.py
```

Optional fake-only injection variables are `FAKE_DELAY_MS`, `FAKE_FAIL_RATE`
and `FAKE_TIMEOUT_MS`. No value enables external access.

The local registry and executor queue are bounded by `MEDIA_WORKER_MAX_JOBS`
(default 1,000). New jobs receive a sanitized HTTP 503 while capacity is full.
Terminal records are evicted after `MEDIA_WORKER_RESULT_TTL_MS`; completed output
first becomes `RESULT_EXPIRED`, then its remaining idempotency record is evicted after
one additional TTL window.

Node contract tests may launch an ephemeral-port instance with:

```bash
MEDIA_WORKER_SERVICE_TOKEN='replace-with-local-secret' \
  python handler.py --serve --host 127.0.0.1 --port 0
```

The first flushed line is `READY {"port":<actual-port>}` and contains no secret.
The token must contain at least 16 characters.

## Tests

```bash
python -m unittest discover -s tests -v
```

Phase A evidence is MOCK only. It is not provider-, GPU-, RunPod- or
production-certified. The loopback HTTP wrapper and Dockerfile are build/test
fixtures; they are not a deployable RunPod endpoint.

`bench/benchmark.py --dry-run` speaks the authenticated, request-hash-bound
contract and accepts only loopback. A real HTTPS target additionally requires
the explicit `--allow-paid` switch. No benchmark is run automatically.
