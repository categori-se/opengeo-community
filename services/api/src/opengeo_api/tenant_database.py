import asyncio
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol, TypeVar
from uuid import UUID

import psycopg

from opengeo_api.config import Settings
from opengeo_api.rds_data import (
    RdsDataApiClient,
    RdsDataApiConflict,
    RdsDataApiUnavailable,
)


class TenantDatabaseUnavailable(RuntimeError):
    pass


class TenantDatabaseConflict(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class TenantContext:
    user_id: UUID
    organization_id: UUID


@dataclass(frozen=True, slots=True)
class UserContext:
    user_id: UUID


class TenantQueryExecutor(Protocol):
    async def fetch_one(
        self,
        context: TenantContext,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> tuple[Any, ...] | None: ...


class TenantTransaction(Protocol):
    async def fetch_one(
        self,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> tuple[Any, ...] | None: ...

    async def fetch_all(
        self,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> list[tuple[Any, ...]]: ...

    async def execute(
        self,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> int: ...


ResultT = TypeVar("ResultT")


class TenantTransactionExecutor(TenantQueryExecutor, Protocol):
    async def run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT: ...


class TenantReadonlySnapshotExecutor(TenantTransactionExecutor, Protocol):
    async def run_readonly_snapshot(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT: ...


class UserQueryExecutor(Protocol):
    async def fetch_one(
        self,
        context: UserContext,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> tuple[Any, ...] | None: ...

    async def fetch_all(
        self,
        context: UserContext,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> list[tuple[Any, ...]]: ...


class UnavailableTenantQueryExecutor:
    async def fetch_one(
        self,
        context: TenantContext,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> tuple[Any, ...] | None:
        del context, statement, parameters
        raise TenantDatabaseUnavailable("database is not configured")

    async def run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT:
        del context, operation
        raise TenantDatabaseUnavailable("database is not configured")

    async def run_readonly_snapshot(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT:
        return await self.run(context, operation)


class UnavailableUserQueryExecutor:
    async def fetch_one(
        self,
        context: UserContext,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> tuple[Any, ...] | None:
        del context, statement, parameters
        raise TenantDatabaseUnavailable("database is not configured")

    async def fetch_all(
        self,
        context: UserContext,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> list[tuple[Any, ...]]:
        del context, statement, parameters
        raise TenantDatabaseUnavailable("database is not configured")


class _PostgresTenantTransaction:
    def __init__(self, cursor: psycopg.AsyncCursor[Any]) -> None:
        self._cursor = cursor

    async def fetch_one(
        self,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> tuple[Any, ...] | None:
        await self._cursor.execute(statement, tuple(parameters))
        return await self._cursor.fetchone()

    async def fetch_all(
        self,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> list[tuple[Any, ...]]:
        await self._cursor.execute(statement, tuple(parameters))
        rows = await self._cursor.fetchall()
        return list(rows)

    async def execute(
        self,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> int:
        await self._cursor.execute(statement, tuple(parameters))
        return self._cursor.rowcount


class PostgresTenantQueryExecutor:
    """Execute a bounded tenant operation with RLS context local to one transaction."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def fetch_one(
        self,
        context: TenantContext,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> tuple[Any, ...] | None:
        async def operation(transaction: TenantTransaction) -> tuple[Any, ...] | None:
            return await transaction.fetch_one(statement, parameters)

        return await self.run(context, operation)

    async def run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT:
        return await self._run(context, operation, readonly_snapshot=False)

    async def run_readonly_snapshot(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT:
        """Read a consistent snapshot with the caller's normal tenant authority."""
        return await self._run(context, operation, readonly_snapshot=True)

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
        *,
        readonly_snapshot: bool,
    ) -> ResultT:
        connection_options = self._settings.database_connection_kwargs()
        if connection_options is None:
            raise TenantDatabaseUnavailable("database is not configured")

        conninfo = str(connection_options.pop("conninfo", ""))
        try:
            connection = await asyncio.wait_for(
                psycopg.AsyncConnection.connect(conninfo, **connection_options),
                timeout=self._settings.readiness_timeout_seconds,
            )
        except (psycopg.Error, TimeoutError) as error:
            raise TenantDatabaseUnavailable("tenant database connection failed") from error

        try:
            return await asyncio.wait_for(
                self._run_in_transaction(
                    connection, context, operation, readonly_snapshot=readonly_snapshot
                ),
                timeout=self._settings.database_query_timeout_seconds,
            )
        except psycopg.IntegrityError as error:
            raise TenantDatabaseConflict("tenant database constraint conflict") from error
        except (psycopg.Error, TimeoutError) as error:
            raise TenantDatabaseUnavailable("tenant database query failed") from error
        finally:
            try:
                await connection.close()
            except psycopg.Error as error:
                raise TenantDatabaseUnavailable("tenant database close failed") from error

    async def _run_in_transaction(
        self,
        connection: psycopg.AsyncConnection[Any],
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
        *,
        readonly_snapshot: bool = False,
    ) -> ResultT:
        statement_timeout_ms = max(1, round(self._settings.database_query_timeout_seconds * 1000))
        async with connection.transaction(), connection.cursor() as cursor:
            if readonly_snapshot:
                # PostgreSQL requires isolation before the first query, including
                # the SELECT that establishes our transaction-local RLS context.
                await cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            await cursor.execute(
                """
                SELECT
                  set_config('app.user_id', %s, true),
                  set_config('app.organization_id', %s, true),
                  set_config('statement_timeout', %s, true)
                """,
                (
                    str(context.user_id),
                    str(context.organization_id),
                    f"{statement_timeout_ms}ms",
                ),
            )
            return await operation(_PostgresTenantTransaction(cursor))


class PostgresUserQueryExecutor:
    """Execute only a user-bound SECURITY DEFINER operation without tenant scope."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def fetch_one(
        self,
        context: UserContext,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> tuple[Any, ...] | None:
        connection_options = self._settings.database_connection_kwargs()
        if connection_options is None:
            raise TenantDatabaseUnavailable("database is not configured")
        conninfo = str(connection_options.pop("conninfo", ""))
        try:
            connection = await asyncio.wait_for(
                psycopg.AsyncConnection.connect(conninfo, **connection_options),
                timeout=self._settings.readiness_timeout_seconds,
            )
        except (psycopg.Error, TimeoutError) as error:
            raise TenantDatabaseUnavailable("user database connection failed") from error

        try:
            return await asyncio.wait_for(
                self._fetch_in_transaction(connection, context, statement, parameters),
                timeout=self._settings.database_query_timeout_seconds,
            )
        except (psycopg.Error, TimeoutError) as error:
            raise TenantDatabaseUnavailable("user database query failed") from error
        finally:
            try:
                await connection.close()
            except psycopg.Error as error:
                raise TenantDatabaseUnavailable("user database close failed") from error

    async def fetch_all(
        self,
        context: UserContext,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> list[tuple[Any, ...]]:
        connection_options = self._settings.database_connection_kwargs()
        if connection_options is None:
            raise TenantDatabaseUnavailable("database is not configured")
        conninfo = str(connection_options.pop("conninfo", ""))
        try:
            connection = await asyncio.wait_for(
                psycopg.AsyncConnection.connect(conninfo, **connection_options),
                timeout=self._settings.readiness_timeout_seconds,
            )
        except (psycopg.Error, TimeoutError) as error:
            raise TenantDatabaseUnavailable("user database connection failed") from error

        try:
            return await asyncio.wait_for(
                self._fetch_all_in_transaction(connection, context, statement, parameters),
                timeout=self._settings.database_query_timeout_seconds,
            )
        except (psycopg.Error, TimeoutError) as error:
            raise TenantDatabaseUnavailable("user database query failed") from error
        finally:
            try:
                await connection.close()
            except psycopg.Error as error:
                raise TenantDatabaseUnavailable("user database close failed") from error

    async def _fetch_in_transaction(
        self,
        connection: psycopg.AsyncConnection[Any],
        context: UserContext,
        statement: str,
        parameters: Sequence[Any],
    ) -> tuple[Any, ...] | None:
        statement_timeout_ms = max(1, round(self._settings.database_query_timeout_seconds * 1000))
        async with connection.transaction(), connection.cursor() as cursor:
            await cursor.execute(
                """
                SELECT
                  set_config('app.user_id', %s, true),
                  set_config('statement_timeout', %s, true)
                """,
                (str(context.user_id), f"{statement_timeout_ms}ms"),
            )
            await cursor.execute(statement, tuple(parameters))
            return await cursor.fetchone()

    async def _fetch_all_in_transaction(
        self,
        connection: psycopg.AsyncConnection[Any],
        context: UserContext,
        statement: str,
        parameters: Sequence[Any],
    ) -> list[tuple[Any, ...]]:
        statement_timeout_ms = max(1, round(self._settings.database_query_timeout_seconds * 1000))
        async with connection.transaction(), connection.cursor() as cursor:
            await cursor.execute(
                """
                SELECT
                  set_config('app.user_id', %s, true),
                  set_config('statement_timeout', %s, true)
                """,
                (str(context.user_id), f"{statement_timeout_ms}ms"),
            )
            await cursor.execute(statement, tuple(parameters))
            return list(await cursor.fetchall())


class _DataApiTenantTransaction:
    def __init__(self, client: RdsDataApiClient, transaction_id: str) -> None:
        self._client = client
        self._transaction_id = transaction_id

    async def fetch_one(
        self,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> tuple[Any, ...] | None:
        result = await self._client.execute(statement, parameters, self._transaction_id)
        return result.records[0] if result.records else None

    async def fetch_all(
        self,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> list[tuple[Any, ...]]:
        result = await self._client.execute(statement, parameters, self._transaction_id)
        return list(result.records)

    async def execute(
        self,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> int:
        result = await self._client.execute(statement, parameters, self._transaction_id)
        return result.updated


class RdsDataApiTenantQueryExecutor:
    """Run the existing tenant transaction contract through explicit Data API calls."""

    def __init__(self, settings: Settings, client: RdsDataApiClient | None = None) -> None:
        self._settings = settings
        self._client = client or RdsDataApiClient(settings)

    async def fetch_one(
        self,
        context: TenantContext,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> tuple[Any, ...] | None:
        async def operation(transaction: TenantTransaction) -> tuple[Any, ...] | None:
            return await transaction.fetch_one(statement, parameters)

        return await self.run(context, operation)

    async def run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT:
        return await self._run(context, operation, readonly_snapshot=False)

    async def run_readonly_snapshot(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT:
        """Read a consistent snapshot with the caller's normal tenant authority."""
        return await self._run(context, operation, readonly_snapshot=True)

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
        *,
        readonly_snapshot: bool,
    ) -> ResultT:
        try:
            return await asyncio.wait_for(
                self._run_transaction(context, operation, readonly_snapshot=readonly_snapshot),
                timeout=(
                    self._settings.database_query_timeout_seconds
                    + self._settings.data_api_resume_timeout_seconds
                    + self._settings.readiness_timeout_seconds
                ),
            )
        except RdsDataApiConflict as error:
            raise TenantDatabaseConflict("tenant database constraint conflict") from error
        except (RdsDataApiUnavailable, TimeoutError) as error:
            raise TenantDatabaseUnavailable("tenant database query failed") from error

    async def _run_transaction(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
        *,
        readonly_snapshot: bool = False,
    ) -> ResultT:
        transaction_id = await self._client.begin()
        transaction = _DataApiTenantTransaction(self._client, transaction_id)
        try:
            if readonly_snapshot:
                await transaction.execute(
                    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
                )
            statement_timeout_ms = max(
                1, round(self._settings.database_query_timeout_seconds * 1000)
            )
            await transaction.fetch_one(
                """
                SELECT
                  set_config('app.user_id', %s, true),
                  set_config('app.organization_id', %s, true),
                  set_config('statement_timeout', %s, true),
                  set_config('timezone', 'UTC', true)
                """,
                (
                    str(context.user_id),
                    str(context.organization_id),
                    f"{statement_timeout_ms}ms",
                ),
            )
            result = await operation(transaction)
        except BaseException:
            await self._client.rollback(transaction_id)
            raise
        await self._client.commit(transaction_id)
        return result


class RdsDataApiUserQueryExecutor:
    """Run pre-membership user-bound functions through a Data API transaction."""

    def __init__(self, settings: Settings, client: RdsDataApiClient | None = None) -> None:
        self._settings = settings
        self._client = client or RdsDataApiClient(settings)

    async def fetch_one(
        self,
        context: UserContext,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> tuple[Any, ...] | None:
        rows = await self._run(context, statement, parameters)
        return rows[0] if rows else None

    async def fetch_all(
        self,
        context: UserContext,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> list[tuple[Any, ...]]:
        return await self._run(context, statement, parameters)

    async def _run(
        self,
        context: UserContext,
        statement: str,
        parameters: Sequence[Any],
    ) -> list[tuple[Any, ...]]:
        try:
            return await asyncio.wait_for(
                self._run_transaction(context, statement, parameters),
                timeout=(
                    self._settings.database_query_timeout_seconds
                    + self._settings.data_api_resume_timeout_seconds
                    + self._settings.readiness_timeout_seconds
                ),
            )
        except RdsDataApiConflict as error:
            raise TenantDatabaseConflict("user database constraint conflict") from error
        except (RdsDataApiUnavailable, TimeoutError) as error:
            raise TenantDatabaseUnavailable("user database query failed") from error

    async def _run_transaction(
        self,
        context: UserContext,
        statement: str,
        parameters: Sequence[Any],
    ) -> list[tuple[Any, ...]]:
        transaction_id = await self._client.begin()
        transaction = _DataApiTenantTransaction(self._client, transaction_id)
        try:
            statement_timeout_ms = max(
                1, round(self._settings.database_query_timeout_seconds * 1000)
            )
            await transaction.fetch_one(
                """
                SELECT
                  set_config('app.user_id', %s, true),
                  set_config('statement_timeout', %s, true),
                  set_config('timezone', 'UTC', true)
                """,
                (str(context.user_id), f"{statement_timeout_ms}ms"),
            )
            result = await transaction.fetch_all(statement, parameters)
        except BaseException:
            await self._client.rollback(transaction_id)
            raise
        await self._client.commit(transaction_id)
        return result
