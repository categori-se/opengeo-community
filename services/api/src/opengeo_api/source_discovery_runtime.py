from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.rds_data import DataApiResult, RdsDataApiUnavailable
from opengeo_api.source_archiver import SourceArchiveFailure, discovery_metadata_key
from opengeo_api.source_discovery import (
    DiscoveryKind,
    DiscoverySourceType,
    SourceDiscoveryEngine,
    SourceDiscoveryFailure,
    SourceDiscoveryResult,
    SourceDiscoverySpec,
    parse_discovery_document,
)

_LEASE_SECONDS = 120
_MAXIMUM_RESULT_BYTES = 524_288


class SourceDiscoveryDependencyUnavailable(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class SourceDiscoveryCommand:
    discovery_job_id: UUID


@dataclass(frozen=True, slots=True, repr=False)
class SourceDiscoveryClaim:
    discovery_job_id: UUID
    source_type: DiscoverySourceType
    kind: DiscoveryKind
    service_url: str
    collection_ref: str | None
    attempt_count: int
    organization_id: UUID | None = None
    project_id: UUID | None = None

    def spec(self) -> SourceDiscoverySpec:
        return SourceDiscoverySpec(
            self.source_type,
            self.kind,
            self.service_url,
            self.collection_ref,
        )


class SourceDiscoveryDataApi(Protocol):
    async def execute(
        self,
        statement: str,
        parameters: tuple[Any, ...] = (),
        transaction_id: str | None = None,
    ) -> DataApiResult: ...


class SourceDiscoveryCoordinator(Protocol):
    async def claim(
        self,
        discovery_job_id: UUID,
        worker_token: UUID,
        lease_seconds: int,
    ) -> SourceDiscoveryClaim | None: ...

    async def complete(
        self,
        discovery_job_id: UUID,
        worker_token: UUID,
        result: dict[str, Any],
        source_document: dict[str, Any] | None = None,
    ) -> bool: ...

    async def fail(
        self,
        discovery_job_id: UUID,
        worker_token: UUID,
        error_code: str,
    ) -> bool: ...

    async def release(
        self,
        discovery_job_id: UUID,
        worker_token: UUID,
        error_code: str,
    ) -> str: ...


class DiscoveryEngine(Protocol):
    async def discover(self, spec: SourceDiscoverySpec) -> SourceDiscoveryResult: ...


class DiscoveryDocumentStorage(Protocol):
    async def read_discovery_document(self, key: str) -> tuple[bytes, dict[str, Any]] | None: ...

    async def store_discovery_document(
        self, key: str, body: bytes, retrieved_at: str
    ) -> tuple[bytes, dict[str, Any]]: ...


class RdsDataSourceDiscoveryCoordinator:
    def __init__(self, client: SourceDiscoveryDataApi) -> None:
        self._client = client

    async def claim(
        self,
        discovery_job_id: UUID,
        worker_token: UUID,
        lease_seconds: int,
    ) -> SourceDiscoveryClaim | None:
        try:
            result = await self._client.execute(
                """
                SELECT claim_status, job_id, source_type, discovery_kind,
                       service_url, collection_ref, attempt_count, organization_id, project_id
                FROM app.claim_external_source_discovery_document(%s, %s, %s::integer)
                """,
                (discovery_job_id, worker_token, lease_seconds),
            )
        except RdsDataApiUnavailable as error:
            raise SourceDiscoveryDependencyUnavailable(
                "source discovery claim is unavailable"
            ) from error
        if len(result.records) != 1 or len(result.records[0]) != 9:
            raise SourceDiscoveryDependencyUnavailable(
                "source discovery claim returned an invalid result"
            )
        row = result.records[0]
        if row[0] not in {
            "claimed",
            "not_ready",
            "busy",
            "already_completed",
            "already_failed",
            "already_cancelled",
        }:
            raise SourceDiscoveryDependencyUnavailable(
                "source discovery claim returned an invalid state"
            )
        if row[0] != "claimed":
            if row[1] is not None and _uuid(row[1]) != discovery_job_id:
                raise SourceDiscoveryDependencyUnavailable(
                    "source discovery claim returned the wrong identity"
                )
            return None
        try:
            claim = SourceDiscoveryClaim(
                _uuid(row[1]),
                cast(DiscoverySourceType, _literal(row[2], {"arcgis", "wfs"})),
                cast(DiscoveryKind, _literal(row[3], {"catalog", "collection"})),
                _bounded_string(row[4], 2_048),
                _optional_bounded_string(row[5], 200),
                _attempt(row[6]),
                _uuid(row[7]),
                _uuid(row[8]),
            )
            claim.spec()
        except (TypeError, ValueError) as error:
            raise SourceDiscoveryDependencyUnavailable(
                "source discovery claim returned invalid fields"
            ) from error
        if claim.discovery_job_id != discovery_job_id:
            raise SourceDiscoveryDependencyUnavailable(
                "source discovery claim returned the wrong identity"
            )
        return claim

    async def complete(
        self,
        discovery_job_id: UUID,
        worker_token: UUID,
        result: dict[str, Any],
        source_document: dict[str, Any] | None = None,
    ) -> bool:
        encoded = json.dumps(result, sort_keys=True, separators=(",", ":")).encode()
        if not 1 <= len(encoded) <= _MAXIMUM_RESULT_BYTES:
            raise SourceDiscoveryDependencyUnavailable(
                "source discovery result exceeds the database bound"
            )
        if source_document is not None:
            if len(json.dumps(source_document).encode()) > 49_152:
                raise SourceDiscoveryDependencyUnavailable("source document exceeds database bound")
            return await self._boolean_function(
                "complete_external_source_discovery_document",
                (discovery_job_id, worker_token, Jsonb(result), Jsonb(source_document)),
                "completion",
            )
        return await self._boolean_function(
            "complete_external_source_discovery",
            (discovery_job_id, worker_token, Jsonb(result)),
            "completion",
        )

    async def fail(
        self,
        discovery_job_id: UUID,
        worker_token: UUID,
        error_code: str,
    ) -> bool:
        return await self._boolean_function(
            "fail_external_source_discovery",
            (discovery_job_id, worker_token, error_code),
            "failure recording",
        )

    async def release(
        self,
        discovery_job_id: UUID,
        worker_token: UUID,
        error_code: str,
    ) -> str:
        try:
            result = await self._client.execute(
                "SELECT app.release_external_source_discovery(%s, %s, %s)",
                (discovery_job_id, worker_token, error_code),
            )
        except RdsDataApiUnavailable as error:
            raise SourceDiscoveryDependencyUnavailable(
                "source discovery release is unavailable"
            ) from error
        if (
            len(result.records) != 1
            or len(result.records[0]) != 1
            or result.records[0][0] not in {"queued", "failed", "lost"}
        ):
            raise SourceDiscoveryDependencyUnavailable(
                "source discovery release returned an invalid result"
            )
        return cast(str, result.records[0][0])

    async def _boolean_function(
        self,
        function_name: str,
        parameters: tuple[Any, ...],
        operation: str,
    ) -> bool:
        if function_name not in {
            "complete_external_source_discovery",
            "complete_external_source_discovery_document",
            "fail_external_source_discovery",
        }:
            raise ValueError("source discovery function is not allowlisted")
        placeholders = ", ".join("%s" for _ in parameters)
        try:
            result = await self._client.execute(
                f"SELECT app.{function_name}({placeholders})",
                parameters,
            )
        except RdsDataApiUnavailable as error:
            raise SourceDiscoveryDependencyUnavailable(
                f"source discovery {operation} is unavailable"
            ) from error
        if len(result.records) != 1 or result.records[0] not in {(True,), (False,)}:
            raise SourceDiscoveryDependencyUnavailable(
                f"source discovery {operation} returned an invalid result"
            )
        return result.records[0][0]


class SourceDiscoveryProcessor:
    def __init__(
        self,
        coordinator: SourceDiscoveryCoordinator,
        engine: DiscoveryEngine | None = None,
        *,
        uuid_factory: Callable[[], UUID] = uuid4,
        lease_seconds: int = _LEASE_SECONDS,
        document_storage: DiscoveryDocumentStorage | None = None,
    ) -> None:
        if not 30 <= lease_seconds <= 120:
            raise ValueError("source discovery lease is outside the database bound")
        self._coordinator = coordinator
        self._engine = engine or SourceDiscoveryEngine()
        self._uuid_factory = uuid_factory
        self._lease_seconds = lease_seconds
        self._document_storage = document_storage

    async def process(self, command: SourceDiscoveryCommand) -> bool:
        worker_token = self._uuid_factory()
        claim = await self._coordinator.claim(
            command.discovery_job_id,
            worker_token,
            self._lease_seconds,
        )
        if claim is None:
            return False
        try:
            key = (
                discovery_metadata_key(
                    claim.organization_id, claim.project_id, claim.discovery_job_id
                )
                if claim.organization_id is not None and claim.project_id is not None
                else None
            )
            retained = (
                await self._document_storage.read_discovery_document(key)
                if self._document_storage is not None
                and key is not None
                and claim.attempt_count > 1
                else None
            )
            if retained is not None:
                body, document = retained
                parsed = parse_discovery_document(claim.spec(), body)
                result = SourceDiscoveryResult(
                    parsed.source_type,
                    parsed.kind,
                    parsed.service_url,
                    parsed.collections,
                    parsed.source_definition,
                    parsed.limitations,
                    document,
                )
            else:
                result = await self._engine.discover(claim.spec())
                if (
                    result.source_document is not None
                    and result.source_body is not None
                    and len(result.source_body) > 32_768
                ):
                    if self._document_storage is None or key is None:
                        raise SourceDiscoveryDependencyUnavailable(
                            "source document storage unavailable"
                        )
                    body, document = await self._document_storage.store_discovery_document(
                        key, result.source_body, result.source_document["retrieved_at"]
                    )
                    parsed = parse_discovery_document(claim.spec(), body)
                    result = SourceDiscoveryResult(
                        parsed.source_type,
                        parsed.kind,
                        parsed.service_url,
                        parsed.collections,
                        parsed.source_definition,
                        parsed.limitations,
                        document,
                    )
            completion = (
                self._coordinator.complete(
                    claim.discovery_job_id,
                    worker_token,
                    result.json_value(),
                    result.source_document,
                )
                if result.source_document is not None
                else self._coordinator.complete(
                    claim.discovery_job_id, worker_token, result.json_value()
                )
            )
            if not await completion:
                raise SourceDiscoveryDependencyUnavailable(
                    "source discovery completion was rejected"
                )
            return True
        except (SourceDiscoveryFailure, SourceArchiveFailure) as error:
            if error.retryable:
                state = await self._coordinator.release(
                    claim.discovery_job_id,
                    worker_token,
                    error.code
                    if isinstance(error, SourceDiscoveryFailure)
                    else "upstream_unavailable",
                )
                if state == "queued":
                    raise SourceDiscoveryDependencyUnavailable(
                        "source discovery retry is required"
                    ) from error
                return False
            if not await self._coordinator.fail(
                claim.discovery_job_id,
                worker_token,
                error.code
                if isinstance(error, SourceDiscoveryFailure)
                else "discovery_response_invalid",
            ):
                raise SourceDiscoveryDependencyUnavailable(
                    "source discovery terminal failure could not be recorded"
                ) from error
            return False
        except SourceDiscoveryDependencyUnavailable:
            await self._coordinator.release(
                claim.discovery_job_id, worker_token, "upstream_unavailable"
            )
            raise


def _uuid(value: Any) -> UUID:
    if isinstance(value, UUID):
        return value
    if isinstance(value, str):
        parsed = UUID(value)
        if str(parsed) == value:
            return parsed
    raise ValueError("invalid UUID")


def _literal(value: Any, allowed: set[str]) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise ValueError("invalid literal")
    return value


def _bounded_string(value: Any, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= maximum
        or value != value.strip()
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise ValueError("invalid string")
    return value


def _optional_bounded_string(value: Any, maximum: int) -> str | None:
    return None if value is None else _bounded_string(value, maximum)


def _attempt(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 3:
        raise ValueError("invalid attempt")
    return value
