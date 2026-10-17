import asyncio
from typing import Any, Protocol, cast
from uuid import UUID

import psycopg

from opengeo_api.auth_models import OrganizationMembership, OrganizationRole, Principal
from opengeo_api.config import Settings
from opengeo_api.rds_data import RdsDataApiClient, RdsDataApiUnavailable


class PrincipalBackendUnavailable(RuntimeError):
    pass


class PrincipalRepository(Protocol):
    async def resolve(self, subject: str) -> Principal | None: ...


class UnavailablePrincipalRepository:
    async def resolve(self, subject: str) -> Principal | None:
        del subject
        raise PrincipalBackendUnavailable("database is not configured")


class PostgresPrincipalRepository:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def resolve(self, subject: str) -> Principal | None:
        connection_options = self._settings.database_connection_kwargs()
        if connection_options is None:
            raise PrincipalBackendUnavailable("database is not configured")

        conninfo = str(connection_options.pop("conninfo", ""))
        try:
            connection = await asyncio.wait_for(
                psycopg.AsyncConnection.connect(conninfo, **connection_options),
                timeout=self._settings.readiness_timeout_seconds,
            )
            try:
                async with connection.cursor() as cursor:
                    await cursor.execute(
                        """
                        SELECT user_id, email, display_name, organization_id,
                               organization_role
                        FROM app.resolve_principal(%s)
                        """,
                        (subject,),
                    )
                    rows = cast(list[tuple[Any, ...]], await cursor.fetchall())
            finally:
                await connection.close()
        except (psycopg.Error, TimeoutError) as error:
            raise PrincipalBackendUnavailable("principal lookup failed") from error

        if not rows:
            return None

        user_id = UUID(str(rows[0][0]))
        email = str(rows[0][1])
        display_name = str(rows[0][2])
        memberships: list[OrganizationMembership] = []
        for row in rows:
            if UUID(str(row[0])) != user_id or str(row[1]) != email or str(row[2]) != display_name:
                raise PrincipalBackendUnavailable(
                    "principal lookup returned inconsistent identity rows"
                )
            if row[3] is None:
                continue
            role = str(row[4])
            if role not in {"admin", "member", "guest"}:
                raise PrincipalBackendUnavailable("principal lookup returned an invalid role")
            memberships.append(
                OrganizationMembership(
                    organization_id=UUID(str(row[3])),
                    role=cast(OrganizationRole, role),
                )
            )

        return Principal(
            user_id=user_id,
            subject=subject,
            email=email,
            display_name=display_name,
            memberships=tuple(memberships),
        )


class RdsDataApiPrincipalRepository:
    def __init__(self, settings: Settings, client: RdsDataApiClient | None = None) -> None:
        self._client = client or RdsDataApiClient(settings)
        self._timeout_seconds = settings.principal_lookup_timeout_seconds
        self._transport_timeout_seconds = settings.readiness_timeout_seconds

    async def resolve(self, subject: str) -> Principal | None:
        return await self._resolve(subject, self._transport_timeout_seconds)

    async def resolve_for_startup(self, subject: str) -> Principal | None:
        """Allow the session GET its existing overall lookup window for transport."""
        return await self._resolve(subject, self._timeout_seconds)

    async def _resolve(self, subject: str, transport_timeout_seconds: float) -> Principal | None:
        try:
            result = await self._client.execute(
                """
                SELECT user_id, email, display_name, organization_id,
                       organization_role
                FROM app.resolve_principal(%s)
                """,
                (subject,),
                # Budgets are local to this read; an uncertain transport is
                # never replayed. Explicit resume responses share the total window.
                timeout_seconds=self._timeout_seconds,
                transport_timeout_seconds=transport_timeout_seconds,
            )
        except RdsDataApiUnavailable as error:
            raise PrincipalBackendUnavailable("principal lookup failed") from error
        return _principal_from_rows(list(result.records), subject)


def _principal_from_rows(rows: list[tuple[Any, ...]], subject: str) -> Principal | None:
    if not rows:
        return None

    user_id = UUID(str(rows[0][0]))
    email = str(rows[0][1])
    display_name = str(rows[0][2])
    memberships: list[OrganizationMembership] = []
    for row in rows:
        if UUID(str(row[0])) != user_id or str(row[1]) != email or str(row[2]) != display_name:
            raise PrincipalBackendUnavailable(
                "principal lookup returned inconsistent identity rows"
            )
        if row[3] is None:
            continue
        role = str(row[4])
        if role not in {"admin", "member", "guest"}:
            raise PrincipalBackendUnavailable("principal lookup returned an invalid role")
        memberships.append(
            OrganizationMembership(
                organization_id=UUID(str(row[3])),
                role=cast(OrganizationRole, role),
            )
        )

    return Principal(
        user_id=user_id,
        subject=subject,
        email=email,
        display_name=display_name,
        memberships=tuple(memberships),
    )
