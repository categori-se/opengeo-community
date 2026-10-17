"""Credential-free metadata discovery and query planning, not a preview executor.

The caller supplies a cursor in an authorized, already-open read-only transaction
from the isolated connector. This module never opens a connection, commits, reads
secrets, or registers a Layer. Plans require a future executor enforcing byte and
geometry ceilings and revalidating the selected schema/key before reading rows.

Primary references consulted:
https://www.postgresql.org/docs/current/catalog-pg-index.html
https://postgis.net/docs/using_postgis_dbmanagement.html
https://www.psycopg.org/psycopg3/docs/api/sql.html
"""

import asyncio
import hashlib
import json
import math
import re
from dataclasses import asdict, dataclass
from typing import Any, Protocol

from psycopg import sql

_SCHEMA = re.compile(r"[A-Za-z_][A-Za-z0-9_$]{0,62}\Z")
_GEOMETRY = re.compile(r"geometry\(([A-Za-z]+),(\d+)\)\Z", re.IGNORECASE)
_KEY_TYPES = {"int2", "int4", "int8", "text", "varchar", "uuid"}
_GEOMETRY_TYPES = {
    "POINT",
    "LINESTRING",
    "POLYGON",
    "MULTIPOINT",
    "MULTILINESTRING",
    "MULTIPOLYGON",
}

_POLICY_SQL = """
SELECT pg_catalog.current_setting('transaction_read_only'),
       pg_catalog.set_config('statement_timeout', %s, true),
       pg_catalog.set_config('lock_timeout', %s, true),
       pg_catalog.set_config('search_path', 'pg_catalog', true)
"""
_RELATIONS_SQL = """
SELECT c.oid, n.nspname, c.relname, c.relkind,
       EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i
               WHERE i.inhparent = c.oid OR i.inhrelid = c.oid)
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ANY(%s::text[])
  AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
  AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
  AND pg_catalog.has_table_privilege(c.oid, 'SELECT')
ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"
LIMIT %s
"""
_COLUMNS_SQL = """
SELECT a.attname, tn.nspname, t.typname, a.attnotnull, a.atttypmod,
       CASE WHEN e.extname = 'postgis' AND t.typname = 'geometry'
            THEN pg_catalog.format_type(t.oid, a.atttypmod) END,
       en.nspname,
       EXISTS (SELECT 1 FROM pg_catalog.pg_index i
               WHERE i.indrelid = a.attrelid AND i.indkey[0] = a.attnum
                 AND i.indnkeyatts = 1 AND i.indisunique AND i.indisvalid
                 AND i.indisready AND i.indislive AND i.indimmediate
                 AND i.indexprs IS NULL AND i.indpred IS NULL),
       EXISTS (SELECT 1 FROM pg_catalog.pg_index i
               WHERE i.indrelid = a.attrelid AND i.indkey[0] = a.attnum
                 AND i.indnkeyatts = 1 AND i.indisprimary AND i.indisvalid
                 AND i.indisready AND i.indislive AND i.indimmediate
                 AND i.indexprs IS NULL AND i.indpred IS NULL)
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
LEFT JOIN pg_catalog.pg_depend d
  ON d.classid = 'pg_catalog.pg_type'::pg_catalog.regclass AND d.objid = t.oid
 AND d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass AND d.deptype = 'e'
LEFT JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid AND e.extname = 'postgis'
LEFT JOIN pg_catalog.pg_namespace en ON en.oid = e.extnamespace
WHERE a.attrelid = %s AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum
LIMIT %s
"""


class CatalogFailure(RuntimeError):
    """Only a fixed safe code escapes; provider exception text is never retained."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class CatalogCursor(Protocol):
    async def execute(self, query: Any, params: Any = None) -> Any: ...

    async def fetchone(self) -> Any: ...


@dataclass(frozen=True)
class CatalogLimits:
    max_relations: int = 100
    max_columns: int = 256
    max_metadata_bytes: int = 1_048_576
    statement_timeout_ms: int = 4000
    lock_timeout_ms: int = 1000
    timeout_seconds: float = 12.0

    def __post_init__(self) -> None:
        for value, maximum in (
            (self.max_relations, 100),
            (self.max_columns, 256),
            (self.max_metadata_bytes, 1_048_576),
            (self.statement_timeout_ms, 4000),
            (self.lock_timeout_ms, 1000),
        ):
            if type(value) is not int or not 1 <= value <= maximum:
                raise CatalogFailure("catalog_limits_invalid")
        if not 0 < self.timeout_seconds <= 12:
            raise CatalogFailure("catalog_limits_invalid")


@dataclass(frozen=True)
class GeometryDescriptor:
    geometry_type: str | None
    srid: int | None
    postgis_schema: str


@dataclass(frozen=True)
class ColumnDescriptor:
    name: str
    type_schema: str
    type_name: str
    not_null: bool
    type_modifier: int
    geometry: GeometryDescriptor | None
    unique_key: bool
    primary_key: bool


@dataclass(frozen=True)
class RelationDescriptor:
    schema: str
    name: str
    kind: str
    columns: tuple[ColumnDescriptor, ...]
    stable_key: str | None
    unsupported_reasons: tuple[str, ...]

    @property
    def schema_fingerprint_sha256(self) -> str:
        return hashlib.sha256(_metadata_bytes(asdict(self))).hexdigest()


@dataclass(frozen=True)
class CatalogDescription:
    relations: tuple[RelationDescriptor, ...]
    truncated: bool


@dataclass(frozen=True)
class PreviewQueryPlan:
    """Unexecuted SQL: LIMIT/bbox alone do not bound row bytes or geometry work.

    A caller must not execute this with an ordinary buffered cursor or interpret
    it as a usable Layer. Stable IDs must retain the selected key without coercion
    and be scoped by the persistent external relation identity.
    """

    statement: sql.Composed
    parameters: tuple[object, ...]
    columns: tuple[str, ...]
    stable_key: str
    schema_fingerprint_sha256: str
    requires_bounded_executor: bool = True


def _schemas(values: tuple[str, ...]) -> tuple[str, ...]:
    if not 1 <= len(values) <= 16 or len(set(values)) != len(values):
        raise CatalogFailure("schema_allowlist_invalid")
    if any(
        not _SCHEMA.fullmatch(v) or v.startswith("pg_") or v == "information_schema" for v in values
    ):
        raise CatalogFailure("schema_allowlist_invalid")
    return tuple(sorted(values))


def _identifier(value: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value or len(value.encode()) > 63:
        raise CatalogFailure("catalog_description_invalid")
    return value


def _metadata_bytes(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def _column(row: Any) -> ColumnDescriptor:
    (
        name,
        type_schema,
        type_name,
        not_null,
        modifier,
        formatted,
        extension_schema,
        unique,
        primary,
    ) = row
    geometry = None
    if formatted is not None:
        match = _GEOMETRY.search(formatted)
        geometry = GeometryDescriptor(
            match[1].upper() if match else None,
            int(match[2]) if match else None,
            _identifier(extension_schema),
        )
    return ColumnDescriptor(
        _identifier(name),
        _identifier(type_schema),
        _identifier(type_name),
        bool(not_null),
        int(modifier),
        geometry,
        bool(unique),
        bool(primary),
    )


def _relation(
    schema: str,
    name: str,
    kind: str,
    columns: tuple[ColumnDescriptor, ...],
    *,
    inherited: bool,
    truncated: bool,
) -> RelationDescriptor:
    reasons = []
    if kind not in {"r", "m"}:
        reasons.append("relation_kind_unsupported")
    if inherited:
        reasons.append("inherited_relation_unsupported")
    if truncated:
        reasons.append("column_limit_exceeded")
    keys = [
        c
        for c in columns
        if c.unique_key
        and c.not_null
        and c.type_schema == "pg_catalog"
        and c.type_name in _KEY_TYPES
    ]
    primary = [c for c in keys if c.primary_key]
    candidates = primary or keys
    stable_key = candidates[0].name if len(candidates) == 1 else None
    if stable_key is None:
        reasons.append("stable_key_ambiguous" if candidates else "stable_key_unavailable")
    if not any(c.geometry is not None for c in columns):
        reasons.append("geometry_unavailable")
    return RelationDescriptor(
        _identifier(schema), _identifier(name), kind, columns, stable_key, tuple(reasons)
    )


async def discover_postgis_catalog(
    cursor: CatalogCursor,
    *,
    allowed_schemas: tuple[str, ...],
    limits: CatalogLimits | None = None,
) -> CatalogDescription:
    """Read bounded metadata using only fixed catalog SQL and bound values.

    The transaction belongs to the caller, which must roll it back/close it.
    Discovery does not query rows or grant access to a discovered relation.
    """
    schemas = _schemas(allowed_schemas)
    limits = limits if limits is not None else CatalogLimits()
    try:
        async with asyncio.timeout(limits.timeout_seconds):
            await cursor.execute(
                _POLICY_SQL, (str(limits.statement_timeout_ms), str(limits.lock_timeout_ms))
            )
            policy = await cursor.fetchone()
            if policy is None or policy[0] != "on":
                raise CatalogFailure("read_only_transaction_required")
            await cursor.execute(_RELATIONS_SQL, (list(schemas), limits.max_relations + 1))
            relations = []
            while (row := await cursor.fetchone()) is not None:
                relations.append(row)
                if len(relations) > limits.max_relations:
                    break
            result = []
            total_bytes = 0
            for oid, schema, name, kind, inherited in relations[: limits.max_relations]:
                if schema not in schemas:
                    raise CatalogFailure("schema_not_allowed")
                await cursor.execute(_COLUMNS_SQL, (oid, limits.max_columns + 1))
                columns = []
                while (row := await cursor.fetchone()) is not None:
                    columns.append(_column(row))
                    if len(columns) > limits.max_columns:
                        break
                descriptor = _relation(
                    schema,
                    name,
                    kind,
                    tuple(columns[: limits.max_columns]),
                    inherited=inherited,
                    truncated=len(columns) > limits.max_columns,
                )
                total_bytes += len(_metadata_bytes(asdict(descriptor)))
                if total_bytes > limits.max_metadata_bytes:
                    raise CatalogFailure("catalog_metadata_limit_exceeded")
                result.append(descriptor)
            return CatalogDescription(tuple(result), len(relations) > limits.max_relations)
    except CatalogFailure:
        raise
    except TimeoutError:
        raise CatalogFailure("catalog_timeout") from None
    except Exception:
        raise CatalogFailure("catalog_description_failed") from None


def build_postgis_preview_query(
    relation: RelationDescriptor,
    *,
    allowed_schemas: tuple[str, ...],
    geometry_column: str,
    bbox: tuple[float, float, float, float],
    max_rows: int = 100,
) -> PreviewQueryPlan:
    """Plan a native-value query only; do not execute without a bounded executor."""
    if relation.schema not in _schemas(allowed_schemas):
        raise CatalogFailure("schema_not_allowed")
    if relation.unsupported_reasons or relation.stable_key is None:
        raise CatalogFailure("relation_unsupported")
    if type(max_rows) is not int or not 1 <= max_rows <= 1000:
        raise CatalogFailure("preview_bounds_invalid")
    if len(bbox) != 4 or any(type(v) not in {int, float} or not math.isfinite(v) for v in bbox):
        raise CatalogFailure("preview_bounds_invalid")
    west, south, east, north = bbox
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise CatalogFailure("preview_bounds_invalid")
    selected = [c for c in relation.columns if c.name == geometry_column]
    if len(selected) != 1 or selected[0].geometry is None:
        raise CatalogFailure("geometry_selection_invalid")
    geometry = selected[0].geometry
    if geometry.srid != 4326 or geometry.geometry_type not in _GEOMETRY_TYPES:
        raise CatalogFailure("preview_geometry_unsupported")
    names = tuple(_identifier(c.name) for c in relation.columns)
    if len(set(names)) != len(names) or relation.stable_key not in names:
        raise CatalogFailure("catalog_description_invalid")
    key = next(c for c in relation.columns if c.name == relation.stable_key)
    ordering: sql.Composable = sql.Identifier(key.name)
    if key.type_name in {"text", "varchar"}:
        ordering = sql.SQL('{} COLLATE "C"').format(ordering)
    statement = sql.SQL(
        "SELECT {columns} FROM ONLY {relation} "
        "WHERE {intersects}({geometry}, {envelope}(%s, %s, %s, %s, %s)) "
        "ORDER BY {ordering} LIMIT %s"
    ).format(
        columns=sql.SQL(", ").join(sql.Identifier(name) for name in names),
        relation=sql.Identifier(_identifier(relation.schema), _identifier(relation.name)),
        intersects=sql.Identifier(_identifier(geometry.postgis_schema), "st_intersects"),
        geometry=sql.Identifier(_identifier(geometry_column)),
        envelope=sql.Identifier(geometry.postgis_schema, "st_makeenvelope"),
        ordering=ordering,
    )
    return PreviewQueryPlan(
        statement,
        (*bbox, 4326, max_rows),
        names,
        relation.stable_key,
        relation.schema_fingerprint_sha256,
    )
