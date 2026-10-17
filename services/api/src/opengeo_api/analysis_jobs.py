"""Private, version-pinned managed analysis jobs; user code never executes in the API."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol
from uuid import UUID

from psycopg.types.json import Jsonb

from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)

if TYPE_CHECKING:
    from opengeo_api.config import Settings

SNAPSHOT_SCHEMA = "opengeo.analysis.snapshot.1"
MAX_SNAPSHOT_BYTES = 17 * 1024 * 1024
MAX_CODE_BYTES = 64 * 1024
MAX_LAYER_BYTES = 16 * 1024 * 1024
MAX_LAYERS = 16
MAX_LOG_BYTES = 128 * 1024
MAX_GEOJSON_BYTES = 8 * 1024 * 1024
MAX_RESULT_BYTES = 9 * 1024 * 1024
LANGUAGES = ("python", "javascript", "bash")
INTERPRETERS = {
    "python": frozenset({"/usr/local/bin/python3", "/usr/bin/python3"}),
    "javascript": frozenset({"/usr/local/bin/node", "/usr/bin/node"}),
    "bash": frozenset({"/usr/bin/bash", "/bin/bash"}),
}


class AnalysisAccessDenied(RuntimeError):
    pass


class AnalysisNotFound(RuntimeError):
    pass


class AnalysisUnavailable(RuntimeError):
    pass


class AnalysisConflict(RuntimeError):
    def __init__(self, code: str = "analysis_conflict") -> None:
        self.code = code
        super().__init__(code)


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":")
    ).encode()


def parse_runtime_profiles(raw: str | None) -> dict[str, Any] | None:
    """Only operator configuration supplies images, interpreters and architecture."""
    if raw is None:
        return None
    if not isinstance(raw, str) or len(raw.encode()) > 8192:
        raise ValueError("analysis runtime profiles exceed their bound")
    try:
        value = json.loads(raw)
    except (ValueError, TypeError) as error:
        raise ValueError("analysis runtime profiles must be JSON") from error
    if (
        not isinstance(value, dict)
        or set(value) != {"schemaVersion", "architecture", "profiles"}
        or type(value["schemaVersion"]) is not int
        or value["schemaVersion"] != 1
        or not isinstance(value["architecture"], str)
        or value["architecture"] not in {"arm64", "amd64"}
        or not isinstance(value["profiles"], dict)
        or set(value["profiles"]) != set(LANGUAGES)
    ):
        raise ValueError("use the closed three-language analysis profile schema")
    for language, profile in value["profiles"].items():
        if (
            not isinstance(profile, dict)
            or set(profile) != {"image", "interpreter"}
            or not isinstance(profile["image"], str)
            or re.fullmatch(r"sha256:[0-9a-f]{64}", profile["image"]) is None
            or not isinstance(profile["interpreter"], str)
            or profile["interpreter"] not in INTERPRETERS[language]
        ):
            raise ValueError("analysis profiles require immutable images and fixed interpreters")
    return value


@dataclass(frozen=True, slots=True)
class AnalysisConfiguration:
    enabled: bool
    queue_url: str | None
    profiles: dict[str, Any] | None

    @classmethod
    def from_settings(cls, settings: Settings) -> AnalysisConfiguration:
        return cls(
            settings.analysis_dispatch_configured,
            settings.analysis_queue_url,
            parse_runtime_profiles(settings.analysis_runtime_profiles),
        )

    @property
    def configured(self) -> bool:
        return self.enabled and self.queue_url is not None and self.profiles is not None

    @property
    def profiles_sha256(self) -> str | None:
        return hashlib.sha256(canonical_bytes(self.profiles)).hexdigest() if self.profiles else None

    def profile(self, language: str) -> dict[str, Any]:
        if not self.configured or language not in LANGUAGES or self.profiles is None:
            raise AnalysisUnavailable("analysis_runtime_unavailable")
        return {
            "architecture": self.profiles["architecture"],
            **self.profiles["profiles"][language],
            "timeout_seconds": 10,
            "memory_mib": 256,
        }


class AnalysisJobRepository(Protocol):
    async def capabilities(
        self, context: TenantContext, project: UUID, configuration: AnalysisConfiguration
    ) -> dict[str, Any]: ...
    async def create(
        self,
        context: TenantContext,
        project: UUID,
        request_key: UUID,
        language: str,
        snapshot: dict[str, Any],
        bindings: list[dict[str, Any]],
        configuration: AnalysisConfiguration,
        bucket: str,
    ) -> dict[str, Any]: ...
    async def find(
        self, context: TenantContext, project: UUID, request_key: UUID
    ) -> dict[str, Any]: ...
    async def get(self, context: TenantContext, project: UUID, job: UUID) -> dict[str, Any]: ...
    async def submit(
        self, context: TenantContext, project: UUID, job: UUID, snapshot: dict[str, Any]
    ) -> dict[str, Any]: ...
    async def dispatched(
        self, context: TenantContext, project: UUID, job: UUID
    ) -> dict[str, Any]: ...
    async def cancel(self, context: TenantContext, project: UUID, job: UUID) -> dict[str, Any]: ...


class PostgresAnalysisJobRepository:
    def __init__(self, executor: TenantTransactionExecutor) -> None:
        self._executor = executor

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[dict[str, Any]]],
    ) -> dict[str, Any]:
        try:
            result = await self._executor.run(context, operation)
        except TenantDatabaseConflict as error:
            raise AnalysisConflict() from error
        except TenantDatabaseUnavailable as error:
            raise AnalysisUnavailable("analysis_store_unavailable") from error
        code = result.get("error")
        if code == "analysis_forbidden":
            raise AnalysisAccessDenied("analysis_forbidden")
        if code == "analysis_not_found":
            raise AnalysisNotFound("analysis_not_found")
        if code in {"analysis_runtime_unavailable", "analysis_runtime_disabled"}:
            raise AnalysisUnavailable(str(code))
        if code:
            raise AnalysisConflict(str(code))
        return result

    async def _call(
        self, context: TenantContext, statement: str, parameters: tuple[Any, ...]
    ) -> dict[str, Any]:
        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            row = await tx.fetch_one(statement, parameters)
            if row is None or not isinstance(row[0], dict):
                raise AnalysisConflict("analysis_invalid_state")
            return row[0]

        return await self._run(context, operation)

    async def capabilities(
        self, context: TenantContext, project: UUID, configuration: AnalysisConfiguration
    ) -> dict[str, Any]:
        return await self._call(
            context,
            "SELECT app.analysis_job_capabilities(%s,%s,%s,%s)",
            (
                project,
                configuration.configured,
                configuration.profiles_sha256,
                configuration.queue_url,
            ),
        )

    async def create(
        self,
        context: TenantContext,
        project: UUID,
        request_key: UUID,
        language: str,
        snapshot: dict[str, Any],
        bindings: list[dict[str, Any]],
        configuration: AnalysisConfiguration,
        bucket: str,
    ) -> dict[str, Any]:
        return await self._call(
            context,
            "SELECT app.create_analysis_job(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                project,
                request_key,
                language,
                Jsonb(snapshot),
                Jsonb(bindings),
                Jsonb(configuration.profile(language)),
                configuration.profiles_sha256,
                configuration.queue_url,
                bucket,
            ),
        )

    async def find(
        self, context: TenantContext, project: UUID, request_key: UUID
    ) -> dict[str, Any]:
        return await self._call(
            context, "SELECT app.find_analysis_job(%s,%s)", (project, request_key)
        )

    async def get(self, context: TenantContext, project: UUID, job: UUID) -> dict[str, Any]:
        return await self._call(context, "SELECT app.read_analysis_job(%s,%s)", (project, job))

    async def submit(
        self, context: TenantContext, project: UUID, job: UUID, snapshot: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._call(
            context, "SELECT app.submit_analysis_job(%s,%s,%s)", (project, job, Jsonb(snapshot))
        )

    async def dispatched(self, context: TenantContext, project: UUID, job: UUID) -> dict[str, Any]:
        return await self._call(
            context, "SELECT app.analysis_job_dispatched(%s,%s)", (project, job)
        )

    async def cancel(self, context: TenantContext, project: UUID, job: UUID) -> dict[str, Any]:
        return await self._call(context, "SELECT app.cancel_analysis_job(%s,%s)", (project, job))
