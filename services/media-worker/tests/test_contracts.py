from __future__ import annotations

import copy
import unittest
import unicodedata

from contracts import (
    ALLOWED_DIMENSIONS,
    ContractError,
    LOCKED_STEPS,
    MAX_PROMPT_CHARS,
    UINT32_MAX,
    compute_request_hash,
    make_valid_envelope,
    parse_run_envelope,
)


class ContractTests(unittest.TestCase):
    def test_valid_contract_and_all_dimensions(self) -> None:
        for width, height in ALLOWED_DIMENSIONS:
            with self.subTest(width=width, height=height):
                envelope = make_valid_envelope(width=width, height=height)
                request = parse_run_envelope(envelope)
                self.assertEqual((request.width, request.height), (width, height))
                self.assertEqual(request.steps, LOCKED_STEPS)
                self.assertEqual(
                    request.request_hash,
                    compute_request_hash(envelope["input"]),
                )

    def test_negative_prompt_is_part_of_hash(self) -> None:
        without_negative = make_valid_envelope()
        with_negative = make_valid_envelope(negativePrompt="no shadows")
        self.assertNotEqual(
            without_negative["input"]["requestHash"],
            with_negative["input"]["requestHash"],
        )

    def test_unicode_hash_matches_frozen_cross_runtime_vector(self) -> None:
        envelope = make_valid_envelope(
            prompt="Norsk gründer – høy kvalitet æøå",
            negativePrompt="ingen støy",
        )
        self.assertEqual(
            envelope["input"]["requestHash"],
            "2cec9e4f6fbfb0fd01ca166cce0810d963afe033202e7a691809ccaa08fa2a7a",
        )

    def test_text_is_nfc_normalized_and_trimmed_before_hash_validation(self) -> None:
        normalized = make_valid_envelope(prompt="Café", negativePrompt="")
        raw = copy.deepcopy(normalized)
        raw["input"]["prompt"] = "  " + unicodedata.normalize("NFD", "Café") + "  "
        request = parse_run_envelope(raw)
        self.assertEqual(request.prompt, "Café")
        self.assertEqual(request.negative_prompt, "")

    def test_forbidden_control_characters_are_rejected_but_tab_lf_cr_are_allowed(self) -> None:
        allowed = parse_run_envelope(make_valid_envelope(prompt="a\tb\nc\rd"))
        self.assertEqual(allowed.prompt, "a\tb\nc\rd")
        for forbidden in ("\x00", "\x08", "\x0b", "\x0c", "\x1f", "\x7f"):
            with self.subTest(codepoint=ord(forbidden)):
                with self.assertRaises(ContractError):
                    make_valid_envelope(prompt=f"safe{forbidden}unsafe")

    def test_uppercase_uuid_is_normalized_before_hash_validation(self) -> None:
        envelope = make_valid_envelope(
            jobRef="AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
        )
        request = parse_run_envelope(envelope)
        self.assertEqual(request.job_ref, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")

    def test_strict_envelope_and_input_allowlists(self) -> None:
        cases = []
        top_level = make_valid_envelope()
        top_level["schemaVersion"] = "unexpected"
        cases.append(top_level)

        input_level = make_valid_envelope()
        input_level["input"]["unexpected"] = True
        input_level["input"]["requestHash"] = compute_request_hash(input_level["input"])
        cases.append(input_level)

        missing = make_valid_envelope()
        del missing["input"]["prompt"]
        missing["input"]["requestHash"] = compute_request_hash(missing["input"])
        cases.append(missing)

        for envelope in cases:
            with self.subTest(envelope=envelope):
                with self.assertRaises(ContractError):
                    parse_run_envelope(envelope)

    def test_operation_model_dimensions_steps_and_seed_are_locked(self) -> None:
        invalid_overrides = (
            {"operation": "video.generate"},
            {"model": "another-model"},
            {"width": 1000, "height": 1000},
            {"steps": 0},
            {"steps": 13},
            {"seed": -1},
            {"seed": UINT32_MAX + 1},
            {"seed": True},
        )
        for overrides in invalid_overrides:
            with self.subTest(overrides=overrides):
                with self.assertRaises(ContractError):
                    parse_run_envelope(make_valid_envelope(**overrides))

        self.assertEqual(parse_run_envelope(make_valid_envelope()).steps, 8)
        self.assertEqual(parse_run_envelope(make_valid_envelope(steps=12)).steps, 12)
        without_steps = make_valid_envelope()
        del without_steps["input"]["steps"]
        without_steps["input"]["requestHash"] = compute_request_hash(without_steps["input"])
        self.assertEqual(parse_run_envelope(without_steps).steps, 8)

    def test_prompt_bounds_and_type_are_strict(self) -> None:
        invalid_prompts = ("", "x" * (MAX_PROMPT_CHARS + 1), None, 7)
        for prompt in invalid_prompts:
            with self.subTest(value_type=type(prompt).__name__):
                with self.assertRaises(ContractError):
                    parse_run_envelope(make_valid_envelope(prompt=prompt))

    def test_job_ref_and_hash_are_strict(self) -> None:
        invalid_job = make_valid_envelope(jobRef="not-a-uuid")
        with self.assertRaisesRegex(ContractError, "canonical UUID"):
            parse_run_envelope(invalid_job)

        bad_hash = make_valid_envelope()
        bad_hash["input"]["requestHash"] = "0" * 64
        with self.assertRaisesRegex(ContractError, "does not match"):
            parse_run_envelope(bad_hash)

        uppercase = make_valid_envelope()
        uppercase["input"]["requestHash"] = uppercase["input"]["requestHash"].upper()
        with self.assertRaisesRegex(ContractError, "lowercase"):
            parse_run_envelope(uppercase)

    def test_error_never_contains_prompt(self) -> None:
        secret_prompt = "RAW-PROMPT-MUST-NOT-LEAK"
        envelope = make_valid_envelope(prompt=secret_prompt)
        envelope["input"]["requestHash"] = "0" * 64
        with self.assertRaises(ContractError) as caught:
            parse_run_envelope(envelope)
        self.assertNotIn(secret_prompt, str(caught.exception))

    def test_request_hash_changes_for_every_semantic_change(self) -> None:
        baseline = make_valid_envelope()
        baseline_hash = baseline["input"]["requestHash"]
        changes = (
            {"prompt": "different"},
            {"seed": 1},
            {"width": 896, "height": 1152},
            {"jobRef": "22222222-2222-4222-8222-222222222222"},
        )
        for change in changes:
            with self.subTest(change=change):
                candidate = make_valid_envelope(**change)
                self.assertNotEqual(candidate["input"]["requestHash"], baseline_hash)


if __name__ == "__main__":
    unittest.main()
