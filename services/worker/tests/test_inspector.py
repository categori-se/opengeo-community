import json
import shutil
import struct
import zipfile
import zlib
from pathlib import Path

import pytest

from opengeo_worker.command_runner import CommandResult, CommandRunner
from opengeo_worker.config import Settings
from opengeo_worker.inspector import DatasetInspector
from opengeo_worker.malware import MalwareScanEvidence
from opengeo_worker.models import ValidationFailure


def png_chunk(kind: bytes, content: bytes) -> bytes:
    checksum = zlib.crc32(kind + content) & 0xFFFFFFFF
    return len(content).to_bytes(4, "big") + kind + content + checksum.to_bytes(4, "big")


def png_bytes(width: int = 1, height: int = 1, text: bytes | None = None) -> bytes:

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    row = b"\x00" + b"\x00\x80\xff" * width
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", header)
        + (png_chunk(b"tEXt", text) if text is not None else b"")
        + png_chunk(b"IDAT", zlib.compress(row * height))
        + png_chunk(b"IEND", b"")
    )


def jpeg_bytes(width: int = 1, height: int = 1) -> bytes:
    frame = b"\x08" + height.to_bytes(2, "big") + width.to_bytes(2, "big") + b"\x01\x01\x11\x00"
    scan = b"\x01\x01\x00\x00\x3f\x00"
    return (
        b"\xff\xd8"
        + b"\xff\xc0"
        + (len(frame) + 2).to_bytes(2, "big")
        + frame
        + b"\xff\xda"
        + (len(scan) + 2).to_bytes(2, "big")
        + scan
        + b"\x00\xff\xd9"
    )


def pdf_bytes(extra_catalog: bytes = b"") -> bytes:
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R " + extra_catalog + b" >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>",
        b"<< /Length 0 >>\nstream\n\nendstream",
    ]
    content = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, body in enumerate(objects, start=1):
        offsets.append(len(content))
        content.extend(f"{index} 0 obj\n".encode())
        content.extend(body)
        content.extend(b"\nendobj\n")
    xref = len(content)
    content.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    content.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        content.extend(f"{offset:010d} 00000 n \n".encode())
    content.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    return bytes(content)


class CleanScanner:
    def scan(self, source: Path, workdir: Path) -> MalwareScanEvidence:
        assert source.parent.resolve() == workdir.resolve()
        return MalwareScanEvidence("1.4.3", 27_900)


class MediaRunner:
    def __init__(self, driver: str, size: tuple[int, int], bands: int) -> None:
        self.driver = driver
        self.size = size
        self.bands = bands
        self.calls: list[tuple[str, list[str], Path]] = []

    def run(self, program: str, arguments: list[str], *, cwd: Path) -> CommandResult:
        self.calls.append((program, arguments, cwd))
        if program == "gdalinfo":
            return CommandResult(
                json.dumps(
                    {
                        "driverShortName": self.driver,
                        "size": list(self.size),
                        "bands": [{"band": index + 1} for index in range(self.bands)],
                    }
                ),
                "",
            )
        assert program == "gdal_translate"
        Path(arguments[-1]).write_bytes(png_bytes(text=b"author\x00private-source-metadata"))
        return CommandResult("", "")


class DocumentRunner:
    def __init__(
        self,
        *,
        javascript: str = "",
        attachments: int = 0,
        extracted_text: str = "First page text.\fSecond page text.\f",
        visual_pages: int = 2,
        ocr_text: str = "Recognized scanned text.",
    ) -> None:
        self.javascript = javascript
        self.attachments = attachments
        self.extracted_text = extracted_text
        self.visual_pages = visual_pages
        self.ocr_text = ocr_text
        self.calls: list[tuple[str, list[str], Path]] = []

    def run(
        self,
        program: str,
        arguments: list[str],
        *,
        cwd: Path,
        maximum_file_bytes: int = 5_368_709_120,
    ) -> CommandResult:
        self.calls.append((program, arguments, cwd))
        if program == "pdfinfo" and arguments[0] == "-box":
            return CommandResult(
                "Pages:           2\n"
                "Encrypted:       no\n"
                "Tagged:          yes\n"
                "Title:           Field report\n"
                "Language:        en-US\n"
                "Page size:       612 x 792 pts\n"
                "PDF version:     1.7\n",
                "",
            )
        if program == "pdfinfo" and arguments[0] == "-js":
            return CommandResult(self.javascript, "")
        if program == "pdfdetach":
            return CommandResult(f"{self.attachments} embedded files\n", "")
        if program == "pdftotext":
            assert maximum_file_bytes == 1_048_576
            assert arguments[-1] == "-"
            return CommandResult(self.extracted_text, "")
        if program == "tesseract":
            if arguments == ["--version"]:
                return CommandResult("tesseract 5.3.4\n", "")
            return CommandResult(self.ocr_text + "\n\f", "")
        if program == "pdftoppm":
            if "-jpeg" in arguments:
                for page_number in range(1, self.visual_pages + 1):
                    Path(f"{arguments[-1]}-{page_number}.jpg").write_bytes(jpeg_bytes(600, 776))
                return CommandResult("", "")
            Path(f"{arguments[-1]}.png").write_bytes(
                png_bytes(750, 970, text=b"private-pdf-render-metadata")
            )
            return CommandResult("", "")
        assert program == "gdal_translate"
        Path(arguments[-1]).write_bytes(png_bytes(247, 320, text=b"private-thumbnail-metadata"))
        return CommandResult("", "")


def settings(workspace: Path) -> Settings:
    return Settings(
        aws_region="us-east-1",
        geodata_bucket="opengeo-test-geodata",
        geodata_kms_key_arn=(
            "arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012"
        ),
        processing_queue_url=(
            "https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-processing"
        ),
        db_host="database.internal",
        db_port=5432,
        db_name="opengeo",
        db_user="opengeo_worker",
        db_password="secret",
        db_sslrootcert="/missing/not-validated-in-inspector-tests",
        workspace_root=workspace,
        command_timeout_seconds=30,
    )


@pytest.mark.skipif(shutil.which("ogrinfo") is None, reason="GDAL is not installed")
def test_geojson_is_inspected_normalized_and_rendered_without_source_names(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.geojson"
    source.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "name": "roads",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"name": "Main", "lanes": 2},
                        "geometry": {
                            "type": "LineString",
                            "coordinates": [[-75, 40], [-74, 41]],
                        },
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    result = DatasetInspector(settings(tmp_path), scanner=CleanScanner()).inspect(
        source, "geojson", tmp_path
    )

    assert result.feature_count == 1
    assert result.extent == (-75.0, 40.0, -74.0, 41.0)
    assert result.geometry_type == "LineString"
    assert result.quality_results["valid"] is True
    assert {artifact.role for artifact in result.artifacts} == {
        "working",
        "derived",
        "tile",
        "thumbnail",
    }
    assert all(
        artifact.path.is_file() and artifact.path.stat().st_size > 0
        for artifact in result.artifacts
    )
    thumbnail = next(artifact for artifact in result.artifacts if artifact.role == "thumbnail")
    assert "roads" not in thumbnail.path.read_text(encoding="utf-8")


def test_magic_mismatch_fails_before_gdal(tmp_path: Path) -> None:
    source = tmp_path / "source.gpkg"
    source.write_bytes(b"not sqlite")
    with pytest.raises(ValidationFailure, match="dataset_magic_mismatch"):
        DatasetInspector(settings(tmp_path), scanner=CleanScanner()).inspect(
            source, "geopackage", tmp_path
        )


def test_shapefile_archive_rejects_traversal_and_compression_bombs(tmp_path: Path) -> None:
    source = tmp_path / "source.zip"
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("../roads.shp", b"x")
        archive.writestr("roads.shx", b"x")
        archive.writestr("roads.dbf", b"x")
    with pytest.raises(ValidationFailure, match="archive_entry_unsafe"):
        DatasetInspector(settings(tmp_path), scanner=CleanScanner()).inspect(
            source, "shapefile", tmp_path
        )


def test_shapefile_archive_requires_one_matching_component_set(tmp_path: Path) -> None:
    source = tmp_path / "source.zip"
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("roads.shp", b"x")
        archive.writestr("roads.shx", b"x")
        archive.writestr("other.dbf", b"x")
    with pytest.raises(ValidationFailure, match="shapefile_components_invalid"):
        DatasetInspector(settings(tmp_path), scanner=CleanScanner()).inspect(
            source, "shapefile", tmp_path
        )


def test_png_is_bounded_normalized_and_metadata_stripped_for_publication(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.png"
    source.write_bytes(png_bytes())
    runner = MediaRunner("PNG", (1_200, 600), 4)

    result = DatasetInspector(settings(tmp_path), runner, CleanScanner()).inspect(
        source, "png", tmp_path
    )

    assert result.geometry_type == "image"
    assert result.schema_definition["media"] == {
        "kind": "image",
        "source_format": "png",
        "width": 1_200,
        "height": 600,
        "band_count": 4,
        "normalized_width": 900,
        "normalized_height": 450,
    }
    assert result.quality_results["safety_scan"] == {
        "status": "passed",
        "engine": "ClamAV",
        "engine_version": "1.4.3",
        "signature_version": 27_900,
        "scope": "signature_heuristic_archive_and_document_scan",
        "comprehensive_malware_scan": True,
        "network_access": False,
    }
    assert {artifact.role for artifact in result.artifacts} == {"derived", "thumbnail"}
    translate_calls = [call for call in runner.calls if call[0] == "gdal_translate"]
    assert translate_calls[0][1][0:9] == [
        "-of",
        "PNG",
        "-ot",
        "Byte",
        "-outsize",
        "900",
        "450",
        "-noxmp",
        "-co",
    ]
    assert all(artifact.path.read_bytes().startswith(b"\x89PNG") for artifact in result.artifacts)
    assert all(
        b"private-source-metadata" not in artifact.path.read_bytes()
        for artifact in result.artifacts
    )


@pytest.mark.skipif(shutil.which("gdalinfo") is None, reason="GDAL is not installed")
def test_png_normalization_runs_through_the_real_bounded_gdal_toolchain(tmp_path: Path) -> None:
    source = tmp_path / "source.png"
    source.write_bytes(png_bytes(2, 1))

    result = DatasetInspector(settings(tmp_path), scanner=CleanScanner()).inspect(
        source, "png", tmp_path
    )

    assert result.schema_definition["media"]["width"] == 2
    assert result.schema_definition["media"]["height"] == 1
    assert [artifact.relative_key for artifact in result.artifacts] == [
        "media/normalized.png",
        "thumbnail/overview.png",
    ]
    assert all(artifact.path.stat().st_size <= 4 * 1024 * 1024 for artifact in result.artifacts)


def test_coordinate_system_accepts_bounded_gdal_wkt_authority_fallback() -> None:
    assert (
        DatasetInspector._coordinate_system(
            {
                "wkt": (
                    'PROJCRS["NAD83 / Massachusetts Mainland",'
                    'BASEGEOGCRS["NAD83",ID["EPSG",4269]],'
                    'CS[Cartesian,2],ID["EPSG",26986]]'
                )
            }
        )
        == "EPSG:26986"
    )
    assert DatasetInspector._coordinate_system({"wkt": 'GEOGCRS["unknown"]'}) is None
    assert DatasetInspector._coordinate_system({"wkt": "x" * 1_048_577}) is None


def test_coordinate_system_does_not_promote_nested_authorities() -> None:
    for wkt in [
        'GEOGCRS["unknown",DATUM["WGS84",ID["EPSG",6326]],ANGLEUNIT["degree",0.01745,ID["EPSG",9122]]]',
        'GEOGCS["unknown",DATUM["WGS84",SPHEROID["WGS84",6378137,298.257,AUTHORITY["EPSG","7030"]]]]',
        'PROJCRS["custom",BASEGEOGCRS["WGS84",ID["EPSG",4326]]]',
        'GEOGCRS["name with ID[""EPSG"",4326]"]',
        'GEOGCRS["invalid",ID["EPSG",4326]',
    ]:
        assert DatasetInspector._coordinate_system({"wkt": wkt}) is None
    assert DatasetInspector._coordinate_system(
        {"wkt": 'GEOGCS["WGS84",UNIT["degree",0.01745],AUTHORITY["EPSG","4326"]]'}
    ) == "EPSG:4326"


@pytest.mark.skipif(
    shutil.which("gdalinfo") is None or shutil.which("gdal_translate") is None,
    reason="GDAL is not installed",
)
def test_real_jpeg_is_decoded_with_the_orientation_open_option(tmp_path: Path) -> None:
    seed = tmp_path / "seed.png"
    source = tmp_path / "source.jpg"
    seed.write_bytes(png_bytes(2, 1))
    command_runner = CommandRunner(tmp_path, timeout_seconds=30, output_bytes=1_048_576)
    command_runner.run("gdal_translate", ["-of", "JPEG", str(seed), str(source)], cwd=tmp_path)

    result = DatasetInspector(settings(tmp_path), scanner=CleanScanner()).inspect(
        source, "jpeg", tmp_path
    )

    assert result.schema_definition["media"]["source_format"] == "jpeg"
    assert result.schema_definition["media"]["width"] == 2
    assert all(artifact.content_type == "image/png" for artifact in result.artifacts)


def test_jpeg_orientation_is_applied_before_metadata_free_png_normalization(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.jpg"
    source.write_bytes(jpeg_bytes())
    runner = MediaRunner("JPEG", (800, 1_200), 3)

    result = DatasetInspector(settings(tmp_path), runner, CleanScanner()).inspect(
        source, "jpeg", tmp_path
    )

    assert result.schema_definition["media"]["source_format"] == "jpeg"
    assert result.schema_definition["media"]["normalized_width"] == 600
    assert result.schema_definition["media"]["normalized_height"] == 900
    assert runner.calls[0][1][0:4] == ["-json", "-oo", "APPLY_ORIENTATION=YES", str(source)]
    assert all(
        call[1][2:4] == ["-oo", "APPLY_ORIENTATION=YES"]
        for call in runner.calls
        if call[0] == "gdal_translate"
    )


def test_media_rejects_trailing_payload_blocked_signature_and_excess_dimensions(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.png"
    source.write_bytes(png_bytes() + b"trailing")
    with pytest.raises(ValidationFailure, match="media_structure_invalid"):
        DatasetInspector(settings(tmp_path), MediaRunner("PNG", (1, 1), 3), CleanScanner()).inspect(
            source, "png", tmp_path
        )

    source.write_bytes(
        png_bytes() + b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
    )
    with pytest.raises(ValidationFailure, match="media_signature_blocked"):
        DatasetInspector(settings(tmp_path), MediaRunner("PNG", (1, 1), 3), CleanScanner()).inspect(
            source, "png", tmp_path
        )

    source.write_bytes(png_bytes())
    with pytest.raises(ValidationFailure, match="media_dimensions_exceeded"):
        DatasetInspector(
            settings(tmp_path), MediaRunner("PNG", (20_001, 1), 3), CleanScanner()
        ).inspect(source, "png", tmp_path)


def test_media_source_limit_is_rechecked_inside_the_worker(tmp_path: Path) -> None:
    source = tmp_path / "source.png"
    with source.open("wb") as stream:
        stream.truncate(16 * 1024 * 1024 + 1)

    with pytest.raises(ValidationFailure, match="media_source_too_large"):
        DatasetInspector(settings(tmp_path), MediaRunner("PNG", (1, 1), 3), CleanScanner()).inspect(
            source, "png", tmp_path
        )


def test_pdf_is_scanned_inspected_and_rendered_to_metadata_free_pngs(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    source.write_bytes(pdf_bytes())
    runner = DocumentRunner()

    result = DatasetInspector(settings(tmp_path), runner, CleanScanner()).inspect(
        source, "pdf", tmp_path
    )

    assert result.geometry_type == "document"
    assert result.schema_definition["document"] == {
        "kind": "pdf",
        "source_format": "pdf",
        "pdf_version": "1.7",
        "page_count": 2,
        "encrypted": False,
        "preview_page": 1,
        "preview_width": 750,
        "preview_height": 970,
        "accessible_preview_schema": "opengeo.document-preview.2.0.0",
        "text_extraction": "poppler_pdftotext",
        "reading_order": "heuristic",
        "ocr_performed": False,
        "tagged": True,
        "text_available": True,
        "text_block_count": 2,
        "text_characters": 33,
        "visual_presentation_schema": "opengeo.pdf-visual-presentation.1.0.0",
        "visual_renderer": "poppler_pdftoppm",
        "visual_media_type": "image/jpeg",
        "visual_annotations_hidden": True,
        "visual_page_count": 2,
        "visual_target_max_dimension": 1000,
        "visual_total_pixels": 931200,
        "visual_total_image_bytes": 56,
    }
    assert result.quality_results["safety_scan"]["comprehensive_malware_scan"] is True
    assert [artifact.relative_key for artifact in result.artifacts] == [
        "document/preview-page-1.png",
        "thumbnail/overview.png",
        "document/accessible-preview.json",
        "document/visual-presentation.json",
    ]
    assert [artifact.content_type for artifact in result.artifacts] == [
        "image/png",
        "image/png",
        "application/json",
        "application/json",
    ]
    assert all(b"private" not in artifact.path.read_bytes() for artifact in result.artifacts)
    semantic = json.loads(result.artifacts[-2].path.read_text(encoding="utf-8"))
    assert semantic == {
        "schemaVersion": "opengeo.document-preview.2.0.0",
        "sourceFormat": "pdf",
        "pdfVersion": "1.7",
        "title": "Field report",
        "language": "en-US",
        "extraction": {
            "engine": "poppler-pdftotext",
            "mode": "layout",
            "ocrPerformed": False,
            "readingOrder": "heuristic",
            "tagged": True,
            "textAvailable": True,
        },
        "pages": [
            {"number": 1, "blocks": [{"type": "paragraph", "text": "First page text."}]},
            {"number": 2, "blocks": [{"type": "paragraph", "text": "Second page text."}]},
        ],
    }
    presentation = json.loads(result.artifacts[-1].path.read_text(encoding="utf-8"))
    assert presentation["schemaVersion"] == "opengeo.pdf-visual-presentation.1.0.0"
    assert presentation["rendering"] == {
        "engine": "poppler-pdftoppm",
        "mediaType": "image/jpeg",
        "annotationsHidden": True,
        "colorSpace": "rgb",
        "pageCount": 2,
        "targetMaximumDimension": 1000,
        "totalPixels": 931200,
        "totalImageBytes": 56,
    }
    assert [page["number"] for page in presentation["pages"]] == [1, 2]
    assert all(page["imageBase64"].startswith("/9j/") for page in presentation["pages"])
    assert [call[0] for call in runner.calls] == [
        "pdfinfo",
        "pdfinfo",
        "pdfdetach",
        "pdftotext",
        "pdftoppm",
        "gdal_translate",
        "pdftoppm",
    ]


def test_pdf_text_empty_pages_receive_bounded_declared_language_ocr(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    source.write_bytes(pdf_bytes())
    runner = DocumentRunner(extracted_text="\f\f", ocr_text="مرحبا بالعالم")

    result = DatasetInspector(settings(tmp_path), runner, CleanScanner()).inspect(
        source, "pdf", tmp_path
    )

    document = result.schema_definition["document"]
    assert document["accessible_preview_schema"] == "opengeo.document-preview.3.0.0"
    assert document["text_extraction"] == "poppler_pdftotext_tesseract"
    assert document["ocr_performed"] is True
    assert document["ocr_engine"] == "tesseract"
    assert document["ocr_engine_version"] == "5.3.4"
    assert document["ocr_model"] == "Latin"
    assert document["ocr_pages"] == [1, 2]
    assert document["ocr_page_count"] == 2
    assert document["ocr_truncated"] is False
    assert document["visual_presentation_schema"] == "opengeo.pdf-visual-presentation.2.0.0"
    assert {warning["code"] for warning in result.quality_results["warnings"]} >= {
        "ocr_text_is_heuristic_and_may_contain_errors"
    }
    semantic = json.loads(result.artifacts[-2].path.read_text(encoding="utf-8"))
    assert semantic["schemaVersion"] == "opengeo.document-preview.3.0.0"
    assert semantic["extraction"]["ocrPerformed"] is True
    assert semantic["extraction"]["ocrPages"] == [1, 2]
    assert semantic["pages"] == [
        {
            "number": 1,
            "textSource": "ocr",
            "blocks": [{"type": "paragraph", "text": "مرحبا بالعالم"}],
        },
        {
            "number": 2,
            "textSource": "ocr",
            "blocks": [{"type": "paragraph", "text": "مرحبا بالعالم"}],
        },
    ]
    presentation = json.loads(result.artifacts[-1].path.read_text(encoding="utf-8"))
    assert presentation["schemaVersion"] == "opengeo.pdf-visual-presentation.2.0.0"
    assert [page["textSource"] for page in presentation["pages"]] == ["ocr", "ocr"]


def test_pdf_semantic_preview_rejects_page_drift_and_text_expansion(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    source.write_bytes(pdf_bytes())
    with pytest.raises(ValidationFailure, match="document_text_extraction_failed"):
        DatasetInspector(
            settings(tmp_path),
            DocumentRunner(extracted_text="Only one page."),
            CleanScanner(),
        ).inspect(source, "pdf", tmp_path)

    with pytest.raises(ValidationFailure, match="document_content_limit_exceeded"):
        DatasetInspector(
            settings(tmp_path),
            DocumentRunner(extracted_text=("x" * 200_001) + "\f\f"),
            CleanScanner(),
        ).inspect(source, "pdf", tmp_path)


def test_pdf_visual_presentation_rejects_missing_pages(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    source.write_bytes(pdf_bytes())

    with pytest.raises(ValidationFailure, match="document_visual_presentation_failed"):
        DatasetInspector(
            settings(tmp_path),
            DocumentRunner(visual_pages=1),
            CleanScanner(),
        ).inspect(source, "pdf", tmp_path)


def test_pdf_rejects_active_content_attachments_and_oversize_sources(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    source.write_bytes(pdf_bytes(b"/Open#41ction 4 0 R"))
    with pytest.raises(ValidationFailure, match="document_active_content_blocked"):
        DatasetInspector(settings(tmp_path), DocumentRunner(), CleanScanner()).inspect(
            source, "pdf", tmp_path
        )

    source.write_bytes(pdf_bytes())
    with pytest.raises(ValidationFailure, match="document_active_content_blocked"):
        DatasetInspector(settings(tmp_path), DocumentRunner(attachments=1), CleanScanner()).inspect(
            source, "pdf", tmp_path
        )

    with source.open("wb") as stream:
        stream.truncate(32 * 1024 * 1024 + 1)
    with pytest.raises(ValidationFailure, match="document_source_too_large"):
        DatasetInspector(settings(tmp_path), DocumentRunner(), CleanScanner()).inspect(
            source, "pdf", tmp_path
        )


@pytest.mark.skipif(
    any(
        shutil.which(binary) is None
        for binary in ("pdfinfo", "pdfdetach", "pdftoppm", "pdftotext", "tesseract")
    ),
    reason="Poppler is not installed",
)
def test_pdf_preview_runs_through_the_real_isolated_poppler_toolchain(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    source.write_bytes(pdf_bytes())

    result = DatasetInspector(settings(tmp_path), scanner=CleanScanner()).inspect(
        source, "pdf", tmp_path
    )

    document = result.schema_definition["document"]
    assert document["page_count"] == 1
    assert document["pdf_version"] == "1.4"
    assert 1 <= document["preview_width"] <= 1_000
    assert 1 <= document["preview_height"] <= 1_000
    assert all(artifact.path.stat().st_size <= 4 * 1024 * 1024 for artifact in result.artifacts)
    semantic = json.loads(result.artifacts[-2].path.read_text(encoding="utf-8"))
    assert semantic["sourceFormat"] == "pdf"
    assert semantic["schemaVersion"] == "opengeo.document-preview.3.0.0"
    assert semantic["extraction"]["ocrPerformed"] is True
    assert semantic["pages"] == [{"blocks": [], "number": 1, "textSource": "ocr"}]
    presentation = json.loads(result.artifacts[-1].path.read_text(encoding="utf-8"))
    assert presentation["rendering"]["pageCount"] == 1
    assert presentation["pages"][0]["number"] == 1


def test_kml_inspection_preserves_source_without_fetch_or_conversion(
    tmp_path: Path,
) -> None:
    import hashlib

    class NoCommands:
        def run(self, *args: object, **kwargs: object) -> None:
            raise AssertionError("KML structure inspection must not execute tools")

    raw = b"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Source title</name>
<Folder><Placemark><name>Survey</name><Point><coordinates>-73,42</coordinates></Point></Placemark></Folder>
<Style id="original"><LineStyle><color>ff0000ff</color></LineStyle></Style>
<NetworkLink><Link><href>https://provider.invalid/observations.kml</href></Link></NetworkLink>
<GroundOverlay><Icon><href>https://provider.invalid/image.png</href></Icon></GroundOverlay>
</Document></kml>"""
    source = tmp_path / "source.kml"
    source.write_bytes(raw)
    result = DatasetInspector(
        settings(tmp_path), runner=NoCommands(), scanner=CleanScanner()
    ).inspect(source, "kml", tmp_path)
    metadata = result.schema_definition["kml_source"]
    assert metadata["source_sha256"] == hashlib.sha256(raw).hexdigest()
    assert metadata["element_counts"]["NetworkLink"] == 1
    assert metadata["element_counts"]["GroundOverlay"] == 1
    assert metadata["element_counts"]["Placemark"] == 1
    assert metadata["links_resolved"] is False
    assert metadata["license"] is None
    assert result.feature_count is None and result.extent is None and result.crs is None
    assert len(result.artifacts) == 1
    assert result.artifacts[0].role == "derived"
    assert result.artifacts[0].content_type == "application/json"
    assert json.loads(result.artifacts[0].path.read_text()) == result.schema_definition
    assert result.artifacts[0].path.stat().st_size < 2048
    assert (
        result.quality_results["kml_inspection"]["rendering_status"]
        == "not_established"
    )
    assert result.quality_results["safety_scan"]
    assert source.read_bytes() == raw
    assert set(tmp_path.iterdir()) == {source, result.artifacts[0].path}


@pytest.mark.parametrize(
    "raw,code",
    [
        (
            b'<!DOCTYPE kml [<!ENTITY external SYSTEM "file:///etc/passwd">]><kml/>',
            "kml_source_entities_forbidden",
        ),
        (
            b'<kml xmlns="https://unexpected.invalid"/>',
            "kml_source_namespace_unsupported",
        ),
        (
            b'<?xml version="1.0" encoding="ISO-8859-1"?><kml/>',
            "kml_source_encoding_unsupported",
        ),
        (b'<kml xmlns="http://www.opengis.net/kml/2.2">', "kml_source_xml_invalid"),
        (
            b'<kml xmlns="http://www.opengis.net/kml/2.2">'
            + b"<Folder>" * 40
            + b"</Folder>" * 40
            + b"</kml>",
            "kml_source_structure_limit",
        ),
    ],
)
def test_kml_source_rejects_unsupported_or_unsafe_xml(
    tmp_path: Path, raw: bytes, code: str
) -> None:
    from opengeo_worker.kml_sources import inspect_kml_source

    source = tmp_path / "source.kml"
    source.write_bytes(raw)
    with pytest.raises(ValidationFailure, match=code):
        inspect_kml_source(source)
    assert source.read_bytes() == raw


def test_kml_source_byte_limit(tmp_path: Path) -> None:
    from opengeo_worker.kml_sources import MAX_KML_SOURCE_BYTES, inspect_kml_source

    source = tmp_path / "large.kml"
    with source.open("wb") as stream:
        stream.truncate(MAX_KML_SOURCE_BYTES + 1)
    with pytest.raises(ValidationFailure, match="kml_source_size_limit"):
        inspect_kml_source(source)
