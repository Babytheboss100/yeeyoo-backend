"""Locked Z-Image-Turbo registry shared by fake and future real execution.

Real execution remains fail-closed until an owner-approved revision and weight
checksum are pinned. Merely importing this module never downloads anything.
"""

from types import MappingProxyType

from contracts import LOCKED_STEPS, MAX_STEPS, MODEL, MODEL_REVISION


MODELS = MappingProxyType(
    {
        MODEL: MappingProxyType(
            {
                "revision": MODEL_REVISION,
                "steps": LOCKED_STEPS,
                "maxSteps": MAX_STEPS,
                "hfRepo": "Tongyi-MAI/Z-Image-Turbo",
                "weightsSha256": None,
                "license": "Apache-2.0",
                "vramGb": 16,
                "tier": "standard",
                "runtime": "fake-v1",
                "realInferenceEnabled": False,
            }
        )
    }
)
