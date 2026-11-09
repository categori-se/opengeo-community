"""Closed tagged-ActualText profile; PDF syntax is parsed exclusively by pypdf.

Run in CommandRunner's resource-limited child. Uncovered PDF features fall back
without changing source bytes or claiming authority from the catalog tagged flag.
"""
import json
import logging
import signal
import sys
from pathlib import Path
from typing import Any, NoReturn, cast

_MAX_NODES = 8_000
_MAX_BYTES = 1_048_576
_MAX_TEXT = 200_000


class UnsupportedTags(ValueError):
    pass


def _marked_page_spans(reader: Any, page: Any, error_type: type[ValueError] = ValueError) -> dict[int, dict[str, Any]]:
    """Validate paint ownership; extract glyph text only inside source MCIDs."""
    from copy import copy
    from pypdf.generic import ArrayObject, ContentStream, DictionaryObject, NameObject, NumberObject

    spans: dict[int, dict[str, Any]] = {}
    operations = decoded = 0
    stack: list[int | None] = []
    path: set[int] = set()

    def resolve(value: Any) -> Any:
        return value.get_object() if hasattr(value, "get_object") else value

    def fail() -> NoReturn:
        raise error_type("tagged_pdf_paint_ownership")

    def scan(stream: Any, resources: Any, inherited: int | None = None, artifact: bool = False, depth: int = 0) -> Any:
        nonlocal operations, decoded
        if depth > 16:
            fail()
        decoded += len(stream.get_data())
        if decoded > 1_048_576:
            fail()
        resources = resolve(resources)
        content = ContentStream(stream, reader)
        local: list[int | None] = []
        for args, op in content.operations:
            operations += 1
            if operations > 40_000:
                fail()
            active = local[-1] if local else inherited
            decorative = bool(local and local[-1] is None) or (not local and artifact)
            if op in {b"BDC", b"BMC"}:
                if len(args) != (2 if op == b"BDC" else 1):
                    fail()
                props = args[1] if op == b"BDC" and len(args) == 2 else None
                if isinstance(props, NameObject):
                    props = resolve(resources.get("/Properties", {})).get(props)
                    props = props.get_object() if props is not None else None
                if str(args[0]) == "/Artifact":
                    if isinstance(props, DictionaryObject) and "/MCID" in props:
                        fail()
                    local.append(None)
                    continue
                if active is not None or decorative or not isinstance(props, DictionaryObject):
                    fail()
                mcid = props.get("/MCID")
                text = props.get("/ActualText")
                if (type(mcid) is not NumberObject or not 0 <= mcid < 2_000
                    or int(mcid) in spans or depth):
                    fail()
                if text is not None and (not isinstance(text, str) or not text.strip()
                    or len(text) > 8_000 or "\x00" in text):
                    fail()
                spans[int(mcid)] = {"text": str(text) if text is not None else None,
                                    "painted": False, "textPaint": False, "imagePaint": False,
                                    "actualText": text is not None}
                local.append(int(mcid))
            elif op == b"EMC":
                if not local:
                    fail()
                local.pop()
            elif op in {b"Tj", b"TJ", b"'", b'"'}:
                if len(args) != (3 if op == b'"' else 1):
                    fail()
                operand = args[-1]
                if op == b"TJ":
                    if not isinstance(operand, ArrayObject):
                        fail()
                    paints_text = any(isinstance(item, (str, bytes)) and len(item) for item in operand)
                else:
                    if not isinstance(operand, (str, bytes)):
                        fail()
                    paints_text = bool(operand)
                if paints_text:
                    if active is None and not decorative:
                        fail()
                    if active is not None:
                        spans[active]["painted"] = spans[active]["textPaint"] = True
            elif op == b"Do":
                if len(args) != 1:
                    fail()
                obj = resolve(resources.get("/XObject", {})).get(args[0])
                if obj is None:
                    fail()
                obj = obj.get_object()
                if obj.get("/Subtype") == "/Image":
                    if active is None and not decorative:
                        fail()
                    if active is not None:
                        spans[active]["painted"] = spans[active]["imagePaint"] = True
                elif obj.get("/Subtype") == "/Form":
                    identity = id(obj)
                    if identity in path or "/StructParents" in obj:
                        fail()
                    path.add(identity)
                    scan(obj, obj.get("/Resources", resources), active, decorative, depth + 1)
                    path.remove(identity)
                else:
                    fail()
        if local:
            fail()
        return content

    if page.get_contents() is None:
        return spans
    content = scan(page.get_contents(), page.get("/Resources", {}))
    if any(not span["painted"] for span in spans.values()):
        fail()
    if any(span["text"] is None and span["textPaint"] for span in spans.values()):
        # Flush extraction at marked-content boundaries. This temporary stream
        # never replaces source/print content, geometry or font resources.
        extraction = copy(page)
        projected = ContentStream(None, reader)
        projected.operations = []
        for args, op in content.operations:
            if op in {b"BDC", b"BMC", b"EMC"}:
                projected.operations.append(([], b"ET"))
            projected.operations.append((args, op))
            if op in {b"BDC", b"BMC", b"EMC"}:
                projected.operations.append(([], b"BT"))
        extraction[NameObject("/Contents")] = projected
        glyphs: dict[int, list[str]] = {mcid: [] for mcid in spans}

        def before(op: bytes, args: Any, *_: Any) -> None:
            if op in {b"BDC", b"BMC"}:
                props = args[1] if op == b"BDC" and len(args) == 2 else None
                if isinstance(props, NameObject):
                    props = resolve(resolve(page.get("/Resources", {})).get("/Properties", {})).get(props)
                    props = props.get_object() if props is not None else None
                stack.append(int(cast(Any, props["/MCID"])) if isinstance(props, DictionaryObject)
                             and "/MCID" in props else None)
            elif op == b"EMC":
                if not stack:
                    fail()
                stack.pop()

        def unicode_font(font: Any) -> bool:
            font = resolve(font)
            if not isinstance(font, DictionaryObject):
                return False
            if "/ToUnicode" in font:
                mapping = resolve(font["/ToUnicode"])
                if not hasattr(mapping, "get_data"):
                    return False
                data = mapping.get_data()
                return bool(data) and len(data) <= 1_048_576 and (
                    b"beginbfchar" in data or b"beginbfrange" in data
                )
            # Only the standard unembedded Roman Type1 fonts have a known
            # fallback encoding. Custom glyph programs and Differences require
            # an explicit ToUnicode mapping; a font name alone is insufficient.
            standard = {
                "/Courier", "/Courier-Bold", "/Courier-Oblique", "/Courier-BoldOblique",
                "/Helvetica", "/Helvetica-Bold", "/Helvetica-Oblique", "/Helvetica-BoldOblique",
                "/Times-Roman", "/Times-Bold", "/Times-Italic", "/Times-BoldItalic",
            }
            return (
                font.get("/Subtype") == "/Type1" and str(font.get("/BaseFont")) in standard
                and "/FontDescriptor" not in font
                and font.get("/Encoding") in (None, "/StandardEncoding", "/WinAnsiEncoding", "/MacRomanEncoding")
            )

        def text(value: str, _cm: Any, _tm: Any, font: Any, _size: Any) -> None:
            if value.strip() and stack and stack[-1] is not None:
                if not unicode_font(font) or "\x00" in value or "\ufffd" in value:
                    fail()
                glyphs[stack[-1]].append(value)

        extraction.extract_text(visitor_operand_before=before, visitor_text=text)
        for mcid, span in spans.items():
            if span["text"] is None and span["textPaint"]:
                value = "".join(glyphs[mcid]).strip()
                if not value or len(value) > 8_000:
                    fail()
                span["text"] = value
    return spans


def tagged_pages(source: Path, page_count: int, *, require_actual_text: bool = False, profile: dict[str, str] | None = None) -> list[list[str]]:
    from pypdf import Configuration, PdfReader
    from pypdf.generic import (
        ArrayObject,
        IndirectObject,
        NumberObject,
    )

    Configuration.zlib_maximum_output_length = _MAX_BYTES
    Configuration.lzw_maximum_output_length = _MAX_BYTES
    Configuration.run_length_maximum_output_length = _MAX_BYTES
    Configuration.array_based_stream_maximum_output_length = _MAX_BYTES
    Configuration.maximum_declared_stream_length = _MAX_BYTES
    Configuration.array_maximum_element_count = 20_000
    Configuration.dictionary_maximum_element_count = 20_000
    Configuration.page_tree_maximum_depth = 32
    Configuration.page_tree_maximum_page_entries = 20_000
    if source.stat().st_size > 32 * 1024 * 1024 or not 1 <= page_count <= 200:
        raise UnsupportedTags()
    reader = PdfReader(source, strict=True, xref_stream_maximum_entries=20_000)
    object_count = sum(len(entries) for entries in reader.xref.values()) + len(reader.xref_objStm)
    if (
        reader.is_encrypted or len(reader.pages) != page_count
        or cast(Any, reader.trailer['/Size']) > 20_000 or object_count > 20_000
    ):
        raise UnsupportedTags()
    root_ref = reader.root_object.raw_get('/StructTreeRoot')
    root = root_ref.get_object()
    if root.get('/Type') != '/StructTreeRoot':
        raise UnsupportedTags()
    # Closed flat number-tree profile. Nested /Kids and form XObjects are unsupported.
    parent_tree = root['/ParentTree']
    if '/Kids' in parent_tree or not isinstance(parent_tree.get('/Nums'), ArrayObject):
        raise UnsupportedTags()
    nums = parent_tree['/Nums']
    if len(nums) > 400 or len(nums) % 2:
        raise UnsupportedTags()
    parents: dict[int, ArrayObject] = {}
    for i in range(0, len(nums), 2):
        key = nums[i]
        if type(key) is not NumberObject or int(key) in parents:
            raise UnsupportedTags()
        array = nums[i + 1].get_object()
        if not isinstance(array, ArrayObject):
            raise UnsupportedTags()
        parents[int(key)] = array
    pages = list(reader.pages)
    page_indices = {cast(Any, page.indirect_reference).idnum: i for i, page in enumerate(pages)}
    found: list[dict[int, dict[str, Any]]] = []
    total_bytes = 0
    for index, page in enumerate(pages):
        key = page.get('/StructParents')
        if type(key) is not NumberObject or int(key) not in parents:
            raise UnsupportedTags()
        spans = _marked_page_spans(reader, page, UnsupportedTags)
        if profile is not None and any(span['textPaint'] and not span['actualText'] for span in spans.values()):
            profile['source_tags'] = 'validated-mcid-text'
        if require_actual_text and any(span['textPaint'] and not span['actualText']
                                       for span in spans.values()):
            raise UnsupportedTags()
        array = parents[int(key)]
        if not isinstance(array, ArrayObject) or len(array) != len(spans):
            raise UnsupportedTags()
        if set(spans) != set(range(len(array))):
            raise UnsupportedTags()
        found.append(spans)
    if set(parents) != {int(cast(Any, page['/StructParents'])) for page in pages}:
        raise UnsupportedTags()
    output: list[list[str]] = [[] for _ in pages]
    visited = set()
    used = set()
    count = 0
    characters = 0
    last_page = 0

    def same(left: object, right: object) -> bool:
        return (
            isinstance(left, IndirectObject) and isinstance(right, IndirectObject)
            and left == right
        )

    def walk(
        ref: object, parent: object, inherited_page: object = None, depth: int = 0
    ) -> None:
        nonlocal count, characters, last_page
        count += 1
        if count > _MAX_NODES or depth > 32 or not isinstance(ref, IndirectObject):
            raise UnsupportedTags()
        identity = (ref.idnum, ref.generation)
        if identity in visited:
            raise UnsupportedTags()
        visited.add(identity)
        node: Any = ref.get_object()
        if node.get('/Type') != '/StructElem' or not same(node.raw_get('/P'), parent):
            raise UnsupportedTags()
        page_ref = node.raw_get('/Pg') if '/Pg' in node else inherited_page
        children = node.raw_get('/K')
        children = children if isinstance(children, ArrayObject) else [children]
        for child in children:
            if type(child) is NumberObject:
                if not isinstance(page_ref, IndirectObject) or page_ref.idnum not in page_indices:
                    raise UnsupportedTags()
                index = page_indices[page_ref.idnum]
                if not same(page_ref, pages[index].indirect_reference) or index < last_page:
                    raise UnsupportedTags()
                last_page = index
                mcid = int(child)
                if (index, mcid) in used or mcid not in found[index]:
                    raise UnsupportedTags()
                parent_array = parents[int(cast(Any, pages[index]['/StructParents']))]
                if not same(parent_array[mcid], ref):
                    raise UnsupportedTags()
                span = found[index][mcid]
                text = span['text']
                if text is None and span['imagePaint']:
                    text = node.get('/Alt')
                    if node.get('/S') != '/Figure':
                        raise UnsupportedTags()
                if not isinstance(text, str) or not text.strip() or len(text) > 8_000:
                    raise UnsupportedTags()
                characters += len(text)
                if characters > _MAX_TEXT:
                    raise UnsupportedTags()
                used.add((index, mcid))
                output[index].append(text)
            else:
                walk(child, ref, page_ref, depth + 1)

    children = root.raw_get('/K')
    children = children if isinstance(children, ArrayObject) else [children]
    for child in children:
        walk(child, root_ref)
    if len(used) != sum(len(page) for page in found):
        raise UnsupportedTags()
    return output


def main() -> None:
    logging.disable(logging.CRITICAL)
    signal.alarm(10)
    unavailable = {'pages': None, 'mode': None, 'sourceTags': None}
    try:
        profile = {'source_tags': 'closed-actualtext'}
        pages = tagged_pages(Path(sys.argv[1]), int(sys.argv[2]), profile=profile)
        source_tags = profile['source_tags']
        mode = {
            'closed-actualtext': 'tagged-actualtext',
            'validated-mcid-text': 'tagged-mcid-text',
        }[source_tags]
        value: dict[str, Any] = {'pages': pages, 'mode': mode, 'sourceTags': source_tags}
    except Exception:
        # A failed or unsupported parse supplies no authoritative provenance.
        value = unavailable
    encoded = json.dumps(value, ensure_ascii=True, separators=(',', ':'))
    if len(encoded) + 1 > _MAX_BYTES:
        encoded = json.dumps(unavailable, separators=(',', ':'))
    print(encoded)



if __name__ == '__main__':
    main()
