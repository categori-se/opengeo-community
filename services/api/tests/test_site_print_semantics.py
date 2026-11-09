"""Inspect the exported PDF's semantic graph, independently of its serializer."""

from dataclasses import replace
from io import BytesIO

from pypdf import PdfReader
from pypdf.generic import ContentStream, DictionaryObject, NumberObject

from opengeo_api.site_print import build_print_pdf
from test_site_export import published_site


def _publication(elements, *, blocks=(), second_elements=None):
    publication = published_site()
    first = replace(publication.site.pages[0], resource_content={"blocks": list(blocks)})
    pages = [first]
    layouts = [{"sitePageSlug": first.slug, "elements": elements}]
    if second_elements is not None:
        pages.append(replace(first, slug="second", position=1, is_home=False))
        layouts.append({"sitePageSlug": "second", "elements": second_elements})
    return replace(
        publication,
        references=(),
        assets=(),
        site=replace(
            publication.site,
            pages=tuple(pages),
            print_layout={"schemaVersion": "opengeo.print-layout.1.3.0", "pages": layouts},
        ),
    )


def _text(identifier, value, style="body", **position):
    return {
        "id": identifier,
        "type": "text",
        "x": 30,
        "y": 30,
        "width": 850,
        "height": 250,
        "rotation": 0,
        "clip": True,
        "text": value,
        "style": style,
        "fontSize": 9,
        "color": "#000000",
        **position,
    }


def _children(node):
    kids = node.get_object().get("/K", [])
    if isinstance(kids, (NumberObject, int)):
        return []
    return [kid for kid in kids if isinstance(kid.get_object(), DictionaryObject)]


def _mcids(node):
    kids = node.get_object().get("/K", [])
    if isinstance(kids, (NumberObject, int)):
        return [int(kids)]
    return [int(kid) for kid in kids if isinstance(kid, (NumberObject, int))]


def _sections(reader):
    return _children(_children(reader.root_object["/StructTreeRoot"])[0])


def _marked_text(reader, page):
    result = {}
    for operands, operator in ContentStream(page.get_contents(), reader).operations:
        if operator == b"BDC" and isinstance(operands[1], DictionaryObject):
            properties = operands[1]
            if "/MCID" in properties:
                mcid = int(properties["/MCID"])
                assert mcid not in result
                result[mcid] = str(properties.get("/ActualText", ""))
    return result


def _node_text(node, marked):
    own = [marked[mcid] for mcid in _mcids(node)]
    return " ".join(own + [_node_text(child, marked) for child in _children(node)])


def test_positioned_table_retains_rectangular_semantics_and_blank_cell():
    table = {
        "id": "results",
        "type": "table",
        "caption": "Survey results",
        "columns": ["District", "Measure"],
        "rows": [["East", ""], ["West", 2]],
    }
    publication = _publication(
        [{
            "id": "table",
            "type": "table_frame",
            "x": 30,
            "y": 30,
            "width": 900,
            "height": 800,
            "rotation": 0,
            "clip": True,
            "blockId": "results",
        }],
        blocks=[table],
    )
    body = build_print_pdf(publication, {})
    assert body.startswith(b"%PDF-1.5")
    reader = PdfReader(BytesIO(body))
    marked = _marked_text(reader, reader.pages[0])
    siblings = _children(_sections(reader)[0])
    table_index = next(i for i, ref in enumerate(siblings) if ref.get_object()["/S"] == "/Table")
    caption = siblings[table_index - 1].get_object()
    assert caption["/S"] == "/Caption"
    assert _node_text(caption, marked) == "Survey results"
    rows = _children(siblings[table_index])
    assert [row.get_object()["/S"] for row in rows] == ["/TR"] * 3
    cells = [_children(row) for row in rows]
    assert [len(row) for row in cells] == [2, 2, 2]
    assert [[cell.get_object()["/S"] for cell in row] for row in cells] == [
        ["/TH", "/TH"], ["/TD", "/TD"], ["/TD", "/TD"]
    ]
    for header in cells[0]:
        attributes = header.get_object()["/A"]
        assert attributes["/O"] == "/Table" and attributes["/Scope"] == "/Column"
    assert [[_node_text(cell, marked) for cell in row] for row in cells] == [
        ["District", "Measure"], ["East", ""], ["West", "2"]
    ]
    assert _mcids(cells[1][1]) == []


def test_headings_and_wrapped_paragraph_keep_authored_order_over_visual_position():
    paragraph = " ".join(["A wrapped paragraph preserves its complete authored reading order."] * 3)
    publication = _publication([
        _text("title", "Authored title", "title", y=700, height=100),
        _text("heading", "Authored heading", "heading", y=400, height=100),
        _text("paragraph", paragraph, y=30, width=220, height=350),
    ])
    body = build_print_pdf(publication, {})
    assert body.startswith(b"%PDF-1.4")
    reader = PdfReader(BytesIO(body))
    marked = _marked_text(reader, reader.pages[0])
    siblings = _children(_sections(reader)[0])
    authored = [ref for ref in siblings if ref.get_object()["/S"] in {"/H1", "/H2", "/P"}]
    assert [node.get_object()["/S"] for node in authored] == ["/H1", "/H2", "/P"]
    assert [_node_text(node, marked) for node in authored] == [
        "Authored title", "Authored heading", paragraph
    ]
    assert len(_children(authored[2])) > 1
    assert "Authored title" in reader.pages[0].extract_text()


def test_parent_tree_maps_every_content_id_to_its_leaf_and_page_ancestry():
    publication = _publication(
        [_text("first", "First authored page", "title")],
        blocks=[{
            "id": "sequence",
            "type": "table",
            "caption": "Second page table",
            "columns": ["Item", "Value"],
            "rows": [["one", ""]],
        }],
        second_elements=[
            _text("second", "Second authored page", "heading"),
            {
                "id": "table",
                "type": "table_frame",
                "x": 30,
                "y": 350,
                "width": 900,
                "height": 600,
                "rotation": 0,
                "clip": True,
                "blockId": "sequence",
            },
        ],
    )
    reader = PdfReader(BytesIO(build_print_pdf(publication, {})))
    assert len(reader.pages) == 2
    root = reader.root_object["/StructTreeRoot"]
    nums = root["/ParentTree"]["/Nums"]
    parent_tree = {int(nums[i]): nums[i + 1] for i in range(0, len(nums), 2)}
    sections = _sections(reader)
    assert len(sections) == len(reader.pages)
    document_ref = root["/K"][0]
    for page, section_ref in zip(reader.pages, sections, strict=True):
        assert section_ref.get_object().raw_get("/P") == document_ref
        content = _marked_text(reader, page)
        parents = parent_tree[int(page["/StructParents"])]
        assert len(parents) == len(content)
        seen = {}

        def visit(ref, parent):
            node = ref.get_object()
            assert node.raw_get("/P") == parent
            for mcid in _mcids(node):
                assert mcid not in seen
                assert node.raw_get("/Pg") == page.indirect_reference
                assert parents[mcid] == ref
                seen[mcid] = ref
            for child in _children(ref):
                visit(child, ref)

        for child in _children(section_ref):
            visit(child, section_ref)
        assert set(seen) == set(content)
        assert list(content) == list(range(len(content)))
