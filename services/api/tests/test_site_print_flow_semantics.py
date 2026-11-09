"""Inspect flow PDF heading/paragraph structure and its painted content."""

from dataclasses import replace
from io import BytesIO

from pypdf import PdfReader
from pypdf.generic import ContentStream, DictionaryObject

from opengeo_api.site_print import build_print_pdf
from test_site_export import published_site
from test_site_print_semantics import _children, _marked_text, _mcids, _node_text, _sections


def _flow(blocks, *, abstract="An abstract before the authored content."):
    publication = published_site()
    page = replace(
        publication.site.pages[0],
        resource_title="Flow findings",
        resource_abstract=abstract,
        resource_content={"blocks": blocks},
    )
    publication = replace(
        publication,
        references=(),
        assets=(),
        site=replace(
            publication.site,
            title="Field publication",
            pages=(page,),
            print_layout={"schemaVersion": "opengeo.print-layout.1.3.0", "pages": []},
        ),
    )
    return PdfReader(BytesIO(build_print_pdf(publication, {})))


def _assert_visible_ancestry(reader):
    """Every marked text run has paint, one structural owner and page ancestry."""
    root = reader.root_object["/StructTreeRoot"]
    nums = root["/ParentTree"]["/Nums"]
    parent_tree = {int(nums[i]): nums[i + 1] for i in range(0, len(nums), 2)}
    document_ref = root["/K"][0]
    sections = _sections(reader)
    assert len(sections) == len(reader.pages)
    for page, section_ref in zip(reader.pages, sections, strict=True):
        assert section_ref.get_object().raw_get("/P") == document_ref
        marked = _marked_text(reader, page)
        parents = parent_tree[int(page["/StructParents"])]
        assert len(parents) == len(marked)
        seen = set()

        def visit(ref, parent):
            node = ref.get_object()
            assert node.raw_get("/P") == parent
            for mcid in _mcids(node):
                assert mcid not in seen
                assert node.raw_get("/Pg") == page.indirect_reference
                assert parents[mcid] == ref
                seen.add(mcid)
            for child in _children(ref):
                visit(child, ref)

        for child in _children(section_ref):
            visit(child, section_ref)
        assert seen == set(marked)
        assert list(marked) == list(range(len(marked)))

        stack = []
        painted = []
        for operands, operator in ContentStream(page.get_contents(), reader).operations:
            if operator in {b"BDC", b"BMC"}:
                properties = operands[1] if operator == b"BDC" else None
                stack.append(
                    int(properties["/MCID"])
                    if isinstance(properties, DictionaryObject) and "/MCID" in properties
                    else None
                )
            elif operator == b"EMC":
                stack.pop()
            elif operator in {b"Tj", b"TJ", b"'", b'"'}:
                assert stack and stack[-1] is not None
                painted.append(stack[-1])
        assert not stack
        assert set(painted) == set(marked)
        assert all(marked.values())
        assert " ".join(page.extract_text().split()) == " ".join(" ".join(marked.values()).split())


def test_flow_headings_wrapped_paragraphs_and_abstract_have_authored_order():
    first = (
        "The first paragraph describes the observed river conditions and the field team's "
        "careful measurements, preserving the complete authored sentence across wrapped lines."
    )
    second = (
        "The second paragraph records the follow-up observations and their supporting evidence, "
        "keeping its words together as one paragraph even when the printed text wraps."
    )
    reader = _flow([
        {"id": "overview", "type": "heading", "level": 2, "text": "Overview"},
        {"id": "body", "type": "markdown", "markdown": first + "\n\n  \n" + second},
        {"id": "detail", "type": "heading", "level": 3, "text": "Detailed findings"},
        {"id": "evidence", "type": "heading", "level": 4, "text": "Supporting evidence"},
    ])
    assert len(reader.pages) == 1
    marked = _marked_text(reader, reader.pages[0])
    siblings = _children(_sections(reader)[0])
    semantic = [node for node in siblings if node.get_object()["/S"] != "/Span"]
    assert [node.get_object()["/S"] for node in semantic] == [
        "/H1", "/P", "/H2", "/P", "/P", "/H3", "/H4"
    ]
    assert [_node_text(node, marked) for node in semantic] == [
        "Flow findings", "An abstract before the authored content.", "Overview",
        first, second, "Detailed findings", "Supporting evidence",
    ]
    for paragraph in semantic[3:5]:
        assert len(_children(paragraph)) > 1
    spans = [_node_text(node, marked) for node in siblings if node.get_object()["/S"] == "/Span"]
    assert "Field publication" in spans
    assert any(text.startswith("Resource ") for text in spans)
    assert any(text.startswith("Edition ") for text in spans)
    _assert_visible_ancestry(reader)


def test_flow_malformed_or_unsupported_heading_levels_remain_paragraphs():
    levels = [True, 5, "2", 3.0, None]
    labels = ["Boolean level", "Unsupported level", "String level", "Float level", "Missing level"]
    blocks = [
        {"id": str(index), "type": "heading", "text": label,
         **({"level": level} if level is not None else {})}
        for index, (level, label) in enumerate(zip(levels, labels, strict=True))
    ]
    reader = _flow(blocks, abstract=None)
    marked = _marked_text(reader, reader.pages[0])
    semantic = [
        node for node in _children(_sections(reader)[0])
        if node.get_object()["/S"] != "/Span"
    ]
    assert [node.get_object()["/S"] for node in semantic] == ["/H1"] + ["/P"] * len(labels)
    assert [_node_text(node, marked) for node in semantic] == ["Flow findings", *labels]


def test_flow_content_limit_has_no_unpainted_or_empty_semantic_nodes():
    words = [f"token{index:04d}" for index in range(1200)]
    reader = _flow([
        {"id": "early", "type": "heading", "level": 2, "text": "Visible heading"},
        {"id": "long", "type": "markdown", "markdown": " ".join(words)},
        {"id": "late", "type": "heading", "level": 3, "text": "Omitted late heading"},
        {"id": "later", "type": "markdown", "markdown": "Omitted later paragraph."},
    ])
    assert len(reader.pages) == 1  # The existing flow limit does not paginate overflow.
    marked = _marked_text(reader, reader.pages[0])
    semantic = [
        node for node in _children(_sections(reader)[0])
        if node.get_object()["/S"] != "/Span"
    ]
    assert [node.get_object()["/S"] for node in semantic] == ["/H1", "/P", "/H2", "/P"]
    texts = [_node_text(node, marked) for node in semantic]
    assert texts[:3] == ["Flow findings", "An abstract before the authored content.", "Visible heading"]
    visible_words = texts[3].split()
    assert 0 < len(visible_words) < len(words)
    assert visible_words == words[:len(visible_words)]
    assert all(text.strip() for text in texts)
    assert "Omitted" not in reader.pages[0].extract_text()
    _assert_visible_ancestry(reader)
