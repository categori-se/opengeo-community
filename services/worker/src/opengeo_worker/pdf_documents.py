import json
import re
from dataclasses import dataclass
from pathlib import Path

from opengeo_worker.command_runner import CommandRunner
from opengeo_worker.models import ValidationFailure
from opengeo_worker.pdf_ocr import MAX_OCR_PAGES, MAX_OCR_PIXELS, PdfOcrResult, ocr_pdf_pages

PREVIEW_SCHEMA = "opengeo.document-preview.2.0.0"
OCR_PREVIEW_SCHEMA = "opengeo.document-preview.3.0.0"
PREVIEW_CONTENT_TYPE = "application/json"

_MAX_RAW_TEXT_BYTES = 1_048_576
_MAX_PREVIEW_BYTES = 512 * 1024
_MAX_PAGES = 200
_MAX_BLOCKS = 2_000
_MAX_TEXT_CHARACTERS = 200_000
_MAX_PARAGRAPH_CHARACTERS = 8_000
_LANGUAGE = re.compile(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}")


@dataclass(frozen=True, slots=True)
class PdfSemanticPreview:
    path: Path
    schema: str
    block_count: int
    text_characters: int
    text_available: bool
    ocr: PdfOcrResult | None


def extract_pdf_semantic_preview(
    source: Path,
    workdir: Path,
    runner: CommandRunner,
    *,
    page_count: int,
    pdf_version: str,
    title: str | None,
    language: str | None,
    tagged: bool,
) -> PdfSemanticPreview:
    """Extract a bounded all-page text representation through isolated Poppler."""
    if not 1 <= page_count <= _MAX_PAGES:
        raise ValidationFailure("document_metadata_invalid")
    normalized_title = _optional_text(title, 300)
    normalized_language = _optional_language(language)
    try:
        result = runner.run(
            "pdftotext",
            [
                "-f",
                "1",
                "-l",
                str(page_count),
                "-layout",
                "-enc",
                "UTF-8",
                "-eol",
                "unix",
                str(source),
                "-",
            ],
            cwd=workdir,
            maximum_file_bytes=_MAX_RAW_TEXT_BYTES,
        )
    except ValidationFailure as error:
        raise ValidationFailure("document_text_extraction_failed") from error
    if len(result.stdout.encode("utf-8")) > _MAX_RAW_TEXT_BYTES or "\x00" in result.stdout:
        raise ValidationFailure("document_content_limit_exceeded")
    raw_pages = result.stdout.split("\f")
    if len(raw_pages) == page_count + 1 and not raw_pages[-1].strip():
        raw_pages.pop()
    if len(raw_pages) != page_count:
        raise ValidationFailure("document_text_extraction_failed")

    embedded_paragraphs = tuple(_paragraphs(raw_page) for raw_page in raw_pages)
    empty_pages = tuple(
        number for number, paragraphs in enumerate(embedded_paragraphs, start=1) if not paragraphs
    )
    ocr = (
        ocr_pdf_pages(
            source,
            workdir,
            runner,
            page_numbers=empty_pages,
            page_count=page_count,
            language=normalized_language,
        )
        if empty_pages
        else None
    )
    pages: list[dict[str, object]] = []
    block_count = 0
    text_characters = 0
    for number, extracted_paragraphs in enumerate(embedded_paragraphs, start=1):
        text_source = "embedded"
        paragraphs = extracted_paragraphs
        if not paragraphs:
            if ocr is not None and number in ocr.text_by_page:
                text_source = "ocr"
                paragraphs = _paragraphs(ocr.text_by_page[number])
            else:
                text_source = "none"
        blocks: list[dict[str, str]] = []
        for paragraph in paragraphs:
            for chunk in _chunks(paragraph, _MAX_PARAGRAPH_CHARACTERS):
                block_count += 1
                text_characters += len(chunk)
                if block_count > _MAX_BLOCKS or text_characters > _MAX_TEXT_CHARACTERS:
                    raise ValidationFailure("document_content_limit_exceeded")
                blocks.append({"type": "paragraph", "text": chunk})
        page: dict[str, object] = {"number": number, "blocks": blocks}
        if ocr is not None:
            page["textSource"] = text_source
        pages.append(page)

    text_available = text_characters > 0
    extraction: dict[str, object]
    schema = PREVIEW_SCHEMA
    if ocr is None:
        extraction = {
            "engine": "poppler-pdftotext",
            "mode": "layout",
            "ocrPerformed": False,
            "readingOrder": "heuristic",
            "tagged": tagged,
            "textAvailable": text_available,
        }
    else:
        schema = OCR_PREVIEW_SCHEMA
        extraction = {
            "engine": "poppler-pdftotext+tesseract",
            "mode": "layout+page-ocr",
            "ocrPerformed": True,
            "ocrEngine": "tesseract",
            "ocrEngineVersion": ocr.engine_version,
            "ocrModel": ocr.model,
            "ocrPageLimit": MAX_OCR_PAGES,
            "ocrPages": list(ocr.attempted_pages),
            "ocrPixelLimit": MAX_OCR_PIXELS,
            "ocrMaximumDimension": ocr.maximum_dimension,
            "ocrTotalPixels": ocr.total_pixels,
            "ocrTruncated": ocr.truncated,
            "readingOrder": "heuristic",
            "tagged": tagged,
            "textAvailable": text_available,
        }
    preview = {
        "schemaVersion": schema,
        "sourceFormat": "pdf",
        "pdfVersion": pdf_version,
        "title": normalized_title,
        "language": normalized_language,
        "extraction": extraction,
        "pages": pages,
    }
    encoded = (
        json.dumps(preview, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode("utf-8")
    if len(encoded) > _MAX_PREVIEW_BYTES:
        raise ValidationFailure("document_content_limit_exceeded")
    target = workdir / "accessible-preview.json"
    target.write_bytes(encoded)
    return PdfSemanticPreview(
        target,
        schema,
        block_count,
        text_characters,
        text_available,
        ocr,
    )


def _paragraphs(page: str) -> tuple[str, ...]:
    normalized = page.replace("\r\n", "\n").replace("\r", "\n")
    result: list[str] = []
    for group in re.split(r"\n[ \t]*\n+", normalized):
        paragraph = " ".join(group.split())
        if paragraph:
            result.append(paragraph)
    return tuple(result)


def _chunks(value: str, maximum: int) -> tuple[str, ...]:
    chunks: list[str] = []
    remaining = value
    while len(remaining) > maximum:
        split_at = remaining.rfind(" ", 0, maximum + 1)
        if split_at < 1:
            split_at = maximum
        chunks.append(remaining[:split_at])
        remaining = remaining[split_at:].lstrip()
    if remaining:
        chunks.append(remaining)
    return tuple(chunks)


def _optional_text(value: str | None, maximum: int) -> str | None:
    if value is None or not value.strip():
        return None
    normalized = " ".join(value.split())
    if len(normalized) > maximum or "\x00" in normalized:
        raise ValidationFailure("document_metadata_invalid")
    return normalized


def _optional_language(value: str | None) -> str | None:
    normalized = _optional_text(value, 35)
    if normalized is None:
        return None
    if _LANGUAGE.fullmatch(normalized) is None:
        raise ValidationFailure("document_metadata_invalid")
    return normalized
