"""Selected private PostGIS Layer registration and transient preview transport.

Only the fixed registration function creates a credentialed source binding.
Preview leases retain metadata; feature bytes stay in this request's memory.
"""

import asyncio
import json
import math
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol, cast
from urllib.parse import quote
from uuid import UUID

from psycopg.types.json import Jsonb

from opengeo_api.cognito_provisioning import (
    AwsCredentialProvider,
    CredentialProvider,
    IdentityProvisioningUnavailable,
)
from opengeo_api.config import Settings
from opengeo_api.connections import ConnectionAccessDenied, ExternalConnectionRepository
from opengeo_api.external_sources import (
    ExternalSourceAccessDenied,
    ExternalSourceConflict,
    ExternalSourceNotFound,
    ExternalSourceStoreUnavailable,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)
from opengeo_api.user_dataset_verification_runtime import (
    AwsJsonTransport,
    DatasetVerificationDependencyUnavailable,
    UrlAwsTransport,
    _signed_headers,
)

PREVIEW_SCHEMA = "opengeo.postgis-preview.1.0.0"
PREVIEW_ERROR_SCHEMA = "opengeo.postgis-preview.error.1.0.0"
MAX_PREVIEW_BYTES = 262_144
PREVIEW_ERRORS = frozenset({
    "preview_unavailable", "preview_stale", "preview_failed", "preview_timeout",
    "preview_limits_exceeded", "preview_schema_changed",
    "preview_representation_unsupported", "preview_geometry_unsupported", "preview_row_too_large",
})


class PostgisPreviewUnavailable(RuntimeError):
    pass


class PostgisPreviewFailure(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class PostgisLayerSelection:
    expected_connection_revision: int
    schema_fingerprint_sha256: str
    geometry_column: str
    name: str
    description: str | None
    expected_source_version: int | None
    request_key: UUID


@dataclass(frozen=True, slots=True)
class RegisteredPostgisLayer:
    dataset_id: UUID
    source_version: int
    created: bool


@dataclass(frozen=True, slots=True)
class PostgisPreviewLease:
    preview_id: UUID
    state: str


class PostgisLayerRepository(Protocol):
    async def register(
        self, context: TenantContext, project: UUID, connection: UUID,
        discovery: UUID, ordinal: int, selection: PostgisLayerSelection,
    ) -> RegisteredPostgisLayer: ...

    async def prepare_preview(
        self, context: TenantContext, dataset: UUID, expected_source_version: int,
        request_key: UUID, bbox: tuple[float, float, float, float],
    ) -> PostgisPreviewLease: ...


class PostgresPostgisLayerRepository:
    def __init__(
        self, executor: TenantTransactionExecutor, connections: ExternalConnectionRepository
    ) -> None:
        self._executor = executor
        self._connections = connections

    async def _run[T](
        self, context: TenantContext, operation: Callable[[TenantTransaction], Awaitable[T]]
    ) -> T:
        try:
            return await self._executor.run(context, operation)
        except TenantDatabaseConflict as error:
            raise ExternalSourceConflict("postgis_source_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise ExternalSourceStoreUnavailable("postgis source unavailable") from error

    async def register(
        self, context: TenantContext, project: UUID, connection: UUID,
        discovery: UUID, ordinal: int, selection: PostgisLayerSelection,
    ) -> RegisteredPostgisLayer:
        # This also binds the requested project/connection before the fixed SQL
        # function independently checks both source-create and manage authority.
        record = await self._connections.get_connection(context, project, connection)
        if not record.capabilities.manage:
            raise ConnectionAccessDenied("action forbidden")

        async def operation(tx: TenantTransaction) -> RegisteredPostgisLayer:
            row = await tx.fetch_one(
                """SELECT dataset_id, source_version, created
                   FROM app.register_external_postgis_layer(
                     %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (connection, discovery, ordinal, selection.expected_connection_revision,
                 selection.schema_fingerprint_sha256, selection.geometry_column,
                 selection.name, selection.description, selection.expected_source_version,
                 selection.request_key),
            )
            if row is None:
                raise ExternalSourceConflict("postgis_source_conflict")
            return RegisteredPostgisLayer(UUID(str(row[0])), cast(int, row[1]), cast(bool, row[2]))

        return await self._run(context, operation)

    async def prepare_preview(
        self, context: TenantContext, dataset: UUID, expected_source_version: int,
        request_key: UUID, bbox: tuple[float, float, float, float],
    ) -> PostgisPreviewLease:
        async def operation(tx: TenantTransaction) -> PostgisPreviewLease:
            # Read a Layer using Layer authority. A viewer does not need access
            # to the connection-management screen or its credential metadata.
            row = await tx.fetch_one(
                """SELECT dataset.source_type::text, dataset.status::text,
                     membership.role = 'admin' OR dataset.owner_user_id = %s OR EXISTS (
                       SELECT 1 FROM app.dataset_permissions permission
                       WHERE permission.organization_id = dataset.organization_id
                         AND permission.dataset_id = dataset.id AND permission.user_id = %s
                         AND permission.role IN ('manage', 'edit', 'view', 'download')
                     ) OR EXISTS (
                       SELECT 1 FROM app.project_datasets link
                       JOIN app.projects project ON project.organization_id=link.organization_id
                         AND project.id=link.project_id AND project.status='active'
                       WHERE link.organization_id=dataset.organization_id
                         AND link.dataset_id=dataset.id
                         AND app.effective_project_role(project.id) IS NOT NULL
                     ) AS can_read
                   FROM app.datasets dataset
                   JOIN app.organizations organization ON organization.id=dataset.organization_id
                     AND organization.status='active'
                   JOIN app.organization_memberships membership
                     ON membership.organization_id=dataset.organization_id AND membership.user_id=%s
                   WHERE dataset.organization_id=%s AND dataset.id=%s""",
                (context.user_id, context.user_id, context.user_id,
                 context.organization_id, dataset),
            )
            if row is None:
                raise ExternalSourceNotFound("dataset")
            if row[2] is not True:
                raise ExternalSourceAccessDenied("action forbidden")
            if row[0] != "postgis" or row[1] != "active":
                raise ExternalSourceConflict("postgis_preview_source_unavailable")
            lease = await tx.fetch_one(
                """SELECT preview_id, state FROM app.prepare_external_postgis_preview(
                     %s, %s, %s, %s)""",
                (dataset, expected_source_version, request_key, Jsonb(list(bbox))),
            )
            if lease is None:
                raise ExternalSourceConflict("postgis_preview_conflict")
            return PostgisPreviewLease(UUID(str(lease[0])), cast(str, lease[1]))

        return await self._run(context, operation)


class PostgisPreviewClient(Protocol):
    @property
    def available(self) -> bool: ...

    async def preview(
        self, preview_id: UUID, dataset: UUID, source_version: int,
        bbox: tuple[float, float, float, float],
    ) -> dict[str, Any]: ...


class UnavailablePostgisPreviewClient:
    available = False

    async def preview(
        self, preview_id: UUID, dataset: UUID, source_version: int,
        bbox: tuple[float, float, float, float],
    ) -> dict[str, Any]:
        del preview_id, dataset, source_version, bbox
        raise PostgisPreviewUnavailable("postgis preview is not configured")


class AwsLambdaPostgisPreviewClient:
    available = True

    def __init__(
        self, settings: Settings, credentials: CredentialProvider | None = None,
        transport: AwsJsonTransport | None = None, now: Callable[[], datetime] | None = None,
    ) -> None:
        if not (settings.connection_postgis_preview_enabled and settings.aws_region
                and settings.connection_verification_function_name):
            raise ValueError("postgis preview is not configured")
        self._region = settings.aws_region
        self._function_name = settings.connection_verification_function_name
        self._credentials = credentials or AwsCredentialProvider()
        self._transport = transport or UrlAwsTransport()
        self._now = now or (lambda: datetime.now(UTC))

    async def preview(
        self, preview_id: UUID, dataset: UUID, source_version: int,
        bbox: tuple[float, float, float, float],
    ) -> dict[str, Any]:
        envelope = await asyncio.to_thread(self._invoke, preview_id)
        return validate_postgis_preview(envelope, preview_id, dataset, source_version, bbox)

    def _invoke(self, preview_id: UUID) -> dict[str, Any]:
        # No connection, account, SQL, secret or source configuration is accepted
        # at this boundary. The connector resolves a currently authorized lease.
        body = json.dumps({"schema": "opengeo.postgis-preview.command.v1",
                           "preview_id": str(preview_id)}, separators=(",", ":")).encode()
        host = f"lambda.{self._region}.amazonaws.com"
        path = "/2015-03-31/functions/" + quote(self._function_name, safe="-_.~") + "/invocations"
        try:
            headers = _signed_headers(
                method="POST", canonical_uri=path, canonical_query="", host=host,
                region=self._region, service="lambda", credentials=self._credentials.load(),
                body=body, now=self._now(), extra_headers={"content-type": "application/json"},
            )
            status, response_headers, response_body = self._transport.call(
                "POST", f"https://{host}{path}", headers, body, 12.0, MAX_PREVIEW_BYTES
            )
        except (IdentityProvisioningUnavailable, DatasetVerificationDependencyUnavailable,
                TimeoutError) as error:
            raise PostgisPreviewUnavailable("postgis preview unavailable") from error
        if (status != 200 or len(response_body) > MAX_PREVIEW_BYTES
                or "x-amz-function-error" in {key.lower() for key in response_headers}):
            raise PostgisPreviewUnavailable("postgis preview unavailable")
        try:
            envelope = json.loads(response_body)
        except (ValueError, TypeError, RecursionError) as error:
            raise PostgisPreviewUnavailable("postgis preview response invalid") from error
        if not isinstance(envelope, dict):
            raise PostgisPreviewUnavailable("postgis preview response invalid")
        return envelope


def create_postgis_preview_client(settings: Settings) -> PostgisPreviewClient:
    if (settings.connection_postgis_preview_enabled and settings.aws_region
            and settings.connection_verification_function_name):
        return AwsLambdaPostgisPreviewClient(settings)
    return UnavailablePostgisPreviewClient()


def validate_postgis_preview(
    envelope: Mapping[str, Any], preview_id: UUID, dataset: UUID, source_version: int,
    bbox: tuple[float, float, float, float],
) -> dict[str, Any]:
    """Fail closed before handing untrusted runtime bytes to a map renderer."""
    invalid = PostgisPreviewUnavailable("postgis preview response invalid")
    try:
        encoded = json.dumps(envelope, ensure_ascii=False, allow_nan=False,
                             separators=(",", ":")).encode()
        if len(encoded) > MAX_PREVIEW_BYTES:
            raise invalid
    except (ValueError, TypeError, RecursionError, UnicodeError) as error:
        raise invalid from error
    if envelope.get("schemaVersion") == PREVIEW_ERROR_SCHEMA:
        if (set(envelope) != {"schemaVersion", "previewId", "code"}
                or envelope.get("previewId") != str(preview_id)
                or not isinstance(envelope.get("code"), str)
                or envelope.get("code") not in PREVIEW_ERRORS):
            raise invalid
        raise PostgisPreviewFailure(envelope["code"])
    if (set(envelope) != {
        "schemaVersion", "previewId", "datasetId", "sourceVersion", "connectionRevision",
        "schemaFingerprint", "observedAt", "bbox", "limit", "returned", "truncated",
        "geojson", "propertyEncodings",
    } or envelope.get("schemaVersion") != PREVIEW_SCHEMA
            or envelope.get("previewId") != str(preview_id)
            or envelope.get("datasetId") != str(dataset)
            or type(envelope.get("sourceVersion")) is not int
            or envelope.get("sourceVersion") != source_version
            or type(envelope.get("connectionRevision")) is not int
            or envelope["connectionRevision"] < 1
            or not isinstance(envelope.get("schemaFingerprint"), str)
            or re.fullmatch(r"[0-9a-f]{64}", envelope["schemaFingerprint"]) is None
            or not isinstance(envelope.get("observedAt"), str)
            or not isinstance(envelope.get("bbox"), list)
            or any(not _finite_number(c) for c in envelope["bbox"])
            or envelope.get("bbox") != list(bbox)
            or type(envelope.get("limit")) is not int or envelope["limit"] != 100
            or type(envelope.get("returned")) is not int or not 0 <= envelope["returned"] <= 100
            or type(envelope.get("truncated")) is not bool):
        raise invalid
    try:
        observed = datetime.fromisoformat(envelope["observedAt"].replace("Z", "+00:00"))
        if observed.tzinfo is None:
            raise ValueError("timezone required")
    except ValueError as error:
        raise invalid from error
    encodings = envelope["propertyEncodings"]
    geojson = envelope["geojson"]
    if (not isinstance(encodings, dict)
            or any(not isinstance(k, str) or not isinstance(v, str)
                   or v not in {"int64:string", "numeric:string"}
                   for k, v in encodings.items())
            or not isinstance(geojson, dict) or set(geojson) != {"type", "features"}
            or geojson["type"] != "FeatureCollection" or not isinstance(geojson["features"], list)
            or len(geojson["features"]) != envelope["returned"]):
        raise invalid
    positions = [0]
    ids: set[str] = set()
    for feature in geojson["features"]:
        if (not isinstance(feature, dict)
                or set(feature) != {"type", "id", "properties", "geometry"}
                or feature["type"] != "Feature" or not isinstance(feature["id"], str)
                or feature["id"] in ids
                or not isinstance(feature["properties"], dict)):
            raise invalid
        ids.add(feature["id"])
        for key, value in feature["properties"].items():
            if (not isinstance(key, str) or not _scalar(value)
                    or (key in encodings and value is not None and not isinstance(value, str))):
                raise invalid
            if key in encodings and value is not None:
                pattern = (r"-?\d+" if encodings[key] == "int64:string"
                           else r"-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?")
                if re.fullmatch(pattern, value) is None:
                    raise invalid
        _geometry(feature["geometry"], positions, invalid)
    return dict(envelope)


def _scalar(value: Any) -> bool:
    return (value is None or type(value) in {str, bool}
            or (type(value) is int and abs(value) <= 9_007_199_254_740_991)
            or (type(value) is float and math.isfinite(value)))


def _finite_number(value: Any) -> bool:
    if type(value) not in {int, float}:
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _geometry(value: Any, positions: list[int], invalid: Exception) -> None:
    if not isinstance(value, dict) or set(value) != {"type", "coordinates"}:
        raise invalid
    dimensions = {"Point": 0, "MultiPoint": 1, "LineString": 1,
                  "MultiLineString": 2, "Polygon": 2, "MultiPolygon": 3}
    kind = value.get("type")
    if not isinstance(kind, str) or kind not in dimensions:
        raise invalid

    def walk(coordinates: Any, depth: int) -> None:
        if not isinstance(coordinates, list) or not coordinates:
            raise invalid
        if depth:
            for nested in coordinates:
                walk(nested, depth - 1)
            return
        if (len(coordinates) != 2 or any(not _finite_number(v) for v in coordinates)
                or not -180 <= coordinates[0] <= 180 or not -90 <= coordinates[1] <= 90):
            raise invalid
        positions[0] += 1
        if positions[0] > 10_000:
            raise invalid

    walk(value["coordinates"], dimensions[kind])
