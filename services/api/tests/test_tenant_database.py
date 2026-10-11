import asyncio
import json
from datetime import UTC, datetime
from uuid import UUID

import psycopg
import pytest
from pydantic import SecretStr

from opengeo_api.config import Settings
from opengeo_api.rds_data import DataApiResult, RdsDataApiUnavailable
from opengeo_api.tenant_database import (
    PostgresTenantQueryExecutor,
    PostgresUserQueryExecutor,
    RdsDataApiTenantQueryExecutor,
    RdsDataApiUserQueryExecutor,
    TenantContext,
    TenantDatabaseUnavailable,
    UnavailableTenantQueryExecutor,
    UserContext,
)
from opengeo_api.workspaces import PostgresWorkspaceRepository

USER_ID = UUID("20000000-0000-4000-8000-000000000001")
ORGANIZATION_ID = UUID("10000000-0000-4000-8000-000000000001")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000001")
MAP_ID = UUID("60000000-0000-4000-8000-000000000001")
NOW = datetime(2026, 8, 19, 12, tzinfo=UTC)


class FakeTransaction:
    def __init__(self, connection) -> None:
        self.connection = connection

    async def __aenter__(self):
        assert self.connection.transaction_active is False
        self.connection.transaction_active = True
        self.connection.events.append("begin")
        return self

    async def __aexit__(self, error_type, error, traceback) -> None:
        del error, traceback
        self.connection.events.append("rollback" if error_type else "commit")
        self.connection.transaction_active = False


class FakeCursor:
    def __init__(self, connection) -> None:
        self.connection = connection

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args) -> None:
        pass

    async def execute(self, statement, parameters=()) -> None:
        assert self.connection.transaction_active is True
        if "set_config('app.user_id'" in statement:
            self.connection.events.append(("context", parameters))
            return
        self.connection.events.append(("query", statement, parameters))
        if self.connection.fail_query:
            raise psycopg.ProgrammingError("password=sensitive-database-detail")

    @property
    def rowcount(self) -> int:
        return 1

    async def fetchone(self):
        assert self.connection.transaction_active is True
        self.connection.events.append("fetch")
        return self.connection.row

    async def fetchall(self):
        assert self.connection.transaction_active is True
        self.connection.events.append("fetch-all")
        return self.connection.rows


class FakeConnection:
    def __init__(self, *, fail_query: bool = False) -> None:
        self.events = []
        self.transaction_active = False
        self.fail_query = fail_query
        self.row = (ORGANIZATION_ID, "Organization A")
        self.rows = [(ORGANIZATION_ID, "Organization A")]

    def transaction(self):
        return FakeTransaction(self)

    def cursor(self):
        return FakeCursor(self)

    async def close(self) -> None:
        assert self.transaction_active is False
        self.events.append("close")


def settings() -> Settings:
    return Settings(
        env="test",
        database_url=SecretStr("postgresql://opengeo_runtime:secret@database/opengeo"),
        database_query_timeout_seconds=1,
    )


def context() -> TenantContext:
    return TenantContext(user_id=USER_ID, organization_id=ORGANIZATION_ID)


class FakeDataApiClient:
    def __init__(self) -> None:
        self.events: list[tuple] = []
        self.results: list[DataApiResult] = []

    async def begin(self) -> str:
        self.events.append(("begin",))
        return "transaction-1"

    async def execute(self, statement, parameters=(), transaction_id=None):
        self.events.append(("execute", statement, tuple(parameters), transaction_id))
        if self.results:
            return self.results.pop(0)
        return DataApiResult(records=(("context-set",),), updated=0)

    async def commit(self, transaction_id: str) -> None:
        self.events.append(("commit", transaction_id))

    async def rollback(self, transaction_id: str) -> None:
        self.events.append(("rollback", transaction_id))


def install_connection(monkeypatch, connection: FakeConnection) -> list[tuple]:
    calls = []

    async def connect(*args, **kwargs):
        calls.append((args, kwargs))
        return connection

    monkeypatch.setattr("opengeo_api.tenant_database.psycopg.AsyncConnection.connect", connect)
    return calls


def test_query_sets_both_rls_values_inside_one_transaction(monkeypatch) -> None:
    connection = FakeConnection()
    connect_calls = install_connection(monkeypatch, connection)
    executor = PostgresTenantQueryExecutor(settings())

    row = asyncio.run(
        executor.fetch_one(
            context(),
            "SELECT id, name FROM app.organizations WHERE id = %s",
            (ORGANIZATION_ID,),
        )
    )

    assert row == (ORGANIZATION_ID, "Organization A")
    assert connect_calls == [
        (
            ("postgresql://opengeo_runtime:secret@database/opengeo",),
            {"connect_timeout": 2, "sslmode": "require"},
        )
    ]
    assert connection.events[0] == "begin"
    assert connection.events[1] == (
        "context",
        (str(USER_ID), str(ORGANIZATION_ID), "1000ms"),
    )
    assert connection.events[2][0] == "query"
    assert connection.events[3:] == ["fetch", "commit", "close"]


def test_database_error_rolls_back_closes_and_is_sanitized(monkeypatch) -> None:
    connection = FakeConnection(fail_query=True)
    install_connection(monkeypatch, connection)
    executor = PostgresTenantQueryExecutor(settings())

    with pytest.raises(TenantDatabaseUnavailable) as caught:
        asyncio.run(executor.fetch_one(context(), "SELECT secret FROM app.organizations"))

    assert "password" not in str(caught.value)
    assert connection.events[-2:] == ["rollback", "close"]


def test_multi_statement_operation_uses_one_context_and_transaction(monkeypatch) -> None:
    connection = FakeConnection()
    install_connection(monkeypatch, connection)
    executor = PostgresTenantQueryExecutor(settings())

    async def operation(transaction):
        one = await transaction.fetch_one("SELECT one FROM app.clients")
        rows = await transaction.fetch_all("SELECT many FROM app.projects")
        changed = await transaction.execute("UPDATE app.maps SET version = version + 1")
        return one, rows, changed

    result = asyncio.run(executor.run(context(), operation))

    assert result == (
        (ORGANIZATION_ID, "Organization A"),
        [(ORGANIZATION_ID, "Organization A")],
        1,
    )
    assert connection.events[0:2] == [
        "begin",
        ("context", (str(USER_ID), str(ORGANIZATION_ID), "1000ms")),
    ]
    assert connection.events[-2:] == ["commit", "close"]


def test_domain_rejection_rolls_back_multi_statement_operation(monkeypatch) -> None:
    connection = FakeConnection()
    install_connection(monkeypatch, connection)
    executor = PostgresTenantQueryExecutor(settings())

    async def rejected(transaction):
        await transaction.execute("UPDATE app.maps SET version = version + 1")
        raise ValueError("authorization rejected")

    with pytest.raises(ValueError, match="authorization rejected"):
        asyncio.run(executor.run(context(), rejected))

    assert connection.events[-2:] == ["rollback", "close"]


def test_invitation_acceptance_executor_sets_user_without_tenant_scope(monkeypatch) -> None:
    connection = FakeConnection()
    install_connection(monkeypatch, connection)
    executor = PostgresUserQueryExecutor(settings())

    row = asyncio.run(
        executor.fetch_one(
            UserContext(USER_ID),
            "SELECT * FROM app.accept_membership_invitation(%s, %s)",
            (UUID("70000000-0000-4000-8000-000000000001"), "request-accept"),
        )
    )

    assert row == (ORGANIZATION_ID, "Organization A")
    assert connection.events[0] == "begin"
    assert connection.events[1] == ("context", (str(USER_ID), "1000ms"))
    assert "app.organization_id" not in connection.events[2][1]
    assert connection.events[-2:] == ["commit", "close"]


def data_api_settings() -> Settings:
    return Settings(
        env="test",
        data_api_region="us-east-1",
        data_api_cluster_arn=("arn:aws:rds:us-east-1:111111111111:cluster:opengeo-serverless"),
        data_api_secret_arn=(
            "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/runtime-AbCd"
        ),
        database_query_timeout_seconds=1,
    )


def test_data_api_tenant_executor_keeps_context_operation_and_commit_in_one_transaction() -> None:
    client = FakeDataApiClient()
    client.results = [
        DataApiResult(records=(("context-set",),), updated=0),
        DataApiResult(records=((ORGANIZATION_ID, "Organization A"),), updated=0),
    ]
    executor = RdsDataApiTenantQueryExecutor(data_api_settings(), client)  # type: ignore[arg-type]

    row = asyncio.run(
        executor.fetch_one(
            context(),
            "SELECT id, name FROM app.organizations WHERE id = %s",
            (ORGANIZATION_ID,),
        )
    )

    assert row == (ORGANIZATION_ID, "Organization A")
    assert client.events[0] == ("begin",)
    assert "set_config('app.user_id'" in client.events[1][1]
    assert "set_config('app.organization_id'" in client.events[1][1]
    assert "set_config('timezone', 'UTC'" in client.events[1][1]
    assert client.events[1][3] == "transaction-1"
    assert client.events[2] == (
        "execute",
        "SELECT id, name FROM app.organizations WHERE id = %s",
        (ORGANIZATION_ID,),
        "transaction-1",
    )
    assert client.events[-1] == ("commit", "transaction-1")


def test_data_api_domain_rejection_rolls_back_without_commit() -> None:
    client = FakeDataApiClient()
    executor = RdsDataApiTenantQueryExecutor(data_api_settings(), client)  # type: ignore[arg-type]

    async def rejected(transaction):
        await transaction.execute("UPDATE app.maps SET version = version + 1")
        raise ValueError("authorization rejected")

    with pytest.raises(ValueError, match="authorization rejected"):
        asyncio.run(executor.run(context(), rejected))

    assert client.events[-1] == ("rollback", "transaction-1")
    assert not any(event[0] == "commit" for event in client.events)


def test_data_api_user_executor_sets_no_organization_context() -> None:
    client = FakeDataApiClient()
    client.results = [
        DataApiResult(records=(("context-set",),), updated=0),
        DataApiResult(records=((ORGANIZATION_ID, "Organization A"),), updated=0),
    ]
    executor = RdsDataApiUserQueryExecutor(data_api_settings(), client)  # type: ignore[arg-type]

    row = asyncio.run(
        executor.fetch_one(
            UserContext(USER_ID),
            "SELECT * FROM app.accept_membership_invitation(%s, %s)",
            (UUID("70000000-0000-4000-8000-000000000001"), "request-accept"),
        )
    )

    assert row == (ORGANIZATION_ID, "Organization A")
    assert "app.organization_id" not in client.events[1][1]
    assert client.events[-1] == ("commit", "transaction-1")


def test_data_api_workspace_reassembles_large_map_without_a_large_result_row() -> None:
    definition = {
        "layers": [{"id": "roads", "style": "界" * 30_000}],
        "bookmarks": [],
    }
    encoded = json.dumps(definition, separators=(", ", ": "), sort_keys=True).encode()
    chunks = tuple(
        (MAP_ID, index, encoded[offset : offset + 24_576])
        for index, offset in enumerate(range(0, len(encoded), 24_576))
    )
    client = FakeDataApiClient()
    client.results = [
        DataApiResult(records=(("context-set",),), updated=0),
        DataApiResult(records=(("member",),), updated=0),
        DataApiResult(records=(("owner",),), updated=0),
        DataApiResult(
            records=(
                (
                    MAP_ID,
                    PROJECT_ID,
                    "Large map",
                    None,
                    "active",
                    len(encoded),
                    1,
                    NOW,
                    NOW,
                ),
            ),
            updated=0,
        ),
        DataApiResult(records=chunks, updated=0),
    ]
    executor = RdsDataApiTenantQueryExecutor(data_api_settings(), client)  # type: ignore[arg-type]
    repository = PostgresWorkspaceRepository(executor)

    result = asyncio.run(repository.get_map(context(), PROJECT_ID, MAP_ID))

    assert result.definition == definition
    execute_events = [event for event in client.events if event[0] == "execute"]
    assert len(execute_events) == 5
    assert all(event[3] == "transaction-1" for event in execute_events)
    metadata_statement = execute_events[-2][1]
    chunk_statement = execute_events[-1][1]
    assert "octet_length(definition::text)" in metadata_statement
    assert "status::text, definition" not in metadata_statement
    assert "convert_to(map.definition::text, 'UTF8')" in chunk_statement
    assert max(len(chunk) for _, _, chunk in chunks) <= 24_576
    assert client.events[-1] == ("commit", "transaction-1")


@pytest.mark.parametrize(
    "tenant_context",
    [
        context(),
        TenantContext(
            user_id=UUID("20000000-0000-4000-8000-000000000002"),
            organization_id=UUID("10000000-0000-4000-8000-000000000002"),
        ),
    ],
)
def test_postgres_snapshot_sets_modes_before_rls_and_keeps_every_read_scoped(
    monkeypatch, tenant_context
) -> None:
    connection = FakeConnection()
    install_connection(monkeypatch, connection)
    executor = PostgresTenantQueryExecutor(settings())

    async def read(transaction):
        await transaction.fetch_one("SELECT id FROM app.projects")
        return await transaction.fetch_all("SELECT id FROM app.maps")

    assert asyncio.run(executor.run_readonly_snapshot(tenant_context, read)) == connection.rows
    assert connection.events[:3] == [
        "begin",
        ("query", "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY", ()),
        (
            "context",
            (str(tenant_context.user_id), str(tenant_context.organization_id), "1000ms"),
        ),
    ]
    assert connection.events[3:7] == [
        ("query", "SELECT id FROM app.projects", ()),
        "fetch",
        ("query", "SELECT id FROM app.maps", ()),
        "fetch-all",
    ]
    assert connection.events[-2:] == ["commit", "close"]


@pytest.mark.parametrize(
    "tenant_context",
    [
        context(),
        TenantContext(
            user_id=UUID("20000000-0000-4000-8000-000000000002"),
            organization_id=UUID("10000000-0000-4000-8000-000000000002"),
        ),
    ],
)
def test_data_api_snapshot_sets_modes_before_rls_and_uses_one_transaction(tenant_context) -> None:
    client = FakeDataApiClient()
    executor = RdsDataApiTenantQueryExecutor(data_api_settings(), client)  # type: ignore[arg-type]

    async def read(transaction):
        await transaction.fetch_one("SELECT id FROM app.projects")
        return await transaction.fetch_all("SELECT id FROM app.maps")

    assert asyncio.run(executor.run_readonly_snapshot(tenant_context, read)) == [("context-set",)]
    assert client.events[:2] == [
        ("begin",),
        (
            "execute",
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
            (),
            "transaction-1",
        ),
    ]
    assert "set_config('app.user_id'" in client.events[2][1]
    assert "set_config('app.organization_id'" in client.events[2][1]
    assert client.events[2][2] == (
        str(tenant_context.user_id),
        str(tenant_context.organization_id),
        "1000ms",
    )
    assert [event[1] for event in client.events[3:-1]] == [
        "SELECT id FROM app.projects",
        "SELECT id FROM app.maps",
    ]
    assert all(event[3] == "transaction-1" for event in client.events[1:-1])
    assert client.events[-1] == ("commit", "transaction-1")


def test_snapshot_does_not_change_subsequent_normal_postgres_operations(monkeypatch) -> None:
    snapshot_connection, normal_connection = FakeConnection(), FakeConnection()
    connections = iter([snapshot_connection, normal_connection])

    async def connect(*args, **kwargs):
        return next(connections)

    monkeypatch.setattr("opengeo_api.tenant_database.psycopg.AsyncConnection.connect", connect)
    executor = PostgresTenantQueryExecutor(settings())

    async def operation(transaction):
        return await transaction.fetch_one("SELECT id FROM app.projects")

    asyncio.run(executor.run_readonly_snapshot(context(), operation))
    other_context = TenantContext(
        UUID("20000000-0000-4000-8000-000000000002"),
        UUID("10000000-0000-4000-8000-000000000002"),
    )
    asyncio.run(executor.run(other_context, operation))
    assert normal_connection.events[:2] == [
        "begin",
        ("context", (str(other_context.user_id), str(other_context.organization_id), "1000ms")),
    ]
    assert not any(
        isinstance(event, tuple) and "SET TRANSACTION" in str(event)
        for event in normal_connection.events
    )


def test_snapshot_does_not_change_subsequent_normal_data_api_operations() -> None:
    client = FakeDataApiClient()
    executor = RdsDataApiTenantQueryExecutor(data_api_settings(), client)  # type: ignore[arg-type]

    async def operation(transaction):
        return await transaction.fetch_one("SELECT id FROM app.projects")

    asyncio.run(executor.run_readonly_snapshot(context(), operation))
    snapshot_events = len(client.events)
    other_context = TenantContext(
        UUID("20000000-0000-4000-8000-000000000002"),
        UUID("10000000-0000-4000-8000-000000000002"),
    )
    asyncio.run(executor.run(other_context, operation))
    normal_events = client.events[snapshot_events:]
    assert normal_events[0] == ("begin",)
    assert "set_config('app.organization_id'" in normal_events[1][1]
    assert normal_events[1][2] == (
        str(other_context.user_id),
        str(other_context.organization_id),
        "1000ms",
    )
    assert not any("SET TRANSACTION" in str(event) for event in normal_events)


def test_postgres_snapshot_setup_failure_stops_before_context_or_callback(monkeypatch) -> None:
    connection = FakeConnection(fail_query=True)
    install_connection(monkeypatch, connection)
    executor = PostgresTenantQueryExecutor(settings())
    callback_called = False

    async def operation(transaction):
        nonlocal callback_called
        callback_called = True

    with pytest.raises(TenantDatabaseUnavailable) as caught:
        asyncio.run(executor.run_readonly_snapshot(context(), operation))
    assert "password" not in str(caught.value)
    assert callback_called is False
    assert not any(
        isinstance(event, tuple) and event[0] == "context" for event in connection.events
    )
    assert connection.events[-2:] == ["rollback", "close"]


def test_data_api_snapshot_setup_failure_stops_before_context_or_callback() -> None:
    class RejectSnapshotClient(FakeDataApiClient):
        async def execute(self, statement, parameters=(), transaction_id=None):
            await super().execute(statement, parameters, transaction_id)
            raise RdsDataApiUnavailable("password=sensitive-database-detail")

    client = RejectSnapshotClient()
    executor = RdsDataApiTenantQueryExecutor(data_api_settings(), client)  # type: ignore[arg-type]
    callback_called = False

    async def operation(transaction):
        nonlocal callback_called
        callback_called = True

    with pytest.raises(TenantDatabaseUnavailable) as caught:
        asyncio.run(executor.run_readonly_snapshot(context(), operation))
    assert "password" not in str(caught.value)
    assert callback_called is False
    assert len(client.events) == 3
    assert "SET TRANSACTION" in client.events[1][1]
    assert client.events[-1] == ("rollback", "transaction-1")


def test_unavailable_snapshot_executor_does_not_run_callback() -> None:
    async def operation(transaction):
        pytest.fail("unconfigured database must not run the callback")

    with pytest.raises(TenantDatabaseUnavailable, match="not configured"):
        asyncio.run(UnavailableTenantQueryExecutor().run_readonly_snapshot(context(), operation))


def test_postgres_readonly_database_rejection_rolls_back_and_closes(monkeypatch) -> None:
    class ReadonlyCursor(FakeCursor):
        async def execute(self, statement, parameters=()):
            await super().execute(statement, parameters)
            if statement.startswith("UPDATE"):
                raise psycopg.errors.ReadOnlySqlTransaction(
                    "cannot write in a read-only transaction"
                )

    class ReadonlyConnection(FakeConnection):
        def cursor(self):
            return ReadonlyCursor(self)

    connection = ReadonlyConnection()
    install_connection(monkeypatch, connection)
    executor = PostgresTenantQueryExecutor(settings())

    async def attempted_write(transaction):
        await transaction.execute("UPDATE app.maps SET version = version + 1")

    with pytest.raises(TenantDatabaseUnavailable):
        asyncio.run(executor.run_readonly_snapshot(context(), attempted_write))
    assert connection.events[1][1].endswith("READ ONLY")
    assert connection.events[-3][1] == "UPDATE app.maps SET version = version + 1"
    assert connection.events[-2:] == ["rollback", "close"]


def test_data_api_readonly_database_rejection_rolls_back_without_commit() -> None:
    class ReadonlyClient(FakeDataApiClient):
        async def execute(self, statement, parameters=(), transaction_id=None):
            result = await super().execute(statement, parameters, transaction_id)
            if statement.startswith("UPDATE"):
                raise RdsDataApiUnavailable("cannot write in a read-only transaction")
            return result

    client = ReadonlyClient()
    executor = RdsDataApiTenantQueryExecutor(data_api_settings(), client)  # type: ignore[arg-type]

    async def attempted_write(transaction):
        await transaction.execute("UPDATE app.maps SET version = version + 1")

    with pytest.raises(TenantDatabaseUnavailable):
        asyncio.run(executor.run_readonly_snapshot(context(), attempted_write))
    assert client.events[1][1].endswith("READ ONLY")
    assert client.events[-2][1] == "UPDATE app.maps SET version = version + 1"
    assert client.events[-1] == ("rollback", "transaction-1")
    assert not any(event[0] == "commit" for event in client.events)
