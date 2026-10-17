"""Bounded feature reads from one revalidated PostGIS relation.

The connector owns the already-authorized, read-only connection. Identifiers come
from fresh fixed catalog queries; values are bound, and no caller SQL is accepted.
A named cursor receives only a server-size-checked JSON string or safe error code.
"""

import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from psycopg import sql

from opengeo_api.postgis_catalog import (
    _COLUMNS_SQL,
    _POLICY_SQL,
    CatalogCursor,
    CatalogFailure,
    RelationDescriptor,
    _column,
    _identifier,
    _relation,
    _schemas,
    build_postgis_preview_query,
)

MAX_FEATURES = 100
MAX_RESPONSE_BYTES = 262_144
MAX_POSITIONS = 10_000
ERROR_CODES = frozenset(
    {
        "preview_unavailable",
        "preview_stale",
        "preview_failed",
        "preview_timeout",
        "preview_limits_exceeded",
        "preview_schema_changed",
        "preview_representation_unsupported",
        "preview_geometry_unsupported",
        "preview_row_too_large",
    }
)
_SCALAR_TYPES = {
    "bool",
    "int2",
    "int4",
    "int8",
    "numeric",
    "float4",
    "float8",
    "text",
    "varchar",
    "bpchar",
    "uuid",
    "date",
    "timestamp",
    "timestamptz",
}
_SELECTED_RELATION_SQL = """
SELECT c.oid, n.nspname, c.relname, c.relkind,
       EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i
               WHERE i.inhparent = c.oid OR i.inhrelid = c.oid)
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = %s AND c.relname = %s
  AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
  AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
  AND pg_catalog.has_table_privilege(c.oid, 'SELECT')
LIMIT 1
"""


class PreviewFailure(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code if code in ERROR_CODES else "preview_failed"
        super().__init__(self.code)


class PreviewConnection(Protocol):
    def cursor(self, *args: Any, **kwargs: Any) -> Any: ...


@dataclass(frozen=True)
class PreviewSelection:
    schema_name: str
    relation_name: str
    geometry_column: str
    stable_key: str
    schema_fingerprint: str


@dataclass(frozen=True)
class PreviewFeatures:
    geojson: dict[str, Any]
    property_encodings: dict[str, str]
    truncated: bool


def preview_bbox(value: object) -> tuple[float, float, float, float]:
    if (
        not isinstance(value, list | tuple)
        or len(value) != 4
        or any(type(v) not in {int, float} or not math.isfinite(v) for v in value)
    ):
        raise PreviewFailure("preview_failed")
    west, south, east, north = value
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise PreviewFailure("preview_failed")
    return float(west), float(south), float(east), float(north)


async def describe_selected_relation(
    cursor: CatalogCursor, selection: PreviewSelection, allowed_schemas: tuple[str, ...]
) -> RelationDescriptor:
    """Recompute the discovery fingerprint without scanning other relations."""
    try:
        if selection.schema_name not in _schemas(allowed_schemas):
            raise PreviewFailure("preview_representation_unsupported")
        await cursor.execute(_POLICY_SQL, ("4000", "1000"))
        policy = await cursor.fetchone()
        if policy is None or policy[0] != "on":
            raise PreviewFailure("preview_failed")
        # Keep the selected definition stable from metadata through feature read.
        # ACCESS SHARE permits live data writes; it prevents concurrent DDL.
        await cursor.execute(
            sql.SQL("LOCK TABLE ONLY {} IN ACCESS SHARE MODE").format(
                sql.Identifier(selection.schema_name, selection.relation_name)
            )
        )
        await cursor.execute(
            _SELECTED_RELATION_SQL, (selection.schema_name, selection.relation_name)
        )
        row = await cursor.fetchone()
        if row is None:
            raise PreviewFailure("preview_schema_changed")
        oid, schema, name, kind, inherited = row
        await cursor.execute(_COLUMNS_SQL, (oid, 65))
        columns = []
        while (column := await cursor.fetchone()) is not None:
            columns.append(_column(column))
            if len(columns) > 64:
                break
        relation = _relation(
            schema,
            name,
            kind,
            tuple(columns[:64]),
            inherited=inherited,
            truncated=len(columns) > 64,
        )
        if (
            relation.schema != selection.schema_name
            or relation.name != selection.relation_name
            or relation.schema_fingerprint_sha256 != selection.schema_fingerprint
            or relation.stable_key != selection.stable_key
        ):
            raise PreviewFailure("preview_schema_changed")
        return relation
    except PreviewFailure:
        raise
    except CatalogFailure:
        raise PreviewFailure("preview_representation_unsupported") from None
    except Exception:
        raise PreviewFailure("preview_failed") from None


def bounded_preview_query(
    relation: RelationDescriptor,
    selection: PreviewSelection,
    allowed_schemas: tuple[str, ...],
    bbox: tuple[float, float, float, float],
) -> tuple[sql.Composed, tuple[object, ...], dict[str, str]]:
    """Build a bounded wire projection; raw table values never reach the driver."""
    if relation.kind != "r":
        raise PreviewFailure("preview_representation_unsupported")
    try:
        # Reuse the core eligibility/identifier/geometry/bounds contract.
        build_postgis_preview_query(
            relation,
            allowed_schemas=allowed_schemas,
            geometry_column=selection.geometry_column,
            bbox=bbox,
            max_rows=MAX_FEATURES,
        )
    except CatalogFailure as error:
        code = (
            "preview_geometry_unsupported"
            if error.code == "preview_geometry_unsupported"
            else "preview_representation_unsupported"
        )
        raise PreviewFailure(code) from None
    geometry_columns = [column for column in relation.columns if column.geometry is not None]
    if len(geometry_columns) != 1:
        raise PreviewFailure("preview_representation_unsupported")
    geometry = geometry_columns[0].geometry
    assert geometry is not None
    properties: list[sql.Composable] = []
    encodings = {}
    finite_checks = []
    size_checks = []
    for column in relation.columns:
        if column.geometry is not None:
            continue
        if column.type_schema != "pg_catalog" or column.type_name not in _SCALAR_TYPES:
            raise PreviewFailure("preview_representation_unsupported")
        reference: sql.Composable = sql.SQL('("row_value").{}').format(sql.Identifier(column.name))
        if column.type_name in {"text", "varchar", "bpchar"}:
            # Native text/bpchar octet_length reads the uncompressed length without allocating
            # an enormous JSON string for a highly compressed toasted attribute.
            size_checks.append(
                sql.SQL("pg_catalog.octet_length({}) > {}").format(
                    reference, sql.Literal(MAX_RESPONSE_BYTES)
                )
            )
        if column.type_name in {"int8", "numeric"}:
            reference = sql.SQL("({})::text").format(reference)
            encodings[column.name] = (
                "int64:string" if column.type_name == "int8" else "numeric:string"
            )
        if column.type_name in {"float4", "float8"}:
            finite_checks.append(
                sql.SQL("({})::text IN ('NaN','Infinity','-Infinity')").format(reference)
            )
        properties.extend((sql.Literal(column.name), reference))
    geom = sql.SQL('("row_value").{}').format(sql.Identifier(selection.geometry_column))
    source_geom = sql.SQL('"source".{}').format(sql.Identifier(selection.geometry_column))
    key = sql.Identifier(selection.stable_key)
    key_type = next(
        column.type_name for column in relation.columns if column.name == selection.stable_key
    )
    ordering = sql.SQL('{} COLLATE "C"').format(key) if key_type in {"text", "varchar"} else key

    def fn(name: str) -> sql.Identifier:
        return sql.Identifier(_identifier(geometry.postgis_schema), name)

    finite = sql.SQL(" OR ").join(finite_checks) if finite_checks else sql.SQL("false")
    oversized = sql.SQL(" OR ").join(size_checks) if size_checks else sql.SQL("false")
    property_objects = sql.SQL(" || ").join(
        sql.SQL("pg_catalog.jsonb_build_object({})").format(
            sql.SQL(", ").join(properties[offset : offset + 64])
        )
        for offset in range(0, len(properties), 64)
    )
    statement = sql.SQL("""
WITH selected AS NOT MATERIALIZED (
  SELECT "source" AS "row_value",
         pg_catalog.row_number() OVER (ORDER BY {ordering}) AS "ordinal"
  FROM ONLY {relation} AS "source"
  WHERE {intersects}({source_geom}, {envelope}(%s,%s,%s,%s,4326))
  ORDER BY {ordering} LIMIT %s
), checked AS NOT MATERIALIZED (
  SELECT "row_value", "ordinal", CASE
    WHEN pg_catalog.pg_column_size("row_value") > %s OR {oversized}
      THEN 'preview_row_too_large'
    WHEN {npoints}({geom}) > %s THEN 'preview_limits_exceeded'
    WHEN {dims}({geom}) <> 2 OR {srid}({geom}) <> 4326
      OR {isempty}({geom}) OR {geometrytype}({geom}) NOT IN
        ('POINT','LINESTRING','POLYGON','MULTIPOINT','MULTILINESTRING','MULTIPOLYGON')
      THEN 'preview_geometry_unsupported'
    WHEN {finite} THEN 'preview_representation_unsupported'
    ELSE NULL END AS "row_error"
  FROM selected
), encoded AS MATERIALIZED (
  SELECT "ordinal", "row_error", CASE WHEN "row_error" IS NULL THEN
    pg_catalog.jsonb_build_object(
      'type','Feature', 'id',({key_ref})::text,
      'geometry',({asgeojson}({geom},17,0))::jsonb,
      'properties',({properties}))::text
    END AS "feature_text"
  FROM checked
)
SELECT CASE WHEN pg_catalog.octet_length("feature_text") > %s
            THEN 'preview_row_too_large' ELSE "row_error" END,
       CASE WHEN "row_error" IS NULL AND pg_catalog.octet_length("feature_text") <= %s
            THEN "feature_text" END
FROM encoded
ORDER BY "ordinal"
""").format(
        relation=sql.Identifier(relation.schema, relation.name),
        intersects=fn("st_intersects"),
        envelope=fn("st_makeenvelope"),
        source_geom=source_geom,
        ordering=ordering,
        npoints=fn("st_npoints"),
        geom=geom,
        dims=fn("st_ndims"),
        srid=fn("st_srid"),
        isempty=fn("st_isempty"),
        geometrytype=fn("geometrytype"),
        finite=finite,
        oversized=oversized,
        key_ref=sql.SQL('("row_value").{}').format(key),
        asgeojson=fn("st_asgeojson"),
        properties=property_objects,
    )
    parameters = (
        *bbox,
        MAX_FEATURES + 1,
        MAX_RESPONSE_BYTES,
        MAX_POSITIONS,
        MAX_RESPONSE_BYTES,
        MAX_RESPONSE_BYTES,
    )
    return statement, parameters, encodings


def _geometry_positions(geometry: object) -> int:
    if not isinstance(geometry, dict) or set(geometry) != {"type", "coordinates"}:
        raise PreviewFailure("preview_geometry_unsupported")
    depths = {
        "Point": 0,
        "MultiPoint": 1,
        "LineString": 1,
        "MultiLineString": 2,
        "Polygon": 2,
        "MultiPolygon": 3,
    }
    kind = geometry.get("type")
    if kind not in depths:
        raise PreviewFailure("preview_geometry_unsupported")

    def count(value: object, depth: int) -> int:
        if not isinstance(value, list) or not value:
            raise PreviewFailure("preview_geometry_unsupported")
        if depth:
            return sum(count(child, depth - 1) for child in value)
        if (
            len(value) != 2
            or any(type(v) not in {int, float} or not math.isfinite(v) for v in value)
            or not -180 <= value[0] <= 180
            or not -90 <= value[1] <= 90
        ):
            raise PreviewFailure("preview_geometry_unsupported")
        return 1

    return count(geometry["coordinates"], depths[kind])


async def read_bounded_features(
    connection: PreviewConnection,
    selection: PreviewSelection,
    allowed_schemas: tuple[str, ...],
    bbox: tuple[float, float, float, float],
    *,
    cursor_name: str,
) -> PreviewFeatures:
    async with connection.cursor() as metadata_cursor:
        relation = await describe_selected_relation(metadata_cursor, selection, allowed_schemas)
    statement, parameters, encodings = bounded_preview_query(
        relation, selection, allowed_schemas, bbox
    )
    features: list[dict[str, Any]] = []
    positions = 0
    wire_bytes = 0
    truncated = False
    async with connection.cursor(name=cursor_name) as cursor:
        # A named server cursor fetches one checked wire row at a time. No fetchall.
        await cursor.execute(statement, parameters)
        while (row := await cursor.fetchone()) is not None:
            if not isinstance(row, tuple | list) or len(row) != 2:
                raise PreviewFailure("preview_failed")
            error, body = row
            if error is not None:
                raise PreviewFailure(error)
            if not isinstance(body, str) or len(body.encode()) > MAX_RESPONSE_BYTES:
                raise PreviewFailure("preview_row_too_large")
            if len(features) == MAX_FEATURES:
                truncated = True
                break
            try:
                feature = json.loads(body)
            except (TypeError, ValueError):
                raise PreviewFailure("preview_failed") from None
            if (
                not isinstance(feature, dict)
                or set(feature) != {"type", "id", "geometry", "properties"}
                or feature["type"] != "Feature"
                or not isinstance(feature["id"], str)
                or not isinstance(feature["properties"], dict)
            ):
                raise PreviewFailure("preview_failed")
            properties: Mapping[str, object] = feature["properties"]
            if any(
                not isinstance(key, str)
                or not (value is None or type(value) in {bool, str, int, float})
                or (type(value) is float and not math.isfinite(value))
                for key, value in properties.items()
            ):
                raise PreviewFailure("preview_representation_unsupported")
            for key, encoding in encodings.items():
                value = properties.get(key)
                if value is None:
                    continue
                if not isinstance(value, str):
                    raise PreviewFailure("preview_representation_unsupported")
                if (
                    encoding == "int64:string" and not re.fullmatch(r"-?(?:0|[1-9][0-9]*)", value)
                ) or (
                    encoding == "numeric:string"
                    and not re.fullmatch(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", value)
                ):
                    raise PreviewFailure("preview_representation_unsupported")
            positions += _geometry_positions(feature["geometry"])
            wire_bytes += len(body.encode())
            if positions > MAX_POSITIONS or wire_bytes > MAX_RESPONSE_BYTES:
                raise PreviewFailure("preview_limits_exceeded")
            features.append(feature)
    return PreviewFeatures(
        {"type": "FeatureCollection", "features": features}, encodings, truncated
    )
