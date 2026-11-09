# ruff: noqa: E501

import hashlib
import io
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
import zlib
from pathlib import Path
from unittest.mock import patch

from opengeo_worker.command_runner import CommandRunner
from opengeo_worker.docx_documents import REL_NS, WORD_NS
from opengeo_worker.models import TransientFailure
from opengeo_worker.odf_documents import inspect_odt
from opengeo_worker.office_print_vectors import (
    _conversion_copy,
    _docx_conversion_copy,
    build_docx_print_vectors,
    build_odt_print_vectors,
)

_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
_CT = "http://schemas.openxmlformats.org/package/2006/content-types"
_WP = "application/vnd.openxmlformats-officedocument.wordprocessingml."


def marker_png() -> bytes:
    def chunk(kind: bytes, body: bytes) -> bytes:
        return (
            struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"\x00\xff\x20\x10"))
        + chunk(b"IEND", b"")
    )


def docx_bytes(
    *,
    body: str | None = None,
    extra_files: dict[str, bytes] | None = None,
    relationships: str = "",
    content_types: str = "",
    document: bytes | None = None,
) -> bytes:
    """CC0 deterministic inactive OPC fixture; no Office SDK or download needed."""
    body = (
        body
        or """
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>नेपाल अध्ययन</w:t></w:r></w:p>
      <w:p><w:r><w:t>First paragraph</w:t><w:br w:type="page"/><w:t>Second page</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>One</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Two</w:t></w:r></w:p>
      <w:tbl><w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p><w:r><w:t>Place</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Count</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>Kathmandu</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>7</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"""
    )
    files = {
        "word/document.xml": document
        or f'''<w:document xmlns:w="{WORD_NS}" xmlns:r="{REL_NS}"
          xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
          xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>{body}</w:body></w:document>'''.encode(),
        "word/styles.xml": f'''<w:styles xmlns:w="{WORD_NS}">
          <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="DejaVu Sans" w:hAnsi="DejaVu Sans"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
          <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:sz w:val="44"/><w:color w:val="1260A0"/></w:rPr></w:style></w:styles>'''.encode(),
        "word/numbering.xml": f'''<w:numbering xmlns:w="{WORD_NS}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>'''.encode(),
        "docProps/core.xml": b"""<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Nepal field report</dc:title><dc:language>ne</dc:language></cp:coreProperties>""",
        "_rels/.rels": f'''<Relationships xmlns="{_REL}"><Relationship Id="rIdDocument" Type="{REL_NS}/officeDocument" Target="word/document.xml"/><Relationship Id="rIdCore" Type="{_REL}/metadata/core-properties" Target="docProps/core.xml"/></Relationships>'''.encode(),
        "word/_rels/document.xml.rels": f'''<Relationships xmlns="{_REL}"><Relationship Id="rIdStyles" Type="{REL_NS}/styles" Target="styles.xml"/><Relationship Id="rIdNumbering" Type="{REL_NS}/numbering" Target="numbering.xml"/>{relationships}</Relationships>'''.encode(),
    }
    files.update(extra_files or {})
    files["[Content_Types].xml"] = f'''<Types xmlns="{_CT}">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Default Extension="png" ContentType="image/png"/>
      <Override PartName="/word/document.xml" ContentType="{_WP}document.main+xml"/>
      <Override PartName="/word/styles.xml" ContentType="{_WP}styles+xml"/>
      <Override PartName="/word/numbering.xml" ContentType="{_WP}numbering+xml"/>
      <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
      {content_types}</Types>'''.encode()
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, value in files.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, value)
    return output.getvalue()


def layout_odt(path: Path, *, remote_image: bool = False) -> None:
    """CC0 two-page Writer source: physical styles, colored text, table and image."""
    content = """<office:document-content
      xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
      xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
      xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
      xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
      xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
      xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
      xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
      xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.3">
      <office:automatic-styles>
        <style:style style:name="Title" style:family="paragraph">
          <style:text-properties fo:font-size="22pt" fo:color="#1260a0"/>
        </style:style>
        <style:style style:name="Next" style:family="paragraph" style:master-page-name="Wide">
          <style:paragraph-properties fo:break-before="page"/>
        </style:style>
      </office:automatic-styles>
      <office:body><office:text>
        <text:h text:style-name="Title" text:outline-level="1">Original layout first</text:h>
        <text:p>A source paragraph with a <text:a xlink:href="https://example.invalid/">visible link</text:a>.</text:p>
        <table:table table:name="Results"><table:table-row>
          <table:table-cell><text:p>Station</text:p></table:table-cell>
          <table:table-cell><text:p>42</text:p></table:table-cell>
        </table:table-row></table:table>
        <text:p><draw:frame draw:name="Marker" text:anchor-type="as-char"
          svg:width="1cm" svg:height="1cm"><draw:image
          xlink:href="PICTURE" xlink:type="simple"/></draw:frame></text:p>
        <text:p text:style-name="Next">Original layout second</text:p>
      </office:text></office:body></office:document-content>"""
    styles = """<office:document-styles
      xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
      xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
      xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
      office:version="1.3"><office:automatic-styles>
        <style:page-layout style:name="Portrait"><style:page-layout-properties
          fo:page-width="14.8cm" fo:page-height="21cm" fo:margin="1.2cm"/></style:page-layout>
        <style:page-layout style:name="Landscape"><style:page-layout-properties
          fo:page-width="21cm" fo:page-height="14.8cm" fo:margin="1.2cm"/></style:page-layout>
      </office:automatic-styles><office:master-styles>
        <style:master-page style:name="Standard" style:page-layout-name="Portrait"/>
        <style:master-page style:name="Wide" style:page-layout-name="Landscape"/>
      </office:master-styles></office:document-styles>"""
    import struct
    import zlib

    def chunk(kind: bytes, body: bytes) -> bytes:
        return (
            struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
        )

    picture = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
    picture += chunk(b"IDAT", zlib.compress(b"\x00\xff\x20\x10")) + chunk(b"IEND", b"")
    media = "application/vnd.oasis.opendocument.text"
    files = {
        "content.xml": content.replace(
            "PICTURE", "https://example.invalid/a.png" if remote_image else "Pictures/marker.png"
        ).encode(),
        "styles.xml": styles.encode(),
        "Pictures/marker.png": picture,
        "settings.xml": b"<not-used/>",
    }
    manifest = '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">'
    manifest += f'<manifest:file-entry manifest:full-path="/" manifest:media-type="{media}"/>'
    manifest += "".join(
        f'<manifest:file-entry manifest:full-path="{name}" manifest:media-type="{"image/png" if name.endswith(".png") else "text/xml"}"/>'
        for name in files
    )
    manifest += "</manifest:manifest>"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("mimetype", media, compress_type=zipfile.ZIP_STORED)
        for name, body in files.items():
            archive.writestr(name, body, compress_type=zipfile.ZIP_DEFLATED)
        archive.writestr("META-INF/manifest.xml", manifest, compress_type=zipfile.ZIP_DEFLATED)


def layout_docx(path: Path, *, remote_image: bool = False) -> None:
    """CC0 two-page DOCX: section geometry, text, table and embedded PNG."""
    portrait = '<w:pgSz w:w="8391" w:h="11906"/><w:pgMar w:top="680" w:right="680" w:bottom="680" w:left="680"/>'
    landscape = '<w:pgSz w:w="11906" w:h="8391" w:orient="landscape"/><w:pgMar w:top="680" w:right="680" w:bottom="680" w:left="680"/>'
    body = f"""<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>DOCX original layout first</w:t></w:r></w:p>
      <w:p><w:r><w:t>A source paragraph with a </w:t></w:r><w:hyperlink r:id="rIdLink"><w:r><w:t>visible link</w:t></w:r></w:hyperlink><w:r><w:t>.</w:t></w:r></w:p>
      <w:tbl><w:tblPr><w:tblW w:w="5000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2500"/><w:gridCol w:w="2500"/></w:tblGrid><w:tr>
        <w:tc><w:tcPr><w:tcW w:w="2500" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>Station</w:t></w:r></w:p></w:tc>
        <w:tc><w:tcPr><w:tcW w:w="2500" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc>
      </w:tr></w:tbl>
      <w:p><w:pPr><w:sectPr><w:type w:val="nextPage"/>{portrait}</w:sectPr></w:pPr><w:r><w:drawing>
        <wp:inline><wp:extent cx="360000" cy="360000"/><wp:docPr id="1" name="Marker"/>
        <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>
          <pic:nvPicPr><pic:cNvPr id="1" name="marker.png"/><pic:cNvPicPr/></pic:nvPicPr>
          <pic:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
          <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="360000" cy="360000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
        </pic:pic></a:graphicData></a:graphic></wp:inline>
      </w:drawing></w:r></w:p>
      <w:p><w:r><w:t>DOCX original layout second</w:t></w:r></w:p><w:sectPr>{landscape}</w:sectPr>"""
    image_target = (
        'Target="https://example.invalid/image.png" TargetMode="External"'
        if remote_image
        else 'Target="media/marker.png"'
    )
    relationships = (
        f'<Relationship Id="rIdImage" Type="{REL_NS}/image" {image_target}/>'
        f'<Relationship Id="rIdLink" Type="{REL_NS}/hyperlink" Target="https://example.invalid/" TargetMode="External"/>'
    )
    path.write_bytes(
        docx_bytes(
            body=body,
            relationships=relationships,
            extra_files={"word/media/marker.png": marker_png()},
        )
    )


class OfficePrintTests(unittest.TestCase):
    def test_docx_conversion_copy_keeps_layout_media_namespace_and_literal_link_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, target = Path(temporary) / "source.docx", Path(temporary) / "copy.docx"
            layout_docx(source)
            before = source.read_bytes()
            _docx_conversion_copy(source, target)
            self.assertEqual(source.read_bytes(), before)
            with zipfile.ZipFile(target) as archive:
                document = archive.read("word/document.xml")
                relationships = archive.read("word/_rels/document.xml.rels")
                self.assertIn(b"DOCX original layout first", document)
                self.assertIn(b"visible link", document)
                self.assertIn(b'w:orient="landscape"', document)
                self.assertIn(b"xmlns:pic=", document)
                self.assertIn("word/media/marker.png", archive.namelist())
                self.assertNotIn(b"rIdLink", document)
                self.assertNotIn(b"https://example.invalid", relationships)
                self.assertNotIn(b"/hyperlink", relationships)

    def test_docx_external_image_refused_before_converter(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.docx"
            layout_docx(source, remote_image=True)
            before = source.read_bytes()
            runner = CommandRunner(root, timeout_seconds=10, output_bytes=4096)
            with patch.object(runner, "run") as run:
                prepared, facts, conversion = build_docx_print_vectors(source, root, runner)
                run.assert_not_called()
            self.assertIsNone(prepared)
            self.assertIn("unavailable_reason", facts)
            self.assertEqual(conversion, {})
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(list(root.iterdir()), [source])

    def test_docx_missing_converter_retains_source_and_uses_fixed_child_format(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.docx"
            layout_docx(source)
            before = source.read_bytes()
            runner = CommandRunner(root, timeout_seconds=10, output_bytes=4096)
            with patch.object(
                runner, "run", side_effect=TransientFailure("runtime_missing")
            ) as run:
                self.assertIsNone(build_docx_print_vectors(source, root, runner)[0])
                arguments = run.call_args.args[1]
                self.assertEqual(arguments[-2:], ["/tmp/job", "docx"])
                self.assertIn("--unshare-user", arguments)
                self.assertIn("--unshare-pid", arguments)
                self.assertIn("--die-with-parent", arguments)
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(list(root.iterdir()), [source])

    def test_conversion_copy_retains_layout_media_and_original_not_active_settings_or_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, target = Path(temporary) / "source.odt", Path(temporary) / "copy.odt"
            layout_odt(source)
            before = source.read_bytes()
            _conversion_copy(source, target)
            self.assertEqual(source.read_bytes(), before)
            with zipfile.ZipFile(target) as archive:
                self.assertNotIn("settings.xml", archive.namelist())
                self.assertIn("Pictures/marker.png", archive.namelist())
                self.assertIn(b"22pt", archive.read("content.xml"))
                self.assertNotIn(b"https://example.invalid", archive.read("content.xml"))
                self.assertIn(b"21cm", archive.read("styles.xml"))
                self.assertEqual(archive.infolist()[0].filename, "mimetype")

    def test_missing_converter_keeps_original_and_semantic_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.odt"
            layout_odt(source)
            before = source.read_bytes()
            runner = CommandRunner(root, timeout_seconds=10, output_bytes=4096)
            with patch.object(runner, "run", side_effect=TransientFailure("runtime_missing")):
                prepared, facts, conversion = build_odt_print_vectors(source, root, runner)
            self.assertIsNone(prepared)
            self.assertIn("unavailable_reason", facts)
            self.assertEqual(conversion, {})
            self.assertEqual(before, source.read_bytes())
            self.assertEqual(list(root.iterdir()), [source])

    def test_missing_or_invalid_isolated_version_record_keeps_semantic_fallback(self):
        for version in (
            None,
            b"",
            b"not LibreOffice",
            b"LibreOffice 7.4.7\x00",
            b"L" * 257,
            b"\xff",
        ):
            with self.subTest(version=version), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source = root / "source.odt"
                layout_odt(source)
                before = source.read_bytes()
                runner = CommandRunner(root, timeout_seconds=10, output_bytes=4096)

                def complete_office(program, arguments, *, cwd, _version=version, **kwargs):
                    self.assertEqual(program, "office-print")
                    if _version is not None:
                        (cwd / "converter-version.txt").write_bytes(_version)

                with patch.object(runner, "run", side_effect=complete_office) as run:
                    prepared, facts, conversion = build_odt_print_vectors(source, root, runner)
                    run.assert_called_once()
                self.assertIsNone(prepared)
                self.assertEqual(facts["unavailable_reason"], "office_unsupported_or_bounded")
                self.assertEqual(conversion, {})
                self.assertEqual(source.read_bytes(), before)
                self.assertEqual(list(root.iterdir()), [source])

    def test_remote_render_dependency_refused_before_converter(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.odt"
            layout_odt(source, remote_image=True)
            runner = CommandRunner(root, timeout_seconds=10, output_bytes=4096)
            with patch.object(runner, "run") as run:
                self.assertIsNone(build_odt_print_vectors(source, root, runner)[0])
                run.assert_not_called()

    def test_corrupt_embedded_media_keeps_the_existing_semantic_ingestion(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.odt"
            layout_odt(source)
            with zipfile.ZipFile(source) as archive:
                info = archive.getinfo("Pictures/marker.png")
                offset = info.header_offset + 30 + len(info.filename.encode()) + len(info.extra)
            body = bytearray(source.read_bytes())
            body[offset + 4] ^= 0xFF
            source.write_bytes(body)
            semantic = inspect_odt(
                source,
                root,
                maximum_entries=256,
                maximum_expanded_bytes=64 * 1024 * 1024,
                maximum_ratio=100,
            )
            self.assertTrue(semantic.quality_results["valid"])
            runner = CommandRunner(root, timeout_seconds=10, output_bytes=4096)
            with patch.object(runner, "run") as run:
                self.assertIsNone(build_odt_print_vectors(source, root, runner)[0])
                run.assert_not_called()
            self.assertEqual(source.read_bytes(), body)

    def test_formula_namespace_survives_hyperlink_sanitization(self):
        from opengeo_worker.office_print_vectors import _conversion_xml

        body = b'<root xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" formula="of:=1+1"/>'
        serialized = _conversion_xml(body)
        self.assertIn(b'xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2"', serialized)
        self.assertIn(b'formula="of:=1+1"', serialized)

    def test_nested_formula_namespace_rebinding_keeps_each_original_scope(self):
        from xml.dom import minidom
        from xml.dom.minidom import Element

        outer = "urn:oasis:names:tc:opendocument:xmlns:of:1.2"
        nested = "http://openoffice.org/2004/calc"
        table_ns = "urn:oasis:names:tc:opendocument:xmlns:table:1.0"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, target = root / "source.odt", root / "copy.odt"
            layout_odt(source)
            with zipfile.ZipFile(source) as archive:
                entries = [(info, archive.read(info)) for info in archive.infolist()]
            content = next(body for info, body in entries if info.filename == "content.xml")
            content = (
                content.replace(
                    b'office:version="1.3">',
                    f'xmlns:of="{outer}" xmlns:ns0="{outer}" office:version="1.3">'.encode(),
                    1,
                )
                .replace(
                    b"<table:table-cell><text:p>Station",
                    b'<table:table-cell table:formula="of:=1+1"><text:p>Station',
                    1,
                )
                .replace(
                    b"<table:table-cell><text:p>42</text:p></table:table-cell>",
                    (
                        f'<table:table-cell xmlns:of="{nested}" table:formula="of:=2+2"><text:p>42</text:p></table:table-cell>'
                        '<table:table-cell table:formula="of:=3+3"><text:p>6</text:p></table:table-cell>'
                        '<table:table-cell table:formula="ns0:=4+4"><text:p>8</text:p></table:table-cell>'
                    ).encode(),
                    1,
                )
            )
            with zipfile.ZipFile(source, "w") as archive:
                for info, body in entries:
                    archive.writestr(info, content if info.filename == "content.xml" else body)
            before = source.read_bytes()
            semantic = inspect_odt(
                source,
                root,
                maximum_entries=256,
                maximum_expanded_bytes=64 * 1024 * 1024,
                maximum_ratio=100,
            )
            self.assertTrue(semantic.quality_results["valid"])
            _conversion_copy(source, target)
            self.assertEqual(source.read_bytes(), before)
            with zipfile.ZipFile(target) as archive:
                serialized = archive.read("content.xml")

            def binding(element: Element, prefix: str) -> str:
                node = element
                while isinstance(node, Element):
                    if node.hasAttribute(f"xmlns:{prefix}"):
                        return node.getAttribute(f"xmlns:{prefix}")
                    node = node.parentNode
                self.fail(f"unbound formula prefix {prefix}")

            with minidom.parseString(serialized) as document:
                cells = document.getElementsByTagNameNS(table_ns, "table-cell")
                self.assertEqual(len(cells), 4)
                expected = [
                    ("of:=1+1", outer),
                    ("of:=2+2", nested),
                    ("of:=3+3", outer),
                    ("ns0:=4+4", outer),
                ]
                for cell, (formula, namespace) in zip(cells, expected, strict=True):
                    self.assertEqual(cell.getAttributeNS(table_ns, "formula"), formula)
                    self.assertEqual(binding(cell, formula.split(":", 1)[0]), namespace)
                links = document.getElementsByTagNameNS(
                    "urn:oasis:names:tc:opendocument:xmlns:text:1.0", "a"
                )
                self.assertEqual(len(links), 1)
                self.assertFalse(links[0].hasAttributeNS("http://www.w3.org/1999/xlink", "href"))
                self.assertEqual(links[0].firstChild.data, "visible link")

    @unittest.skipUnless(
        os.environ.get("OPEN_GEO_TEST_NATIVE_OFFICE") == "1", "explicit local native qualification"
    )
    def test_native_docx_original_layout(self):
        from pypdf import PdfReader

        with tempfile.TemporaryDirectory(prefix="og-office-") as temporary:
            root = Path(temporary)
            source = root / "source.docx"
            layout_docx(source)
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            runner = CommandRunner(root, timeout_seconds=25, output_bytes=32768)
            prepared, facts, conversion = build_docx_print_vectors(source, root, runner)
            self.assertIsNotNone(prepared, facts)
            self.assertEqual(before, hashlib.sha256(source.read_bytes()).hexdigest())
            self.assertEqual(facts["page_count"], 2)
            self.assertEqual(conversion["network"], "seccomp-denied")
            reader = PdfReader(prepared)
            self.assertIn("DOCX original layout first", reader.pages[0].extract_text())
            self.assertIn("visible link", reader.pages[0].extract_text())
            self.assertIn("Station", reader.pages[0].extract_text())
            self.assertIn("42", reader.pages[0].extract_text())
            self.assertIn("DOCX original layout second", reader.pages[1].extract_text())
            self.assertLess(reader.pages[0].mediabox.width, reader.pages[0].mediabox.height)
            self.assertGreater(reader.pages[1].mediabox.width, reader.pages[1].mediabox.height)
            self.assertIn("/Font", reader.pages[0]["/Resources"])
            self.assertIn("/XObject", reader.pages[0]["/Resources"])
            self.assertFalse(any("/Annots" in page for page in reader.pages))

    @unittest.skipUnless(
        os.environ.get("OPEN_GEO_TEST_NATIVE_OFFICE") == "1", "explicit local native qualification"
    )
    def test_native_original_layout_and_kernel_boundaries(self):
        from pypdf import PdfReader

        with tempfile.TemporaryDirectory(prefix="og-office-") as temporary:
            root = Path(temporary)
            source = root / "source.odt"
            layout_odt(source)
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            runner = CommandRunner(root, timeout_seconds=25, output_bytes=32768)
            prepared, facts, conversion = build_odt_print_vectors(source, root, runner)
            self.assertIsNotNone(prepared, facts)
            self.assertEqual(before, hashlib.sha256(source.read_bytes()).hexdigest())
            self.assertEqual(facts["page_count"], 2)
            self.assertEqual(conversion["network"], "seccomp-denied")
            reader = PdfReader(prepared)
            self.assertIn("Original layout first", reader.pages[0].extract_text())
            self.assertIn("Station", reader.pages[0].extract_text())
            self.assertIn("Original layout second", reader.pages[1].extract_text())
            self.assertLess(reader.pages[0].mediabox.width, reader.pages[0].mediabox.height)
            self.assertGreater(reader.pages[1].mediabox.width, reader.pages[1].mediabox.height)
            self.assertIn("/Font", reader.pages[0]["/Resources"])
            self.assertIn("/XObject", reader.pages[0]["/Resources"])
            self.assertFalse(any("/Annots" in page for page in reader.pages))
            # In a separate child, verify actual denied operations, not declarations.
            secret = root / "outside.txt"
            secret.write_text("PRIVATE-CONTROL")
            work = root / "probe"
            work.mkdir()
            package = str(Path(__file__).resolve().parents[1] / "src")
            probe = f"""import sys,os,socket,json
from pathlib import Path
sys.path.insert(0,{package!r})
from opengeo_worker.office_sandbox import restrict_office_process
restrict_office_process(Path({str(work)!r}))
checks=[]
for operation in [lambda:open({str(secret)!r}).read(),lambda:open({str(secret)!r},'w'),lambda:socket.socket(socket.AF_INET),lambda:socket.socket(socket.AF_INET6)]:
 try:operation()
 except PermissionError:checks.append(True)
 else:checks.append(False)
Path({str(work / "ok")!r}).write_text('allowed')
checks.append(Path({str(work / "ok")!r}).read_text()=='allowed')
s=socket.socket(socket.AF_UNIX);s.close();checks.append(True)
print(json.dumps(checks))"""
            result = subprocess.run(
                [sys.executable, "-I", "-c", probe],
                capture_output=True,
                text=True,
                timeout=10,
                env={"PATH": "/usr/bin:/bin"},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), [True] * 6)


if __name__ == "__main__":
    unittest.main()
