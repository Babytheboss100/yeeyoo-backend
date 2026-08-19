"""Versioned Yeeyoo Media Worker request contract.

This module is deliberately independent from the local asynchronous control
plane.  A serverless runtime can call ``parse_run_envelope`` and an
``InferenceHandler`` directly without adopting the local job registry.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import hmac
import json
import re
from types import MappingProxyType
from typing import Any, Mapping
import unicodedata


SCHEMA_VERSION = "yeeyoo.media.worker.v1"
OPERATION = "image.generate"
MODEL = "z-image-turbo"
MODEL_REVISION = "fake"
LOCKED_STEPS = 8
MAX_STEPS = 12
UINT32_MAX = (1 << 32) - 1
MAX_PROMPT_CHARS = 2_000
MAX_PROMPT_UTF8_BYTES = 8_000
ALLOWED_DIMENSIONS = frozenset(
    {
        (1024, 1024),
        (896, 1152),
        (1152, 896),
        (768, 1344),
        (1344, 768),
    }
)

_ENVELOPE_FIELDS = frozenset({"input"})
_REQUIRED_INPUT_FIELDS = frozenset(
    {
        "schemaVersion",
        "operation",
        "jobRef",
        "requestHash",
        "model",
        "prompt",
        "width",
        "height",
        "seed",
    }
)
_OPTIONAL_INPUT_FIELDS = frozenset({"negativePrompt", "steps"})
_INPUT_FIELDS = _REQUIRED_INPUT_FIELDS | _OPTIONAL_INPUT_FIELDS
_HASH_PATTERN = re.compile(r"^[0-9a-f]{64}$")
UUID_TEXT_PATTERN = (
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
)
_UUID_PATTERN = re.compile(rf"^{UUID_TEXT_PATTERN}$", re.IGNORECASE)
_FORBIDDEN_CONTROL_PATTERN = re.compile(
    r"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]"
)
# ECMAScript WhiteSpace + LineTerminator set used by String.prototype.trim().
_JS_TRIM_PATTERN = re.compile(
    r"^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+"
    r"|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$"
)


class ContractError(ValueError):
    """Safe, public validation error with no request values in its message."""

    code = "INVALID_REQUEST"
    retryable = False

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message

    def as_error(self) -> dict[str, object]:
        return {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }


@dataclass(frozen=True, slots=True)
class InferenceRequestV1:
    schema_version: str
    operation: str
    job_ref: str
    request_hash: str
    model: str
    prompt: str
    negative_prompt: str | None
    width: int
    height: int
    seed: int
    steps: int
    canonical_input: Mapping[str, object]
    canonical_json: bytes


def _strict_fields(
    value: Mapping[str, Any],
    *,
    allowed: frozenset[str],
    required: frozenset[str],
    location: str,
) -> None:
    keys = set(value)
    if keys - allowed:
        raise ContractError(f"{location} contains unsupported fields")
    if required - keys:
        raise ContractError(f"{location} is missing required fields")


def _require_string(value: object, *, field: str, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise ContractError(f"{field} must be a string")
    if not allow_empty and not value:
        raise ContractError(f"{field} must not be empty")
    return value


def _require_int(value: object, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ContractError(f"{field} must be an integer")
    return value


def _normalize_text(value: object, *, field: str, required: bool) -> str:
    text = _require_string(value, field=field, allow_empty=not required)
    normalized = unicodedata.normalize("NFC", text)
    while True:
        trimmed = _JS_TRIM_PATTERN.sub("", normalized)
        if trimmed == normalized:
            break
        normalized = trimmed
    if required and not normalized:
        raise ContractError(f"{field} must not be empty")
    try:
        utf8 = normalized.encode("utf-8")
        # Node's String.length counts UTF-16 code units. This exactly mirrors it
        # and is stricter than counting Python code points for astral symbols.
        utf16_units = len(normalized.encode("utf-16-le")) // 2
    except UnicodeEncodeError as exc:
        raise ContractError(f"{field} contains invalid text") from exc
    if (
        utf16_units > MAX_PROMPT_CHARS
        or len(utf8) > MAX_PROMPT_UTF8_BYTES
        or _FORBIDDEN_CONTROL_PATTERN.search(normalized)
    ):
        raise ContractError(f"{field} is invalid or too long")
    return normalized


def canonical_json_bytes(input_without_request_hash: Mapping[str, object]) -> bytes:
    """Return the cross-runtime canonical JSON used by Node and Python.

    The v1 input is flat. Keys are lexicographically sorted, insignificant
    whitespace is removed, UTF-8 is emitted directly, and ``requestHash`` is
    excluded by the caller.
    """

    return json.dumps(
        input_without_request_hash,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def compute_request_hash(input_with_or_without_hash: Mapping[str, object]) -> str:
    hash_input = {
        key: value
        for key, value in input_with_or_without_hash.items()
        if key != "requestHash"
    }
    if hash_input.get("operation") == OPERATION and "steps" not in hash_input:
        hash_input["steps"] = LOCKED_STEPS
    return hashlib.sha256(canonical_json_bytes(hash_input)).hexdigest()


def parse_run_envelope(envelope: object) -> InferenceRequestV1:
    if not isinstance(envelope, dict):
        raise ContractError("request body must be an object")
    _strict_fields(
        envelope,
        allowed=_ENVELOPE_FIELDS,
        required=_ENVELOPE_FIELDS,
        location="request body",
    )

    raw_input = envelope["input"]
    if not isinstance(raw_input, dict):
        raise ContractError("input must be an object")
    _strict_fields(
        raw_input,
        allowed=_INPUT_FIELDS,
        required=_REQUIRED_INPUT_FIELDS,
        location="input",
    )

    schema_version = _require_string(raw_input["schemaVersion"], field="schemaVersion")
    if schema_version != SCHEMA_VERSION:
        raise ContractError("schemaVersion is not supported")

    operation = _require_string(raw_input["operation"], field="operation")
    if operation != OPERATION:
        raise ContractError("operation is not supported")

    job_ref = _require_string(raw_input["jobRef"], field="jobRef")
    if not _UUID_PATTERN.fullmatch(job_ref):
        raise ContractError("jobRef must be a canonical UUID")
    job_ref = job_ref.lower()

    request_hash = _require_string(raw_input["requestHash"], field="requestHash")
    if not _HASH_PATTERN.fullmatch(request_hash):
        raise ContractError("requestHash must be a lowercase SHA-256 hex digest")

    model = _require_string(raw_input["model"], field="model")
    if model != MODEL:
        raise ContractError("model is not supported")

    prompt = _normalize_text(raw_input["prompt"], field="prompt", required=True)

    negative_prompt: str | None = None
    if "negativePrompt" in raw_input:
        negative_prompt = _normalize_text(
            raw_input["negativePrompt"],
            field="negativePrompt",
            required=False,
        )

    width = _require_int(raw_input["width"], field="width")
    height = _require_int(raw_input["height"], field="height")
    if (width, height) not in ALLOWED_DIMENSIONS:
        raise ContractError("width and height must be an allowed dimension pair")

    seed = _require_int(raw_input["seed"], field="seed")
    if seed < 0 or seed > UINT32_MAX:
        raise ContractError("seed must be an unsigned 32-bit integer")

    steps = _require_int(raw_input.get("steps", LOCKED_STEPS), field="steps")
    if steps < 1 or steps > MAX_STEPS:
        raise ContractError(f"steps must be between 1 and {MAX_STEPS}")

    canonical_input: dict[str, object] = {
        "schemaVersion": schema_version,
        "operation": operation,
        "jobRef": job_ref,
        "model": model,
        "prompt": prompt,
        **({"negativePrompt": negative_prompt} if negative_prompt is not None else {}),
        "width": width,
        "height": height,
        "seed": seed,
        "steps": steps,
    }
    canonical_bytes = canonical_json_bytes(canonical_input)
    expected_hash = hashlib.sha256(canonical_bytes).hexdigest()
    if not hmac.compare_digest(request_hash, expected_hash):
        raise ContractError("requestHash does not match canonical input")

    return InferenceRequestV1(
        schema_version=schema_version,
        operation=operation,
        job_ref=job_ref,
        request_hash=request_hash,
        model=model,
        prompt=prompt,
        negative_prompt=negative_prompt,
        width=width,
        height=height,
        seed=seed,
        steps=steps,
        canonical_input=MappingProxyType(canonical_input),
        canonical_json=canonical_bytes,
    )


def make_valid_envelope(**overrides: object) -> dict[str, object]:
    """Build a correctly hashed v1 envelope for tests and local smoke checks."""

    input_data: dict[str, object] = {
        "schemaVersion": SCHEMA_VERSION,
        "operation": OPERATION,
        "jobRef": "11111111-1111-4111-8111-111111111111",
        "model": MODEL,
        "prompt": "A safe local fake image",
        "width": 1024,
        "height": 1024,
        "seed": 0,
        "steps": LOCKED_STEPS,
    }
    input_data.update(overrides)
    if isinstance(input_data.get("jobRef"), str):
        input_data["jobRef"] = input_data["jobRef"].lower()
    if "prompt" in input_data and isinstance(input_data["prompt"], str):
        input_data["prompt"] = _normalize_text(
            input_data["prompt"], field="prompt", required=True
        )
    if "negativePrompt" in input_data and isinstance(input_data["negativePrompt"], str):
        input_data["negativePrompt"] = _normalize_text(
            input_data["negativePrompt"], field="negativePrompt", required=False
        )
    input_data["requestHash"] = compute_request_hash(input_data)
    return {"input": input_data}
