import asyncio
import os
from collections import deque
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from psycopg.types.json import Jsonb

from opengeo_api.features import (
    _CUT_MULTIPOLYGON_SQL,
    _DISSOLVE_MULTIPOLYGON_SQL,
    _DISSOLVE_TIMEOUT_SQL,
    _MOVE_SHARED_POLYGON_VERTEX_SQL,
    AttributeQueryStep,
    FeatureAccessDenied,
    FeatureCollection,
    FeatureConflict,
    FeatureInvalid,
    FeatureRecord,
    FeatureTombstonePage,
    PostgresFeatureRepository,
    SpatialQueryStep,
    cut_multipolygon_drafts,
    feature_draft,
    feature_field_document,
    merge_multipolygon_draft,
    normalize_cut_line,
    normalize_fields,
    normalize_geometry,
    normalize_properties,
    normalize_query_geometry,
    separate_multipolygon_drafts,
    shared_polygon_vertex_drafts,
)
from opengeo_api.ogc_features import collection_document
from opengeo_api.tenant_database import TenantContext

FEATURE_ID = UUID("90000000-0000-4000-8000-000000000131")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000131")
DATASET_ID = UUID("80000000-0000-4000-8000-000000000131")
USER_ID = UUID("20000000-0000-4000-8000-000000000131")
ORG_ID = UUID("10000000-0000-4000-8000-000000000131")
LOCK_TOKEN = UUID("a0000000-0000-4000-8000-000000000131")
OTHER_USER_ID = UUID("20000000-0000-4000-8000-000000000132")
NOW = datetime(2026, 8, 26, 12, tzinfo=UTC)


class QueryTransaction:
    def __init__(
        self,
        one: list[tuple[Any, ...] | None],
        all_rows: list[list[tuple[Any, ...]]] | None = None,
    ) -> None:
        self.one = deque(one)
        self.all_rows = deque(all_rows or [])
        self.calls: list[tuple[str, str, tuple[Any, ...]]] = []

    async def fetch_one(self, statement: str, parameters=()):
        self.calls.append(("one", statement, tuple(parameters)))
        assert self.one, f"unexpected fetch_one: {statement}"
        return self.one.popleft()

    async def fetch_all(self, statement: str, parameters=()):
        self.calls.append(("all", statement, tuple(parameters)))
        assert self.all_rows, f"unexpected fetch_all: {statement}"
        return self.all_rows.popleft()

    async def execute(self, statement: str, parameters=()):
        self.calls.append(("execute", statement, tuple(parameters)))
        return 1


class QueryExecutor:
    def __init__(self, transaction: QueryTransaction) -> None:
        self.transaction = transaction

    async def run(self, context, operation):
        return await operation(self.transaction)

    async def fetch_one(self, context, statement, parameters=()):
        return await self.transaction.fetch_one(statement, parameters)


def test_schema_and_properties_are_scalar_bounded_and_exact() -> None:
    fields = normalize_fields(
        [
            {"name": "name", "type": "string", "required": True},
            {"name": "count", "type": "integer", "required": False},
            {"name": "verified", "type": "boolean", "required": False},
        ]
    )

    assert normalize_properties({"name": "Station", "count": 3, "verified": True}, fields) == {
        "name": "Station",
        "count": 3,
        "verified": True,
    }
    with pytest.raises(FeatureInvalid, match="unknown field"):
        normalize_properties({"name": "Station", "secret": "extra"}, fields)
    with pytest.raises(FeatureInvalid, match="safe integer"):
        normalize_properties({"name": "Station", "count": True}, fields)
    with pytest.raises(FeatureInvalid, match="required"):
        normalize_properties({}, fields)
    with pytest.raises(FeatureInvalid, match="unique"):
        normalize_fields(
            [
                {"name": "Station", "type": "string"},
                {"name": "station", "type": "string"},
            ]
        )


def test_multipolygon_structure_drafts_preserve_identity_attributes_and_bounds() -> None:
    fields = normalize_fields([{"name": "name", "type": "string", "required": True}])
    feature = FeatureRecord(
        FEATURE_ID,
        4,
        "MultiPolygon",
        {
            "type": "MultiPolygon",
            "coordinates": [
                [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
                [[[3, 0], [4, 0], [4, 1], [3, 1], [3, 0]]],
            ],
        },
        (0, 0, 4, 1),
        {"name": "Survey areas"},
        USER_ID,
        NOW,
        USER_ID,
        NOW,
    )

    separated = separate_multipolygon_drafts(feature, fields, 1)

    assert len(separated) == 2
    assert separated[0].feature_id == FEATURE_ID
    assert separated[0].geometry["coordinates"] == [feature.geometry["coordinates"][1]]
    assert separated[0].bbox == (3.0, 0.0, 4.0, 1.0)
    assert separated[1].feature_id != FEATURE_ID
    assert separated[1].properties == {"name": "Survey areas"}
    assert feature.geometry["coordinates"][0][0][0] == [0, 0]

    merged = merge_multipolygon_draft(
        [
            FeatureRecord(
                draft.feature_id,
                1,
                draft.geometry_type,
                draft.geometry,
                draft.bbox,
                draft.properties,
                USER_ID,
                NOW,
                USER_ID,
                NOW,
            )
            for draft in separated
        ],
        fields,
        FEATURE_ID,
    )

    assert merged.feature_id == FEATURE_ID
    assert len(merged.geometry["coordinates"]) == 2
    assert merged.properties == {"name": "Survey areas"}
    with pytest.raises(FeatureInvalid, match="at least two parts"):
        separate_multipolygon_drafts(
            replace(
                feature,
                geometry={
                    "type": "MultiPolygon",
                    "coordinates": separated[0].geometry["coordinates"],
                },
            ),
            fields,
            0,
        )
    with pytest.raises(FeatureInvalid, match="must be first"):
        merge_multipolygon_draft(
            [
                replace(feature, feature_id=UUID("90000000-0000-4000-8000-000000000132")),
                feature,
            ],
            fields,
            FEATURE_ID,
        )


def test_schema_fields_carry_bounded_capture_rules_into_value_validation() -> None:
    fields = normalize_fields(
        [
            {
                "name": "status",
                "type": "string",
                "required": True,
                "label": " Review status ",
                "description": " Choose the current state. ",
                "choices": ["Open", "Closed"],
                "min_length": 4,
                "max_length": 6,
            },
            {
                "name": "score",
                "type": "number",
                "minimum": 0,
                "maximum": 100,
            },
        ]
    )

    assert feature_field_document(fields[0]) == {
        "name": "status",
        "type": "string",
        "required": True,
        "label": "Review status",
        "description": "Choose the current state.",
        "choices": ["Open", "Closed"],
        "min_length": 4,
        "max_length": 6,
    }
    assert normalize_properties({"status": "Open", "score": 82.5}, fields) == {
        "status": "Open",
        "score": 82.5,
    }
    with pytest.raises(FeatureInvalid, match="choices"):
        normalize_properties({"status": "Draft"}, fields)
    with pytest.raises(FeatureInvalid, match="above its maximum"):
        normalize_properties({"status": "Closed", "score": 101}, fields)
    with pytest.raises(FeatureInvalid, match="inverted"):
        normalize_fields([{"name": "score", "type": "integer", "minimum": 5, "maximum": 4}])
    with pytest.raises(FeatureInvalid, match="cannot declare string rules"):
        normalize_fields([{"name": "score", "type": "number", "choices": ["high"]}])


def test_conditional_fields_are_typed_ordered_and_required_only_when_visible() -> None:
    fields = normalize_fields(
        [
            {
                "name": "inspection_type",
                "type": "string",
                "required": True,
                "choices": ["Routine", "Incident"],
            },
            {
                "name": "incident_reference",
                "type": "string",
                "required": True,
                "visible_when": {"field": "inspection_type", "equals": "Incident"},
            },
        ]
    )

    assert feature_field_document(fields[1])["visible_when"] == {
        "field": "inspection_type",
        "equals": "Incident",
    }
    assert normalize_properties({"inspection_type": "Routine"}, fields) == {
        "inspection_type": "Routine"
    }
    assert normalize_properties(
        {"inspection_type": "Incident", "incident_reference": "INC-7"}, fields
    ) == {"inspection_type": "Incident", "incident_reference": "INC-7"}
    with pytest.raises(FeatureInvalid, match="required"):
        normalize_properties({"inspection_type": "Incident"}, fields)
    with pytest.raises(FeatureInvalid, match="hidden"):
        normalize_properties({"inspection_type": "Routine", "incident_reference": "INC-7"}, fields)

    collection = FeatureCollection(
        DATASET_ID,
        "Point",
        fields,
        1,
        0,
        USER_ID,
        NOW,
        USER_ID,
        NOW,
    )
    ogc = collection_document(collection, "https://example.test/ogc")
    assert ogc["opengeo:properties"]["incident_reference"]["x-opengeo-visible-when"] == {
        "field": "inspection_type",
        "equals": "Incident",
    }
    with pytest.raises(FeatureInvalid, match="earlier field"):
        normalize_fields(
            [
                {
                    "name": "reference",
                    "type": "string",
                    "visible_when": {"field": "later", "equals": True},
                },
                {"name": "later", "type": "boolean"},
            ]
        )
    with pytest.raises(FeatureInvalid, match="one of its choices"):
        normalize_fields(
            [
                {
                    "name": "kind",
                    "type": "string",
                    "choices": ["A", "B"],
                },
                {
                    "name": "detail",
                    "type": "string",
                    "visible_when": {"field": "kind", "equals": "C"},
                },
            ]
        )


def test_nested_and_repeating_groups_are_bounded_recursive_and_ordered() -> None:
    fields = normalize_fields(
        [
            {"name": "survey_kind", "type": "string", "required": True},
            {
                "name": "contact",
                "type": "group",
                "required": True,
                "fields": [
                    {"name": "name", "type": "string", "required": True},
                    {"name": "email", "type": "string"},
                ],
            },
            {
                "name": "samples",
                "type": "group",
                "repeat": True,
                "min_items": 1,
                "max_items": 2,
                "fields": [
                    {"name": "value", "type": "number", "required": True, "minimum": 0},
                    {
                        "name": "detail",
                        "type": "string",
                        "visible_when": {"field": "value", "equals": 0},
                    },
                ],
            },
        ]
    )
    properties = {
        "survey_kind": "water",
        "contact": {"name": "Ada", "email": "ada@example.test"},
        "samples": [
            {"value": 0, "detail": "below detection"},
            {"value": 4.5},
        ],
    }

    assert normalize_properties(properties, fields) == properties
    group = feature_field_document(fields[2])
    assert group == {
        "name": "samples",
        "type": "group",
        "required": False,
        "fields": [
            {"name": "value", "type": "number", "required": True, "minimum": 0},
            {
                "name": "detail",
                "type": "string",
                "required": False,
                "visible_when": {"field": "value", "equals": 0},
            },
        ],
        "repeat": True,
        "min_items": 1,
        "max_items": 2,
    }
    collection = FeatureCollection(DATASET_ID, "Point", fields, 1, 0, USER_ID, NOW, USER_ID, NOW)
    schema = collection_document(collection, "https://example.test/ogc")["opengeo:properties"]
    assert schema["contact"]["type"] == "object"
    assert schema["contact"]["required"] == ["name"]
    assert schema["samples"]["type"] == "array"
    assert schema["samples"]["minItems"] == 1
    assert schema["samples"]["maxItems"] == 2

    with pytest.raises(FeatureInvalid, match="must contain 1 to 2 items"):
        normalize_properties({**properties, "samples": []}, fields)
    with pytest.raises(FeatureInvalid, match=r"samples\[0\].detail is hidden"):
        normalize_properties(
            {**properties, "samples": [{"value": 2, "detail": "not applicable"}]},
            fields,
        )
    with pytest.raises(FeatureInvalid, match="visible_when controller must be scalar"):
        normalize_fields(
            [
                {"name": "group", "type": "group", "fields": [{"name": "x", "type": "string"}]},
                {
                    "name": "dependent",
                    "type": "string",
                    "visible_when": {"field": "group", "equals": "x"},
                },
            ]
        )
    too_deep: dict[str, Any] = {"name": "leaf", "type": "string"}
    for index in range(4):
        too_deep = {"name": f"group_{index}", "type": "group", "fields": [too_deep]}
    with pytest.raises(FeatureInvalid, match="three nested levels"):
        normalize_fields([too_deep])


def test_geometry_is_strict_two_dimensional_wgs84_geojson() -> None:
    geometry_type, geometry, bbox = normalize_geometry(
        {
            "type": "Polygon",
            "coordinates": [[[-77.1, 38.8], [-76.9, 38.8], [-76.9, 39.0], [-77.1, 38.8]]],
        }
    )

    assert geometry_type == "Polygon"
    assert geometry["coordinates"][0][0] == [-77.1, 38.8]
    assert bbox == (-77.1, 38.8, -76.9, 39.0)
    with pytest.raises(FeatureInvalid, match="closed"):
        normalize_geometry(
            {
                "type": "Polygon",
                "coordinates": [[[-77.1, 38.8], [-76.9, 38.8], [-76.9, 39.0], [-77.1, 39.0]]],
            }
        )
    with pytest.raises(FeatureInvalid, match="two-dimensional"):
        normalize_geometry({"type": "Point", "coordinates": [-77.1, 38.8, 10]})
    with pytest.raises(FeatureInvalid, match="WGS84"):
        normalize_geometry({"type": "Point", "coordinates": [181, 38.8]})


def test_query_geometry_accepts_bounded_multipoint_and_mixed_result_collection() -> None:
    multipoint = normalize_query_geometry(
        {"type": "MultiPoint", "coordinates": [[-71.06, 42.36], [-71.05, 42.37]]}
    )
    collection = normalize_query_geometry(
        {
            "type": "GeometryCollection",
            "geometries": [
                {"type": "Point", "coordinates": [-71.06, 42.36]},
                {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [-71.051, 42.369],
                            [-71.049, 42.369],
                            [-71.049, 42.371],
                            [-71.051, 42.369],
                        ]
                    ],
                },
            ],
        }
    )

    assert multipoint["type"] == "MultiPoint"
    assert collection["type"] == "GeometryCollection"
    assert [member["type"] for member in collection["geometries"]] == [
        "Point",
        "Polygon",
    ]
    with pytest.raises(FeatureInvalid, match="1 to 100"):
        normalize_query_geometry({"type": "GeometryCollection", "geometries": []})
    with pytest.raises(FeatureInvalid, match="1 to 100"):
        normalize_query_geometry(
            {
                "type": "GeometryCollection",
                "geometries": [{"type": "GeometryCollection", "geometries": []}],
            }
        )


def test_feature_draft_preserves_caller_id_and_normalizes_coordinates() -> None:
    fields = normalize_fields([{"name": "name", "type": "string", "required": True}])

    draft = feature_draft(
        {"type": "Point", "coordinates": [-77, 38]},
        {"name": "Station"},
        fields,
        FEATURE_ID,
    )

    assert draft.feature_id == FEATURE_ID
    assert draft.geometry == {"type": "Point", "coordinates": [-77.0, 38.0]}
    assert draft.bbox == (-77.0, 38.0, -77.0, 38.0)


def test_governed_repository_query_applies_scope_generation_and_bounded_postgis_sql() -> None:
    schema = {
        "schemaVersion": "1.0.0",
        "fields": [
            {"name": "name", "type": "string", "required": True},
            {"name": "priority", "type": "integer", "required": True},
        ],
    }
    transaction = QueryTransaction(
        one=[
            ("member", "viewer", None, False, "active", "geojson"),
            (DATASET_ID, "Point", schema, 7, 1, USER_ID, NOW, USER_ID, NOW),
            (1,),
        ],
        all_rows=[
            [
                (
                    FEATURE_ID,
                    1,
                    "Point",
                    {"name": "Station", "priority": 3},
                    {"type": "Point", "coordinates": [-77.03, 38.9]},
                    [-77.03, 38.9, -77.03, 38.9],
                    USER_ID,
                    NOW,
                    USER_ID,
                    NOW,
                )
            ]
        ],
    )
    repository = PostgresFeatureRepository(QueryExecutor(transaction))

    page = asyncio.run(
        repository.query_features(
            TenantContext(user_id=USER_ID, organization_id=ORG_ID),
            PROJECT_ID,
            DATASET_ID,
            steps=(
                AttributeQueryStep("name", "contains", "sta"),
                AttributeQueryStep("priority", "greater_than_or_equal", 2),
                SpatialQueryStep(
                    "intersects",
                    {"type": "Point", "coordinates": [-77.03, 38.9]},
                    25,
                ),
            ),
            limit=100,
            offset=0,
            expected_generation=7,
        )
    )

    assert page.collection.generation == 7
    assert page.features[0].feature_id == FEATURE_ID
    assert page.number_matched == 1
    count_call = transaction.calls[2]
    rows_call = transaction.calls[3]
    assert "lower(feature.properties ->> %s) LIKE lower(%s) ESCAPE '\\\\'" in count_call[1]
    assert "(feature.properties ->> %s)::numeric >= %s" in count_call[1]
    assert "ST_Intersects(feature.geometry, ST_Buffer(" in count_call[1]
    assert "ORDER BY feature.id" in rows_call[1]
    assert count_call[2][-1] == 25.0
    assert rows_call[2][-2:] == (100, 0)


def test_governed_repository_query_denies_unpermitted_dataset_scope_before_reading() -> None:
    transaction = QueryTransaction(one=[("guest", None, None, False, "active", "geojson")])
    repository = PostgresFeatureRepository(QueryExecutor(transaction))

    with pytest.raises(FeatureAccessDenied):
        asyncio.run(
            repository.query_features(
                TenantContext(user_id=USER_ID, organization_id=ORG_ID),
                PROJECT_ID,
                DATASET_ID,
                steps=(AttributeQueryStep("name", "equals", "Station"),),
                limit=100,
                offset=0,
            )
        )

    assert len(transaction.calls) == 1


def test_repository_feature_lock_acquire_list_release_and_conflict_are_explicit() -> None:
    schema = {"schemaVersion": "1.0.0", "fields": []}
    geometry = {"type": "Point", "coordinates": [0, 0]}
    acquired_transaction = QueryTransaction(
        one=[
            ("member", "editor", None, False, "active", "geojson"),
            (DATASET_ID, "Point", schema, 1, 1, USER_ID, NOW, USER_ID, NOW),
            feature_row(FEATURE_ID, 1, geometry, (0, 0, 0, 0)),
            (USER_ID,),
            None,
            (0,),
            (FEATURE_ID, 1, LOCK_TOKEN, True, NOW, NOW + timedelta(minutes=2)),
        ]
    )
    repository = PostgresFeatureRepository(QueryExecutor(acquired_transaction))
    acquired = asyncio.run(
        repository.acquire_feature_lock(
            TenantContext(user_id=USER_ID, organization_id=ORG_ID),
            PROJECT_ID,
            DATASET_ID,
            FEATURE_ID,
            1,
            LOCK_TOKEN,
            120,
            "feature-lock-acquire",
        )
    )

    assert acquired.lock_token == LOCK_TOKEN
    assert acquired.held_by_current_user is True
    assert acquired.feature_version == 1
    assert any(
        "ON CONFLICT (organization_id, dataset_id, feature_id)" in statement
        and "expires_at <= clock_timestamp()" in statement
        for _kind, statement, _parameters in acquired_transaction.calls
    )
    assert any(
        "dataset.feature.lock.acquired" in parameters
        for _kind, _statement, parameters in acquired_transaction.calls
    )

    list_transaction = QueryTransaction(
        one=[
            ("member", "editor", None, False, "active", "geojson"),
            (DATASET_ID, "Point", schema, 1, 1, USER_ID, NOW, USER_ID, NOW),
        ],
        all_rows=[
            [
                (FEATURE_ID, 1, LOCK_TOKEN, True, NOW, NOW + timedelta(minutes=2)),
                (
                    UUID("90000000-0000-4000-8000-000000000132"),
                    2,
                    None,
                    False,
                    NOW,
                    NOW + timedelta(minutes=3),
                ),
            ]
        ],
    )
    listed = asyncio.run(
        PostgresFeatureRepository(QueryExecutor(list_transaction)).list_feature_locks(
            TenantContext(user_id=USER_ID, organization_id=ORG_ID),
            PROJECT_ID,
            DATASET_ID,
        )
    )
    assert [item.lock_token for item in listed] == [LOCK_TOKEN, None]
    assert [item.held_by_current_user for item in listed] == [True, False]

    conflict_transaction = QueryTransaction(one=[(LOCK_TOKEN, OTHER_USER_ID, 1)])
    with pytest.raises(FeatureConflict) as conflict:
        asyncio.run(
            PostgresFeatureRepository._require_feature_lock_access(
                conflict_transaction,
                TenantContext(user_id=USER_ID, organization_id=ORG_ID),
                DATASET_ID,
                FEATURE_ID,
                LOCK_TOKEN,
            )
        )
    assert conflict.value.code == "feature_locked"
    assert conflict.value.current_version == 1

    release_transaction = QueryTransaction(
        one=[
            ("member", "editor", None, False, "active", "geojson"),
            (DATASET_ID, "Point", schema, 1, 1, USER_ID, NOW, USER_ID, NOW),
            feature_row(FEATURE_ID, 1, geometry, (0, 0, 0, 0)),
            (LOCK_TOKEN, USER_ID, 1),
        ]
    )
    released = asyncio.run(
        PostgresFeatureRepository(QueryExecutor(release_transaction)).release_feature_lock(
            TenantContext(user_id=USER_ID, organization_id=ORG_ID),
            PROJECT_ID,
            DATASET_ID,
            FEATURE_ID,
            LOCK_TOKEN,
            "feature-lock-release",
        )
    )
    assert released.released is True
    assert any(
        "dataset.feature.lock.released" in parameters
        for _kind, _statement, parameters in release_transaction.calls
    )


def test_repository_separates_multipolygon_parts_with_one_locked_generation_advance() -> None:
    schema = {
        "schemaVersion": "1.0.0",
        "fields": [{"name": "name", "type": "string", "required": True}],
    }
    source_geometry = {
        "type": "MultiPolygon",
        "coordinates": [
            [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
            [[[3, 0], [4, 0], [4, 1], [3, 1], [3, 0]]],
        ],
    }
    retained_geometry = {
        "type": "MultiPolygon",
        "coordinates": [source_geometry["coordinates"][1]],
    }
    created_geometry = {
        "type": "MultiPolygon",
        "coordinates": [source_geometry["coordinates"][0]],
    }
    transaction = QueryTransaction(
        one=[
            ("member", "editor", None, False, "active", "geojson"),
            (DATASET_ID, "MultiPolygon", schema, 1, 1, USER_ID, NOW, USER_ID, NOW),
            feature_row(FEATURE_ID, 1, source_geometry, (0, 0, 4, 1)),
            None,
            feature_row(FEATURE_ID, 2, retained_geometry, (3, 0, 4, 1)),
            feature_row(
                UUID("90000000-0000-4000-8000-000000000132"),
                1,
                created_geometry,
                (0, 0, 1, 1),
            ),
            (2, 2, NOW),
        ]
    )
    repository = PostgresFeatureRepository(QueryExecutor(transaction))

    result = asyncio.run(
        repository.separate_multipolygon_parts(
            TenantContext(user_id=USER_ID, organization_id=ORG_ID),
            PROJECT_ID,
            DATASET_ID,
            FEATURE_ID,
            1,
            1,
            "Separate survey areas",
            "polygon-separate-request",
        )
    )

    assert result.collection.generation == 2
    assert result.collection.feature_count == 2
    assert result.retained_feature.version_number == 2
    assert len(result.created_features) == 1
    assert result.created_features[0].geometry == created_geometry
    assert result.deleted_features == ()
    assert (
        sum(
            "UPDATE app.feature_collections" in statement
            for _kind, statement, _parameters in transaction.calls
        )
        == 1
    )
    assert (
        sum("FOR UPDATE" in statement for _kind, statement, _parameters in transaction.calls) >= 2
    )
    assert any(
        "dataset.feature.parts.separated" in parameters
        for _kind, _statement, parameters in transaction.calls
    )


def test_repository_merges_multipolygon_features_and_tombstones_donor_atomically() -> None:
    donor_id = UUID("90000000-0000-4000-8000-000000000132")
    schema = {
        "schemaVersion": "1.0.0",
        "fields": [{"name": "name", "type": "string", "required": True}],
    }
    retained_geometry = {
        "type": "MultiPolygon",
        "coordinates": [[[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]],
    }
    donor_geometry = {
        "type": "MultiPolygon",
        "coordinates": [[[[3, 0], [4, 0], [4, 1], [3, 1], [3, 0]]]],
    }
    merged_geometry = {
        "type": "MultiPolygon",
        "coordinates": [
            retained_geometry["coordinates"][0],
            donor_geometry["coordinates"][0],
        ],
    }
    transaction = QueryTransaction(
        one=[
            ("member", "editor", None, False, "active", "geojson"),
            (DATASET_ID, "MultiPolygon", schema, 7, 2, USER_ID, NOW, USER_ID, NOW),
            feature_row(FEATURE_ID, 2, retained_geometry, (0, 0, 1, 1)),
            feature_row(donor_id, 3, donor_geometry, (3, 0, 4, 1)),
            None,
            None,
            (True,),
            feature_row(FEATURE_ID, 3, merged_geometry, (0, 0, 4, 1)),
            (8, 1, NOW),
        ]
    )
    repository = PostgresFeatureRepository(QueryExecutor(transaction))

    result = asyncio.run(
        repository.merge_multipolygon_features(
            TenantContext(user_id=USER_ID, organization_id=ORG_ID),
            PROJECT_ID,
            DATASET_ID,
            FEATURE_ID,
            ((donor_id, 3, None), (FEATURE_ID, 2, None)),
            "Merge survey areas",
            "polygon-merge-request",
        )
    )

    assert result.collection.generation == 8
    assert result.collection.feature_count == 1
    assert result.retained_feature.geometry == merged_geometry
    assert result.created_features == ()
    assert [(item.feature_id, item.deleted_version) for item in result.deleted_features] == [
        (donor_id, 4)
    ]
    assert result.deleted_features[0].collection_generation == 8
    assert (
        sum(
            "UPDATE app.feature_collections" in statement
            for _kind, statement, _parameters in transaction.calls
        )
        == 1
    )
    assert any(
        "deleted_at = clock_timestamp()" in statement
        for _kind, statement, _parameters in transaction.calls
    )
    assert any(
        "dataset.feature.parts.merged" in parameters
        for _kind, _statement, parameters in transaction.calls
    )


def dissolve_transaction(
    *,
    role="editor",
    geometries=None,
    locks=(None, None),
    result=None,
    committed=False,
    geometry_type="MultiPolygon",
):
    donor_id = UUID("90000000-0000-4000-8000-000000000132")
    schema = {
        "schemaVersion": "1.0.0",
        "fields": [{"name": "name", "type": "string", "required": True}],
    }
    if geometries is None:
        geometries = [
            {
                "type": "MultiPolygon",
                "coordinates": [
                    [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
                ],
            },
            {
                "type": "MultiPolygon",
                "coordinates": [
                    [[[1, 0], [3, 0], [3, 2], [1, 2], [1, 0]]],
                ],
            },
        ]
    if geometry_type == "Polygon":
        geometries = [
            {"type": "Polygon", "coordinates": geometry["coordinates"][0]}
            for geometry in geometries
        ]
    rows = [
        ("member", role, None, False, "active", "geojson"),
        (DATASET_ID, geometry_type, schema, 7, 2, USER_ID, NOW, USER_ID, NOW),
        feature_row(FEATURE_ID, 2, geometries[0], (0, 0, 2, 2), geometry_type=geometry_type),
        feature_row(donor_id, 3, geometries[1], (1, 0, 3, 2), geometry_type=geometry_type),
        *locks,
        result,
    ]
    if committed:
        rows.extend(
            [
                feature_row(
                    FEATURE_ID,
                    3,
                    {"type": "Polygon", "coordinates": result[0]["coordinates"][0]}
                    if geometry_type == "Polygon"
                    else result[0],
                    (0, 0, 3, 2),
                    geometry_type=geometry_type,
                ),
                (8, 1, NOW),
            ]
        )
    return QueryTransaction(rows), donor_id


def dissolve_selected(transaction, donor_id, *, version=2, geometry_operation="dissolve"):
    return asyncio.run(
        PostgresFeatureRepository(QueryExecutor(transaction)).merge_multipolygon_features(
            TenantContext(user_id=USER_ID, organization_id=ORG_ID),
            PROJECT_ID,
            DATASET_ID,
            FEATURE_ID,
            ((FEATURE_ID, version, None), (donor_id, 3, None)),
            None,
            "polygon-dissolve-request",
            geometry_operation=geometry_operation,
        )
    )


def cut_source_and_pieces():
    source = {
        "type": "MultiPolygon",
        "coordinates": [
            [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]],
            [[[10, 0], [11, 0], [11, 1], [10, 1], [10, 0]]],
        ],
    }
    pieces = [
        {"type": "Polygon", "coordinates": [[[1, 0], [4, 0], [4, 4], [1, 4], [1, 0]]]},
        {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 4], [0, 4], [0, 0]]]},
    ]
    return source, pieces


def cut_transaction(*, accepted=True, role="editor", lock=None, geometry_type="MultiPolygon"):
    source, pieces = cut_source_and_pieces()
    retained = {
        "type": "MultiPolygon",
        "coordinates": [pieces[0]["coordinates"], source["coordinates"][1]],
    }
    created = {"type": "MultiPolygon", "coordinates": [pieces[1]["coordinates"]]}
    if geometry_type == "Polygon":
        source = {"type": "Polygon", "coordinates": source["coordinates"][0]}
        retained, created = pieces
    schema = {
        "schemaVersion": "1.0.0",
        "fields": [{"name": "name", "type": "string", "required": True}],
    }
    return QueryTransaction(
        [
            ("member", role, None, False, "active", "geojson"),
            (DATASET_ID, geometry_type, schema, 7, 1, USER_ID, NOW, USER_ID, NOW),
            feature_row(FEATURE_ID, 2, source, (0, 0, 11, 4), geometry_type=geometry_type),
            lock,
            (pieces if accepted else None, accepted),
            feature_row(FEATURE_ID, 3, retained, (1, 0, 11, 4), geometry_type=geometry_type),
            feature_row(uuid4(), 1, created, (0, 0, 1, 4), geometry_type=geometry_type),
            (8, 2, NOW),
        ]
    )


def cut_selected(transaction, *, version=2, part_index=0, line=None, lock_token=None):
    return asyncio.run(
        PostgresFeatureRepository(QueryExecutor(transaction)).cut_multipolygon_feature(
            TenantContext(user_id=USER_ID, organization_id=ORG_ID),
            PROJECT_ID,
            DATASET_ID,
            FEATURE_ID,
            version,
            part_index,
            line or {"type": "LineString", "coordinates": [[1, -1], [1, 5]]},
            None,
            "polygon-cut-request",
            lock_token,
        )
    )


def test_cut_retains_largest_piece_untouched_parts_attributes_history_and_lock():
    transaction = cut_transaction(lock=(LOCK_TOKEN, USER_ID, 2))
    result = cut_selected(transaction, lock_token=LOCK_TOKEN)
    source, pieces = cut_source_and_pieces()
    assert result.retained_feature.feature_id == FEATURE_ID
    assert result.retained_feature.version_number == 3
    assert result.retained_feature.geometry["coordinates"] == [
        pieces[0]["coordinates"],
        source["coordinates"][1],
    ]
    assert result.retained_feature.properties == {"name": "Survey areas"}
    assert len(result.created_features) == 1 and result.deleted_features == ()
    assert result.created_features[0].geometry["coordinates"] == [pieces[1]["coordinates"]]
    assert result.created_features[0].properties == result.retained_feature.properties
    assert (result.collection.generation, result.collection.feature_count) == (8, 2)
    statements = [statement for _kind, statement, _parameters in transaction.calls]
    split_index = statements.index(_CUT_MULTIPOLYGON_SQL)
    assert sum("FOR UPDATE" in statement for statement in statements[:split_index]) == 2
    assert statements[split_index - 1] == _DISSOLVE_TIMEOUT_SQL
    assert transaction.calls[split_index][2][2] == 1
    assert (
        sum("INSERT INTO app.dataset_feature_revisions" in statement for statement in statements)
        == 2
    )
    assert sum("UPDATE app.feature_collections" in statement for statement in statements) == 1
    assert any("UPDATE app.dataset_feature_locks" in statement for statement in statements)
    assert any(
        "dataset.feature.cut" in parameters for _kind, _statement, parameters in transaction.calls
    )


def test_polygon_cut_retains_exact_type_identity_properties_and_transaction_guards():
    transaction = cut_transaction(geometry_type="Polygon", lock=(LOCK_TOKEN, USER_ID, 2))
    result = cut_selected(transaction, lock_token=LOCK_TOKEN)
    source, pieces = cut_source_and_pieces()
    assert result.collection.geometry_type == "Polygon"
    assert result.retained_feature.feature_id == FEATURE_ID
    assert result.retained_feature.version_number == 3
    assert result.retained_feature.geometry == pieces[0]
    assert result.created_features[0].geometry == pieces[1]
    assert result.created_features[0].feature_id != FEATURE_ID
    assert result.created_features[0].version_number == 1
    assert (
        result.retained_feature.properties
        == result.created_features[0].properties
        == {"name": "Survey areas"}
    )
    assert result.deleted_features == ()
    assert (result.collection.generation, result.collection.feature_count) == (8, 2)
    split = next(call for call in transaction.calls if call[1] == _CUT_MULTIPOLYGON_SQL)
    assert split[2][0].obj == {"type": "MultiPolygon", "coordinates": source["coordinates"][:1]}
    assert split[2][2] == 1
    assert sum("FOR UPDATE" in call[1] for call in transaction.calls) == 2
    assert sum("UPDATE app.feature_collections" in call[1] for call in transaction.calls) == 1
    assert (
        sum("INSERT INTO app.dataset_feature_revisions" in call[1] for call in transaction.calls)
        == 2
    )
    assert any("UPDATE app.dataset_feature_locks" in call[1] for call in transaction.calls)


@pytest.mark.parametrize("failure", ["viewer", "stale", "locked", "part", "result"])
def test_polygon_cut_rejects_before_writes(failure):
    transaction = cut_transaction(
        geometry_type="Polygon",
        accepted=failure != "result",
        role="viewer" if failure == "viewer" else "editor",
        lock=(LOCK_TOKEN, OTHER_USER_ID, 2) if failure == "locked" else None,
    )
    with pytest.raises((FeatureInvalid, FeatureConflict, FeatureAccessDenied)):
        cut_selected(
            transaction,
            version=1 if failure == "stale" else 2,
            part_index=1 if failure == "part" else 0,
        )
    assert not any(
        "INSERT INTO" in statement or "UPDATE app." in statement
        for _kind, statement, _parameters in transaction.calls
    )
    if failure != "result":
        assert not any(
            statement == _CUT_MULTIPOLYGON_SQL
            for _kind, statement, _parameters in transaction.calls
        )


def test_polygon_cut_drafts_preserve_holes_and_reject_nonzero_parts_and_mixed_types():
    source, pieces = cut_source_and_pieces()
    polygon = {"type": "Polygon", "coordinates": source["coordinates"][0]}
    hole = [[2, 1], [2, 2], [3, 2], [3, 1], [2, 1]]
    polygon["coordinates"].append(hole)
    pieces[0]["coordinates"].append(hole)
    current = replace(
        PostgresFeatureRepository._feature(
            feature_row(FEATURE_ID, 2, polygon, (0, 0, 4, 4), geometry_type="Polygon")
        ),
        properties={},
    )
    drafts = cut_multipolygon_drafts(current, (), 0, pieces)
    assert [draft.geometry_type for draft in drafts] == ["Polygon", "Polygon"]
    assert drafts[0].geometry["coordinates"][1] == hole
    assert drafts[0].feature_id == FEATURE_ID and drafts[1].feature_id != FEATURE_ID
    assert current.geometry == polygon
    with pytest.raises(FeatureInvalid, match="part index"):
        cut_multipolygon_drafts(current, (), 1, pieces)
    with pytest.raises(FeatureInvalid, match="between 2 and 20"):
        cut_multipolygon_drafts(current, (), 0, pieces * 11)
    with pytest.raises(FeatureInvalid, match="geometry type"):
        cut_multipolygon_drafts(replace(current, geometry_type="MultiPolygon"), (), 0, pieces)


@pytest.mark.parametrize(
    "failure", ["viewer", "stale", "locked", "part", "line", "closed", "positions", "result"]
)
def test_cut_fails_before_writes_and_preserves_version_and_authority(failure):
    transaction = cut_transaction(
        accepted=failure != "result",
        role="viewer" if failure == "viewer" else "editor",
        lock=(LOCK_TOKEN, OTHER_USER_ID, 2) if failure == "locked" else None,
    )
    line = {"type": "LineString", "coordinates": [[1, -1], [1, 5]]}
    if failure == "line":
        line = {"type": "Point", "coordinates": [1, 1]}
    elif failure == "closed":
        line["coordinates"] = [[0, 0], [1, 1], [0, 0]]
    elif failure == "positions":
        line["coordinates"] = [[index / 1000, 1] for index in range(257)]
    with pytest.raises((FeatureInvalid, FeatureConflict, FeatureAccessDenied)):
        cut_selected(
            transaction,
            version=1 if failure == "stale" else 2,
            part_index=4 if failure == "part" else 0,
            line=line,
        )
    assert not any(
        "INSERT INTO" in statement or "UPDATE app." in statement
        for _kind, statement, _parameters in transaction.calls
    )
    if failure != "result":
        assert not any(
            "ST_Split" in statement for _kind, statement, _parameters in transaction.calls
        )


def test_cut_drafts_and_blade_are_bounded_before_heads_change():
    source, pieces = cut_source_and_pieces()
    row = feature_row(FEATURE_ID, 2, source, (0, 0, 11, 4))
    feature = PostgresFeatureRepository._feature(row)
    with pytest.raises(FeatureInvalid, match="between 2 and 20"):
        cut_multipolygon_drafts(feature, (), 0, pieces * 11)
    # The combined result must obey the original 256-part limit even though
    # every individual new feature is a valid one-part geometry.
    crowded = replace(
        feature,
        geometry={"type": "MultiPolygon", "coordinates": source["coordinates"][:1] * 256},
        properties={},
    )
    with pytest.raises(FeatureInvalid, match="256"):
        cut_multipolygon_drafts(crowded, (), 0, pieces)
    with pytest.raises(FeatureInvalid, match="WGS84"):
        normalize_cut_line({"type": "LineString", "coordinates": [[181, 0], [1, 1]]})


def shared_vertex_geometries(kind="Polygon"):
    left = {
        "type": "Polygon",
        "coordinates": [
            [[0, 0], [1, 0], [1, 1], [1, 2], [0, 2], [0, 0]],
            [[0.2, 0.5], [0.2, 1], [0.4, 1], [0.4, 0.5], [0.2, 0.5]],
        ],
    }
    right = {
        "type": "Polygon",
        "coordinates": [
            [[1, 0], [2, 0], [2, 2], [1, 2], [1, 1], [1, 0]],
        ],
    }
    if kind == "MultiPolygon":
        left = {
            "type": kind,
            "coordinates": [
                left["coordinates"],
                [
                    [[10, 0], [11, 0], [11, 1], [10, 1], [10, 0]],
                ],
            ],
        }
        right = {
            "type": kind,
            "coordinates": [
                right["coordinates"],
                [
                    [[13, 0], [14, 0], [14, 1], [13, 1], [13, 0]],
                ],
            ],
        }
    return [left, right]


def shared_vertex_transaction(
    *, kind="Polygon", accepted=True, role="editor", foreign=False, geometries=None, committed=False
):
    other_id = UUID("90000000-0000-4000-8000-000000000132")
    geometries = geometries or shared_vertex_geometries(kind)
    schema = {
        "schemaVersion": "1.0.0",
        "fields": [
            {"name": "name", "type": "string", "required": True},
        ],
    }
    records = []
    for feature_id, version, geometry, name in zip(
        [FEATURE_ID, other_id], [2, 3], geometries, ["Left parcel", "Right parcel"], strict=True
    ):
        record = replace(
            PostgresFeatureRepository._feature(
                feature_row(feature_id, version, geometry, (0, 0, 2, 2), geometry_type=kind)
            ),
            properties={"name": name},
        )
        records.append(record)

    def row(record):
        result = list(
            feature_row(
                record.feature_id,
                record.version_number,
                record.geometry,
                record.bbox,
                geometry_type=record.geometry_type,
            )
        )
        result[3] = record.properties
        return tuple(result)

    rows = [
        ("member", role, None, False, "active", "geojson"),
        (DATASET_ID, kind, schema, 7, 2, USER_ID, NOW, USER_ID, NOW),
        *[row(record) for record in records],
        (LOCK_TOKEN, OTHER_USER_ID if foreign else USER_ID, 3),
        None,
        (accepted,),
    ]
    if committed:
        drafts = shared_polygon_vertex_drafts(
            records, normalize_fields(schema["fields"]), [1, 1], [1.2, 1]
        )
        rows += [
            row(
                replace(
                    records[index],
                    version_number=records[index].version_number + 1,
                    geometry=drafts[index].geometry,
                )
            )
            for index in [1, 0]
        ]
        rows.append((8, 2, NOW))
    return QueryTransaction(rows), records, other_id


def shared_vertex_move(transaction, other_id, *, version=3, source=None, target=None):
    return asyncio.run(
        PostgresFeatureRepository(QueryExecutor(transaction)).move_shared_polygon_vertex(
            TenantContext(user_id=USER_ID, organization_id=ORG_ID),
            PROJECT_ID,
            DATASET_ID,
            ((other_id, version, LOCK_TOKEN), (FEATURE_ID, 2, None)),
            [1, 1] if source is None else source,
            [1.2, 1] if target is None else target,
            None,
            "shared-vertex-request",
        )
    )


@pytest.mark.parametrize("kind", ["Polygon", "MultiPolygon"])
def test_shared_vertex_atomic_heads_sorted_locks_properties_holes_and_generation(kind):
    transaction, originals, other_id = shared_vertex_transaction(kind=kind, committed=True)
    result = shared_vertex_move(transaction, other_id)
    assert [feature.feature_id for feature in result.updated_features] == [other_id, FEATURE_ID]
    assert [feature.version_number for feature in result.updated_features] == [4, 3]
    assert [feature.properties for feature in result.updated_features] == [
        {"name": "Right parcel"},
        {"name": "Left parcel"},
    ]
    assert all(
        feature.geometry_type == feature.geometry["type"] == kind
        for feature in result.updated_features
    )
    assert (result.collection.generation, result.collection.feature_count) == (8, 2)
    validation_index = next(
        i for i, call in enumerate(transaction.calls) if call[1] == _MOVE_SHARED_POLYGON_VERTEX_SQL
    )
    previous = transaction.calls[:validation_index]
    assert sum("FOR UPDATE" in statement for _kind, statement, _parameters in previous) == 3
    heads = [
        parameters[2]
        for _kind, statement, parameters in previous
        if "FROM app.dataset_features" in statement
    ]
    assert heads == sorted([FEATURE_ID, other_id], key=str)
    assert transaction.calls[validation_index - 1][1] == _DISSOLVE_TIMEOUT_SQL
    assert sum("UPDATE app.feature_collections" in call[1] for call in transaction.calls) == 1
    assert (
        sum("INSERT INTO app.dataset_feature_revisions" in call[1] for call in transaction.calls)
        == 2
    )
    assert not any("deleted_at = clock_timestamp" in call[1] for call in transaction.calls)
    assert originals[0].geometry == shared_vertex_geometries(kind)[0]
    left = result.updated_features[1].geometry["coordinates"]
    old_left = originals[0].geometry["coordinates"]
    if kind == "MultiPolygon":
        assert left[1:] == old_left[1:]
        left, old_left = left[0], old_left[0]
    assert left[1:] == old_left[1:]


@pytest.mark.parametrize(
    "failure",
    [
        "stale",
        "foreign",
        "union",
        "wrong_geometry",
        "missing",
        "ambiguous",
        "noop",
        "target_exists",
        "authority",
    ],
)
def test_shared_vertex_rejects_without_heads_or_history(failure):
    geometries = shared_vertex_geometries()
    if failure == "missing":
        geometries[1]["coordinates"][0][4] = [1, 1.5]
    elif failure == "ambiguous":
        geometries[1]["coordinates"][0].insert(2, [1, 1])
    elif failure == "wrong_geometry":
        geometries[1] = {"type": "Point", "coordinates": [1, 1]}
    transaction, _originals, other_id = shared_vertex_transaction(
        geometries=geometries,
        accepted=failure != "union",
        foreign=failure == "foreign",
        role="viewer" if failure == "authority" else "editor",
    )
    with pytest.raises((FeatureInvalid, FeatureConflict, FeatureAccessDenied)):
        shared_vertex_move(
            transaction,
            other_id,
            version=4 if failure == "stale" else 3,
            target=[1, 1]
            if failure == "noop"
            else ([1, 0] if failure == "target_exists" else None),
        )
    assert all(
        kind != "execute" or statement == _DISSOLVE_TIMEOUT_SQL
        for kind, statement, _parameters in transaction.calls
    )
    if failure != "union":
        assert not any(call[1] == _MOVE_SHARED_POLYGON_VERTEX_SQL for call in transaction.calls)


def test_shared_vertex_closure_and_aggregate_bounds():
    _transaction, records, _other_id = shared_vertex_transaction()
    drafts = shared_polygon_vertex_drafts(
        records,
        normalize_fields(
            [
                {"name": "name", "type": "string", "required": True},
            ]
        ),
        [1, 0],
        [1.1, 0],
    )
    assert (
        drafts[1].geometry["coordinates"][0][0]
        == drafts[1].geometry["coordinates"][0][-1]
        == [1.1, 0]
    )
    with pytest.raises(FeatureInvalid, match="unique"):
        shared_polygon_vertex_drafts([records[0], records[0]], (), [1, 1], [1.2, 1])
    fields = normalize_fields([{"name": "name", "type": "string", "required": True}])
    for count, position, message in [
        (5001, [0.5, 0.5], "10000"),
        (4000, [0.12345678901234568, 0.4567890123456789], "262144"),
    ]:
        crowded = []
        for record in records:
            geometry = {
                "type": "Polygon",
                "coordinates": [
                    record.geometry["coordinates"][0][:-1]
                    + [position] * count
                    + record.geometry["coordinates"][0][-1:],
                ],
            }
            crowded.append(replace(record, geometry=geometry))
        with pytest.raises(FeatureInvalid, match=message):
            shared_polygon_vertex_drafts(crowded, fields, [1, 1], [1.2, 1])


def test_selected_dissolve_retains_identity_and_uses_bounded_parameterized_union():
    geometry = {
        "type": "MultiPolygon",
        "coordinates": [
            [[[0, 0], [3, 0], [3, 2], [0, 2], [0, 0]]],
        ],
    }
    transaction, donor_id = dissolve_transaction(result=(geometry, True), committed=True)

    result = dissolve_selected(transaction, donor_id)

    assert result.retained_feature.feature_id == FEATURE_ID
    assert result.retained_feature.properties == {"name": "Survey areas"}
    assert result.retained_feature.geometry == geometry
    assert result.collection.generation == 8 and result.collection.feature_count == 1
    assert [(item.feature_id, item.deleted_version) for item in result.deleted_features] == [
        (donor_id, 4)
    ]
    statements = [statement for _kind, statement, _parameters in transaction.calls]
    union_index = next(
        index for index, statement in enumerate(statements) if "ST_UnaryUnion" in statement
    )
    assert sum("FOR UPDATE" in statement for statement in statements[:union_index]) == 3
    assert sum("expires_at >" in statement for statement in statements[:union_index]) == 2
    assert statements[union_index - 1] == _DISSOLVE_TIMEOUT_SQL
    union_parameters = transaction.calls[union_index][2]
    assert isinstance(union_parameters[0], Jsonb) and len(union_parameters[0].obj) == 2
    assert union_parameters[1] == 10_000
    assert "ST_MakeValid" not in statements[union_index]
    assert sum("UPDATE app.feature_collections" in statement for statement in statements) == 1
    assert any(
        "Dissolved polygon feature boundaries" in parameters
        for _kind, _statement, parameters in transaction.calls
    )
    event = next(
        parameters
        for _kind, _statement, parameters in transaction.calls
        if "dataset.feature.parts.merged" in parameters
    )
    assert any(
        isinstance(value, Jsonb) and value.obj.get("geometry_operation") == "dissolve"
        for value in event
    )


def test_connected_polygon_dissolve_preserves_type_identity_properties_and_donor_history():
    union = {
        "type": "MultiPolygon",
        "coordinates": [
            [[[0, 0], [3, 0], [3, 2], [0, 2], [0, 0]]],
        ],
    }
    transaction, donor_id = dissolve_transaction(
        geometry_type="Polygon", result=(union, True), committed=True
    )
    result = dissolve_selected(transaction, donor_id)
    assert result.collection.geometry_type == result.retained_feature.geometry_type == "Polygon"
    assert result.retained_feature.geometry == {
        "type": "Polygon",
        "coordinates": union["coordinates"][0],
    }
    assert result.retained_feature.feature_id == FEATURE_ID
    assert result.retained_feature.version_number == 3
    assert result.retained_feature.properties == {"name": "Survey areas"}
    assert result.created_features == ()
    assert [(item.feature_id, item.deleted_version) for item in result.deleted_features] == [
        (donor_id, 4)
    ]
    assert (result.collection.generation, result.collection.feature_count) == (8, 1)
    union_call = next(call for call in transaction.calls if call[1] == _DISSOLVE_MULTIPOLYGON_SQL)
    assert all(geometry["type"] == "MultiPolygon" for geometry in union_call[2][0].obj)
    revisions = [
        parameters
        for _kind, statement, parameters in transaction.calls
        if "INSERT INTO app.dataset_feature_revisions" in statement
    ]
    assert len(revisions) == 2 and all(parameters[5] == "Polygon" for parameters in revisions)
    assert any(
        "DELETE FROM app.dataset_feature_locks" in statement
        for _kind, statement, _parameters in transaction.calls
    )


@pytest.mark.parametrize(
    "failure", ["collect", "authority", "stale", "lock", "disconnected", "wrong_result"]
)
def test_connected_polygon_dissolve_rejects_without_feature_writes(failure):
    union = {
        "type": "MultiPolygon",
        "coordinates": [
            [[[0, 0], [3, 0], [3, 2], [0, 2], [0, 0]]],
        ],
    }
    if failure == "disconnected":
        union["coordinates"] *= 2
    elif failure == "wrong_result":
        union = {"type": "Polygon", "coordinates": union["coordinates"][0]}
    transaction, donor_id = dissolve_transaction(
        geometry_type="Polygon",
        result=(union, True),
        role="viewer" if failure == "authority" else "editor",
        locks=((LOCK_TOKEN, OTHER_USER_ID, 2), None) if failure == "lock" else (None, None),
    )
    with pytest.raises((FeatureInvalid, FeatureConflict, FeatureAccessDenied)):
        dissolve_selected(
            transaction,
            donor_id,
            geometry_operation="collect" if failure == "collect" else "dissolve",
            version=1 if failure == "stale" else 2,
        )
    assert all(
        kind != "execute" or statement == _DISSOLVE_TIMEOUT_SQL
        for kind, statement, _parameters in transaction.calls
    )
    if failure in {"collect", "authority", "stale", "lock"}:
        assert not any(
            statement == _DISSOLVE_MULTIPOLYGON_SQL
            for _kind, statement, _parameters in transaction.calls
        )


@pytest.mark.parametrize("failure", ["authority", "stale", "reservation", "positions", "parts"])
def test_selected_dissolve_rejects_before_topology_or_writes(failure):
    arguments = {}
    if failure == "authority":
        arguments["role"] = "viewer"
    elif failure == "reservation":
        arguments["locks"] = ((LOCK_TOKEN, OTHER_USER_ID, 2), None)
    elif failure in {"positions", "parts"}:
        coordinates = (
            [[[[0, 0]] * 5001]]
            if failure == "positions"
            else [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] * 129
        )
        arguments["geometries"] = [
            {"type": "MultiPolygon", "coordinates": coordinates},
            {"type": "MultiPolygon", "coordinates": coordinates},
        ]
    transaction, donor_id = dissolve_transaction(**arguments)
    expected = (
        FeatureAccessDenied
        if failure == "authority"
        else (FeatureConflict if failure in {"stale", "reservation"} else FeatureInvalid)
    )
    with pytest.raises(expected):
        dissolve_selected(transaction, donor_id, version=1 if failure == "stale" else 2)
    assert not any("ST_UnaryUnion" in statement for _kind, statement, _params in transaction.calls)
    assert not any(kind == "execute" for kind, _statement, _params in transaction.calls)


@pytest.mark.parametrize(
    "union_result",
    [
        None,
        (None, False),
        ({"type": "MultiPolygon", "coordinates": []}, True),
    ],
)
def test_selected_dissolve_rejects_invalid_empty_or_oversized_union_without_writes(union_result):
    transaction, donor_id = dissolve_transaction(result=union_result)
    with pytest.raises(FeatureInvalid):
        dissolve_selected(transaction, donor_id)
    assert all(
        kind != "execute" or statement == _DISSOLVE_TIMEOUT_SQL
        for kind, statement, _parameters in transaction.calls
    )


@pytest.mark.skipif(
    not os.environ.get("OPENGEO_FEATURE_TEST_DSN"), reason="explicit local PostGIS DSN required"
)
def test_selected_dissolve_native_postgis_overlap_shared_edge_hole_and_rejections():
    import psycopg

    donut = {
        "type": "MultiPolygon",
        "coordinates": [
            [
                [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
                [[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]],
            ]
        ],
    }
    overlapping = {
        "type": "MultiPolygon",
        "coordinates": [
            [[[3, 0], [5, 0], [5, 4], [3, 4], [3, 0]]],
        ],
    }
    touching = {
        "type": "MultiPolygon",
        "coordinates": [
            [[[5, 0], [6, 0], [6, 4], [5, 4], [5, 0]]],
        ],
    }
    invalid = {
        "type": "MultiPolygon",
        "coordinates": [
            [[[0, 0], [2, 2], [0, 2], [2, 0], [0, 0]]],
        ],
    }
    with (
        psycopg.connect(os.environ["OPENGEO_FEATURE_TEST_DSN"]) as connection,
        connection.cursor() as cursor,
    ):
        for initial, expected in ((1000, 1000), (0, 5000), (10000, 5000)):
            cursor.execute("SELECT set_config('statement_timeout', %s, true)", (str(initial),))
            cursor.execute(_DISSOLVE_TIMEOUT_SQL)
            cursor.execute("SELECT setting::int FROM pg_settings WHERE name='statement_timeout'")
            assert cursor.fetchone() == (expected,)
        cursor.execute(_DISSOLVE_MULTIPOLYGON_SQL, (Jsonb([donut, overlapping, touching]), 10_000))
        geometry, accepted = cursor.fetchone()
        assert accepted is True
        draft = feature_draft(geometry, {}, (), FEATURE_ID)
        assert draft.feature_id == FEATURE_ID and draft.geometry_type == "MultiPolygon"
        cursor.execute(
            "SELECT ST_Area(geom), ST_NumInteriorRings(ST_GeometryN(geom, 1)), "
            "ST_IsValid(geom) "
            "FROM (SELECT ST_GeomFromGeoJSON(%s::text) AS geom) result",
            (Jsonb(draft.geometry),),
        )
        assert cursor.fetchone() == (20.0, 1, True)
        cursor.execute(_DISSOLVE_MULTIPOLYGON_SQL, (Jsonb([donut, invalid]), 10_000))
        assert cursor.fetchone() == (None, False)
        cursor.execute(_DISSOLVE_MULTIPOLYGON_SQL, (Jsonb([donut, overlapping, touching]), 5))
        assert cursor.fetchone() == (None, False)


@pytest.mark.skipif(
    not os.environ.get("OPENGEO_FEATURE_TEST_DSN"), reason="explicit local PostGIS DSN required"
)
def test_cut_native_postgis_bent_line_holes_ties_and_rejections():
    import psycopg

    source, _pieces = cut_source_and_pieces()
    donut = {
        "type": "MultiPolygon",
        "coordinates": [
            [
                [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
                [[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]],
            ]
        ],
    }
    with (
        psycopg.connect(os.environ["OPENGEO_FEATURE_TEST_DSN"]) as connection,
        connection.cursor() as cursor,
    ):
        cursor.execute(_DISSOLVE_TIMEOUT_SQL)

        def split(geometry, positions):
            cursor.execute(
                _CUT_MULTIPOLYGON_SQL,
                (Jsonb(geometry), Jsonb({"type": "LineString", "coordinates": positions}), 1),
            )
            return cursor.fetchone()

        for geometry, line, area, holes in [
            (source, [[1, -1], [1, 1], [3, 3], [3, 5]], 16, 0),
            (donut, [[0.5, -1], [0.5, 5]], 12, 1),
            (donut, [[2, -1], [2, 5]], 12, 0),
        ]:
            pieces, accepted = split(geometry, line)
            assert accepted is True and len(pieces) == 2
            cursor.execute(
                "SELECT sum(ST_Area(geom)),sum(ST_NumInteriorRings(geom)),"
                "bool_and(ST_IsValid(geom)) "
                "FROM (SELECT ST_GeomFromGeoJSON(value::text) AS geom "
                "FROM jsonb_array_elements(%s::jsonb)) parts",
                (Jsonb(pieces),),
            )
            assert cursor.fetchone() == (area, holes, True)
        tied, accepted = split(source, [[2, -1], [2, 5]])
        reversed_tied, reversed_accepted = split(source, [[2, 5], [2, -1]])
        assert accepted and reversed_accepted
        cursor.execute(
            "SELECT ST_Equals(ST_GeomFromGeoJSON(%s::text),ST_GeomFromGeoJSON(%s::text))",
            (Jsonb(tied[0]), Jsonb(reversed_tied[0])),
        )
        assert cursor.fetchone() == (True,)
        for geometry, positions in [
            (source, [[-1, -1], [-1, 5]]),  # outside
            (source, [[-1, -1], [0, 0], [-1, 1]]),  # tangent
            (source, [[0, -1], [0, 2], [2, 2]]),  # boundary overlap
            (source, [[1, 1], [3, 3]]),  # ends inside
            (source, [[1, -1], [1, 5], [1, -1]]),  # closed
            (source, [[-1, -1], [5, 5], [-1, 5], [5, -1]]),  # self intersection
            (source, [[1, 1], [1, 1]]),  # zero length
            (donut, [[1.2, 1.2], [2.8, 2.8]]),  # entirely in the hole
            (source, [[index / 1000, 1] for index in range(257)]),
            (
                source,
                [
                    [x, index / 6]
                    for index in range(1, 22)
                    for x in ([-1, 5] if index % 2 else [5, -1])
                ],
            ),  # 22 pieces
            (
                {"type": "MultiPolygon", "coordinates": [source["coordinates"][0]] * 2},
                [[1, -1], [1, 5]],
            ),
        ]:
            assert split(geometry, positions) == (None, False)


async def native_shared_polygon_vertex(
    connection, cursor, repository, context, project_id, dataset_id, fields, kind
):
    from opengeo_api.tenant_database import _PostgresTenantTransaction

    left_id, right_id = uuid4(), uuid4()
    left_token, right_token = uuid4(), uuid4()
    geometries = shared_vertex_geometries(kind)
    await repository.create_collection(
        context,
        project_id,
        dataset_id,
        kind,
        fields,
        tuple(
            feature_draft(geometry, {"name": name}, fields, feature_id)
            for feature_id, name, geometry in zip(
                [left_id, right_id], ["Left parcel", "Right parcel"], geometries, strict=True
            )
        ),
        "shared-vertex-collection",
    )
    for feature_id, token in [(left_id, left_token), (right_id, right_token)]:
        await repository.acquire_feature_lock(
            context, project_id, dataset_id, feature_id, 1, token, 120, "shared-vertex-lock"
        )

    async def snapshot():
        page = await repository.list_features(
            context, project_id, dataset_id, bbox=None, limit=20, offset=0
        )
        histories = [
            await repository.list_feature_history(
                context, project_id, dataset_id, feature_id, 20, 0
            )
            for feature_id in (left_id, right_id)
        ]
        locks = await repository.list_feature_locks(context, project_id, dataset_id)
        return page, histories, locks

    before = await snapshot()
    records = [
        next(feature for feature in before[0].features if feature.feature_id == feature_id)
        for feature_id in (left_id, right_id)
    ]
    expected = ((right_id, 1, right_token), (left_id, 1, left_token))

    async def move(*, selected=expected, source=None, target=None, implementation=repository):
        return await implementation.move_shared_polygon_vertex(
            context,
            project_id,
            dataset_id,
            selected,
            [1, 1] if source is None else source,
            [1.2, 1] if target is None else target,
            "Move shared survey vertex",
            "native-shared-vertex",
        )

    # A valid partial boundary move can preserve the union while introducing
    # overlap, so exercise that check independently of validity/conservation.
    candidates = shared_polygon_vertex_drafts(records, fields, [1, 1], [1.2, 1])
    overlap = [
        {
            "before": records[index].geometry,
            "after": candidates[index].geometry if index == 0 else records[index].geometry,
        }
        for index in range(2)
    ]
    await cursor.execute(
        "SELECT ST_IsValid(a),ST_IsValid(b),ST_Relate(a,b,'2********'),"
        "ST_Equals(ST_UnaryUnion(ST_Collect(a,b)),ST_UnaryUnion(ST_Collect(c,d))) "
        "FROM (SELECT ST_GeomFromGeoJSON(%s::text) a,ST_GeomFromGeoJSON(%s::text) b,"
        "ST_GeomFromGeoJSON(%s::text) c,ST_GeomFromGeoJSON(%s::text) d) fixture",
        tuple(
            Jsonb(geometry)
            for geometry in [
                overlap[0]["after"],
                overlap[1]["after"],
                records[0].geometry,
                records[1].geometry,
            ]
        ),
    )
    assert await cursor.fetchone() == (True, True, True, True)
    await cursor.execute(_DISSOLVE_TIMEOUT_SQL)
    await cursor.execute(_MOVE_SHARED_POLYGON_VERTEX_SQL, (Jsonb(overlap),))
    assert await cursor.fetchone() == (False,)
    closure = shared_polygon_vertex_drafts(records, fields, [1, 0], [1.1, 0])
    await cursor.execute(
        _MOVE_SHARED_POLYGON_VERTEX_SQL,
        (
            Jsonb(
                [
                    {"before": record.geometry, "after": draft.geometry}
                    for record, draft in zip(records, closure, strict=True)
                ]
            ),
        ),
    )
    assert await cursor.fetchone() == (True,)
    with pytest.raises(FeatureInvalid, match="identical combined footprint"):
        await move(source=[1, 0], target=[1, 0.2])
    with pytest.raises(FeatureConflict, match="feature_version_conflict"):
        await move(selected=((right_id, 2, right_token), (left_id, 1, left_token)))
    with pytest.raises(FeatureConflict):
        await move(selected=((right_id, 1, None), (left_id, 1, left_token)))
    assert await snapshot() == before

    class FailAfterFirstHead(PostgresFeatureRepository):
        @staticmethod
        async def _advance_feature_lock_version(*args, **kwargs):
            await PostgresFeatureRepository._advance_feature_lock_version(*args, **kwargs)
            raise RuntimeError("injected failure after first head, revision and reservation")

    failing = FailAfterFirstHead(QueryExecutor(_PostgresTenantTransaction(cursor)))
    with pytest.raises(RuntimeError, match="injected failure"):
        async with connection.transaction():
            await move(implementation=failing)
    assert await snapshot() == before
    result = await move()
    assert (result.collection.generation, result.collection.feature_count) == (2, 2)
    assert [feature.feature_id for feature in result.updated_features] == [right_id, left_id]
    assert all(
        feature.geometry_type == feature.geometry["type"] == kind and feature.version_number == 2
        for feature in result.updated_features
    )
    page, histories, locks = await snapshot()
    assert {feature.feature_id for feature in page.features} == {left_id, right_id}
    for index, feature_id in enumerate((left_id, right_id)):
        current = next(
            feature for feature in result.updated_features if feature.feature_id == feature_id
        )
        assert current.properties == records[index].properties
        assert [(item.version_number, item.operation) for item in histories[index]] == [
            (2, "update"),
            (1, "create"),
        ]
        assert histories[index][-1].geometry == records[index].geometry
        assert histories[index][0].geometry == current.geometry
        assert all(
            item.properties == current.properties and item.geometry_type == kind
            for item in histories[index]
        )
        old_parts = records[index].geometry["coordinates"]
        new_parts = current.geometry["coordinates"]
        if kind == "MultiPolygon":
            assert old_parts[1:] == new_parts[1:]
            old_parts, new_parts = old_parts[0], new_parts[0]
        assert old_parts[1:] == new_parts[1:]  # every hole unchanged
    assert {lock.feature_id: lock.feature_version for lock in locks} == {left_id: 2, right_id: 2}
    assert all(lock.lock_token in (left_token, right_token) for lock in locks)
    deleted = await repository.list_deleted_features(
        context, project_id, dataset_id, limit=20, offset=0
    )
    assert deleted.tombstones == ()
    await cursor.execute(
        "SELECT ST_Equals(ST_UnaryUnion(ST_Collect(geom)),(SELECT ST_UnaryUnion(ST_Collect(geom)) "
        "FROM (SELECT ST_GeomFromGeoJSON(value::text) geom "
        "FROM jsonb_array_elements(%s::jsonb)) old)),"
        "sum(ST_Area(geom)),sum(ST_NumInteriorRings(ST_GeometryN(geom,1))) "
        "FROM (SELECT ST_GeomFromGeoJSON(value::text) geom "
        "FROM jsonb_array_elements(%s::jsonb)) current",
        (
            Jsonb([record.geometry for record in records]),
            Jsonb([feature.geometry for feature in result.updated_features]),
        ),
    )
    conserved, area, holes = await cursor.fetchone()
    assert (
        conserved is True
        and area == pytest.approx(5.9 if kind == "MultiPolygon" else 3.9)
        and holes == 1
    )


async def native_connected_polygon_dissolve(
    connection, cursor, repository, context, project_id, dataset_id, fields
):
    from opengeo_api.tenant_database import _PostgresTenantTransaction

    retained_id, donor_id, separate_id = uuid4(), uuid4(), uuid4()
    retained_token, donor_token = uuid4(), uuid4()
    retained_geometry = {
        "type": "Polygon",
        "coordinates": [
            [[1, 0], [4, 0], [4, 4], [1, 4], [1, 0]],
            [[2, 1], [2, 3], [3, 3], [3, 1], [2, 1]],
        ],
    }
    donor_geometry = {
        "type": "Polygon",
        "coordinates": [
            [[0, 0], [1, 0], [1, 4], [0, 4], [0, 0]],
        ],
    }
    separate_geometry = {
        "type": "Polygon",
        "coordinates": [
            [[10, 0], [11, 0], [11, 1], [10, 1], [10, 0]],
        ],
    }
    original = {
        "type": "Polygon",
        "coordinates": [
            [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
            retained_geometry["coordinates"][1],
        ],
    }
    await repository.create_collection(
        context,
        project_id,
        dataset_id,
        "Polygon",
        fields,
        tuple(
            feature_draft(geometry, {"name": name}, fields, feature_id)
            for feature_id, geometry, name in [
                (retained_id, retained_geometry, "Retained parcel"),
                (donor_id, donor_geometry, "Donor parcel"),
                (separate_id, separate_geometry, "Separate parcel"),
            ]
        ),
        "polygon-dissolve-collection",
    )
    for feature_id, token in [(retained_id, retained_token), (donor_id, donor_token)]:
        await repository.acquire_feature_lock(
            context, project_id, dataset_id, feature_id, 1, token, 120, "polygon-dissolve-lock"
        )

    async def snapshot():
        page = await repository.list_features(
            context, project_id, dataset_id, bbox=None, limit=20, offset=0
        )
        histories = [
            await repository.list_feature_history(
                context, project_id, dataset_id, feature_id, 20, 0
            )
            for feature_id in (retained_id, donor_id)
        ]
        locks = await repository.list_feature_locks(context, project_id, dataset_id)
        return page, histories, locks

    before = await snapshot()
    selection = ((retained_id, 1, retained_token), (donor_id, 1, donor_token))

    async def merge(selected=selection, operation="dissolve", implementation=repository):
        return await implementation.merge_multipolygon_features(
            context,
            project_id,
            dataset_id,
            retained_id,
            selected,
            None,
            "native-connected-polygon-dissolve",
            geometry_operation=operation,
        )

    with pytest.raises(FeatureInvalid, match="explicit dissolve"):
        await merge(operation="collect")
    with pytest.raises(FeatureInvalid, match="connected Polygon"):
        await merge(((retained_id, 1, retained_token), (separate_id, 1, None)))
    with pytest.raises(FeatureConflict):
        await merge(((retained_id, 1, None), (donor_id, 1, donor_token)))
    with pytest.raises(FeatureConflict, match="feature_version_conflict"):
        await merge(((retained_id, 1, retained_token), (donor_id, 2, donor_token)))
    assert await snapshot() == before

    class FailAfterTombstone(PostgresFeatureRepository):
        @staticmethod
        async def _tombstone_feature_head(*args, **kwargs):
            await PostgresFeatureRepository._tombstone_feature_head(*args, **kwargs)
            raise RuntimeError("injected failure after donor tombstone and revision")

    failing = FailAfterTombstone(QueryExecutor(_PostgresTenantTransaction(cursor)))
    with pytest.raises(RuntimeError, match="injected failure"):
        async with connection.transaction():
            await merge(implementation=failing)
    assert await snapshot() == before

    merged = await merge()
    assert merged.collection.geometry_type == merged.retained_feature.geometry_type == "Polygon"
    assert merged.retained_feature.geometry["type"] == "Polygon"
    assert merged.retained_feature.feature_id == retained_id
    assert merged.retained_feature.version_number == 2
    assert merged.retained_feature.properties == {"name": "Retained parcel"}
    assert merged.created_features == ()
    assert [(item.feature_id, item.deleted_version) for item in merged.deleted_features] == [
        (donor_id, 2)
    ]
    assert (merged.collection.generation, merged.collection.feature_count) == (2, 2)
    await cursor.execute(
        "SELECT ST_Equals(geom,ST_GeomFromGeoJSON(%s::text)),ST_Area(geom),"
        "ST_NumInteriorRings(geom),ST_IsValid(geom),ST_GeometryType(geom) "
        "FROM (SELECT ST_GeomFromGeoJSON(%s::text) AS geom) result",
        (Jsonb(original), Jsonb(merged.retained_feature.geometry)),
    )
    assert await cursor.fetchone() == (True, 14, 1, True, "ST_Polygon")
    page, histories, locks = await snapshot()
    assert {feature.feature_id for feature in page.features} == {retained_id, separate_id}
    assert (
        next(feature for feature in page.features if feature.feature_id == separate_id).geometry
        == separate_geometry
    )
    assert (
        next(feature for feature in page.features if feature.feature_id == retained_id)
        == merged.retained_feature
    )
    retained_history, donor_history = histories
    assert [(item.version_number, item.operation) for item in retained_history] == [
        (2, "update"),
        (1, "create"),
    ]
    assert [(item.version_number, item.operation) for item in donor_history] == [
        (2, "delete"),
        (1, "create"),
    ]
    assert retained_history[-1].geometry == retained_geometry
    assert donor_history[0].geometry == donor_history[-1].geometry == donor_geometry
    assert donor_history[0].properties == {"name": "Donor parcel"}
    assert all(
        item.geometry_type == item.geometry["type"] == "Polygon"
        for history in histories
        for item in history
    )
    assert len(locks) == 1 and locks[0].feature_id == retained_id
    assert locks[0].feature_version == 2 and locks[0].lock_token == retained_token
    deleted = await repository.list_deleted_features(
        context, project_id, dataset_id, limit=20, offset=0
    )
    assert [(item.feature_id, item.deleted_version) for item in deleted.tombstones] == [
        (donor_id, 2)
    ]
    after = await snapshot()
    with pytest.raises(FeatureConflict, match="feature_version_conflict"):
        await merge(((retained_id, 1, retained_token), (separate_id, 1, None)))
    assert await snapshot() == after


@pytest.mark.skipif(
    not os.environ.get("OPENGEO_FEATURE_TEST_DSN"), reason="explicit local PostGIS DSN required"
)
@pytest.mark.parametrize(
    ("polygon_geometry_type", "polygon_operation"),
    [
        ("MultiPolygon", "cut"),
        ("Polygon", "cut"),
        ("Polygon", "dissolve"),
        ("Polygon", "shared_vertex"),
    ],
    ids=["MultiPolygon", "Polygon", "PolygonDissolve", "SharedVertex"],
)
def test_native_postgis_typed_text_feature_crud_and_history(
    polygon_geometry_type, polygon_operation
) -> None:
    """Use the fully migrated local database and roll back every fixture row."""
    import psycopg
    from psycopg.types.string import StrDumper

    from opengeo_api.tenant_database import _PostgresTenantTransaction

    async def scenario() -> None:
        async with await psycopg.AsyncConnection.connect(
            os.environ["OPENGEO_FEATURE_TEST_DSN"], autocommit=True
        ) as connection:
            if connection.info.host != "db" and not connection.info.host.startswith("/tmp/"):
                raise ValueError("use a disposable, fully migrated local PostGIS database")
            async with connection.transaction(force_rollback=True), connection.cursor() as cursor:
                user_id, organization_id, project_id, dataset_id = (uuid4() for _ in range(4))
                initial_id, feature_id = uuid4(), uuid4()
                polygon_dataset_id, polygon_feature_id = uuid4(), uuid4()
                await cursor.execute(
                    "INSERT INTO app.users (id,cognito_subject,email,display_name) "
                    "VALUES (%s,%s,%s,'Feature typed-text regression')",
                    (user_id, f"feature-text-{user_id}", f"{user_id}@example.test"),
                )
                await cursor.execute(
                    "INSERT INTO app.organizations (id,name,slug,created_by) "
                    "VALUES (%s,'Feature typed-text regression',%s,%s)",
                    (organization_id, f"feature-text-{organization_id}", user_id),
                )
                await cursor.execute(
                    "INSERT INTO app.organization_memberships "
                    "(organization_id,user_id,role,invited_by) VALUES (%s,%s,'admin',%s)",
                    (organization_id, user_id, user_id),
                )
                await cursor.execute(
                    "INSERT INTO app.projects (id,organization_id,name,created_by) "
                    "VALUES (%s,%s,'Feature typed-text regression',%s)",
                    (project_id, organization_id, user_id),
                )
                await cursor.execute(
                    "INSERT INTO app.datasets "
                    "(id,organization_id,name,classification,source_type,format,status,"
                    "owner_user_id,created_by,updated_by) "
                    "VALUES (%s,%s,'Survey points','internal','upload','geojson','active',"
                    "%s,%s,%s)",
                    (dataset_id, organization_id, user_id, user_id, user_id),
                )
                await cursor.execute(
                    "INSERT INTO app.project_datasets "
                    "(organization_id,project_id,dataset_id,linked_by) VALUES (%s,%s,%s,%s)",
                    (organization_id, project_id, dataset_id, user_id),
                )
                await cursor.execute(
                    "INSERT INTO app.datasets "
                    "(id,organization_id,name,classification,source_type,format,status,"
                    "owner_user_id,created_by,updated_by) "
                    "VALUES (%s,%s,'Cut polygons','internal','upload','geojson','active',%s,%s,%s)",
                    (polygon_dataset_id, organization_id, user_id, user_id, user_id),
                )
                await cursor.execute(
                    "INSERT INTO app.project_datasets "
                    "(organization_id,project_id,dataset_id,linked_by) VALUES (%s,%s,%s,%s)",
                    (organization_id, project_id, polygon_dataset_id, user_id),
                )
                # psycopg normally sends strings as unknown. Data API strings are
                # text (OID 25), so register the text dumper after fixture setup.
                connection.adapters.register_dumper(str, StrDumper)
                cursor.adapters.register_dumper(str, StrDumper)
                await cursor.execute("SET LOCAL ROLE opengeo_runtime")
                await cursor.execute(
                    "SELECT set_config('app.user_id',%s,true),"
                    "set_config('app.organization_id',%s,true),pg_typeof(%s)::text,current_user",
                    (str(user_id), str(organization_id), "Point"),
                )
                assert (await cursor.fetchone())[2:] == ("text", "opengeo_runtime")
                repository = PostgresFeatureRepository(
                    QueryExecutor(_PostgresTenantTransaction(cursor))
                )
                context = TenantContext(user_id=user_id, organization_id=organization_id)
                fields = normalize_fields([{"name": "name", "type": "string", "required": True}])
                if polygon_operation == "shared_vertex":
                    for shared_dataset, shared_kind in [
                        (polygon_dataset_id, "Polygon"),
                        (dataset_id, "MultiPolygon"),
                    ]:
                        await native_shared_polygon_vertex(
                            connection,
                            cursor,
                            repository,
                            context,
                            project_id,
                            shared_dataset,
                            fields,
                            shared_kind,
                        )
                    return
                if polygon_operation == "dissolve":
                    await native_connected_polygon_dissolve(
                        connection,
                        cursor,
                        repository,
                        context,
                        project_id,
                        polygon_dataset_id,
                        fields,
                    )
                    return
                initial_geometry = {"type": "Point", "coordinates": [-71.1, 42.3]}
                changed_geometry = {"type": "Point", "coordinates": [-71.2, 42.4]}
                initial = feature_draft(
                    initial_geometry, {"name": "Initial station"}, fields, initial_id
                )

                async def validate_revisions() -> None:
                    # Check deferred head/revision integrity before the final rollback.
                    await cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
                    await cursor.execute("SET CONSTRAINTS ALL DEFERRED")

                page = await repository.create_collection(
                    context, project_id, dataset_id, "Point", fields, (initial,), "text-collection"
                )
                assert page.collection.geometry_type == "Point"
                assert (page.collection.generation, page.collection.feature_count) == (1, 1)
                assert page.features[0].geometry == initial_geometry
                await validate_revisions()
                draft = feature_draft(
                    initial_geometry, {"name": "Added station"}, fields, feature_id
                )
                created = await repository.create_feature(
                    context, project_id, dataset_id, draft, "Add station", "text-create"
                )
                assert created.feature.version_number == 1
                assert (created.collection.generation, created.collection.feature_count) == (2, 2)
                await validate_revisions()
                changed_draft = feature_draft(
                    changed_geometry, {"name": "Revised station"}, fields, feature_id
                )
                changed = await repository.update_feature(
                    context,
                    project_id,
                    dataset_id,
                    feature_id,
                    1,
                    changed_draft,
                    "Move station",
                    "text-update",
                )
                assert changed.feature.version_number == 2
                assert changed.feature.geometry == changed_geometry
                assert (changed.collection.generation, changed.collection.feature_count) == (3, 2)
                await validate_revisions()
                history = await repository.list_feature_history(
                    context, project_id, dataset_id, feature_id, 20, 0
                )
                assert [
                    (item.version_number, item.operation, item.request_id) for item in history
                ] == [
                    (2, "update", "text-update"),
                    (1, "create", "text-create"),
                ]
                with pytest.raises(FeatureConflict, match="feature_version_conflict"):
                    await repository.update_feature(
                        context,
                        project_id,
                        dataset_id,
                        feature_id,
                        1,
                        draft,
                        "Stale overwrite",
                        "text-stale",
                    )
                retained = await repository.list_features(
                    context, project_id, dataset_id, bbox=None, limit=20, offset=0
                )
                assert retained.collection.generation == 3
                assert retained.collection.feature_count == 2
                retained_feature = next(
                    item for item in retained.features if item.feature_id == feature_id
                )
                assert retained_feature == changed.feature
                assert (
                    await repository.list_feature_history(
                        context, project_id, dataset_id, feature_id, 20, 0
                    )
                    == history
                )
                deleted = await repository.delete_feature(
                    context, project_id, dataset_id, feature_id, 2, "Remove station", "text-delete"
                )
                assert (deleted.deleted_version, deleted.collection_generation) == (3, 4)
                await validate_revisions()
                restored = await repository.restore_feature(
                    context,
                    project_id,
                    dataset_id,
                    feature_id,
                    3,
                    2,
                    "Restore station",
                    "text-restore",
                )
                assert restored.feature.version_number == 4
                assert restored.feature.geometry == changed_geometry
                assert restored.feature.properties == {"name": "Revised station"}
                assert (restored.collection.generation, restored.collection.feature_count) == (5, 2)
                await validate_revisions()
                history = await repository.list_feature_history(
                    context, project_id, dataset_id, feature_id, 20, 0
                )
                assert [(item.version_number, item.operation) for item in history] == [
                    (4, "restore"),
                    (3, "delete"),
                    (2, "update"),
                    (1, "create"),
                ]
                assert history[-1].geometry == initial_geometry
                assert history[-1].properties == {"name": "Added station"}

                # Cut through the same runtime authority, typed-text transport,
                # immutable history and reservation path as ordinary edits.
                polygon_geometry, _pieces = cut_source_and_pieces()
                polygon_geometry["coordinates"][0].append([[2, 1], [2, 3], [3, 3], [3, 1], [2, 1]])
                if polygon_geometry_type == "Polygon":
                    polygon_geometry = {
                        "type": "Polygon",
                        "coordinates": polygon_geometry["coordinates"][0],
                    }
                polygon_draft = feature_draft(
                    polygon_geometry, {"name": "Survey areas"}, fields, polygon_feature_id
                )
                await repository.create_collection(
                    context,
                    project_id,
                    polygon_dataset_id,
                    polygon_geometry_type,
                    fields,
                    (polygon_draft,),
                    "cut-collection",
                )
                lock_token = uuid4()
                await repository.acquire_feature_lock(
                    context,
                    project_id,
                    polygon_dataset_id,
                    polygon_feature_id,
                    1,
                    lock_token,
                    120,
                    "cut-lock",
                )
                cut = await repository.cut_multipolygon_feature(
                    context,
                    project_id,
                    polygon_dataset_id,
                    polygon_feature_id,
                    1,
                    0,
                    {"type": "LineString", "coordinates": [[1, -1], [1, 5]]},
                    "Cut survey area",
                    "native-cut",
                    lock_token,
                )
                assert cut.retained_feature.feature_id == polygon_feature_id
                assert cut.retained_feature.version_number == 2
                assert (cut.collection.generation, cut.collection.feature_count) == (2, 2)
                if polygon_geometry_type == "Polygon":
                    assert len(cut.retained_feature.geometry["coordinates"]) == 2  # original hole
                else:
                    assert len(cut.retained_feature.geometry["coordinates"][0]) == 2
                    assert (
                        cut.retained_feature.geometry["coordinates"][1]
                        == polygon_geometry["coordinates"][1]
                    )
                assert cut.created_features[0].properties == {"name": "Survey areas"}
                assert cut.collection.geometry_type == polygon_geometry_type
                assert cut.retained_feature.geometry_type == polygon_geometry_type
                assert cut.created_features[0].geometry_type == polygon_geometry_type
                assert len(cut.created_features[0].geometry["coordinates"]) == 1
                await cursor.execute(
                    "SELECT ST_Equals(ST_UnaryUnion(ST_Collect(geom)),"
                    "ST_GeomFromGeoJSON(%s::text)),sum(ST_Area(geom)),"
                    "sum(ST_NumInteriorRings(ST_GeometryN(geom,1))) "
                    "FROM (SELECT ST_GeomFromGeoJSON(value::text) AS geom "
                    "FROM jsonb_array_elements(%s::jsonb)) pieces",
                    (
                        Jsonb(polygon_geometry),
                        Jsonb([cut.retained_feature.geometry, cut.created_features[0].geometry]),
                    ),
                )
                assert await cursor.fetchone() == (
                    True,
                    14 if polygon_geometry_type == "Polygon" else 15,
                    1,
                )
                locks = await repository.list_feature_locks(context, project_id, polygon_dataset_id)
                assert locks[0].feature_version == 2 and locks[0].lock_token == lock_token
                cut_history = await repository.list_feature_history(
                    context, project_id, polygon_dataset_id, polygon_feature_id, 20, 0
                )
                assert [(item.version_number, item.operation) for item in cut_history] == [
                    (2, "update"),
                    (1, "create"),
                ]
                assert cut_history[-1].geometry == polygon_geometry
                await validate_revisions()
                with pytest.raises(FeatureConflict, match="feature_version_conflict"):
                    await repository.cut_multipolygon_feature(
                        context,
                        project_id,
                        polygon_dataset_id,
                        polygon_feature_id,
                        1,
                        0,
                        {"type": "LineString", "coordinates": [[3.5, -1], [3.5, 5]]},
                        None,
                        "native-cut-stale",
                        lock_token,
                    )

                class FailAfterInsert(PostgresFeatureRepository):
                    @staticmethod
                    async def _insert_feature(*args, **kwargs):
                        await PostgresFeatureRepository._insert_feature(*args, **kwargs)
                        raise RuntimeError("injected failure after new feature insertion")

                failing = FailAfterInsert(QueryExecutor(_PostgresTenantTransaction(cursor)))
                with pytest.raises(RuntimeError, match="injected failure"):
                    async with connection.transaction():
                        await failing.cut_multipolygon_feature(
                            context,
                            project_id,
                            polygon_dataset_id,
                            polygon_feature_id,
                            2,
                            0,
                            {"type": "LineString", "coordinates": [[3.5, -1], [3.5, 5]]},
                            None,
                            "native-cut-rollback",
                            lock_token,
                        )
                reopened = await repository.list_features(
                    context, project_id, polygon_dataset_id, bbox=None, limit=20, offset=0
                )
                assert (reopened.collection.generation, reopened.collection.feature_count) == (2, 2)
                assert {item.feature_id for item in reopened.features} == {
                    cut.retained_feature.feature_id,
                    cut.created_features[0].feature_id,
                }
                assert (
                    next(
                        item for item in reopened.features if item.feature_id == polygon_feature_id
                    )
                    == cut.retained_feature
                )
                assert (
                    await repository.list_feature_history(
                        context, project_id, polygon_dataset_id, polygon_feature_id, 20, 0
                    )
                    == cut_history
                )
                assert (
                    await repository.list_feature_locks(context, project_id, polygon_dataset_id)
                )[0].feature_version == 2
                await validate_revisions()

    asyncio.run(scenario())


def test_repository_lists_deleted_feature_tombstones_with_bounded_paging() -> None:
    schema = {"schemaVersion": "1.0.0", "fields": []}
    deleted_at = NOW + timedelta(minutes=2)
    transaction = QueryTransaction(
        one=[
            ("member", "viewer", None, False, "active", "geojson"),
            (DATASET_ID, "Point", schema, 7, 0, USER_ID, NOW, USER_ID, NOW),
            (1,),
        ],
        all_rows=[[(FEATURE_ID, 3, USER_ID, deleted_at, deleted_at)]],
    )

    page = asyncio.run(
        PostgresFeatureRepository(QueryExecutor(transaction)).list_deleted_features(
            TenantContext(user_id=USER_ID, organization_id=ORG_ID),
            PROJECT_ID,
            DATASET_ID,
            limit=20,
            offset=0,
        )
    )

    assert isinstance(page, FeatureTombstonePage)
    assert page.number_matched == 1
    assert page.tombstones[0].feature_id == FEATURE_ID
    assert page.tombstones[0].deleted_version == 3
    assert page.tombstones[0].deleted_at == deleted_at
    rows_call = transaction.calls[3]
    assert rows_call[0] == "all"
    assert "deleted_at IS NOT NULL" in rows_call[1]
    assert "ORDER BY deleted_at DESC, id" in rows_call[1]
    assert rows_call[2][-2:] == (20, 0)


def test_repository_restores_deleted_feature_from_immutable_revision_atomically() -> None:
    schema = {
        "schemaVersion": "1.0.0",
        "fields": [{"name": "name", "type": "string", "required": True}],
    }
    geometry = {"type": "Point", "coordinates": [-71.1, 42.3]}
    restored_row = (
        FEATURE_ID,
        4,
        "Point",
        {"name": "Recovered station"},
        geometry,
        (-71.1, 42.3, -71.1, 42.3),
        USER_ID,
        NOW,
        USER_ID,
        NOW,
    )
    transaction = QueryTransaction(
        one=[
            ("member", "editor", None, False, "active", "geojson"),
            (DATASET_ID, "Point", schema, 9, 0, USER_ID, NOW, USER_ID, NOW),
            (3, NOW),
            ("Point", {"name": "Recovered station"}, geometry),
            restored_row,
            (10, 1, NOW),
        ]
    )

    result = asyncio.run(
        PostgresFeatureRepository(QueryExecutor(transaction)).restore_feature(
            TenantContext(user_id=USER_ID, organization_id=ORG_ID),
            PROJECT_ID,
            DATASET_ID,
            FEATURE_ID,
            3,
            1,
            "Recover field capture",
            "feature-restore-request",
        )
    )

    assert result.feature.feature_id == FEATURE_ID
    assert result.feature.version_number == 4
    assert result.feature.geometry == geometry
    assert result.collection.generation == 10
    assert result.collection.feature_count == 1
    restore_head = next(
        call for call in transaction.calls if call[0] == "one" and "deleted_by = NULL" in call[1]
    )
    assert "deleted_at IS NOT NULL AND version_number = %s" in restore_head[1]
    restore_revision = next(
        call
        for call in transaction.calls
        if call[0] == "execute" and "INSERT INTO app.dataset_feature_revisions" in call[1]
    )
    assert restore_revision[2][4] == "restore"
    assert restore_revision[2][3] == 4
    assert any(
        "dataset.feature.restored" in parameters
        for _kind, _statement, parameters in transaction.calls
    )
    assert (
        sum(
            "UPDATE app.feature_collections" in statement
            for _kind, statement, _parameters in transaction.calls
        )
        == 1
    )


def test_repository_restore_rejects_live_or_stale_feature_without_writes() -> None:
    schema = {"schemaVersion": "1.0.0", "fields": []}
    scope = ("member", "editor", None, False, "active", "geojson")
    collection = (DATASET_ID, "Point", schema, 9, 0, USER_ID, NOW, USER_ID, NOW)

    live_transaction = QueryTransaction(one=[scope, collection, (3, None)])
    with pytest.raises(FeatureConflict) as live_error:
        asyncio.run(
            PostgresFeatureRepository(QueryExecutor(live_transaction)).restore_feature(
                TenantContext(user_id=USER_ID, organization_id=ORG_ID),
                PROJECT_ID,
                DATASET_ID,
                FEATURE_ID,
                3,
                1,
                None,
                "feature-restore-live",
            )
        )
    assert live_error.value.code == "feature_not_deleted"
    assert not any(call[0] == "execute" for call in live_transaction.calls)

    stale_transaction = QueryTransaction(one=[scope, collection, (4, NOW)])
    with pytest.raises(FeatureConflict) as stale_error:
        asyncio.run(
            PostgresFeatureRepository(QueryExecutor(stale_transaction)).restore_feature(
                TenantContext(user_id=USER_ID, organization_id=ORG_ID),
                PROJECT_ID,
                DATASET_ID,
                FEATURE_ID,
                3,
                1,
                None,
                "feature-restore-stale",
            )
        )
    assert stale_error.value.code == "feature_version_conflict"
    assert stale_error.value.current_version == 4
    assert not any(call[0] == "execute" for call in stale_transaction.calls)


def feature_row(
    feature_id: UUID,
    version: int,
    geometry: dict[str, Any],
    bbox: tuple[float, float, float, float],
    *,
    geometry_type: str = "MultiPolygon",
) -> tuple[Any, ...]:
    return (
        feature_id,
        version,
        geometry_type,
        {"name": "Survey areas"},
        geometry,
        bbox,
        USER_ID,
        NOW,
        USER_ID,
        NOW,
    )


def test_cql2_list_count_and_page_share_parameters_and_scope():
    scope = ("member", "viewer", None, False, "active", "geojson")
    schema = {"schemaVersion": "1.0.0", "fields": [{"name": "value", "type": "number"}]}
    collection = (DATASET_ID, "Point", schema, 9, 3, USER_ID, NOW, USER_ID, NOW)
    transaction = QueryTransaction(one=[scope, collection, (2,)], all_rows=[[]])
    bbox = (-78, 38, -76, 40)
    page = asyncio.run(
        PostgresFeatureRepository(QueryExecutor(transaction)).list_features(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            DATASET_ID,
            bbox=bbox,
            limit=1,
            offset=1,
            expected_generation=9,
            cql2_filter=("value > 2", "cql2-text"),
        )
    )
    assert page.number_matched == 2
    count, rows = transaction.calls[-2:]
    assert count[2] == (ORG_ID, DATASET_ID, *bbox, *bbox, "value", 2)
    assert rows[2] == (*count[2], 1, 1)
    for _, query, _ in (count, rows):
        assert "deleted_at IS NULL" in query and "ST_Intersects" in query
        assert "::numeric > %s" in query and "organization_id = %s" in query


@pytest.mark.parametrize(
    ("operator", "shown", "hidden"),
    [
        ("ne", 9, 10),
        ("gt", 11, 10),
        ("gte", 10, 9),
        ("lt", 9, 10),
        ("lte", 10, 11),
    ],
)
def test_relational_field_visibility(operator, shown, hidden):
    rule = {"field": "score", "equals": 10, "operator": operator}
    fields = normalize_fields(
        [
            {"name": "score", "type": "number", "required": False},
            {"name": "reason", "type": "string", "required": True, "visible_when": rule},
        ]
    )
    assert feature_field_document(fields[1])["visible_when"] == rule
    assert normalize_properties({"score": shown, "reason": "review"}, fields)["reason"] == "review"
    assert normalize_properties({"score": hidden}, fields) == {"score": hidden}
    assert normalize_properties({}, fields) == {}
    with pytest.raises(FeatureInvalid, match="hidden"):
        normalize_properties({"score": hidden, "reason": "review"}, fields)
    with pytest.raises(FeatureInvalid):
        normalize_properties({"score": shown}, fields)


def test_ordered_visibility_rejects_text_controller():
    with pytest.raises(FeatureInvalid, match="numeric"):
        normalize_fields(
            [
                {"name": "kind", "type": "string", "required": False},
                {
                    "name": "note",
                    "type": "string",
                    "required": False,
                    "visible_when": {"field": "kind", "equals": "x", "operator": "gt"},
                },
            ]
        )


def test_cross_field_visibility_uses_each_repeat_record_and_preserves_rule():
    rule = {"field": "measured", "value_field": "limit", "operator": "gt"}
    fields = normalize_fields(
        [
            {
                "name": "readings",
                "type": "group",
                "repeat": True,
                "min_items": 0,
                "max_items": 5,
                "fields": [
                    {"name": "measured", "type": "number"},
                    {"name": "limit", "type": "integer"},
                    {"name": "reason", "type": "string", "required": True, "visible_when": rule},
                ],
            }
        ]
    )
    assert feature_field_document(fields[0])["fields"][2]["visible_when"] == rule
    data = {
        "readings": [
            {"measured": 11, "limit": 10, "reason": "review"},
            {"measured": 9, "limit": 10},
            {"measured": 11},
        ]
    }
    assert normalize_properties(data, fields) == data
    with pytest.raises(FeatureInvalid, match="hidden"):
        normalize_properties({"readings": [{"measured": 9, "limit": 10, "reason": "bad"}]}, fields)
    with pytest.raises(FeatureInvalid):
        normalize_properties({"readings": [{"measured": 11, "limit": 10}]}, fields)


@pytest.mark.parametrize(
    "rule",
    [
        {"field": "score", "value_field": "later"},
        {"field": "score", "value_field": "name"},
        {"field": "score", "value_field": "score", "equals": 10},
    ],
)
def test_cross_field_visibility_rejects_invalid_operands(rule):
    with pytest.raises(FeatureInvalid):
        normalize_fields(
            [
                {"name": "score", "type": "number"},
                {"name": "name", "type": "string"},
                {"name": "note", "type": "string", "visible_when": rule},
            ]
        )


def test_calculated_fields_recompute_and_reject_forged_values():
    formula = {"*": [{"var": "quantity"}, {"var": "price"}]}
    fields = normalize_fields(
        [
            {"name": "quantity", "type": "integer"},
            {"name": "price", "type": "number"},
            {"name": "total", "type": "number", "calculation": formula},
            {
                "name": "review",
                "type": "string",
                "visible_when": {"field": "total", "equals": 10, "operator": "gt"},
            },
        ]
    )
    assert feature_field_document(fields[2])["calculation"] == formula
    assert normalize_properties({"quantity": 3, "price": 4, "review": "large"}, fields) == {
        "quantity": 3,
        "price": 4,
        "total": 12,
        "review": "large",
    }
    assert normalize_properties({"quantity": 3}, fields) == {"quantity": 3}
    with pytest.raises(FeatureInvalid, match="differs"):
        normalize_properties({"quantity": 3, "price": 4, "total": 1}, fields)


def test_calculation_errors_and_schema_limits():
    fields = normalize_fields(
        [
            {"name": "n", "type": "number"},
            {"name": "result", "type": "number", "calculation": {"/": [1, {"var": "n"}]}},
        ]
    )
    with pytest.raises(FeatureInvalid, match="zero"):
        normalize_properties({"n": 0}, fields)
    for formula in [{"var": "later"}, {"eval": ["bad"]}, {"+": [True, 1]}, {"+": [1] * 17}]:
        with pytest.raises(FeatureInvalid):
            normalize_fields([{"name": "result", "type": "number", "calculation": formula}])


def test_attachment_fields_preserve_immutable_version_ids_and_reject_urls():
    from opengeo_api.features import _schema_definition

    fields = normalize_fields([{"name": "photo", "type": "string", "attachment": True}])
    version = "81000000-0000-4000-8000-000000000001"
    assert normalize_properties({"photo": version}, fields) == {"photo": version}
    assert feature_field_document(fields[0])["attachment"] is True
    assert _schema_definition(fields)["schemaVersion"] == "1.5.0"
    with pytest.raises(FeatureInvalid, match="UUID"):
        normalize_properties({"photo": "https://provider.invalid/private.jpg"}, fields)
    with pytest.raises(FeatureInvalid, match="strings"):
        normalize_fields([{"name": "photo", "type": "number", "attachment": True}])


def test_attachment_authority_is_batched_and_missing_or_revoked_versions_reject():
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from opengeo_api.features import authorize_feature_attachments

    version = UUID("81000000-0000-4000-8000-000000000001")
    context = TenantContext(
        UUID("81000000-0000-4000-8000-000000000002"), UUID("81000000-0000-4000-8000-000000000003")
    )
    fields = normalize_fields([{"name": "photo", "type": "string", "attachment": True}])
    fetch = AsyncMock(return_value=[(version, "member", False, None, "viewer")])
    transaction = SimpleNamespace(fetch_all=fetch)
    asyncio.run(
        authorize_feature_attachments(
            transaction, context, [{"photo": str(version)}, {"photo": str(version)}], fields
        )
    )
    assert fetch.await_count == 1
    assert fetch.call_args.args[1][-1] == [version]
    fetch.return_value = []
    with pytest.raises(FeatureInvalid, match="unavailable"):
        asyncio.run(
            authorize_feature_attachments(transaction, context, [{"photo": str(version)}], fields)
        )
    fetch.return_value = [(version, "member", False, None, None)]
    with pytest.raises(FeatureAccessDenied):
        asyncio.run(
            authorize_feature_attachments(transaction, context, [{"photo": str(version)}], fields)
        )
