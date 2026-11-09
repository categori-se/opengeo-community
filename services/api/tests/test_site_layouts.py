from copy import deepcopy
from uuid import UUID

import pytest

from opengeo_api.site_layouts import SiteLayoutError, empty_print_layout, parse_print_layout

MAP_ID = UUID("a0000000-0000-4000-8000-000000000291")


def rich_layout() -> dict[str, object]:
    return {
        "schemaVersion": "opengeo.print-layout.1.1.0",
        "pages": [
            {
                "sitePageSlug": "findings",
                "elements": [
                    {
                        "id": "map_1",
                        "type": "map_frame",
                        "x": 20,
                        "y": 80,
                        "width": 620,
                        "height": 700,
                        "rotation": -12,
                        "clip": True,
                        "resourceId": str(MAP_ID),
                        "fit": "cover",
                    },
                    {
                        "id": "legend",
                        "type": "legend_frame",
                        "x": 670,
                        "y": 80,
                        "width": 290,
                        "height": 220,
                        "rotation": 0,
                        "clip": True,
                        "mapFrameId": "map_1",
                    },
                    {
                        "id": "photo",
                        "type": "image_frame",
                        "x": 670,
                        "y": 330,
                        "width": 290,
                        "height": 220,
                        "rotation": 8,
                        "clip": False,
                        "blockId": "field_photo",
                        "fit": "contain",
                    },
                    {
                        "id": "results",
                        "type": "table_frame",
                        "x": 20,
                        "y": 820,
                        "width": 450,
                        "height": 140,
                        "rotation": 0,
                        "clip": True,
                        "blockId": "result_table",
                    },
                    {
                        "id": "trend",
                        "type": "chart_frame",
                        "x": 510,
                        "y": 820,
                        "width": 450,
                        "height": 140,
                        "rotation": 0,
                        "clip": True,
                        "blockId": "trend_chart",
                    },
                ],
            }
        ],
    }


def test_rich_layout_round_trips_and_is_the_empty_document_default() -> None:
    layout = rich_layout()
    parsed = parse_print_layout(layout)

    assert empty_print_layout() == {
        "schemaVersion": "opengeo.print-layout.1.1.0",
        "pages": [],
    }
    assert parsed.as_json() == layout
    assert parsed.pages[0].elements[0].resource_id == MAP_ID
    assert parsed.pages[0].elements[2].block_id == "field_photo"
    assert parsed.pages[0].elements[2].clip is False


@pytest.mark.parametrize(
    ("change", "code"),
    [
        (lambda value: value.update(remoteUrl="https://bad.example"), "shape_invalid"),
        (
            lambda value: value["pages"][0]["elements"][0].update(rotation=181),
            "rotation_invalid",
        ),
        (
            lambda value: value["pages"][0]["elements"][0].update(fit="remote"),
            "fit_invalid",
        ),
        (
            lambda value: value["pages"][0]["elements"][1].update(mapFrameId="missing"),
            "map_frame_not_found",
        ),
        (
            lambda value: value["pages"][0]["elements"][2].update(blockId="https://bad"),
            "block_id_invalid",
        ),
    ],
)
def test_rich_layout_rejects_unbounded_or_unsealed_bindings(change, code: str) -> None:
    layout = deepcopy(rich_layout())
    change(layout)
    with pytest.raises(SiteLayoutError, match=code):
        parse_print_layout(layout)


def test_legacy_positioned_layout_remains_readable_without_mutation() -> None:
    legacy = {
        "schemaVersion": "opengeo.print-layout.1.0.0",
        "pages": [
            {
                "sitePageSlug": "findings",
                "elements": [
                    {
                        "id": "map_1",
                        "type": "map_frame",
                        "x": 20,
                        "y": 80,
                        "width": 620,
                        "height": 700,
                        "resourceId": str(MAP_ID),
                    }
                ],
            }
        ],
    }

    assert parse_print_layout(legacy).as_json() == legacy


def shape_layout() -> dict:
    return {
        "schemaVersion": "opengeo.print-layout.1.2.0",
        "pages": [
            {
                "sitePageSlug": "findings",
                "elements": [
                    {
                        "id": "outline",
                        "type": "shape_frame",
                        "x": 100,
                        "y": 200,
                        "width": 600,
                        "height": 300,
                        "rotation": 35,
                        "clip": False,
                        "shape": "ellipse",
                        "stroke": "#0055aa",
                        "fill": None,
                        "strokeWidth": 4,
                    }
                ],
            }
        ],
    }


def test_shape_layout_round_trips_null_fill_without_resources_or_legacy_changes() -> None:
    from opengeo_api.site_layouts import print_layout_resource_ids

    layout = shape_layout()
    parsed = parse_print_layout(layout)
    assert parsed.as_json() == layout
    assert parsed.pages[0].elements[0].stroke_width == 4
    assert print_layout_resource_ids(layout) == frozenset()
    assert empty_print_layout()["schemaVersion"] == "opengeo.print-layout.1.1.0"
    assert parse_print_layout(rich_layout()).as_json() == rich_layout()


@pytest.mark.parametrize("version", ["opengeo.print-layout.1.0.0", "opengeo.print-layout.1.1.0"])
def test_shapes_are_explicitly_rejected_in_older_layout_versions(version: str) -> None:
    layout = shape_layout()
    layout["schemaVersion"] = version
    with pytest.raises(SiteLayoutError, match="element_type_invalid"):
        parse_print_layout(layout)


@pytest.mark.parametrize(
    "change",
    [
        {"shape": []},
        {"shape": "path"},
        {"stroke": "url(https://example.invalid)"},
        {"stroke": "#aabbcc80"},
        {"fill": "red"},
        {"stroke": None, "fill": None},
        {"shape": "line", "stroke": None, "fill": "#ffffff"},
        {"shape": "line", "fill": "#ffffff"},
        {"strokeWidth": True},
        {"strokeWidth": 0},
        {"strokeWidth": 13},
        {"strokeWidth": 1.5},
        {"path": "M0 0"},
        {"resourceId": str(MAP_ID)},
    ],
)
def test_shape_layout_rejects_active_unbounded_or_invisible_styles(change: dict) -> None:
    layout = shape_layout()
    layout["pages"][0]["elements"][0].update(change)
    with pytest.raises(SiteLayoutError):
        parse_print_layout(layout)


def formatted_layout():
    return {
        "schemaVersion": "opengeo.print-layout.1.3.0",
        "pages": [
            {
                "sitePageSlug": "findings",
                "elements": [
                    {
                        "id": "text",
                        "type": "text",
                        "x": 0,
                        "y": 0,
                        "width": 1000,
                        "height": 200,
                        "rotation": 0,
                        "clip": True,
                        "text": "Exact point size",
                        "style": "body",
                        "fontSize": 12.375,
                        "color": "#336699",
                    }
                ],
            }
        ],
    }


def test_formatted_text_round_trips_fractional_points_and_keeps_default_and_old_keys() -> None:
    layout = formatted_layout()
    assert parse_print_layout(layout).as_json() == layout
    element = parse_print_layout(layout).pages[0].elements[0]
    assert element.font_size == 12.375 and element.color == "#336699"
    assert "fontSize" not in element.as_json("opengeo.print-layout.1.2.0")
    assert empty_print_layout()["schemaVersion"] == "opengeo.print-layout.1.1.0"
    for version in ["1.0.0", "1.1.0", "1.2.0"]:
        older = deepcopy(layout)
        older["schemaVersion"] = f"opengeo.print-layout.{version}"
        with pytest.raises(SiteLayoutError):
            parse_print_layout(older)
    for missing in ["fontSize", "color"]:
        malformed = deepcopy(layout)
        del malformed["pages"][0]["elements"][0][missing]
        with pytest.raises(SiteLayoutError):
            parse_print_layout(malformed)


@pytest.mark.parametrize(
    "value", [True, False, 0, 144.01, float("nan"), float("inf"), "12.5", None]
)
def test_formatted_text_rejects_nonphysical_point_sizes(value) -> None:
    layout = formatted_layout()
    layout["pages"][0]["elements"][0]["fontSize"] = value
    with pytest.raises(SiteLayoutError, match="font_size_invalid"):
        parse_print_layout(layout)


@pytest.mark.parametrize("value", ["#3366AA", "red", "#123", "#123456ff", None])
def test_formatted_text_requires_canonical_rgb(value) -> None:
    layout = formatted_layout()
    layout["pages"][0]["elements"][0]["color"] = value
    with pytest.raises(SiteLayoutError, match="color_invalid"):
        parse_print_layout(layout)
