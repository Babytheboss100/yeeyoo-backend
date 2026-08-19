"""Deterministic standard-library PNG generation for fake execution."""

from __future__ import annotations

import hashlib
import struct
import zlib


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _chunk(kind: bytes, payload: bytes) -> bytes:
    checksum = zlib.crc32(kind)
    checksum = zlib.crc32(payload, checksum) & 0xFFFFFFFF
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", checksum)
    )


def deterministic_png(canonical_request: bytes, width: int, height: int) -> bytes:
    """Create a valid RGB PNG derived solely from the canonical full request.

    Prompt text is never rendered or copied into PNG chunks. The digest controls
    a simple stripe pattern, which makes request changes observable while keeping
    fake artifacts compact.
    """

    digest = hashlib.sha256(canonical_request).digest()
    palette = [digest[index : index + 3] for index in range(0, 24, 3)]
    stripe_width = 24 + digest[24] % 73
    row_phase = 12 + digest[25] % 61

    compressor = zlib.compressobj(level=9)
    compressed_parts: list[bytes] = []
    for y in range(height):
        palette_offset = (y // row_phase + digest[26]) % len(palette)
        pixels = bytearray(width * 3)
        for x_start in range(0, width, stripe_width):
            color = palette[(palette_offset + x_start // stripe_width) % len(palette)]
            run = min(stripe_width, width - x_start)
            pixels[x_start * 3 : (x_start + run) * 3] = color * run
        compressed_parts.append(compressor.compress(b"\x00" + pixels))
    compressed_parts.append(compressor.flush())

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"".join(
        (
            PNG_SIGNATURE,
            _chunk(b"IHDR", ihdr),
            _chunk(b"IDAT", b"".join(compressed_parts)),
            _chunk(b"IEND", b""),
        )
    )
