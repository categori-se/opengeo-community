import gzip
from hashlib import sha256

import pytest

from opengeo_api.print_fonts import (
    UNIFONT_PATH_ENV,
    UNIFONT_REQUIRED_ENV,
    UNIFONT_SHA256_ENV,
    PrintFontError,
    configured_unifont,
)


def _font_archive(records: bytes) -> bytes:
    return gzip.compress(records, compresslevel=9, mtime=0)


def _configure(monkeypatch: pytest.MonkeyPatch, path, body: bytes) -> None:
    monkeypatch.setenv(UNIFONT_PATH_ENV, str(path))
    monkeypatch.setenv(UNIFONT_SHA256_ENV, sha256(body).hexdigest())
    monkeypatch.setenv(UNIFONT_REQUIRED_ENV, "true")


def test_loads_checksum_bound_narrow_and_wide_hex_glyphs(tmp_path, monkeypatch) -> None:
    body = _font_archive(
        b"0041:0000182424427E424242000000000000\n"
        b"1F30D:07E0187822FC41FE423E87F7CFE3EFC1C3C1C1A181034002400221CC1FF807E0\n"
    )
    path = tmp_path / "unifont.hex.gz"
    path.write_bytes(body)
    _configure(monkeypatch, path, body)

    font = configured_unifont()

    assert font is not None
    assert font[0x41].width == 8
    assert len(font[0x41].rows) == 16
    assert font[0x1F30D].width == 16
    assert font[0x1F30D].rows[-1] == 0x07E0


def test_rejects_font_checksum_drift(tmp_path, monkeypatch) -> None:
    body = _font_archive(b"0041:0000182424427E424242000000000000\n")
    path = tmp_path / "unifont.hex.gz"
    path.write_bytes(body)
    monkeypatch.setenv(UNIFONT_PATH_ENV, str(path))
    monkeypatch.setenv(UNIFONT_SHA256_ENV, "0" * 64)
    monkeypatch.setenv(UNIFONT_REQUIRED_ENV, "true")

    with pytest.raises(PrintFontError, match="print_unicode_font_checksum_mismatch"):
        configured_unifont()


def test_rejects_unsorted_or_duplicate_font_records(tmp_path, monkeypatch) -> None:
    body = _font_archive(
        b"0042:0000182424427E424242000000000000\n0041:0000182424427E424242000000000000\n"
    )
    path = tmp_path / "unifont.hex.gz"
    path.write_bytes(body)
    _configure(monkeypatch, path, body)

    with pytest.raises(PrintFontError, match="print_unicode_font_order_invalid"):
        configured_unifont()


def test_required_production_font_fails_closed_when_missing(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv(UNIFONT_PATH_ENV, str(tmp_path / "missing.hex.gz"))
    monkeypatch.setenv(UNIFONT_SHA256_ENV, "0" * 64)
    monkeypatch.setenv(UNIFONT_REQUIRED_ENV, "true")

    with pytest.raises(PrintFontError, match="print_unicode_font_unavailable"):
        configured_unifont()
