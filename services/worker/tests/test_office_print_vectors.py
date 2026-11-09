# ruff: noqa: E501

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from opengeo_worker.command_runner import CommandRunner
from opengeo_worker.models import TransientFailure
from opengeo_worker.odf_documents import inspect_odt
from opengeo_worker.office_print_vectors import _conversion_copy, build_odt_print_vectors


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


class OfficePrintTests(unittest.TestCase):
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
