import math
import re
from dataclasses import dataclass
from pathlib import Path

from opengeo_worker.command_runner import CommandRunner
from opengeo_worker.models import ValidationFailure

MAX_OCR_PAGES = 32
MAX_OCR_PIXELS = 32_000_000
MAX_OCR_DIMENSION = 1_600
MIN_OCR_DIMENSION = 300
MAX_OCR_PAGE_BYTES = 8 * 1024 * 1024
MAX_OCR_TEXT_BYTES = 1_048_576

_VERSION = re.compile(r"tesseract ([0-9]+\.[0-9]+\.[0-9]+(?:[-+._A-Za-z0-9]{0,24})?)")
_MODELS = frozenset(
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


@dataclass(frozen=True, slots=True)
class PdfOcrResult:
    text_by_page: dict[int, str]
    attempted_pages: tuple[int, ...]
    truncated: bool
    engine_version: str
    model: str
    maximum_dimension: int
    total_pixels: int


def ocr_pdf_pages(
    source: Path,
    workdir: Path,
    runner: CommandRunner,
    *,
    page_numbers: tuple[int, ...],
    page_count: int,
    language: str | None,
) -> PdfOcrResult:
    """OCR bounded text-empty PDF pages through isolated Poppler and Tesseract."""

    if (
        not page_numbers
        or not 1 <= page_count <= 200
        or tuple(sorted(set(page_numbers))) != page_numbers
        or page_numbers[0] < 1
        or page_numbers[-1] > page_count
    ):
        raise ValidationFailure("document_ocr_input_invalid")
    attempted = page_numbers[:MAX_OCR_PAGES]
    dimension = max(
        MIN_OCR_DIMENSION,
        min(MAX_OCR_DIMENSION, math.isqrt(MAX_OCR_PIXELS // len(attempted))),
    )
    try:
        version_result = runner.run("tesseract", ["--version"], cwd=workdir)
        version_output = version_result.stdout + version_result.stderr
    except ValidationFailure as error:
        raise ValidationFailure("document_ocr_failed") from error
    version_match = _VERSION.search(version_output)
    if version_match is None:
        raise ValidationFailure("document_ocr_runtime_invalid")
    engine_version = version_match.group(1)
    model = select_ocr_model(language)
    text_by_page: dict[int, str] = {}
    total_pixels = 0
    total_text_bytes = 0
    for page_number in attempted:
        prefix = workdir / f"document-ocr-{page_number}"
        image = prefix.with_suffix(".png")
        try:
            runner.run(
                "pdftoppm",
                [
                    "-f",
                    str(page_number),
                    "-l",
                    str(page_number),
                    "-singlefile",
                    "-r",
                    "200",
                    "-scale-to",
                    str(dimension),
                    "-gray",
                    "-png",
                    str(source),
                    str(prefix),
                ],
                cwd=workdir,
                maximum_file_bytes=MAX_OCR_PAGE_BYTES,
            )
            width, height = _png_dimensions(image, dimension)
            total_pixels += width * height
            if total_pixels > MAX_OCR_PIXELS:
                raise ValidationFailure("document_ocr_pixel_limit_exceeded")
            output = runner.run(
                "tesseract",
                [
                    str(image),
                    "stdout",
                    "--oem",
                    "1",
                    "--psm",
                    "3",
                    "-l",
                    model,
                    "-c",
                    "user_defined_dpi=200",
                    "txt",
                ],
                cwd=workdir,
                maximum_file_bytes=MAX_OCR_TEXT_BYTES,
            ).stdout
        except ValidationFailure as error:
            raise ValidationFailure("document_ocr_failed") from error
        finally:
            image.unlink(missing_ok=True)
        if "\x00" in output:
            raise ValidationFailure("document_ocr_output_invalid")
        normalized = output.replace("\r\n", "\n").replace("\r", "\n").strip("\n\f ")
        encoded_bytes = len(normalized.encode("utf-8"))
        total_text_bytes += encoded_bytes
        if encoded_bytes > 128 * 1024 or total_text_bytes > MAX_OCR_TEXT_BYTES:
            raise ValidationFailure("document_ocr_text_limit_exceeded")
        text_by_page[page_number] = normalized
    return PdfOcrResult(
        text_by_page=text_by_page,
        attempted_pages=attempted,
        truncated=len(attempted) != len(page_numbers),
        engine_version=engine_version,
        model=model,
        maximum_dimension=dimension,
        total_pixels=total_pixels,
    )


def select_ocr_model(language: str | None) -> str:
    if language is None:
        return "eng"
    pieces = language.replace("_", "-").split("-")
    primary = pieces[0].lower()
    normalized_pieces = {piece.lower() for piece in pieces[1:]}
    if primary in {"ar", "ckb", "fa", "ku", "ps", "sd", "ug", "ur"}:
        model = "Arabic"
    elif primary in {"as", "bn"}:
        model = "Bengali"
    elif primary in {"be", "bg", "kk", "ky", "mk", "mn", "ru", "tg", "uk"}:
        model = "Cyrillic"
    elif primary in {"hi", "mai", "mr", "ne", "sa"}:
        model = "Devanagari"
    elif primary in {"am", "ti"}:
        model = "Ethiopic"
    elif primary in {"el", "grc"}:
        model = "Greek"
    elif primary == "ko":
        model = "Hangul"
    elif primary == "zh":
        model = "HanT" if normalized_pieces.intersection({"hant", "hk", "mo", "tw"}) else "HanS"
    elif primary == "he" or primary == "yi":
        model = "Hebrew"
    elif primary == "ja":
        model = "Japanese"
    elif primary == "th":
        model = "Thai"
    else:
        model = "Latin"
    if model not in _MODELS:
        raise AssertionError("unregistered OCR model")
    return model


def _png_dimensions(path: Path, maximum_dimension: int) -> tuple[int, int]:
    try:
        size = path.stat().st_size
        content = path.read_bytes()[:24]
    except OSError as error:
        raise ValidationFailure("document_ocr_render_invalid") from error
    if (
        not 1 <= size <= MAX_OCR_PAGE_BYTES
        or len(content) != 24
        or not content.startswith(b"\x89PNG\r\n\x1a\n")
        or content[12:16] != b"IHDR"
    ):
        raise ValidationFailure("document_ocr_render_invalid")
    width = int.from_bytes(content[16:20], "big")
    height = int.from_bytes(content[20:24], "big")
    if not 1 <= width <= maximum_dimension or not 1 <= height <= maximum_dimension:
        raise ValidationFailure("document_ocr_render_invalid")
    return width, height
