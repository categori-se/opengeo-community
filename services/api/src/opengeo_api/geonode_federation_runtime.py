from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.geonode_federation import (
    GeoNodeFederationConfiguration,
    GeoNodeFederationFailure,
    GeoNodeHarvestEngine,
    GeoNodeHarvestSnapshot,
)
from opengeo_api.rds_data import DataApiResult, RdsDataApiUnavailable
from opengeo_api.source_archiver import AnonymousSourceFetcher

_LEASE_SECONDS = 120
_MAXIMUM_RESULT_BYTES = 2_097_152
_RETRYABLE_CODES = frozenset(
    {
        "dns_resolution_failed",
        "geonode_harvest_upstream_unavailable",
        "tls_verification_failed",
    }
)
_TERMINAL_CODES = frozenset(
    {
        "geonode_harvest_identity_collision",
        "geonode_harvest_identity_invalid",
        "geonode_harvest_local_identity_collision",
        "geonode_harvest_response_invalid",
        "geonode_harvest_response_too_large",
        "geonode_harvest_response_unsafe",
        "geonode_harvest_timestamp_invalid",
        "geonode_harvest_total_invalid",
        "geonode_harvest_type_unsupported",
        "response_media_rejected",
        "unsafe_network_target",
        "upstream_rejected",
    }
)


class GeoNodeHarvestDependencyUnavailable(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class GeoNodeHarvestCommand:
    harvest_job_id: UUID


@dataclass(frozen=True, slots=True, repr=False)
class GeoNodeHarvestClaim:
    harvest_job_id: UUID
    configuration: GeoNodeFederationConfiguration
    attempt_count: int


class GeoNodeHarvestDataApi(Protocol):
    async def execute(
        self,
        statement: str,
        parameters: tuple[Any, ...] = (),
        transaction_id: str | None = None,
    ) -> DataApiResult: ...


class GeoNodeHarvestCoordinator(Protocol):
    async def claim(
        self,
        harvest_job_id: UUID,
        worker_token: UUID,
        lease_seconds: int,
    ) -> GeoNodeHarvestClaim | None: ...

    async def complete(
        self,
        harvest_job_id: UUID,
        worker_token: UUID,
        snapshot: dict[str, Any],
    ) -> bool: ...

    async def fail(
        self,
        harvest_job_id: UUID,
        worker_token: UUID,
        error_code: str,
    ) -> bool: ...

    async def release(
        self,
        harvest_job_id: UUID,
        worker_token: UUID,
        error_code: str,
    ) -> str: ...


class HarvestEngine(Protocol):
    async def harvest(
        self,
        configuration: GeoNodeFederationConfiguration,
        *,
        observed_at: datetime,
    ) -> GeoNodeHarvestSnapshot: ...


class RdsDataGeoNodeHarvestCoordinator:
    def __init__(self, client: GeoNodeHarvestDataApi) -> None:
        self._client = client

    async def claim(
        self,
        harvest_job_id: UUID,
        worker_token: UUID,
        lease_seconds: int,
    ) -> GeoNodeHarvestClaim | None:
        try:
            result = await self._client.execute(
                """
                SELECT claim_status, job_id, display_name, remote_url,
                       source_fingerprint_sha256, source_version,
                       scheduling_enabled, refresh_interval_minutes,
                       maximum_resources, credential_mode, attempt_count
                FROM app.claim_geonode_harvest(%s, %s, %s)
                """,
                (harvest_job_id, worker_token, lease_seconds),
            )
        except RdsDataApiUnavailable as error:
            raise GeoNodeHarvestDependencyUnavailable(
                "GeoNode harvest claim is unavailable"
            ) from error
        if len(result.records) != 1 or len(result.records[0]) != 11:
            raise GeoNodeHarvestDependencyUnavailable(
                "GeoNode harvest claim returned an invalid result"
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
            raise GeoNodeHarvestDependencyUnavailable(
                "GeoNode harvest claim returned an invalid state"
            )
        if row[0] != "claimed":
            if row[1] is not None and _uuid(row[1]) != harvest_job_id:
                raise GeoNodeHarvestDependencyUnavailable(
                    "GeoNode harvest claim returned the wrong identity"
                )
            return None
        try:
            configuration = GeoNodeFederationConfiguration(
                name=_bounded_string(row[2], 100),
                remote_url=_bounded_string(row[3], 2_048),
                source_version=cast(Any, _literal(row[5], {"5.1.0"})),
                scheduling_enabled=_boolean(row[6]),
                refresh_interval_minutes=_bounded_integer(row[7], 60, 10_080),
                maximum_resources=_bounded_integer(row[8], 1, 100),
                credential_mode=cast(Any, _literal(row[9], {"anonymous"})),
            )
            claim = GeoNodeHarvestClaim(
                _uuid(row[1]),
                configuration,
                _bounded_integer(row[10], 1, 3),
            )
            if (
                claim.harvest_job_id != harvest_job_id
                or configuration.source_fingerprint != _sha256(row[4])
            ):
                raise ValueError("claim identity mismatch")
        except (TypeError, ValueError, RuntimeError) as error:
            raise GeoNodeHarvestDependencyUnavailable(
                "GeoNode harvest claim returned invalid fields"
            ) from error
        return claim

    async def complete(
        self,
        harvest_job_id: UUID,
        worker_token: UUID,
        snapshot: dict[str, Any],
    ) -> bool:
        try:
            encoded = json.dumps(
                snapshot,
                allow_nan=False,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
        except (TypeError, ValueError) as error:
            raise GeoNodeHarvestDependencyUnavailable(
                "GeoNode harvest result is invalid"
            ) from error
        if not 1 <= len(encoded) <= _MAXIMUM_RESULT_BYTES:
            raise GeoNodeHarvestDependencyUnavailable(
                "GeoNode harvest result exceeds the database bound"
            )
        return await self._boolean_function(
            "complete_geonode_harvest",
            (harvest_job_id, worker_token, Jsonb(snapshot)),
            "completion",
        )

    async def fail(
        self,
        harvest_job_id: UUID,
        worker_token: UUID,
        error_code: str,
    ) -> bool:
        if error_code not in _TERMINAL_CODES:
            raise GeoNodeHarvestDependencyUnavailable("GeoNode harvest failure code is invalid")
        return await self._boolean_function(
            "fail_geonode_harvest",
            (harvest_job_id, worker_token, error_code),
            "failure recording",
        )

    async def release(
        self,
        harvest_job_id: UUID,
        worker_token: UUID,
        error_code: str,
    ) -> str:
        if error_code not in _RETRYABLE_CODES:
            raise GeoNodeHarvestDependencyUnavailable("GeoNode harvest retry code is invalid")
        try:
            result = await self._client.execute(
                "SELECT app.release_geonode_harvest(%s, %s, %s)",
                (harvest_job_id, worker_token, error_code),
            )
        except RdsDataApiUnavailable as error:
            raise GeoNodeHarvestDependencyUnavailable(
                "GeoNode harvest release is unavailable"
            ) from error
        if (
            len(result.records) != 1
            or len(result.records[0]) != 1
            or result.records[0][0] not in {"queued", "failed", "lost"}
        ):
            raise GeoNodeHarvestDependencyUnavailable(
                "GeoNode harvest release returned an invalid result"
            )
        return cast(str, result.records[0][0])

    async def _boolean_function(
        self,
        function_name: str,
        parameters: tuple[Any, ...],
        operation: str,
    ) -> bool:
        if function_name not in {"complete_geonode_harvest", "fail_geonode_harvest"}:
            raise ValueError("GeoNode harvest function is not allowlisted")
        placeholders = ", ".join("%s" for _ in parameters)
        try:
            result = await self._client.execute(
                f"SELECT app.{function_name}({placeholders})",
                parameters,
            )
        except RdsDataApiUnavailable as error:
            raise GeoNodeHarvestDependencyUnavailable(
                f"GeoNode harvest {operation} is unavailable"
            ) from error
        if len(result.records) != 1 or result.records[0] not in {(True,), (False,)}:
            raise GeoNodeHarvestDependencyUnavailable(
                f"GeoNode harvest {operation} returned an invalid result"
            )
        return result.records[0][0]


class GeoNodeHarvestProcessor:
    def __init__(
        self,
        coordinator: GeoNodeHarvestCoordinator,
        engine: HarvestEngine | None = None,
        *,
        uuid_factory: Callable[[], UUID] = uuid4,
        now: Callable[[], datetime] | None = None,
        lease_seconds: int = _LEASE_SECONDS,
    ) -> None:
        if not 30 <= lease_seconds <= 120:
            raise ValueError("GeoNode harvest lease is outside the database bound")
        self._coordinator = coordinator
        self._engine = engine or GeoNodeHarvestEngine(AnonymousSourceFetcher())
        self._uuid_factory = uuid_factory
        self._now = now or (lambda: datetime.now(UTC))
        self._lease_seconds = lease_seconds

    async def process(self, command: GeoNodeHarvestCommand) -> bool:
        worker_token = self._uuid_factory()
        claim = await self._coordinator.claim(
            command.harvest_job_id,
            worker_token,
            self._lease_seconds,
        )
        if claim is None:
            return False
        try:
            snapshot = await self._engine.harvest(
                claim.configuration,
                observed_at=self._now().astimezone(UTC),
            )
            if not await self._coordinator.complete(
                claim.harvest_job_id,
                worker_token,
                snapshot.json_value(),
            ):
                raise GeoNodeHarvestDependencyUnavailable("GeoNode harvest completion was rejected")
            return True
        except GeoNodeFederationFailure as error:
            code = _database_error_code(error.code)
            if error.retryable and code in _RETRYABLE_CODES:
                state = await self._coordinator.release(
                    claim.harvest_job_id,
                    worker_token,
                    code,
                )
                if state == "queued":
                    raise GeoNodeHarvestDependencyUnavailable(
                        "GeoNode harvest retry is required"
                    ) from error
                return False
            if not await self._coordinator.fail(
                claim.harvest_job_id,
                worker_token,
                code,
            ):
                raise GeoNodeHarvestDependencyUnavailable(
                    "GeoNode harvest terminal failure could not be recorded"
                ) from error
            return False


def _database_error_code(value: str) -> str:
    if value in _TERMINAL_CODES or value in _RETRYABLE_CODES:
        return value
    return "geonode_harvest_response_invalid"


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


def _bounded_integer(value: Any, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError("invalid integer")
    return value


def _boolean(value: Any) -> bool:
    if not isinstance(value, bool):
        raise ValueError("invalid boolean")
    return value


def _sha256(value: Any) -> str:
    if not isinstance(value, str) or len(value) != 64:
        raise ValueError("invalid SHA-256")
    int(value, 16)
    if value != value.lower():
        raise ValueError("invalid SHA-256")
    return value
