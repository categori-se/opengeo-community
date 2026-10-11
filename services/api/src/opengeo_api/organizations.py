from dataclasses import dataclass
from typing import Literal, Protocol, cast
from uuid import UUID

from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseUnavailable,
    TenantQueryExecutor,
)

OrganizationStatus = Literal["active", "archived"]


class OrganizationBackendUnavailable(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class Organization:
    organization_id: UUID
    name: str
    slug: str
    status: OrganizationStatus


class OrganizationRepository(Protocol):
    async def get_current(self, context: TenantContext) -> Organization | None: ...


class UnavailableOrganizationRepository:
    async def get_current(self, context: TenantContext) -> Organization | None:
        del context
        raise OrganizationBackendUnavailable("database is not configured")


class PostgresOrganizationRepository:
    def __init__(self, executor: TenantQueryExecutor) -> None:
        self._executor = executor

    async def get_current(self, context: TenantContext) -> Organization | None:
        try:
            row = await self._executor.fetch_one(
                context,
                """
                SELECT id, name, slug, status::text
                FROM app.organizations
                WHERE id = %s
                """,
                (context.organization_id,),
            )
        except TenantDatabaseUnavailable as error:
            raise OrganizationBackendUnavailable("organization lookup failed") from error

        if row is None:
            return None
        try:
            organization_id = UUID(str(row[0]))
            name = str(row[1])
            slug = str(row[2])
            status = str(row[3])
        except (IndexError, TypeError, ValueError) as error:
            raise OrganizationBackendUnavailable(
                "organization lookup returned an invalid row"
            ) from error
        if status not in {"active", "archived"}:
            raise OrganizationBackendUnavailable("organization lookup returned an invalid status")

        return Organization(
            organization_id=organization_id,
            name=name,
            slug=slug,
            status=cast(OrganizationStatus, status),
        )
