"""Approval intake reusing the existing administrator invitation workflow."""

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, Protocol, cast
from uuid import UUID

from opengeo_api.memberships import (
    MembershipConflict,
    MembershipNotFound,
    MembershipStoreUnavailable,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
    UserContext,
    UserQueryExecutor,
)

RequestState = Literal["pending", "approved", "rejected"]


@dataclass(frozen=True, slots=True)
class AccountRequest:
    id: UUID
    email: str
    display_name: str
    purpose: str
    state: RequestState
    invitation_id: UUID | None
    created_at: datetime
    reviewed_at: datetime | None


class AccountRequestRepository(Protocol):
    async def submit(
        self,
        organization_id: UUID,
        reviewer_user_id: UUID,
        email: str,
        display_name: str,
        purpose: str,
        fingerprint: str,
    ) -> str: ...

    async def list_requests(
        self, context: TenantContext, limit: int, offset: int
    ) -> list[AccountRequest]: ...

    async def get(self, context: TenantContext, request_id: UUID) -> AccountRequest: ...

    async def reject(self, context: TenantContext, request_id: UUID) -> AccountRequest: ...


class PostgresAccountRequestRepository:
    def __init__(
        self, executor: TenantTransactionExecutor, user_executor: UserQueryExecutor
    ) -> None:
        self._executor = executor
        self._user_executor = user_executor

    async def submit(
        self,
        organization_id: UUID,
        reviewer_user_id: UUID,
        email: str,
        display_name: str,
        purpose: str,
        fingerprint: str,
    ) -> str:
        try:
            row = await self._user_executor.fetch_one(
                UserContext(UUID(int=0)),
                "SELECT app.submit_account_access_request(%s,%s,%s,%s,%s,%s)",
                (organization_id, reviewer_user_id, email, display_name, purpose, fingerprint),
            )
        except TenantDatabaseUnavailable as error:
            raise MembershipStoreUnavailable("account request store unavailable") from error
        return str(row[0]) if row else "unavailable"

    @staticmethod
    def _select() -> str:
        return """SELECT id,email,display_name,purpose,state,invitation_id,created_at,reviewed_at
                  FROM app.account_access_requests"""

    @staticmethod
    def _record(row: tuple[Any, ...]) -> AccountRequest:
        return AccountRequest(
            UUID(str(row[0])),
            str(row[1]),
            str(row[2]),
            str(row[3]),
            cast(RequestState, row[4]),
            UUID(str(row[5])) if row[5] else None,
            cast(datetime, row[6]),
            cast(datetime | None, row[7]),
        )

    async def list_requests(
        self, context: TenantContext, limit: int, offset: int
    ) -> list[AccountRequest]:
        async def operation(transaction: TenantTransaction) -> list[AccountRequest]:
            rows = await transaction.fetch_all(
                self._select()
                + " ORDER BY (state = 'pending') DESC, created_at, id LIMIT %s OFFSET %s",
                (limit, offset),
            )
            return [self._record(row) for row in rows]

        try:
            return await self._executor.run(context, operation)
        except TenantDatabaseUnavailable as error:
            raise MembershipStoreUnavailable("account request store unavailable") from error

    async def get(self, context: TenantContext, request_id: UUID) -> AccountRequest:
        async def operation(transaction: TenantTransaction) -> AccountRequest:
            row = await transaction.fetch_one(self._select() + " WHERE id = %s", (request_id,))
            if row is None:
                raise MembershipNotFound("account_request")
            return self._record(row)

        try:
            return await self._executor.run(context, operation)
        except TenantDatabaseUnavailable as error:
            raise MembershipStoreUnavailable("account request store unavailable") from error

    async def reject(self, context: TenantContext, request_id: UUID) -> AccountRequest:
        async def operation(transaction: TenantTransaction) -> AccountRequest:
            row = await transaction.fetch_one(
                self._select() + " WHERE id = %s FOR UPDATE", (request_id,)
            )
            if row is None:
                raise MembershipNotFound("account_request")
            record = self._record(row)
            if record.state == "approved":
                raise MembershipConflict("account_request_already_approved")
            if record.state == "pending":
                await transaction.execute(
                    """UPDATE app.account_access_requests
                       SET state = 'rejected', reviewed_at = clock_timestamp() WHERE id = %s""",
                    (request_id,),
                )
                row = await transaction.fetch_one(self._select() + " WHERE id = %s", (request_id,))
                assert row is not None
                record = self._record(row)
            return record

        try:
            return await self._executor.run(context, operation)
        except TenantDatabaseUnavailable as error:
            raise MembershipStoreUnavailable("account request store unavailable") from error
