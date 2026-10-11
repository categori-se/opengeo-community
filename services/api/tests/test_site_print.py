import json
import struct
import zlib
from dataclasses import replace
from hashlib import sha256
from io import BytesIO
from uuid import UUID
from zipfile import ZipFile

import pytest

from opengeo_api.print_text import layout_print_text
from opengeo_api.site_export import build_static_package
from opengeo_api.site_print import (
    MAX_PRINT_COMPOSITE_BITMAPS,
    SitePrintError,
    _PdfFontCatalog,
    build_map_sheet_svg,
    build_print_page_png,
    build_print_pdf,
)
from opengeo_api.site_publications import (
    PublishedLegendItem,
    PublishedMapLegend,
    PublishedMapSnapshot,
    PublishedSiteAsset,
)
from test_site_export import IMAGE_OBJECT_ID, MAP_RESOURCE_ID, published_site


def png(width: int = 32, height: int = 20) -> bytes:
    pixels = bytes((23, 107, 135, 224)) * width
    rows = b"".join(b"\x00" + pixels for _ in range(height))

    def chunk(kind: bytes, value: bytes) -> bytes:
        return (
            struct.pack(">I", len(value))
            + kind
            + value
            + struct.pack(">I", zlib.crc32(kind + value) & 0xFFFFFFFF)
        )

    return b"".join(
        (
            b"\x89PNG\r\n\x1a\n",
            chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)),
            chunk(b"IDAT", zlib.compress(rows, level=9)),
            chunk(b"IEND", b""),
        )
    )


def assert_pdf_maps_text(pdf: bytes, value: str) -> None:
    for character in set(value):
        encoded = character.encode("utf-16-be").hex().upper().encode("ascii")
        assert b"<" + encoded + b">" in pdf


def publication_with_snapshot():
    publication = published_site()
    body = png()
    snapshot = PublishedMapSnapshot(
        render_job_id=publication.references[0].resource_id,
        output_object_id=publication.references[0].version_id,
        storage_version_id="s3-version-1",
        content_type="image/png",
        size_bytes=len(body),
        checksum_sha256=sha256(body).hexdigest(),
        width=32,
        height=20,
        bbox=(-71.2, 42.2, -71.0, 42.4),
        crs="EPSG:3857",
        legend=PublishedMapLegend(
            title="Survey status",
            profile_checksum_sha256="c" * 64,
            items=(
                PublishedLegendItem("Verified", "fill", "#176b87", 0.8),
                PublishedLegendItem("Other", "fill", "#d8e8ed", 0.8),
            ),
        ),
    )
    return (
        replace(
            publication,
            references=(replace(publication.references[0], snapshot=snapshot),),
        ),
        body,
    )


def test_builds_deterministic_pdf_with_checksum_bound_map_appendix() -> None:
    publication, body = publication_with_snapshot()
    first = build_print_pdf(publication, {MAP_RESOURCE_ID: body})
    second = build_print_pdf(publication, {MAP_RESOURCE_ID: body})

    assert first == second
    assert first.startswith(b"%PDF-1.4")
    assert b"/Subtype /Image" in first
    assert b"/Subtype /Type3" in first
    assert b"/ToUnicode" in first
    assert_pdf_maps_text(first, "Findings")
    assert_pdf_maps_text(first, "Detailed findings")
    assert_pdf_maps_text(first, "Critical context")
    assert_pdf_maps_text(first, publication.references[0].snapshot.checksum_sha256)
    assert first.endswith(b"%%EOF\n")


def test_pdf_catalog_bounds_total_composite_bitmap_work() -> None:
    catalog = _PdfFontCatalog()
    for character in ("א", "ב", "ג", "ד"):
        catalog.encode_layout(layout_print_text(character * 4_096))

    assert catalog._composite_bitmaps == MAX_PRINT_COMPOSITE_BITMAPS
    with pytest.raises(SitePrintError, match="site_print_composite_bitmap_limit_exceeded"):
        catalog.encode_layout(layout_print_text("ה"))


def test_static_package_embeds_snapshot_and_uses_it_as_progressive_fallback() -> None:
    publication, body = publication_with_snapshot()
    package = build_static_package(
        publication,
        public_project_root="https://geo.example.test/public/organizations/o/projects/p",
        map_images={MAP_RESOURCE_ID: body},
    )

    with ZipFile(BytesIO(package)) as archive:
        path = f"assets/maps/{MAP_RESOURCE_ID}.png"
        assert archive.read(path) == body
        document = archive.read("index.html").decode("utf-8")
        assert f'src="{path}"' in document
        assert f'data-static-src="{path}"' in document
        sheet = archive.read(f"print/maps/{MAP_RESOURCE_ID}.svg")
        assert b"data:image/png;base64," in sheet
        assert publication.references[0].snapshot.checksum_sha256.encode() in sheet
        report = json.loads(archive.read("conversion-report.json"))
        assert report["status"] == "complete"
        assert report["print"] == {
            "layout": "flow",
            "northArrow": True,
            "orientation": "landscape",
            "pageSize": "a4",
            "pdf": "request-driven",
            "positionedPages": 0,
            "scaleBar": True,
            "selfContainedSvgMapSheets": 1,
            "sourcePanel": True,
            "wholePagePng": "request-driven-96-dpi",
        }


def test_print_rejects_bytes_that_do_not_match_the_edition_seal() -> None:
    publication, body = publication_with_snapshot()
    with pytest.raises(SitePrintError, match="site_snapshot_checksum_mismatch"):
        build_print_pdf(publication, {MAP_RESOURCE_ID: body + b"changed"})


def test_map_sheet_layout_honors_sealed_page_and_furniture_options() -> None:
    publication, body = publication_with_snapshot()
    publication = replace(
        publication,
        site=replace(
            publication.site,
            theme_options={
                "printPageSize": "a3",
                "printOrientation": "portrait",
                "printLayout": "map-sheet",
                "printLegend": "true",
                "printNorthArrow": "true",
                "printScaleBar": "true",
            },
        ),
    )

    pdf = build_print_pdf(publication, {MAP_RESOURCE_ID: body})
    first = build_map_sheet_svg(publication, publication.references[0], body)
    second = build_map_sheet_svg(publication, publication.references[0], body)

    assert b"/MediaBox [0 0 842 1191]" in pdf
    assert_pdf_maps_text(pdf, "Survey status")
    assert_pdf_maps_text(pdf, "N")
    assert_pdf_maps_text(pdf, "cm")
    assert_pdf_maps_text(pdf, "Map SHA-256")
    assert first == second
    assert first.startswith(b'<?xml version="1.0" encoding="UTF-8"?>')
    assert b'width="842pt" height="1191pt"' in first
    assert b'role="img" aria-labelledby="sheet-title sheet-description"' in first
    assert b'href="data:image/png;base64,' in first
    assert b">Survey status</text>" in first
    assert b">Verified</text>" in first
    assert b">N</text>" in first
    assert b" cm" in first
    assert publication.references[0].snapshot.checksum_sha256.encode() in first
    assert b"<script" not in first


def test_map_sheet_rejects_invalid_legacy_print_options() -> None:
    publication, body = publication_with_snapshot()
    publication = replace(
        publication,
        site=replace(publication.site, theme_options={"printPageSize": "wall"}),
    )

    with pytest.raises(SitePrintError, match="site_print_option_printPageSize_invalid"):
        build_map_sheet_svg(publication, publication.references[0], body)


def test_positioned_multi_frame_pdf_and_whole_page_png_are_deterministic() -> None:
    publication, body = publication_with_snapshot()
    resource_id = publication.references[0].resource_id
    publication = replace(
        publication,
        site=replace(
            publication.site,
            print_layout={
                "schemaVersion": "opengeo.print-layout.1.0.0",
                "pages": [
                    {
                        "sitePageSlug": "findings",
                        "elements": [
                            {
                                "id": "title",
                                "type": "text",
                                "x": 40,
                                "y": 30,
                                "width": 920,
                                "height": 80,
                                "text": "Two independently positioned sealed maps",
                                "style": "title",
                            },
                            {
                                "id": "map_1",
                                "type": "map_frame",
                                "x": 40,
                                "y": 140,
                                "width": 430,
                                "height": 620,
                                "resourceId": str(resource_id),
                            },
                            {
                                "id": "map_2",
                                "type": "map_frame",
                                "x": 500,
                                "y": 140,
                                "width": 460,
                                "height": 620,
                                "resourceId": str(resource_id),
                            },
                            {
                                "id": "sources",
                                "type": "source_panel",
                                "x": 40,
                                "y": 790,
                                "width": 500,
                                "height": 150,
                                "mapFrameId": "map_1",
                            },
                            {
                                "id": "north",
                                "type": "north_arrow",
                                "x": 700,
                                "y": 800,
                                "width": 80,
                                "height": 120,
                                "mapFrameId": "map_2",
                            },
                            {
                                "id": "scale",
                                "type": "scale_bar",
                                "x": 800,
                                "y": 820,
                                "width": 160,
                                "height": 90,
                                "mapFrameId": "map_2",
                            },
                        ],
                    }
                ],
            },
        ),
    )

    pdf = build_print_pdf(publication, {resource_id: body})
    first = build_print_page_png(publication, "findings", {resource_id: body})
    second = build_print_page_png(publication, "findings", {resource_id: body})

    assert b"/Map0" in pdf and b"/Map1" in pdf
    assert pdf.count(b" Do Q") == 2
    assert_pdf_maps_text(pdf, "Two independently positioned sealed maps")
    assert first == second
    assert first.startswith(b"\x89PNG\r\n\x1a\n")
    assert struct.unpack(">II", first[16:24]) == (1123, 793)
    assert b"OpenGeo deterministic print renderer" in first
    assert publication.edition.manifest_checksum_sha256.encode() in first


def test_rich_positioned_layout_renders_exact_legend_image_table_and_chart() -> None:
    publication, map_body = publication_with_snapshot()
    image_body = png(20, 32)
    page = publication.site.pages[0]
    blocks = list(page.resource_content["blocks"])
    blocks.append(
        {
            "id": "field-photo",
            "type": "image",
            "object_id": str(IMAGE_OBJECT_ID),
            "alt_text": "Survey team recording a verified location.",
            "caption": "Field evidence",
        }
    )
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
    elements = [
        {
            "id": "map_1",
            "type": "map_frame",
            "x": 30,
            "y": 40,
            "width": 580,
            "height": 500,
            "rotation": -8,
            "clip": True,
            "resourceId": str(MAP_RESOURCE_ID),
            "fit": "cover",
        },
        {
            "id": "legend",
            "type": "legend_frame",
            "x": 650,
            "y": 40,
            "width": 310,
            "height": 220,
            "rotation": 0,
            "clip": True,
            "mapFrameId": "map_1",
        },
        {
            "id": "photo",
            "type": "image_frame",
            "x": 650,
            "y": 290,
            "width": 310,
            "height": 250,
            "rotation": 12,
            "clip": False,
            "blockId": "field-photo",
            "fit": "contain",
        },
        {
            "id": "results",
            "type": "table_frame",
            "x": 30,
            "y": 590,
            "width": 440,
            "height": 350,
            "rotation": 0,
            "clip": True,
            "blockId": "survey-table",
        },
        {
            "id": "coverage",
            "type": "chart_frame",
            "x": 510,
            "y": 590,
            "width": 450,
            "height": 350,
            "rotation": 0,
            "clip": True,
            "blockId": "coverage-chart",
        },
    ]
    publication = replace(
        publication,
        site=replace(
            publication.site,
            pages=(replace(page, resource_content={"blocks": blocks}),),
            print_layout={
                "schemaVersion": "opengeo.print-layout.1.1.0",
                "pages": [{"sitePageSlug": "findings", "elements": elements}],
            },
        ),
        assets=(asset,),
    )

    first_pdf = build_print_pdf(
        publication, {MAP_RESOURCE_ID: map_body}, {IMAGE_OBJECT_ID: image_body}
    )
    second_pdf = build_print_pdf(
        publication, {MAP_RESOURCE_ID: map_body}, {IMAGE_OBJECT_ID: image_body}
    )
    first_png = build_print_page_png(
        publication, "findings", {MAP_RESOURCE_ID: map_body}, {IMAGE_OBJECT_ID: image_body}
    )
    second_png = build_print_page_png(
        publication, "findings", {MAP_RESOURCE_ID: map_body}, {IMAGE_OBJECT_ID: image_body}
    )

    assert first_pdf == second_pdf
    assert b"/Map0" in first_pdf and b"/Asset1" in first_pdf
    assert first_pdf.count(b"/Subtype /Image") == 2
    assert_pdf_maps_text(first_pdf, "Survey status Verified")
    assert_pdf_maps_text(first_pdf, "Survey results Coverage by district")
    assert b"0.990268" in first_pdf  # deterministic cos(8 degrees) transform
    assert first_png == second_png
    assert first_png.startswith(b"\x89PNG\r\n\x1a\n")
    assert struct.unpack(">II", first_png[16:24]) == (1123, 793)

    with pytest.raises(SitePrintError, match="site_print_layout_image_not_sealed"):
        build_print_pdf(
            publication, {MAP_RESOURCE_ID: map_body}, {IMAGE_OBJECT_ID: image_body + b"changed"}
        )


def test_positioned_layout_rejects_missing_map_frame_and_unsealed_map() -> None:
    publication, body = publication_with_snapshot()
    invalid = {
        "schemaVersion": "opengeo.print-layout.1.0.0",
        "pages": [
            {
                "sitePageSlug": "findings",
                "elements": [
                    {
                        "id": "north",
                        "type": "north_arrow",
                        "x": 10,
                        "y": 10,
                        "width": 100,
                        "height": 100,
                        "mapFrameId": "missing",
                    }
                ],
            }
        ],
    }
    publication = replace(publication, site=replace(publication.site, print_layout=invalid))
    with pytest.raises(SitePrintError, match="site_print_layout_map_frame_not_found"):
        build_print_page_png(publication, "findings", {MAP_RESOURCE_ID: body})


def test_pdf_embeds_searchable_unicode_and_png_rasterizes_the_same_text() -> None:
    publication, body = publication_with_snapshot()
    page = publication.site.pages[0]
    title = "Résumé — Ω Ж 中文 🌍"

    def with_text(value: str):
        return replace(
            publication,
            site=replace(
                publication.site,
                pages=(replace(page, resource_title=title),),
                print_layout={
                    "schemaVersion": "opengeo.print-layout.1.1.0",
                    "pages": [
                        {
                            "sitePageSlug": "findings",
                            "elements": [
                                {
                                    "id": "unicode",
                                    "type": "text",
                                    "x": 40,
                                    "y": 40,
                                    "width": 920,
                                    "height": 300,
                                    "rotation": 0,
                                    "clip": True,
                                    "text": value,
                                    "style": "title",
                                }
                            ],
                        }
                    ],
                },
            ),
        )

    unicode_publication = with_text(title)
    pdf = build_print_pdf(unicode_publication, {MAP_RESOURCE_ID: body})
    unicode_png = build_print_page_png(unicode_publication, "findings", {MAP_RESOURCE_ID: body})
    ascii_png = build_print_page_png(
        with_text("???????????????"), "findings", {MAP_RESOURCE_ID: body}
    )

    assert b"/Subtype /Type3" in pdf
    assert b"/ToUnicode" in pdf
    assert_pdf_maps_text(pdf, title)
    assert title.encode("utf-8") in unicode_png
    assert unicode_png != ascii_png


def test_pdf_and_png_share_bidi_order_and_arabic_shaping_with_logical_actual_text() -> None:
    publication, body = publication_with_snapshot()
    page = publication.site.pages[0]
    logical = "OpenGeo: مرحبا بالعالم 123 · שלום"
    publication = replace(
        publication,
        site=replace(
            publication.site,
            pages=(replace(page, resource_title=logical),),
            print_layout={
                "schemaVersion": "opengeo.print-layout.1.1.0",
                "pages": [
                    {
                        "sitePageSlug": "findings",
                        "elements": [
                            {
                                "id": "bidi",
                                "type": "text",
                                "x": 40,
                                "y": 40,
                                "width": 920,
                                "height": 300,
                                "rotation": 0,
                                "clip": True,
                                "text": logical,
                                "style": "title",
                            }
                        ],
                    }
                ],
            },
        ),
    )

    pdf = build_print_pdf(publication, {MAP_RESOURCE_ID: body})
    raster = build_print_page_png(publication, "findings", {MAP_RESOURCE_ID: body})
    layout = layout_print_text(logical)
    actual_text = (b"\xfe\xff" + logical.encode("utf-16-be")).hex().upper().encode("ascii")

    assert layout.visual == "OpenGeo: םולש · 123 ﻢﻟﺎﻌﻟﺎﺑ ﺎﺒﺣﺮﻣ"
    assert b"/ActualText <" + actual_text + b">" in pdf
    assert b"<" + logical.encode("utf-16-be").hex().upper().encode("ascii") + b">" in pdf
    assert logical.encode("utf-8") in raster


def test_print_rejects_invisible_bidi_override_controls() -> None:
    publication, body = publication_with_snapshot()
    page = publication.site.pages[0]
    publication = replace(
        publication,
        site=replace(
            publication.site,
            print_layout={
                "schemaVersion": "opengeo.print-layout.1.1.0",
                "pages": [
                    {
                        "sitePageSlug": "findings",
                        "elements": [
                            {
                                "id": "spoof",
                                "type": "text",
                                "x": 40,
                                "y": 40,
                                "width": 920,
                                "height": 300,
                                "rotation": 0,
                                "clip": True,
                                "text": "safe\u202eevil",
                                "style": "title",
                            }
                        ],
                    }
                ],
            },
            pages=(page,),
        ),
    )

    with pytest.raises(SitePrintError, match="site_print_bidi_control_forbidden"):
        build_print_pdf(publication, {MAP_RESOURCE_ID: body})
    with pytest.raises(SitePrintError, match="site_print_bidi_control_forbidden"):
        build_print_page_png(publication, "findings", {MAP_RESOURCE_ID: body})


def test_pdf_splits_more_than_255_distinct_unicode_glyphs_across_embedded_banks() -> None:
    publication, body = publication_with_snapshot()
    page = publication.site.pages[0]
    value = "".join(chr(0x4E00 + index) for index in range(300))
    publication = replace(
        publication,
        site=replace(
            publication.site,
            print_layout={
                "schemaVersion": "opengeo.print-layout.1.1.0",
                "pages": [
                    {
                        "sitePageSlug": "findings",
                        "elements": [
                            {
                                "id": "unicode",
                                "type": "text",
                                "x": 10,
                                "y": 10,
                                "width": 980,
                                "height": 980,
                                "rotation": 0,
                                "clip": True,
                                "text": value,
                                "style": "body",
                            }
                        ],
                    }
                ],
            },
            pages=(page,),
        ),
    )

    pdf = build_print_pdf(publication, {MAP_RESOURCE_ID: body})

    assert b"/F1" in pdf and b"/F2" in pdf
    assert pdf.count(b"/Subtype /Type3") >= 2
    assert_pdf_maps_text(pdf, value)


def test_pdf_rejects_more_than_the_bounded_distinct_glyph_budget() -> None:
    publication, body = publication_with_snapshot()
    values = (
        "".join(chr(0x1000 + index) for index in range(600)),
        "".join(chr(0x4000 + index) for index in range(600)),
    )
    publication = replace(
        publication,
        site=replace(
            publication.site,
            print_layout={
                "schemaVersion": "opengeo.print-layout.1.1.0",
                "pages": [
                    {
                        "sitePageSlug": "findings",
                        "elements": [
                            {
                                "id": f"unicode_{index}",
                                "type": "text",
                                "x": 10,
                                "y": 10,
                                "width": 980,
                                "height": 980,
                                "rotation": 0,
                                "clip": True,
                                "text": value,
                                "style": "body",
                            }
                            for index, value in enumerate(values)
                        ],
                    }
                ],
            },
        ),
    )

    with pytest.raises(SitePrintError, match="site_print_unicode_glyph_limit_exceeded"):
        build_print_pdf(publication, {MAP_RESOURCE_ID: body})
