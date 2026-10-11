import base64
import binascii
import json
import re
from hashlib import sha256
from typing import Any, cast

DOCUMENT_PREVIEW_SCHEMA = "opengeo.document-preview.1.0.0"
PDF_DOCUMENT_PREVIEW_SCHEMA = "opengeo.document-preview.2.0.0"
PDF_OCR_DOCUMENT_PREVIEW_SCHEMA = "opengeo.document-preview.3.0.0"
PDF_VISUAL_PRESENTATION_SCHEMA = "opengeo.pdf-visual-presentation.1.0.0"
PDF_OCR_VISUAL_PRESENTATION_SCHEMA = "opengeo.pdf-visual-presentation.2.0.0"
PDF_DOCUMENT_PREVIEW_SCHEMAS = frozenset(
    {PDF_DOCUMENT_PREVIEW_SCHEMA, PDF_OCR_DOCUMENT_PREVIEW_SCHEMA}
)
PDF_VISUAL_PRESENTATION_SCHEMAS = frozenset(
    {PDF_VISUAL_PRESENTATION_SCHEMA, PDF_OCR_VISUAL_PRESENTATION_SCHEMA}
)
DOCUMENT_PREVIEW_SCHEMAS = frozenset(
    {
        DOCUMENT_PREVIEW_SCHEMA,
        *PDF_DOCUMENT_PREVIEW_SCHEMAS,
        *PDF_VISUAL_PRESENTATION_SCHEMAS,
    }
)
MAX_DOCUMENT_PREVIEW_BYTES = 512 * 1024
MAX_PDF_VISUAL_PRESENTATION_BYTES = 4 * 1024 * 1024
MAX_PDF_VISUAL_IMAGE_BYTES = 2_400_000
MAX_PDF_VISUAL_PIXELS = 20_000_000
MAX_PDF_OCR_PAGES = 32
MAX_PDF_OCR_PIXELS = 32_000_000
PDF_OCR_MODELS = frozenset(
    {
        "eng",
        "Arabic",
        "Bengali",
        "Cyrillic",
        "Devanagari",
        "Ethiopic",
        "Greek",
        "Hangul",
        "HanS",
        "HanT",
        "Hebrew",
        "Japanese",
        "Latin",
        "Thai",
    }
)


class DocumentPreviewInvalid(ValueError):
    pass


def parse_document_preview(content: bytes) -> dict[str, Any]:
    """Parse the closed, bounded semantic document-preview contract."""
    if not 1 <= len(content) <= MAX_PDF_VISUAL_PRESENTATION_BYTES:
        raise DocumentPreviewInvalid("document_preview_invalid")
    try:
        raw = json.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise DocumentPreviewInvalid("document_preview_invalid") from error
    if not isinstance(raw, dict):
        raise DocumentPreviewInvalid("document_preview_invalid")
    schema = raw.get("schemaVersion")
    if schema not in PDF_VISUAL_PRESENTATION_SCHEMAS and len(content) > MAX_DOCUMENT_PREVIEW_BYTES:
        raise DocumentPreviewInvalid("document_preview_invalid")
    if schema == DOCUMENT_PREVIEW_SCHEMA:
        if (
            set(raw)
            != {
                "schemaVersion",
                "sourceFormat",
                "odfVersion",
                "title",
                "language",
                "pages",
            }
            or raw.get("sourceFormat") != "odt"
            or raw.get("odfVersion") not in {"1.2", "1.3", "1.4"}
        ):
            raise DocumentPreviewInvalid("document_preview_invalid")
    elif schema in PDF_DOCUMENT_PREVIEW_SCHEMAS | PDF_VISUAL_PRESENTATION_SCHEMAS:
        extraction = raw.get("extraction")
        expected_keys = {
            "schemaVersion",
            "sourceFormat",
            "pdfVersion",
            "title",
            "language",
            "extraction",
            "pages",
        }
        if schema in PDF_VISUAL_PRESENTATION_SCHEMAS:
            expected_keys.add("rendering")
        if (
            set(raw) != expected_keys
            or raw.get("sourceFormat") != "pdf"
            or raw.get("pdfVersion")
            not in {
                "1.0",
                "1.1",
                "1.2",
                "1.3",
                "1.4",
                "1.5",
                "1.6",
                "1.7",
                "2.0",
            }
            or not _pdf_extraction_valid(extraction, schema)
        ):
            raise DocumentPreviewInvalid("document_preview_invalid")
        if schema in PDF_VISUAL_PRESENTATION_SCHEMAS:
            rendering = raw.get("rendering")
            if (
                not isinstance(rendering, dict)
                or set(rendering)
                != {
                    "engine",
                    "mediaType",
                    "annotationsHidden",
                    "colorSpace",
                    "pageCount",
                    "targetMaximumDimension",
                    "totalPixels",
                    "totalImageBytes",
                }
                or rendering.get("engine") != "poppler-pdftoppm"
                or rendering.get("mediaType") != "image/jpeg"
                or rendering.get("annotationsHidden") is not True
                or rendering.get("colorSpace") != "rgb"
                or not _integer_between(rendering.get("pageCount"), 1, 200)
                or not _integer_between(rendering.get("targetMaximumDimension"), 64, 1_000)
                or not _integer_between(rendering.get("totalPixels"), 1, MAX_PDF_VISUAL_PIXELS)
                or not _integer_between(
                    rendering.get("totalImageBytes"), 1, MAX_PDF_VISUAL_IMAGE_BYTES
                )
            ):
                raise DocumentPreviewInvalid("document_preview_invalid")
    else:
        raise DocumentPreviewInvalid("document_preview_invalid")
    if (raw.get("title") is not None and not _bounded_text(raw.get("title"), 300)) or (
        raw.get("language") is not None and not _language(raw.get("language"))
    ):
        raise DocumentPreviewInvalid("document_preview_invalid")
    pages = raw.get("pages")
    if not isinstance(pages, list) or not 1 <= len(pages) <= 200:
        raise DocumentPreviewInvalid("document_preview_invalid")
    block_total = 0
    character_total = 0
    table_cells = 0
    visual_pixels = 0
    visual_bytes = 0
    for number, page in enumerate(pages, start=1):
        page_keys = {"number", "blocks"}
        if schema in PDF_VISUAL_PRESENTATION_SCHEMAS:
            page_keys.update({"width", "height", "imageBase64", "imageSha256"})
        if schema in {PDF_OCR_DOCUMENT_PREVIEW_SCHEMA, PDF_OCR_VISUAL_PRESENTATION_SCHEMA}:
            page_keys.add("textSource")
        if (
            not isinstance(page, dict)
            or set(page) != page_keys
            or page.get("number") != number
            or not isinstance(page.get("blocks"), list)
            or (
                schema in {PDF_OCR_DOCUMENT_PREVIEW_SCHEMA, PDF_OCR_VISUAL_PRESENTATION_SCHEMA}
                and page.get("textSource") not in {"embedded", "ocr", "none"}
            )
        ):
            raise DocumentPreviewInvalid("document_preview_invalid")
        if schema in PDF_VISUAL_PRESENTATION_SCHEMAS:
            rendering = cast(dict[str, object], raw["rendering"])
            target_dimension = cast(int, rendering["targetMaximumDimension"])
            if (
                not _integer_between(page.get("width"), 1, target_dimension)
                or not _integer_between(page.get("height"), 1, target_dimension)
                or not isinstance(page.get("imageBase64"), str)
                or not isinstance(page.get("imageSha256"), str)
                or re.fullmatch(r"[0-9a-f]{64}", cast(str, page["imageSha256"])) is None
            ):
                raise DocumentPreviewInvalid("document_preview_invalid")
            image = _decode_visual_image(cast(str, page["imageBase64"]))
            image_width, image_height = _jpeg_dimensions(image)
            if (
                image_width != page["width"]
                or image_height != page["height"]
                or sha256(image).hexdigest() != page["imageSha256"]
                or len(image) > 512 * 1024
            ):
                raise DocumentPreviewInvalid("document_preview_invalid")
            visual_pixels += image_width * image_height
            visual_bytes += len(image)
        for block in cast(list[object], page["blocks"]):
            block_total += 1
            if block_total > 2_000 or not isinstance(block, dict):
                raise DocumentPreviewInvalid("document_preview_invalid")
            kind = block.get("type")
            if kind == "heading":
                if (
                    set(block) != {"type", "level", "text"}
                    or not isinstance(block.get("level"), int)
                    or isinstance(block.get("level"), bool)
                    or not 1 <= cast(int, block["level"]) <= 10
                    or not _bounded_text(block.get("text"), 8_000)
                ):
                    raise DocumentPreviewInvalid("document_preview_invalid")
                character_total += len(cast(str, block["text"]))
            elif kind == "paragraph":
                if set(block) != {"type", "text"} or not _bounded_text(block.get("text"), 8_000):
                    raise DocumentPreviewInvalid("document_preview_invalid")
                character_total += len(cast(str, block["text"]))
            elif kind == "list":
                items = block.get("items")
                if (
                    set(block) != {"type", "ordered", "items"}
                    or not isinstance(block.get("ordered"), bool)
                    or not isinstance(items, list)
                    or not 1 <= len(items) <= 500
                    or any(not _bounded_text(item, 1_000) for item in items)
                ):
                    raise DocumentPreviewInvalid("document_preview_invalid")
                character_total += sum(len(cast(str, item)) for item in items)
            elif kind == "table":
                allowed = {"type", "rows", "headerRows", "label"}
                rows = block.get("rows")
                if (
                    not set(block) <= allowed
                    or not {"type", "rows", "headerRows"} <= set(block)
                    or not isinstance(block.get("headerRows"), int)
                    or isinstance(block.get("headerRows"), bool)
                    or not 0 <= cast(int, block["headerRows"]) <= 200
                    or ("label" in block and not _bounded_text(block.get("label"), 300))
                    or not isinstance(rows, list)
                    or not 1 <= len(rows) <= 200
                ):
                    raise DocumentPreviewInvalid("document_preview_invalid")
                table_width: int | None = None
                for table_row in rows:
                    if (
                        not isinstance(table_row, list)
                        or not 1 <= len(table_row) <= 20
                        or any(not isinstance(cell, str) or len(cell) > 1_000 for cell in table_row)
                        or (table_width is not None and len(table_row) != table_width)
                    ):
                        raise DocumentPreviewInvalid("document_preview_invalid")
                    table_width = len(table_row)
                    table_cells += len(table_row)
                    character_total += sum(len(cell) for cell in table_row)
                if cast(int, block["headerRows"]) > len(rows):
                    raise DocumentPreviewInvalid("document_preview_invalid")
            else:
                raise DocumentPreviewInvalid("document_preview_invalid")
            if table_cells > 5_000 or character_total > 200_000:
                raise DocumentPreviewInvalid("document_preview_invalid")
    if schema in PDF_DOCUMENT_PREVIEW_SCHEMAS | PDF_VISUAL_PRESENTATION_SCHEMAS:
        extraction = cast(dict[str, object], raw["extraction"])
        if cast(bool, extraction["textAvailable"]) is not (character_total > 0):
            raise DocumentPreviewInvalid("document_preview_invalid")
    if schema in {PDF_OCR_DOCUMENT_PREVIEW_SCHEMA, PDF_OCR_VISUAL_PRESENTATION_SCHEMA}:
        extraction = cast(dict[str, object], raw["extraction"])
        ocr_pages = cast(list[int], extraction["ocrPages"])
        page_sources = [cast(dict[str, object], page)["textSource"] for page in pages]
        if (
            ocr_pages
            != [number for number, source in enumerate(page_sources, start=1) if source == "ocr"]
            or any(
                source == "embedded" and not cast(dict[str, object], page)["blocks"]
                for source, page in zip(page_sources, pages, strict=True)
            )
            or any(
                source == "none" and cast(dict[str, object], page)["blocks"]
                for source, page in zip(page_sources, pages, strict=True)
            )
            or cast(bool, extraction["ocrTruncated"]) is not ("none" in page_sources)
        ):
            raise DocumentPreviewInvalid("document_preview_invalid")
    if schema in PDF_VISUAL_PRESENTATION_SCHEMAS:
        rendering = cast(dict[str, object], raw["rendering"])
        if (
            rendering["pageCount"] != len(pages)
            or rendering["totalPixels"] != visual_pixels
            or rendering["totalImageBytes"] != visual_bytes
        ):
            raise DocumentPreviewInvalid("document_preview_invalid")
    return cast(dict[str, Any], raw)


def document_visual_page(preview: dict[str, Any], page_number: int) -> tuple[bytes, str]:
    """Return one already-strictly-parsed visual page and its sealed image digest."""
    if preview.get("schemaVersion") not in PDF_VISUAL_PRESENTATION_SCHEMAS:
        raise DocumentPreviewInvalid("document_preview_invalid")
    pages = preview.get("pages")
    if not isinstance(pages, list) or not 1 <= page_number <= len(pages):
        raise DocumentPreviewInvalid("document_preview_invalid")
    page = pages[page_number - 1]
    if not isinstance(page, dict) or page.get("number") != page_number:
        raise DocumentPreviewInvalid("document_preview_invalid")
    image = _decode_visual_image(page.get("imageBase64"))
    digest = page.get("imageSha256")
    if not isinstance(digest, str) or sha256(image).hexdigest() != digest:
        raise DocumentPreviewInvalid("document_preview_invalid")
    return image, digest


def _bounded_text(value: object, maximum: int) -> bool:
    return isinstance(value, str) and 1 <= len(value) <= maximum and "\x00" not in value


def _language(value: object) -> bool:
    return (
        isinstance(value, str)
        and re.fullmatch(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}", value) is not None
    )


def _integer_between(value: object, minimum: int, maximum: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= maximum


def _pdf_extraction_valid(value: object, schema: object) -> bool:
    if not isinstance(value, dict):
        return False
    common_valid = (
        value.get("readingOrder") == "heuristic"
        and isinstance(value.get("tagged"), bool)
        and isinstance(value.get("textAvailable"), bool)
    )
    if not common_valid:
        return False
    if schema in {PDF_DOCUMENT_PREVIEW_SCHEMA, PDF_VISUAL_PRESENTATION_SCHEMA}:
        return (
            set(value)
            == {
                "engine",
                "mode",
                "ocrPerformed",
                "readingOrder",
                "tagged",
                "textAvailable",
            }
            and value.get("engine") == "poppler-pdftotext"
            and value.get("mode") == "layout"
            and value.get("ocrPerformed") is False
        )
    ocr_pages = value.get("ocrPages")
    return (
        set(value)
        == {
            "engine",
            "mode",
            "ocrPerformed",
            "ocrEngine",
            "ocrEngineVersion",
            "ocrModel",
            "ocrPageLimit",
            "ocrPages",
            "ocrPixelLimit",
            "ocrMaximumDimension",
            "ocrTotalPixels",
            "ocrTruncated",
            "readingOrder",
            "tagged",
            "textAvailable",
        }
        and value.get("engine") == "poppler-pdftotext+tesseract"
        and value.get("mode") == "layout+page-ocr"
        and value.get("ocrPerformed") is True
        and value.get("ocrEngine") == "tesseract"
        and isinstance(value.get("ocrEngineVersion"), str)
        and re.fullmatch(
            r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+._A-Za-z0-9]{0,24})?",
            cast(str, value["ocrEngineVersion"]),
        )
        is not None
        and value.get("ocrModel") in PDF_OCR_MODELS
        and value.get("ocrPageLimit") == MAX_PDF_OCR_PAGES
        and isinstance(ocr_pages, list)
        and 1 <= len(ocr_pages) <= MAX_PDF_OCR_PAGES
        and all(_integer_between(page, 1, 200) for page in ocr_pages)
        and ocr_pages == sorted(set(cast(list[int], ocr_pages)))
        and value.get("ocrPixelLimit") == MAX_PDF_OCR_PIXELS
        and _integer_between(value.get("ocrMaximumDimension"), 300, 1_600)
        and _integer_between(value.get("ocrTotalPixels"), 1, MAX_PDF_OCR_PIXELS)
        and isinstance(value.get("ocrTruncated"), bool)
        and (
            value.get("ocrTruncated") is False
            or len(cast(list[object], ocr_pages)) == MAX_PDF_OCR_PAGES
        )
    )


def _decode_visual_image(value: object) -> bytes:
    if not isinstance(value, str) or not 4 <= len(value) <= 700_000:
        raise DocumentPreviewInvalid("document_preview_invalid")
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as error:
        raise DocumentPreviewInvalid("document_preview_invalid") from error


def _jpeg_dimensions(content: bytes) -> tuple[int, int]:
    if not content.startswith(b"\xff\xd8") or not content.endswith(b"\xff\xd9"):
        raise DocumentPreviewInvalid("document_preview_invalid")
    position = 2
    dimensions: tuple[int, int] | None = None
    seen_scan = False
    while position < len(content):
        if content[position] != 0xFF:
            raise DocumentPreviewInvalid("document_preview_invalid")
        while position < len(content) and content[position] == 0xFF:
            position += 1
        if position >= len(content):
            raise DocumentPreviewInvalid("document_preview_invalid")
        marker = content[position]
        position += 1
        if marker == 0xD9:
            if position != len(content) or dimensions is None or not seen_scan:
                raise DocumentPreviewInvalid("document_preview_invalid")
            return dimensions
        if marker in {0x00, 0x01, 0xD8} or 0xD0 <= marker <= 0xD7:
            raise DocumentPreviewInvalid("document_preview_invalid")
        if position + 2 > len(content):
            raise DocumentPreviewInvalid("document_preview_invalid")
        segment_length = int.from_bytes(content[position : position + 2], "big")
        segment_end = position + segment_length
        if segment_length < 2 or segment_end > len(content):
            raise DocumentPreviewInvalid("document_preview_invalid")
        payload = content[position + 2 : segment_end]
        if marker == 0xE0 and not payload.startswith(b"JFIF\x00"):
            raise DocumentPreviewInvalid("document_preview_invalid")
        if marker in {*range(0xE1, 0xF0), 0xFE}:
            raise DocumentPreviewInvalid("document_preview_invalid")
        if marker == 0xC0:
            if len(payload) < 6 or payload[0] != 8:
                raise DocumentPreviewInvalid("document_preview_invalid")
            height = int.from_bytes(payload[1:3], "big")
            width = int.from_bytes(payload[3:5], "big")
            if width < 1 or height < 1 or dimensions is not None:
                raise DocumentPreviewInvalid("document_preview_invalid")
            dimensions = (width, height)
        elif marker in {0xC1, 0xC2}:
            raise DocumentPreviewInvalid("document_preview_invalid")
        if marker != 0xDA:
            position = segment_end
            continue
        if dimensions is None:
            raise DocumentPreviewInvalid("document_preview_invalid")
        seen_scan = True
        position = segment_end
        while position < len(content):
            if content[position] != 0xFF:
                position += 1
                continue
            next_position = position + 1
            while next_position < len(content) and content[next_position] == 0xFF:
                next_position += 1
            if next_position >= len(content):
                raise DocumentPreviewInvalid("document_preview_invalid")
            next_marker = content[next_position]
            if next_marker == 0x00 or 0xD0 <= next_marker <= 0xD7:
                position = next_position + 1
                continue
            if next_marker != 0xD9:
                raise DocumentPreviewInvalid("document_preview_invalid")
            position = next_position - 1
            break
    raise DocumentPreviewInvalid("document_preview_invalid")
