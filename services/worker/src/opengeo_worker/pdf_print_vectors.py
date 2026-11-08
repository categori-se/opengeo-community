"""Optional safe PDF sibling; invoked only after the source safety gates.

Preserves PDF fonts, text operators, graphics, crop and rotation. This closed
profile deliberately removes inert annotations and refuses source tag authority
outside the supported ActualText profile. Original source is never rewritten.
"""

import importlib.util
import json
import logging
import math
import signal
import sys
from pathlib import Path

from opengeo_worker.command_runner import CommandRunner

SCHEMA = "opengeo.pdf-print-vector.1.0.0"
MAX_BYTES = 4 * 1024 * 1024
_MAX_DECODED_BYTES = 32 * 1024 * 1024


class UnsupportedVectors(ValueError):
    pass


def prepare_vectors(source: Path, target: Path, page_count: int) -> dict[str, object]:
    from pypdf import Configuration, PdfReader, PdfWriter
    from pypdf.generic import (
        ArrayObject,
        DictionaryObject,
        IndirectObject,
        StreamObject,
        TextStringObject,
    )

    if source.resolve() == target.resolve() or source.stat().st_size > 16 * 1024 * 1024:
        raise UnsupportedVectors("source_limit")
    if not 1 <= page_count <= 200:
        raise UnsupportedVectors("page_limit")
    for setting in (
        "zlib_maximum_output_length",
        "lzw_maximum_output_length",
        "run_length_maximum_output_length",
        "array_based_stream_maximum_output_length",
        "maximum_declared_stream_length",
    ):
        setattr(Configuration, setting, MAX_BYTES)
    Configuration.array_maximum_element_count = 20_000
    Configuration.dictionary_maximum_element_count = 20_000
    Configuration.page_tree_maximum_depth = 32
    Configuration.page_tree_maximum_page_entries = 20_000
    reader = PdfReader(source, strict=True, xref_stream_maximum_entries=20_000)
    count = sum(len(entries) for entries in reader.xref.values()) + len(reader.xref_objStm)
    if reader.is_encrypted or reader.trailer.get("/Size", 20_001) > 20_000 or count > 20_000:
        raise UnsupportedVectors("object_limit")
    pages = list(reader.pages)
    if len(pages) != page_count:
        raise UnsupportedVectors("page_count")
    # Catalog-only rendering controls are outside this bounded print profile.
    forbidden = frozenset(
        {
            "/OpenAction",
            "/A",
            "/AA",
            "/JS",
            "/JavaScript",
            "/EmbeddedFiles",
            "/EF",
            "/AF",
            "/AcroForm",
            "/XFA",
            "/RichMediaContent",
            "/RichMediaSettings",
            "/Collection",
            "/OCProperties",
            "/OutputIntents",
            "/PresSteps",
            "/Requirements",
            "/Perms",
        }
    )
    actions = frozenset(
        {
            "/GoTo",
            "/GoToR",
            "/GoToE",
            "/Launch",
            "/Thread",
            "/URI",
            "/Sound",
            "/Movie",
            "/Hide",
            "/Named",
            "/SubmitForm",
            "/ResetForm",
            "/ImportData",
            "/JavaScript",
            "/SetOCGState",
            "/Rendition",
            "/Trans",
            "/GoTo3DView",
        }
    )
    tagged = "/StructTreeRoot" in reader.root_object
    visited: set[tuple[int, int] | int] = set()
    nodes = decoded = 0

    def walk(value: object, depth: int = 0) -> None:
        nonlocal nodes, decoded
        if depth > 64:
            raise UnsupportedVectors("graph_depth")
        if isinstance(value, IndirectObject):
            identity = (value.idnum, value.generation)
            if identity in visited:
                return
            visited.add(identity)
            value = value.get_object()
        elif isinstance(value, (ArrayObject, DictionaryObject)):
            container_identity = id(value)
            if container_identity in visited:
                return
            visited.add(container_identity)
        nodes += 1
        if nodes > 100_000:
            raise UnsupportedVectors("graph_limit")
        if isinstance(value, DictionaryObject):
            if not tagged and any(key in value for key in ("/StructParents", "/StructParent")):
                raise UnsupportedVectors("orphan_source_tags")
            if forbidden.intersection(value):
                raise UnsupportedVectors("unsupported_controls_or_tags")
            if (
                value.get("/Type") in ("/Filespec", "/EmbeddedFile", "/Action")
                or value.get("/S") in actions
            ):
                raise UnsupportedVectors("active_or_attached_content")
            if isinstance(value, StreamObject):
                if any(key in value for key in ("/F", "/FFilter", "/FDecodeParms")):
                    raise UnsupportedVectors("external_stream")
                decoded += len(value.get_data())
                if decoded > _MAX_DECODED_BYTES:
                    raise UnsupportedVectors("decoded_limit")
            for child in value.values():
                walk(child, depth + 1)
        elif isinstance(value, ArrayObject):
            for child in value:
                walk(child, depth + 1)

    # Walk the complete reachable catalog before copying pages: annotations and
    # actions are parsed objects, never detected by searching raw PDF names.
    walk(reader.root_object)
    if tagged:
        from opengeo_worker.pdf_tagged_text import tagged_pages

        # Authoritative closed profile; complex tags stay unavailable.
        tagged_pages(source, page_count)
    elif any("/StructParents" in page or "/StructParent" in page for page in pages):
        raise UnsupportedVectors("orphan_source_tags")
    dimensions = []
    removed = 0
    for page in pages:
        crop = [float(number) for number in page.cropbox]
        media = [float(number) for number in page.mediabox]
        rotation = page.get("/Rotate", 0)
        if (
            type(rotation).__name__ not in ("NumberObject", "int")
            or int(rotation) % 90
            or not all(math.isfinite(number) and abs(number) <= 14_400 for number in crop + media)
            or crop[2] <= crop[0]
            or crop[3] <= crop[1]
            or media[2] <= media[0]
            or media[3] <= media[1]
            or "/UserUnit" in page
        ):
            raise UnsupportedVectors("page_geometry")
        annotations = page.get("/Annots")
        if annotations is not None:
            if not isinstance(annotations, ArrayObject):
                raise UnsupportedVectors("annotation_shape")
            removed += len(annotations)
        # PdfReader's flattened PageObject is a separate dictionary from the
        # indirect page in the catalog tree. Sanitize both before cloning the
        # catalog; otherwise clone_reader_document_root reintroduces annotations.
        # Both mutations are in memory; source file bytes remain untouched.
        page_reference = page.indirect_reference
        if page_reference is None:
            raise UnsupportedVectors("page_reference")
        raw_page = page_reference.get_object()
        if not isinstance(raw_page, DictionaryObject):
            raise UnsupportedVectors("page_dictionary_shape")
        for key in ("/Annots", "/Metadata", "/PieceInfo", "/Thumb"):
            page.pop(key, None)
            raw_page.pop(key, None)
        dimensions.append(
            {
                "crop_box": crop,
                "media_box": media,
                "rotation": int(rotation) % 360,
                "width_points": crop[2] - crop[0],
                "height_points": crop[3] - crop[1],
            }
        )
    # Copy a closed catalog graph, including the supported tag tree and its
    # original page identities, but no unreferenced source objects or annotations.
    for key in list(reader.root_object):
        if key not in ("/Type", "/Pages", "/StructTreeRoot", "/MarkInfo", "/Lang"):
            reader.root_object.pop(key)
    writer = PdfWriter()
    writer.clone_reader_document_root(reader)
    writer.metadata = None
    from pypdf.generic import NameObject

    writer.root_object[NameObject("/OpenGeoPrintVector")] = TextStringObject("1.0.0")
    # No generate_file_identifiers: neither timestamps nor volatile document IDs.
    writer.write(target)
    if not 1 <= target.stat().st_size <= MAX_BYTES:
        target.unlink(missing_ok=True)
        raise UnsupportedVectors("output_limit")
    return {
        "schema": SCHEMA,
        "page_count": page_count,
        "pages": dimensions,
        "annotations_removed": removed,
        "source_tags": "closed-actualtext" if tagged else "absent",
        "renderer": "pypdf-safe-clone",
    }


def build_pdf_print_vectors(
    source: Path, workdir: Path, runner: CommandRunner, *, page_count: int
) -> tuple[Path | None, dict[str, object]]:
    """Return optional (path, facts); failure never invalidates ordinary ingestion."""
    from opengeo_worker.models import TransientFailure, ValidationFailure

    target = workdir / "print-vector.pdf"
    target.unlink(missing_ok=True)
    spec = importlib.util.find_spec("pypdf")
    if spec is None or spec.origin is None:
        return None, {"unavailable_reason": "parser_unavailable"}
    paths = [str(Path(spec.origin).parent.parent), str(Path(__file__).resolve().parents[1])]
    bootstrap = (
        f"import sys;sys.path[:0]={paths!r};"
        "from opengeo_worker.pdf_print_vectors import main;main()"
    )
    try:
        result = runner.run(
            "pdf-print-vectors",
            ["-I", "-c", bootstrap, str(source), str(target), str(page_count)],
            cwd=workdir,
            maximum_file_bytes=MAX_BYTES,
        )
        facts = json.loads(result.stdout)
        if (
            result.stderr
            or facts.get("schema") != SCHEMA
            or facts.get("page_count") != page_count
            or not isinstance(facts.get("pages"), list)
            or len(facts["pages"]) != page_count
            or not target.is_file()
            or not 1 <= target.stat().st_size <= MAX_BYTES
        ):
            raise ValueError("unsupported_or_bounded")
        return target, facts
    except (ValidationFailure, TransientFailure, ValueError, TypeError, AttributeError, OSError):
        target.unlink(missing_ok=True)
        return None, {"unavailable_reason": "unsupported_or_bounded"}


def main() -> None:
    logging.disable(logging.CRITICAL)
    signal.alarm(15)
    try:
        facts = prepare_vectors(Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3]))
    except Exception:
        Path(sys.argv[2]).unlink(missing_ok=True)
        facts = {"unavailable_reason": "unsupported_or_bounded"}
    print(json.dumps(facts, ensure_ascii=True, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
