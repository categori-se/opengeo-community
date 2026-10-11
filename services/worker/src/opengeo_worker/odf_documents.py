import json
import re
import stat
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit
from xml.etree import ElementTree

from opengeo_worker.models import ArtifactFile, InspectionResult, ValidationFailure

ODT_MEDIA_TYPE = "application/vnd.oasis.opendocument.text"
PREVIEW_SCHEMA = "opengeo.document-preview.1.0.0"
PREVIEW_CONTENT_TYPE = "application/json"

_NS = {
    "dc": "http://purl.org/dc/elements/1.1/",
    "draw": "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
    "fo": "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
    "manifest": "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0",
    "office": "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
    "script": "urn:oasis:names:tc:opendocument:xmlns:script:1.0",
    "style": "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
    "table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
    "text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
    "xlink": "http://www.w3.org/1999/xlink",
}

_MAX_SOURCE_BYTES = 32 * 1024 * 1024
_MAX_EXPANDED_BYTES = 64 * 1024 * 1024
_MAX_ENTRY_BYTES = 16 * 1024 * 1024
_MAX_XML_BYTES = 8 * 1024 * 1024
_MAX_COMPRESSION_RATIO = 100
_MAX_PAGES = 200
_MAX_BLOCKS = 2_000
_MAX_TEXT_CHARACTERS = 200_000
_MAX_PREVIEW_BYTES = 512 * 1024
_MAX_TABLE_ROWS = 200
_MAX_TABLE_COLUMNS = 20
_MAX_TABLE_CELLS = 5_000
_MAX_CELL_CHARACTERS = 1_000
_MAX_LIST_ITEMS = 500
_LANGUAGE = re.compile(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}")

_OFFICE = f"{{{_NS['office']}}}"
_TEXT = f"{{{_NS['text']}}}"
_TABLE = f"{{{_NS['table']}}}"
_STYLE = f"{{{_NS['style']}}}"
_FO = f"{{{_NS['fo']}}}"
_MANIFEST = f"{{{_NS['manifest']}}}"
_XLINK_HREF = f"{{{_NS['xlink']}}}href"
_PAGE_MARKER = "\u0000OPEN_GEO_PAGE_BREAK\u0000"


@dataclass(frozen=True, slots=True)
class _Package:
    manifest_version: str | None
    content: bytes
    styles: bytes | None
    metadata: bytes | None
    embedded_media_count: int
    entry_count: int
    expanded_bytes: int


class _PreviewBuilder:
    def __init__(self, break_before: set[str], break_after: set[str], ordered: set[str]) -> None:
        self.pages: list[list[dict[str, object]]] = [[]]
        self.break_before = break_before
        self.break_after = break_after
        self.ordered = ordered
        self.block_count = 0
        self.text_characters = 0
        self.table_cells = 0

    def render(self, office_text: ElementTree.Element) -> None:
        for child in office_text:
            self._render_element(child)
        while len(self.pages) > 1 and not self.pages[-1]:
            self.pages.pop()
        if not any(self.pages):
            raise ValidationFailure("document_structure_invalid")

    def _render_element(self, element: ElementTree.Element) -> None:
        style_name = element.get(f"{_TEXT}style-name", "")
        if style_name in self.break_before:
            self._new_page()
        if element.tag == f"{_TEXT}h":
            level_text = element.get(f"{_TEXT}outline-level", "1")
            try:
                level = int(level_text)
            except ValueError as error:
                raise ValidationFailure("document_structure_invalid") from error
            if not 1 <= level <= 10:
                raise ValidationFailure("document_structure_invalid")
            self._add_segmented_text("heading", element, level=level)
        elif element.tag == f"{_TEXT}p":
            self._add_segmented_text("paragraph", element)
        elif element.tag == f"{_TEXT}list":
            self._add_list(element)
        elif element.tag == f"{_TABLE}table":
            self._add_table(element)
        elif element.tag in {f"{_TEXT}section", f"{_OFFICE}text"}:
            for child in element:
                self._render_element(child)
        elif element.tag in {
            f"{_TEXT}sequence-decls",
            f"{_TEXT}tracked-changes",
            f"{_TEXT}user-field-decls",
            f"{_TEXT}variable-decls",
        }:
            pass
        if style_name in self.break_after:
            self._new_page()

    def _add_segmented_text(
        self, kind: str, element: ElementTree.Element, *, level: int | None = None
    ) -> None:
        segments = _inline_text(element).split(_PAGE_MARKER)
        for index, segment in enumerate(segments):
            if index:
                self._new_page()
            text = _normalize_text(segment)
            if not text:
                continue
            block: dict[str, object] = {"type": kind, "text": text}
            if level is not None:
                block["level"] = level
            self._add_block(block, len(text))

    def _add_list(self, element: ElementTree.Element) -> None:
        style_name = element.get(f"{_TEXT}style-name", "")
        items: list[str] = []
        for item in element.findall(f"{_TEXT}list-item"):
            text = _normalize_text(_inline_text(item).replace(_PAGE_MARKER, " "))
            if text:
                items.append(text)
            if len(items) > _MAX_LIST_ITEMS:
                raise ValidationFailure("document_content_limit_exceeded")
        if items:
            self._add_block(
                {"type": "list", "ordered": style_name in self.ordered, "items": items},
                sum(len(item) for item in items),
            )
        if any(_PAGE_MARKER in _inline_text(item) for item in element.findall(f"{_TEXT}list-item")):
            self._new_page()

    def _add_table(self, element: ElementTree.Element) -> None:
        rows: list[list[str]] = []
        header_rows = 0
        for raw_row, is_header in _table_rows(element):
            try:
                row_repeat = int(raw_row.get(f"{_TABLE}number-rows-repeated", "1"))
            except ValueError as error:
                raise ValidationFailure("document_structure_invalid") from error
            if not 1 <= row_repeat <= _MAX_TABLE_ROWS:
                raise ValidationFailure("document_content_limit_exceeded")
            row: list[str] = []
            for cell in raw_row:
                if cell.tag not in {f"{_TABLE}table-cell", f"{_TABLE}covered-table-cell"}:
                    continue
                try:
                    column_repeat = int(cell.get(f"{_TABLE}number-columns-repeated", "1"))
                except ValueError as error:
                    raise ValidationFailure("document_structure_invalid") from error
                if not 1 <= column_repeat <= _MAX_TABLE_COLUMNS:
                    raise ValidationFailure("document_content_limit_exceeded")
                value = _normalize_text(_inline_text(cell).replace(_PAGE_MARKER, " "))
                if len(value) > _MAX_CELL_CHARACTERS:
                    raise ValidationFailure("document_content_limit_exceeded")
                row.extend([value] * column_repeat)
                if len(row) > _MAX_TABLE_COLUMNS:
                    raise ValidationFailure("document_content_limit_exceeded")
            if row:
                for _ in range(row_repeat):
                    rows.append(list(row))
                    if is_header:
                        header_rows += 1
                    if len(rows) > _MAX_TABLE_ROWS:
                        raise ValidationFailure("document_content_limit_exceeded")
        if not rows:
            return
        width = max(len(row) for row in rows)
        for row in rows:
            row.extend([""] * (width - len(row)))
        self.table_cells += len(rows) * width
        if self.table_cells > _MAX_TABLE_CELLS:
            raise ValidationFailure("document_content_limit_exceeded")
        label = element.get(f"{_TABLE}name")
        block: dict[str, object] = {
            "type": "table",
            "headerRows": header_rows,
            "rows": rows,
        }
        if label and 1 <= len(label) <= 300:
            block["label"] = label
        self._add_block(block, sum(len(cell) for row in rows for cell in row))
        if _PAGE_MARKER in _inline_text(element):
            self._new_page()

    def _add_block(self, block: dict[str, object], characters: int) -> None:
        self.block_count += 1
        self.text_characters += characters
        if self.block_count > _MAX_BLOCKS or self.text_characters > _MAX_TEXT_CHARACTERS:
            raise ValidationFailure("document_content_limit_exceeded")
        self.pages[-1].append(block)

    def _new_page(self) -> None:
        if not self.pages[-1]:
            return
        if len(self.pages) >= _MAX_PAGES:
            raise ValidationFailure("document_content_limit_exceeded")
        self.pages.append([])


def inspect_odt(
    source: Path,
    workdir: Path,
    *,
    maximum_entries: int,
    maximum_expanded_bytes: int,
    maximum_ratio: int,
) -> InspectionResult:
    package = _read_package(
        source,
        maximum_entries=min(maximum_entries, 256),
        maximum_expanded_bytes=min(maximum_expanded_bytes, _MAX_EXPANDED_BYTES),
        maximum_ratio=min(maximum_ratio, _MAX_COMPRESSION_RATIO),
    )
    content_root = _parse_xml(package.content, "document_structure_invalid")
    if content_root.tag != f"{_OFFICE}document-content":
        raise ValidationFailure("document_structure_invalid")
    version = content_root.get(f"{_OFFICE}version") or package.manifest_version
    if version not in {"1.2", "1.3", "1.4"} or package.manifest_version not in {
        None,
        version,
    }:
        raise ValidationFailure("document_structure_invalid")
    _reject_active_or_external_content(content_root)
    styles_root = (
        _parse_xml(package.styles, "document_structure_invalid")
        if package.styles is not None
        else None
    )
    if styles_root is not None:
        _reject_active_or_external_content(styles_root)
    break_before, break_after, ordered = _style_contract(content_root, styles_root)
    office_text = content_root.find(f"{_OFFICE}body/{_OFFICE}text")
    if office_text is None:
        raise ValidationFailure("document_structure_invalid")
    builder = _PreviewBuilder(break_before, break_after, ordered)
    builder.render(office_text)
    title, language = _metadata(package.metadata)
    preview = {
        "schemaVersion": PREVIEW_SCHEMA,
        "sourceFormat": "odt",
        "odfVersion": version,
        "title": title,
        "language": language,
        "pages": [
            {"number": index + 1, "blocks": blocks} for index, blocks in enumerate(builder.pages)
        ],
    }
    encoded = (
        json.dumps(preview, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode("utf-8")
    if len(encoded) > _MAX_PREVIEW_BYTES:
        raise ValidationFailure("document_content_limit_exceeded")
    target = workdir / "accessible-preview.json"
    target.write_bytes(encoded)
    return InspectionResult(
        feature_count=None,
        extent=None,
        crs=None,
        geometry_type="document",
        schema_definition={
            "document": {
                "kind": "odf_text",
                "source_format": "odt",
                "odf_version": version,
                "page_count": len(builder.pages),
                "block_count": builder.block_count,
                "text_characters": builder.text_characters,
                "embedded_media_count": package.embedded_media_count,
                "accessible_preview_schema": PREVIEW_SCHEMA,
            }
        },
        quality_results={
            "valid": True,
            "checks": [
                {"code": "format_verified", "status": "passed"},
                {"code": "odf_package_manifest_verified", "status": "passed"},
                {"code": "encrypted_active_and_embedded_content_absent", "status": "passed"},
                {"code": "bounded_semantic_text_extraction", "status": "passed"},
                {"code": "accessible_preview_generated", "status": "passed"},
            ],
            "warnings": [
                {"code": "semantic_preview_does_not_claim_page_layout_fidelity"},
                {"code": "embedded_media_not_included_in_semantic_preview"},
            ],
        },
        artifacts=(
            ArtifactFile(
                "derived",
                "document/accessible-preview.json",
                PREVIEW_CONTENT_TYPE,
                target,
            ),
        ),
    )


def _read_package(
    source: Path, *, maximum_entries: int, maximum_expanded_bytes: int, maximum_ratio: int
) -> _Package:
    if not 1 <= source.stat().st_size <= _MAX_SOURCE_BYTES:
        raise ValidationFailure("document_source_too_large")
    try:
        with zipfile.ZipFile(source) as archive:
            infos = archive.infolist()
            if not 3 <= len(infos) <= maximum_entries:
                raise ValidationFailure("document_archive_invalid")
            first = infos[0]
            if (
                first.filename != "mimetype"
                or first.compress_type != zipfile.ZIP_STORED
                or first.extra
                or archive.read(first) != ODT_MEDIA_TYPE.encode("ascii")
            ):
                raise ValidationFailure("document_archive_invalid")
            names: set[str] = set()
            files: set[str] = set()
            expanded = 0
            embedded_media = 0
            for info in infos:
                path = PurePosixPath(info.filename)
                unix_mode = info.external_attr >> 16
                if (
                    info.flag_bits & 0x1
                    or path.is_absolute()
                    or "\\" in info.filename
                    or ":" in info.filename
                    or any(part in {"", ".", ".."} for part in path.parts)
                    or (unix_mode and stat.S_ISLNK(unix_mode))
                    or info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
                    or info.filename.casefold() in names
                ):
                    raise ValidationFailure("document_archive_invalid")
                names.add(info.filename.casefold())
                if info.is_dir():
                    continue
                files.add(info.filename)
                if info.file_size < 0 or info.file_size > _MAX_ENTRY_BYTES:
                    raise ValidationFailure("document_content_limit_exceeded")
                expanded += info.file_size
                ratio = info.file_size / max(1, info.compress_size)
                if expanded > maximum_expanded_bytes or ratio > maximum_ratio:
                    raise ValidationFailure("document_content_limit_exceeded")
                if info.filename.startswith("Pictures/"):
                    embedded_media += 1
                elif not _allowed_package_file(info.filename):
                    raise ValidationFailure("document_active_content_blocked")
            mandatory = {"mimetype", "content.xml", "META-INF/manifest.xml"}
            if not mandatory <= files:
                raise ValidationFailure("document_archive_invalid")
            manifest_bytes = _bounded_read(archive, "META-INF/manifest.xml", _MAX_XML_BYTES)
            manifest_version = _verify_manifest(manifest_bytes, files)
            content = _bounded_read(archive, "content.xml", _MAX_XML_BYTES)
            styles = (
                _bounded_read(archive, "styles.xml", _MAX_XML_BYTES)
                if "styles.xml" in files
                else None
            )
            metadata = (
                _bounded_read(archive, "meta.xml", _MAX_XML_BYTES) if "meta.xml" in files else None
            )
    except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile, RuntimeError) as error:
        if isinstance(error, ValidationFailure):
            raise
        raise ValidationFailure("document_archive_invalid") from error
    return _Package(
        manifest_version,
        content,
        styles,
        metadata,
        embedded_media,
        len(infos),
        expanded,
    )


def _allowed_package_file(name: str) -> bool:
    if name in {
        "mimetype",
        "content.xml",
        "styles.xml",
        "meta.xml",
        "settings.xml",
        "manifest.rdf",
        "META-INF/manifest.xml",
        "Thumbnails/thumbnail.png",
    }:
        return True
    if name.startswith("Pictures/"):
        suffix = PurePosixPath(name).suffix.lower()
        return suffix in {".png", ".jpg", ".jpeg"}
    return False


def _bounded_read(archive: zipfile.ZipFile, name: str, limit: int) -> bytes:
    info = archive.getinfo(name)
    if info.file_size > limit:
        raise ValidationFailure("document_content_limit_exceeded")
    content = archive.read(info)
    if len(content) != info.file_size:
        raise ValidationFailure("document_archive_invalid")
    return content


def _verify_manifest(content: bytes, files: set[str]) -> str | None:
    root = _parse_xml(content, "document_archive_invalid")
    if root.tag != f"{_MANIFEST}manifest":
        raise ValidationFailure("document_archive_invalid")
    version = root.get(f"{_MANIFEST}version")
    if version is not None and version not in {"1.2", "1.3", "1.4"}:
        raise ValidationFailure("document_archive_invalid")
    entries: dict[str, str] = {}
    for entry in root.findall(f"{_MANIFEST}file-entry"):
        path = entry.get(f"{_MANIFEST}full-path")
        media_type = entry.get(f"{_MANIFEST}media-type", "")
        if not path or path in entries or entry.find(f"{_MANIFEST}encryption-data") is not None:
            raise ValidationFailure("document_archive_invalid")
        entries[path] = media_type
    if entries.get("/") != ODT_MEDIA_TYPE:
        raise ValidationFailure("document_archive_invalid")
    for name in files - {"mimetype", "META-INF/manifest.xml"}:
        if entries.get(name) is None:
            raise ValidationFailure("document_archive_invalid")
    for name, media_type in entries.items():
        if name.startswith("Pictures/") and media_type not in {"image/png", "image/jpeg"}:
            raise ValidationFailure("document_archive_invalid")
    return version


def _parse_xml(content: bytes | None, code: str) -> ElementTree.Element:
    if content is None or b"<!DOCTYPE" in content.upper() or b"<!ENTITY" in content.upper():
        raise ValidationFailure(code)
    try:
        return ElementTree.fromstring(content)
    except ElementTree.ParseError as error:
        raise ValidationFailure(code) from error


def _reject_active_or_external_content(root: ElementTree.Element) -> None:
    forbidden = {
        f"{{{_NS['draw']}}}applet",
        f"{{{_NS['draw']}}}floating-frame",
        f"{{{_NS['draw']}}}object",
        f"{{{_NS['draw']}}}object-ole",
        f"{{{_NS['draw']}}}plugin",
        f"{{{_NS['script']}}}event-listener",
    }
    for element in root.iter():
        if element.tag in {f"{_OFFICE}forms", f"{_OFFICE}scripts"} and (
            element.attrib or list(element) or _normalize_text(element.text or "")
        ):
            raise ValidationFailure("document_active_content_blocked")
        if element.tag in forbidden or element.tag.startswith(
            "{urn:oasis:names:tc:opendocument:xmlns:form:"
        ):
            raise ValidationFailure("document_active_content_blocked")
        href = element.get(_XLINK_HREF)
        if href is not None and not _safe_reference(href):
            raise ValidationFailure("document_active_content_blocked")


def _safe_reference(value: str) -> bool:
    if not 1 <= len(value) <= 2_048 or any(ord(character) < 32 for character in value):
        return False
    if value.startswith("#"):
        return True
    if value.startswith("Pictures/"):
        path = PurePosixPath(value)
        return not path.is_absolute() and ".." not in path.parts
    try:
        parsed = urlsplit(value)
        return (
            parsed.scheme == "https"
            and bool(parsed.hostname)
            and parsed.username is None
            and parsed.password is None
            and parsed.port in {None, 443}
        )
    except ValueError:
        return False


def _style_contract(
    content: ElementTree.Element, styles: ElementTree.Element | None
) -> tuple[set[str], set[str], set[str]]:
    before: set[str] = set()
    after: set[str] = set()
    ordered: set[str] = set()
    roots = [content, *([styles] if styles is not None else [])]
    for root in roots:
        for style in root.iter(f"{_STYLE}style"):
            name = style.get(f"{_STYLE}name")
            if not name or len(name) > 200:
                continue
            properties = style.find(f"{_STYLE}paragraph-properties")
            if properties is not None:
                if properties.get(f"{_FO}break-before") == "page":
                    before.add(name)
                if properties.get(f"{_FO}break-after") == "page":
                    after.add(name)
        for list_style in root.iter(f"{_TEXT}list-style"):
            name = list_style.get(f"{_STYLE}name")
            if name and list_style.find(f"{_TEXT}list-level-style-number") is not None:
                ordered.add(name)
    return before, after, ordered


def _metadata(content: bytes | None) -> tuple[str | None, str | None]:
    if content is None:
        return None, None
    root = _parse_xml(content, "document_metadata_invalid")
    _reject_active_or_external_content(root)
    title = _normalize_text(root.findtext(f".//{{{_NS['dc']}}}title", default="")) or None
    language = _normalize_text(root.findtext(f".//{{{_NS['dc']}}}language", default="")) or None
    if title is not None and len(title) > 300:
        raise ValidationFailure("document_metadata_invalid")
    if language is not None and _LANGUAGE.fullmatch(language) is None:
        raise ValidationFailure("document_metadata_invalid")
    return title, language


def _inline_text(element: ElementTree.Element) -> str:
    parts: list[str] = [element.text or ""]
    for child in element:
        if child.tag == f"{_TEXT}s":
            try:
                count = int(child.get(f"{_TEXT}c", "1"))
            except ValueError as error:
                raise ValidationFailure("document_structure_invalid") from error
            if not 1 <= count <= 100:
                raise ValidationFailure("document_content_limit_exceeded")
            parts.append(" " * count)
        elif child.tag == f"{_TEXT}tab":
            parts.append("\t")
        elif child.tag == f"{_TEXT}line-break":
            parts.append("\n")
        elif child.tag == f"{_TEXT}soft-page-break":
            parts.append(_PAGE_MARKER)
        else:
            parts.append(_inline_text(child))
        parts.append(child.tail or "")
    return "".join(parts)


def _normalize_text(value: str) -> str:
    return " ".join(value.replace("\u00a0", " ").split())


def _table_rows(
    element: ElementTree.Element, *, header: bool = False
) -> list[tuple[ElementTree.Element, bool]]:
    rows: list[tuple[ElementTree.Element, bool]] = []
    for child in element:
        if child.tag == f"{_TABLE}table-row":
            rows.append((child, header))
        elif child.tag in {
            f"{_TABLE}table-header-rows",
            f"{_TABLE}table-rows",
            f"{_TABLE}table-row-group",
        }:
            rows.extend(
                _table_rows(child, header=header or child.tag == f"{_TABLE}table-header-rows")
            )
    return rows
