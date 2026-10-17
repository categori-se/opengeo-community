import asyncio
import json
from dataclasses import replace

import pytest

from opengeo_api.postgis_catalog import ColumnDescriptor, GeometryDescriptor, RelationDescriptor
from opengeo_api.postgis_preview import (
    MAX_POSITIONS,
    MAX_RESPONSE_BYTES,
    PreviewFailure,
    PreviewSelection,
    bounded_preview_query,
    describe_selected_relation,
    preview_bbox,
    read_bounded_features,
)


def relation(*, schema="gis", name="plots", key="id", geom="shape"):
    return RelationDescriptor(
        schema,
        name,
        "r",
        (
            ColumnDescriptor(key, "pg_catalog", "int8", True, -1, None, True, True),
            ColumnDescriptor("amount", "pg_catalog", "numeric", False, -1, None, False, False),
            ColumnDescriptor("name", "pg_catalog", "text", False, -1, None, False, False),
            ColumnDescriptor(
                geom,
                "spatial",
                "geometry",
                False,
                1107460,
                GeometryDescriptor("POINT", 4326, "spatial"),
                False,
                False,
            ),
        ),
        key,
        (),
    )


def selection(descriptor=None):
    descriptor = descriptor or relation()
    return PreviewSelection(
        descriptor.schema,
        descriptor.name,
        descriptor.columns[-1].name,
        descriptor.stable_key,
        descriptor.schema_fingerprint_sha256,
    )


def feature(index=1, **properties):
    return {
        "type": "Feature",
        "id": str(index),
        "geometry": {"type": "Point", "coordinates": [85, 27]},
        "properties": {"id": str(index), "amount": "12345678901234567890.123456789", **properties},
    }


class Cursor:
    def __init__(self, *, rows=(), descriptor=None):
        self.rows = iter(rows)
        self.descriptor = descriptor or relation()
        self.calls = []
        self.closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        self.closed = True

    async def execute(self, statement, parameters=None):
        self.calls.append((statement, parameters))
        if isinstance(statement, str) and "transaction_read_only" in statement:
            self.rows = iter([("on", "4000", "1000", "pg_catalog")])
        elif isinstance(statement, str) and "pg_class" in statement:
            self.rows = iter([(55, self.descriptor.schema, self.descriptor.name, "r", False)])
        elif isinstance(statement, str) and "pg_attribute" in statement:
            self.rows = iter(
                [
                    (
                        c.name,
                        c.type_schema,
                        c.type_name,
                        c.not_null,
                        c.type_modifier,
                        f"spatial.geometry({c.geometry.geometry_type},4326)"
                        if c.geometry
                        else None,
                        "spatial" if c.geometry else None,
                        c.unique_key,
                        c.primary_key,
                    )
                    for c in self.descriptor.columns
                ]
            )

    async def fetchone(self):
        return next(self.rows, None)


class Connection:
    def __init__(self, rows, *, descriptor=None):
        self.metadata = Cursor(descriptor=descriptor)
        self.features = Cursor(rows=rows, descriptor=descriptor)
        self.names = []

    def cursor(self, **kwargs):
        if "name" in kwargs:
            self.names.append(kwargs["name"])
            return self.features
        return self.metadata


def read(rows, *, descriptor=None):
    connection = Connection(rows, descriptor=descriptor)
    result = asyncio.run(
        read_bounded_features(
            connection,
            selection(descriptor),
            ("gis",),
            (80, 20, 90, 30),
            cursor_name="preview_test",
        )
    )
    return result, connection


def test_schema_revalidation_locks_selected_relation_and_detects_changed_definition():
    descriptor = relation()
    cursor = Cursor()
    actual = asyncio.run(describe_selected_relation(cursor, selection(), ("gis",)))
    assert actual == descriptor
    assert cursor.calls[1][0].as_string() == 'LOCK TABLE ONLY "gis"."plots" IN ACCESS SHARE MODE'
    assert cursor.calls[2][1] == ("gis", "plots")
    assert cursor.calls[3][1] == (55, 65)
    changed = replace(selection(), schema_fingerprint="0" * 64)
    with pytest.raises(PreviewFailure, match="preview_schema_changed"):
        asyncio.run(describe_selected_relation(Cursor(), changed, ("gis",)))
    with pytest.raises(PreviewFailure, match="preview_representation_unsupported"):
        asyncio.run(describe_selected_relation(Cursor(), selection(), ("other",)))


def test_sql_is_quoted_value_bound_size_checked_and_precision_preserving():
    descriptor = relation(name='plots"; DROP TABLE secrets;--', key='key"id', geom='g"shape')
    query, parameters, encodings = bounded_preview_query(
        descriptor, selection(descriptor), ("gis",), (80, 20, 90, 30)
    )
    rendered = query.as_string()
    assert 'ONLY "gis"."plots""; DROP TABLE secrets;--"' in rendered
    assert '("row_value")."key""id"' in rendered
    assert '"spatial"."st_makeenvelope"(%s,%s,%s,%s,4326)' in rendered
    assert parameters == (
        80,
        20,
        90,
        30,
        101,
        MAX_RESPONSE_BYTES,
        MAX_POSITIONS,
        MAX_RESPONSE_BYTES,
        MAX_RESPONSE_BYTES,
    )
    for guard in (
        "pg_column_size",
        "octet_length",
        '"spatial"."st_npoints"',
        '"spatial"."st_ndims"',
        "NOT MATERIALIZED",
        'ORDER BY "ordinal"',
    ):
        assert guard in rendered
    assert encodings == {'key"id': "int64:string", "amount": "numeric:string"}
    assert "int64:string" not in rendered


def test_named_cursor_lookahead_limits_features_without_float_coercion():
    rows = [(None, json.dumps(feature(9_223_372_036_854_775_807 - index))) for index in range(101)]
    result, connection = read(rows)
    assert len(result.geojson["features"]) == 100 and result.truncated is True
    assert result.geojson["features"][0]["id"] == "9223372036854775807"
    assert result.geojson["features"][0]["properties"]["amount"] == "12345678901234567890.123456789"
    assert connection.names == ["preview_test"]
    assert connection.features.closed and connection.metadata.closed
    empty, _ = read([])
    assert empty.geojson == {"type": "FeatureCollection", "features": []}
    assert empty.truncated is False


def test_oversized_or_invalid_rows_fail_instead_of_silently_dropping_features():
    invalid = [
        (("preview_row_too_large", None), "preview_row_too_large"),
        ((None, "x" * (MAX_RESPONSE_BYTES + 1)), "preview_row_too_large"),
        ((None, json.dumps(feature(name="x" * 140_000))), "preview_limits_exceeded"),
    ]
    for row, code in invalid:
        rows = [row, row] if code == "preview_limits_exceeded" else [row]
        with pytest.raises(PreviewFailure, match=code):
            read(rows)
    malformed = feature()
    malformed["geometry"]["coordinates"] = [181, 27]
    with pytest.raises(PreviewFailure, match="preview_geometry_unsupported"):
        read([(None, json.dumps(malformed))])
    malformed["geometry"]["coordinates"] = [85, 27, 4]
    with pytest.raises(PreviewFailure, match="preview_geometry_unsupported"):
        read([(None, json.dumps(malformed))])


def test_geometry_budget_and_unknown_attributes_are_explicitly_unsupported():
    large = feature()
    large["geometry"] = {"type": "MultiPoint", "coordinates": [[0, 0]] * 5001}
    with pytest.raises(PreviewFailure, match="preview_limits_exceeded"):
        read([(None, json.dumps(large))] * 2)
    descriptor = relation()
    for columns in (
        (*descriptor.columns, replace(descriptor.columns[2], name="nested", type_name="jsonb")),
        (*descriptor.columns, replace(descriptor.columns[-1], name="other_shape")),
    ):
        unsupported = replace(descriptor, columns=columns)
        with pytest.raises(PreviewFailure, match="preview_representation_unsupported"):
            bounded_preview_query(unsupported, selection(unsupported), ("gis",), (80, 20, 90, 30))
    for value in ([0, 0, 0, 1], [-181, 0, 1, 1], [0, 0, float("nan"), 1], [0, False, 1, 1]):
        with pytest.raises(PreviewFailure):
            preview_bbox(value)


def test_sixty_four_columns_split_json_constructors_below_postgres_argument_limit():
    descriptor = relation()
    columns = (
        *descriptor.columns[:1],
        *(replace(descriptor.columns[2], name=f"property_{index}") for index in range(62)),
        descriptor.columns[-1],
    )
    for kind in ("p", "m", "v"):
        unsupported = replace(descriptor, kind=kind)
        with pytest.raises(PreviewFailure, match="preview_representation_unsupported"):
            bounded_preview_query(unsupported, selection(unsupported), ("gis",), (80, 20, 90, 30))
    descriptor = replace(descriptor, columns=columns)
    statement, _, _ = bounded_preview_query(
        descriptor, selection(descriptor), ("gis",), (80, 20, 90, 30)
    )
    rendered = statement.as_string()
    assert rendered.count("pg_catalog.jsonb_build_object(") == 3
    assert " || " in rendered
