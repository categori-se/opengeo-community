import json

import pytest

from opengeo_api.spatial_previews import SpatialPreviewInvalid, parse_spatial_preview


def valid_preview() -> dict[str, object]:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": "road-1",
                "properties": {"name": "Bounded road", "inspected": True},
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[-71.2, 42.2], [-71.0, 42.4]],
                },
            }
        ],
    }


def test_constrained_geojson_preview_accepts_valid_wgs84_features() -> None:
    document = valid_preview()

    assert parse_spatial_preview(json.dumps(document).encode()) == document


def test_constrained_geojson_preview_accepts_null_feature_properties() -> None:
    document = valid_preview()
    features = document["features"]
    assert isinstance(features, list)
    feature = features[0]
    assert isinstance(feature, dict)
    feature["properties"] = None

    assert parse_spatial_preview(json.dumps(document).encode()) == document


def test_constrained_geojson_preview_omits_bounded_foreign_root_metadata() -> None:
    document = {
        **valid_preview(),
        "id": "source-collection",
        "opengeo:capture": {
            "source": {"url": "https://provider.invalid/original", "unknown": None},
            "storage": {"bucket": "private", "key": "original.geojson"},
            "count": 1,
        },
        "remoteUrl": "https://provider.invalid/other",
    }

    assert parse_spatial_preview(json.dumps(document).encode()) == valid_preview()


@pytest.mark.parametrize(
    "foreign",
    [
        {"crs": None},
        {"crs": {"type": "name", "properties": {"name": "EPSG:3857"}}},
        {"coordinates": [0, 0]},
        {"geometry": {"type": "Point", "coordinates": [0, 0]}},
        {"properties": {}},
    ],
)
def test_constrained_geojson_preview_rejects_crs_and_misplaced_standard_members(
    foreign: dict[str, object],
) -> None:
    with pytest.raises(SpatialPreviewInvalid, match="spatial_preview_invalid"):
        parse_spatial_preview(json.dumps({**valid_preview(), **foreign}).encode())


@pytest.mark.parametrize(
    "value",
    [
        [[[[[[[[[[None]]]]]]]]]],
        "x" * 8_193,
        [None] * 1_025,
        {str(index): None for index in range(257)},
    ],
)
def test_constrained_geojson_preview_bounds_ignored_foreign_values(value: object) -> None:
    document = {**valid_preview(), "metadata": value}

    with pytest.raises(SpatialPreviewInvalid, match="spatial_preview_invalid"):
        parse_spatial_preview(json.dumps(document).encode())


@pytest.mark.parametrize("key", ["", "x" * 257, "nul\0key"])
def test_constrained_geojson_preview_bounds_foreign_member_names(key: str) -> None:
    with pytest.raises(SpatialPreviewInvalid, match="spatial_preview_invalid"):
        parse_spatial_preview(json.dumps({**valid_preview(), key: None}).encode())


def test_constrained_geojson_preview_shares_foreign_and_feature_json_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("opengeo_api.spatial_previews.MAX_SPATIAL_PREVIEW_JSON_NODES", 12)
    document = {"type": "FeatureCollection", "features": [], "metadata": [None] * 7}
    assert parse_spatial_preview(json.dumps(document).encode())["features"] == []
    document["features"] = valid_preview()["features"]

    with pytest.raises(SpatialPreviewInvalid, match="spatial_preview_invalid"):
        parse_spatial_preview(json.dumps(document).encode())


def test_constrained_geojson_preview_rejects_deep_foreign_json_with_typed_error() -> None:
    content = (
        b'{"type":"FeatureCollection","features":[],"metadata":'
        + b"[" * 2_000
        + b"null"
        + b"]" * 2_000
        + b"}"
    )

    with pytest.raises(SpatialPreviewInvalid, match="spatial_preview_invalid"):
        parse_spatial_preview(content)


@pytest.mark.parametrize(
    "bbox",
    [
        [177.0, -20.0, -178.0, -16.0],
        [-180.0, 80.0, 180.0, 90.0],
        [177.0, -20.0, -100.0, -178.0, -16.0, 25.0],
    ],
)
def test_constrained_geojson_preview_accepts_rfc7946_edge_bounding_boxes(
    bbox: list[float],
) -> None:
    document = {**valid_preview(), "bbox": bbox}

    assert parse_spatial_preview(json.dumps(document).encode())["bbox"] == bbox


@pytest.mark.parametrize(
    "bbox",
    [
        [-180.0, 20.0, 180.0, 10.0],
        [-180.0, -91.0, 180.0, 10.0],
        [181.0, -20.0, -178.0, -16.0],
        [177.0, -20.0, -181.0, -16.0],
        [-180.0, -20.0, 100.0, 180.0, 20.0, -100.0],
    ],
)
def test_constrained_geojson_preview_rejects_invalid_rfc7946_bounding_boxes(
    bbox: list[float],
) -> None:
    document = {**valid_preview(), "bbox": bbox}

    with pytest.raises(SpatialPreviewInvalid, match="spatial_preview_invalid"):
        parse_spatial_preview(json.dumps(document).encode())


@pytest.mark.parametrize(
    "content",
    [
        b'{"type":"FeatureCollection","features":[],"features":[]}',
        b'{"type":"FeatureCollection","features":[],"metadata":{"x":1,"x":2}}',
        b'{"type":"FeatureCollection","features":[],"metadata":{"value":NaN}}',
        b'{"type":"FeatureCollection","features":[],"metadata":{"value":1e400}}',
        b'{"type":"FeatureCollection","features":[{"type":"Feature",'
        b'"properties":{"value":NaN},"geometry":null}]}',
        b'{"type":"FeatureCollection","features":[{"type":"Feature",'
        b'"properties":{},"geometry":{"type":"Point","coordinates":[0,91]}}]}',
    ],
)
def test_constrained_geojson_preview_rejects_widened_or_unsafe_content(
    content: bytes,
) -> None:
    with pytest.raises(SpatialPreviewInvalid, match="spatial_preview_invalid"):
        parse_spatial_preview(content)


def test_constrained_geojson_preview_has_one_global_position_budget() -> None:
    positions = [[0, 0]] * 100_001
    document = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": feature_id,
                "properties": {},
                "geometry": {"type": "MultiPoint", "coordinates": positions},
            }
            for feature_id in (1, 2)
        ],
    }

    with pytest.raises(SpatialPreviewInvalid, match="spatial_preview_invalid"):
        parse_spatial_preview(json.dumps(document).encode())
