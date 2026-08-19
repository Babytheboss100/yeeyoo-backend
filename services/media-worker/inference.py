"""Fail-closed real inference boundary for Z-Image-Turbo.

The Phase B-F codebase contains no downloader and performs no network or paid
provider action. A future owner-approved weight-pinning step must replace the
fake revision and add an exact SHA-256 before this boundary can be enabled.
"""

from __future__ import annotations

from contracts import InferenceRequestV1
from models import MODELS


class RealModeLocked(RuntimeError):
    """Raised when real inference is requested without pinned model bytes."""


def run_real(request: InferenceRequestV1) -> bytes:
    model = MODELS[request.model]
    revision = model.get("revision")
    checksum = model.get("weightsSha256")
    enabled = model.get("realInferenceEnabled") is True
    if not enabled or not revision or revision == "fake" or not checksum:
        raise RealModeLocked("REAL_MODE_LOCKED")
    raise RealModeLocked("REAL_PIPELINE_NOT_INSTALLED")
