"""Tenant-scoped catalog history; credentials remain in the isolated connector."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol, cast
from uuid import UUID

from opengeo_api.connections import (
    ConnectionAccessDenied,
    ConnectionConflict,
    ConnectionNotFound,
    ConnectionStoreUnavailable,
    ExternalConnectionRepository,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)


@dataclass(frozen=True)
class CatalogDiscoveryJob:
    discovery_id: UUID
    connection_id: UUID
    connection_revision_number: int
    state: str
    attempt_count: int
    relation_count: int
    truncated: bool
    sanitized_error_code: str | None
    requested_by: UUID
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class CatalogDiscoveryRepository(Protocol):
    async def list_jobs(
        self, context: TenantContext, project: UUID, connection: UUID
    ) -> tuple[CatalogDiscoveryJob, ...]: ...

    async def request(
        self,
        context: TenantContext,
        project: UUID,
        connection: UUID,
        expected_revision: int,
        request_key: UUID,
    ) -> CatalogDiscoveryJob: ...

    async def get(
        self, context: TenantContext, project: UUID, connection: UUID, job: UUID
    ) -> CatalogDiscoveryJob: ...

    async def cancel(
        self, context: TenantContext, project: UUID, connection: UUID, job: UUID
    ) -> CatalogDiscoveryJob: ...

    async def relations(
        self, context: TenantContext, project: UUID, connection: UUID, job: UUID, after: int
    ) -> tuple[tuple[tuple[int, dict[str, Any]], ...], int | None]: ...


_JOB_SELECT = """
SELECT id, connection_id, connection_revision_number, state, attempt_count,
       relation_count, truncated, sanitized_error_code, requested_by,
       created_at, started_at, finished_at
FROM app.external_connection_catalog_discoveries
WHERE organization_id = %s AND project_id = %s AND connection_id = %s
"""


class PostgresCatalogDiscoveryRepository:
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
            raise ConnectionConflict("connection_catalog_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise ConnectionStoreUnavailable("connection catalog unavailable") from error

    async def _authorize(
        self, context: TenantContext, project: UUID, connection: UUID, *, manage: bool = False
    ) -> None:
        record = await self._connections.get_connection(context, project, connection)
        if manage and not record.capabilities.manage:
            raise ConnectionAccessDenied("action forbidden")

    async def list_jobs(
        self, context: TenantContext, project: UUID, connection: UUID
    ) -> tuple[CatalogDiscoveryJob, ...]:
        await self._authorize(context, project, connection)

        async def operation(tx: TenantTransaction) -> tuple[CatalogDiscoveryJob, ...]:
            rows = await tx.fetch_all(
                _JOB_SELECT + " ORDER BY created_at DESC, id DESC LIMIT 20",
                (context.organization_id, project, connection),
            )
            return tuple(_job(row) for row in rows)

        return await self._run(context, operation)

    async def request(
        self,
        context: TenantContext,
        project: UUID,
        connection: UUID,
        expected_revision: int,
        request_key: UUID,
    ) -> CatalogDiscoveryJob:
        await self._authorize(context, project, connection, manage=True)

        async def operation(tx: TenantTransaction) -> CatalogDiscoveryJob:
            row = await tx.fetch_one(
                "SELECT app.request_external_connection_catalog_discovery(%s, %s, %s)",
                (connection, expected_revision, str(request_key)),
            )
            if row is None or row[0] is None:
                raise ConnectionConflict("connection_catalog_conflict")
            return await self._load(tx, context, project, connection, cast(UUID, row[0]))

        return await self._run(context, operation)

    async def get(
        self, context: TenantContext, project: UUID, connection: UUID, job: UUID
    ) -> CatalogDiscoveryJob:
        await self._authorize(context, project, connection)
        return await self._run(
            context, lambda tx: self._load(tx, context, project, connection, job)
        )

    async def cancel(
        self, context: TenantContext, project: UUID, connection: UUID, job: UUID
    ) -> CatalogDiscoveryJob:
        await self._authorize(context, project, connection, manage=True)

        async def operation(tx: TenantTransaction) -> CatalogDiscoveryJob:
            await self._load(tx, context, project, connection, job)
            await tx.fetch_one(
                "SELECT app.cancel_external_connection_catalog_discovery(%s)", (job,)
            )
            return await self._load(tx, context, project, connection, job)

        return await self._run(context, operation)

    async def relations(
        self, context: TenantContext, project: UUID, connection: UUID, job: UUID, after: int
    ) -> tuple[tuple[tuple[int, dict[str, Any]], ...], int | None]:
        if not 0 <= after <= 100:
            raise ConnectionConflict("connection_catalog_cursor_invalid")
        await self._authorize(context, project, connection)

        async def operation(
            tx: TenantTransaction,
        ) -> tuple[tuple[tuple[int, dict[str, Any]], ...], int | None]:
            record = await self._load(tx, context, project, connection, job)
            if record.state != "completed":
                raise ConnectionConflict("connection_catalog_not_completed")
            # Ten 48KiB descriptors leave room for JSON escaping and the Data API
            # response envelope. Do not aggregate all descriptors into one row.
            rows = await tx.fetch_all(
                """
                SELECT ordinal, descriptor FROM app.external_connection_catalog_relations
                WHERE organization_id = %s AND project_id = %s
                  AND discovery_id = %s AND ordinal > %s
                ORDER BY ordinal LIMIT 10
                """,
                (context.organization_id, project, job, after),
            )
            items = tuple((cast(int, row[0]), cast(dict[str, Any], row[1])) for row in rows)
            next_ordinal = items[-1][0] if items and items[-1][0] < record.relation_count else None
            return items, next_ordinal

        return await self._run(context, operation)

    @staticmethod
    async def _load(
        tx: TenantTransaction, context: TenantContext, project: UUID, connection: UUID, job: UUID
    ) -> CatalogDiscoveryJob:
        row = await tx.fetch_one(
            _JOB_SELECT + " AND id = %s", (context.organization_id, project, connection, job)
        )
        if row is None:
            raise ConnectionNotFound("connection_catalog_discovery")
        return _job(row)


def _job(row: tuple[Any, ...]) -> CatalogDiscoveryJob:
    return CatalogDiscoveryJob(
        cast(UUID, row[0]),
        cast(UUID, row[1]),
        cast(int, row[2]),
        cast(str, row[3]),
        cast(int, row[4]),
        cast(int, row[5]),
        cast(bool, row[6]),
        cast(str | None, row[7]),
        cast(UUID, row[8]),
        cast(datetime, row[9]),
        cast(datetime | None, row[10]),
        cast(datetime | None, row[11]),
    )
