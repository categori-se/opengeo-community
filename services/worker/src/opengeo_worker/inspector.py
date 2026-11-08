import json
import math
import re
import stat
import zipfile
import zlib
from pathlib import Path, PurePosixPath
from typing import Any, cast

from opengeo_worker.command_runner import CommandRunner
from opengeo_worker.config import Settings
from opengeo_worker.geometry_dimensions import dimension_evidence
from opengeo_worker.kml_sources import inspect_kml_source
from opengeo_worker.malware import ClamAvScanner, MalwareScanEvidence, MalwareScanner
from opengeo_worker.models import ArtifactFile, DatasetFormat, InspectionResult, ValidationFailure
from opengeo_worker.odf_documents import inspect_odt
from opengeo_worker.pdf_documents import (
    PREVIEW_CONTENT_TYPE as PDF_PREVIEW_CONTENT_TYPE,
)
from opengeo_worker.pdf_documents import (
    extract_pdf_semantic_preview,
)
from opengeo_worker.pdf_ocr import MAX_OCR_PAGES, MAX_OCR_PIXELS
from opengeo_worker.pdf_presentations import (
    PRESENTATION_CONTENT_TYPE as PDF_PRESENTATION_CONTENT_TYPE,
)
from opengeo_worker.pdf_presentations import build_pdf_visual_presentation
from opengeo_worker.pdf_print_vectors import SCHEMA as PDF_PRINT_VECTOR_SCHEMA
from opengeo_worker.pdf_print_vectors import build_pdf_print_vectors
from opengeo_worker.working_counts import working_count_evidence

_EXPECTED_VECTOR_DRIVER: dict[DatasetFormat, str] = {
    "geojson": "GeoJSON",
    "csv": "CSV",
    "shapefile": "ESRI Shapefile",
    "mapinfo": "MapInfo File",
    "geopackage": "GPKG",
    "geoparquet": "Parquet",
    "pmtiles": "PMTiles",
}

_MEDIA_FORMATS: frozenset[DatasetFormat] = frozenset({"png", "jpeg"})
_EXPECTED_MEDIA_DRIVER: dict[DatasetFormat, str] = {"png": "PNG", "jpeg": "JPEG"}
_NORMALIZED_RASTER_DRIVERS: dict[DatasetFormat, str] = {
    "geotiff": "GTiff", "nitf": "NITF", "img": "HFA",
}
_MAX_MEDIA_SOURCE_BYTES = 16 * 1024 * 1024
_MAX_MEDIA_DIMENSION = 20_000
_MAX_MEDIA_PIXELS = 40_000_000
_MAX_PUBLISHABLE_IMAGE_BYTES = 4 * 1024 * 1024
_NORMALIZED_IMAGE_MAX_DIMENSION = 900
_THUMBNAIL_MAX_DIMENSION = 320
_MAX_DOCUMENT_SOURCE_BYTES = 32 * 1024 * 1024
_MAX_DOCUMENT_PAGES = 200
_MAX_DOCUMENT_PAGE_POINTS = 14_400
_DOCUMENT_PREVIEW_MAX_DIMENSION = 1_000
_PDF_HEADER = re.compile(rb"\A%PDF-(?:1\.[0-7]|2\.0)(?:\r\n|\r|\n)")
_PDF_NAME_ESCAPE = re.compile(rb"#([0-9A-Fa-f]{2})")
_PDF_ACTIVE_NAME = re.compile(
    rb"/(?:AA|AcroForm|EmbeddedFiles|Encrypt|Filespec|ImportData|JavaScript|JS|"
    rb"Launch|OpenAction|RichMedia|SubmitForm|XFA)"
    rb"(?=[\x00\x09\x0a\x0c\x0d\x20()<>\[\]{}/%])"
)
_PDF_PAGE_SIZE = re.compile(
    r"^Page(?:\s+\d+)? size:\s*([0-9]+(?:\.[0-9]+)?) x "
    r"([0-9]+(?:\.[0-9]+)?) pts(?:\s|$)",
    re.MULTILINE,
)
_WKT_AUTHORITY_ID = re.compile(
    r'(?:ID|AUTHORITY)\["([A-Za-z][A-Za-z0-9_.-]{0,31})",\s*"?'
    r'([A-Za-z0-9_.:-]{1,64})"?\]'
)
_EICAR_TEST_SIGNATURE = b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"


class DatasetInspector:
    def __init__(
        self,
        settings: Settings,
        runner: CommandRunner | None = None,
        scanner: MalwareScanner | None = None,
    ) -> None:
        self._settings = settings
        self._runner = runner or CommandRunner(
            settings.workspace_root,
            timeout_seconds=settings.command_timeout_seconds,
            output_bytes=settings.command_output_bytes,
        )
        self._scanner = scanner or ClamAvScanner(
            self._runner, maximum_bytes=settings.max_object_bytes
        )

    def inspect(
        self,
        source: Path,
        dataset_format: DatasetFormat,
        workdir: Path,
    ) -> InspectionResult:
        if source.parent.resolve() != workdir.resolve() or source.stat().st_size < 1:
            raise ValidationFailure("source_file_invalid")
        scan = self._scanner.scan(source, workdir)
        if dataset_format in _MEDIA_FORMATS:
            self._verify_media_structure(source, dataset_format)
            return self._with_malware_scan(
                self._inspect_media(source, dataset_format, workdir), scan
            )
        if dataset_format == "kml":
            return self._with_malware_scan(inspect_kml_source(source), scan)
        if dataset_format == "pdf":
            self._verify_pdf_structure(source)
            return self._with_malware_scan(self._inspect_pdf(source, workdir), scan)
        if dataset_format == "odt":
            return self._with_malware_scan(
                inspect_odt(
                    source,
                    workdir,
                    maximum_entries=self._settings.max_archive_entries,
                    maximum_expanded_bytes=self._settings.max_archive_expanded_bytes,
                    maximum_ratio=self._settings.max_archive_ratio,
                ),
                scan,
            )
        self._verify_magic(source, dataset_format)
        if dataset_format == "cog":
            return self._with_malware_scan(self._inspect_cog(source, workdir), scan)
        if dataset_format in _NORMALIZED_RASTER_DRIVERS:
            return self._with_malware_scan(
                self._inspect_normalized_raster(source, dataset_format, workdir), scan
            )
        datasource = self._vector_datasource(source, dataset_format)
        return self._with_malware_scan(
            self._inspect_vector(datasource, dataset_format, workdir), scan
        )

    @staticmethod
    def _with_malware_scan(result: InspectionResult, scan: MalwareScanEvidence) -> InspectionResult:
        quality = dict(result.quality_results)
        raw_checks = quality.get("checks", [])
        checks = list(raw_checks) if isinstance(raw_checks, list) else []
        checks.append({"code": "malware_signature_and_heuristic_scan", "status": "passed"})
        quality["checks"] = checks
        quality["safety_scan"] = scan.as_quality_record()
        return InspectionResult(
            feature_count=result.feature_count,
            extent=result.extent,
            crs=result.crs,
            geometry_type=result.geometry_type,
            schema_definition=result.schema_definition,
            quality_results=quality,
            artifacts=result.artifacts,
        )

    def _inspect_media(
        self,
        source: Path,
        dataset_format: DatasetFormat,
        workdir: Path,
    ) -> InspectionResult:
        open_options = ["-oo", "APPLY_ORIENTATION=YES"] if dataset_format == "jpeg" else []
        result = self._runner.run("gdalinfo", ["-json", *open_options, str(source)], cwd=workdir)
        try:
            document = json.loads(result.stdout)
        except ValueError as error:
            raise ValidationFailure("media_metadata_invalid") from error
        size = document.get("size") if isinstance(document, dict) else None
        bands = document.get("bands") if isinstance(document, dict) else None
        if (
            not isinstance(document, dict)
            or document.get("driverShortName") != _EXPECTED_MEDIA_DRIVER[dataset_format]
        ):
            raise ValidationFailure("dataset_format_mismatch")
        if (
            not isinstance(size, list)
            or len(size) != 2
            or not all(isinstance(value, int) and not isinstance(value, bool) for value in size)
            or not isinstance(bands, list)
            or not 1 <= len(bands) <= 4
        ):
            raise ValidationFailure("media_metadata_invalid")
        width, height = cast(list[int], size)
        if (
            width < 1
            or height < 1
            or width > _MAX_MEDIA_DIMENSION
            or height > _MAX_MEDIA_DIMENSION
            or width * height > _MAX_MEDIA_PIXELS
        ):
            raise ValidationFailure("media_dimensions_exceeded")

        normalized_size = self._scaled_dimensions(width, height, _NORMALIZED_IMAGE_MAX_DIMENSION)
        thumbnail_size = self._scaled_dimensions(width, height, _THUMBNAIL_MAX_DIMENSION)
        normalized = workdir / "normalized.png"
        thumbnail = workdir / "thumbnail.png"
        self._normalize_media(source, normalized, normalized_size, open_options, workdir)
        self._normalize_media(source, thumbnail, thumbnail_size, open_options, workdir)
        self._require_publishable_image(normalized)
        self._require_publishable_image(thumbnail)

        return InspectionResult(
            feature_count=None,
            extent=None,
            crs=None,
            geometry_type="image",
            schema_definition={
                "media": {
                    "kind": "image",
                    "source_format": dataset_format,
                    "width": width,
                    "height": height,
                    "band_count": len(bands),
                    "normalized_width": normalized_size[0],
                    "normalized_height": normalized_size[1],
                }
            },
            quality_results={
                "valid": True,
                "checks": [
                    {"code": "format_verified", "status": "passed"},
                    {"code": "media_structure_verified", "status": "passed"},
                    {"code": "gdal_read_only_decode", "status": "passed"},
                    {"code": "metadata_stripped_by_normalization", "status": "passed"},
                    {"code": "publication_derivative_bounded", "status": "passed"},
                ],
                "warnings": [],
            },
            artifacts=(
                ArtifactFile("derived", "media/normalized.png", "image/png", normalized),
                ArtifactFile("thumbnail", "thumbnail/overview.png", "image/png", thumbnail),
            ),
        )

    def _inspect_pdf(self, source: Path, workdir: Path) -> InspectionResult:
        try:
            metadata = self._runner.run(
                "pdfinfo", ["-box", "-isodates", str(source)], cwd=workdir
            ).stdout
        except ValidationFailure as error:
            raise ValidationFailure("document_metadata_invalid") from error
        fields: dict[str, str] = {}
        for line in metadata.splitlines():
            key, separator, value = line.partition(":")
            if separator and key in {
                "Pages",
                "Encrypted",
                "PDF version",
                "Title",
                "Language",
                "Tagged",
            }:
                fields[key] = value.strip()
        try:
            page_count = int(fields["Pages"])
        except (KeyError, ValueError) as error:
            raise ValidationFailure("document_metadata_invalid") from error
        page_sizes = [
            (float(match.group(1)), float(match.group(2)))
            for match in _PDF_PAGE_SIZE.finditer(metadata)
        ]
        pdf_version = fields.get("PDF version")
        if (
            not 1 <= page_count <= _MAX_DOCUMENT_PAGES
            or fields.get("Encrypted") != "no"
            or not isinstance(pdf_version, str)
            or re.fullmatch(r"(?:1\.[0-7]|2\.0)", pdf_version) is None
            or not page_sizes
            or any(
                width <= 0
                or height <= 0
                or width > _MAX_DOCUMENT_PAGE_POINTS
                or height > _MAX_DOCUMENT_PAGE_POINTS
                for width, height in page_sizes
            )
        ):
            raise ValidationFailure("document_metadata_invalid")

        try:
            javascript = self._runner.run("pdfinfo", ["-js", str(source)], cwd=workdir)
            attachments = self._runner.run("pdfdetach", ["-list", str(source)], cwd=workdir)
        except ValidationFailure as error:
            raise ValidationFailure("document_metadata_invalid") from error
        if javascript.stdout.strip():
            raise ValidationFailure("document_active_content_blocked")
        if re.fullmatch(r"\s*0 embedded files\s*", attachments.stdout) is None:
            raise ValidationFailure("document_active_content_blocked")

        semantic_preview = extract_pdf_semantic_preview(
            source,
            workdir,
            self._runner,
            page_count=page_count,
            pdf_version=pdf_version,
            title=fields.get("Title"),
            language=fields.get("Language"),
            tagged=fields.get("Tagged") == "yes",
        )

        preview_prefix = workdir / "document-preview-page-1"
        try:
            self._runner.run(
                "pdftoppm",
                [
                    "-f",
                    "1",
                    "-l",
                    "1",
                    "-singlefile",
                    "-r",
                    "96",
                    "-scale-to",
                    str(_DOCUMENT_PREVIEW_MAX_DIMENSION),
                    "-hide-annotations",
                    "-png",
                    str(source),
                    str(preview_prefix),
                ],
                cwd=workdir,
            )
        except ValidationFailure as error:
            raise ValidationFailure("document_preview_generation_failed") from error
        preview = workdir / "document-preview-page-1.png"
        try:
            self._strip_png_ancillary_metadata(preview)
            self._require_publishable_image(preview)
            preview_width, preview_height = self._png_dimensions(preview)
        except (OSError, ValidationFailure) as error:
            raise ValidationFailure("document_preview_generation_failed") from error
        thumbnail = workdir / "document-thumbnail.png"
        thumbnail_size = self._scaled_dimensions(
            preview_width, preview_height, _THUMBNAIL_MAX_DIMENSION
        )
        try:
            self._normalize_media(preview, thumbnail, thumbnail_size, [], workdir)
            self._require_publishable_image(thumbnail)
        except ValidationFailure as error:
            raise ValidationFailure("document_preview_generation_failed") from error

        visual_presentation = build_pdf_visual_presentation(
            source,
            semantic_preview.path,
            workdir,
            self._runner,
            page_count=page_count,
        )

        print_vectors, print_vector_facts = build_pdf_print_vectors(
            source,
            workdir,
            self._runner,
            page_count=page_count,
        )
        ocr = semantic_preview.ocr
        document_definition: dict[str, object] = {
            "kind": "pdf",
            "source_format": "pdf",
            "pdf_version": pdf_version,
            "page_count": page_count,
            "encrypted": False,
            "preview_page": 1,
            "preview_width": preview_width,
            "preview_height": preview_height,
            "accessible_preview_schema": semantic_preview.schema,
            "text_extraction": semantic_preview.text_extraction,
            "reading_order": semantic_preview.reading_order,
            "ocr_performed": ocr is not None,
            "tagged": fields.get("Tagged") == "yes",
            "text_available": semantic_preview.text_available,
            "text_block_count": semantic_preview.block_count,
            "text_characters": semantic_preview.text_characters,
            "visual_presentation_schema": visual_presentation.schema,
            "visual_renderer": "poppler_pdftoppm",
            "visual_media_type": "image/jpeg",
            "visual_annotations_hidden": True,
            "visual_page_count": visual_presentation.page_count,
            "visual_target_max_dimension": visual_presentation.target_maximum_dimension,
            "visual_total_pixels": visual_presentation.total_pixels,
            "visual_total_image_bytes": visual_presentation.total_image_bytes,
            "print_vector_available": print_vectors is not None,
            "print_vector_schema": PDF_PRINT_VECTOR_SCHEMA,
            "print_vector_facts": print_vector_facts,
        }
        checks = [
            {"code": "format_verified", "status": "passed"},
            {"code": "pdf_structure_verified", "status": "passed"},
            {"code": "active_content_and_attachments_absent", "status": "passed"},
            {"code": "isolated_first_page_render", "status": "passed"},
            {"code": "preview_metadata_stripped", "status": "passed"},
            {"code": "bounded_full_document_text_extraction", "status": "passed"},
            {"code": "accessible_preview_generated", "status": "passed"},
            {"code": "bounded_all_page_visual_presentation", "status": "passed"},
        ]
        warnings = [
            {"code": "public_original_is_attachment_only"},
            {"code": "visual_presentation_is_bounded_lossy_raster"},
        ]
        if print_vectors is None:
            warnings.append({"code": "print_vector_unavailable_unsupported_or_bounded"})
        else:
            checks.append({"code": "bounded_safe_vector_pdf_prepared", "status": "passed"})
        if semantic_preview.reading_order == "heuristic":
            warnings.append({"code": "semantic_pdf_text_reading_order_is_heuristic"})
        if ocr is None:
            warnings.append({"code": "ocr_not_performed"})
        else:
            document_definition.update(
                {
                    "ocr_engine": "tesseract",
                    "ocr_engine_version": ocr.engine_version,
                    "ocr_model": ocr.model,
                    "ocr_page_limit": MAX_OCR_PAGES,
                    "ocr_page_count": len(ocr.attempted_pages),
                    "ocr_pages": list(ocr.attempted_pages),
                    "ocr_pixel_limit": MAX_OCR_PIXELS,
                    "ocr_maximum_dimension": ocr.maximum_dimension,
                    "ocr_total_pixels": ocr.total_pixels,
                    "ocr_truncated": ocr.truncated,
                }
            )
            checks.append({"code": "bounded_text_empty_page_ocr", "status": "passed"})
            warnings.append({"code": "ocr_text_is_heuristic_and_may_contain_errors"})
            if ocr.truncated:
                warnings.append({"code": "ocr_page_limit_reached"})

        return InspectionResult(
            feature_count=None,
            extent=None,
            crs=None,
            geometry_type="document",
            schema_definition={"document": document_definition},
            quality_results={
                "valid": True,
                "checks": checks,
                "warnings": warnings,
            },
            artifacts=(
                (
                    ArtifactFile(
                        "derived",
                        "document/print-vector.pdf",
                        "application/pdf",
                        print_vectors,
                    ),
                )
                if print_vectors is not None
                else ()
            )
            + (
                ArtifactFile(
                    "derived",
                    "document/preview-page-1.png",
                    "image/png",
                    preview,
                ),
                ArtifactFile(
                    "thumbnail",
                    "thumbnail/overview.png",
                    "image/png",
                    thumbnail,
                ),
                ArtifactFile(
                    "derived",
                    "document/accessible-preview.json",
                    PDF_PREVIEW_CONTENT_TYPE,
                    semantic_preview.path,
                ),
                ArtifactFile(
                    "derived",
                    "document/visual-presentation.json",
                    PDF_PRESENTATION_CONTENT_TYPE,
                    visual_presentation.path,
                ),
            ),
        )

    @staticmethod
    def _png_dimensions(path: Path) -> tuple[int, int]:
        content = path.read_bytes()[:24]
        if len(content) != 24 or not content.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValidationFailure("media_structure_invalid")
        return int.from_bytes(content[16:20], "big"), int.from_bytes(content[20:24], "big")

    @staticmethod
    def _verify_pdf_structure(source: Path) -> None:
        if source.stat().st_size > _MAX_DOCUMENT_SOURCE_BYTES:
            raise ValidationFailure("document_source_too_large")
        try:
            content = source.read_bytes()
        except OSError as error:
            raise ValidationFailure("document_structure_invalid") from error
        stripped = content.rstrip(b"\x00\t\n\x0c\r ")
        if _PDF_HEADER.match(content) is None or not stripped.endswith(b"%%EOF"):
            raise ValidationFailure("document_structure_invalid")
        normalized_names = _PDF_NAME_ESCAPE.sub(
            lambda match: bytes.fromhex(match.group(1).decode("ascii")), content
        )
        if _PDF_ACTIVE_NAME.search(normalized_names) is not None:
            raise ValidationFailure("document_active_content_blocked")

    def _normalize_media(
        self,
        source: Path,
        target: Path,
        size: tuple[int, int],
        open_options: list[str],
        workdir: Path,
    ) -> None:
        self._runner.run(
            "gdal_translate",
            [
                "-of",
                "PNG",
                *open_options,
                "-ot",
                "Byte",
                "-outsize",
                str(size[0]),
                str(size[1]),
                "-noxmp",
                "-co",
                "ZLEVEL=9",
                str(source),
                str(target),
            ],
            cwd=workdir,
        )
        self._strip_png_ancillary_metadata(target)

    @classmethod
    def _strip_png_ancillary_metadata(cls, path: Path) -> None:
        cls._verify_media_structure(path, "png")
        content = path.read_bytes()
        sanitized = bytearray(content[:8])
        position = 8
        while position < len(content):
            length = int.from_bytes(content[position : position + 4], "big")
            chunk_type = content[position + 4 : position + 8]
            end = position + 12 + length
            if chunk_type[0] & 0x20 == 0 or chunk_type == b"tRNS":
                sanitized.extend(content[position:end])
            position = end
            if chunk_type == b"IEND":
                break
        try:
            path.write_bytes(sanitized)
        except OSError as error:
            raise ValidationFailure("media_derivative_generation_failed") from error

    def _require_publishable_image(self, path: Path) -> None:
        if (
            not path.is_file()
            or path.stat().st_size < 1
            or path.stat().st_size > _MAX_PUBLISHABLE_IMAGE_BYTES
        ):
            raise ValidationFailure("media_derivative_generation_failed")
        self._verify_media_structure(path, "png")

    @staticmethod
    def _scaled_dimensions(width: int, height: int, maximum: int) -> tuple[int, int]:
        if max(width, height) <= maximum:
            return width, height
        scale = maximum / max(width, height)
        return max(1, round(width * scale)), max(1, round(height * scale))

    @classmethod
    def _verify_media_structure(cls, source: Path, dataset_format: DatasetFormat) -> None:
        size = source.stat().st_size
        if size > _MAX_MEDIA_SOURCE_BYTES:
            raise ValidationFailure("media_source_too_large")
        try:
            content = source.read_bytes()
        except OSError as error:
            raise ValidationFailure("media_structure_invalid") from error
        if _EICAR_TEST_SIGNATURE in content:
            raise ValidationFailure("media_signature_blocked")
        if dataset_format == "png":
            cls._verify_png_structure(content)
            return
        if dataset_format == "jpeg":
            cls._verify_jpeg_structure(content)
            return
        raise ValidationFailure("media_structure_invalid")

    @staticmethod
    def _verify_png_structure(content: bytes) -> None:
        if not content.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValidationFailure("dataset_magic_mismatch")
        position = 8
        chunk_count = 0
        seen_header = False
        seen_data = False
        while position < len(content):
            if len(content) - position < 12:
                raise ValidationFailure("media_structure_invalid")
            length = int.from_bytes(content[position : position + 4], "big")
            chunk_type = content[position + 4 : position + 8]
            end = position + 12 + length
            if end > len(content) or len(chunk_type) != 4 or not chunk_type.isalpha():
                raise ValidationFailure("media_structure_invalid")
            chunk_data = content[position + 8 : position + 8 + length]
            expected_crc = int.from_bytes(content[position + 8 + length : end], "big")
            if zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF != expected_crc:
                raise ValidationFailure("media_structure_invalid")
            chunk_count += 1
            if chunk_count > 10_000 or chunk_type in {b"acTL", b"fcTL", b"fdAT"}:
                raise ValidationFailure("media_structure_invalid")
            if chunk_count == 1:
                if chunk_type != b"IHDR" or length != 13:
                    raise ValidationFailure("media_structure_invalid")
                seen_header = True
            elif chunk_type == b"IHDR":
                raise ValidationFailure("media_structure_invalid")
            if chunk_type == b"IDAT":
                seen_data = True
            if chunk_type == b"IEND":
                if length != 0 or end != len(content) or not (seen_header and seen_data):
                    raise ValidationFailure("media_structure_invalid")
                return
            if chunk_type[0] & 0x20 == 0 and chunk_type not in {
                b"IHDR",
                b"PLTE",
                b"IDAT",
                b"IEND",
            }:
                raise ValidationFailure("media_structure_invalid")
            position = end
        raise ValidationFailure("media_structure_invalid")

    @staticmethod
    def _verify_jpeg_structure(content: bytes) -> None:
        if not content.startswith(b"\xff\xd8"):
            raise ValidationFailure("dataset_magic_mismatch")
        if not content.endswith(b"\xff\xd9"):
            raise ValidationFailure("media_structure_invalid")
        position = 2
        seen_frame = False
        seen_scan = False
        while position < len(content):
            if content[position] != 0xFF:
                raise ValidationFailure("media_structure_invalid")
            marker_start = position
            while position < len(content) and content[position] == 0xFF:
                position += 1
            if position >= len(content):
                raise ValidationFailure("media_structure_invalid")
            marker = content[position]
            position += 1
            if marker == 0xD9:
                if position != len(content) or not (seen_frame and seen_scan):
                    raise ValidationFailure("media_structure_invalid")
                return
            if marker in {0x00, 0x01, 0xD8} or 0xD0 <= marker <= 0xD7:
                raise ValidationFailure("media_structure_invalid")
            if position + 2 > len(content):
                raise ValidationFailure("media_structure_invalid")
            segment_length = int.from_bytes(content[position : position + 2], "big")
            if segment_length < 2 or position + segment_length > len(content):
                raise ValidationFailure("media_structure_invalid")
            if marker in {0xC0, 0xC1, 0xC2}:
                seen_frame = True
            if marker != 0xDA:
                position += segment_length
                continue
            seen_scan = True
            position += segment_length
            while position < len(content):
                if content[position] != 0xFF:
                    position += 1
                    continue
                next_position = position + 1
                while next_position < len(content) and content[next_position] == 0xFF:
                    next_position += 1
                if next_position >= len(content):
                    raise ValidationFailure("media_structure_invalid")
                next_marker = content[next_position]
                if next_marker == 0x00 or 0xD0 <= next_marker <= 0xD7:
                    position = next_position + 1
                    continue
                break
            if position == marker_start:
                raise ValidationFailure("media_structure_invalid")
        raise ValidationFailure("media_structure_invalid")

    def _inspect_vector(
        self,
        datasource: str,
        dataset_format: DatasetFormat,
        workdir: Path,
    ) -> InspectionResult:
        result = self._runner.run(
            "ogrinfo", ["-ro", "-so", "-al", "-json", datasource], cwd=workdir
        )
        try:
            document = json.loads(result.stdout)
        except ValueError as error:
            raise ValidationFailure("gis_metadata_invalid") from error
        if (
            not isinstance(document, dict)
            or document.get("driverShortName") != _EXPECTED_VECTOR_DRIVER[dataset_format]
        ):
            raise ValidationFailure("dataset_format_mismatch")
        raw_layers = document.get("layers")
        if not isinstance(raw_layers, list) or not 1 <= len(raw_layers) <= 8:
            raise ValidationFailure("dataset_layer_count_invalid")

        layers: list[dict[str, object]] = []
        working_counts: list[dict[str, Any]] = []
        feature_count = 0
        feature_count_known = True
        extents: list[tuple[float, float, float, float]] = []
        geometry_types: set[str] = set()
        crs_values: set[str] = set()
        artifacts: list[ArtifactFile] = []
        layer_names: list[str] = []
        for index, value in enumerate(raw_layers, start=1):
            if not isinstance(value, dict):
                raise ValidationFailure("gis_metadata_invalid")
            layer_name = value.get("name")
            fields = value.get("fields", [])
            geometry_fields = value.get("geometryFields", [])
            if (
                not isinstance(layer_name, str)
                or not layer_name
                or len(layer_name) > 512
                or not isinstance(fields, list)
                or len(fields) > 512
                or not isinstance(geometry_fields, list)
                or len(geometry_fields) > 8
            ):
                raise ValidationFailure("gis_metadata_invalid")
            layer_names.append(layer_name)
            layer_schema = self._field_schema(fields)
            layer_geometry, layer_extent, layer_crs = self._geometry_metadata(geometry_fields)
            if layer_geometry:
                geometry_types.add(layer_geometry)
            if layer_extent:
                extents.append(layer_extent)
            if layer_crs:
                crs_values.add(layer_crs)
            raw_count = value.get("featureCount")
            if type(raw_count) is int and raw_count >= 0:
                feature_count += raw_count
            else:
                feature_count_known = False
            layers.append(
                {
                    "index": index,
                    "name": layer_name[:200],
                    "fields": layer_schema,
                    **dimension_evidence(geometry_fields),
                    "geometry_type": layer_geometry,
                    "feature_count": raw_count
                    if type(raw_count) is int and raw_count >= 0
                    else None,
                }
            )

            parquet = workdir / f"layer-{index:03d}.parquet"
            self._runner.run(
                "ogr2ogr",
                [
                    "-f",
                    "Parquet",
                    "--config",
                    "OGR_PARQUET_ALLOW_ALL_DIMS",
                    "YES",
                    str(parquet),
                    datasource,
                    layer_name,
                    # Preserve source ordinates/topology in working data. GDAL
                    # MakeValid can drop M; display derivatives are separate.
                    "-nln",
                    f"layer_{index:03d}",
                    "-lco",
                    "COMPRESSION=ZSTD",
                ],
                cwd=workdir,
            )
            self._require_artifact(parquet)
            working_info = self._runner.run(
                "ogrinfo", ["-ro", "-so", "-al", "-json", str(parquet)], cwd=workdir
            )
            try:
                working_document = json.loads(working_info.stdout)
            except ValueError as error:
                raise ValidationFailure("working_metadata_invalid") from error
            count_evidence = working_count_evidence(raw_count, working_document)
            working_counts.append(count_evidence)
            layers[-1]["working_count_evidence"] = count_evidence
            artifacts.append(
                ArtifactFile(
                    "working",
                    f"working/layer-{index:03d}.parquet",
                    "application/vnd.apache.parquet",
                    parquet,
                )
            )

        if extents:
            preview = workdir / "preview.geojson"
            self._runner.run(
                "ogr2ogr",
                [
                    "-f",
                    "GeoJSON",
                    str(preview),
                    datasource,
                    layer_names[0],
                    "-makevalid",
                    "-t_srs",
                    "EPSG:4326",
                    "-limit",
                    "5000",
                    "-lco",
                    "RFC7946=YES",
                ],
                cwd=workdir,
            )
            self._require_artifact(preview)
            artifacts.append(
                ArtifactFile("derived", "preview/preview.geojson", "application/geo+json", preview)
            )

            tiles = workdir / "tiles.pmtiles"
            self._runner.run(
                "ogr2ogr",
                ["-f", "PMTiles", str(tiles), datasource, "-makevalid"],
                cwd=workdir,
            )
            self._require_artifact(tiles)
            artifacts.append(
                ArtifactFile("tile", "tiles/dataset.pmtiles", "application/vnd.pmtiles", tiles)
            )

        extent = self._union_extent(extents)
        thumbnail = workdir / "thumbnail.svg"
        self._write_thumbnail(thumbnail, extent)
        artifacts.append(
            ArtifactFile("thumbnail", "thumbnail/overview.svg", "image/svg+xml", thumbnail)
        )
        warnings: list[dict[str, str]] = []
        counts_verified = bool(working_counts) and all(
            item["status"] == "matched" for item in working_counts
        )
        if not counts_verified:
            warnings.append(
                {
                    "code": "working_feature_count_unavailable",
                    "message": (
                        "Input and working-file feature counts could not both "
                        "be established for every layer."
                    ),
                }
            )
        if any(
            "M" in layout
            for layer in layers
            for layout in cast(list[str], layer["coordinate_layouts"] or [])
        ):
            warnings.append(
                {
                    "code": "working_parquet_measured_extension",
                    "message": (
                        "Working Parquet retains measured geometry using GDAL's "
                        "additional-dimensions option. Standard GeoParquet reader compatibility "
                        "is not established; the original remains available."
                    ),
                }
            )
            warnings.append(
                {
                    "code": "display_derivatives_omit_measure",
                    "message": (
                        "GeoJSON previews and map tiles do not preserve M values. "
                        "Use the retained source or inspect working data for "
                        "measured-coordinate analysis."
                    ),
                }
            )
        if not crs_values and extents:
            warnings.append({"code": "crs_missing"})
        if not extents:
            warnings.append({"code": "spatial_geometry_missing"})
        return InspectionResult(
            feature_count=feature_count if feature_count_known else None,
            extent=extent,
            crs=next(iter(crs_values))
            if len(crs_values) == 1
            else ("mixed" if crs_values else None),
            geometry_type=", ".join(sorted(geometry_types)) or None,
            schema_definition={
                "layers": layers,
                "coordinate_dimension": (
                    layers[0]["coordinate_dimension"]
                    if layers
                    and all(
                        layer["coordinate_dimension"] == layers[0]["coordinate_dimension"]
                        for layer in layers
                    )
                    else None
                ),
                "coordinate_dimension_basis": "ogrinfo declared geometry types",
            },
            quality_results={
                "valid": True,
                "checks": [
                    {"code": "format_verified", "status": "passed"},
                    {"code": "gdal_read_only_inspection", "status": "passed"},
                    {"code": "geometry_normalization", "status": "passed"},
                    {
                        "code": "working_feature_count",
                        "status": "passed" if counts_verified else "unavailable",
                    },
                ],
                "warnings": warnings,
            },
            artifacts=tuple(artifacts),
        )

    def _inspect_normalized_raster(
        self, source: Path, dataset_format: DatasetFormat, workdir: Path
    ) -> InspectionResult:
        source_document = self._raster_document(
            source, workdir, expected_driver=_NORMALIZED_RASTER_DRIVERS[dataset_format]
        )
        native_crs = None
        source_srs = None
        uninterpreted_bands: frozenset[int] = frozenset()
        if dataset_format != "geotiff":
            native_crs, source_srs = self._native_raster_crs(source_document, dataset_format)
            uninterpreted_bands = frozenset(
                band.get("band") for band in source_document.get("bands", [])
                if isinstance(band, dict) and band.get("colorInterpretation") == "Undefined"
            )
        source_signature = self._raster_preservation_signature(
            source_document, error_prefix=dataset_format, canonical_crs=native_crs,
            uninterpreted_bands=uninterpreted_bands,
        )
        working = workdir / "raster.cog.tif"
        self._runner.run(
            "gdal_translate",
            [
                "-of", "COG", "-co", "COMPRESS=DEFLATE", "-co", "BIGTIFF=IF_SAFER",
                str(source), str(working),
            ],
            cwd=workdir,
        )
        self._require_artifact(working)
        working_document = self._raster_document(working, workdir)
        metadata = working_document.get("metadata", {})
        image_structure = metadata.get("IMAGE_STRUCTURE", {}) if isinstance(metadata, dict) else {}
        if not isinstance(image_structure, dict) or image_structure.get("LAYOUT") != "COG":
            raise ValidationFailure(f"{dataset_format}_working_cog_invalid")
        if source_srs is not None:
            working_crs, working_srs = self._native_raster_crs(working_document, dataset_format)
            if working_crs != native_crs or not source_srs.IsSame(working_srs):
                raise ValidationFailure(f"{dataset_format}_working_cog_mismatch")
            for band in working_document.get("bands", []):
                if (
                    band.get("band") in uninterpreted_bands
                    and band.get("colorInterpretation") not in {"Undefined", "Gray"}
                ):
                    raise ValidationFailure(f"{dataset_format}_working_cog_mismatch")
        if self._raster_preservation_signature(
            working_document, error_prefix=dataset_format, canonical_crs=native_crs,
            uninterpreted_bands=uninterpreted_bands,
        ) != source_signature:
            raise ValidationFailure(f"{dataset_format}_working_cog_mismatch")
        display_bounds = self._raster_display_bounds(working_document, error_prefix=dataset_format)

        # Reuse the strict COG inspection and its existing preview/thumbnail path.
        inspected = self._inspect_cog(working, workdir)
        raster = dict(cast(dict[str, object], inspected.schema_definition["raster"]))
        raster["source_format"] = dataset_format
        if dataset_format != "geotiff":
            raster["source_coordinate_system"] = source_document.get("coordinateSystem")
            raster["working_coordinate_system"] = working_document.get("coordinateSystem")
            raster["source_band_interpretations"] = [
                {"index": band.get("band"), "color_interpretation": band.get("colorInterpretation")}
                for band in source_document["bands"]
            ]
        raster["display_bounds_crs84"] = display_bounds
        raster["working_cog"] = {
            "relative_key": "working/raster.cog.tif",
            "filename": "raster.cog.tif",
        }
        quality = dict(inspected.quality_results)
        if uninterpreted_bands:
            quality["warnings"] = [
                *cast(list[object], quality["warnings"]),
                "Source band color interpretation is undefined; the working TIFF may use "
                "GDAL's default grayscale display tag. Source interpretations are retained.",
            ]
        quality["checks"] = [
            *cast(list[object], quality["checks"]),
            {
                "code": (
                    "geotiff_working_cog_verified"
                    if dataset_format == "geotiff" else "working_cog_verified"
                ),
                "status": "passed",
            },
        ]
        return InspectionResult(
            feature_count=inspected.feature_count,
            extent=inspected.extent,
            crs=native_crs or inspected.crs,
            geometry_type=inspected.geometry_type,
            schema_definition={"raster": raster},
            quality_results=quality,
            artifacts=(
                ArtifactFile("working", "working/raster.cog.tif", "image/tiff", working),
                *inspected.artifacts,
            ),
        )

    @staticmethod
    def _native_raster_crs(
        document: dict[str, Any], dataset_format: str
    ) -> tuple[str, Any]:
        # The maintained GDAL image already supplies its matching OSR bindings.
        from osgeo import osr  # type: ignore[import-untyped]

        coordinate_system = document.get("coordinateSystem")
        wkt = coordinate_system.get("wkt") if isinstance(coordinate_system, dict) else None
        if not isinstance(wkt, str) or not wkt or len(wkt) > 65_536:
            raise ValidationFailure(f"{dataset_format}_georeferencing_unsupported")
        osr.UseExceptions()
        osr.SetPROJEnableNetwork(False)
        try:
            source = osr.SpatialReference()
            source.ImportFromWkt(wkt)
            if source.Validate() or source.GetAxesCount() != 2:
                raise ValueError("unsupported CRS")
            source.AutoIdentifyEPSG()
            authority, code = source.GetAuthorityName(None), source.GetAuthorityCode(None)
            if authority != "EPSG" or not isinstance(code, str) or not code.isdecimal():
                raise ValueError("unsupported display projection")
            reference = osr.SpatialReference()
            reference.ImportFromEPSG(int(code))
            if not source.IsSame(reference):
                raise ValueError("CRS identity is not semantically equal")
        except (RuntimeError, ValueError) as error:
            raise ValidationFailure(f"{dataset_format}_georeferencing_unsupported") from error
        return f"EPSG:{code}", source

    @staticmethod
    def _raster_display_bounds(
        document: dict[str, Any], *, error_prefix: str
    ) -> list[float]:
        footprint = document.get("wgs84Extent")
        coordinates = footprint.get("coordinates") if isinstance(footprint, dict) else None
        if (
            not isinstance(footprint, dict)
            or footprint.get("type") != "Polygon"
            or not isinstance(coordinates, list)
            or len(coordinates) != 1
            or not isinstance(coordinates[0], list)
            or len(coordinates[0]) < 4
        ):
            raise ValidationFailure(f"{error_prefix}_display_bounds_invalid")
        ring = coordinates[0]
        for point in ring:
            if (
                not isinstance(point, list)
                or len(point) != 2
                or not all(
                    isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                    for v in point
                )
                or not -180 <= point[0] <= 180
                or not -90 <= point[1] <= 90
            ):
                raise ValidationFailure(f"{error_prefix}_display_bounds_invalid")
        if ring[0] != ring[-1]:
            raise ValidationFailure(f"{error_prefix}_display_bounds_invalid")
        bounds = [
            min(point[0] for point in ring), min(point[1] for point in ring),
            max(point[0] for point in ring), max(point[1] for point in ring),
        ]
        if bounds[0] >= bounds[2] or bounds[1] >= bounds[3]:
            raise ValidationFailure(f"{error_prefix}_display_bounds_invalid")
        return bounds

    def _raster_document(
        self, source: Path, workdir: Path, *, expected_driver: str = "GTiff"
    ) -> dict[str, Any]:
        result = self._runner.run("gdalinfo", ["-json", str(source)], cwd=workdir)
        try:
            document = json.loads(result.stdout)
        except ValueError as error:
            raise ValidationFailure("gis_metadata_invalid") from error
        if not isinstance(document, dict) or document.get("driverShortName") != expected_driver:
            raise ValidationFailure("dataset_format_mismatch")
        metadata = document.get("metadata")
        if (
            expected_driver in {"NITF", "HFA"}
            and isinstance(metadata, dict)
            and metadata.get("SUBDATASETS")
        ):
            raise ValidationFailure("raster_subdatasets_unsupported")
        return document

    @classmethod
    def _raster_preservation_signature(
        cls, document: dict[str, Any], *, error_prefix: str,
        canonical_crs: str | None = None,
        uninterpreted_bands: frozenset[int] = frozenset(),
    ) -> str:
        size = document.get("size")
        bands = document.get("bands")
        if (
            not isinstance(size, list)
            or len(size) != 2
            or not all(isinstance(v, int) and not isinstance(v, bool) and v > 0 for v in size)
            or not isinstance(bands, list)
            or not 1 <= len(bands) <= 64
        ):
            raise ValidationFailure("gis_metadata_invalid")
        transform = document.get("geoTransform")
        corners = document.get("cornerCoordinates")
        crs = canonical_crs or cls._coordinate_system(document.get("coordinateSystem"))
        if (
            not isinstance(transform, list)
            or len(transform) != 6
            or not all(
                isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                for v in transform
            )
            or transform[1] * transform[5] - transform[2] * transform[4] == 0
            or crs is None
            or re.fullmatch(r"EPSG:[1-9][0-9]{0,7}", crs) is None
            or not isinstance(corners, dict)
        ):
            raise ValidationFailure(f"{error_prefix}_georeferencing_unsupported")
        determinant = transform[1] * transform[5] - transform[2] * transform[4]
        for name in ("lowerLeft", "lowerRight", "upperLeft", "upperRight"):
            point = corners.get(name)
            if (
                not isinstance(point, list)
                or len(point) < 2
                or not all(
                    isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                    for v in point[:2]
                )
            ):
                raise ValidationFailure(f"{error_prefix}_georeferencing_unsupported")
        if not math.isfinite(determinant):
            raise ValidationFailure(f"{error_prefix}_georeferencing_unsupported")
        coordinate_system = document.get("coordinateSystem")
        if canonical_crs is not None:
            axis_mapping = (
                coordinate_system.get("dataAxisToSRSAxisMapping")
                if isinstance(coordinate_system, dict) else None
            )
            if (
                not isinstance(axis_mapping, list)
                or len(axis_mapping) != 2
                or not all(
                    isinstance(axis, int) and not isinstance(axis, bool) for axis in axis_mapping
                )
                or {abs(axis) for axis in axis_mapping} != {1, 2}
            ):
                raise ValidationFailure(f"{error_prefix}_georeferencing_unsupported")
            coordinate_system = {
                "crs": canonical_crs,
                "dataAxisToSRSAxisMapping": axis_mapping,
            }
        preserved_bands = []
        for index, band in enumerate(bands, start=1):
            if (
                not isinstance(band, dict)
                or band.get("band") != index
                or not isinstance(band.get("type"), str)
                or not band["type"]
            ):
                raise ValidationFailure("gis_metadata_invalid")
            preserved_bands.append({
                key: band[key]
                for key in (
                    "band", "type", "noDataValue", "scale", "offset", "unit",
                    "colorInterpretation", "colorTable",
                )
                if key in band
                and not (key == "colorInterpretation" and index in uninterpreted_bands)
            })
        # Canonical JSON also compares NaN nodata values consistently. Block sizes
        # and overviews deliberately change when producing a COG.
        return json.dumps({
            "size": size,
            "geoTransform": transform,
            "coordinateSystem": coordinate_system,
            "bands": preserved_bands,
        }, sort_keys=True)

    def _inspect_cog(self, source: Path, workdir: Path) -> InspectionResult:
        result = self._runner.run("gdalinfo", ["-json", str(source)], cwd=workdir)
        try:
            document = json.loads(result.stdout)
        except ValueError as error:
            raise ValidationFailure("gis_metadata_invalid") from error
        if not isinstance(document, dict) or document.get("driverShortName") != "GTiff":
            raise ValidationFailure("dataset_format_mismatch")
        metadata = document.get("metadata", {})
        image_structure = metadata.get("IMAGE_STRUCTURE", {}) if isinstance(metadata, dict) else {}
        layout = image_structure.get("LAYOUT") if isinstance(image_structure, dict) else None
        if layout != "COG":
            raise ValidationFailure("cog_layout_required")
        size = document.get("size")
        bands = document.get("bands")
        if (
            not isinstance(size, list)
            or len(size) != 2
            or not all(isinstance(value, int) and value > 0 for value in size)
            or not isinstance(bands, list)
            or not 1 <= len(bands) <= 64
        ):
            raise ValidationFailure("gis_metadata_invalid")
        extent = self._raster_extent(document)
        crs = self._coordinate_system(document.get("coordinateSystem"))
        preview_cog = workdir / "preview.tif"
        self._runner.run(
            "gdal_translate",
            ["-of", "COG", "-outsize", "25%", "25%", str(source), str(preview_cog)],
            cwd=workdir,
        )
        thumbnail = workdir / "thumbnail.png"
        self._runner.run(
            "gdal_translate",
            ["-of", "PNG", "-outsize", "320", "0", str(source), str(thumbnail)],
            cwd=workdir,
        )
        self._require_artifact(preview_cog)
        self._require_artifact(thumbnail)
        return InspectionResult(
            feature_count=None,
            extent=extent,
            crs=crs,
            geometry_type="raster",
            schema_definition={
                "raster": {
                    "width": size[0],
                    "height": size[1],
                    "band_count": len(bands),
                    "bands": [
                        {
                            "index": band.get("band"),
                            "data_type": band.get("type"),
                            "color_interpretation": band.get("colorInterpretation"),
                        }
                        for band in cast(list[dict[str, object]], bands)
                    ],
                }
            },
            quality_results={
                "valid": True,
                "checks": [
                    {"code": "format_verified", "status": "passed"},
                    {"code": "cog_layout_verified", "status": "passed"},
                ],
                "warnings": [],
            },
            artifacts=(
                ArtifactFile("derived", "preview/preview.tif", "image/tiff", preview_cog),
                ArtifactFile("thumbnail", "thumbnail/overview.png", "image/png", thumbnail),
            ),
        )

    def _verify_magic(self, source: Path, dataset_format: DatasetFormat) -> None:
        with source.open("rb") as stream:
            head = stream.read(8192)
            stream.seek(max(0, source.stat().st_size - 4))
            tail = stream.read(4)
        valid = {
            "geojson": head.lstrip().startswith(b"{"),
            "csv": b"\x00" not in head and (b"," in head or b";" in head or b"\t" in head),
            "shapefile": head.startswith(b"PK\x03\x04"),
            "mapinfo": head.startswith(b"PK\x03\x04"),
            "geopackage": head.startswith(b"SQLite format 3\x00"),
            "geoparquet": head.startswith(b"PAR1") and tail == b"PAR1",
            "cog": head.startswith((b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+")),
            "geotiff": head.startswith((b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+")),
            "nitf": head.startswith((b"NITF02.10", b"NITF02.00", b"NSIF01.00")),
            "img": head.startswith(b"EHFA_HEADER_TAG\x00"),
            "pmtiles": head.startswith(b"PMTiles\x03"),
        }[dataset_format]
        if not valid:
            raise ValidationFailure("dataset_magic_mismatch")

    def _vector_datasource(self, source: Path, dataset_format: DatasetFormat) -> str:
        if dataset_format not in {"shapefile", "mapinfo"}:
            return str(source)
        shapefile_stem: str | None = None
        total_expanded = 0
        try:
            with zipfile.ZipFile(source) as archive:
                entries = archive.infolist()
                minimum_entries = 2 if dataset_format == "mapinfo" else 3
                if not minimum_entries <= len(entries) <= self._settings.max_archive_entries:
                    raise ValidationFailure("archive_entry_count_invalid")
                suffixes: dict[str, set[str]] = {}
                shapefile_paths: dict[str, str] = {}
                normalized_paths: set[str] = set()
                for entry in entries:
                    path = PurePosixPath(entry.filename)
                    unix_mode = entry.external_attr >> 16
                    if (
                        entry.flag_bits & 0x1
                        or entry.is_dir()
                        or path.is_absolute()
                        or "\\" in entry.filename
                        or ":" in entry.filename
                        or any(part in {"", ".", ".."} for part in path.parts)
                        or stat.S_ISLNK(unix_mode)
                        or entry.filename.casefold() in normalized_paths
                        or entry.file_size < 0
                        or entry.compress_size < 0
                    ):
                        raise ValidationFailure("archive_entry_unsafe")
                    normalized_paths.add(entry.filename.casefold())
                    total_expanded += entry.file_size
                    if total_expanded > self._settings.max_archive_expanded_bytes:
                        raise ValidationFailure("archive_expanded_size_exceeded")
                    if (
                        entry.file_size
                        > max(1, entry.compress_size) * self._settings.max_archive_ratio
                    ):
                        raise ValidationFailure("archive_compression_ratio_exceeded")
                    if dataset_format == "mapinfo":
                        continue
                    suffix = path.suffix.lower()
                    if suffix in {".shp", ".shx", ".dbf"}:
                        normalized_stem = str(path.with_suffix("")).lower()
                        suffixes.setdefault(normalized_stem, set()).add(suffix)
                        if suffix == ".shp":
                            shapefile_paths[normalized_stem] = entry.filename
                if dataset_format == "mapinfo":
                    return self._mapinfo_datasource(source, archive, entries)
                candidates = [
                    stem for stem, parts in suffixes.items() if parts == {".shp", ".shx", ".dbf"}
                ]
                if len(candidates) != 1:
                    raise ValidationFailure("shapefile_components_invalid")
                shapefile_stem = shapefile_paths[candidates[0]]
        except (zipfile.BadZipFile, OSError) as error:
            raise ValidationFailure("archive_invalid") from error
        assert shapefile_stem is not None
        return f"/vsizip/{source}/{shapefile_stem}"

    @staticmethod
    def _mapinfo_datasource(
        source: Path, archive: zipfile.ZipFile, entries: list[zipfile.ZipInfo]
    ) -> str:
        # Select one complete logical table. Other metadata stays in the original
        # archive and is never opened by GDAL. Do not admit linked/raster/view TABs.
        components = {
            entry.filename.casefold(): entry for entry in entries
            if PurePosixPath(entry.filename).suffix.casefold()
            in {".tab", ".dat", ".map", ".id", ".ind", ".mif", ".mid"}
        }
        primary = [
            entry for name, entry in components.items()
            if PurePosixPath(name).suffix in {".tab", ".mif"}
        ]
        if len(primary) != 1:
            raise ValidationFailure("mapinfo_components_invalid")
        entry = primary[0]
        path = PurePosixPath(entry.filename)
        stem = str(path.with_suffix("")).casefold()
        native = path.suffix.casefold() == ".tab"
        required = {".tab", ".dat", ".map", ".id"} if native else {".mif", ".mid"}
        allowed = required | ({".ind"} if native else set())
        if (
            not all(stem + suffix in components for suffix in required)
            or any(name not in {stem + suffix for suffix in allowed} for name in components)
        ):
            raise ValidationFailure("mapinfo_components_invalid")
        dat_name: str | None = None
        if native:
            with archive.open(entry) as stream:
                header = stream.read(1024 * 1024 + 1)
            if len(header) > 1024 * 1024:
                raise ValidationFailure("mapinfo_definition_invalid")
            # Keywords/filenames are ASCII in native TAB definitions; attribute
            # values live in DAT and are left byte-for-byte unchanged.
            files = re.findall(rb'^\s*File\s+"([^"\r\n]+)"\s*$', header, re.I | re.M)
            types = re.findall(rb"^\s*Type\s+([^\r\n]+)", header, re.I | re.M)
            if (
                not re.match(rb"\s*!table\b", header, re.I)
                or re.search(rb"^\s*Definition\s+Table\s*$", header, re.I | re.M) is None
                or len(types) != 1
                or re.fullmatch(rb'NATIVE(?:\s+Charset\s+"[^"\r\n]+")?\s*', types[0], re.I)
                is None
                or len(files) > 1
                or len(re.findall(rb"^\s*File\b", header, re.I | re.M)) != len(files)
            ):
                raise ValidationFailure("mapinfo_definition_invalid")
            try:
                dat_name = files[0].decode("ascii") if files else path.stem + ".dat"
            except UnicodeDecodeError as error:
                raise ValidationFailure("mapinfo_reference_unsafe") from error
            if (
                any(character in dat_name for character in "/\\:\x00")
                or dat_name.casefold() != path.stem.casefold() + ".dat"
            ):
                raise ValidationFailure("mapinfo_reference_unsafe")
        # Normalize only scratch filenames so mixed-case companions work on
        # case-sensitive hosts. Retain the TAB's exact local DAT reference and
        # every component's bytes; the uploaded original ZIP remains untouched.
        directory = source.parent / "mapinfo-source"
        directory.mkdir()
        for name, component in components.items():
            suffix = PurePosixPath(name).suffix
            filename = dat_name if suffix == ".dat" else path.stem + suffix
            assert filename is not None
            with archive.open(component) as stream, (directory / filename).open("xb") as target:
                while chunk := stream.read(1024 * 1024):
                    target.write(chunk)
        return str(directory / (path.stem + path.suffix.casefold()))

    @staticmethod
    def _field_schema(fields: list[object]) -> list[dict[str, object]]:
        result: list[dict[str, object]] = []
        for value in fields:
            if not isinstance(value, dict):
                raise ValidationFailure("gis_metadata_invalid")
            name = value.get("name")
            field_type = value.get("type")
            if (
                not isinstance(name, str)
                or not name
                or len(name) > 512
                or not isinstance(field_type, str)
            ):
                raise ValidationFailure("gis_metadata_invalid")
            result.append(
                {
                    "name": name[:200],
                    "type": field_type[:100],
                    "nullable": bool(value.get("nullable", True)),
                }
            )
        return result

    @classmethod
    def _geometry_metadata(
        cls, geometry_fields: list[object]
    ) -> tuple[str | None, tuple[float, float, float, float] | None, str | None]:
        if not geometry_fields:
            return None, None, None
        first = geometry_fields[0]
        if not isinstance(first, dict):
            raise ValidationFailure("gis_metadata_invalid")
        geometry_type = first.get("type")
        if not isinstance(geometry_type, str) or len(geometry_type) > 200:
            raise ValidationFailure("gis_metadata_invalid")
        extent_value = first.get("extent")
        extent = cls._extent(extent_value)
        return geometry_type, extent, cls._coordinate_system(first.get("coordinateSystem"))

    @staticmethod
    def _coordinate_system(value: object) -> str | None:
        if not isinstance(value, dict):
            return None
        projjson = value.get("projjson")
        if isinstance(projjson, dict):
            identifier = projjson.get("id")
            if isinstance(identifier, dict):
                authority, code = identifier.get("authority"), identifier.get("code")
                if isinstance(authority, str) and isinstance(code, (str, int)):
                    return f"{authority}:{code}"[:1024]
            name = projjson.get("name")
            if isinstance(name, str):
                return name[:1024]
        wkt = value.get("wkt")
        if isinstance(wkt, str) and len(wkt) <= 1_048_576:
            # A unit, datum or ellipsoid ID is not a CRS ID. Only accept an
            # authority directly inside the root WKT node, outside quoted text.
            matches = {match.start(): match.groups() for match in _WKT_AUTHORITY_ID.finditer(wkt)}
            identifiers = []
            depth, quoted, index = 0, False, 0
            while index < len(wkt):
                char = wkt[index]
                if char == '"':
                    if quoted and index + 1 < len(wkt) and wkt[index + 1] == '"':
                        index += 2
                        continue
                    quoted = not quoted
                elif not quoted:
                    if depth == 1 and index in matches:
                        identifiers.append(matches[index])
                    if char == "[":
                        depth += 1
                    elif char == "]":
                        depth -= 1
                        if depth < 0:
                            return None
                index += 1
            if identifiers and depth == 0 and not quoted:
                authority, code = identifiers[-1]
                return f"{authority}:{code}"[:1024]
        return None

    @classmethod
    def _raster_extent(cls, document: dict[str, Any]) -> tuple[float, float, float, float] | None:
        corners = document.get("cornerCoordinates")
        if not isinstance(corners, dict):
            return None
        points = [
            corners.get(name) for name in ("lowerLeft", "lowerRight", "upperLeft", "upperRight")
        ]
        if not all(isinstance(point, list) and len(point) >= 2 for point in points):
            return None
        numbers = cast(list[list[float]], points)
        return (
            min(p[0] for p in numbers),
            min(p[1] for p in numbers),
            max(p[0] for p in numbers),
            max(p[1] for p in numbers),
        )

    @staticmethod
    def _extent(value: object) -> tuple[float, float, float, float] | None:
        if not isinstance(value, list) or len(value) != 4:
            return None
        if not all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in value):
            return None
        numbers = tuple(float(item) for item in value)
        if not all(number == number and abs(number) != float("inf") for number in numbers):
            return None
        if numbers[0] > numbers[2] or numbers[1] > numbers[3]:
            return None
        return cast(tuple[float, float, float, float], numbers)

    @staticmethod
    def _union_extent(
        extents: list[tuple[float, float, float, float]],
    ) -> tuple[float, float, float, float] | None:
        if not extents:
            return None
        return (
            min(value[0] for value in extents),
            min(value[1] for value in extents),
            max(value[2] for value in extents),
            max(value[3] for value in extents),
        )

    @staticmethod
    def _require_artifact(path: Path) -> None:
        if not path.is_file() or not 1 <= path.stat().st_size <= 5_368_709_120:
            raise ValidationFailure("derivative_generation_failed")

    @staticmethod
    def _write_thumbnail(path: Path, extent: tuple[float, float, float, float] | None) -> None:
        bounds = extent or (0.0, 0.0, 1.0, 1.0)
        width = max(bounds[2] - bounds[0], 1e-12)
        height = max(bounds[3] - bounds[1], 1e-12)
        ratio = min(280.0 / width, 160.0 / height)
        display_width = max(2.0, width * ratio)
        display_height = max(2.0, height * ratio)
        x = (320.0 - display_width) / 2.0
        y = (200.0 - display_height) / 2.0
        svg = (
            '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" '
            'viewBox="0 0 320 200">'
            '<rect width="320" height="200" fill="#eef4f1"/>'
            f'<rect x="{x:.2f}" y="{y:.2f}" width="{display_width:.2f}" '
            f'height="{display_height:.2f}" '
            'rx="4" fill="#2f7d68" stroke="#173f35" stroke-width="2"/>'
            "</svg>"
        )
        path.write_text(svg, encoding="utf-8")
