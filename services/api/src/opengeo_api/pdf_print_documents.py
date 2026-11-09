"""Bounded, page-only composition of sealed worker-prepared PDF documents.

Call these synchronous helpers through the route's existing thread boundary. The
PDF parser runs in an isolated, resource-limited child, never in the API process.
"""

from __future__ import annotations

import importlib.util
import json
import math
import os
import subprocess
import sys
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, NoReturn, TypedDict, cast
from uuid import UUID

MAX_DOCUMENT_BYTES = 4 * 1024 * 1024
MAX_TOTAL_BYTES = 16 * 1024 * 1024
MAX_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_PAGES = 200
CHILD_TIMEOUT_SECONDS = 15


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
                                    "painted": False, "textPaint": False, "imagePaint": False}
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


class VectorPagePlacement(TypedDict):
    targetPageIndex: int
    objectID: str
    sourcePageIndex: int


class PdfPrintDocumentError(ValueError):
    """A document is unsafe, unsupported, malformed or exceeds the print budget."""


def _documents[DocumentID: UUID | str](documents: Mapping[DocumentID, bytes]) -> dict[str, bytes]:
    result: dict[str, bytes] = {}
    total = 0
    for identity, data in documents.items():
        key = str(UUID(str(identity)))
        if key in result or not isinstance(data, bytes) or not 0 < len(data) <= MAX_DOCUMENT_BYTES:
            raise PdfPrintDocumentError("pdf_print_document_limit")
        total += len(data)
        if total > MAX_TOTAL_BYTES or len(result) >= MAX_PAGES:
            raise PdfPrintDocumentError("pdf_print_document_limit")
        result[key] = data
    return result


def _run(
    documents: dict[str, bytes], base: bytes | None, placements: list[dict[str, Any]]
) -> bytes:
    # Discover the installed dependency without importing its parser in the host.
    spec = importlib.util.find_spec("pypdf")
    if spec is None or not spec.submodule_search_locations:
        raise PdfPrintDocumentError("pdf_print_dependency_unavailable")
    dependency_path = str(Path(next(iter(spec.submodule_search_locations))).parent)
    with tempfile.TemporaryDirectory(prefix="opengeo-pdf-print-") as directory:
        temporary = Path(directory)
        entries = []
        for index, (identity, data) in enumerate(sorted(documents.items())):
            filename = f"document-{index}.pdf"
            (temporary / filename).write_bytes(data)
            entries.append({"id": identity, "file": filename})
        (temporary / "request.json").write_text(
            json.dumps(
                {"documents": entries, "compose": base is not None, "placements": placements}
            ),
            encoding="utf-8",
        )
        if base is not None:
            (temporary / "base.pdf").write_bytes(base)
        try:
            # No pipes: even malformed-PDF diagnostics cannot accumulate in RAM.
            child = subprocess.run(
                [
                    sys.executable,
                    "-I",
                    str(Path(__file__).resolve()),
                    "--child",
                    directory,
                    dependency_path,
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                cwd=directory,
                env={"PATH": os.defpath, "LANG": "C.UTF-8"},
                timeout=CHILD_TIMEOUT_SECONDS,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise PdfPrintDocumentError("pdf_print_child_failed") from error
        output = temporary / "result"
        if child.returncode != 0 or not output.is_file():
            raise PdfPrintDocumentError("pdf_print_document_rejected")
        if not 0 < output.stat().st_size <= MAX_OUTPUT_BYTES:
            raise PdfPrintDocumentError("pdf_print_output_limit")
        return output.read_bytes()


def describe_vector_documents[DocumentID: UUID | str](
    documents: Mapping[DocumentID, bytes],
) -> dict[str, list[dict[str, Any]]]:
    """Return display dimensions and original page geometry keyed by object UUID."""
    prepared = _documents(documents)
    if not prepared:
        return {}
    return dict(json.loads(_run(prepared, None, [])))


def compose_vector_pages[DocumentID: UUID | str](
    base_generated_pdf: bytes,
    documents: Mapping[DocumentID, bytes],
    placements: Sequence[VectorPagePlacement],
) -> bytes:
    """Replace empty authored placeholders, retaining the base page identities.

    Imported closed-profile source tags retain their authoritative page order.
    Existing generated StructTreeRoot,
    ParentTree and MCID references are cloned together with their original pages.
    Source document bytes are never modified.
    """
    prepared = _documents(documents)
    if not prepared:
        if placements:
            raise PdfPrintDocumentError("pdf_print_invalid_placement")
        return base_generated_pdf
    if (
        not isinstance(base_generated_pdf, bytes)
        or not 0 < len(base_generated_pdf) <= MAX_OUTPUT_BYTES
    ):
        raise PdfPrintDocumentError("pdf_print_base_limit")
    if not placements or len(placements) > MAX_PAGES:
        raise PdfPrintDocumentError("pdf_print_invalid_placement")
    checked = []
    targets: set[int] = set()
    for placement in placements:
        target = placement.get("targetPageIndex")
        source = placement.get("sourcePageIndex")
        identity = str(UUID(str(placement.get("objectID"))))
        if (
            type(target) is not int
            or type(source) is not int
            or not 0 <= target < MAX_PAGES
            or not 0 <= source < MAX_PAGES
            or target in targets
            or identity not in prepared
        ):
            raise PdfPrintDocumentError("pdf_print_invalid_placement")
        targets.add(target)
        checked.append({"targetPageIndex": target, "sourcePageIndex": source, "objectID": identity})
    return _run(prepared, base_generated_pdf, checked)


def _child(directory: str, dependency_path: str) -> None:
    # Limits precede pypdf import and every untrusted PDF parse/decompression.
    import resource

    resource.setrlimit(resource.RLIMIT_CPU, (8, 8))
    resource.setrlimit(resource.RLIMIT_AS, (384 * 1024 * 1024, 384 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES))
    resource.setrlimit(resource.RLIMIT_NOFILE, (48, 48))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

    def audit(event: str, _arguments: tuple[Any, ...]) -> None:
        if event.startswith(("socket.", "subprocess.")) or event in {
            "os.system",
            "os.posix_spawn",
            "os.fork",
            "os.forkpty",
        }:
            raise PdfPrintDocumentError("pdf_print_child_external_access")

    sys.addaudithook(audit)
    sys.path.insert(0, dependency_path)
    from io import BytesIO

    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import (
        ArrayObject,
        ContentStream,
        DictionaryObject,
        IndirectObject,
        NameObject,
        NumberObject,
        StreamObject,
        TextStringObject,
    )

    denied = {
        "/Annots",
        "/AA",
        "/OpenAction",
        "/JS",
        "/JavaScript",
        "/AcroForm",
        "/XFA",
        "/EmbeddedFiles",
        "/EF",
        "/AF",
        "/StructParent",
        "/A",
        "/RichMediaContent",
        "/RichMediaSettings",
        "/PresSteps",
        "/OPI",
        "/Ref",
        "/F",
        "/FFilter",
        "/FDecodeParms",
    }
    action_types = {
        "/JavaScript",
        "/Launch",
        "/URI",
        "/GoToR",
        "/GoToE",
        "/SubmitForm",
        "/ImportData",
        "/Rendition",
        "/Movie",
        "/Sound",
        "/Named",
        "/GoTo",
        "/Hide",
        "/SetOCGState",
        "/Trans",
        "/GoTo3DView",
        "/Thread",
        "/ResetForm",
    }

    def validate_graph(root: Any) -> None:
        pending = [(root, 0)]
        seen: set[Any] = set()
        visited = 0
        decoded = 0
        while pending:
            value, depth = pending.pop()
            visited += 1
            if visited > 100_000 or depth > 64:
                raise PdfPrintDocumentError("pdf_print_graph_limit")
            if isinstance(value, IndirectObject):
                identity = (id(value.pdf), value.idnum, value.generation)
                if identity in seen:
                    continue
                seen.add(identity)
                pending.append((value.get_object(), depth + 1))
            elif isinstance(value, DictionaryObject):
                if isinstance(value, StreamObject):
                    decoded += len(value.get_data())
                    if decoded > 32 * 1024 * 1024:
                        raise PdfPrintDocumentError("pdf_print_decoded_limit")
                if any(key in denied for key in value):
                    raise PdfPrintDocumentError("pdf_print_unsafe_object")
                if value.get("/Type") in {"/Filespec", "/Action", "/Annot", "/EmbeddedFile"}:
                    raise PdfPrintDocumentError("pdf_print_unsafe_object")
                if value.get("/S") in action_types or value.get("/Subtype") in {
                    "/PS",
                    "/RichMedia",
                }:
                    raise PdfPrintDocumentError("pdf_print_unsafe_object")
                pending.extend((item, depth + 1) for item in value.values())
            elif isinstance(value, ArrayObject):
                pending.extend((item, depth + 1) for item in value)

    def geometry(page: Any) -> dict[str, Any]:
        crop = [float(number) for number in page.cropbox]
        media = [float(number) for number in page.mediabox]
        unit = float(page.get("/UserUnit", 1))
        rotation = int(page.get("/Rotate", 0))
        if (
            not all(math.isfinite(number) and abs(number) <= 100_000 for number in crop + media)
            or not math.isfinite(unit)
            or not 0 < unit <= 100
            or rotation % 90 != 0
        ):
            raise PdfPrintDocumentError("pdf_print_page_geometry")
        width = (crop[2] - crop[0]) * unit
        height = (crop[3] - crop[1]) * unit
        if not 0 < width <= 100_000 or not 0 < height <= 100_000:
            raise PdfPrintDocumentError("pdf_print_page_geometry")
        if rotation % 180:
            width, height = height, width
        return {
            "width": width,
            "height": height,
            "rotation": rotation,
            "cropBox": crop,
            "mediaBox": media,
            "userUnit": unit,
        }

    def same(left: Any, right: Any) -> bool:
        return (
            isinstance(left, IndirectObject)
            and isinstance(right, IndirectObject)
            and left.idnum == right.idnum
            and left.generation == right.generation
            and left.pdf is right.pdf
        )

    def tag_profile(reader: Any, validate_content: bool = False) -> Any:
        # Preserve original roles and semantic order. A top-level source subtree
        # must belong to one page; spanning trees/OBJR/role maps are unsupported.
        if "/StructTreeRoot" not in reader.root_object:
            if any("/StructParents" in page for page in reader.pages):
                raise PdfPrintDocumentError("pdf_print_incomplete_tags")
            return None
        root = reader.root_object["/StructTreeRoot"]
        if set(root) - {"/Type", "/K", "/ParentTree", "/ParentTreeNextKey"}:
            raise PdfPrintDocumentError("pdf_print_tag_profile")
        roots = root["/K"]
        if not isinstance(roots, ArrayObject) or len(roots) != 1:
            raise PdfPrintDocumentError("pdf_print_tag_profile")
        document = roots[0].get_object()
        if (
            set(document) - {"/Type", "/S", "/P", "/K"}
            or document.get("/S") != "/Document"
            or not same(document.raw_get("/P"), root.indirect_reference)
        ):
            raise PdfPrintDocumentError("pdf_print_tag_profile")
        children = document["/K"]
        tree = root["/ParentTree"]
        if set(tree) != {"/Nums"} or not isinstance(children, ArrayObject):
            raise PdfPrintDocumentError("pdf_print_tag_profile")
        nums = tree["/Nums"]
        if len(nums) != 2 * len(reader.pages):
            raise PdfPrintDocumentError("pdf_print_tag_profile")
        parents = {int(nums[index]): nums[index + 1] for index in range(0, len(nums), 2)}
        if len(parents) != len(reader.pages):
            raise PdfPrintDocumentError("pdf_print_tag_profile")
        page_indices = {
            page.indirect_reference.idnum: index for index, page in enumerate(reader.pages)
        }
        groups = [ArrayObject() for _page in reader.pages]
        used: set[tuple[int, int]] = set()
        visited: set[int] = set()
        last_page = 0

        def walk(ref: Any, parent: Any, inherited_page: Any = None, depth: int = 0) -> set[int]:
            nonlocal last_page
            if (
                depth > 32
                or not isinstance(ref, IndirectObject)
                or ref.idnum in visited
                or len(visited) > 20_000
            ):
                raise PdfPrintDocumentError("pdf_print_tag_profile")
            visited.add(ref.idnum)
            node = ref.get_object()
            if not isinstance(node, DictionaryObject):
                raise PdfPrintDocumentError("pdf_print_tag_profile")
            if node.get("/Type") != "/StructElem" or not same(node.raw_get("/P"), parent):
                raise PdfPrintDocumentError("pdf_print_tag_profile")
            page_ref = node.raw_get("/Pg") if "/Pg" in node else inherited_page
            index = None
            if page_ref is not None:
                if not isinstance(page_ref, IndirectObject) or page_ref.idnum not in page_indices:
                    raise PdfPrintDocumentError("pdf_print_tag_profile")
                index = page_indices[page_ref.idnum]
                if not same(page_ref, reader.pages[index].indirect_reference):
                    raise PdfPrintDocumentError("pdf_print_tag_profile")
            kids = node.raw_get("/K")
            if type(kids) is NumberObject:
                if index is None or index < last_page:
                    raise PdfPrintDocumentError("pdf_print_tag_profile")
                key = int(reader.pages[index]["/StructParents"])
                array = parents[key]
                mcid = int(kids)
                if (
                    not 0 <= mcid < len(array)
                    or (index, mcid) in used
                    or not same(array[mcid], ref)
                ):
                    raise PdfPrintDocumentError("pdf_print_tag_profile")
                used.add((index, mcid))
                last_page = index
                return {index}
            if not isinstance(kids, ArrayObject):
                raise PdfPrintDocumentError("pdf_print_tag_profile")
            found: set[int] = set()
            for kid in kids:
                if type(kid) is NumberObject:
                    if index is None or index < last_page:
                        raise PdfPrintDocumentError("pdf_print_tag_profile")
                    key = int(reader.pages[index]["/StructParents"])
                    mcid = int(kid)
                    if (not 0 <= mcid < len(parents[key]) or (index, mcid) in used
                        or not same(parents[key][mcid], ref)):
                        raise PdfPrintDocumentError("pdf_print_tag_profile")
                    used.add((index, mcid))
                    last_page = index
                    found.add(index)
                else:
                    found.update(walk(kid, ref, page_ref, depth + 1))
            if not kids and index is not None:
                found.add(index)
            return found

        for child in children:
            indices = walk(child, document.indirect_reference)
            if len(indices) != 1:
                raise PdfPrintDocumentError("pdf_print_spanning_tag_subtree")
            groups[next(iter(indices))].append(child)
        expected: set[tuple[int, int]] = set()
        for index, page in enumerate(reader.pages):
            array = parents[int(page["/StructParents"])]
            if not isinstance(array, ArrayObject):
                raise PdfPrintDocumentError("pdf_print_tag_profile")
            expected.update((index, mcid) for mcid in range(len(array)))
            if validate_content:
                marked = _marked_page_spans(reader, page, PdfPrintDocumentError)
                if set(marked) != set(range(len(array))):
                    raise PdfPrintDocumentError("pdf_print_tag_profile")
                for mcid, span in marked.items():
                    if span["text"] is None:
                        owner = array[mcid].get_object()
                        if (not span["imagePaint"] or owner.get("/S") != "/Figure"
                            or not isinstance(owner.get("/Alt"), str)
                            or not owner["/Alt"].strip() or len(owner["/Alt"]) > 8_000):
                            raise PdfPrintDocumentError("pdf_print_tag_profile")
        if used != expected:
            raise PdfPrintDocumentError("pdf_print_tag_profile")
        return (root, document, children, parents, groups)

    def import_tags(writer: Any, readers: Any, profiles: Any, placements: Any) -> None:
        if not any(profiles.values()):
            return
        base_profile = tag_profile(writer)
        if base_profile is None:
            raise PdfPrintDocumentError("pdf_print_base_tags_required")
        base_root, _base_document, base_sections, base_parents, _base_groups = base_profile
        base_tree = base_root["/ParentTree"]["/Nums"]
        base_offsets = {int(base_tree[i]): i + 1 for i in range(0, len(base_tree), 2)}
        for identity, profile in profiles.items():
            if profile is None:
                continue
            selected = [item for item in placements if item["objectID"] == identity]
            source_count = len(readers[identity].pages)
            if len(selected) % source_count:
                raise PdfPrintDocumentError("pdf_print_tagged_pages_require_complete_order")
            for offset in range(0, len(selected), source_count):
                instance = selected[offset : offset + source_count]
                if [item["sourcePageIndex"] for item in instance] != list(range(source_count)):
                    raise PdfPrintDocumentError("pdf_print_tagged_pages_require_complete_order")
                targets = [item["targetPageIndex"] for item in instance]
                if targets != sorted(targets):
                    raise PdfPrintDocumentError("pdf_print_tagged_pages_require_complete_order")
                source_root, source_document, _source_children, source_parents, source_groups = (
                    profile
                )
                # Each complete authored reuse has its own structure nodes and
                # page mapping; cached source bytes remain immutable and shared.
                writer.reset_translation(readers[identity])
                translation = writer._id_translated.setdefault(id(readers[identity]), {})
                translation[source_root.indirect_reference.idnum] = (
                    base_root.indirect_reference.idnum
                )
                for item in instance:
                    source = readers[identity].pages[item["sourcePageIndex"]]
                    target = writer.pages[item["targetPageIndex"]]
                    translation[source.indirect_reference.idnum] = target.indirect_reference.idnum
                for item in instance:
                    target_index = item["targetPageIndex"]
                    source_index = item["sourcePageIndex"]
                    target = writer.pages[target_index]
                    source = readers[identity].pages[source_index]
                    old_section = base_sections[target_index].get_object()
                    key = int(target["/StructParents"])
                    if old_section["/K"] or base_parents[key]:
                        raise PdfPrintDocumentError("pdf_print_placeholder_has_tags")
                    translation[source_document.indirect_reference.idnum] = (
                        old_section.indirect_reference.idnum
                    )
                    imported_children = ArrayObject(
                        [child.clone(writer) for child in source_groups[source_index]]
                    )
                    old_section[NameObject("/K")] = imported_children
                    source_language = readers[identity].root_object.get("/Lang")
                    if source_language is not None and "/Lang" not in old_section:
                        old_section[NameObject("/Lang")] = source_language.clone(writer)
                    source_key = int(source["/StructParents"])
                    base_tree[base_offsets[key]] = source_parents[source_key].clone(writer)

    temporary = Path(directory)
    request = json.loads((temporary / "request.json").read_bytes())
    readers = {}
    descriptions = {}
    tagged = {}
    page_count = 0
    for entry in request["documents"]:
        reader = PdfReader(BytesIO((temporary / entry["file"]).read_bytes()), strict=True)
        root = reader.root_object
        if (
            reader.is_encrypted
            or root.get("/OpenGeoPrintVector") != "1.0.0"
            or set(root)
            - {"/Type", "/Pages", "/OpenGeoPrintVector", "/StructTreeRoot", "/MarkInfo", "/Lang"}
        ):
            raise PdfPrintDocumentError("pdf_print_not_prepared")
        validate_graph(root)
        count = len(reader.pages)
        page_count += count
        if not 0 < count <= MAX_PAGES or page_count > MAX_PAGES:
            raise PdfPrintDocumentError("pdf_print_page_limit")
        tagged[entry["id"]] = tag_profile(reader, validate_content=True)
        descriptions[entry["id"]] = [geometry(page) for page in reader.pages]
        readers[entry["id"]] = reader
    if not request["compose"]:
        (temporary / "result").write_text(
            json.dumps(descriptions, sort_keys=True), encoding="utf-8"
        )
        return
    base = PdfReader(BytesIO((temporary / "base.pdf").read_bytes()), strict=True)
    if base.is_encrypted or not 0 < len(base.pages) <= MAX_PAGES:
        raise PdfPrintDocumentError("pdf_print_base_limit")
    writer = PdfWriter(clone_from=base)
    replace_keys = (
        "/Contents",
        "/Resources",
        "/MediaBox",
        "/CropBox",
        "/BleedBox",
        "/TrimBox",
        "/ArtBox",
        "/Rotate",
        "/UserUnit",
        "/Group",
    )
    import_tags(writer, readers, tagged, request["placements"])
    for placement in request["placements"]:
        target = writer.pages[placement["targetPageIndex"]]
        source = readers[placement["objectID"]].pages[placement["sourcePageIndex"]]
        # The base generator must give imported pages empty placeholders. Reject
        # accidental replacement of generated marked/text content or annotations.
        contents = target.get_contents()
        if contents is not None and contents.get_data().strip():
            raise PdfPrintDocumentError("pdf_print_placeholder_not_empty")
        if "/Annots" in target:
            raise PdfPrintDocumentError("pdf_print_placeholder_not_empty")
        for key in replace_keys:
            target.pop(key, None)
            if key in source:
                target[NameObject(key)] = source.raw_get(key).clone(writer)
        # No add_page/merge_page: the target's indirect reference, StructParents,
        # and every base structure /Pg reference continue to identify this page.
    with (temporary / "result").open("wb") as output:
        writer.write(output)


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] != "--child":
        raise SystemExit(2)
    try:
        _child(sys.argv[2], sys.argv[3])
    except Exception:
        raise SystemExit(1) from None
