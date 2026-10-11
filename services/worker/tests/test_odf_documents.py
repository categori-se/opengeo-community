# ruff: noqa: E501

import io
import json
import zipfile
from pathlib import Path

import pytest

from opengeo_worker.config import Settings
from opengeo_worker.inspector import DatasetInspector
from opengeo_worker.malware import MalwareScanEvidence
from opengeo_worker.models import ValidationFailure
from opengeo_worker.odf_documents import ODT_MEDIA_TYPE, PREVIEW_SCHEMA, inspect_odt


def settings(tmp_path: Path) -> Settings:
    return Settings(
        aws_region="us-east-1",
        geodata_bucket="opengeo-test",
        geodata_kms_key_arn="arn:aws:kms:us-east-1:123456789012:key/test",
        processing_queue_url="https://sqs.us-east-1.amazonaws.com/123456789012/test",
        db_host="db.example.test",
        db_port=5432,
        db_name="opengeo",
        db_user="opengeo_worker",
        db_password="secret",
        db_sslrootcert="/missing/not-validated-in-odf-tests",
        workspace_root=tmp_path,
    )


class CleanScanner:
    def scan(self, source: Path, workdir: Path) -> MalwareScanEvidence:
        del source, workdir
        return MalwareScanEvidence("1.5.3", 28098)


def odt_bytes(
    *,
    content: str | None = None,
    manifest_version: str | None = "1.4",
    manifest_extra: str = "",
    extra_files: dict[str, bytes] | None = None,
) -> bytes:
    content_xml = (
        content
        or """<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
 xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
 xmlns:xlink="http://www.w3.org/1999/xlink"
 office:version="1.4">
 <office:body><office:text>
  <text:h text:outline-level="1">नेपाल अध्ययन</text:h>
  <text:p>First paragraph<text:soft-page-break/>Second page</text:p>
  <text:list text:style-name="L1"><text:list-item><text:p>One</text:p></text:list-item><text:list-item><text:p>Two</text:p></text:list-item></text:list>
  <table:table table:name="Results"><table:table-header-rows><table:table-row><table:table-cell><text:p>Place</text:p></table:table-cell><table:table-cell><text:p>Count</text:p></table:table-cell></table:table-row></table:table-header-rows><table:table-row><table:table-cell><text:p>Kathmandu</text:p></table:table-cell><table:table-cell><text:p>7</text:p></table:table-cell></table:table-row></table:table>
 </office:text></office:body>
</office:document-content>"""
    )
    styles = """<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles
 xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
 office:version="1.4"><office:styles><text:list-style style:name="L1"><text:list-level-style-number text:level="1"/></text:list-style></office:styles></office:document-styles>"""
    metadata = """<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.4"><office:meta><dc:title>Nepal field report</dc:title><dc:language>ne</dc:language></office:meta></office:document-meta>"""
    extra_files = extra_files or {}
    file_entries = "".join(
        f'<manifest:file-entry manifest:full-path="{name}" manifest:media-type="application/octet-stream"/>'
        for name in extra_files
        if f'manifest:full-path="{name}"' not in manifest_extra
    )
    version_attribute = (
        f' manifest:version="{manifest_version}"' if manifest_version is not None else ""
    )
    manifest = f"""<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"{version_attribute}>
 <manifest:file-entry manifest:full-path="/" manifest:media-type="{ODT_MEDIA_TYPE}"/>
 <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
 <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
 <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
 {file_entries}{manifest_extra}
</manifest:manifest>"""
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        mimetype = zipfile.ZipInfo("mimetype")
        mimetype.compress_type = zipfile.ZIP_STORED
        archive.writestr(mimetype, ODT_MEDIA_TYPE)
        archive.writestr("content.xml", content_xml, compress_type=zipfile.ZIP_DEFLATED)
        archive.writestr("styles.xml", styles, compress_type=zipfile.ZIP_DEFLATED)
        archive.writestr("meta.xml", metadata, compress_type=zipfile.ZIP_DEFLATED)
        archive.writestr("META-INF/manifest.xml", manifest, compress_type=zipfile.ZIP_DEFLATED)
        for name, value in extra_files.items():
            archive.writestr(name, value, compress_type=zipfile.ZIP_DEFLATED)
    return output.getvalue()


def inspect(source: Path, workdir: Path):
    return inspect_odt(
        source,
        workdir,
        maximum_entries=256,
        maximum_expanded_bytes=64 * 1024 * 1024,
        maximum_ratio=100,
    )


def test_odt_extracts_bounded_unicode_semantic_pages_lists_and_tables(tmp_path: Path) -> None:
    source = tmp_path / "report.odt"
    source.write_bytes(odt_bytes())

    first = inspect(source, tmp_path)
    first_bytes = first.artifacts[0].path.read_bytes()
    second = inspect(source, tmp_path)

    assert first.geometry_type == "document"
    assert first.schema_definition["document"] == {
        "kind": "odf_text",
        "source_format": "odt",
        "odf_version": "1.4",
        "page_count": 2,
        "block_count": 5,
        "text_characters": 64,
        "embedded_media_count": 0,
        "accessible_preview_schema": PREVIEW_SCHEMA,
    }
    assert first.artifacts[0].relative_key == "document/accessible-preview.json"
    assert first.artifacts[0].content_type == "application/json"
    assert second.artifacts[0].path.read_bytes() == first_bytes
    preview = json.loads(first_bytes)
    assert preview["schemaVersion"] == PREVIEW_SCHEMA
    assert preview["title"] == "Nepal field report"
    assert preview["language"] == "ne"
    assert preview["pages"][0]["blocks"][0] == {
        "level": 1,
        "text": "नेपाल अध्ययन",
        "type": "heading",
    }
    assert preview["pages"][1]["blocks"][1] == {
        "items": ["One", "Two"],
        "ordered": True,
        "type": "list",
    }
    assert preview["pages"][1]["blocks"][2]["rows"][1] == ["Kathmandu", "7"]
    assert preview["pages"][1]["blocks"][2]["headerRows"] == 1


def test_odt_accepts_a_content_version_when_the_package_manifest_omits_it(
    tmp_path: Path,
) -> None:
    source = tmp_path / "manifest-version-optional.odt"
    source.write_bytes(odt_bytes(manifest_version=None))

    result = inspect(source, tmp_path)

    assert result.schema_definition["document"]["odf_version"] == "1.4"


def test_odt_accepts_empty_standard_script_and_form_containers(tmp_path: Path) -> None:
    source = tmp_path / "inactive-containers.odt"
    source.write_bytes(
        odt_bytes(
            content="""<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.4"><office:scripts/><office:body><office:text><office:forms/><text:p>Safe text</text:p></office:text></office:body></office:document-content>"""
        )
    )

    result = inspect(source, tmp_path)

    assert result.quality_results["valid"] is True


@pytest.mark.parametrize(
    ("content", "manifest_extra", "extra_files", "code"),
    [
        (
            None,
            '<manifest:file-entry manifest:full-path="Pictures/secret.png" manifest:media-type="image/png"><manifest:encryption-data/></manifest:file-entry>',
            {"Pictures/secret.png": b"encrypted"},
            "document_archive_invalid",
        ),
        (None, "", {"Scripts/python.py": b"print(1)"}, "document_active_content_blocked"),
        (
            """<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.4"><office:body><office:text><text:p><text:a xlink:href="file:///etc/passwd">unsafe</text:a></text:p></office:text></office:body></office:document-content>""",
            "",
            None,
            "document_active_content_blocked",
        ),
        (
            """<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.4"/>""",
            "",
            None,
            "document_structure_invalid",
        ),
    ],
)
def test_odt_rejects_encryption_macros_external_references_and_entities(
    tmp_path: Path,
    content: str | None,
    manifest_extra: str,
    extra_files: dict[str, bytes] | None,
    code: str,
) -> None:
    source = tmp_path / "hostile.odt"
    source.write_bytes(
        odt_bytes(content=content, manifest_extra=manifest_extra, extra_files=extra_files)
    )

    with pytest.raises(ValidationFailure, match=code):
        inspect(source, tmp_path)


def test_odt_rejects_high_ratio_and_page_expansion(tmp_path: Path) -> None:
    source = tmp_path / "expanded.odt"
    source.write_bytes(odt_bytes(extra_files={"Pictures/image.png": b"0" * 1_000_000}))
    with pytest.raises(ValidationFailure, match="document_content_limit_exceeded"):
        inspect(source, tmp_path)

    page_breaks = "<text:p>page<text:soft-page-break/></text:p>" * 201
    source.write_bytes(
        odt_bytes(
            content=f"""<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.4"><office:body><office:text>{page_breaks}</office:text></office:body></office:document-content>"""
        )
    )
    with pytest.raises(ValidationFailure, match="document_content_limit_exceeded"):
        inspect(source, tmp_path)


def test_dataset_inspector_runs_clamav_before_odt_semantic_extraction(tmp_path: Path) -> None:
    source = tmp_path / "source.odt"
    source.write_bytes(odt_bytes())

    result = DatasetInspector(settings(tmp_path), scanner=CleanScanner()).inspect(
        source, "odt", tmp_path
    )

    assert result.quality_results["safety_scan"] == {
        "status": "passed",
        "engine": "ClamAV",
        "engine_version": "1.5.3",
        "signature_version": 28098,
        "scope": "signature_heuristic_archive_and_document_scan",
        "comprehensive_malware_scan": True,
        "network_access": False,
    }
    assert result.quality_results["checks"][-1] == {
        "code": "malware_signature_and_heuristic_scan",
        "status": "passed",
    }
