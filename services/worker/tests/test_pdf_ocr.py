import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from opengeo_worker.command_runner import CommandResult
from opengeo_worker.models import ValidationFailure
from opengeo_worker.pdf_documents import extract_pdf_semantic_preview
from opengeo_worker.pdf_ocr import MAX_OCR_PAGES, ocr_pdf_pages, select_ocr_model


@pytest.mark.parametrize(
    ("contract", "expected_mode", "expected_method"),
    [
        ({"mode": "tagged-actualtext", "sourceTags": "closed-actualtext"},
         "tagged-actualtext", "pypdf_tagged_actualtext"),
        ({"mode": "tagged-mcid-text", "sourceTags": "validated-mcid-text"},
         "tagged-mcid-text", "pypdf_tagged_mcid_text"),
        ({}, "layout", "poppler_pdftotext"),
        ({"mode": None, "sourceTags": None}, "layout", "poppler_pdftotext"),
        ({"mode": "tagged-unknown", "sourceTags": "validated-mcid-text"},
         "layout", "poppler_pdftotext"),
        ({"mode": "tagged-mcid-text", "sourceTags": "closed-actualtext"},
         "layout", "poppler_pdftotext"),
        ({"mode": "tagged-actualtext", "sourceTags": "validated-mcid-text"},
         "layout", "poppler_pdftotext"),
        ({"mode": "tagged-mcid-text", "sourceTags": "unknown-profile"},
         "layout", "poppler_pdftotext"),
    ],
)
def test_pdf_caller_preserves_validated_text_provenance_or_falls_back(
    tmp_path, monkeypatch, contract, expected_mode, expected_method
):
    source = tmp_path / "source.pdf"
    source.write_bytes(b"source retained; isolated parser is represented by this test peer")
    before = source.read_bytes()
    monkeypatch.setattr("opengeo_worker.pdf_documents.importlib.util.find_spec",
                        lambda name: SimpleNamespace(origin=str(tmp_path / "pypdf/__init__.py")))

    class Runner:
        def run(self, program, arguments, **kwargs):
            if program == "pdftotext":
                return CommandResult("Coordinate fallback.\n\f", "")
            assert program == "pdf-tagged-text"
            return CommandResult(json.dumps({"pages": [["Authored source order."]], **contract}), "")

    result = extract_pdf_semantic_preview(
        source, tmp_path, Runner(), page_count=1, pdf_version="1.7",
        title=None, language="en", tagged=True,
    )
    preview = json.loads(result.path.read_bytes())
    assert preview["extraction"]["mode"] == expected_mode
    assert result.text_extraction == expected_method
    authoritative = expected_mode != "layout"
    assert preview["extraction"]["readingOrder"] == ("source-tags" if authoritative else "heuristic")
    assert result.reading_order == ("source-tags" if authoritative else "heuristic")
    assert preview["pages"][0]["blocks"][0]["text"] == (
        "Authored source order." if authoritative else "Coordinate fallback."
    )
    assert source.read_bytes() == before


def png_header(width: int, height: int) -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n"
        + b"\x00\x00\x00\x0dIHDR"
        + width.to_bytes(4, "big")
        + height.to_bytes(4, "big")
    )


class OcrRunner:
    def __init__(self, *, invalid_image: bool = False) -> None:
        self.invalid_image = invalid_image
        self.calls: list[tuple[str, list[str], int]] = []

    def run(
        self,
        program: str,
        arguments: list[str],
        *,
        cwd: Path,
        maximum_file_bytes: int = 5_368_709_120,
    ) -> CommandResult:
        self.calls.append((program, arguments, maximum_file_bytes))
        if program == "tesseract" and arguments == ["--version"]:
            return CommandResult("tesseract 5.3.4\n leptonica-1.82.0\n", "")
        if program == "pdftoppm":
            image = Path(arguments[-1]).with_suffix(".png")
            image.write_bytes(b"not-png" if self.invalid_image else png_header(800, 1_000))
            return CommandResult("", "")
        assert program == "tesseract"
        page_number = Path(arguments[0]).stem.rsplit("-", 1)[-1]
        return CommandResult(f"Recognized page {page_number}.\n\f", "")


@pytest.mark.parametrize(
    ("language", "model"),
    [
        (None, "eng"),
        ("en-US", "Latin"),
        ("ar", "Arabic"),
        ("bn-BD", "Bengali"),
        ("ru", "Cyrillic"),
        ("ne", "Devanagari"),
        ("am", "Ethiopic"),
        ("el", "Greek"),
        ("ko", "Hangul"),
        ("zh-Hans", "HanS"),
        ("zh-TW", "HanT"),
        ("he", "Hebrew"),
        ("ja", "Japanese"),
        ("th", "Thai"),
    ],
)
def test_selects_closed_declared_language_script_models(language: str | None, model: str) -> None:
    assert select_ocr_model(language) == model


def test_ocrs_only_the_bounded_ordered_page_prefix_and_removes_images(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    source.write_bytes(b"pdf")
    runner = OcrRunner()

    result = ocr_pdf_pages(
        source,
        tmp_path,
        runner,
        page_numbers=tuple(range(1, 41)),
        page_count=40,
        language="ar",
    )

    assert result.attempted_pages == tuple(range(1, MAX_OCR_PAGES + 1))
    assert result.truncated is True
    assert result.engine_version == "5.3.4"
    assert result.model == "Arabic"
    assert result.total_pixels == MAX_OCR_PAGES * 800_000
    assert result.text_by_page[1] == "Recognized page 1."
    assert result.text_by_page[MAX_OCR_PAGES] == f"Recognized page {MAX_OCR_PAGES}."
    assert not tuple(tmp_path.glob("document-ocr-*.png"))
    tesseract_calls = [call for call in runner.calls if call[0] == "tesseract"]
    assert len(tesseract_calls) == MAX_OCR_PAGES + 1
    assert tesseract_calls[1][1][7:9] == ["Arabic", "-c"]


def test_rejects_unbounded_or_invalid_rendered_ocr_input(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    source.write_bytes(b"pdf")
    with pytest.raises(ValidationFailure, match="document_ocr_input_invalid"):
        ocr_pdf_pages(
            source,
            tmp_path,
            OcrRunner(),
            page_numbers=(2, 1),
            page_count=2,
            language="en",
        )
    with pytest.raises(ValidationFailure, match="document_ocr_failed"):
        ocr_pdf_pages(
            source,
            tmp_path,
            OcrRunner(invalid_image=True),
            page_numbers=(1,),
            page_count=1,
            language="en",
        )
