from datetime import UTC, datetime
from uuid import UUID

import pytest

from opengeo_api.arcgis_compat import (
    ARCGIS_CRS84_WKID,
    ArcgisCompatibilityError,
    arcgis_object_id,
    feature_page_document,
    parse_envelope,
    parse_object_ids,
    validate_callback,
)
from opengeo_api.features import (
    FeatureCollection,
    FeatureField,
    FeatureFieldCondition,
    FeaturePage,
    FeatureRecord,
)

ACTOR_ID = UUID("20000000-0000-4000-8000-000000000070")
DATASET_ID = UUID("80000000-0000-4000-8000-000000000070")
FEATURE_ID = UUID("90000000-0000-4000-8000-000000000070")
NOW = datetime(2026, 9, 1, 17, tzinfo=UTC)


def page(geometry_type, coordinates, *, fields=None):
    if fields is None:
        fields = (FeatureField("name", "string", True),)
    collection = FeatureCollection(
        DATASET_ID,
        geometry_type,
        fields,
        1,
        1,
        ACTOR_ID,
        NOW,
        ACTOR_ID,
        NOW,
    )
    record = FeatureRecord(
        FEATURE_ID,
        2,
        geometry_type,
        {"type": geometry_type, "coordinates": coordinates},
        (-77.1, 38.8, -76.9, 39.0),
        {field.name: "Road" for field in fields},
        ACTOR_ID,
        NOW,
        ACTOR_ID,
        NOW,
    )
    return FeaturePage(collection, (record,), 1, 100, 0)


@pytest.mark.parametrize(
    ("geometry_type", "coordinates", "geometry_key", "member_count"),
    [
        ("Point", [-77.0, 38.9], "x", None),
        ("MultiPoint", [[-77.0, 38.9], [-76.9, 39.0]], "points", 2),
        ("LineString", [[-77.0, 38.9], [-76.9, 39.0]], "paths", 1),
        (
            "MultiLineString",
            [[[-77.0, 38.9], [-76.9, 39.0]], [[-77.1, 38.8], [-77.0, 38.9]]],
            "paths",
            2,
        ),
        (
            "Polygon",
            [[[-77.1, 38.8], [-76.9, 38.8], [-76.9, 39.0], [-77.1, 38.8]]],
            "rings",
            1,
        ),
        (
            "MultiPolygon",
            [
                [[[-77.1, 38.8], [-77.0, 38.8], [-77.0, 38.9], [-77.1, 38.8]]],
                [[[-77.0, 38.9], [-76.9, 38.9], [-76.9, 39.0], [-77.0, 38.9]]],
            ],
            "rings",
            2,
        ),
    ],
)
def test_arcgis_serializer_covers_declared_geometry_families(
    geometry_type, coordinates, geometry_key, member_count
) -> None:
    source = page(geometry_type, coordinates)
    object_id = arcgis_object_id(FEATURE_ID)
    document = feature_page_document(
        source,
        out_wkid=ARCGIS_CRS84_WKID,
        object_ids=(object_id,),
    )
    geometry = document["features"][0]["geometry"]

    assert document["features"][0]["attributes"]["OBJECTID"] == object_id
    assert geometry["spatialReference"] == {"wkid": 4326}
    assert geometry_key in geometry
    if member_count is not None:
        assert len(geometry[geometry_key]) == member_count


def test_arcgis_polygon_rings_are_oriented_for_arcgis() -> None:
    source = page(
        "Polygon",
        [
            [[0, 0], [2, 0], [2, 2], [0, 0]],
            [[0.5, 0.5], [0.5, 1], [1, 0.5], [0.5, 0.5]],
        ],
    )
    document = feature_page_document(
        source,
        out_wkid=4326,
        object_ids=(arcgis_object_id(FEATURE_ID),),
    )
    outer, hole = document["features"][0]["geometry"]["rings"]

    assert _signed_area(outer) < 0
    assert _signed_area(hole) > 0


def test_arcgis_compatibility_parsers_are_bounded_and_fail_closed() -> None:
    envelope = parse_envelope(
        '{"xmin":-78,"ymin":38,"xmax":-76,"ymax":40}',
        in_wkid=4326,
    )
    assert envelope == (-78, 38, -76, 40)
    assert parse_object_ids("1,2,3") == (1, 2, 3)
    assert validate_callback("reqwest_1788278400000_1") == "reqwest_1788278400000_1"

    with pytest.raises(ArcgisCompatibilityError, match="arcgis_geometry_invalid"):
        parse_envelope('{"xmin":-78,"ymin":38,"xmax":-76}', in_wkid=4326)
    with pytest.raises(ArcgisCompatibilityError, match="arcgis_object_ids_duplicate"):
        parse_object_ids("1,1")
    with pytest.raises(ArcgisCompatibilityError, match="arcgis_object_ids_limit_exceeded"):
        parse_object_ids(",".join(str(index) for index in range(1, 102)))
    with pytest.raises(ArcgisCompatibilityError, match="arcgis_callback_invalid"):
        validate_callback("alert(1)")


def test_arcgis_reserved_field_collisions_fail_closed() -> None:
    source = page(
        "Point",
        [-77.0, 38.9],
        fields=(FeatureField("OBJECTID", "integer", True),),
    )
    with pytest.raises(ArcgisCompatibilityError, match="arcgis_field_name_collision"):
        feature_page_document(
            source,
            out_wkid=4326,
            object_ids=(arcgis_object_id(FEATURE_ID),),
        )


def test_arcgis_schema_marks_conditionally_required_fields_nullable() -> None:
    source = page(
        "Point",
        [-77.0, 38.9],
        fields=(
            FeatureField("kind", "string", True),
            FeatureField(
                "detail",
                "string",
                True,
                visible_when=FeatureFieldCondition("kind", "Road"),
            ),
        ),
    )
    document = feature_page_document(
        source,
        out_wkid=4326,
        object_ids=(arcgis_object_id(FEATURE_ID),),
    )
    fields = {field["name"]: field for field in document["fields"]}

    assert fields["kind"]["nullable"] is False
    assert fields["detail"]["nullable"] is True


def test_arcgis_compatibility_serializes_structured_groups_as_canonical_json() -> None:
    group = FeatureField(
        "samples",
        "group",
        True,
        fields=(FeatureField("value", "number", True),),
        repeat=True,
        min_items=1,
        max_items=4,
    )
    collection = FeatureCollection(
        DATASET_ID, "Point", (group,), 1, 1, ACTOR_ID, NOW, ACTOR_ID, NOW
    )
    record = FeatureRecord(
        FEATURE_ID,
        1,
        "Point",
        {"type": "Point", "coordinates": [-77.0, 38.9]},
        (-77.0, 38.9, -77.0, 38.9),
        {"samples": [{"value": 2.5}]},
        ACTOR_ID,
        NOW,
        ACTOR_ID,
        NOW,
    )
    document = feature_page_document(
        FeaturePage(collection, (record,), 1, 100, 0),
        out_wkid=4326,
        object_ids=(arcgis_object_id(FEATURE_ID),),
    )
    fields = {field["name"]: field for field in document["fields"]}

    assert fields["samples"]["type"] == "esriFieldTypeString"
    assert fields["samples"]["length"] == 32_768
    assert document["features"][0]["attributes"]["samples"] == '[{"value":2.5}]'


def _signed_area(ring) -> float:
    return sum(
        (ring[index][0] * ring[index + 1][1]) - (ring[index + 1][0] * ring[index][1])
        for index in range(len(ring) - 1)
    )
