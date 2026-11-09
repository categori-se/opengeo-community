# ruff: noqa: E501

import hashlib
import io
import json
import zipfile
from pathlib import Path

import pytest

from opengeo_worker.docx_documents import (
    DOCX_MEDIA_TYPE,
    PREVIEW_SCHEMA,
    REL_NS,
    WORD_NS,
    inspect_docx,
)
from opengeo_worker.inspector import DatasetInspector
from opengeo_worker.models import ValidationFailure
from test_odf_documents import CleanScanner, settings
from test_office_print_vectors import docx_bytes


def inspect(source: Path, workdir: Path):
    return inspect_docx(
        source,
        workdir,
        maximum_entries=256,
        maximum_expanded_bytes=64 * 1024 * 1024,
        maximum_ratio=100,
    )


def test_docx_semantic_preview_retains_identity_unicode_lists_tables_pages_and_source(tmp_path):
    source = tmp_path / "source.docx"
    original = docx_bytes()
    source.write_bytes(original)
    first = inspect(source, tmp_path)
    encoded = first.artifacts[0].path.read_bytes()
    second = inspect(source, tmp_path)
    preview = json.loads(encoded)
    assert source.read_bytes() == original
    assert second.artifacts[0].path.read_bytes() == encoded
    assert set(preview) == {"schemaVersion", "sourceFormat", "title", "language", "pages"}
    assert preview["schemaVersion"] == PREVIEW_SCHEMA
    assert preview["sourceFormat"] == "docx"
    assert preview["title"] == "Nepal field report"
    assert preview["language"] == "ne"
    assert preview["pages"][0]["blocks"] == [
        {"type": "heading", "level": 1, "text": "नेपाल अध्ययन"},
        {"type": "paragraph", "text": "First paragraph"},
    ]
    assert preview["pages"][1]["blocks"] == [
        {"type": "paragraph", "text": "Second page"},
        {"type": "list", "ordered": True, "items": ["One", "Two"]},
        {"type": "table", "headerRows": 1, "rows": [["Place", "Count"], ["Kathmandu", "7"]]},
    ]
    metadata = first.schema_definition["document"]
    assert metadata["kind"] == "ooxml_text"
    assert metadata["source_format"] == "docx"
    assert metadata["accessible_preview_schema"] == PREVIEW_SCHEMA
    assert metadata["page_count"] == 2
    assert metadata["block_count"] == 5
    assert first.artifacts[0].relative_key == "document/accessible-preview.json"
    assert DOCX_MEDIA_TYPE.endswith("wordprocessingml.document")


@pytest.mark.parametrize(
    "files",
    [
        {"word/vbaProject.bin": b"macro"},
        {"word/embeddings/object.bin": b"OLE"},
        {"word/activeX/activeX1.xml": b"<control/>"},
        {"../outside.xml": b"<outside/>"},
        {"word/media/image.svg": b"<svg/>"},
        {"Word/document.xml": b"<duplicate/>"},
    ],
)
def test_docx_rejects_active_unknown_or_ambiguous_package_parts(tmp_path, files):
    source = tmp_path / "unsafe.docx"
    source.write_bytes(docx_bytes(extra_files=files))
    with pytest.raises(ValidationFailure):
        inspect(source, tmp_path)
    assert not (tmp_path / "accessible-preview.json").exists()


def test_docx_rejects_nul_truncated_opc_part_name(tmp_path):
    source = tmp_path / "ambiguous.docx"
    with (
        zipfile.ZipFile(io.BytesIO(docx_bytes())) as archive,
        zipfile.ZipFile(source, "w") as output,
    ):
        for info in archive.infolist():
            name = "word/document.xmlX" if info.filename == "word/document.xml" else info.filename
            output.writestr(name, archive.read(info), compress_type=zipfile.ZIP_DEFLATED)
    source.write_bytes(source.read_bytes().replace(b"word/document.xmlX", b"word/document.xml\x00"))
    with pytest.raises(ValidationFailure, match="document_archive_invalid"):
        inspect(source, tmp_path)


@pytest.mark.parametrize(
    "relation",
    [
        f'<Relationship Id="rIdBad" Type="{REL_NS}/image" Target="https://example.invalid/image.png" TargetMode="External"/>',
        f'<Relationship Id="rIdBad" Type="{REL_NS}/hyperlink" Target="file:///etc/passwd" TargetMode="External"/>',
        f'<Relationship Id="rIdBad" Type="{REL_NS}/hyperlink" Target="https://user:secret@example.invalid/" TargetMode="External"/>',
        f'<Relationship Id="rIdBad" Type="{REL_NS}/image" Target="media/missing.png"/>',
        f'<Relationship Id="rIdBad" Type="{REL_NS}/attachedTemplate" Target="styles.xml"/>',
        f'<Relationship Id="rIdStyles" Type="{REL_NS}/styles" Target="styles.xml"/>',
        f'<Relationship Id="rIdNested" Type="{REL_NS}/styles" Target="styles.xml"><Relationship Id="nested" Type="{REL_NS}/image" Target="https://example.invalid/image.png" TargetMode="External"/></Relationship>',
    ],
)
def test_docx_rejects_external_content_dangling_unknown_or_duplicate_relationships(
    tmp_path, relation
):
    source = tmp_path / "unsafe.docx"
    source.write_bytes(docx_bytes(relationships=relation))
    with pytest.raises(ValidationFailure):
        inspect(source, tmp_path)


@pytest.mark.parametrize(
    "body",
    [
        "<w:p><w:r><w:instrText>DDEAUTO file</w:instrText><w:t>unsafe</w:t></w:r></w:p>",
        '<w:altChunk r:id="rIdStyles"/>',
        "<w:p><w:r><w:object/></w:r></w:p>",
        "<w:sdt><w:sdtContent><w:p><w:r><w:t>control</w:t></w:r></w:p></w:sdtContent></w:sdt>",
        '<w:p><w:hyperlink r:id="missing"><w:r><w:t>dangling</w:t></w:r></w:hyperlink></w:p>',
    ],
)
def test_docx_rejects_fields_objects_controls_and_unbound_relationship_references(tmp_path, body):
    source = tmp_path / "unsafe.docx"
    source.write_bytes(docx_bytes(body=body))
    with pytest.raises(ValidationFailure):
        inspect(source, tmp_path)


@pytest.mark.parametrize("encoding", ["utf-8", "utf-16"])
def test_docx_rejects_entity_declarations_before_extraction_or_native_parser(tmp_path, encoding):
    document = f'''<?xml version="1.0" encoding="{encoding}"?><!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><w:document xmlns:w="{WORD_NS}"><w:body><w:p><w:r><w:t>&secret;</w:t></w:r></w:p></w:body></w:document>'''.encode(
        encoding
    )
    source = tmp_path / "unsafe.docx"
    source.write_bytes(docx_bytes(document=document))
    with pytest.raises(ValidationFailure, match="document_active_content_blocked"):
        inspect(source, tmp_path)


def test_docx_checks_declared_main_content_type_and_bounded_expansion(tmp_path):
    source = tmp_path / "unsafe.docx"
    original = docx_bytes()
    with zipfile.ZipFile(io.BytesIO(original)) as archive:
        entries = {info.filename: archive.read(info) for info in archive.infolist()}
    entries["[Content_Types].xml"] = entries["[Content_Types].xml"].replace(
        b"wordprocessingml.document.main+xml", b"wordprocessingml.template.main+xml"
    )
    with zipfile.ZipFile(source, "w") as archive:
        for name, value in entries.items():
            archive.writestr(name, value)
    with pytest.raises(ValidationFailure):
        inspect(source, tmp_path)
    source.write_bytes(docx_bytes(extra_files={"word/media/image.png": b"0" * 1_000_000}))
    with pytest.raises(ValidationFailure, match="document_content_limit_exceeded"):
        inspect(source, tmp_path)
    source.write_bytes(
        docx_bytes(body='<w:p><w:r><w:t>page</w:t><w:br w:type="page"/></w:r></w:p>' * 201)
    )
    with pytest.raises(ValidationFailure, match="document_content_limit_exceeded"):
        inspect(source, tmp_path)


@pytest.mark.parametrize(
    ("properties", "length"),
    [
        ("", 8_001),
        ('<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>', 8_001),
        ('<w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr>', 1_001),
    ],
)
def test_docx_rejects_individual_text_blocks_outside_preview_contract(tmp_path, properties, length):
    source = tmp_path / "oversized.docx"
    # Hashes keep this source below the archive compression-ratio cap.
    text = "".join(
        hashlib.sha256(str(index).encode()).hexdigest() for index in range((length + 63) // 64)
    )[:length]
    source.write_bytes(docx_bytes(body=f"<w:p>{properties}<w:r><w:t>{text[:-1]}</w:t></w:r></w:p>"))
    inspect(source, tmp_path)
    source.write_bytes(docx_bytes(body=f"<w:p>{properties}<w:r><w:t>{text}</w:t></w:r></w:p>"))
    with pytest.raises(ValidationFailure, match="document_content_limit_exceeded"):
        inspect(source, tmp_path)


def test_docx_inspector_scans_first_preserves_semantics_when_layout_unavailable(
    tmp_path, monkeypatch
):
    source = tmp_path / "source.docx"
    original = docx_bytes()
    source.write_bytes(original)
    order = []

    class Scanner(CleanScanner):
        def scan(self, source, workdir):
            order.append("scan")
            return super().scan(source, workdir)

    def unavailable(source, workdir, runner):
        order.append("convert")
        return None, {"unavailable_reason": "office_unsupported_or_bounded"}, {}

    monkeypatch.setattr("opengeo_worker.inspector.build_docx_print_vectors", unavailable)
    result = DatasetInspector(settings(tmp_path), scanner=Scanner()).inspect(
        source, "docx", tmp_path
    )
    assert order == ["scan", "convert"]
    assert result.schema_definition["document"]["print_vector_available"] is False
    assert result.schema_definition["document"]["page_count"] == 2
    assert result.artifacts[0].relative_key == "document/accessible-preview.json"
    assert result.quality_results["safety_scan"]["network_access"] is False
    assert source.read_bytes() == original


def test_docx_inspector_binds_native_companion_without_replacing_semantic_page_count(
    tmp_path, monkeypatch
):
    source = tmp_path / "source.docx"
    source.write_bytes(docx_bytes())
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    companion = tmp_path / "print-vector.pdf"
    companion.write_bytes(b"prepared companion fixture")
    facts = {"page_count": 3, "pages": [{}, {}, {}]}
    conversion = {"renderer": "libreoffice-writer-pdf", "network": "seccomp-denied"}
    monkeypatch.setattr(
        "opengeo_worker.inspector.build_docx_print_vectors",
        lambda *args: (companion, facts, conversion),
    )
    result = DatasetInspector(settings(tmp_path), scanner=CleanScanner()).inspect(
        source, "docx", tmp_path
    )
    metadata = result.schema_definition["document"]
    assert metadata["page_count"] == 2
    assert metadata["print_vector_available"] is True
    assert metadata["print_vector_schema"] == "opengeo.pdf-print-vector.1.0.0"
    assert metadata["print_vector_facts"] == facts
    assert metadata["print_conversion"] == conversion
    assert result.artifacts[-1].relative_key == "document/print-vector.pdf"
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before
