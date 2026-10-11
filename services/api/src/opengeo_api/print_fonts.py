import gzip
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from types import MappingProxyType

UNIFONT_VERSION = "17.0.04"
UNIFONT_FILENAME = f"unifont_all-{UNIFONT_VERSION}.hex.gz"
UNIFONT_SHA256 = "c31d210962408a00de8e2ebe2f2fc26824d7a4939d4eb15d347761fb2a0b39a6"
UNIFONT_PATH_ENV = "OPENGEO_PRINT_UNIFONT_PATH"
UNIFONT_SHA256_ENV = "OPENGEO_PRINT_UNIFONT_SHA256"
UNIFONT_REQUIRED_ENV = "OPENGEO_PRINT_UNIFONT_REQUIRED"
DEFAULT_UNIFONT_PATH = f"/srv/opengeo/fonts/{UNIFONT_FILENAME}"

_MAX_COMPRESSED_BYTES = 2_000_000
_MAX_DECOMPRESSED_BYTES = 20_000_000
_MAX_GLYPHS = 150_000
_HEX_GLYPH = re.compile(rb"([0-9A-F]{4,6}):([0-9A-F]{32}|[0-9A-F]{64})\n?\Z")


class PrintFontError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class BitmapGlyph:
    width: int
    rows: tuple[int, ...]

    def __post_init__(self) -> None:
        if self.width not in {8, 16} or len(self.rows) != 16:
            raise PrintFontError("print_unicode_font_glyph_invalid")
        if any(row < 0 or row >= 1 << self.width for row in self.rows):
            raise PrintFontError("print_unicode_font_glyph_invalid")


def configured_unifont() -> Mapping[int, BitmapGlyph] | None:
    """Return the checksum-bound production font, or the explicit local fallback signal."""

    path = os.environ.get(UNIFONT_PATH_ENV, DEFAULT_UNIFONT_PATH)
    expected_checksum = os.environ.get(UNIFONT_SHA256_ENV, UNIFONT_SHA256)
    required_value = os.environ.get(UNIFONT_REQUIRED_ENV, "false").lower()
    if required_value not in {"true", "false"}:
        raise PrintFontError("print_unicode_font_required_invalid")
    return _configured_unifont(path, expected_checksum, required_value == "true")


@lru_cache(maxsize=4)
def _configured_unifont(
    path: str, expected_checksum: str, required: bool
) -> Mapping[int, BitmapGlyph] | None:
    if not Path(path).is_file():
        if required:
            raise PrintFontError("print_unicode_font_unavailable")
        return None
    return _load_unifont(path, expected_checksum)


@lru_cache(maxsize=4)
def _load_unifont(path: str, expected_checksum: str) -> Mapping[int, BitmapGlyph]:
    if not re.fullmatch(r"[0-9a-f]{64}", expected_checksum):
        raise PrintFontError("print_unicode_font_checksum_invalid")
    source = Path(path)
    try:
        if source.stat().st_size > _MAX_COMPRESSED_BYTES:
            raise PrintFontError("print_unicode_font_compressed_limit_exceeded")
        compressed = source.read_bytes()
    except OSError as error:
        raise PrintFontError("print_unicode_font_unavailable") from error
    if sha256(compressed).hexdigest() != expected_checksum:
        raise PrintFontError("print_unicode_font_checksum_mismatch")

    glyphs: dict[int, BitmapGlyph] = {}
    decompressed_bytes = 0
    prior_codepoint = -1
    try:
        with gzip.GzipFile(fileobj=BytesIO(compressed), mode="rb") as stream:
            for line in stream:
                decompressed_bytes += len(line)
                if decompressed_bytes > _MAX_DECOMPRESSED_BYTES:
                    raise PrintFontError("print_unicode_font_decompressed_limit_exceeded")
                match = _HEX_GLYPH.fullmatch(line)
                if match is None:
                    raise PrintFontError("print_unicode_font_record_invalid")
                codepoint = int(match.group(1), 16)
                if codepoint <= prior_codepoint or codepoint > 0x10FFFF:
                    raise PrintFontError("print_unicode_font_order_invalid")
                bitmap = match.group(2)
                width = 8 if len(bitmap) == 32 else 16
                row_digits = width // 4
                rows = tuple(
                    int(bitmap[offset : offset + row_digits], 16)
                    for offset in range(0, len(bitmap), row_digits)
                )
                glyphs[codepoint] = BitmapGlyph(width=width, rows=rows)
                prior_codepoint = codepoint
                if len(glyphs) > _MAX_GLYPHS:
                    raise PrintFontError("print_unicode_font_glyph_limit_exceeded")
    except (EOFError, gzip.BadGzipFile, OSError) as error:
        raise PrintFontError("print_unicode_font_archive_invalid") from error
    if not glyphs:
        raise PrintFontError("print_unicode_font_empty")
    return MappingProxyType(glyphs)
