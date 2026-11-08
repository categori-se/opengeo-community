"""Closed tagged-ActualText profile; PDF syntax is parsed exclusively by pypdf.

Run in CommandRunner's resource-limited child. Uncovered PDF features fall back
without changing source bytes or claiming authority from the catalog tagged flag.
"""
import json
import logging
import signal
import sys
from pathlib import Path

_MAX_NODES = 8_000
_MAX_BYTES = 1_048_576
_MAX_TEXT = 200_000


class UnsupportedTags(ValueError):
    pass


def tagged_pages(source: Path, page_count: int) -> list[list[str]]:
    from pypdf import Configuration, PdfReader
    from pypdf.generic import (
        ArrayObject,
        ContentStream,
        DictionaryObject,
        IndirectObject,
        NumberObject,
        TextStringObject,
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
        or reader.trailer['/Size'] > 20_000 or object_count > 20_000
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
    page_indices = {page.indirect_reference.idnum: i for i, page in enumerate(pages)}
    found: list[dict[int, tuple[str, bool]]] = []
    total_bytes = 0
    for index, page in enumerate(pages):
        if '/Properties' in page.get('/Resources', {}) or '/XObject' in page.get('/Resources', {}):
            raise UnsupportedTags()
        key = page.get('/StructParents')
        if type(key) is not NumberObject or int(key) not in parents:
            raise UnsupportedTags()
        contents = page.get_contents()
        if contents is None:
            raise UnsupportedTags()
        data = contents.get_data()
        total_bytes += len(data)
        if total_bytes > _MAX_BYTES:
            raise UnsupportedTags()
        content = ContentStream(contents, reader)
        if len(content.operations) > 40_000:
            raise UnsupportedTags()
        spans: dict[int, tuple[str, bool]] = {}
        stack: list[int] = []
        for operands, operator in content.operations:
            if operator == b'BDC':
                if stack or len(operands) != 2 or not isinstance(operands[1], DictionaryObject):
                    raise UnsupportedTags()
                props = operands[1]
                mcid, text = props.get('/MCID'), props.get('/ActualText')
                if type(mcid) is not NumberObject or not 0 <= mcid < 2_000:
                    raise UnsupportedTags()
                if int(mcid) in spans or not isinstance(text, TextStringObject) or not text.strip():
                    raise UnsupportedTags()
                if '\x00' in text or len(text) > 8_000:
                    raise UnsupportedTags()
                stack.append(int(mcid))
                spans[int(mcid)] = (str(text), False)
            elif operator == b'EMC':
                if not stack:
                    raise UnsupportedTags()
                stack.pop()
            elif operator == b'BMC' or operator == b'Do':
                raise UnsupportedTags()
            elif operator in (b'Tj', b'TJ', b"'", b'"'):
                if not stack:
                    raise UnsupportedTags()
                spans[stack[-1]] = (spans[stack[-1]][0], True)
        if stack or not spans or any(not value[1] for value in spans.values()):
            raise UnsupportedTags()
        array = parents[int(key)]
        if not isinstance(array, ArrayObject) or len(array) != len(spans):
            raise UnsupportedTags()
        if set(spans) != set(range(len(array))):
            raise UnsupportedTags()
        found.append(spans)
    if set(parents) != {int(page['/StructParents']) for page in pages}:
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
        node = ref.get_object()
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
                parent_array = parents[int(pages[index]['/StructParents'])]
                if not same(parent_array[mcid], ref):
                    raise UnsupportedTags()
                text = found[index][mcid][0]
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
    try:
        value = {'pages': tagged_pages(Path(sys.argv[1]), int(sys.argv[2]))}
    except Exception:
        # The parent retains its existing heuristic extraction on any parser failure.
        value = {'pages': None}
    print(json.dumps(value, ensure_ascii=True, separators=(',', ':')))


if __name__ == '__main__':
    main()
