"""One-shot, authority-checked PostGIS preview; feature bytes are never persisted."""

import asyncio
import json
import re
from collections.abc import Mapping
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol
from uuid import UUID, uuid4

from opengeo_api.connection_verification import (
    AddressResolver,
    PostgreSqlCredentials,
    PostgreSqlVerificationTarget,
    SystemAddressResolver,
    public_connection_address,
    verified_postgresql_connection,
)
from opengeo_api.connection_verification_runtime import (
    AwsConnectionVerificationSecretLoader,
    VerificationCommandInvalid,
    VerificationDataApi,
    VerificationDependencyUnavailable,
    VerificationSecretLoader,
    VerifierRuntimeSettings,
    _bounded_port,
    _bounded_string,
    _positive_int,
    _uuid,
)
from opengeo_api.postgis_catalog import CatalogFailure, _schemas
from opengeo_api.postgis_preview import (
    MAX_FEATURES,
    MAX_RESPONSE_BYTES,
    PreviewFailure,
    PreviewFeatures,
    PreviewSelection,
    preview_bbox,
    read_bounded_features,
)
from opengeo_api.rds_data import RdsDataApiClient, RdsDataApiUnavailable

COMMAND_SCHEMA = "opengeo.postgis-preview.command.v1"
RESPONSE_SCHEMA = "opengeo.postgis-preview.1.0.0"
ERROR_SCHEMA = "opengeo.postgis-preview.error.1.0.0"


@dataclass(frozen=True, slots=True)
class PreviewCommand:
    preview_id: UUID


@dataclass(frozen=True, slots=True, repr=False)
class PreviewClaim:
    preview_id: UUID
    organization_id: UUID
    project_id: UUID
    dataset_id: UUID
    source_version: int
    connection_id: UUID
    connection_revision: int
    endpoint_host: str
    endpoint_port: int
    database_name: str
    allowed_schemas: tuple[str, ...]
    tls_mode: str
    network_mode: str
    secret_reference: str
    selection: PreviewSelection
    bbox: tuple[float, float, float, float]


class PreviewCoordinator(Protocol):
    async def claim(
        self, preview_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> PreviewClaim | None: ...

    async def complete(
        self,
        preview_id: UUID,
        worker_token: UUID,
        returned: int | None,
        truncated: bool | None,
        error_code: str | None,
    ) -> bool: ...


class PreviewReader(Protocol):
    async def preview(
        self, claim: PreviewClaim, credentials: PostgreSqlCredentials
    ) -> PreviewFeatures: ...


def _selection(configuration: object, connection: UUID, revision: int) -> PreviewSelection:
    keys = {
        "service_kind",
        "connection_id",
        "connection_revision_number",
        "catalog_discovery_id",
        "catalog_relation_ordinal",
        "schema_name",
        "relation_name",
        "schema_fingerprint_sha256",
        "geometry_column",
        "stable_key",
    }
    if isinstance(configuration, str):
        if len(configuration.encode()) > 16_384:
            raise ValueError
        configuration = json.loads(configuration)
    if not isinstance(configuration, dict) or set(configuration) != keys:
        raise ValueError
    if (
        configuration["service_kind"] != "postgis"
        or _uuid(configuration["connection_id"]) != connection
        or _positive_int(configuration["connection_revision_number"]) != revision
        or not re.fullmatch(r"[a-f0-9]{64}", configuration["schema_fingerprint_sha256"])
    ):
        raise ValueError
    _uuid(configuration["catalog_discovery_id"])
    _positive_int(configuration["catalog_relation_ordinal"])
    names = tuple(
        _bounded_string(configuration[key], 63)
        for key in ("schema_name", "relation_name", "geometry_column", "stable_key")
    )
    if any("\x00" in value or len(value.encode()) > 63 for value in names):
        raise ValueError
    return PreviewSelection(
        names[0], names[1], names[2], names[3], configuration["schema_fingerprint_sha256"]
    )


class RdsDataPreviewCoordinator:
    def __init__(self, client: VerificationDataApi) -> None:
        self._client = client

    async def claim(
        self, preview_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> PreviewClaim | None:
        try:
            result = await self._client.execute(
                """SELECT claim_status,preview_id,organization_id,project_id,dataset_id,
                          source_version,connection_id,connection_revision_number,provider,
                          endpoint_host,endpoint_port,database_name,allowed_schemas,
                          tls_mode,network_mode,secret_arn,source_configuration,bbox
                   FROM app.claim_external_postgis_preview(%s,%s,%s)""",
                (preview_id, worker_token, lease_seconds),
            )
            if len(result.records) != 1 or len(result.records[0]) != 18:
                raise ValueError
            row = result.records[0]
            if row[0] not in {
                "claimed",
                "not_found",
                "already_running",
                "already_completed",
                "already_failed",
                "already_cancelled",
                "not_previewable",
            }:
                raise ValueError
            if row[0] != "claimed":
                return None
            schemas = row[12]
            if not isinstance(schemas, list | tuple) or not 1 <= len(schemas) <= 16:
                raise ValueError
            connection, revision = _uuid(row[6]), _positive_int(row[7])
            bbox = json.loads(row[17]) if isinstance(row[17], str) else row[17]
            claim = PreviewClaim(
                _uuid(row[1]),
                _uuid(row[2]),
                _uuid(row[3]),
                _uuid(row[4]),
                _positive_int(row[5]),
                connection,
                revision,
                _bounded_string(row[9], 253),
                _bounded_port(row[10]),
                _bounded_string(row[11], 63),
                tuple(_bounded_string(s, 63) for s in schemas),
                _bounded_string(row[13], 32),
                _bounded_string(row[14], 32),
                _bounded_string(row[15], 512),
                _selection(row[16], connection, revision),
                preview_bbox(bbox),
            )
            if claim.preview_id != preview_id or row[8] != "postgresql":
                raise ValueError
            if (
                claim.tls_mode != "verify_full"
                or claim.network_mode != "public_internet"
                or claim.selection.schema_name not in _schemas(claim.allowed_schemas)
            ):
                raise ValueError
            return claim
        except (RdsDataApiUnavailable, ValueError, TypeError, PreviewFailure, CatalogFailure):
            raise VerificationDependencyUnavailable("PostGIS preview claim unavailable") from None

    async def complete(
        self,
        preview_id: UUID,
        worker_token: UUID,
        returned: int | None,
        truncated: bool | None,
        error_code: str | None,
    ) -> bool:
        try:
            result = await self._client.execute(
                "SELECT app.complete_external_postgis_preview(%s,%s,%s,%s,%s)",
                (preview_id, worker_token, returned, truncated, error_code),
            )
            if len(result.records) != 1 or result.records[0] not in {(True,), (False,)}:
                raise ValueError
            return result.records[0][0]
        except (RdsDataApiUnavailable, ValueError, TypeError):
            raise VerificationDependencyUnavailable(
                "PostGIS preview completion unavailable"
            ) from None


class PostgreSqlPreviewReader:
    def __init__(self, *, resolver: AddressResolver | None = None) -> None:
        self._resolver = resolver or SystemAddressResolver()

    async def preview(
        self, claim: PreviewClaim, credentials: PostgreSqlCredentials
    ) -> PreviewFeatures:
        if claim.tls_mode != "verify_full" or claim.network_mode != "public_internet":
            raise PreviewFailure("preview_failed")
        target = PostgreSqlVerificationTarget(
            claim.endpoint_host,
            claim.endpoint_port,
            claim.database_name,
            claim.tls_mode,
            claim.network_mode,
        )
        try:
            addresses = await self._resolver.resolve(target.host, target.port)
            if (
                not addresses
                or len(addresses) > 8
                or any(not public_connection_address(address) for address in addresses)
            ):
                raise PreviewFailure("preview_failed")
            async with verified_postgresql_connection(
                target, credentials, addresses[0]
            ) as connection:
                return await read_bounded_features(
                    connection,
                    claim.selection,
                    claim.allowed_schemas,
                    claim.bbox,
                    cursor_name=f"opengeo_preview_{claim.preview_id.hex}",
                )
        except PreviewFailure:
            raise
        except TimeoutError:
            raise PreviewFailure("preview_timeout") from None
        except Exception as error:
            if getattr(error, "sqlstate", None) == "57014":
                raise PreviewFailure("preview_timeout") from None
            raise PreviewFailure("preview_failed") from None


def error_response(preview_id: UUID, code: str) -> dict[str, Any]:
    return {
        "schemaVersion": ERROR_SCHEMA,
        "previewId": str(preview_id),
        "code": PreviewFailure(code).code,
    }


class PreviewProcessor:
    def __init__(
        self,
        coordinator: PreviewCoordinator,
        secret_loader: VerificationSecretLoader,
        reader: PreviewReader,
    ) -> None:
        self._coordinator = coordinator
        self._secret_loader = secret_loader
        self._reader = reader

    async def process(self, command: PreviewCommand) -> dict[str, Any]:
        token = uuid4()
        try:
            claim = await self._coordinator.claim(command.preview_id, token, 20)
        except VerificationDependencyUnavailable:
            return error_response(command.preview_id, "preview_unavailable")
        if claim is None:
            return error_response(command.preview_id, "preview_unavailable")
        try:
            # This is the full credential/read/serialization budget, not per-query.
            async with asyncio.timeout(10):
                credentials = await self._secret_loader.load(claim.secret_reference)
                try:
                    features = await self._reader.preview(claim, credentials)
                finally:
                    del credentials
                response: dict[str, Any] = {
                    "schemaVersion": RESPONSE_SCHEMA,
                    "previewId": str(claim.preview_id),
                    "datasetId": str(claim.dataset_id),
                    "sourceVersion": claim.source_version,
                    "connectionRevision": claim.connection_revision,
                    "schemaFingerprint": claim.selection.schema_fingerprint,
                    "observedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                    "bbox": list(claim.bbox),
                    "limit": MAX_FEATURES,
                    "returned": len(features.geojson["features"]),
                    "truncated": features.truncated,
                    "geojson": features.geojson,
                    "propertyEncodings": features.property_encodings,
                }
                # Bound even the standard ASCII-escaped, spaced Lambda encoding.
                if len(json.dumps(response, allow_nan=False).encode()) > MAX_RESPONSE_BYTES:
                    raise PreviewFailure("preview_limits_exceeded")
        except asyncio.CancelledError:
            # A cancelled ID is never requeued or retried against the provider.
            with suppress(Exception):
                await asyncio.shield(
                    self._coordinator.complete(
                        claim.preview_id, token, None, None, "preview_failed"
                    )
                )
            raise
        except Exception as error:
            code = (
                "preview_timeout"
                if isinstance(error, TimeoutError)
                else error.code
                if isinstance(error, PreviewFailure)
                else "preview_failed"
            )
            with suppress(VerificationDependencyUnavailable):
                await self._coordinator.complete(claim.preview_id, token, None, None, code)
            return error_response(claim.preview_id, code)
        try:
            # Feature bytes escape only after the final authority/revision check.
            accepted = await self._coordinator.complete(
                claim.preview_id, token, response["returned"], response["truncated"], None
            )
        except VerificationDependencyUnavailable:
            accepted = False
        if not accepted:
            return error_response(claim.preview_id, "preview_stale")
        return response


def parse_preview_command(event: Mapping[str, Any]) -> PreviewCommand:
    try:
        if (
            set(event) != {"schema", "preview_id"}
            or event["schema"] != COMMAND_SCHEMA
            or len(json.dumps(dict(event)).encode()) > 512
        ):
            raise ValueError
        return PreviewCommand(_uuid(event["preview_id"]))
    except (TypeError, ValueError, UnicodeError):
        raise VerificationCommandInvalid("postgis_preview_command_invalid") from None


_DEFAULT_PROCESSOR: PreviewProcessor | None = None


def default_processor() -> PreviewProcessor:
    global _DEFAULT_PROCESSOR
    if _DEFAULT_PROCESSOR is None:
        runtime = VerifierRuntimeSettings.from_environment()
        _DEFAULT_PROCESSOR = PreviewProcessor(
            RdsDataPreviewCoordinator(RdsDataApiClient(runtime.data_api_settings())),
            AwsConnectionVerificationSecretLoader(runtime),
            PostgreSqlPreviewReader(),
        )
    return _DEFAULT_PROCESSOR


def handler(event: Mapping[str, Any], context: object) -> dict[str, Any]:
    del context
    command = parse_preview_command(event)
    return asyncio.run(default_processor().process(command))
