"""Isolated, function-coordinated PostGIS metadata jobs; no feature execution."""

import asyncio
import json
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from typing import Any, Protocol, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.connection_verification import (
    AddressResolver,
    PostgreSqlCredentials,
    PostgreSqlVerificationTarget,
    SystemAddressResolver,
    VerificationFailure,
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
from opengeo_api.postgis_catalog import CatalogFailure, CatalogLimits, discover_postgis_catalog
from opengeo_api.rds_data import RdsDataApiClient, RdsDataApiUnavailable

COMMAND_SCHEMA = "opengeo.connection-catalog-discovery.command.v1"
_SAFE_CATALOG_CODES = {
    "catalog_timeout",
    "catalog_limits_invalid",
    "catalog_description_invalid",
    "catalog_metadata_limit_exceeded",
    "catalog_description_failed",
    "catalog_descriptor_limit_exceeded",
    "catalog_cancelled",
    "catalog_failed",
}
_SAFE_VERIFICATION_CODES = {
    "credentials_rejected",
    "dns_resolution_failed",
    "postgis_required",
    "tls_verification_failed",
    "unsafe_network_target",
    "verification_cancelled",
    "verification_failed",
    "verification_timeout",
}


class CatalogDiscoveryFailure(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = (
            code
            if code in _SAFE_CATALOG_CODES | _SAFE_VERIFICATION_CODES
            else "catalog_description_failed"
        )
        super().__init__(self.code)


@dataclass(frozen=True, slots=True)
class CatalogDiscoveryCommand:
    discovery_id: UUID


@dataclass(frozen=True, slots=True, repr=False)
class CatalogDiscoveryClaim:
    discovery_id: UUID
    organization_id: UUID
    project_id: UUID
    connection_id: UUID
    connection_revision_number: int
    endpoint_host: str
    endpoint_port: int
    database_name: str
    allowed_schemas: tuple[str, ...]
    tls_mode: str
    network_mode: str
    secret_reference: str


class CatalogDiscoveryCoordinator(Protocol):
    async def claim(
        self, discovery_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> CatalogDiscoveryClaim | None: ...

    async def complete(
        self,
        discovery_id: UUID,
        worker_token: UUID,
        catalog: dict[str, Any] | None,
        error_code: str | None,
    ) -> bool: ...

    async def release(self, discovery_id: UUID, worker_token: UUID, max_attempts: int) -> str: ...


class CatalogReader(Protocol):
    async def discover(
        self, claim: CatalogDiscoveryClaim, credentials: PostgreSqlCredentials
    ) -> dict[str, Any]: ...


class RdsDataCatalogDiscoveryCoordinator:
    def __init__(self, client: VerificationDataApi) -> None:
        self._client = client

    async def claim(
        self, discovery_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> CatalogDiscoveryClaim | None:
        try:
            result = await self._client.execute(
                """SELECT claim_status, discovery_id, organization_id, project_id,
                          connection_id, connection_revision_number, provider,
                          endpoint_host, endpoint_port, database_name, allowed_schemas,
                          tls_mode, network_mode, secret_arn, attempt_count
                   FROM app.claim_external_connection_catalog_discovery(%s, %s, %s)""",
                (discovery_id, worker_token, lease_seconds),
            )
            if len(result.records) != 1 or len(result.records[0]) != 15:
                raise ValueError
            row = result.records[0]
            if row[0] not in {
                "claimed",
                "not_found",
                "already_completed",
                "already_failed",
                "already_cancelled",
                "busy",
                "not_discoverable",
                "attempts_exhausted",
            }:
                raise ValueError
            if row[0] != "claimed":
                return None
            schemas = row[10]
            if not isinstance(schemas, list | tuple) or not 1 <= len(schemas) <= 16:
                raise ValueError
            claim = CatalogDiscoveryClaim(
                _uuid(row[1]),
                _uuid(row[2]),
                _uuid(row[3]),
                _uuid(row[4]),
                _positive_int(row[5]),
                _bounded_string(row[7], 253),
                _bounded_port(row[8]),
                _bounded_string(row[9], 63),
                tuple(_bounded_string(s, 63) for s in schemas),
                _bounded_string(row[11], 32),
                _bounded_string(row[12], 32),
                _bounded_string(row[13], 512),
            )
            _positive_int(row[14])
            if claim.discovery_id != discovery_id or row[6] != "postgresql":
                raise ValueError
            return claim
        except (RdsDataApiUnavailable, ValueError, TypeError):
            raise VerificationDependencyUnavailable("catalog discovery claim unavailable") from None

    async def complete(
        self,
        discovery_id: UUID,
        worker_token: UUID,
        catalog: dict[str, Any] | None,
        error_code: str | None,
    ) -> bool:
        try:
            result = await self._client.execute(
                "SELECT app.complete_external_connection_catalog_discovery(%s, %s, %s, %s)",
                (
                    discovery_id,
                    worker_token,
                    Jsonb(catalog) if catalog is not None else None,
                    error_code,
                ),
            )
        except RdsDataApiUnavailable:
            raise VerificationDependencyUnavailable(
                "catalog discovery completion unavailable"
            ) from None
        if len(result.records) != 1 or result.records[0] not in {(True,), (False,)}:
            raise VerificationDependencyUnavailable("catalog discovery completion invalid")
        return result.records[0][0]

    async def release(self, discovery_id: UUID, worker_token: UUID, max_attempts: int) -> str:
        try:
            result = await self._client.execute(
                "SELECT app.release_external_connection_catalog_discovery(%s, %s, %s)",
                (discovery_id, worker_token, max_attempts),
            )
        except RdsDataApiUnavailable:
            raise VerificationDependencyUnavailable(
                "catalog discovery release unavailable"
            ) from None
        if (
            len(result.records) != 1
            or len(result.records[0]) != 1
            or result.records[0][0] not in {"queued", "failed", "lost"}
        ):
            raise VerificationDependencyUnavailable("catalog discovery release invalid")
        return cast(str, result.records[0][0])


class PostgreSqlCatalogReader:
    def __init__(self, *, resolver: AddressResolver | None = None) -> None:
        self._resolver = resolver or SystemAddressResolver()

    async def discover(
        self, claim: CatalogDiscoveryClaim, credentials: PostgreSqlCredentials
    ) -> dict[str, Any]:
        if claim.tls_mode != "verify_full" or claim.network_mode != "public_internet":
            raise CatalogDiscoveryFailure("verification_failed")
        target = PostgreSqlVerificationTarget(
            claim.endpoint_host,
            claim.endpoint_port,
            claim.database_name,
            claim.tls_mode,
            claim.network_mode,
        )
        try:
            async with asyncio.timeout(12):
                addresses = await self._resolver.resolve(target.host, target.port)
                if (
                    not addresses
                    or len(addresses) > 8
                    or any(not public_connection_address(a) for a in addresses)
                ):
                    raise CatalogDiscoveryFailure("unsafe_network_target")
                async with verified_postgresql_connection(
                    target, credentials, addresses[0]
                ) as connection:
                    async with connection.cursor() as cursor:
                        description = await discover_postgis_catalog(
                            cursor,
                            allowed_schemas=claim.allowed_schemas,
                            limits=CatalogLimits(max_columns=64),
                        )
                    relations = []
                    for relation in description.relations:
                        descriptor = {
                            **asdict(relation),
                            "schema_fingerprint_sha256": relation.schema_fingerprint_sha256,
                        }
                        if (
                            len(
                                json.dumps(
                                    descriptor, separators=(",", ":"), ensure_ascii=False
                                ).encode()
                            )
                            > 49_152
                        ):
                            raise CatalogDiscoveryFailure("catalog_descriptor_limit_exceeded")
                        relations.append(descriptor)
                    catalog = {
                        "schemaVersion": "opengeo.postgis-catalog.1.0.0",
                        "relations": relations,
                        "truncated": description.truncated,
                    }
                    if (
                        len(json.dumps(catalog, separators=(",", ":"), ensure_ascii=False).encode())
                        > 1_048_576
                    ):
                        raise CatalogDiscoveryFailure("catalog_metadata_limit_exceeded")
                    return catalog
        except CatalogDiscoveryFailure:
            raise
        except (CatalogFailure, VerificationFailure) as error:
            raise CatalogDiscoveryFailure(error.code) from None
        except TimeoutError:
            raise CatalogDiscoveryFailure("catalog_timeout") from None
        except Exception:
            raise CatalogDiscoveryFailure("catalog_description_failed") from None


class CatalogDiscoveryProcessor:
    def __init__(
        self,
        coordinator: CatalogDiscoveryCoordinator,
        secret_loader: VerificationSecretLoader,
        reader: CatalogReader,
        *,
        lease_seconds: int = 20,
    ) -> None:
        if not 15 <= lease_seconds <= 60:
            raise ValueError("catalog discovery lease must be 15 through 60 seconds")
        self._coordinator = coordinator
        self._secret_loader = secret_loader
        self._reader = reader
        self._lease_seconds = lease_seconds

    async def process(self, command: CatalogDiscoveryCommand) -> bool:
        token = uuid4()
        claim = await self._coordinator.claim(command.discovery_id, token, self._lease_seconds)
        if claim is None:
            return False
        try:
            catalog = None
            error_code = None
            try:
                async with asyncio.timeout(12):
                    credentials = await self._secret_loader.load(claim.secret_reference)
                    try:
                        catalog = await self._reader.discover(claim, credentials)
                    finally:
                        del credentials
            except CatalogDiscoveryFailure as error:
                error_code = error.code
            except TimeoutError:
                error_code = "catalog_timeout"
            return await self._coordinator.complete(claim.discovery_id, token, catalog, error_code)
        except asyncio.CancelledError:
            await self._coordinator.release(claim.discovery_id, token, 3)
            raise
        except Exception:
            release = await self._coordinator.release(claim.discovery_id, token, 3)
            if release in {"failed", "lost"}:
                return False
            raise VerificationDependencyUnavailable(
                "catalog discovery dependency unavailable"
            ) from None


def parse_catalog_discovery_command(body: str) -> CatalogDiscoveryCommand:
    try:
        if len(body.encode()) > 512:
            raise ValueError
        payload = json.loads(body)
        if (
            not isinstance(payload, dict)
            or set(payload) != {"schema", "discovery_id"}
            or payload["schema"] != COMMAND_SCHEMA
        ):
            raise ValueError
        return CatalogDiscoveryCommand(_uuid(payload["discovery_id"]))
    except (ValueError, TypeError, UnicodeError):
        raise VerificationCommandInvalid("catalog_discovery_command_invalid") from None


async def handle_sqs_event(
    event: Mapping[str, Any], processor: CatalogDiscoveryProcessor
) -> dict[str, list[dict[str, str]]]:
    records = event.get("Records")
    if not isinstance(records, list) or not 1 <= len(records) <= 10:
        raise VerificationCommandInvalid("catalog_discovery_event_invalid")
    failures = []
    for record in records:
        message_id = record.get("messageId") if isinstance(record, dict) else None
        body = record.get("body") if isinstance(record, dict) else None
        if (
            not isinstance(message_id, str)
            or not 1 <= len(message_id) <= 128
            or not isinstance(body, str)
        ):
            raise VerificationCommandInvalid("catalog_discovery_event_invalid")
        try:
            await processor.process(parse_catalog_discovery_command(body))
        except (VerificationCommandInvalid, VerificationDependencyUnavailable):
            failures.append({"itemIdentifier": message_id})
    return {"batchItemFailures": failures}


_DEFAULT_PROCESSOR: CatalogDiscoveryProcessor | None = None


def default_processor() -> CatalogDiscoveryProcessor:
    global _DEFAULT_PROCESSOR
    if _DEFAULT_PROCESSOR is None:
        runtime = VerifierRuntimeSettings.from_environment()
        _DEFAULT_PROCESSOR = CatalogDiscoveryProcessor(
            RdsDataCatalogDiscoveryCoordinator(RdsDataApiClient(runtime.data_api_settings())),
            AwsConnectionVerificationSecretLoader(runtime),
            PostgreSqlCatalogReader(),
        )
    return _DEFAULT_PROCESSOR


def handler(event: Mapping[str, Any], context: object) -> dict[str, list[dict[str, str]]]:
    del context
    return asyncio.run(handle_sqs_event(event, default_processor()))
