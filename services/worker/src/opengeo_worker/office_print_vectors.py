"""One-shot original-layout ODT rendering, after the ordinary source safety gates.

The semantic preview and original package stay intact. Only the derived PDF
enters the existing safe-vector preparation path. No office service is started.
"""

import json
import os
import re
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import zipfile
import zlib
from pathlib import Path
from xml.dom import minidom
from xml.dom.minidom import Element
from xml.parsers.expat import ExpatError

from opengeo_worker.command_runner import CommandRunner
from opengeo_worker.models import TransientFailure, ValidationFailure
from opengeo_worker.odf_documents import _parse_xml, _read_package
from opengeo_worker.pdf_print_vectors import MAX_BYTES, build_pdf_print_vectors

_MAX_SOURCE_BYTES = 32 * 1024 * 1024
_MAX_CONVERTED_BYTES = 16 * 1024 * 1024
_VERSION = re.compile(r"LibreOffice [0-9]+(?:\.[0-9]+){2,3}[^\r\n\x00-\x1f]{0,90}")
_MANIFEST = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"
_XLINK = "http://www.w3.org/1999/xlink"
_HYPERLINKS = {
    ("urn:oasis:names:tc:opendocument:xmlns:text:1.0", "a"),
    ("urn:oasis:names:tc:opendocument:xmlns:drawing:1.0", "a"),
}


def _conversion_xml(body: bytes, *, omitted: set[str] | None = None) -> bytes:
    # Keep the existing entity/DTD gate before using another XML parser. DOM
    # retains lexical namespace declarations in their original element scopes,
    # including prefixes used only inside ODF formula attribute values.
    _parse_xml(body, "document_structure_invalid")
    with minidom.parseString(body) as document:
        if omitted is not None:
            root = document.documentElement
            if root is None:
                raise ValueError("document_root_missing")
            for child in list(root.childNodes):
                if (
                    isinstance(child, Element)
                    and child.getAttributeNS(_MANIFEST, "full-path") in omitted
                ):
                    root.removeChild(child)
                    child.unlink()
        else:
            for element in document.getElementsByTagName("*"):
                local = element.localName or element.tagName
                if local in {"dde-source", "section-source", "table-source"} or local.startswith(
                    "database-"
                ):
                    raise ValueError("linked_content_requires_external_source")
                href = element.getAttributeNS(_XLINK, "href")
                if (element.namespaceURI, local) in _HYPERLINKS:
                    # Retain displayed text/styles, not actionable PDF links.
                    if element.hasAttributeNS(_XLINK, "href"):
                        element.removeAttributeNS(_XLINK, "href")
                elif href and not href.startswith(("Pictures/", "#")):
                    raise ValueError("linked_content_requires_external_source")
        encoded: bytes = document.toxml(encoding="utf-8")
        return encoded


def _conversion_copy(source: Path, target: Path) -> None:
    # Reuse the same closed package limits before another native parser sees it.
    _read_package(
        source,
        maximum_entries=256,
        maximum_expanded_bytes=64 * 1024 * 1024,
        maximum_ratio=100,
    )
    omitted = {"settings.xml", "manifest.rdf", "Thumbnails/thumbnail.png"}
    with zipfile.ZipFile(source) as archive, zipfile.ZipFile(target, "w") as output:
        for info in archive.infolist():
            if info.is_dir() or info.filename in omitted:
                continue
            body = archive.read(info)
            if info.filename.endswith(".xml"):
                body = _conversion_xml(
                    body, omitted=omitted if info.filename == "META-INF/manifest.xml" else None
                )
            output.writestr(
                info.filename,
                body,
                compress_type=(
                    zipfile.ZIP_STORED if info.filename == "mimetype" else zipfile.ZIP_DEFLATED
                ),
            )


def build_odt_print_vectors(
    source: Path,
    workdir: Path,
    runner: CommandRunner,
) -> tuple[Path | None, dict[str, object], dict[str, object]]:
    """Return optional prepared pages, safe PDF facts and conversion provenance."""
    target = workdir / "print-vector.pdf"
    target.unlink(missing_ok=True)
    if not 1 <= source.stat().st_size <= _MAX_SOURCE_BYTES:
        return None, {"unavailable_reason": "source_limit"}, {}
    try:
        # A private short child directory also stays below Unix socket path limits.
        with tempfile.TemporaryDirectory(prefix="office-", dir=workdir) as temporary:
            conversion = Path(temporary)
            _conversion_copy(source, conversion / "source.odt")
            package = str(Path(__file__).resolve().parents[1])
            bootstrap = (
                f"import sys;sys.path.insert(0,{package!r});"
                "from opengeo_worker.office_print_vectors import main;main()"
            )
            runner.run(
                "office-print",
                [
                    "--unshare-user",
                    "--unshare-pid",
                    "--ro-bind",
                    "/",
                    "/",
                    "--proc",
                    "/proc",
                    # A user-namespace root bind cannot open the host device
                    # nodes. Supply bubblewrap's private minimal device mount;
                    # Landlock still permits only null and urandom below it.
                    "--dev",
                    "/dev",
                    "--size",
                    "67108864",
                    "--tmpfs",
                    "/tmp",
                    "--dir",
                    "/tmp/job",
                    "--bind",
                    str(conversion),
                    "/tmp/job",
                    "--chdir",
                    "/tmp/job",
                    "--die-with-parent",
                    "--",
                    sys.executable,
                    "-I",
                    "-c",
                    bootstrap,
                    "/tmp/job",
                ],
                cwd=conversion,
                maximum_file_bytes=_MAX_CONVERTED_BYTES,
            )
            with (conversion / "converter-version.txt").open("rb") as version_file:
                version_bytes = version_file.read(257)
            if len(version_bytes) > 256:
                raise ValueError("office_version_unavailable")
            version = version_bytes.decode("utf-8").strip()
            if len(version) > 120 or not _VERSION.fullmatch(version):
                raise ValueError("office_version_unavailable")
            rendered = conversion / "source.pdf"
            if not rendered.is_file() or not 1 <= rendered.stat().st_size <= _MAX_CONVERTED_BYTES:
                raise ValueError("office_output_limit")
            metadata = runner.run("pdfinfo", ["-box", str(rendered)], cwd=conversion).stdout
            pages = re.search(r"^Pages:\s+([0-9]+)\s*$", metadata, re.MULTILINE)
            if pages is None or not 1 <= int(pages[1]) <= 200:
                raise ValueError("office_page_limit")
            # The PDF safe-cloner parses the full reachable graph, rejects active
            # controls/attachments and strips inert annotations and volatile metadata.
            prepared, facts = build_pdf_print_vectors(
                rendered,
                conversion,
                runner,
                page_count=int(pages[1]),
            )
            if prepared is None or prepared.stat().st_size > MAX_BYTES:
                raise ValueError("office_pdf_unsupported")
            shutil.move(str(prepared), target)
            return (
                target,
                facts,
                {
                    "renderer": "libreoffice-writer-pdf",
                    "version": version,
                    "export_filter": "writer_pdf_Export",
                    "network": "seccomp-denied",
                    "fonts": "system-fonts-substitution-possible",
                },
            )
    except (
        ValidationFailure,
        TransientFailure,
        ValueError,
        OSError,
        RuntimeError,
        ExpatError,
        zipfile.BadZipFile,
        zlib.error,
    ):
        target.unlink(missing_ok=True)
        return None, {"unavailable_reason": "office_unsupported_or_bounded"}, {}


def main() -> None:
    """Fixed executable/arguments; the caller never supplies a command or filter."""
    from opengeo_worker.office_sandbox import restrict_office_process

    workdir = Path(sys.argv[1]).resolve()
    if workdir != Path.cwd().resolve() or not (workdir / "source.odt").is_file():
        raise ValueError("office_workspace_invalid")
    profile = workdir / "profile"
    (profile / "user").mkdir(parents=True)
    (profile / "user/registrymodifications.xcu").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<oor:items xmlns:oor="http://openoffice.org/2001/registry">'
        '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
        '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>'
        '<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>'
        "</item></oor:items>",
        encoding="utf-8",
    )
    filters = {
        key: {"type": "boolean", "value": "false"}
        for key in (
            "UseTaggedPDF",
            "ExportFormFields",
            "ExportBookmarks",
            "ExportNotes",
            "ExportNotesPages",
            "IsAddStream",
            "ExportBookmarksToPDFDestination",
        )
    }
    os.environ.update(
        {
            "HOME": str(workdir),
            "TMPDIR": str(workdir),
            "SAL_USE_VCLPLUGIN": "svp",
            "XDG_CACHE_HOME": str(workdir / "cache"),
            "XDG_CONFIG_HOME": str(workdir / "config"),
            "XDG_DATA_HOME": str(workdir / "data"),
        }
    )
    signal.alarm(30)
    restrict_office_process(workdir, private_runtime=True)
    # Apply the same process cap after entering the private user namespace,
    # where unrelated desktop processes do not consume this child's allowance.
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
    completed = subprocess.run(
        ["/usr/bin/libreoffice", "--version"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=5,
        check=True,
        close_fds=True,
    )
    if len(completed.stdout) > 256:
        raise ValueError("office_version_unavailable")
    version = completed.stdout.decode("utf-8").strip()
    if len(version) > 120 or not _VERSION.fullmatch(version):
        raise ValueError("office_version_unavailable")
    (workdir / "converter-version.txt").write_text(version + "\n", encoding="utf-8")
    os.execv(
        "/usr/bin/libreoffice",
        [
            "/usr/bin/libreoffice",
            f"-env:UserInstallation={profile.as_uri()}",
            "--headless",
            "--nologo",
            "--nodefault",
            "--norestore",
            "--convert-to",
            "pdf:writer_pdf_Export:" + json.dumps(filters, separators=(",", ":")),
            "--outdir",
            str(workdir),
            str(workdir / "source.odt"),
        ],
    )
