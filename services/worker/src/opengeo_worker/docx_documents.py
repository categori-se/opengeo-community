"""Bounded, inactive DOCX packages and their semantic main-document preview.

This accepts a closed WordprocessingML subset, not every OOXML package. Native
layout conversion receives a separately sanitized copy; source bytes stay intact.
"""

import json
import posixpath
import re
import stat
import zipfile
import zlib
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit
from xml.etree import ElementTree

from opengeo_worker.models import ArtifactFile, InspectionResult, ValidationFailure
from opengeo_worker.odf_documents import (
    _LANGUAGE,
    _MAX_BLOCKS,
    _MAX_CELL_CHARACTERS,
    _MAX_COMPRESSION_RATIO,
    _MAX_ENTRY_BYTES,
    _MAX_EXPANDED_BYTES,
    _MAX_LIST_ITEMS,
    _MAX_PAGES,
    _MAX_PREVIEW_BYTES,
    _MAX_SOURCE_BYTES,
    _MAX_TABLE_CELLS,
    _MAX_TABLE_COLUMNS,
    _MAX_TABLE_ROWS,
    _MAX_TEXT_CHARACTERS,
    _MAX_XML_BYTES,
    _normalize_text,
)

DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PREVIEW_SCHEMA = "opengeo.document-preview.4.0.0"
PREVIEW_CONTENT_TYPE = "application/json"
WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
_W = f"{{{WORD_NS}}}"
_R = f"{{{REL_NS}}}"
_REL = f"{{{PACKAGE_REL_NS}}}"
_CT = f"{{{CONTENT_NS}}}"
_WP_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml."
_REL_TYPE = "application/vnd.openxmlformats-package.relationships+xml"
_CORE_TYPE = "application/vnd.openxmlformats-package.core-properties+xml"
_PAGE_MARKER = "\u0000OPEN_GEO_PAGE_BREAK\u0000"
_DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
_XML_NAMESPACES = {
    WORD_NS,
    REL_NS,
    PACKAGE_REL_NS,
    CONTENT_NS,
    _DRAWING_NS,
    "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "http://schemas.openxmlformats.org/drawingml/2006/picture",
    "http://schemas.openxmlformats.org/drawingml/2006/theme",
    "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
    "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties",
    "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes",
    "http://purl.org/dc/elements/1.1/",
    "http://purl.org/dc/terms/",
    "http://www.w3.org/2001/XMLSchema-instance",
    "http://schemas.openxmlformats.org/markup-compatibility/2006",
}
_FORBIDDEN_ELEMENTS = {
    "altChunk",
    "object",
    "OLEObject",
    "control",
    "subDoc",
    "attachedTemplate",
    "saveThroughXslt",
    "dataBinding",
    "instrText",
    "fldSimple",
    "fldChar",
    "mailMerge",
    "sdt",
    "customXml",
    "movie",
    "contentPart",
    "AlternateContent",
}
_PART_TYPES = {
    "word/document.xml": _WP_TYPE + "document.main+xml",
    "word/styles.xml": _WP_TYPE + "styles+xml",
    "word/numbering.xml": _WP_TYPE + "numbering+xml",
    "word/settings.xml": _WP_TYPE + "settings+xml",
    "word/fontTable.xml": _WP_TYPE + "fontTable+xml",
    "word/webSettings.xml": _WP_TYPE + "webSettings+xml",
    "word/footnotes.xml": _WP_TYPE + "footnotes+xml",
    "word/endnotes.xml": _WP_TYPE + "endnotes+xml",
    "docProps/core.xml": _CORE_TYPE,
    "docProps/app.xml": "application/vnd.openxmlformats-officedocument.extended-properties+xml",
}
_REL_PART_TYPES = {
    REL_NS + "/officeDocument": {_WP_TYPE + "document.main+xml"},
    REL_NS + "/styles": {_WP_TYPE + "styles+xml"},
    REL_NS + "/numbering": {_WP_TYPE + "numbering+xml"},
    REL_NS + "/settings": {_WP_TYPE + "settings+xml"},
    REL_NS + "/fontTable": {_WP_TYPE + "fontTable+xml"},
    REL_NS + "/webSettings": {_WP_TYPE + "webSettings+xml"},
    REL_NS + "/theme": {"application/vnd.openxmlformats-officedocument.theme+xml"},
    REL_NS + "/header": {_WP_TYPE + "header+xml"},
    REL_NS + "/footer": {_WP_TYPE + "footer+xml"},
    REL_NS + "/footnotes": {_WP_TYPE + "footnotes+xml"},
    REL_NS + "/endnotes": {_WP_TYPE + "endnotes+xml"},
    REL_NS + "/image": {"image/png", "image/jpeg"},
    PACKAGE_REL_NS + "/metadata/core-properties": {_CORE_TYPE},
    REL_NS + "/extended-properties": {
        "application/vnd.openxmlformats-officedocument.extended-properties+xml"
    },
}
HYPERLINK_RELATIONSHIP = REL_NS + "/hyperlink"


@dataclass(frozen=True, slots=True)
class _Relationship:
    kind: str
    target: str
    external: bool


@dataclass(frozen=True, slots=True)
class _Package:
    files: dict[str, bytes]
    roots: dict[str, ElementTree.Element]
    relationships: dict[str, dict[str, _Relationship]]
    embedded_media_count: int


def _safe_part_name(name: str) -> bool:
    return (
        1 <= len(name) <= 240
        and not name.startswith("/")
        and not any(character in name for character in "\\:%?#")
        and all(ord(character) >= 32 for character in name)
        and all(part not in {"", ".", ".."} for part in name.split("/"))
    )


def _part_type(name: str) -> str | None:
    if name in _PART_TYPES:
        return _PART_TYPES[name]
    if name == "_rels/.rels" or re.fullmatch(r"word/_rels/[A-Za-z0-9]+\.xml\.rels", name):
        return _REL_TYPE
    if re.fullmatch(r"word/theme/theme[0-9]+\.xml", name):
        return "application/vnd.openxmlformats-officedocument.theme+xml"
    if re.fullmatch(r"word/(?:header|footer)[0-9]+\.xml", name):
        return _WP_TYPE + ("header+xml" if "/header" in name else "footer+xml")
    if name.startswith("word/media/") and name.count("/") == 2:
        return {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}.get(
            PurePosixPath(name).suffix.lower()
        )
    return None


def _parse_xml(body: bytes) -> ElementTree.Element:
    # NUL removal also recognizes declarations in UTF-16/32 XML before Expat
    # can expand an internal entity. No native parser sees unvalidated XML.
    declarations = body.replace(b"\x00", b"").upper()
    if (
        b"<!DOCTYPE" in declarations
        or b"<!ENTITY" in declarations
        or re.search(rb"<\?(?!XML(?:\s|\?>))", declarations)
    ):
        raise ValidationFailure("document_active_content_blocked")
    try:
        root = ElementTree.fromstring(body)
    except (ElementTree.ParseError, ValueError) as error:
        raise ValidationFailure("document_structure_invalid") from error
    pending = [(root, 0)]
    count = 0
    while pending:
        element, depth = pending.pop()
        count += 1
        if depth > 64 or count > 100_000:
            raise ValidationFailure("document_content_limit_exceeded")
        pending.extend((child, depth + 1) for child in element)
        namespace, _, local = (
            element.tag[1:].partition("}") if element.tag.startswith("{") else ("", "", element.tag)
        )
        if namespace not in _XML_NAMESPACES or local in _FORBIDDEN_ELEMENTS:
            raise ValidationFailure("document_active_content_blocked")
        for attribute in element.attrib:
            if attribute.startswith("{"):
                uri = attribute[1:].partition("}")[0]
                if uri not in _XML_NAMESPACES | {"http://www.w3.org/XML/1998/namespace"}:
                    raise ValidationFailure("document_active_content_blocked")
    return root


def _content_types(root: ElementTree.Element, files: set[str]) -> dict[str, str]:
    if root.tag != f"{_CT}Types" or root.attrib:
        raise ValidationFailure("document_archive_invalid")
    defaults: dict[str, str] = {}
    overrides: dict[str, str] = {}
    allowed_defaults = {
        "rels": _REL_TYPE,
        "xml": "application/xml",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
    }
    for element in root:
        if len(element) or (element.text or "").strip():
            raise ValidationFailure("document_archive_invalid")
        if element.tag == f"{_CT}Default" and set(element.attrib) == {"Extension", "ContentType"}:
            extension, media = element.get("Extension", ""), element.get("ContentType", "")
            if extension in defaults or allowed_defaults.get(extension) != media:
                raise ValidationFailure("document_active_content_blocked")
            defaults[extension] = media
        elif element.tag == f"{_CT}Override" and set(element.attrib) == {"PartName", "ContentType"}:
            part, media = element.get("PartName", ""), element.get("ContentType", "")
            if not part.startswith("/") or part[1:] not in files or part in overrides:
                raise ValidationFailure("document_archive_invalid")
            if _part_type(part[1:]) != media:
                raise ValidationFailure("document_active_content_blocked")
            overrides[part] = media
        else:
            raise ValidationFailure("document_archive_invalid")
    result: dict[str, str] = {}
    for name in files - {"[Content_Types].xml"}:
        extension = "rels" if name.endswith(".rels") else PurePosixPath(name).suffix[1:]
        media = overrides.get("/" + name, defaults.get(extension, ""))
        if not media or media != _part_type(name):
            raise ValidationFailure("document_archive_invalid")
        result[name] = media
    return result


def _relationship_owner(name: str) -> str:
    if name == "_rels/.rels":
        return ""
    return "word/" + name.removeprefix("word/_rels/").removesuffix(".rels")


def _relationships(
    name: str, root: ElementTree.Element, types: dict[str, str]
) -> dict[str, _Relationship]:
    if root.tag != f"{_REL}Relationships" or root.attrib:
        raise ValidationFailure("document_archive_invalid")
    owner = _relationship_owner(name)
    if owner and owner not in types:
        raise ValidationFailure("document_archive_invalid")
    result: dict[str, _Relationship] = {}
    for element in root:
        identifier = element.get("Id", "")
        kind, target = element.get("Type", ""), element.get("Target", "")
        mode = element.get("TargetMode", "Internal")
        if (
            element.tag != f"{_REL}Relationship"
            or len(element)
            or (element.text or "").strip()
            or set(element.attrib) - {"Id", "Type", "Target", "TargetMode"}
            or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,199}", identifier)
            or identifier in result
            or not 1 <= len(target) <= 2_048
            or any(ord(character) < 32 for character in target)
            or mode not in {"Internal", "External"}
        ):
            raise ValidationFailure("document_archive_invalid")
        if mode == "External":
            try:
                parsed = urlsplit(target)
                safe = (
                    kind == HYPERLINK_RELATIONSHIP
                    and parsed.scheme == "https"
                    and bool(parsed.hostname)
                    and parsed.username is None
                    and parsed.password is None
                    and parsed.port in {None, 443}
                )
            except ValueError:
                safe = False
            if not safe:
                raise ValidationFailure("document_active_content_blocked")
        else:
            if any(character in target for character in "\\:%?#"):
                raise ValidationFailure("document_active_content_blocked")
            target = posixpath.normpath(
                target[1:]
                if target.startswith("/")
                else posixpath.join(posixpath.dirname(owner), target)
            )
            if not _safe_part_name(target) or types.get(target) not in _REL_PART_TYPES.get(
                kind, set()
            ):
                raise ValidationFailure("document_active_content_blocked")
        result[identifier] = _Relationship(kind, target, mode == "External")
    return result


def _read_package(
    source: Path,
    *,
    maximum_entries: int = 256,
    maximum_expanded_bytes: int = _MAX_EXPANDED_BYTES,
    maximum_ratio: int = _MAX_COMPRESSION_RATIO,
) -> _Package:
    if not 1 <= source.stat().st_size <= _MAX_SOURCE_BYTES:
        raise ValidationFailure("document_source_too_large")
    files: dict[str, bytes] = {}
    names: set[str] = set()
    expanded = 0
    try:
        with zipfile.ZipFile(source) as archive:
            infos = archive.infolist()
            if not 3 <= len(infos) <= min(maximum_entries, 256):
                raise ValidationFailure("document_archive_invalid")
            for info in infos:
                name = info.filename.rstrip("/") if info.is_dir() else info.filename
                mode = info.external_attr >> 16
                if (
                    info.orig_filename != info.filename
                    or not _safe_part_name(name)
                    or name.casefold() in names
                    or info.flag_bits & 1
                    or (mode and stat.S_ISLNK(mode))
                    or info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
                ):
                    raise ValidationFailure("document_archive_invalid")
                names.add(name.casefold())
                if info.is_dir():
                    continue
                if name != "[Content_Types].xml" and _part_type(name) is None:
                    raise ValidationFailure("document_active_content_blocked")
                expanded += info.file_size
                limit = _MAX_XML_BYTES if name.endswith((".xml", ".rels")) else _MAX_ENTRY_BYTES
                if (
                    not 0 <= info.file_size <= limit
                    or expanded > min(maximum_expanded_bytes, _MAX_EXPANDED_BYTES)
                    or info.file_size / max(1, info.compress_size) > min(maximum_ratio, 100)
                ):
                    raise ValidationFailure("document_content_limit_exceeded")
                body = archive.read(info)
                if len(body) != info.file_size:
                    raise ValidationFailure("document_archive_invalid")
                files[name] = body
    except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile, RuntimeError, zlib.error) as error:
        if isinstance(error, ValidationFailure):
            raise
        raise ValidationFailure("document_archive_invalid") from error
    if not {"[Content_Types].xml", "_rels/.rels", "word/document.xml"} <= files.keys():
        raise ValidationFailure("document_archive_invalid")
    roots = {
        name: _parse_xml(body) for name, body in files.items() if name.endswith((".xml", ".rels"))
    }
    types = _content_types(roots["[Content_Types].xml"], set(files))
    expected_roots = {
        "word/document.xml": f"{_W}document",
        "word/styles.xml": f"{_W}styles",
        "word/numbering.xml": f"{_W}numbering",
        "word/settings.xml": f"{_W}settings",
        "word/fontTable.xml": f"{_W}fonts",
        "word/webSettings.xml": f"{_W}webSettings",
        "word/footnotes.xml": f"{_W}footnotes",
        "word/endnotes.xml": f"{_W}endnotes",
        "docProps/core.xml": (
            "{http://schemas.openxmlformats.org/package/2006/metadata/core-properties}"
            "coreProperties"
        ),
        "docProps/app.xml": (
            "{http://schemas.openxmlformats.org/officeDocument/2006/extended-properties}Properties"
        ),
    }
    for name, root in roots.items():
        expected = expected_roots.get(name)
        if re.fullmatch(r"word/(?:header|footer)[0-9]+\.xml", name):
            expected = f"{_W}hdr" if "/header" in name else f"{_W}ftr"
        elif name.startswith("word/theme/"):
            expected = f"{{{_DRAWING_NS}}}theme"
        if expected is not None and root.tag != expected:
            raise ValidationFailure("document_structure_invalid")
    relationships = {
        _relationship_owner(name): _relationships(name, root, types)
        for name, root in roots.items()
        if name.endswith(".rels")
    }
    main = [
        relation
        for relation in relationships[""].values()
        if relation.kind == REL_NS + "/officeDocument"
    ]
    if len(main) != 1 or main[0].target != "word/document.xml" or main[0].external:
        raise ValidationFailure("document_archive_invalid")
    for name, root in roots.items():
        if name.endswith(".rels") or name == "[Content_Types].xml":
            continue
        for element in root.iter():
            for key, value in element.attrib.items():
                if key.startswith(_R) and value not in relationships.get(name, {}):
                    raise ValidationFailure("document_archive_invalid")
    if roots["word/document.xml"].tag != f"{_W}document":
        raise ValidationFailure("document_structure_invalid")
    return _Package(
        files, roots, relationships, sum(name.startswith("word/media/") for name in files)
    )


def _on(element: ElementTree.Element | None) -> bool:
    return element is not None and element.get(f"{_W}val", "true") not in {"0", "false", "off"}


def _inline_text(element: ElementTree.Element) -> str:
    if element.tag == f"{_W}t":
        return element.text or ""
    if element.tag == f"{_W}tab":
        return "\t"
    if element.tag == f"{_W}br":
        return _PAGE_MARKER if element.get(f"{_W}type") == "page" else "\n"
    if element.tag == f"{_W}lastRenderedPageBreak":
        return _PAGE_MARKER
    if element.tag == f"{_W}cr":
        return "\n"
    if element.tag in {f"{_W}del", f"{_W}drawing", f"{_W}pPr", f"{_W}rPr"}:
        return ""
    text = "".join(_inline_text(child) for child in element)
    return text + "\n" if element.tag == f"{_W}p" else text


class _PreviewBuilder:
    def __init__(self, roots: dict[str, ElementTree.Element]) -> None:
        self.pages: list[list[dict[str, object]]] = [[]]
        self.block_count = 0
        self.text_characters = 0
        self.table_cells = 0
        self.styles: dict[str, ElementTree.Element] = {}
        for style in roots.get("word/styles.xml", ElementTree.Element("empty")):
            identifier = style.get(f"{_W}styleId")
            if identifier:
                if identifier in self.styles:
                    raise ValidationFailure("document_structure_invalid")
                self.styles[identifier] = style
        self.numbering: dict[tuple[str, str], bool] = {}
        numbering = roots.get("word/numbering.xml", ElementTree.Element("empty"))
        abstracts: dict[str, ElementTree.Element] = {}
        for element in numbering.findall(f"{_W}abstractNum"):
            identifier = element.get(f"{_W}abstractNumId")
            if identifier is None or identifier in abstracts:
                raise ValidationFailure("document_structure_invalid")
            abstracts[identifier] = element
        num_ids: set[str] = set()
        for num in numbering.findall(f"{_W}num"):
            identifier = num.get(f"{_W}numId")
            if (
                identifier is None
                or identifier in num_ids
                or num.find(f"{_W}lvlOverride") is not None
            ):
                raise ValidationFailure("document_structure_invalid")
            num_ids.add(identifier)
            abstract_id = num.find(f"{_W}abstractNumId")
            abstract = (
                abstracts.get(abstract_id.get(f"{_W}val", "")) if abstract_id is not None else None
            )
            if abstract is None:
                raise ValidationFailure("document_structure_invalid")
            for level in abstract.findall(f"{_W}lvl"):
                fmt = level.find(f"{_W}numFmt")
                if fmt is None:
                    raise ValidationFailure("document_structure_invalid")
                key = (identifier, level.get(f"{_W}ilvl", "0"))
                if key in self.numbering:
                    raise ValidationFailure("document_structure_invalid")
                self.numbering[key] = fmt.get(f"{_W}val") != "bullet"
        self.last_list: tuple[str, str] | None = None

    def _add(self, block: dict[str, object], characters: int) -> None:
        self.block_count += 1
        self.text_characters += characters
        if self.block_count > _MAX_BLOCKS or self.text_characters > _MAX_TEXT_CHARACTERS:
            raise ValidationFailure("document_content_limit_exceeded")
        self.pages[-1].append(block)

    def _new_page(self) -> None:
        self.last_list = None
        if not self.pages[-1]:
            return
        if len(self.pages) >= _MAX_PAGES:
            raise ValidationFailure("document_content_limit_exceeded")
        self.pages.append([])

    def _properties(self, paragraph: ElementTree.Element) -> list[ElementTree.Element]:
        direct = paragraph.find(f"{_W}pPr")
        properties = [] if direct is None else [direct]
        style = direct.find(f"{_W}pStyle") if direct is not None else None
        identifier = style.get(f"{_W}val") if style is not None else None
        seen: set[str] = set()
        while identifier:
            if identifier in seen or len(seen) >= 32:
                raise ValidationFailure("document_structure_invalid")
            seen.add(identifier)
            definition = self.styles.get(identifier)
            if definition is None:
                break
            ppr = definition.find(f"{_W}pPr")
            if ppr is not None:
                properties.append(ppr)
            parent = definition.find(f"{_W}basedOn")
            identifier = parent.get(f"{_W}val") if parent is not None else None
        return properties

    def _property(
        self, properties: list[ElementTree.Element], path: str
    ) -> ElementTree.Element | None:
        return next((found for prop in properties if (found := prop.find(path)) is not None), None)

    def _paragraph(self, paragraph: ElementTree.Element) -> None:
        properties = self._properties(paragraph)
        if _on(self._property(properties, f"{_W}pageBreakBefore")):
            self._new_page()
        outline = self._property(properties, f"{_W}outlineLvl")
        level = None
        if outline is not None:
            try:
                level = int(outline.get(f"{_W}val", "")) + 1
            except ValueError as error:
                raise ValidationFailure("document_structure_invalid") from error
            if not 1 <= level <= 10:
                raise ValidationFailure("document_structure_invalid")
            if level == 10:
                level = None
        num = self._property(properties, f"{_W}numPr/{_W}numId")
        depth = self._property(properties, f"{_W}numPr/{_W}ilvl")
        list_key = (
            (num.get(f"{_W}val", ""), depth.get(f"{_W}val", "0") if depth is not None else "0")
            if num is not None and num.get(f"{_W}val") != "0"
            else None
        )
        if list_key is not None and list_key not in self.numbering:
            raise ValidationFailure("document_structure_invalid")
        for index, segment in enumerate(_inline_text(paragraph).split(_PAGE_MARKER)):
            if index:
                self._new_page()
            text = _normalize_text(segment)
            if not text:
                continue
            if len(text) > (1_000 if list_key is not None and level is None else 8_000):
                raise ValidationFailure("document_content_limit_exceeded")
            if list_key is not None and level is None:
                if self.last_list != list_key:
                    self._add({"type": "list", "ordered": self.numbering[list_key], "items": []}, 0)
                block = self.pages[-1][-1]
                items = block["items"]
                if not isinstance(items, list):
                    raise ValidationFailure("document_structure_invalid")
                items.append(text)
                self.text_characters += len(text)
                if len(items) > _MAX_LIST_ITEMS or self.text_characters > _MAX_TEXT_CHARACTERS:
                    raise ValidationFailure("document_content_limit_exceeded")
                self.last_list = list_key
            else:
                self.last_list = None
                block = {"type": "paragraph" if level is None else "heading", "text": text}
                if level is not None:
                    block["level"] = level
                self._add(block, len(text))
        section = paragraph.find(f"{_W}pPr/{_W}sectPr")
        if section is not None:
            kind = section.find(f"{_W}type")
            if kind is None or kind.get(f"{_W}val") != "continuous":
                self._new_page()

    def _table(self, table: ElementTree.Element) -> None:
        self.last_list = None
        rows: list[list[str]] = []
        headers = 0
        for row in table.findall(f"{_W}tr"):
            cells = [
                _normalize_text(_inline_text(cell).replace(_PAGE_MARKER, " "))
                for cell in row.findall(f"{_W}tc")
            ]
            if len(cells) > _MAX_TABLE_COLUMNS or any(
                len(cell) > _MAX_CELL_CHARACTERS for cell in cells
            ):
                raise ValidationFailure("document_content_limit_exceeded")
            if cells:
                if len(rows) == headers and _on(row.find(f"{_W}trPr/{_W}tblHeader")):
                    headers += 1
                rows.append(cells)
            if len(rows) > _MAX_TABLE_ROWS:
                raise ValidationFailure("document_content_limit_exceeded")
        if not rows:
            return
        width = max(len(row) for row in rows)
        rows = [row + [""] * (width - len(row)) for row in rows]
        self.table_cells += width * len(rows)
        if self.table_cells > _MAX_TABLE_CELLS:
            raise ValidationFailure("document_content_limit_exceeded")
        self._add(
            {"type": "table", "headerRows": headers, "rows": rows},
            sum(len(cell) for row in rows for cell in row),
        )
        if _PAGE_MARKER in _inline_text(table):
            self._new_page()

    def render(self, root: ElementTree.Element) -> None:
        body = root.find(f"{_W}body")
        if body is None:
            raise ValidationFailure("document_structure_invalid")
        for element in body:
            if element.tag == f"{_W}p":
                self._paragraph(element)
            elif element.tag == f"{_W}tbl":
                self._table(element)
            elif element.tag != f"{_W}sectPr":
                raise ValidationFailure("document_structure_invalid")
        while len(self.pages) > 1 and not self.pages[-1]:
            self.pages.pop()
        if not any(self.pages):
            raise ValidationFailure("document_structure_invalid")


def inspect_docx(
    source: Path,
    workdir: Path,
    *,
    maximum_entries: int,
    maximum_expanded_bytes: int,
    maximum_ratio: int,
) -> InspectionResult:
    package = _read_package(
        source,
        maximum_entries=maximum_entries,
        maximum_expanded_bytes=maximum_expanded_bytes,
        maximum_ratio=maximum_ratio,
    )
    builder = _PreviewBuilder(package.roots)
    builder.render(package.roots["word/document.xml"])
    core = package.roots.get("docProps/core.xml", ElementTree.Element("empty"))
    title = _normalize_text(core.findtext("{http://purl.org/dc/elements/1.1/}title", "")) or None
    language = (
        _normalize_text(core.findtext("{http://purl.org/dc/elements/1.1/}language", "")) or None
    )
    if (title is not None and len(title) > 300) or (
        language is not None and not _LANGUAGE.fullmatch(language)
    ):
        raise ValidationFailure("document_metadata_invalid")
    preview = {
        "schemaVersion": PREVIEW_SCHEMA,
        "sourceFormat": "docx",
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
                "kind": "ooxml_text",
                "source_format": "docx",
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
                {"code": "opc_content_types_and_relationships_verified", "status": "passed"},
                {"code": "encrypted_active_and_embedded_content_absent", "status": "passed"},
                {"code": "bounded_semantic_text_extraction", "status": "passed"},
                {"code": "accessible_preview_generated", "status": "passed"},
            ],
            "warnings": [
                {"code": "semantic_preview_does_not_claim_page_layout_fidelity"},
                {"code": "embedded_media_not_included_in_semantic_preview"},
                {"code": "docx_auxiliary_stories_not_included_in_semantic_preview"},
            ],
        },
        artifacts=(
            ArtifactFile(
                "derived", "document/accessible-preview.json", PREVIEW_CONTENT_TYPE, target
            ),
        ),
    )
