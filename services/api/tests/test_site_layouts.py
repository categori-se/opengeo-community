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
