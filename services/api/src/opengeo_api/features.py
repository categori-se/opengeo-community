import json
import math
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Any, Literal, Protocol, TypeVar, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.auth_models import OrganizationRole
from opengeo_api.authorization import (
    Action,
    AuthorizationDenied,
    DatasetPermissionRole,
    ProjectRole,
    Roles,
    authorize,
)
from opengeo_api.cql2_features import Cql2Invalid, compile_feature_filter
from opengeo_api.feature_attachments import authorize_attachment_versions
from opengeo_api.field_calculations import evaluate_calculation, validate_calculation
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)
from opengeo_api.vector_analysis import (
    ANALYSIS_QUERY_MARKER,
    MAX_COORDINATES,
    MAX_FEATURES,
    MAX_OUTPUT_BYTES,
    AnalysisRequest,
    analysis_application_name,
    analysis_statement,
)

GeometryType = Literal[
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
]
FeatureFieldType = Literal["string", "integer", "number", "boolean", "group"]
FeatureScalar = str | int | float | bool
FeatureOperation = Literal["create", "update", "delete", "restore"]
PolygonGeometryOperation = Literal["collect", "dissolve"]
FeatureQueryOperator = Literal[
    "equals",
    "not_equals",
    "contains",
    "starts_with",
    "greater_than",
    "greater_than_or_equal",
    "less_than",
    "less_than_or_equal",
    "is_null",
]
FeatureSpatialRelation = Literal["intersects", "within"]
_VECTOR_FORMATS = frozenset({"geojson", "shapefile", "geopackage", "geoparquet"})
_FIELD_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_.:-]{0,99}$")
_RESERVED_FIELD_NAMES = frozenset(
    {
        "opengeo_created_at",
        "opengeo_updated_at",
        "opengeo_version",
    }
)
_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_MAX_COORDINATES = 10_000
_MAX_QUERY_COORDINATES = 2_048
_MAX_QUERY_GEOMETRY_BYTES = 65_536
_MAX_CUT_LINE_COORDINATES = 256
_MAX_SCHEMA_FIELDS = 64
_MAX_GROUP_DEPTH = 3
_MAX_REPEAT_ITEMS = 20
_MAX_FEATURE_LOCKS_PER_USER = 25
_MAX_FEATURE_LOCK_LEASE_SECONDS = 300
_DISSOLVE_TIMEOUT_SQL = """
    SELECT set_config('statement_timeout',
        CASE WHEN setting::int = 0 THEN '5000'
             ELSE LEAST(setting::int, 5000)::text END, true)
    FROM pg_settings WHERE name = 'statement_timeout'
"""
_DISSOLVE_MULTIPOLYGON_SQL = """
    WITH inputs AS MATERIALIZED (
        SELECT ST_SetSRID(ST_GeomFromGeoJSON(value::text), 4326) AS geom
        FROM jsonb_array_elements(%s::jsonb)
    ), checked AS MATERIALIZED (
        SELECT bool_and(ST_IsValid(geom) AND NOT ST_IsEmpty(geom)
                        AND ST_GeometryType(geom) = 'ST_MultiPolygon') AS valid,
               array_agg(geom) AS geometries
        FROM inputs
    ), dissolved AS MATERIALIZED (
        SELECT CASE WHEN valid
                    THEN ST_Multi(ST_UnaryUnion(ST_Collect(geometries))) END AS geom
        FROM checked
    ), bounded AS MATERIALIZED (
        SELECT geom, COALESCE(
            ST_IsValid(geom) AND NOT ST_IsEmpty(geom)
            AND ST_GeometryType(geom) = 'ST_MultiPolygon'
            AND ST_NPoints(geom) <= %s AND ST_NumGeometries(geom) <= 256,
            false) AS accepted
        FROM dissolved
    )
    SELECT CASE WHEN accepted THEN ST_AsGeoJSON(geom, 17)::jsonb END, accepted
    FROM bounded
"""
_CUT_MULTIPOLYGON_SQL = """
    WITH inputs AS MATERIALIZED (
        SELECT ST_SetSRID(ST_GeomFromGeoJSON(%s::text), 4326) AS source,
               ST_SetSRID(ST_GeomFromGeoJSON(%s::text), 4326) AS blade,
               %s::int AS part_number
    ), selected AS MATERIALIZED (
        SELECT *, ST_GeometryN(source, part_number) AS target FROM inputs
    ), checked AS MATERIALIZED (
        SELECT *, COALESCE(
            ST_GeometryType(source) = 'ST_MultiPolygon'
            AND ST_IsValid(source) AND NOT ST_IsEmpty(source)
            AND ST_GeometryType(blade) = 'ST_LineString'
            AND ST_IsValid(blade) AND ST_IsSimple(blade)
            AND NOT ST_IsClosed(blade) AND ST_Length(blade) > 0
            AND ST_NPoints(source) <= 10000 AND ST_NumGeometries(source) <= 256
            AND ST_NPoints(blade) <= 256
            AND target IS NOT NULL AND NOT ST_IsEmpty(target), false) AS valid
        FROM selected
    ), split AS MATERIALIZED (
        SELECT *, CASE WHEN valid THEN
            CASE WHEN ST_Dimension(ST_Intersection(ST_Boundary(target), blade)) < 1
                 THEN ST_Split(target, blade) END
            END AS pieces
        FROM checked
    ), parts AS MATERIALIZED (
        SELECT (ST_Dump(ST_CollectionExtract(pieces, 3))).geom AS geom FROM split
        LIMIT 21
    ), ordered AS MATERIALIZED (
        SELECT geom, row_number() OVER (
            ORDER BY ST_Area(geom) DESC, ST_AsEWKB(ST_Normalize(geom))) AS piece_index
        FROM parts
    ), bounded AS MATERIALIZED (
        SELECT count(*) BETWEEN 2 AND 20
            AND bool_and(ST_IsValid(geom) AND NOT ST_IsEmpty(geom)
                         AND ST_GeometryType(geom) = 'ST_Polygon')
            AND sum(ST_NPoints(geom)) +
                (SELECT ST_NPoints(source) - ST_NPoints(target) FROM selected) <= 10000
            AND count(*) + (SELECT ST_NumGeometries(source) - 1 FROM selected) <= 256
            AND ST_Equals(ST_UnaryUnion(ST_Collect(geom)), (SELECT target FROM selected))
            AND NOT EXISTS (
                SELECT 1 FROM ordered a JOIN ordered b ON a.piece_index < b.piece_index
                WHERE ST_Relate(a.geom, b.geom, '2********')
            ) AS accepted
        FROM ordered
    )
    SELECT CASE WHEN accepted THEN (
        SELECT jsonb_agg(ST_AsGeoJSON(geom, 17)::jsonb ORDER BY piece_index) FROM ordered
    ) END, COALESCE(accepted, false)
    FROM bounded
"""


class FeatureStoreUnavailable(RuntimeError):
    pass


class FeatureAccessDenied(RuntimeError):
    pass


class FeatureNotFound(RuntimeError):
    def __init__(self, resource: str) -> None:
        self.resource = resource
        super().__init__(resource)


class FeatureConflict(RuntimeError):
    def __init__(self, code: str, current_version: int | None = None) -> None:
        self.code = code
        self.current_version = current_version
        super().__init__(code)


class FeatureInvalid(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class FeatureFieldCondition:
    field: str
    equals: FeatureScalar | None = None
    operator: str = "eq"
    value_field: str | None = None


@dataclass(frozen=True, slots=True)
class FeatureField:
    name: str
    type: FeatureFieldType
    required: bool = False
    label: str | None = None
    description: str | None = None
    choices: tuple[str, ...] = ()
    minimum: int | float | None = None
    maximum: int | float | None = None
    min_length: int | None = None
    max_length: int | None = None
    attachment: bool = False
    calculation: Any = None
    visible_when: FeatureFieldCondition | None = None
    fields: tuple["FeatureField", ...] = ()
    repeat: bool = False
    min_items: int | None = None
    max_items: int | None = None


@dataclass(frozen=True, slots=True)
class FeatureDraft:
    feature_id: UUID
    geometry_type: GeometryType
    geometry: dict[str, Any]
    bbox: tuple[float, float, float, float]
    properties: dict[str, Any]


@dataclass(frozen=True, slots=True)
class FeatureRecord:
    feature_id: UUID
    version_number: int
    geometry_type: GeometryType
    geometry: dict[str, Any]
    bbox: tuple[float, float, float, float]
    properties: dict[str, Any]
    created_by: UUID
    created_at: datetime
    updated_by: UUID
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class FeatureRevision:
    version_number: int
    operation: FeatureOperation
    geometry_type: GeometryType
    geometry: dict[str, Any]
    properties: dict[str, Any]
    changed_by: UUID
    change_message: str | None
    request_id: str
    created_at: datetime


@dataclass(frozen=True, slots=True)
class FeatureCollection:
    dataset_id: UUID
    geometry_type: GeometryType
    fields: tuple[FeatureField, ...]
    generation: int
    feature_count: int
    created_by: UUID
    created_at: datetime
    updated_by: UUID
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class FeaturePage:
    collection: FeatureCollection
    features: tuple[FeatureRecord, ...]
    number_matched: int
    limit: int
    offset: int


@dataclass(frozen=True, slots=True)
class FeatureMutation:
    collection: FeatureCollection
    feature: FeatureRecord


@dataclass(frozen=True, slots=True)
class FeatureDeletion:
    feature_id: UUID
    deleted_version: int
    collection_generation: int


@dataclass(frozen=True, slots=True)
class FeatureTombstone:
    feature_id: UUID
    deleted_version: int
    deleted_by: UUID
    deleted_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class FeatureTombstonePage:
    tombstones: tuple[FeatureTombstone, ...]
    number_matched: int
    limit: int
    offset: int


@dataclass(frozen=True, slots=True)
class FeatureStructureMutation:
    collection: FeatureCollection
    retained_feature: FeatureRecord
    created_features: tuple[FeatureRecord, ...]
    deleted_features: tuple[FeatureDeletion, ...]


@dataclass(frozen=True, slots=True)
class FeatureLockRecord:
    feature_id: UUID
    feature_version: int
    lock_token: UUID | None
    held_by_current_user: bool
    acquired_at: datetime
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class FeatureLockRelease:
    feature_id: UUID
    released: bool


@dataclass(frozen=True, slots=True)
class AttributeQueryStep:
    field: str
    operator: FeatureQueryOperator
    value: str | int | float | bool | None
    case_sensitive: bool = False


@dataclass(frozen=True, slots=True)
class SpatialQueryStep:
    relation: FeatureSpatialRelation
    geometry: dict[str, Any]
    buffer_meters: float = 0


@dataclass(frozen=True, slots=True)
class TemporalQueryStep:
    field: Literal["opengeo_created_at", "opengeo_updated_at"]
    begin: datetime
    end: datetime


FeatureQueryStep = AttributeQueryStep | SpatialQueryStep | TemporalQueryStep


class FeatureRepository(Protocol):
    async def resolve_attachment(
        self,
        context: TenantContext,
        version_id: UUID,
    ) -> dict[str, Any]: ...

    async def preview_analysis(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        request: "AnalysisRequest",
    ) -> dict[str, Any]: ...

    async def cancel_analysis_preview(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        preview_id: UUID,
    ) -> bool: ...

    async def create_collection(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        geometry_type: GeometryType,
        fields: tuple[FeatureField, ...],
        features: tuple[FeatureDraft, ...],
        request_id: str,
    ) -> FeaturePage: ...

    async def list_features(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        *,
        bbox: tuple[float, float, float, float] | None,
        limit: int,
        offset: int,
        expected_generation: int | None = None,
        cql2_filter: tuple[str, str] | None = None,
    ) -> FeaturePage: ...

    async def get_feature(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        feature_id: UUID,
        *,
        expected_generation: int | None = None,
    ) -> FeatureRecord: ...

    async def query_features(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        *,
        steps: tuple[FeatureQueryStep, ...],
        limit: int,
        offset: int,
        expected_generation: int | None = None,
    ) -> FeaturePage: ...

    async def create_feature(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        feature: FeatureDraft,
        change_message: str | None,
        request_id: str,
    ) -> FeatureMutation: ...

    async def update_feature(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        feature_id: UUID,
        expected_version: int,
        feature: FeatureDraft,
        change_message: str | None,
        request_id: str,
        lock_token: UUID | None = None,
    ) -> FeatureMutation: ...

    async def delete_feature(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        feature_id: UUID,
        expected_version: int,
        change_message: str | None,
        request_id: str,
        lock_token: UUID | None = None,
    ) -> FeatureDeletion: ...

    async def list_deleted_features(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        *,
        limit: int,
        offset: int,
    ) -> FeatureTombstonePage: ...

    async def restore_feature(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        feature_id: UUID,
        expected_version: int,
        revision_version: int,
        change_message: str | None,
        request_id: str,
    ) -> FeatureMutation: ...

    async def separate_multipolygon_parts(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        feature_id: UUID,
        expected_version: int,
        retained_part_index: int,
        change_message: str | None,
        request_id: str,
        lock_token: UUID | None = None,
    ) -> FeatureStructureMutation: ...

    async def cut_multipolygon_feature(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        feature_id: UUID,
        expected_version: int,
        part_index: int,
        cut_line: dict[str, Any],
        change_message: str | None,
        request_id: str,
        lock_token: UUID | None = None,
    ) -> FeatureStructureMutation: ...

    async def merge_multipolygon_features(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        retained_feature_id: UUID,
        expected_versions: tuple[tuple[UUID, int, UUID | None], ...],
        change_message: str | None,
        request_id: str,
        geometry_operation: PolygonGeometryOperation = "collect",
    ) -> FeatureStructureMutation: ...

    async def list_feature_locks(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
    ) -> tuple[FeatureLockRecord, ...]: ...

    async def acquire_feature_lock(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        feature_id: UUID,
        expected_version: int,
        lock_token: UUID,
        lease_seconds: int,
        request_id: str,
    ) -> FeatureLockRecord: ...

    async def release_feature_lock(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        feature_id: UUID,
        lock_token: UUID,
        request_id: str,
    ) -> FeatureLockRelease: ...

    async def list_feature_history(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        feature_id: UUID,
        limit: int,
        offset: int,
    ) -> tuple[FeatureRevision, ...]: ...


def _optional_field_text(value: Any, name: str, maximum: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise FeatureInvalid(f"feature field {name} is invalid")
    normalized = value.strip()
    if not 1 <= len(normalized) <= maximum:
        raise FeatureInvalid(f"feature field {name} is invalid")
    return normalized


def normalize_fields(values: list[dict[str, Any]]) -> tuple[FeatureField, ...]:
    return _normalize_fields(values, depth=0, counter=[0])


def _normalize_fields(
    values: list[dict[str, Any]],
    *,
    depth: int,
    counter: list[int],
) -> tuple[FeatureField, ...]:
    if not isinstance(values, list):
        raise FeatureInvalid("feature fields must be an array")
    if len(values) > _MAX_SCHEMA_FIELDS:
        raise FeatureInvalid("feature schema exceeds 64 fields")
    fields: list[FeatureField] = []
    seen: set[str] = set()
    for value in values:
        counter[0] += 1
        if counter[0] > _MAX_SCHEMA_FIELDS:
            raise FeatureInvalid("feature schema exceeds 64 fields across all groups")
        if not isinstance(value, dict):
            raise FeatureInvalid("feature field must be an object")
        unknown = set(value) - {
            "name",
            "type",
            "required",
            "label",
            "description",
            "choices",
            "minimum",
            "maximum",
            "min_length",
            "max_length",
            "attachment",
            "calculation",
            "visible_when",
            "fields",
            "repeat",
            "min_items",
            "max_items",
        }
        if unknown:
            raise FeatureInvalid(f"feature field contains unknown key {sorted(unknown)[0]}")
        name = value.get("name")
        field_type = value.get("type")
        required = value.get("required", False)
        if not isinstance(name, str) or not _FIELD_NAME.fullmatch(name):
            raise FeatureInvalid("feature field name is invalid")
        folded = name.casefold()
        if folded in _RESERVED_FIELD_NAMES:
            raise FeatureInvalid("feature field name is reserved")
        if folded in seen:
            raise FeatureInvalid("feature field names must be case-insensitively unique")
        if field_type not in {"string", "integer", "number", "boolean", "group"}:
            raise FeatureInvalid("feature field type is invalid")
        if not isinstance(required, bool):
            raise FeatureInvalid("feature field required flag is invalid")
        label = _optional_field_text(value.get("label"), "label", 100)
        description = _optional_field_text(value.get("description"), "description", 500)
        raw_choices = value.get("choices", [])
        if not isinstance(raw_choices, list) or len(raw_choices) > 32:
            raise FeatureInvalid("feature field choices must contain at most 32 values")
        if any(not isinstance(choice, str) for choice in raw_choices):
            raise FeatureInvalid("feature field choices must be bounded strings")
        choices = tuple(choice.strip() for choice in raw_choices)
        if any(not 1 <= len(choice) <= 200 for choice in choices):
            raise FeatureInvalid("feature field choices must be bounded strings")
        if len(set(choices)) != len(choices):
            raise FeatureInvalid("feature field choices must be unique")
        minimum = value.get("minimum")
        maximum = value.get("maximum")
        min_length = value.get("min_length")
        max_length = value.get("max_length")
        raw_fields = value.get("fields", [])
        repeat = value.get("repeat", False)
        min_items = value.get("min_items")
        max_items = value.get("max_items")
        child_fields: tuple[FeatureField, ...] = ()
        if field_type == "group":
            if depth >= _MAX_GROUP_DEPTH:
                raise FeatureInvalid("feature schema groups exceed three nested levels")
            if not isinstance(raw_fields, list) or not raw_fields:
                raise FeatureInvalid("feature group fields must contain at least one field")
            if not isinstance(repeat, bool):
                raise FeatureInvalid("feature group repeat flag is invalid")
            if choices or minimum is not None or maximum is not None:
                raise FeatureInvalid("feature groups cannot declare scalar value rules")
            if min_length is not None or max_length is not None:
                raise FeatureInvalid("feature groups cannot declare string bounds")
            if repeat:
                minimum_items = 0 if min_items is None else min_items
                maximum_items = _MAX_REPEAT_ITEMS if max_items is None else max_items
                if (
                    isinstance(minimum_items, bool)
                    or not isinstance(minimum_items, int)
                    or not 0 <= minimum_items <= _MAX_REPEAT_ITEMS
                    or isinstance(maximum_items, bool)
                    or not isinstance(maximum_items, int)
                    or not 1 <= maximum_items <= _MAX_REPEAT_ITEMS
                    or minimum_items > maximum_items
                ):
                    raise FeatureInvalid("feature group repeat bounds are invalid")
                min_items = minimum_items
                max_items = maximum_items
            elif min_items is not None or max_items is not None:
                raise FeatureInvalid("non-repeating feature groups cannot declare item bounds")
            child_fields = _normalize_fields(raw_fields, depth=depth + 1, counter=counter)
        elif raw_fields or repeat or min_items is not None or max_items is not None:
            raise FeatureInvalid("scalar feature fields cannot declare group rules")
        elif field_type == "string":
            if minimum is not None or maximum is not None:
                raise FeatureInvalid("string feature fields cannot declare numeric bounds")
            for bound_name, bound in (("min_length", min_length), ("max_length", max_length)):
                if bound is not None and (
                    isinstance(bound, bool) or not isinstance(bound, int) or not 1 <= bound <= 2_000
                ):
                    raise FeatureInvalid(f"feature field {bound_name} is invalid")
            effective_min = min_length if min_length is not None else 1
            effective_max = max_length if max_length is not None else 2_000
            if effective_min > effective_max:
                raise FeatureInvalid("feature field string bounds are inverted")
            if choices and any(
                not effective_min <= len(choice) <= effective_max for choice in choices
            ):
                raise FeatureInvalid("feature field choice violates the string bounds")
        elif field_type in {"integer", "number"}:
            if choices or min_length is not None or max_length is not None:
                raise FeatureInvalid("numeric feature fields cannot declare string rules")
            for bound_name, bound in (("minimum", minimum), ("maximum", maximum)):
                if bound is not None and (
                    isinstance(bound, bool)
                    or not isinstance(bound, int | float)
                    or not math.isfinite(bound)
                    or (field_type == "integer" and not isinstance(bound, int))
                    or (field_type == "integer" and abs(bound) > _MAX_SAFE_INTEGER)
                ):
                    raise FeatureInvalid(f"feature field {bound_name} is invalid")
            if minimum is not None and maximum is not None and minimum > maximum:
                raise FeatureInvalid("feature field numeric bounds are inverted")
        else:
            if (
                choices
                or minimum is not None
                or maximum is not None
                or min_length is not None
                or max_length is not None
            ):
                raise FeatureInvalid("boolean feature fields cannot declare value rules")
        attachment = value.get("attachment", False)
        if not isinstance(attachment, bool) or (
            attachment
            and (
                field_type != "string"
                or choices
                or min_length is not None
                or max_length is not None
            )
        ):
            raise FeatureInvalid("attachment fields must be strings without choice or length rules")
        calculation = value.get("calculation")
        if calculation is not None:
            if field_type not in ("integer", "number"):
                raise FeatureInvalid("calculated fields must be numeric")
            try:
                calculation = validate_calculation(
                    calculation,
                    {field.name for field in fields if field.type in ("integer", "number")},
                )
            except ValueError as error:
                raise FeatureInvalid(str(error)) from error
        visible_when = _normalize_field_condition(value.get("visible_when"), fields)
        seen.add(folded)
        fields.append(
            FeatureField(
                name=name,
                type=cast(FeatureFieldType, field_type),
                required=required,
                label=label,
                description=description,
                choices=choices,
                minimum=minimum,
                maximum=maximum,
                min_length=min_length,
                max_length=max_length,
                attachment=attachment,
                calculation=calculation,
                visible_when=visible_when,
                fields=child_fields,
                repeat=cast(bool, repeat),
                min_items=min_items,
                max_items=max_items,
            )
        )
    return tuple(fields)


def _normalize_field_condition(
    value: Any,
    prior_fields: list[FeatureField],
) -> FeatureFieldCondition | None:
    if value is None:
        return None
    if (
        not isinstance(value, dict)
        or "field" not in value
        or set(value) - {"field", "equals", "operator", "value_field"}
    ):
        raise FeatureInvalid("feature field visible_when requires field and one comparison operand")
    value_field = value.get("value_field")
    if (value_field is None) == (value.get("equals") is None):
        raise FeatureInvalid("visibility requires exactly one of equals or value_field")
    field_name = value.get("field")
    if not isinstance(field_name, str):
        raise FeatureInvalid("feature field visible_when field is invalid")
    try:
        controller = next(field for field in prior_fields if field.name == field_name)
    except StopIteration as error:
        raise FeatureInvalid(
            "feature field visible_when must reference an earlier field"
        ) from error
    if controller.type == "group":
        raise FeatureInvalid("feature field visible_when controller must be scalar")
    equals = None
    if value_field is not None:
        other = next((field for field in prior_fields if field.name == value_field), None)
        if other is None or other.type == "group":
            raise FeatureInvalid("visibility value_field must reference an earlier scalar field")
        numeric = {"integer", "number"}
        if other.type != controller.type and not {other.type, controller.type} <= numeric:
            raise FeatureInvalid("visibility comparison fields must have compatible types")
    else:
        equals = _normalize_field_value(value.get("equals"), controller)
    operator = value.get("operator", "eq")
    if operator not in ("eq", "ne", "gt", "gte", "lt", "lte"):
        raise FeatureInvalid("feature field visibility operator is invalid")
    if operator not in ("eq", "ne") and controller.type not in ("integer", "number"):
        raise FeatureInvalid("ordered visibility comparison requires a numeric field")
    return FeatureFieldCondition(
        field=controller.name, equals=equals, operator=operator, value_field=value_field
    )


def _field_visible(condition: FeatureFieldCondition | None, values: dict[str, Any]) -> bool:
    if condition is None:
        return True
    actual = values.get(condition.field)
    if actual is None:
        return False
    expected = values.get(condition.value_field) if condition.value_field else condition.equals
    if expected is None:
        return False
    if condition.operator == "eq":
        return bool(actual == expected)
    if condition.operator == "ne":
        return bool(actual != expected)
    if not isinstance(actual, (int, float)) or not isinstance(expected, (int, float)):
        return False
    return {
        "gt": actual > expected,
        "gte": actual >= expected,
        "lt": actual < expected,
        "lte": actual <= expected,
    }[condition.operator]


def _normalize_field_value(item: Any, field: FeatureField) -> FeatureScalar:
    if field.type == "group":
        raise FeatureInvalid(f"feature property {field.name} group requires structured validation")
    if field.attachment:
        try:
            if not isinstance(item, str) or str(UUID(item)) != item:
                raise ValueError
        except ValueError as error:
            raise FeatureInvalid(
                "attachment value must be a canonical dataset-version UUID"
            ) from error
    if field.type == "string":
        minimum_length = field.min_length if field.min_length is not None else 1
        maximum_length = field.max_length if field.max_length is not None else 2_000
        if not isinstance(item, str) or not minimum_length <= len(item) <= maximum_length:
            raise FeatureInvalid(f"feature property {field.name} must be a bounded string")
        if field.choices and item not in field.choices:
            raise FeatureInvalid(f"feature property {field.name} must be one of its choices")
    elif field.type == "integer":
        if isinstance(item, bool) or not isinstance(item, int) or abs(item) > _MAX_SAFE_INTEGER:
            raise FeatureInvalid(f"feature property {field.name} must be a safe integer")
    elif field.type == "number":
        if isinstance(item, bool) or not isinstance(item, int | float) or not math.isfinite(item):
            raise FeatureInvalid(f"feature property {field.name} must be finite")
    elif field.type == "boolean" and not isinstance(item, bool):
        raise FeatureInvalid(f"feature property {field.name} must be boolean")
    if field.type in {"integer", "number"}:
        if field.minimum is not None and item < field.minimum:
            raise FeatureInvalid(f"feature property {field.name} is below its minimum")
        if field.maximum is not None and item > field.maximum:
            raise FeatureInvalid(f"feature property {field.name} is above its maximum")
    return cast(FeatureScalar, item)


def normalize_properties(value: dict[str, Any], fields: tuple[FeatureField, ...]) -> dict[str, Any]:
    normalized = _normalize_properties(value, fields, path="")
    if len(_canonical_json(normalized)) > 32_768:
        raise FeatureInvalid("feature properties exceed 32768 bytes")
    return normalized


async def authorize_feature_attachments(
    transaction: TenantTransaction,
    context: TenantContext,
    records: list[dict[str, Any]],
    fields: tuple[FeatureField, ...],
) -> None:
    versions: set[UUID] = set()

    def collect(record: dict[str, Any], definitions: tuple[FeatureField, ...]) -> None:
        for field in definitions:
            value = record.get(field.name)
            if value is None:
                continue
            if field.attachment:
                versions.add(UUID(value))
            elif field.type == "group":
                for child in value if field.repeat else [value]:
                    collect(child, field.fields)

    for record in records:
        collect(record, fields)
    try:
        await authorize_attachment_versions(transaction, context, versions)
    except AuthorizationDenied as error:
        raise FeatureAccessDenied("attachment access denied") from error
    except ValueError as error:
        raise FeatureInvalid(str(error)) from error


def _normalize_properties(
    value: dict[str, Any],
    fields: tuple[FeatureField, ...],
    *,
    path: str,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise FeatureInvalid(f"feature properties {path or 'root'} must be an object")
    definitions = {field.name: field for field in fields}
    unknown = set(value) - set(definitions)
    if unknown:
        raise FeatureInvalid(f"feature properties contain unknown field {sorted(unknown)[0]}")
    normalized: dict[str, Any] = {}
    for field in fields:
        field_path = f"{path}.{field.name}" if path else field.name
        visible = _field_visible(field.visible_when, normalized)
        if not visible:
            if field.name in value:
                raise FeatureInvalid(
                    f"feature property {field_path} is hidden by its visibility rule"
                )
            continue
        if field.calculation is not None:
            try:
                computed = evaluate_calculation(field.calculation, normalized)
            except ValueError as error:
                raise FeatureInvalid(f"feature property {field_path}: {error}") from error
            supplied = value.get(field.name)
            if supplied is not None and (
                type(supplied) not in (int, float) or supplied != computed
            ):
                raise FeatureInvalid(f"feature property {field_path} differs from its calculation")
            if computed is None:
                if field.required:
                    raise FeatureInvalid(
                        f"feature property {field_path} requires calculation inputs"
                    )
                continue
            item = int(computed) if field.type == "integer" and computed.is_integer() else computed
            normalized[field.name] = _normalize_field_value(item, field)
            continue
        if field.name not in value:
            if field.required:
                raise FeatureInvalid(f"feature property {field_path} is required")
            continue
        item = value[field.name]
        if item is None:
            if field.required:
                raise FeatureInvalid(f"feature property {field_path} is required")
            normalized[field.name] = None
            continue
        if field.type == "group":
            if field.repeat:
                if not isinstance(item, list):
                    raise FeatureInvalid(f"feature property {field_path} must be an array")
                minimum = max(field.min_items or 0, 1 if field.required else 0)
                maximum = field.max_items or _MAX_REPEAT_ITEMS
                if not minimum <= len(item) <= maximum:
                    raise FeatureInvalid(
                        f"feature property {field_path} must contain {minimum} to {maximum} items"
                    )
                normalized[field.name] = [
                    _normalize_properties(entry, field.fields, path=f"{field_path}[{index}]")
                    for index, entry in enumerate(item)
                ]
            else:
                normalized[field.name] = _normalize_properties(item, field.fields, path=field_path)
            continue
        try:
            normalized[field.name] = _normalize_field_value(item, field)
        except FeatureInvalid as error:
            if path:
                raise FeatureInvalid(str(error).replace(field.name, field_path, 1)) from error
            raise
    return normalized


def normalize_geometry(
    value: dict[str, Any],
) -> tuple[GeometryType, dict[str, Any], tuple[float, float, float, float]]:
    if not isinstance(value, dict) or set(value) != {"type", "coordinates"}:
        raise FeatureInvalid("geometry must contain only type and coordinates")
    geometry_type = value.get("type")
    if geometry_type not in {
        "Point",
        "MultiPoint",
        "LineString",
        "MultiLineString",
        "Polygon",
        "MultiPolygon",
    }:
        raise FeatureInvalid("geometry type is unsupported")
    state = _CoordinateState()
    coordinates = value.get("coordinates")
    if geometry_type == "Point":
        normalized: Any = state.position(coordinates, "coordinates")
    elif geometry_type == "MultiPoint":
        normalized = state.positions(coordinates, "coordinates", minimum=1)
    elif geometry_type == "LineString":
        normalized = state.positions(coordinates, "coordinates", minimum=2)
    elif geometry_type == "MultiLineString":
        normalized = state.lines(coordinates, "coordinates")
    elif geometry_type == "Polygon":
        normalized = state.polygon(coordinates, "coordinates")
    else:
        normalized = state.multipolygon(coordinates, "coordinates")
    document = {"type": geometry_type, "coordinates": normalized}
    if len(_canonical_json(document)) > 262_144:
        raise FeatureInvalid("feature geometry exceeds 262144 bytes")
    assert state.minimum_x is not None
    bbox = (state.minimum_x, state.minimum_y, state.maximum_x, state.maximum_y)
    return (
        cast(GeometryType, geometry_type),
        document,
        cast(tuple[float, float, float, float], bbox),
    )


def normalize_query_geometry(value: dict[str, Any]) -> dict[str, Any]:
    if (
        isinstance(value, dict)
        and value.get("type") == "GeometryCollection"
        and set(value) == {"type", "geometries"}
    ):
        members = value.get("geometries")
        if (
            not isinstance(members, list)
            or not 1 <= len(members) <= 100
            or any(
                not isinstance(member, dict) or member.get("type") == "GeometryCollection"
                for member in members
            )
        ):
            raise FeatureInvalid(
                "query GeometryCollection must contain 1 to 100 non-collection geometries"
            )
        geometries = [normalize_geometry(member)[1] for member in members]
        geometry = {"type": "GeometryCollection", "geometries": geometries}
        coordinate_count = sum(_coordinate_count(member["coordinates"]) for member in geometries)
    else:
        _geometry_type, geometry, _bbox = normalize_geometry(value)
        coordinate_count = _coordinate_count(geometry["coordinates"])
    if coordinate_count > _MAX_QUERY_COORDINATES:
        raise FeatureInvalid("query geometry exceeds 2048 coordinates")
    if len(_canonical_json(geometry)) > _MAX_QUERY_GEOMETRY_BYTES:
        raise FeatureInvalid("query geometry exceeds 65536 bytes")
    return geometry


def feature_draft(
    geometry: dict[str, Any],
    properties: dict[str, Any],
    fields: tuple[FeatureField, ...],
    feature_id: UUID | None = None,
) -> FeatureDraft:
    geometry_type, normalized_geometry, bbox = normalize_geometry(geometry)
    return FeatureDraft(
        feature_id=feature_id or uuid4(),
        geometry_type=geometry_type,
        geometry=normalized_geometry,
        bbox=bbox,
        properties=normalize_properties(properties, fields),
    )


def separate_multipolygon_drafts(
    feature: FeatureRecord,
    fields: tuple[FeatureField, ...],
    retained_part_index: int,
) -> tuple[FeatureDraft, ...]:
    if feature.geometry_type != "MultiPolygon" or feature.geometry.get("type") != "MultiPolygon":
        raise FeatureInvalid("only MultiPolygon features can separate polygon parts")
    coordinates = feature.geometry.get("coordinates")
    if not isinstance(coordinates, list) or len(coordinates) < 2:
        raise FeatureInvalid("a multipart polygon needs at least two parts to separate")
    if len(coordinates) > 256:
        raise FeatureInvalid("polygon separation supports at most 256 parts")
    if not 0 <= retained_part_index < len(coordinates):
        raise FeatureInvalid("retained polygon part index is outside the feature")
    ordered = [coordinates[retained_part_index]] + [
        part for index, part in enumerate(coordinates) if index != retained_part_index
    ]
    return tuple(
        feature_draft(
            {"type": "MultiPolygon", "coordinates": [part]},
            feature.properties,
            fields,
            feature.feature_id if index == 0 else None,
        )
        for index, part in enumerate(ordered)
    )


def normalize_cut_line(value: dict[str, Any]) -> dict[str, Any]:
    geometry_type, geometry, _bbox = normalize_geometry(value)
    if geometry_type != "LineString":
        raise FeatureInvalid("cut line must be a LineString")
    if len(geometry["coordinates"]) > _MAX_CUT_LINE_COORDINATES:
        raise FeatureInvalid("cut line supports at most 256 positions")
    if len(_canonical_json(geometry)) > _MAX_QUERY_GEOMETRY_BYTES:
        raise FeatureInvalid("cut line exceeds 65536 bytes")
    if geometry["coordinates"][0] == geometry["coordinates"][-1]:
        raise FeatureInvalid("cut line must be open")
    return geometry


def cut_multipolygon_drafts(
    feature: FeatureRecord,
    fields: tuple[FeatureField, ...],
    part_index: int,
    pieces: list[dict[str, Any]],
) -> tuple[FeatureDraft, ...]:
    """Reassemble already validated, deterministically ordered PostGIS pieces."""
    if feature.geometry_type != "MultiPolygon":
        raise FeatureInvalid("only MultiPolygon features can be cut")
    kind, original, _bbox = normalize_geometry(feature.geometry)
    if kind != "MultiPolygon":
        raise FeatureInvalid("only MultiPolygon features can be cut")
    coordinates = original["coordinates"]
    if not 0 <= part_index < len(coordinates):
        raise FeatureInvalid("cut polygon part index is outside the feature")
    if not 2 <= len(pieces) <= 20:
        raise FeatureInvalid("cut line must produce between 2 and 20 polygon pieces")
    cut_coordinates = []
    for piece in pieces:
        kind, geometry, _bbox = normalize_geometry(piece)
        if kind != "Polygon":
            raise FeatureInvalid("cut line result must contain only polygons")
        cut_coordinates.append(geometry["coordinates"])
    retained_coordinates = list(coordinates)
    retained_coordinates[part_index] = cut_coordinates[0]
    if len(retained_coordinates) + len(cut_coordinates) - 1 > 256:
        raise FeatureInvalid("cut line result supports at most 256 polygon parts")
    # Bound the entire mutation together, including untouched parts and the
    # duplicated endpoints introduced by the split, before creating any heads.
    normalize_geometry(
        {"type": "MultiPolygon", "coordinates": retained_coordinates + cut_coordinates[1:]}
    )
    return tuple(
        feature_draft(
            {"type": "MultiPolygon", "coordinates": parts},
            feature.properties,
            fields,
            feature.feature_id if index == 0 else None,
        )
        for index, parts in enumerate(
            [retained_coordinates] + [[part] for part in cut_coordinates[1:]]
        )
    )


def merge_multipolygon_draft(
    features: list[FeatureRecord],
    fields: tuple[FeatureField, ...],
    retained_feature_id: UUID,
) -> FeatureDraft:
    if not 2 <= len(features) <= 20:
        raise FeatureInvalid("polygon merge requires between 2 and 20 features")
    if len({feature.feature_id for feature in features}) != len(features):
        raise FeatureInvalid("polygon merge feature ids must be unique")
    if features[0].feature_id != retained_feature_id:
        raise FeatureInvalid("the retained polygon feature must be first")
    coordinates: list[Any] = []
    for feature in features:
        if (
            feature.geometry_type != "MultiPolygon"
            or feature.geometry.get("type") != "MultiPolygon"
        ):
            raise FeatureInvalid("only MultiPolygon features can merge polygon parts")
        parts = feature.geometry.get("coordinates")
        if not isinstance(parts, list) or not parts:
            raise FeatureInvalid("polygon merge feature has no parts")
        coordinates.extend(parts)
    if len(coordinates) > 256:
        raise FeatureInvalid("merged polygon geometry supports at most 256 parts")
    return feature_draft(
        {"type": "MultiPolygon", "coordinates": coordinates},
        features[0].properties,
        fields,
        retained_feature_id,
    )


class _CoordinateState:
    def __init__(self) -> None:
        self.count = 0
        self.minimum_x: float | None = None
        self.minimum_y: float | None = None
        self.maximum_x: float | None = None
        self.maximum_y: float | None = None

    def position(self, value: Any, path: str) -> list[float]:
        if not isinstance(value, list) or len(value) != 2:
            raise FeatureInvalid(f"{path} must be a two-dimensional position")
        if any(isinstance(item, bool) or not isinstance(item, int | float) for item in value):
            raise FeatureInvalid(f"{path} coordinates must be numbers")
        x, y = float(value[0]), float(value[1])
        if (
            not math.isfinite(x)
            or not math.isfinite(y)
            or not -180 <= x <= 180
            or not -90 <= y <= 90
        ):
            raise FeatureInvalid(f"{path} must be a finite WGS84 position")
        self.count += 1
        if self.count > _MAX_COORDINATES:
            raise FeatureInvalid("feature geometry exceeds 10000 positions")
        self.minimum_x = x if self.minimum_x is None else min(self.minimum_x, x)
        self.minimum_y = y if self.minimum_y is None else min(self.minimum_y, y)
        self.maximum_x = x if self.maximum_x is None else max(self.maximum_x, x)
        self.maximum_y = y if self.maximum_y is None else max(self.maximum_y, y)
        return [x, y]

    def positions(self, value: Any, path: str, minimum: int) -> list[list[float]]:
        if not isinstance(value, list) or len(value) < minimum:
            raise FeatureInvalid(f"{path} has too few positions")
        return [self.position(item, f"{path}[{index}]") for index, item in enumerate(value)]

    def lines(self, value: Any, path: str) -> list[list[list[float]]]:
        if not isinstance(value, list) or not value:
            raise FeatureInvalid(f"{path} must contain at least one line")
        return [
            self.positions(item, f"{path}[{index}]", minimum=2) for index, item in enumerate(value)
        ]

    def polygon(self, value: Any, path: str) -> list[list[list[float]]]:
        if not isinstance(value, list) or not value:
            raise FeatureInvalid(f"{path} must contain at least one ring")
        rings: list[list[list[float]]] = []
        for index, item in enumerate(value):
            ring = self.positions(item, f"{path}[{index}]", minimum=4)
            if ring[0] != ring[-1]:
                raise FeatureInvalid(f"{path}[{index}] must be closed")
            rings.append(ring)
        return rings

    def multipolygon(self, value: Any, path: str) -> list[list[list[list[float]]]]:
        if not isinstance(value, list) or not value:
            raise FeatureInvalid(f"{path} must contain at least one polygon")
        return [self.polygon(item, f"{path}[{index}]") for index, item in enumerate(value)]


@dataclass(frozen=True, slots=True)
class _DatasetScope:
    roles: Roles
    status: str
    format: str


ResultT = TypeVar("ResultT")


class PostgresFeatureRepository:
    def __init__(self, executor: TenantTransactionExecutor) -> None:
        self._executor = executor

    async def resolve_attachment(self, context: TenantContext, version_id: UUID) -> dict[str, Any]:
        async def operation(transaction: TenantTransaction) -> dict[str, Any]:
            try:
                await authorize_attachment_versions(transaction, context, {version_id})
            except (ValueError, AuthorizationDenied) as error:
                raise FeatureNotFound("attachment") from error
            row = await transaction.fetch_one(
                """
                SELECT version.dataset_id, version.original_object_id, version.version_number,
                       dataset.name, dataset.format::text,
                       (SELECT link.project_id FROM app.project_datasets link
                         WHERE link.organization_id = dataset.organization_id
                           AND link.dataset_id = dataset.id
                         ORDER BY (app.effective_project_role(link.project_id) IS NOT NULL) DESC,
                                  link.project_id LIMIT 1)
                FROM app.dataset_versions version
                JOIN app.datasets dataset ON dataset.organization_id = version.organization_id
                  AND dataset.id = version.dataset_id
                WHERE version.organization_id = %s AND version.id = %s
                """,
                (context.organization_id, version_id),
            )
            if row is None or row[5] is None:
                raise FeatureNotFound("attachment")
            return {
                "version_id": str(version_id),
                "dataset_id": str(row[0]),
                "object_id": str(row[1]),
                "version_number": row[2],
                "name": row[3],
                "format": row[4],
                "project_id": str(row[5]),
            }

        return await self._run(context, operation)

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT:
        try:
            return await self._executor.run(context, operation)
        except TenantDatabaseConflict as error:
            raise FeatureConflict("feature_store_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise FeatureStoreUnavailable("feature store operation failed") from error

    async def create_collection(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        geometry_type: GeometryType,
        fields: tuple[FeatureField, ...],
        features: tuple[FeatureDraft, ...],
        request_id: str,
    ) -> FeaturePage:
        if len(features) > 100:
            raise FeatureInvalid("initial feature collection exceeds 100 features")
        normalized_features: list[FeatureDraft] = []
        seen_ids: set[UUID] = set()
        for feature in features:
            _require_geometry_type(feature, geometry_type)
            if feature.feature_id in seen_ids:
                raise FeatureInvalid("initial feature ids must be unique")
            seen_ids.add(feature.feature_id)
            normalized_features.append(
                replace(feature, properties=normalize_properties(feature.properties, fields))
            )
        features = tuple(normalized_features)

        async def operation(transaction: TenantTransaction) -> FeaturePage:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_EDIT, scope.roles)
            self._require_editable_dataset(scope)
            existing = await transaction.fetch_one(
                """
                SELECT 1 FROM app.feature_collections
                WHERE organization_id = %s AND dataset_id = %s
                """,
                (context.organization_id, dataset_id),
            )
            if existing is not None:
                raise FeatureConflict("feature_collection_exists")
            await authorize_feature_attachments(
                transaction, context, [feature.properties for feature in features], fields
            )
            schema = _schema_definition(fields)
            collection_row = await transaction.fetch_one(
                """
                INSERT INTO app.feature_collections
                  (organization_id, dataset_id, geometry_type, schema_definition,
                   generation, feature_count, created_by, updated_by)
                VALUES (%s, %s, %s::app.feature_geometry_type, %s, 1, %s, %s, %s)
                RETURNING created_at, updated_at
                """,
                (
                    context.organization_id,
                    dataset_id,
                    geometry_type,
                    Jsonb(schema),
                    len(features),
                    context.user_id,
                    context.user_id,
                ),
            )
            assert collection_row is not None
            records: list[FeatureRecord] = []
            for feature in features:
                records.append(
                    await self._insert_feature(
                        transaction,
                        context,
                        dataset_id,
                        feature,
                        "create",
                        "Initial feature collection import",
                        request_id,
                    )
                )
            await self._event(
                transaction,
                context,
                project_id,
                dataset_id,
                "dataset.feature_collection.created",
                "dataset",
                dataset_id,
                request_id,
                {"generation": 1, "feature_count": len(features)},
            )
            collection = FeatureCollection(
                dataset_id=dataset_id,
                geometry_type=geometry_type,
                fields=fields,
                generation=1,
                feature_count=len(features),
                created_by=context.user_id,
                created_at=cast(datetime, collection_row[0]),
                updated_by=context.user_id,
                updated_at=cast(datetime, collection_row[1]),
            )
            return FeaturePage(collection, tuple(records), len(records), 100, 0)

        return await self._run(context, operation)

    async def query_features(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        *,
        steps: tuple[FeatureQueryStep, ...],
        limit: int,
        offset: int,
        expected_generation: int | None = None,
    ) -> FeaturePage:
        if not 1 <= len(steps) <= 4:
            raise FeatureInvalid("feature query requires between one and four steps")

        async def operation(transaction: TenantTransaction) -> FeaturePage:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_READ, scope.roles)
            collection = await self._collection(transaction, context, dataset_id)
            if expected_generation is not None and collection.generation != expected_generation:
                raise FeatureConflict(
                    "feature_collection_generation_conflict", collection.generation
                )
            predicates, parameters = _query_predicates(steps, collection.fields)
            predicate_sql = "\n                  AND ".join(predicates)
            count_row = await transaction.fetch_one(
                f"""
                SELECT count(*)::bigint
                FROM app.dataset_features feature
                WHERE feature.organization_id = %s
                  AND feature.dataset_id = %s
                  AND feature.deleted_at IS NULL
                  AND {predicate_sql}
                """,
                (context.organization_id, dataset_id, *parameters),
            )
            rows = await transaction.fetch_all(
                f"""
                {self._feature_select()}
                WHERE feature.organization_id = %s
                  AND feature.dataset_id = %s
                  AND feature.deleted_at IS NULL
                  AND {predicate_sql}
                ORDER BY feature.id
                LIMIT %s OFFSET %s
                """,
                (
                    context.organization_id,
                    dataset_id,
                    *parameters,
                    limit,
                    offset,
                ),
            )
            return FeaturePage(
                collection=collection,
                features=tuple(self._feature(row) for row in rows),
                number_matched=cast(int, count_row[0]) if count_row is not None else 0,
                limit=limit,
                offset=offset,
            )

        return await self._run(context, operation)

    async def preview_analysis(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        request: AnalysisRequest,
    ) -> dict[str, Any]:
        try:
            statement, parameters = analysis_statement(context.organization_id, dataset_id, request)
        except ValueError as error:
            raise FeatureInvalid(str(error)) from error

        async def operation(transaction: TenantTransaction) -> dict[str, Any]:
            for identity in {dataset_id, request.target_dataset_id} - {None}:
                scope = await self._scope(transaction, context, project_id, cast(UUID, identity))
                self._require(Action.DATASET_READ, scope.roles)
            if request.preview_id is None:
                await transaction.execute("SET LOCAL statement_timeout = '5000ms'", ())
            else:
                await transaction.execute(
                    """SELECT set_config('statement_timeout', '5000ms', true),
                              set_config('application_name', %s, true)""",
                    (
                        analysis_application_name(
                            context.organization_id,
                            context.user_id,
                            project_id,
                            dataset_id,
                            request.preview_id,
                        ),
                    ),
                )
            row = await transaction.fetch_one(statement, parameters)
            if row is None:
                raise FeatureInvalid("analysis source is unavailable")
            facts, output, size, features = row
            if facts["source_generation"] != request.source_generation:
                raise FeatureConflict(
                    "feature_collection_generation_conflict", facts["source_generation"]
                )
            expected_target = request.target_generation or request.source_generation
            if facts["target_generation"] != expected_target:
                raise FeatureConflict(
                    "feature_collection_generation_conflict", facts["target_generation"]
                )
            if (
                not facts["allowed"]
                or output["count"] > MAX_FEATURES
                or output["points"] > MAX_COORDINATES
                or size > MAX_OUTPUT_BYTES
            ):
                raise FeatureInvalid("analysis exceeds bounded preview limits")
            return {
                "type": "FeatureCollection",
                "features": features,
                "opengeo:analysis": {
                    "operation": request.operation,
                    "version": "1.1.0"
                    if request.operation in {"clip", "intersection"}
                    else "1.0.0",
                    "sourceDatasetId": str(dataset_id),
                    **facts,
                    "targetDatasetId": str(request.target_dataset_id)
                    if request.target_dataset_id
                    else None,
                    "distanceMeters": request.distance_meters,
                    "crs": "CRS:84",
                    "persisted": False,
                    **({"previewId": str(request.preview_id)} if request.preview_id else {}),
                    **(
                        {
                            "joinSummary": {
                                "predicate": "intersects",
                                "unmatched": "retained",
                                "selection": "lowest_target_feature_id",
                            }
                        }
                        if request.operation == "join-summary"
                        else {}
                    ),
                    **(
                        {
                            "measurementUnits": {"area_sqm": "m2", "length_m": "m"},
                            "measurementMethod": "PostGIS spheroidal geography",
                        }
                        if request.operation == "measure"
                        else {}
                    ),
                    **(
                        {
                            "buildingReconciliation": {
                                "minimumIntersectionOverUnion": 0.5,
                                "intersectionMethod": "PostGIS local projected geography overlay",
                                "areaMethod": "PostGIS spheroidal geography",
                                "candidateRule": "one positive-area neighbor on each side",
                                "ambiguityRule": "multiple positive-area neighbors on either side",
                                "unmatched": "retained on both sides",
                                "reviewStatus": "unreviewed",
                                "validatedCount": None,
                                "maximumSpanDegrees": 6,
                                "maximumAbsoluteLatitude": 80,
                            }
                        }
                        if request.operation == "building-reconcile"
                        else {}
                    ),
                    "limits": {
                        "features": MAX_FEATURES,
                        "coordinates": MAX_COORDINATES,
                        "bytes": MAX_OUTPUT_BYTES,
                        "statementSeconds": 5,
                        "bufferLongitudeSpanDegrees": 6,
                    },
                },
            }

        return await self._run(context, operation)

    async def cancel_analysis_preview(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        preview_id: UUID,
    ) -> bool:
        async def operation(transaction: TenantTransaction) -> bool:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_READ, scope.roles)
            row = await transaction.fetch_one(
                """
                SELECT coalesce(bool_or(pg_cancel_backend(pid)), false)
                FROM pg_stat_activity
                WHERE datname = current_database() AND usename = current_user
                  AND pid <> pg_backend_pid() AND state = 'active'
                  AND application_name = %s AND starts_with(query, %s)
                """,
                (
                    analysis_application_name(
                        context.organization_id,
                        context.user_id,
                        project_id,
                        dataset_id,
                        preview_id,
                    ),
                    ANALYSIS_QUERY_MARKER,
                ),
            )
            if row is None or not isinstance(row[0], bool):
                raise FeatureStoreUnavailable("analysis cancellation response is unavailable")
            return row[0]

        return await self._run(context, operation)

    async def list_features(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        *,
        bbox: tuple[float, float, float, float] | None,
        limit: int,
        offset: int,
        expected_generation: int | None = None,
        cql2_filter: tuple[str, str] | None = None,
    ) -> FeaturePage:
        async def operation(transaction: TenantTransaction) -> FeaturePage:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_READ, scope.roles)
            collection = await self._collection(transaction, context, dataset_id)
            if expected_generation is not None and collection.generation != expected_generation:
                raise FeatureConflict(
                    "feature_collection_generation_conflict", collection.generation
                )
            filter_sql = ""
            filter_parameters: tuple[Any, ...] = ()
            if cql2_filter is not None:
                geometry_literals: list[dict[str, Any]] = []
                predicate, filter_parameters = compile_feature_filter(
                    *cql2_filter,
                    {field.name: field.type for field in collection.fields},
                    spatial=True,
                    geometry_literals=geometry_literals,
                )
                if geometry_literals:
                    valid = await transaction.fetch_one(
                        "SELECT bool_and(ST_IsValid(ST_GeomFromGeoJSON(value::text))) "
                        "FROM jsonb_array_elements(%s::jsonb)",
                        (Jsonb(geometry_literals),),
                    )
                    if valid is None or valid[0] is not True:
                        raise Cql2Invalid("invalid geometry topology in filter")
                filter_sql = f"AND ({predicate})"
            spatial_sql = ""
            spatial_parameters: tuple[Any, ...] = ()
            if bbox is not None:
                spatial_sql = """
                  AND feature.geometry && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
                  AND ST_Intersects(
                    feature.geometry,
                    ST_MakeEnvelope(%s, %s, %s, %s, 4326)
                  )
                """
                spatial_parameters = (*bbox, *bbox)
            count_row = await transaction.fetch_one(
                f"""
                SELECT count(*)::bigint
                FROM app.dataset_features feature
                WHERE feature.organization_id = %s
                  AND feature.dataset_id = %s
                  AND feature.deleted_at IS NULL
                  {spatial_sql}
                  {filter_sql}
                """,
                (context.organization_id, dataset_id, *spatial_parameters, *filter_parameters),
            )
            rows = await transaction.fetch_all(
                f"""
                {self._feature_select()}
                WHERE feature.organization_id = %s
                  AND feature.dataset_id = %s
                  AND feature.deleted_at IS NULL
                  {spatial_sql}
                  {filter_sql}
                ORDER BY feature.id
                LIMIT %s OFFSET %s
                """,
                (
                    context.organization_id,
                    dataset_id,
                    *spatial_parameters,
                    *filter_parameters,
                    limit,
                    offset,
                ),
            )
            return FeaturePage(
                collection=collection,
                features=tuple(self._feature(row) for row in rows),
                number_matched=cast(int, count_row[0]) if count_row is not None else 0,
                limit=limit,
                offset=offset,
            )

        return await self._run(context, operation)

    async def get_feature(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        feature_id: UUID,
        *,
        expected_generation: int | None = None,
    ) -> FeatureRecord:
        async def operation(transaction: TenantTransaction) -> FeatureRecord:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_READ, scope.roles)
            collection = await self._collection(transaction, context, dataset_id)
            if expected_generation is not None and collection.generation != expected_generation:
                raise FeatureConflict(
                    "feature_collection_generation_conflict", collection.generation
                )
            return await self._feature_head(transaction, context, dataset_id, feature_id)

        return await self._run(context, operation)

    async def list_deleted_features(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        *,
        limit: int,
        offset: int,
    ) -> FeatureTombstonePage:
        async def operation(transaction: TenantTransaction) -> FeatureTombstonePage:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_READ, scope.roles)
            await self._collection(transaction, context, dataset_id)
            count_row = await transaction.fetch_one(
                """
                SELECT count(*)::bigint
                FROM app.dataset_features
                WHERE organization_id = %s AND dataset_id = %s
                  AND deleted_at IS NOT NULL
                """,
                (context.organization_id, dataset_id),
            )
            rows = await transaction.fetch_all(
                """
                SELECT id, version_number, deleted_by, deleted_at, updated_at
                FROM app.dataset_features
                WHERE organization_id = %s AND dataset_id = %s
                  AND deleted_at IS NOT NULL
                ORDER BY deleted_at DESC, id
                LIMIT %s OFFSET %s
                """,
                (context.organization_id, dataset_id, limit, offset),
            )
            return FeatureTombstonePage(
                tombstones=tuple(
                    FeatureTombstone(
                        feature_id=cast(UUID, row[0]),
                        deleted_version=cast(int, row[1]),
                        deleted_by=cast(UUID, row[2]),
                        deleted_at=cast(datetime, row[3]),
                        updated_at=cast(datetime, row[4]),
                    )
                    for row in rows
                ),
                number_matched=cast(int, count_row[0]) if count_row is not None else 0,
                limit=limit,
                offset=offset,
            )

        return await self._run(context, operation)

    async def create_feature(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        feature: FeatureDraft,
        change_message: str | None,
        request_id: str,
        lock_token: UUID | None = None,
    ) -> FeatureMutation:
        async def operation(transaction: TenantTransaction) -> FeatureMutation:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_EDIT, scope.roles)
            self._require_editable_dataset(scope)
            collection = await self._collection(transaction, context, dataset_id, lock=True)
            _require_geometry_type(feature, collection.geometry_type)
            normalized_feature = replace(
                feature,
                properties=normalize_properties(feature.properties, collection.fields),
            )
            await authorize_feature_attachments(
                transaction, context, [normalized_feature.properties], collection.fields
            )
            exists = await transaction.fetch_one(
                """
                SELECT 1 FROM app.dataset_features
                WHERE organization_id = %s AND dataset_id = %s AND id = %s
                """,
                (context.organization_id, dataset_id, normalized_feature.feature_id),
            )
            if exists is not None:
                raise FeatureConflict("feature_id_exists")
            record = await self._insert_feature(
                transaction,
                context,
                dataset_id,
                normalized_feature,
                "create",
                change_message,
                request_id,
            )
            collection = await self._advance_collection(
                transaction, context, collection, count_delta=1
            )
            await self._event(
                transaction,
                context,
                project_id,
                dataset_id,
                "dataset.feature.created",
                "feature",
                normalized_feature.feature_id,
                request_id,
                {"dataset_id": str(dataset_id), "version": 1, "generation": collection.generation},
            )
            return FeatureMutation(collection, record)

        return await self._run(context, operation)

    async def update_feature(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        feature_id: UUID,
        expected_version: int,
        feature: FeatureDraft,
        change_message: str | None,
        request_id: str,
        lock_token: UUID | None = None,
    ) -> FeatureMutation:
        async def operation(transaction: TenantTransaction) -> FeatureMutation:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_EDIT, scope.roles)
            self._require_editable_dataset(scope)
            collection = await self._collection(transaction, context, dataset_id, lock=True)
            _require_geometry_type(feature, collection.geometry_type)
            properties = normalize_properties(feature.properties, collection.fields)
            await authorize_feature_attachments(
                transaction, context, [properties], collection.fields
            )
            current = await self._feature_head(
                transaction, context, dataset_id, feature_id, lock=True
            )
            if current.version_number != expected_version:
                raise FeatureConflict("feature_version_conflict", current.version_number)
            await self._require_feature_lock_access(
                transaction, context, dataset_id, feature_id, lock_token
            )
            next_version = expected_version + 1
            row = await transaction.fetch_one(
                """
                UPDATE app.dataset_features
                SET version_number = %s,
                    properties = %s,
                    geometry_geojson = %s,
                    geometry = ST_SetSRID(ST_GeomFromGeoJSON(%s::text), 4326),
                    updated_by = %s
                WHERE organization_id = %s AND dataset_id = %s AND id = %s
                  AND deleted_at IS NULL AND version_number = %s
                RETURNING id, version_number, geometry_type::text, properties,
                          geometry_geojson, bbox, created_by, created_at,
                          updated_by, updated_at
                """,
                (
                    next_version,
                    Jsonb(properties),
                    Jsonb(feature.geometry),
                    Jsonb(feature.geometry),
                    context.user_id,
                    context.organization_id,
                    dataset_id,
                    feature_id,
                    expected_version,
                ),
            )
            if row is None:
                raise FeatureConflict("feature_version_conflict", current.version_number)
            await self._insert_revision(
                transaction,
                context,
                dataset_id,
                feature_id,
                next_version,
                "update",
                feature.geometry_type,
                properties,
                feature.geometry,
                change_message,
                request_id,
            )
            await self._advance_feature_lock_version(
                transaction, context, dataset_id, feature_id, lock_token, next_version
            )
            collection = await self._advance_collection(
                transaction, context, collection, count_delta=0
            )
            await self._event(
                transaction,
                context,
                project_id,
                dataset_id,
                "dataset.feature.updated",
                "feature",
                feature_id,
                request_id,
                {
                    "dataset_id": str(dataset_id),
                    "version": next_version,
                    "generation": collection.generation,
                },
            )
            return FeatureMutation(collection, self._feature(row))

        return await self._run(context, operation)

    async def delete_feature(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        feature_id: UUID,
        expected_version: int,
        change_message: str | None,
        request_id: str,
        lock_token: UUID | None = None,
    ) -> FeatureDeletion:
        async def operation(transaction: TenantTransaction) -> FeatureDeletion:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_EDIT, scope.roles)
            self._require_editable_dataset(scope)
            collection = await self._collection(transaction, context, dataset_id, lock=True)
            current = await self._feature_head(
                transaction, context, dataset_id, feature_id, lock=True
            )
            if current.version_number != expected_version:
                raise FeatureConflict("feature_version_conflict", current.version_number)
            await self._require_feature_lock_access(
                transaction, context, dataset_id, feature_id, lock_token
            )
            next_version = expected_version + 1
            changed = await transaction.execute(
                """
                UPDATE app.dataset_features
                SET version_number = %s, updated_by = %s,
                    deleted_by = %s, deleted_at = clock_timestamp()
                WHERE organization_id = %s AND dataset_id = %s AND id = %s
                  AND deleted_at IS NULL AND version_number = %s
                """,
                (
                    next_version,
                    context.user_id,
                    context.user_id,
                    context.organization_id,
                    dataset_id,
                    feature_id,
                    expected_version,
                ),
            )
            if changed != 1:
                raise FeatureConflict("feature_version_conflict", current.version_number)
            await self._insert_revision(
                transaction,
                context,
                dataset_id,
                feature_id,
                next_version,
                "delete",
                current.geometry_type,
                current.properties,
                current.geometry,
                change_message,
                request_id,
            )
            await self._drop_feature_lock(transaction, context, dataset_id, feature_id)
            collection = await self._advance_collection(
                transaction, context, collection, count_delta=-1
            )
            await self._event(
                transaction,
                context,
                project_id,
                dataset_id,
                "dataset.feature.deleted",
                "feature",
                feature_id,
                request_id,
                {
                    "dataset_id": str(dataset_id),
                    "version": next_version,
                    "generation": collection.generation,
                },
            )
            return FeatureDeletion(feature_id, next_version, collection.generation)

        return await self._run(context, operation)

    async def restore_feature(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        feature_id: UUID,
        expected_version: int,
        revision_version: int,
        change_message: str | None,
        request_id: str,
    ) -> FeatureMutation:
        async def operation(transaction: TenantTransaction) -> FeatureMutation:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_EDIT, scope.roles)
            self._require_editable_dataset(scope)
            collection = await self._collection(transaction, context, dataset_id, lock=True)
            head = await transaction.fetch_one(
                """
                SELECT version_number, deleted_at
                FROM app.dataset_features
                WHERE organization_id = %s AND dataset_id = %s AND id = %s
                FOR UPDATE
                """,
                (context.organization_id, dataset_id, feature_id),
            )
            if head is None:
                raise FeatureNotFound("feature")
            current_version = int(head[0])
            if head[1] is None:
                raise FeatureConflict("feature_not_deleted", current_version)
            if current_version != expected_version:
                raise FeatureConflict("feature_version_conflict", current_version)
            if revision_version >= expected_version:
                raise FeatureInvalid("restore revision must predate the current tombstone")
            revision = await transaction.fetch_one(
                """
                SELECT geometry_type::text, properties, geometry_geojson
                FROM app.dataset_feature_revisions
                WHERE organization_id = %s AND dataset_id = %s AND feature_id = %s
                  AND version_number = %s
                  AND operation IN ('create', 'update', 'restore')
                """,
                (context.organization_id, dataset_id, feature_id, revision_version),
            )
            if revision is None:
                raise FeatureNotFound("feature_revision")
            geometry_type = cast(GeometryType, revision[0])
            if geometry_type != collection.geometry_type:
                raise FeatureInvalid("restore revision geometry type changed")
            properties = normalize_properties(cast(dict[str, Any], revision[1]), collection.fields)
            await authorize_feature_attachments(
                transaction, context, [properties], collection.fields
            )
            geometry = cast(dict[str, Any], revision[2])
            normalized_geometry_type, normalized_geometry, _bbox = normalize_geometry(geometry)
            if normalized_geometry_type != collection.geometry_type:
                raise FeatureInvalid("restore revision geometry type changed")
            next_version = expected_version + 1
            row = await transaction.fetch_one(
                """
                UPDATE app.dataset_features
                SET version_number = %s,
                    properties = %s,
                    geometry_geojson = %s,
                    geometry = ST_SetSRID(ST_GeomFromGeoJSON(%s::text), 4326),
                    updated_by = %s,
                    deleted_by = NULL,
                    deleted_at = NULL
                WHERE organization_id = %s AND dataset_id = %s AND id = %s
                  AND deleted_at IS NOT NULL AND version_number = %s
                RETURNING id, version_number, geometry_type::text, properties,
                          geometry_geojson, bbox, created_by, created_at,
                          updated_by, updated_at
                """,
                (
                    next_version,
                    Jsonb(properties),
                    Jsonb(normalized_geometry),
                    Jsonb(normalized_geometry),
                    context.user_id,
                    context.organization_id,
                    dataset_id,
                    feature_id,
                    expected_version,
                ),
            )
            if row is None:
                raise FeatureConflict("feature_version_conflict", current_version)
            await self._insert_revision(
                transaction,
                context,
                dataset_id,
                feature_id,
                next_version,
                "restore",
                collection.geometry_type,
                properties,
                normalized_geometry,
                change_message,
                request_id,
            )
            await self._drop_feature_lock(transaction, context, dataset_id, feature_id)
            collection = await self._advance_collection(
                transaction, context, collection, count_delta=1
            )
            await self._event(
                transaction,
                context,
                project_id,
                dataset_id,
                "dataset.feature.restored",
                "feature",
                feature_id,
                request_id,
                {
                    "dataset_id": str(dataset_id),
                    "version": next_version,
                    "source_revision": revision_version,
                    "generation": collection.generation,
                },
            )
            return FeatureMutation(collection, self._feature(row))

        return await self._run(context, operation)

    async def separate_multipolygon_parts(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        feature_id: UUID,
        expected_version: int,
        retained_part_index: int,
        change_message: str | None,
        request_id: str,
        lock_token: UUID | None = None,
    ) -> FeatureStructureMutation:
        async def operation(transaction: TenantTransaction) -> FeatureStructureMutation:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_EDIT, scope.roles)
            self._require_editable_dataset(scope)
            collection = await self._collection(transaction, context, dataset_id, lock=True)
            if collection.geometry_type != "MultiPolygon":
                raise FeatureInvalid("only MultiPolygon collections can separate polygon parts")
            current = await self._feature_head(
                transaction, context, dataset_id, feature_id, lock=True
            )
            if current.version_number != expected_version:
                raise FeatureConflict("feature_version_conflict", current.version_number)
            await self._require_feature_lock_access(
                transaction, context, dataset_id, feature_id, lock_token
            )
            drafts = separate_multipolygon_drafts(current, collection.fields, retained_part_index)
            await authorize_feature_attachments(
                transaction, context, [current.properties], collection.fields
            )
            retained = await self._replace_feature_head(
                transaction,
                context,
                dataset_id,
                current,
                drafts[0],
                change_message or "Separated multipart polygon feature",
                request_id,
            )
            await self._advance_feature_lock_version(
                transaction,
                context,
                dataset_id,
                feature_id,
                lock_token,
                retained.version_number,
            )
            created = tuple(
                [
                    await self._insert_feature(
                        transaction,
                        context,
                        dataset_id,
                        draft,
                        "create",
                        change_message or f"Separated from feature {feature_id}",
                        request_id,
                    )
                    for draft in drafts[1:]
                ]
            )
            collection = await self._advance_collection(
                transaction, context, collection, count_delta=len(created)
            )
            await self._event(
                transaction,
                context,
                project_id,
                dataset_id,
                "dataset.feature.parts.separated",
                "feature",
                feature_id,
                request_id,
                {
                    "dataset_id": str(dataset_id),
                    "retained_feature_id": str(feature_id),
                    "retained_part_index": retained_part_index,
                    "created_feature_ids": [str(item.feature_id) for item in created],
                    "generation": collection.generation,
                },
            )
            return FeatureStructureMutation(collection, retained, created, ())

        return await self._run(context, operation)

    async def cut_multipolygon_feature(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        feature_id: UUID,
        expected_version: int,
        part_index: int,
        cut_line: dict[str, Any],
        change_message: str | None,
        request_id: str,
        lock_token: UUID | None = None,
    ) -> FeatureStructureMutation:
        async def operation(transaction: TenantTransaction) -> FeatureStructureMutation:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_EDIT, scope.roles)
            self._require_editable_dataset(scope)
            collection = await self._collection(transaction, context, dataset_id, lock=True)
            if collection.geometry_type != "MultiPolygon":
                raise FeatureInvalid("only MultiPolygon collections can cut polygon features")
            current = await self._feature_head(
                transaction, context, dataset_id, feature_id, lock=True
            )
            if current.version_number != expected_version:
                raise FeatureConflict("feature_version_conflict", current.version_number)
            await self._require_feature_lock_access(
                transaction, context, dataset_id, feature_id, lock_token
            )
            kind, geometry, _bbox = normalize_geometry(current.geometry)
            if kind != "MultiPolygon" or not 0 <= part_index < len(geometry["coordinates"]):
                raise FeatureInvalid("cut polygon part index is outside the feature")
            blade = normalize_cut_line(cut_line)
            await authorize_feature_attachments(
                transaction, context, [current.properties], collection.fields
            )
            await transaction.execute(_DISSOLVE_TIMEOUT_SQL, ())
            row = await transaction.fetch_one(
                _CUT_MULTIPOLYGON_SQL, (Jsonb(geometry), Jsonb(blade), part_index + 1)
            )
            if row is None or row[1] is not True or not isinstance(row[0], list):
                raise FeatureInvalid(
                    "cut requires an open simple line crossing the selected polygon without "
                    "boundary overlap, and 2 to 20 valid pieces within geometry limits"
                )
            drafts = cut_multipolygon_drafts(current, collection.fields, part_index, row[0])
            retained = await self._replace_feature_head(
                transaction,
                context,
                dataset_id,
                current,
                drafts[0],
                change_message or "Cut polygon with a line",
                request_id,
            )
            await self._advance_feature_lock_version(
                transaction, context, dataset_id, feature_id, lock_token, retained.version_number
            )
            created = tuple(
                [
                    await self._insert_feature(
                        transaction,
                        context,
                        dataset_id,
                        draft,
                        "create",
                        change_message or f"Cut from feature {feature_id}",
                        request_id,
                    )
                    for draft in drafts[1:]
                ]
            )
            collection = await self._advance_collection(
                transaction, context, collection, count_delta=len(created)
            )
            await self._event(
                transaction,
                context,
                project_id,
                dataset_id,
                "dataset.feature.cut",
                "feature",
                feature_id,
                request_id,
                {
                    "dataset_id": str(dataset_id),
                    "part_index": part_index,
                    "created_feature_ids": [str(item.feature_id) for item in created],
                    "generation": collection.generation,
                },
            )
            return FeatureStructureMutation(collection, retained, created, ())

        return await self._run(context, operation)

    async def merge_multipolygon_features(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        retained_feature_id: UUID,
        expected_versions: tuple[tuple[UUID, int, UUID | None], ...],
        change_message: str | None,
        request_id: str,
        geometry_operation: PolygonGeometryOperation = "collect",
    ) -> FeatureStructureMutation:
        async def operation(transaction: TenantTransaction) -> FeatureStructureMutation:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_EDIT, scope.roles)
            self._require_editable_dataset(scope)
            if geometry_operation not in {"collect", "dissolve"}:
                raise FeatureInvalid("polygon geometry operation must be collect or dissolve")
            collection = await self._collection(transaction, context, dataset_id, lock=True)
            if collection.geometry_type != "MultiPolygon":
                raise FeatureInvalid("only MultiPolygon collections can merge polygon features")
            if not 2 <= len(expected_versions) <= 20:
                raise FeatureInvalid("polygon merge requires between 2 and 20 features")
            requested_ids = [feature_id for feature_id, _version, _token in expected_versions]
            if len(set(requested_ids)) != len(requested_ids):
                raise FeatureInvalid("polygon merge feature ids must be unique")
            if retained_feature_id not in requested_ids:
                raise FeatureInvalid("retained polygon feature must be included in the merge")
            locked: dict[UUID, FeatureRecord] = {}
            for feature_id in sorted(requested_ids, key=str):
                locked[feature_id] = await self._feature_head(
                    transaction, context, dataset_id, feature_id, lock=True
                )
            lock_tokens: dict[UUID, UUID | None] = {}
            for feature_id, expected_version, lock_token in expected_versions:
                current = locked[feature_id]
                if current.version_number != expected_version:
                    raise FeatureConflict("feature_version_conflict", current.version_number)
                lock_tokens[feature_id] = lock_token
                await self._require_feature_lock_access(
                    transaction, context, dataset_id, feature_id, lock_token
                )
            ordered = [locked[retained_feature_id]] + [
                locked[feature_id]
                for feature_id in requested_ids
                if feature_id != retained_feature_id
            ]
            retained_draft = merge_multipolygon_draft(
                ordered, collection.fields, retained_feature_id
            )
            await authorize_feature_attachments(
                transaction, context, [retained_draft.properties], collection.fields
            )
            if geometry_operation == "dissolve":
                # The combined normalized draft bounds every input coordinate and
                # part before the database performs any topology computation.
                await transaction.execute(_DISSOLVE_TIMEOUT_SQL, ())
                row = await transaction.fetch_one(
                    _DISSOLVE_MULTIPOLYGON_SQL,
                    (Jsonb([feature.geometry for feature in ordered]), _MAX_COORDINATES),
                )
                if row is None or row[1] is not True or not isinstance(row[0], dict):
                    raise FeatureInvalid(
                        "dissolve requires valid source polygons and a nonempty valid "
                        "MultiPolygon result within 10000 positions and 256 parts"
                    )
                retained_draft = feature_draft(
                    row[0], retained_draft.properties, collection.fields, retained_feature_id
                )
                if retained_draft.geometry_type != "MultiPolygon":
                    raise FeatureInvalid("dissolve result must be a MultiPolygon")
            else:
                await self._require_valid_geometry(transaction, retained_draft.geometry)
            default_message = (
                "Dissolved polygon feature boundaries"
                if geometry_operation == "dissolve"
                else "Merged multipart polygon features"
            )
            retained = await self._replace_feature_head(
                transaction,
                context,
                dataset_id,
                locked[retained_feature_id],
                retained_draft,
                change_message or default_message,
                request_id,
            )
            await self._advance_feature_lock_version(
                transaction,
                context,
                dataset_id,
                retained_feature_id,
                lock_tokens[retained_feature_id],
                retained.version_number,
            )
            deleted: list[FeatureDeletion] = []
            for current in ordered[1:]:
                deleted_version = await self._tombstone_feature_head(
                    transaction,
                    context,
                    dataset_id,
                    current,
                    change_message
                    or (
                        f"Dissolved into feature {retained_feature_id}"
                        if geometry_operation == "dissolve"
                        else f"Merged into feature {retained_feature_id}"
                    ),
                    request_id,
                )
                await self._drop_feature_lock(transaction, context, dataset_id, current.feature_id)
                deleted.append(FeatureDeletion(current.feature_id, deleted_version, 0))
            collection = await self._advance_collection(
                transaction, context, collection, count_delta=-len(deleted)
            )
            deletions = tuple(
                replace(item, collection_generation=collection.generation) for item in deleted
            )
            await self._event(
                transaction,
                context,
                project_id,
                dataset_id,
                "dataset.feature.parts.merged",
                "feature",
                retained_feature_id,
                request_id,
                {
                    "dataset_id": str(dataset_id),
                    "retained_feature_id": str(retained_feature_id),
                    "deleted_feature_ids": [str(item.feature_id) for item in deletions],
                    "generation": collection.generation,
                    "geometry_operation": geometry_operation,
                },
            )
            return FeatureStructureMutation(collection, retained, (), deletions)

        return await self._run(context, operation)

    async def list_feature_locks(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
    ) -> tuple[FeatureLockRecord, ...]:
        async def operation(transaction: TenantTransaction) -> tuple[FeatureLockRecord, ...]:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_READ, scope.roles)
            await self._collection(transaction, context, dataset_id, lock=False)
            rows = await transaction.fetch_all(
                """
                SELECT feature_lock.feature_id, feature_lock.feature_version,
                       CASE WHEN feature_lock.locked_by = %s
                         THEN feature_lock.lock_token ELSE NULL END,
                       feature_lock.locked_by = %s,
                       feature_lock.acquired_at, feature_lock.expires_at
                FROM app.dataset_feature_locks feature_lock
                JOIN app.dataset_features feature
                  ON feature.organization_id = feature_lock.organization_id
                 AND feature.dataset_id = feature_lock.dataset_id
                 AND feature.id = feature_lock.feature_id
                WHERE feature_lock.organization_id = %s
                  AND feature_lock.dataset_id = %s
                  AND feature_lock.expires_at > clock_timestamp()
                  AND feature.deleted_at IS NULL
                ORDER BY feature_lock.expires_at, feature_lock.feature_id
                LIMIT 100
                """,
                (
                    context.user_id,
                    context.user_id,
                    context.organization_id,
                    dataset_id,
                ),
            )
            return tuple(self._feature_lock(row) for row in rows)

        return await self._run(context, operation)

    async def acquire_feature_lock(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        feature_id: UUID,
        expected_version: int,
        lock_token: UUID,
        lease_seconds: int,
        request_id: str,
    ) -> FeatureLockRecord:
        if not 30 <= lease_seconds <= _MAX_FEATURE_LOCK_LEASE_SECONDS:
            raise FeatureInvalid("feature lock lease must be between 30 and 300 seconds")

        async def operation(transaction: TenantTransaction) -> FeatureLockRecord:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_EDIT, scope.roles)
            self._require_editable_dataset(scope)
            await self._collection(transaction, context, dataset_id, lock=False)
            current = await self._feature_head(
                transaction, context, dataset_id, feature_id, lock=True
            )
            if current.version_number != expected_version:
                raise FeatureConflict("feature_version_conflict", current.version_number)
            user_row = await transaction.fetch_one(
                "SELECT id FROM app.users WHERE id = %s FOR UPDATE",
                (context.user_id,),
            )
            if user_row is None:
                raise FeatureAccessDenied("feature lock user is unavailable")
            active = await transaction.fetch_one(
                """
                SELECT lock_token, locked_by
                FROM app.dataset_feature_locks
                WHERE organization_id = %s AND dataset_id = %s AND feature_id = %s
                  AND expires_at > clock_timestamp()
                """,
                (context.organization_id, dataset_id, feature_id),
            )
            renewing = active is not None
            if active is not None and (
                UUID(str(active[0])) != lock_token or UUID(str(active[1])) != context.user_id
            ):
                raise FeatureConflict("feature_locked", current.version_number)
            if active is None:
                count_row = await transaction.fetch_one(
                    """
                    SELECT count(*)
                    FROM app.dataset_feature_locks
                    WHERE organization_id = %s AND locked_by = %s
                      AND expires_at > clock_timestamp()
                    """,
                    (context.organization_id, context.user_id),
                )
                if count_row is None or int(count_row[0]) >= _MAX_FEATURE_LOCKS_PER_USER:
                    raise FeatureConflict("feature_lock_limit_reached")
            row = await transaction.fetch_one(
                """
                INSERT INTO app.dataset_feature_locks
                  (organization_id, dataset_id, feature_id, feature_version,
                   lock_token, locked_by, acquired_at, expires_at)
                VALUES (
                  %s, %s, %s, %s, %s, %s, clock_timestamp(),
                  clock_timestamp() + make_interval(secs => %s)
                )
                ON CONFLICT (organization_id, dataset_id, feature_id)
                DO UPDATE SET
                  feature_version = EXCLUDED.feature_version,
                  lock_token = EXCLUDED.lock_token,
                  locked_by = EXCLUDED.locked_by,
                  acquired_at = EXCLUDED.acquired_at,
                  expires_at = EXCLUDED.expires_at
                WHERE dataset_feature_locks.locked_by = EXCLUDED.locked_by
                   OR dataset_feature_locks.expires_at <= clock_timestamp()
                RETURNING feature_id, feature_version, lock_token, true,
                          acquired_at, expires_at
                """,
                (
                    context.organization_id,
                    dataset_id,
                    feature_id,
                    expected_version,
                    lock_token,
                    context.user_id,
                    lease_seconds,
                ),
            )
            if row is None:
                raise FeatureConflict("feature_locked", current.version_number)
            feature_lock = self._feature_lock(row)
            await self._event(
                transaction,
                context,
                project_id,
                dataset_id,
                "dataset.feature.lock.renewed" if renewing else "dataset.feature.lock.acquired",
                "feature",
                feature_id,
                request_id,
                {
                    "dataset_id": str(dataset_id),
                    "feature_version": expected_version,
                    "lease_seconds": lease_seconds,
                    "expires_at": feature_lock.expires_at.isoformat(),
                },
            )
            return feature_lock

        return await self._run(context, operation)

    async def release_feature_lock(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        feature_id: UUID,
        lock_token: UUID,
        request_id: str,
    ) -> FeatureLockRelease:
        async def operation(transaction: TenantTransaction) -> FeatureLockRelease:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_EDIT, scope.roles)
            self._require_editable_dataset(scope)
            await self._collection(transaction, context, dataset_id, lock=False)
            current = await self._feature_head(
                transaction, context, dataset_id, feature_id, lock=True
            )
            active = await transaction.fetch_one(
                """
                SELECT lock_token, locked_by, feature_version
                FROM app.dataset_feature_locks
                WHERE organization_id = %s AND dataset_id = %s AND feature_id = %s
                  AND expires_at > clock_timestamp()
                FOR UPDATE
                """,
                (context.organization_id, dataset_id, feature_id),
            )
            if active is None:
                return FeatureLockRelease(feature_id, False)
            if UUID(str(active[0])) != lock_token or UUID(str(active[1])) != context.user_id:
                raise FeatureConflict("feature_locked", current.version_number)
            changed = await transaction.execute(
                """
                DELETE FROM app.dataset_feature_locks
                WHERE organization_id = %s AND dataset_id = %s AND feature_id = %s
                  AND lock_token = %s AND locked_by = %s
                """,
                (
                    context.organization_id,
                    dataset_id,
                    feature_id,
                    lock_token,
                    context.user_id,
                ),
            )
            if changed != 1:
                raise FeatureConflict("feature_locked", current.version_number)
            await self._event(
                transaction,
                context,
                project_id,
                dataset_id,
                "dataset.feature.lock.released",
                "feature",
                feature_id,
                request_id,
                {
                    "dataset_id": str(dataset_id),
                    "feature_version": int(active[2]),
                },
            )
            return FeatureLockRelease(feature_id, True)

        return await self._run(context, operation)

    async def list_feature_history(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        feature_id: UUID,
        limit: int,
        offset: int,
    ) -> tuple[FeatureRevision, ...]:
        async def operation(transaction: TenantTransaction) -> tuple[FeatureRevision, ...]:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_READ, scope.roles)
            exists = await transaction.fetch_one(
                """
                SELECT 1 FROM app.dataset_features
                WHERE organization_id = %s AND dataset_id = %s AND id = %s
                """,
                (context.organization_id, dataset_id, feature_id),
            )
            if exists is None:
                raise FeatureNotFound("feature")
            rows = await transaction.fetch_all(
                """
                SELECT version_number, operation::text, geometry_type::text,
                       properties, geometry_geojson, changed_by, change_message,
                       request_id, created_at
                FROM app.dataset_feature_revisions
                WHERE organization_id = %s AND dataset_id = %s AND feature_id = %s
                ORDER BY version_number DESC
                LIMIT %s OFFSET %s
                """,
                (context.organization_id, dataset_id, feature_id, limit, offset),
            )
            return tuple(
                FeatureRevision(
                    version_number=cast(int, row[0]),
                    operation=cast(FeatureOperation, row[1]),
                    geometry_type=cast(GeometryType, row[2]),
                    properties=cast(dict[str, Any], row[3]),
                    geometry=cast(dict[str, Any], row[4]),
                    changed_by=cast(UUID, row[5]),
                    change_message=cast(str | None, row[6]),
                    request_id=cast(str, row[7]),
                    created_at=cast(datetime, row[8]),
                )
                for row in rows
            )

        return await self._run(context, operation)

    @staticmethod
    async def _scope(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
    ) -> _DatasetScope:
        row = await transaction.fetch_one(
            """
            SELECT organization.role::text,
                   app.effective_project_role(project.id, organization.user_id)::text,
                   permission.role::text, dataset.owner_user_id = %s,
                   dataset.status::text, dataset.format::text
            FROM app.organization_memberships organization
            JOIN app.projects project
              ON project.organization_id = organization.organization_id
             AND project.id = %s
            JOIN app.project_datasets project_dataset
              ON project_dataset.organization_id = project.organization_id
             AND project_dataset.project_id = project.id
             AND project_dataset.dataset_id = %s
            JOIN app.datasets dataset
              ON dataset.organization_id = project_dataset.organization_id
             AND dataset.id = project_dataset.dataset_id
            LEFT JOIN app.dataset_permissions permission
              ON permission.organization_id = dataset.organization_id
             AND permission.dataset_id = dataset.id
             AND permission.user_id = organization.user_id
            WHERE organization.organization_id = %s
              AND organization.user_id = %s
            """,
            (
                context.user_id,
                project_id,
                dataset_id,
                context.organization_id,
                context.user_id,
            ),
        )
        if row is None:
            raise FeatureNotFound("dataset")
        return _DatasetScope(
            roles=Roles(
                organization=cast(OrganizationRole, row[0]),
                project=cast(ProjectRole | None, row[1]),
                dataset=cast(DatasetPermissionRole | None, row[2]),
                dataset_owner=cast(bool, row[3]),
            ),
            status=cast(str, row[4]),
            format=cast(str, row[5]),
        )

    @staticmethod
    def _require_editable_dataset(scope: _DatasetScope) -> None:
        if scope.status not in {"draft", "active"} or scope.format not in _VECTOR_FORMATS:
            raise FeatureConflict("dataset_not_feature_editable")

    @staticmethod
    async def _require_feature_lock_access(
        transaction: TenantTransaction,
        context: TenantContext,
        dataset_id: UUID,
        feature_id: UUID,
        lock_token: UUID | None,
    ) -> None:
        row = await transaction.fetch_one(
            """
            SELECT lock_token, locked_by, feature_version
            FROM app.dataset_feature_locks
            WHERE organization_id = %s AND dataset_id = %s AND feature_id = %s
              AND expires_at > clock_timestamp()
            """,
            (context.organization_id, dataset_id, feature_id),
        )
        if row is None:
            return
        if (
            lock_token is None
            or UUID(str(row[0])) != lock_token
            or UUID(str(row[1])) != context.user_id
        ):
            raise FeatureConflict("feature_locked", int(row[2]))

    @staticmethod
    async def _advance_feature_lock_version(
        transaction: TenantTransaction,
        context: TenantContext,
        dataset_id: UUID,
        feature_id: UUID,
        lock_token: UUID | None,
        next_version: int,
    ) -> None:
        if lock_token is None:
            return
        changed = await transaction.execute(
            """
            UPDATE app.dataset_feature_locks
            SET feature_version = %s
            WHERE organization_id = %s AND dataset_id = %s AND feature_id = %s
              AND lock_token = %s AND locked_by = %s
              AND expires_at > clock_timestamp()
            """,
            (
                next_version,
                context.organization_id,
                dataset_id,
                feature_id,
                lock_token,
                context.user_id,
            ),
        )
        if changed not in {0, 1}:
            raise FeatureStoreUnavailable("feature lock version update was not unique")

    @staticmethod
    async def _drop_feature_lock(
        transaction: TenantTransaction,
        context: TenantContext,
        dataset_id: UUID,
        feature_id: UUID,
    ) -> None:
        changed = await transaction.execute(
            """
            DELETE FROM app.dataset_feature_locks
            WHERE organization_id = %s AND dataset_id = %s AND feature_id = %s
              AND (locked_by = %s OR expires_at <= clock_timestamp())
            """,
            (context.organization_id, dataset_id, feature_id, context.user_id),
        )
        if changed not in {0, 1}:
            raise FeatureStoreUnavailable("feature lock deletion was not unique")

    @staticmethod
    def _require(action: Action, roles: Roles) -> None:
        try:
            authorize(action, roles)
        except AuthorizationDenied as error:
            raise FeatureAccessDenied("action forbidden") from error

    @staticmethod
    async def _collection(
        transaction: TenantTransaction,
        context: TenantContext,
        dataset_id: UUID,
        *,
        lock: bool = False,
    ) -> FeatureCollection:
        row = await transaction.fetch_one(
            f"""
            SELECT dataset_id, geometry_type::text, schema_definition,
                   generation, feature_count, created_by, created_at,
                   updated_by, updated_at
            FROM app.feature_collections
            WHERE organization_id = %s AND dataset_id = %s
            {"FOR UPDATE" if lock else ""}
            """,
            (context.organization_id, dataset_id),
        )
        if row is None:
            raise FeatureNotFound("feature_collection")
        return FeatureCollection(
            dataset_id=cast(UUID, row[0]),
            geometry_type=cast(GeometryType, row[1]),
            fields=_fields_from_schema(cast(dict[str, Any], row[2])),
            generation=cast(int, row[3]),
            feature_count=cast(int, row[4]),
            created_by=cast(UUID, row[5]),
            created_at=cast(datetime, row[6]),
            updated_by=cast(UUID, row[7]),
            updated_at=cast(datetime, row[8]),
        )

    @staticmethod
    async def _advance_collection(
        transaction: TenantTransaction,
        context: TenantContext,
        collection: FeatureCollection,
        *,
        count_delta: int,
    ) -> FeatureCollection:
        row = await transaction.fetch_one(
            """
            UPDATE app.feature_collections
            SET generation = generation + 1,
                feature_count = feature_count + %s,
                updated_by = %s
            WHERE organization_id = %s AND dataset_id = %s
              AND generation = %s
            RETURNING generation, feature_count, updated_at
            """,
            (
                count_delta,
                context.user_id,
                context.organization_id,
                collection.dataset_id,
                collection.generation,
            ),
        )
        if row is None:
            raise FeatureConflict("feature_collection_generation_conflict")
        return replace(
            collection,
            generation=cast(int, row[0]),
            feature_count=cast(int, row[1]),
            updated_by=context.user_id,
            updated_at=cast(datetime, row[2]),
        )

    @staticmethod
    async def _replace_feature_head(
        transaction: TenantTransaction,
        context: TenantContext,
        dataset_id: UUID,
        current: FeatureRecord,
        feature: FeatureDraft,
        change_message: str | None,
        request_id: str,
    ) -> FeatureRecord:
        next_version = current.version_number + 1
        row = await transaction.fetch_one(
            """
            UPDATE app.dataset_features
            SET version_number = %s,
                properties = %s,
                geometry_geojson = %s,
                geometry = ST_SetSRID(ST_GeomFromGeoJSON(%s::text), 4326),
                updated_by = %s
            WHERE organization_id = %s AND dataset_id = %s AND id = %s
              AND deleted_at IS NULL AND version_number = %s
            RETURNING id, version_number, geometry_type::text, properties,
                      geometry_geojson, bbox, created_by, created_at,
                      updated_by, updated_at
            """,
            (
                next_version,
                Jsonb(feature.properties),
                Jsonb(feature.geometry),
                Jsonb(feature.geometry),
                context.user_id,
                context.organization_id,
                dataset_id,
                current.feature_id,
                current.version_number,
            ),
        )
        if row is None:
            raise FeatureConflict("feature_version_conflict", current.version_number)
        await PostgresFeatureRepository._insert_revision(
            transaction,
            context,
            dataset_id,
            current.feature_id,
            next_version,
            "update",
            feature.geometry_type,
            feature.properties,
            feature.geometry,
            change_message,
            request_id,
        )
        return PostgresFeatureRepository._feature(row)

    @staticmethod
    async def _tombstone_feature_head(
        transaction: TenantTransaction,
        context: TenantContext,
        dataset_id: UUID,
        current: FeatureRecord,
        change_message: str | None,
        request_id: str,
    ) -> int:
        next_version = current.version_number + 1
        changed = await transaction.execute(
            """
            UPDATE app.dataset_features
            SET version_number = %s, updated_by = %s,
                deleted_by = %s, deleted_at = clock_timestamp()
            WHERE organization_id = %s AND dataset_id = %s AND id = %s
              AND deleted_at IS NULL AND version_number = %s
            """,
            (
                next_version,
                context.user_id,
                context.user_id,
                context.organization_id,
                dataset_id,
                current.feature_id,
                current.version_number,
            ),
        )
        if changed != 1:
            raise FeatureConflict("feature_version_conflict", current.version_number)
        await PostgresFeatureRepository._insert_revision(
            transaction,
            context,
            dataset_id,
            current.feature_id,
            next_version,
            "delete",
            current.geometry_type,
            current.properties,
            current.geometry,
            change_message,
            request_id,
        )
        return next_version

    @staticmethod
    async def _require_valid_geometry(
        transaction: TenantTransaction, geometry: dict[str, Any]
    ) -> None:
        row = await transaction.fetch_one(
            """
            SELECT ST_IsValid(ST_SetSRID(ST_GeomFromGeoJSON(%s::text), 4326))
            """,
            (Jsonb(geometry),),
        )
        if row is None or row[0] is not True:
            raise FeatureInvalid(
                "merged polygon parts must form a valid non-overlapping MultiPolygon"
            )

    @staticmethod
    async def _insert_feature(
        transaction: TenantTransaction,
        context: TenantContext,
        dataset_id: UUID,
        feature: FeatureDraft,
        operation: FeatureOperation,
        change_message: str | None,
        request_id: str,
    ) -> FeatureRecord:
        row = await transaction.fetch_one(
            """
            INSERT INTO app.dataset_features
              (id, organization_id, dataset_id, version_number, geometry_type,
               properties, geometry_geojson, geometry, created_by, updated_by)
            VALUES (
              %s, %s, %s, 1, %s::app.feature_geometry_type, %s, %s,
              ST_SetSRID(ST_GeomFromGeoJSON(%s::text), 4326), %s, %s
            )
            RETURNING id, version_number, geometry_type::text, properties,
                      geometry_geojson, bbox, created_by, created_at,
                      updated_by, updated_at
            """,
            (
                feature.feature_id,
                context.organization_id,
                dataset_id,
                feature.geometry_type,
                Jsonb(feature.properties),
                Jsonb(feature.geometry),
                Jsonb(feature.geometry),
                context.user_id,
                context.user_id,
            ),
        )
        assert row is not None
        await PostgresFeatureRepository._insert_revision(
            transaction,
            context,
            dataset_id,
            feature.feature_id,
            1,
            operation,
            feature.geometry_type,
            feature.properties,
            feature.geometry,
            change_message,
            request_id,
        )
        return PostgresFeatureRepository._feature(row)

    @staticmethod
    async def _insert_revision(
        transaction: TenantTransaction,
        context: TenantContext,
        dataset_id: UUID,
        feature_id: UUID,
        version_number: int,
        operation: FeatureOperation,
        geometry_type: GeometryType,
        properties: dict[str, Any],
        geometry: dict[str, Any],
        change_message: str | None,
        request_id: str,
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.dataset_feature_revisions
              (organization_id, dataset_id, feature_id, version_number,
               operation, geometry_type, properties, geometry_geojson,
               geometry, changed_by, change_message, request_id)
            VALUES (
              %s, %s, %s, %s, %s::app.feature_revision_operation,
              %s::app.feature_geometry_type, %s, %s,
              ST_SetSRID(ST_GeomFromGeoJSON(%s::text), 4326), %s, %s, %s
            )
            """,
            (
                context.organization_id,
                dataset_id,
                feature_id,
                version_number,
                operation,
                geometry_type,
                Jsonb(properties),
                Jsonb(geometry),
                Jsonb(geometry),
                context.user_id,
                change_message,
                request_id,
            ),
        )

    @staticmethod
    async def _feature_head(
        transaction: TenantTransaction,
        context: TenantContext,
        dataset_id: UUID,
        feature_id: UUID,
        *,
        lock: bool = False,
    ) -> FeatureRecord:
        row = await transaction.fetch_one(
            f"""
            {PostgresFeatureRepository._feature_select()}
            WHERE feature.organization_id = %s
              AND feature.dataset_id = %s
              AND feature.id = %s
              AND feature.deleted_at IS NULL
            {"FOR UPDATE" if lock else ""}
            """,
            (context.organization_id, dataset_id, feature_id),
        )
        if row is None:
            raise FeatureNotFound("feature")
        return PostgresFeatureRepository._feature(row)

    @staticmethod
    def _feature_select() -> str:
        return """
            SELECT feature.id, feature.version_number, feature.geometry_type::text,
                   feature.properties, feature.geometry_geojson, feature.bbox,
                   feature.created_by, feature.created_at,
                   feature.updated_by, feature.updated_at
            FROM app.dataset_features feature
        """

    @staticmethod
    def _feature(row: tuple[Any, ...]) -> FeatureRecord:
        return FeatureRecord(
            feature_id=cast(UUID, row[0]),
            version_number=cast(int, row[1]),
            geometry_type=cast(GeometryType, row[2]),
            properties=cast(dict[str, Any], row[3]),
            geometry=cast(dict[str, Any], row[4]),
            bbox=cast(tuple[float, float, float, float], tuple(float(item) for item in row[5])),
            created_by=cast(UUID, row[6]),
            created_at=cast(datetime, row[7]),
            updated_by=cast(UUID, row[8]),
            updated_at=cast(datetime, row[9]),
        )

    @staticmethod
    def _feature_lock(row: tuple[Any, ...]) -> FeatureLockRecord:
        return FeatureLockRecord(
            feature_id=cast(UUID, row[0]),
            feature_version=cast(int, row[1]),
            lock_token=cast(UUID | None, row[2]),
            held_by_current_user=cast(bool, row[3]),
            acquired_at=cast(datetime, row[4]),
            expires_at=cast(datetime, row[5]),
        )

    @staticmethod
    async def _event(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        event_type: str,
        resource_type: str,
        resource_id: UUID,
        request_id: str,
        payload: dict[str, Any],
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.activity_events
              (organization_id, actor_user_id, project_id, event_type,
               resource_type, resource_id, request_id, payload)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                context.organization_id,
                context.user_id,
                project_id,
                event_type,
                resource_type,
                resource_id,
                request_id,
                Jsonb(payload),
            ),
        )


def _require_geometry_type(feature: FeatureDraft, geometry_type: GeometryType) -> None:
    if feature.geometry_type != geometry_type:
        raise FeatureInvalid(
            f"feature geometry type {feature.geometry_type} does not match {geometry_type}"
        )


def _query_predicates(
    steps: tuple[FeatureQueryStep, ...],
    fields: tuple[FeatureField, ...],
) -> tuple[list[str], tuple[Any, ...]]:
    definitions = {field.name: field for field in fields}
    predicates: list[str] = []
    parameters: list[Any] = []
    for step in steps:
        if isinstance(step, TemporalQueryStep):
            if step.field not in {"opengeo_created_at", "opengeo_updated_at"}:
                raise FeatureInvalid("feature temporal query field is invalid")
            if step.begin.tzinfo is None or step.end.tzinfo is None or step.begin >= step.end:
                raise FeatureInvalid("feature temporal query interval is invalid")
            column = "created_at" if step.field == "opengeo_created_at" else "updated_at"
            predicates.append(f"feature.{column} >= %s AND feature.{column} < %s")
            parameters.extend((step.begin, step.end))
            continue
        if isinstance(step, SpatialQueryStep):
            if step.relation not in {"intersects", "within"}:
                raise FeatureInvalid("feature spatial query relation is invalid")
            if (
                isinstance(step.buffer_meters, bool)
                or not isinstance(step.buffer_meters, int | float)
                or not math.isfinite(step.buffer_meters)
                or not 0 <= step.buffer_meters <= 100_000
            ):
                raise FeatureInvalid("feature query buffer must be between 0 and 100000 meters")
            geometry = normalize_query_geometry(step.geometry)
            query_geometry = (
                "ST_Buffer("
                "ST_SetSRID(ST_GeomFromGeoJSON((%s)::jsonb::text), 4326)::geography, %s"
                ")::geometry"
            )
            predicate = (
                "ST_Intersects(feature.geometry, {query})"
                if step.relation == "intersects"
                else "ST_Within(feature.geometry, {query})"
            )
            predicates.append(predicate.format(query=query_geometry))
            parameters.extend((Jsonb(geometry), float(step.buffer_meters)))
            continue

        field = definitions.get(step.field)
        if field is None:
            raise FeatureInvalid("feature query field is not in the collection schema")
        if field.type == "group":
            raise FeatureInvalid("structured feature groups are not top-level query fields")
        operator = step.operator
        if operator == "is_null":
            if step.value is not None:
                raise FeatureInvalid("is_null query value must be null")
            predicates.append(
                "(NOT (feature.properties ? %s) OR feature.properties -> %s = 'null'::jsonb)"
            )
            parameters.extend((field.name, field.name))
            continue
        value = _query_value(step.value, field)
        if field.type == "string":
            if operator not in {"equals", "not_equals", "contains", "starts_with"}:
                raise FeatureInvalid("feature string query operator is invalid")
            expression = "feature.properties ->> %s"
            parameter = str(value)
            if operator in {"contains", "starts_with"}:
                parameter = _like_pattern(parameter, contains=operator == "contains")
                comparator = "LIKE"
            else:
                comparator = "=" if operator == "equals" else "<>"
            if step.case_sensitive:
                predicates.append(
                    f"({expression}) {comparator} %s"
                    + (" ESCAPE '\\\\'" if comparator == "LIKE" else "")
                )
            else:
                predicates.append(
                    f"lower({expression}) {comparator} lower(%s)"
                    + (" ESCAPE '\\\\'" if comparator == "LIKE" else "")
                )
            parameters.extend((field.name, parameter))
            continue
        if step.case_sensitive:
            raise FeatureInvalid("case sensitivity applies only to string queries")
        if field.type == "boolean":
            if operator not in {"equals", "not_equals"}:
                raise FeatureInvalid("feature boolean query operator is invalid")
            comparator = "=" if operator == "equals" else "<>"
            predicates.append(f"(feature.properties ->> %s)::boolean {comparator} %s")
            parameters.extend((field.name, value))
            continue
        if operator not in {
            "equals",
            "not_equals",
            "greater_than",
            "greater_than_or_equal",
            "less_than",
            "less_than_or_equal",
        }:
            raise FeatureInvalid("feature numeric query operator is invalid")
        comparator = {
            "equals": "=",
            "not_equals": "<>",
            "greater_than": ">",
            "greater_than_or_equal": ">=",
            "less_than": "<",
            "less_than_or_equal": "<=",
        }[operator]
        predicates.append(f"(feature.properties ->> %s)::numeric {comparator} %s")
        parameters.extend((field.name, value))
    return predicates, tuple(parameters)


def _query_value(value: Any, field: FeatureField) -> str | int | float | bool:
    if value is None:
        raise FeatureInvalid("feature query value is required")
    if field.type == "string":
        if not isinstance(value, str) or not 1 <= len(value) <= 200:
            raise FeatureInvalid("feature string query value must contain 1 to 200 characters")
        return value
    if field.type == "integer":
        if isinstance(value, bool) or not isinstance(value, int) or abs(value) > _MAX_SAFE_INTEGER:
            raise FeatureInvalid("feature integer query value must be a safe integer")
        return value
    if field.type == "number":
        if (
            isinstance(value, bool)
            or not isinstance(value, int | float)
            or not math.isfinite(value)
        ):
            raise FeatureInvalid("feature number query value must be finite")
        return value
    if not isinstance(value, bool):
        raise FeatureInvalid("feature boolean query value must be boolean")
    return value


def _like_pattern(value: str, *, contains: bool) -> str:
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%" if contains else f"{escaped}%"


def _coordinate_count(value: Any) -> int:
    if not isinstance(value, list):
        return 0
    if len(value) == 2 and all(
        isinstance(item, int | float) and not isinstance(item, bool) for item in value
    ):
        return 1
    return sum(_coordinate_count(item) for item in value)


def feature_field_document(field: FeatureField) -> dict[str, Any]:
    document: dict[str, Any] = {
        "name": field.name,
        "type": field.type,
        "required": field.required,
    }
    if field.label is not None:
        document["label"] = field.label
    if field.description is not None:
        document["description"] = field.description
    if field.choices:
        document["choices"] = list(field.choices)
    if field.minimum is not None:
        document["minimum"] = field.minimum
    if field.maximum is not None:
        document["maximum"] = field.maximum
    if field.min_length is not None:
        document["min_length"] = field.min_length
    if field.max_length is not None:
        document["max_length"] = field.max_length
    if field.attachment:
        document["attachment"] = True
    if field.calculation is not None:
        document["calculation"] = field.calculation
    if field.visible_when is not None:
        document["visible_when"] = {
            "field": field.visible_when.field,
        }
        if field.visible_when.value_field is not None:
            document["visible_when"]["value_field"] = field.visible_when.value_field
        else:
            document["visible_when"]["equals"] = field.visible_when.equals
        if field.visible_when.operator != "eq":
            document["visible_when"]["operator"] = field.visible_when.operator
    if field.type == "group":
        document["fields"] = [feature_field_document(child) for child in field.fields]
        if field.repeat:
            document["repeat"] = True
            document["min_items"] = field.min_items if field.min_items is not None else 0
            document["max_items"] = (
                field.max_items if field.max_items is not None else _MAX_REPEAT_ITEMS
            )
    return document


def _schema_definition(fields: tuple[FeatureField, ...]) -> dict[str, Any]:
    def visit(definitions: tuple[FeatureField, ...]) -> tuple[bool, bool]:
        structured = any(field.type == "group" for field in definitions)
        conditional = any(field.visible_when is not None for field in definitions)
        for field in definitions:
            if field.type == "group":
                child_structured, child_conditional = visit(field.fields)
                structured = structured or child_structured
                conditional = conditional or child_conditional
        return structured, conditional

    def has_comparisons(definitions: tuple[FeatureField, ...]) -> bool:
        return any(
            (
                field.visible_when is not None
                and (
                    field.visible_when.operator != "eq"
                    or field.visible_when.value_field is not None
                )
            )
            or has_comparisons(field.fields)
            for field in definitions
        )

    def has_calculations(definitions: tuple[FeatureField, ...]) -> bool:
        return any(
            field.calculation is not None or has_calculations(field.fields) for field in definitions
        )

    def has_attachments(definitions: tuple[FeatureField, ...]) -> bool:
        return any(field.attachment or has_attachments(field.fields) for field in definitions)

    structured, conditional = visit(fields)
    version = "1.2.0" if structured else "1.1.0" if conditional else "1.0.0"
    return {
        "schemaVersion": (
            "1.5.0"
            if has_attachments(fields)
            else "1.4.0"
            if has_calculations(fields)
            else "1.3.0"
            if has_comparisons(fields)
            else version
        ),
        "fields": [feature_field_document(field) for field in fields],
    }


def _fields_from_schema(value: dict[str, Any]) -> tuple[FeatureField, ...]:
    fields = value.get("fields")
    if not isinstance(fields, list):
        raise FeatureStoreUnavailable("stored feature schema is invalid")
    try:
        return normalize_fields([cast(dict[str, Any], item) for item in fields])
    except (FeatureInvalid, TypeError) as error:
        raise FeatureStoreUnavailable("stored feature schema is invalid") from error


def _canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf8")
