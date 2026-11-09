"""Inspect authored image alternatives against real PDF image paint and ancestry."""

from dataclasses import replace
from hashlib import sha256
from io import BytesIO
from uuid import UUID

import pytest
from pypdf import PdfReader
from pypdf.generic import ContentStream, DictionaryObject

from opengeo_api import site_print
from opengeo_api.site_print import SitePrintError, build_print_pdf
from opengeo_api.site_publications import PublishedSiteAsset
from test_site_export import IMAGE_OBJECT_ID, published_site
from test_site_print import png
from test_site_print_semantics import _children, _mcids, _sections, _text


ALT_TEXT = '  Café Ω 東京 <b>river (east)</b> & "🛰️"  '
_ABSENT = object()


def _image_frame(identifier, block_id="field-photo", **position):
    return {
        "id": identifier,
        "type": "image_frame",
        "x": 80,
        "y": 220,
        "width": 340,
        "height": 300,
        "rotation": 12,
        "clip": True,
        "blockId": block_id,
        "fit": "cover",
        **position,
    }


def _figure_publication(*, alt_text=ALT_TEXT, second_page=False):
    """Return (publication, snapshots, asset_bodies), ready for build_print_pdf(*args).

    One sealed PNG appears twice, with different fit/rotation/clipping, alongside
    ordinary text. The optional second page places the same block and asset again.
    Native before/current comparisons should use the unchanged default arguments.
    """
    publication = published_site()
    image_body = png(20, 32)
    block = {
        "id": "field-photo",
        "type": "image",
        "object_id": str(IMAGE_OBJECT_ID),
        "caption": "A caption is not a substitute for an authored alternative.",
    }
    if alt_text is not _ABSENT:
        block["alt_text"] = alt_text
    asset = PublishedSiteAsset(
        kind="image",
        dataset_id=UUID("80000000-0000-4000-8000-000000000264"),
        dataset_version_id=UUID("81000000-0000-4000-8000-000000000264"),
        object_id=IMAGE_OBJECT_ID,
        bucket="opengeo-managed",
        object_key="organizations/o/site-assets/field.png",
        storage_version_id="asset-version-1",
        content_type="image/png",
        size_bytes=len(image_body),
        checksum_sha256=sha256(image_body).hexdigest(),
        filename="field.png",
    )
    first = replace(
        publication.site.pages[0],
        resource_title="Figure findings",
        resource_content={"blocks": [block]},
    )
    pages = [first]
    layouts = [{
        "sitePageSlug": first.slug,
        "elements": [
            _text("heading", "Authored heading", "heading", height=100),
            _image_frame("first"),
            _text("body", "Text between the authored image placements.", y=570, height=100),
            _image_frame("second", x=580, y=240, rotation=-17, clip=False, fit="contain"),
        ],
    }]
    if second_page:
        pages.append(replace(first, slug="second", position=1, is_home=False))
        layouts.append({
            "sitePageSlug": "second",
            "elements": [
                _text("second-heading", "Second page heading", "heading", height=100),
                _image_frame("third", x=300, y=260, rotation=-8),
            ],
        })
    publication = replace(
        publication,
        references=(),
        assets=(asset,),
        site=replace(
            publication.site,
            pages=tuple(pages),
            print_layout={"schemaVersion": "opengeo.print-layout.1.3.0", "pages": layouts},
        ),
    )
    return publication, {}, {IMAGE_OBJECT_ID: image_body}


def _inspect(reader):
    """Bind every content MCID to real text/image operators and its owning node."""
    root = reader.root_object["/StructTreeRoot"]
    nums = root["/ParentTree"]["/Nums"]
    parent_tree = {int(nums[i]): nums[i + 1] for i in range(0, len(nums), 2)}
    document_ref = root["/K"][0]
    results = []
    sections = _sections(reader)
    assert len(sections) == len(reader.pages)
    for page, section_ref in zip(reader.pages, sections, strict=True):
        assert section_ref.get_object().raw_get("/P") == document_ref
        marked, image_paint, stack = {}, [], []
        for operands, operator in ContentStream(page.get_contents(), reader).operations:
            if operator in {b"BDC", b"BMC"}:
                properties = operands[1] if operator == b"BDC" else None
                mcid = (
                    int(properties["/MCID"])
                    if isinstance(properties, DictionaryObject) and "/MCID" in properties
                    else None
                )
                if mcid is not None:
                    assert mcid not in marked
                    marked[mcid] = {"role": str(operands[0]), "properties": properties, "paint": []}
                stack.append(mcid)
            elif operator == b"EMC":
                assert stack
                stack.pop()
            elif operator in {b"Do", b"Tj", b"TJ", b"'", b'"'}:
                mcid = stack[-1] if stack else None
                if mcid is not None:
                    marked[mcid]["paint"].append(operator)
                if operator == b"Do":
                    assert page["/Resources"]["/XObject"][operands[0]]["/Subtype"] == "/Image"
                    image_paint.append((mcid, str(operands[0])))
                else:
                    assert mcid is not None, "Every painted text run retains an owner"
        assert not stack
        assert list(marked) == list(range(len(marked)))
        parents = parent_tree[int(page["/StructParents"])]
        assert len(parents) == len(marked)
        seen, figures = {}, []

        def visit(ref, parent):
            node = ref.get_object()
            assert node.raw_get("/P") == parent
            if node["/S"] == "/Figure":
                figures.append(ref)
                assert not _children(ref) and len(_mcids(ref)) == 1
            for mcid in _mcids(ref):
                assert mcid not in seen
                assert node.raw_get("/Pg") == page.indirect_reference
                assert parents[mcid] == ref
                seen[mcid] = ref
                assert marked[mcid]["paint"], "No owner exists for unpainted content"
                if node["/S"] == "/Figure":
                    assert marked[mcid]["role"] == "/Figure"
                    assert marked[mcid]["paint"] == [b"Do"]
                    assert "/ActualText" not in marked[mcid]["properties"]
                else:
                    assert b"Do" not in marked[mcid]["paint"]
                    assert str(marked[mcid]["properties"]["/ActualText"]).strip()
            for child in _children(ref):
                visit(child, ref)

        for child in _children(section_ref):
            visit(child, section_ref)
        assert set(seen) == set(marked)
        logical_text = " ".join(
            str(run["properties"].get("/ActualText", "")) for run in marked.values()
        )
        assert " ".join(page.extract_text().split()) == " ".join(logical_text.split())
        results.append({"figures": figures, "images": image_paint, "marked": marked})
    return results


def test_positioned_figures_preserve_exact_literal_alternatives_and_actual_paint():
    args = _figure_publication()
    body = build_print_pdf(*args)
    assert body == build_print_pdf(*args), "Repeated serialization preserves stable ownership"
    reader = PdfReader(BytesIO(body))
    result, = _inspect(reader)
    assert len(result["figures"]) == len(result["images"]) == 2
    for ref in result["figures"]:
        assert ref.get_object()["/Alt"] == ALT_TEXT
        assert _mcids(ref)[0] in {mcid for mcid, _ in result["images"]}
    assert len({ref.idnum for ref in result["figures"]}) == 2
    siblings = _children(_sections(reader)[0])
    roles = [
        ref.get_object()["/S"] for ref in siblings
        if ref.get_object()["/S"] in {"/H2", "/P", "/Figure"}
    ]
    assert roles == [
        "/H2", "/Figure", "/P", "/Figure",
    ], "Reading order follows authored element order rather than visual position"
    assert b"<FEFF" + ALT_TEXT.encode("utf-16-be").hex().upper().encode("ascii") + b">" in body


def test_repeated_asset_on_another_page_gets_distinct_figure_and_correct_page_parent():
    publication, snapshots, assets = _figure_publication(second_page=True)
    assert len(publication.assets) == 1
    reader = PdfReader(BytesIO(build_print_pdf(publication, snapshots, assets)))
    results = _inspect(reader)
    assert [len(result["figures"]) for result in results] == [2, 1]
    figures = [ref for result in results for ref in result["figures"]]
    assert len({ref.idnum for ref in figures}) == 3
    assert all(ref.get_object()["/Alt"] == ALT_TEXT for ref in figures)
    assert [len(result["images"]) for result in results] == [2, 1]


def test_legacy_missing_or_invalid_alternatives_keep_image_paint_without_fabrication():
    publication, snapshots, assets = _figure_publication()
    values = [_ABSENT, None, "", " \n\t ", 42, "x" * 1001, "\ud800"]
    original = publication.site.pages[0]
    blocks = []
    elements = [_text("heading", "Legacy images retain their paint.", "heading", height=100)]
    for index, value in enumerate(values):
        block = {**original.resource_content["blocks"][0], "id": f"legacy-{index}"}
        if value is _ABSENT:
            block.pop("alt_text")
        else:
            block["alt_text"] = value
        blocks.append(block)
        elements.append(_image_frame(
            f"image-{index}", block["id"], x=30 + (index % 3) * 310,
            y=200 + (index // 3) * 230, width=280, height=200,
        ))
    page = replace(original, resource_content={"blocks": blocks})
    publication = replace(publication, site=replace(publication.site, pages=(page,), print_layout={
        "schemaVersion": "opengeo.print-layout.1.3.0",
        "pages": [{"sitePageSlug": page.slug, "elements": elements}],
    }))
    reader = PdfReader(BytesIO(build_print_pdf(publication, snapshots, assets)))
    result, = _inspect(reader)
    assert result["figures"] == []
    assert len(result["images"]) == len(values)
    assert all(mcid is None for mcid, _ in result["images"])
    without_alt = [
        {key: value for key, value in block.items() if key != "alt_text"} for block in blocks
    ]
    baseline = replace(publication, site=replace(publication.site, pages=(
        replace(page, resource_content={"blocks": without_alt}),
    )))
    baseline_reader = PdfReader(BytesIO(build_print_pdf(baseline, snapshots, assets)))
    assert ContentStream(reader.pages[0].get_contents(), reader).operations == ContentStream(
        baseline_reader.pages[0].get_contents(), baseline_reader
    ).operations, "Invalid or missing alternatives leave every paint operator unchanged"


def test_missing_sealed_image_fails_before_any_figure_owner(monkeypatch):
    publication, snapshots, assets = _figure_publication()
    figure_roles = []
    original = site_print._PdfFontCatalog.tag

    def observe(self, role, **options):
        if role == "Figure":
            figure_roles.append(role)
        return original(self, role, **options)

    monkeypatch.setattr(site_print._PdfFontCatalog, "tag", observe)
    for candidate, bodies in [(publication, {}), (replace(publication, assets=()), assets)]:
        with pytest.raises(SitePrintError, match="site_print_layout_image_not_sealed"):
            build_print_pdf(candidate, snapshots, bodies)
    assert figure_roles == []


def test_figure_survives_normal_composition_with_authoritative_tagged_source_pages():
    from test_pdf_print_documents import prepared_vector_fixture
    from test_site_print import _publication_with_vector_document

    source_body = prepared_vector_fixture()
    publication, document_asset = _publication_with_vector_document(source_body)
    image_publication, _, assets = _figure_publication()
    original = publication.site.pages[0]
    image_block = image_publication.site.pages[0].resource_content["blocks"][0]
    first = replace(original, resource_content={
        "blocks": [*original.resource_content["blocks"], image_block],
    })
    after = replace(
        original, slug="after-import", position=1, is_home=False,
        resource_title="After imported pages",
        resource_content={"blocks": [original.resource_content["blocks"][-1]]},
    )
    publication = replace(
        publication,
        assets=(*publication.assets, *image_publication.assets),
        site=replace(publication.site, pages=(first, after), print_layout={
            "schemaVersion": "opengeo.print-layout.1.3.0",
            "pages": [{
                "sitePageSlug": first.slug,
                "elements": [
                    _text("before", "Before imported pages", "heading", height=100),
                    _image_frame("photo"),
                ],
            }],
        }),
    )
    assets = {**assets, document_asset.object_id: source_body}
    reader = PdfReader(BytesIO(build_print_pdf(publication, {}, assets)))
    assert len(reader.pages) == 3
    results = _inspect(reader)
    assert [len(result["figures"]) for result in results] == [1, 0, 0]
    figure = results[0]["figures"][0]
    assert figure.get_object()["/Alt"] == ALT_TEXT
    assert figure.get_object()["/K"] == results[0]["images"][0][0]
    imported = reader.pages[1]
    assert imported.rotation == 90 and list(imported.cropbox) == [10, 15, 290, 280]
    assert "/Annots" not in imported
    extracted = [page.extract_text() for page in reader.pages]
    assert "Before imported pages" in extracted[0]
    assert "First authored" in extracted[1] and "Second authored" in extracted[1]
    assert "After imported pages" in extracted[2]
    imported_tags = _children(_sections(reader)[1])
    assert len(imported_tags) == 2
    assert [ref.get_object()["/S"] for ref in imported_tags] == ["/P", "/P"]
    assert [_mcids(ref) for ref in imported_tags] == [[0], [1]]
