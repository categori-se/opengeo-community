import base64
import json
import math
import re
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any, cast

from opengeo_worker.command_runner import CommandRunner
from opengeo_worker.models import ValidationFailure

PRESENTATION_SCHEMA = "opengeo.pdf-visual-presentation.1.0.0"
OCR_PRESENTATION_SCHEMA = "opengeo.pdf-visual-presentation.2.0.0"
PRESENTATION_CONTENT_TYPE = "application/json"

_MAX_PAGES = 200
_MAX_PAGE_IMAGE_BYTES = 512 * 1024
_MAX_TOTAL_IMAGE_BYTES = 2_400_000
_MAX_TOTAL_PIXELS = 20_000_000
_MAX_PRESENTATION_BYTES = 4 * 1024 * 1024
_MAX_DIMENSION = 1_000
_MIN_DIMENSION = 64
_MAX_RENDER_ATTEMPTS = 8
_IMAGE_NAME = re.compile(r"document-visual-(0*[1-9][0-9]{0,2})\.jpg")


@dataclass(frozen=True, slots=True)
class PdfVisualPresentation:
    path: Path
    schema: str
    page_count: int
    target_maximum_dimension: int
    total_pixels: int
    total_image_bytes: int


def build_pdf_visual_presentation(
    source: Path,
    semantic_preview: Path,
    workdir: Path,
    runner: CommandRunner,
    *,
    page_count: int,
) -> PdfVisualPresentation:
    """Build one bounded, deterministic, all-page visual-plus-semantic JSON artifact."""
    if not 1 <= page_count <= _MAX_PAGES:
        raise ValidationFailure("document_metadata_invalid")
    semantic = _semantic_document(semantic_preview, page_count)
    dimension = max(
        _MIN_DIMENSION,
        min(_MAX_DIMENSION, math.isqrt(_MAX_TOTAL_PIXELS // page_count)),
    )
    images: list[tuple[int, int, bytes]] | None = None
    total_pixels = 0
    total_image_bytes = 0
    for _attempt in range(_MAX_RENDER_ATTEMPTS):
        _remove_prior_images(workdir)
        prefix = workdir / "document-visual"
        try:
            runner.run(
                "pdftoppm",
                [
                    "-f",
                    "1",
                    "-l",
                    str(page_count),
                    "-r",
                    "96",
                    "-scale-to",
                    str(dimension),
                    "-hide-annotations",
                    "-jpeg",
                    "-jpegopt",
                    "quality=55,progressive=n,optimize=y",
                    str(source),
                    str(prefix),
                ],
                cwd=workdir,
                maximum_file_bytes=4 * 1024 * 1024,
            )
        except ValidationFailure as error:
            raise ValidationFailure("document_visual_presentation_failed") from error
        rendered = _rendered_images(workdir, page_count)
        images = []
        total_pixels = 0
        total_image_bytes = 0
        maximum_page_bytes = 0
        for path in rendered:
            try:
                content = path.read_bytes()
            except OSError as error:
                raise ValidationFailure("document_visual_presentation_failed") from error
            width, height = _jpeg_dimensions(content)
            if width > dimension or height > dimension:
                raise ValidationFailure("document_visual_presentation_failed")
            images.append((width, height, content))
            total_pixels += width * height
            total_image_bytes += len(content)
            maximum_page_bytes = max(maximum_page_bytes, len(content))
        if (
            total_pixels <= _MAX_TOTAL_PIXELS
            and total_image_bytes <= _MAX_TOTAL_IMAGE_BYTES
            and maximum_page_bytes <= _MAX_PAGE_IMAGE_BYTES
        ):
            break
        ratios = [
            math.sqrt(_MAX_TOTAL_PIXELS / max(1, total_pixels)),
            math.sqrt(_MAX_TOTAL_IMAGE_BYTES / max(1, total_image_bytes)),
            math.sqrt(_MAX_PAGE_IMAGE_BYTES / max(1, maximum_page_bytes)),
        ]
        next_dimension = max(_MIN_DIMENSION, int(dimension * min(ratios) * 0.88))
        if next_dimension >= dimension:
            next_dimension = max(_MIN_DIMENSION, dimension - max(1, dimension // 5))
        if next_dimension == dimension:
            images = None
            break
        dimension = next_dimension
    if (
        images is None
        or len(images) != page_count
        or total_pixels > _MAX_TOTAL_PIXELS
        or total_image_bytes > _MAX_TOTAL_IMAGE_BYTES
        or any(len(content) > _MAX_PAGE_IMAGE_BYTES for _, _, content in images)
    ):
        raise ValidationFailure("document_visual_presentation_limit_exceeded")

    semantic_pages = cast(list[dict[str, Any]], semantic["pages"])
    pages: list[dict[str, object]] = []
    for number, ((width, height, content), semantic_page) in enumerate(
        zip(images, semantic_pages, strict=True), start=1
    ):
        page: dict[str, object] = {
            "number": number,
            "width": width,
            "height": height,
            "imageBase64": base64.b64encode(content).decode("ascii"),
            "imageSha256": sha256(content).hexdigest(),
            "blocks": semantic_page["blocks"],
        }
        if "textSource" in semantic_page:
            page["textSource"] = semantic_page["textSource"]
        pages.append(page)
    schema = (
        OCR_PRESENTATION_SCHEMA
        if semantic["schemaVersion"] == "opengeo.document-preview.3.0.0"
        else PRESENTATION_SCHEMA
    )
    presentation = {
        "schemaVersion": schema,
        "sourceFormat": "pdf",
        "pdfVersion": semantic["pdfVersion"],
        "title": semantic["title"],
        "language": semantic["language"],
        "extraction": semantic["extraction"],
        "rendering": {
            "engine": "poppler-pdftoppm",
            "mediaType": "image/jpeg",
            "annotationsHidden": True,
            "colorSpace": "rgb",
            "pageCount": page_count,
            "targetMaximumDimension": dimension,
            "totalPixels": total_pixels,
            "totalImageBytes": total_image_bytes,
        },
        "pages": pages,
    }
    encoded = (
        json.dumps(presentation, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode("utf-8")
    if len(encoded) > _MAX_PRESENTATION_BYTES:
        raise ValidationFailure("document_visual_presentation_limit_exceeded")
    target = workdir / "visual-presentation.json"
    target.write_bytes(encoded)
    return PdfVisualPresentation(
        target,
        schema,
        page_count,
        dimension,
        total_pixels,
        total_image_bytes,
    )


def _semantic_document(path: Path, page_count: int) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as error:
        raise ValidationFailure("document_visual_presentation_failed") from error
    if (
        not isinstance(value, dict)
        or value.get("schemaVersion")
        not in {"opengeo.document-preview.2.0.0", "opengeo.document-preview.3.0.0"}
        or value.get("sourceFormat") != "pdf"
        or not isinstance(value.get("pages"), list)
        or len(value["pages"]) != page_count
        or any(
            not isinstance(page, dict)
            or page.get("number") != number
            or not isinstance(page.get("blocks"), list)
            for number, page in enumerate(value["pages"], start=1)
        )
    ):
        raise ValidationFailure("document_visual_presentation_failed")
    ocr_schema = value["schemaVersion"] == "opengeo.document-preview.3.0.0"
    if any(
        (
            set(page) != {"number", "blocks", "textSource"}
            if ocr_schema
            else set(page) != {"number", "blocks"}
        )
        or (ocr_schema and page.get("textSource") not in {"embedded", "ocr", "none"})
        for page in value["pages"]
    ):
        raise ValidationFailure("document_visual_presentation_failed")
    return cast(dict[str, Any], value)


def _remove_prior_images(workdir: Path) -> None:
    for path in workdir.iterdir():
        if _IMAGE_NAME.fullmatch(path.name):
            path.unlink()


def _rendered_images(workdir: Path, page_count: int) -> tuple[Path, ...]:
    indexed: dict[int, Path] = {}
    for path in workdir.iterdir():
        match = _IMAGE_NAME.fullmatch(path.name)
        if match is None:
            continue
        number = int(match.group(1))
        if number in indexed:
            raise ValidationFailure("document_visual_presentation_failed")
        indexed[number] = path
    if set(indexed) != set(range(1, page_count + 1)):
        raise ValidationFailure("document_visual_presentation_failed")
    return tuple(indexed[number] for number in range(1, page_count + 1))


def _jpeg_dimensions(content: bytes) -> tuple[int, int]:
    """Accept the closed baseline-JPEG shape emitted by the fixed Poppler command."""
    if not content.startswith(b"\xff\xd8") or not content.endswith(b"\xff\xd9"):
        raise ValidationFailure("document_visual_presentation_failed")
    position = 2
    dimensions: tuple[int, int] | None = None
    seen_scan = False
    while position < len(content):
        if content[position] != 0xFF:
            raise ValidationFailure("document_visual_presentation_failed")
        while position < len(content) and content[position] == 0xFF:
            position += 1
        if position >= len(content):
            raise ValidationFailure("document_visual_presentation_failed")
        marker = content[position]
        position += 1
        if marker == 0xD9:
            if position != len(content) or dimensions is None or not seen_scan:
                raise ValidationFailure("document_visual_presentation_failed")
            return dimensions
        if marker in {0x00, 0x01, 0xD8} or 0xD0 <= marker <= 0xD7:
            raise ValidationFailure("document_visual_presentation_failed")
        if position + 2 > len(content):
            raise ValidationFailure("document_visual_presentation_failed")
        segment_length = int.from_bytes(content[position : position + 2], "big")
        segment_end = position + segment_length
        if segment_length < 2 or segment_end > len(content):
            raise ValidationFailure("document_visual_presentation_failed")
        payload = content[position + 2 : segment_end]
        if marker == 0xE0 and not payload.startswith(b"JFIF\x00"):
            raise ValidationFailure("document_visual_presentation_failed")
        if marker in {*range(0xE1, 0xF0), 0xFE}:
            raise ValidationFailure("document_visual_presentation_failed")
        if marker == 0xC0:
            if len(payload) < 6 or payload[0] != 8:
                raise ValidationFailure("document_visual_presentation_failed")
            height = int.from_bytes(payload[1:3], "big")
            width = int.from_bytes(payload[3:5], "big")
            if width < 1 or height < 1 or dimensions is not None:
                raise ValidationFailure("document_visual_presentation_failed")
            dimensions = (width, height)
        elif marker in {0xC1, 0xC2}:
            raise ValidationFailure("document_visual_presentation_failed")
        if marker != 0xDA:
            position = segment_end
            continue
        if dimensions is None:
            raise ValidationFailure("document_visual_presentation_failed")
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
                raise ValidationFailure("document_visual_presentation_failed")
            next_marker = content[next_position]
            if next_marker == 0x00 or 0xD0 <= next_marker <= 0xD7:
                position = next_position + 1
                continue
            if next_marker != 0xD9:
                raise ValidationFailure("document_visual_presentation_failed")
            position = next_position - 1
            break
    raise ValidationFailure("document_visual_presentation_failed")
