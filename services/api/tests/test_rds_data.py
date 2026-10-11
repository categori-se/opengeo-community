import asyncio
import json
from datetime import UTC, datetime
from decimal import Decimal
from time import monotonic
from uuid import UUID

import pytest
from psycopg.types.json import Jsonb

from opengeo_api.app import create_app
from opengeo_api.cognito_provisioning import AwsCredentials
from opengeo_api.config import Settings
from opengeo_api.principals import PrincipalBackendUnavailable, RdsDataApiPrincipalRepository
from opengeo_api.rds_data import (
    DataApiResult,
    RdsDataApiClient,
    RdsDataApiConflict,
    RdsDataApiUnavailable,
    compile_data_api_statement,
    decode_data_api_result,
)
from opengeo_api.readiness import RdsDataApiReadinessProbe

USER_ID = UUID("20000000-0000-4000-8000-000000000001")


def test_aurora_timestamptz_without_offset_retains_utc_identity() -> None:
    result = decode_data_api_result(
        {
            "columnMetadata": [{"typeName": "timestamptz"}, {"typeName": "timestamp"}],
            "records": [
                [{"stringValue": "2026-09-11 04:45:00"}, {"stringValue": "2026-09-11 04:45:00"}]
            ],
        }
    )
    assert result.records == (
        (datetime(2026, 9, 11, 4, 45, tzinfo=UTC), datetime(2026, 9, 11, 4, 45)),
    )


def test_array_parameters_use_bound_literals_and_fixed_casts() -> None:
    sql, params = compile_data_api_statement(
        "SELECT %s, %s, %s", (["NOAA", 'a"b', "NULL", None], [USER_ID], [])
    )
    assert sql == "SELECT CAST(:p0 AS text[]), CAST(:p1 AS uuid[]), CAST(:p2 AS text[])"
    assert params[0]["value"]["stringValue"] == '{"NOAA","a\\"b","NULL",NULL}'
    assert params[1]["value"]["stringValue"] == '{"' + str(USER_ID) + '"}'
    assert params[2]["value"]["stringValue"] == "{}"
    with pytest.raises(RdsDataApiUnavailable):
        compile_data_api_statement("SELECT %s", (["text", 1],))


class StaticCredentials:
    def load(self) -> AwsCredentials:
        return AwsCredentials("AKIDEXAMPLE", "secret-value", "session-token")


class FakeTransport:
    def __init__(self, responses: list[tuple[int, dict[str, str], dict]]) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[str, dict[str, str], dict, float]] = []

    async def call(self, url, headers, body, timeout_seconds):
        self.calls.append((url, dict(headers), json.loads(body), timeout_seconds))
        status, response_headers, payload = self.responses.pop(0)
        return status, response_headers, json.dumps(payload).encode()


def settings() -> Settings:
    return Settings(
        env="test",
        db_name="opengeo",
        data_api_region="us-east-1",
        data_api_cluster_arn=("arn:aws:rds:us-east-1:111111111111:cluster:opengeo-serverless"),
        data_api_secret_arn=(
            "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/runtime-AbCd"
        ),
    )


def test_statement_compiler_preserves_literal_percent_and_types_parameters() -> None:
    sql, parameters = compile_data_api_statement(
        "SELECT * FROM app.datasets WHERE name ILIKE '%%' || %s || '%%' "
        "AND owner_id = %s AND metadata = %s AND updated_at >= %s AND count = %s",
        (
            "roads",
            USER_ID,
            Jsonb({"source": "survey"}),
            datetime(2026, 8, 19, 12, 30, tzinfo=UTC),
            3,
        ),
    )

    assert "ILIKE '%' || :p0 || '%'" in sql
    assert "owner_id = :p1" in sql
    assert parameters == [
        {"name": "p0", "value": {"stringValue": "roads"}},
        {"name": "p1", "value": {"stringValue": str(USER_ID)}, "typeHint": "UUID"},
        {
            "name": "p2",
            "value": {"stringValue": '{"source":"survey"}'},
            "typeHint": "JSON",
        },
        {
            "name": "p3",
            "value": {"stringValue": "2026-08-19 12:30:00.000000"},
            "typeHint": "TIMESTAMP",
        },
        {"name": "p4", "value": {"longValue": 3}},
    ]


@pytest.mark.parametrize(
    ("statement", "parameters"),
    [("SELECT %s", ()), ("SELECT 1", (1,)), ("SELECT 10 % 3", ())],
)
def test_statement_compiler_rejects_mismatched_or_ambiguous_placeholders(
    statement: str, parameters: tuple
) -> None:
    with pytest.raises(RdsDataApiUnavailable, match=r"placeholder|count"):
        compile_data_api_statement(statement, parameters)


def test_result_decoder_restores_database_types_and_array_values() -> None:
    result = decode_data_api_result(
        {
            "columnMetadata": [
                {"typeName": "uuid"},
                {"typeName": "jsonb"},
                {"typeName": "timestamptz"},
                {"typeName": "_text"},
                {"typeName": "numeric"},
                {"typeName": "bool"},
                {"typeName": "bytea"},
            ],
            "records": [
                [
                    {"stringValue": str(USER_ID)},
                    {"stringValue": '{"quality":"valid"}'},
                    {"stringValue": "2026-08-19 12:30:00+00:00"},
                    {"arrayValue": {"stringValues": ["field", "reviewed"]}},
                    {"stringValue": "12.50"},
                    {"booleanValue": True},
                    {"blobValue": "AAEC/w=="},
                ]
            ],
            "numberOfRecordsUpdated": 0,
        }
    )

    assert result == DataApiResult(
        records=(
            (
                USER_ID,
                {"quality": "valid"},
                datetime(2026, 8, 19, 12, 30, tzinfo=UTC),
                ["field", "reviewed"],
                Decimal("12.50"),
                True,
                b"\x00\x01\x02\xff",
            ),
        ),
        updated=0,
    )


def test_result_decoder_accepts_null_optional_lists_for_write_only_statements() -> None:
    result = decode_data_api_result(
        {
            "columnMetadata": None,
            "records": None,
            "numberOfRecordsUpdated": 1,
        }
    )

    assert result == DataApiResult(records=(), updated=1)


def test_client_signs_explicit_transaction_calls_and_never_serializes_secret() -> None:
    transport = FakeTransport(
        [
            (200, {}, {"transactionId": "transaction-1"}),
            (
                200,
                {},
                {
                    "columnMetadata": [{"typeName": "int8"}],
                    "records": [[{"longValue": 1}]],
                    "numberOfRecordsUpdated": 0,
                },
            ),
            (200, {}, {"transactionStatus": "Transaction Committed"}),
        ]
    )
    client = RdsDataApiClient(
        settings(),
        credentials=StaticCredentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 19, 12, tzinfo=UTC),
    )

    async def scenario() -> DataApiResult:
        transaction_id = await client.begin()
        result = await client.execute("SELECT %s::bigint", (1,), transaction_id)
        await client.commit(transaction_id)
        return result

    assert asyncio.run(scenario()).records == ((1,),)
    assert [call[0] for call in transport.calls] == [
        "https://rds-data.us-east-1.amazonaws.com/BeginTransaction",
        "https://rds-data.us-east-1.amazonaws.com/Execute",
        "https://rds-data.us-east-1.amazonaws.com/CommitTransaction",
    ]
    execute_payload = transport.calls[1][2]
    assert execute_payload["transactionId"] == "transaction-1"
    assert execute_payload["sql"] == "SELECT :p0::bigint"
    for _, headers, payload, _ in transport.calls:
        assert headers["x-amz-security-token"] == "session-token"
        assert (
            "Credential=AKIDEXAMPLE/20260819/us-east-1/rds-data/aws4_request"
            in headers["authorization"]
        )
        assert "secret-value" not in json.dumps(payload)
        assert "secret-value" not in json.dumps(headers)


def test_client_maps_constraint_state_without_exposing_database_details() -> None:
    transport = FakeTransport(
        [
            (
                400,
                {"x-amzn-errortype": "DatabaseErrorException"},
                {
                    "message": (
                        "duplicate key password=sensitive; SQLState: 23505; "
                        "constraint tenant_unique"
                    )
                },
            )
        ]
    )
    client = RdsDataApiClient(settings(), credentials=StaticCredentials(), transport=transport)

    with pytest.raises(RdsDataApiConflict) as caught:
        asyncio.run(client.execute("INSERT INTO app.tags(name) VALUES (%s)", ("roads",)))

    assert "password" not in str(caught.value)
    assert "tenant_unique" not in str(caught.value)


def test_client_retries_only_the_explicit_database_resuming_state() -> None:
    sleeps: list[float] = []

    async def sleep(delay: float) -> None:
        sleeps.append(delay)

    transport = FakeTransport(
        [
            (
                400,
                {"x-amzn-errortype": "DatabaseResumingException"},
                {"message": "database is resuming"},
            ),
            (200, {}, {"transactionId": "transaction-after-resume"}),
        ]
    )
    client = RdsDataApiClient(
        settings(),
        credentials=StaticCredentials(),
        transport=transport,
        sleep=sleep,
        monotonic_clock=lambda: 0,
    )

    transaction_id = asyncio.run(client.begin())

    assert transaction_id == "transaction-after-resume"
    assert sleeps == [1.0]
    assert len(transport.calls) == 2


def test_client_stops_resume_retries_at_the_configured_deadline() -> None:
    times = iter([0.0, 13.0])
    transport = FakeTransport(
        [
            (
                400,
                {"x-amzn-errortype": "DatabaseResumingException"},
                {"message": "database is still resuming"},
            )
        ]
    )
    client = RdsDataApiClient(
        settings(),
        credentials=StaticCredentials(),
        transport=transport,
        monotonic_clock=lambda: next(times),
    )

    with pytest.raises(RdsDataApiUnavailable, match="resume"):
        asyncio.run(client.begin())

    assert len(transport.calls) == 1


def test_principal_lookup_caps_transport_and_keeps_fresh_sql() -> None:
    transport = FakeTransport([(200, {}, {"records": []})] * 3)
    client = RdsDataApiClient(settings(), credentials=StaticCredentials(), transport=transport)
    repository = RdsDataApiPrincipalRepository(settings(), client)

    assert asyncio.run(repository.resolve("known-subject")) is None
    assert asyncio.run(repository.resolve("known-subject")) is None
    asyncio.run(client.execute("SELECT 1"))

    assert [call[3] for call in transport.calls] == [3.0, 3.0, 3.0]
    for call in transport.calls[:2]:
        assert "resolve_principal" in call[2]["sql"]
        assert call[2]["parameters"][0]["value"] == {"stringValue": "known-subject"}


def test_explicit_lookup_budget_covers_resume_wait_after_readiness_deadline() -> None:
    def exercise(completes: bool) -> None:
        elapsed = 0.0
        sleeps = []

        async def sleep(delay):
            nonlocal elapsed
            sleeps.append(delay)
            elapsed += delay

        resuming = (400, {"x-amzn-errortype": "DatabaseResumingException"}, {})
        transport = FakeTransport(
            [resuming] * (5 if completes else 7)
            + ([(200, {}, {"records": []})] if completes else [])
        )
        client = RdsDataApiClient(
            settings(),
            credentials=StaticCredentials(),
            transport=transport,
            sleep=sleep,
            monotonic_clock=lambda: elapsed,
        )
        repository = RdsDataApiPrincipalRepository(settings(), client)
        if completes:
            assert asyncio.run(repository.resolve("known-subject")) is None
            assert elapsed == 15.0
            assert sleeps == [1.0, 2.0, 4.0, 4.0, 4.0]
            assert [call[3] for call in transport.calls] == [3.0] * 6
        else:
            with pytest.raises(PrincipalBackendUnavailable):
                asyncio.run(repository.resolve("known-subject"))
            assert elapsed == 20.0
            assert sleeps == [1.0, 2.0, 4.0, 4.0, 4.0, 4.0, 1.0]
            assert [call[3] for call in transport.calls] == [3.0] * 6 + [1.0]

    exercise(True)
    exercise(False)


def test_principal_transport_stall_stops_at_transport_cap_without_replay() -> None:
    calls = []
    cancelled = []

    class HangingTransport:
        async def call(self, *args):
            calls.append(args)
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.append(True)

    config = settings().model_copy(update={"readiness_timeout_seconds": 0.02})
    client = RdsDataApiClient(config, credentials=StaticCredentials(), transport=HangingTransport())
    repository = RdsDataApiPrincipalRepository(config, client)
    started = monotonic()
    with pytest.raises(PrincipalBackendUnavailable) as caught:
        asyncio.run(repository.resolve("known-subject"))
    assert monotonic() - started < 0.5
    assert calls[0][3] == 0.02
    assert len(calls) == 1 and cancelled == [True]
    assert isinstance(caught.value.__cause__, RdsDataApiUnavailable)
    assert isinstance(caught.value.__cause__.__cause__, TimeoutError)


def test_startup_principal_allows_slow_read_without_changing_normal_cap() -> None:
    calls = []
    cancelled = []

    class DelayedTransport:
        async def call(self, *args):
            calls.append(args)
            try:
                await asyncio.sleep(0.03)
            except asyncio.CancelledError:
                cancelled.append(True)
                raise
            return 200, {}, b'{"records":[]}'

    # Scale both existing budgets so this exercises real cancellation cheaply.
    config = settings().model_copy(
        update={"readiness_timeout_seconds": 0.01, "principal_lookup_timeout_seconds": 0.1}
    )
    client = RdsDataApiClient(config, credentials=StaticCredentials(), transport=DelayedTransport())
    repository = RdsDataApiPrincipalRepository(config, client)
    with pytest.raises(PrincipalBackendUnavailable):
        asyncio.run(repository.resolve("normal-subject"))
    assert asyncio.run(repository.resolve_for_startup("startup-subject")) is None
    with pytest.raises(PrincipalBackendUnavailable):
        asyncio.run(repository.resolve("normal-subject"))
    assert len(calls) == 3 and cancelled == [True, True]
    assert [call[3] for call in calls] == pytest.approx([0.01, 0.1, 0.01], abs=0.005)
    for call, subject in zip(
        calls, ["normal-subject", "startup-subject", "normal-subject"], strict=True
    ):
        payload = json.loads(call[2])
        assert "resolve_principal" in payload["sql"]
        assert payload["parameters"][0]["value"] == {"stringValue": subject}


def test_startup_principal_overall_deadline_cancels_without_transport_replay() -> None:
    calls = []
    cancelled = []

    class HangingTransport:
        async def call(self, *args):
            calls.append(args)
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.append(True)

    config = settings().model_copy(
        update={"readiness_timeout_seconds": 0.01, "principal_lookup_timeout_seconds": 0.04}
    )
    client = RdsDataApiClient(config, credentials=StaticCredentials(), transport=HangingTransport())
    repository = RdsDataApiPrincipalRepository(config, client)
    started = monotonic()
    with pytest.raises(PrincipalBackendUnavailable) as caught:
        asyncio.run(repository.resolve_for_startup("known-subject"))
    assert monotonic() - started < 0.5
    assert len(calls) == 1 and cancelled == [True]
    assert calls[0][3] == pytest.approx(0.04, abs=0.005)
    assert isinstance(caught.value.__cause__, RdsDataApiUnavailable)
    assert isinstance(caught.value.__cause__.__cause__, TimeoutError)


def test_startup_principal_preserves_explicit_resume_backoff_inside_total_window() -> None:
    elapsed = 0.0
    sleeps = []

    async def sleep(delay):
        nonlocal elapsed
        sleeps.append(delay)
        elapsed += delay

    resuming = (400, {"x-amzn-errortype": "DatabaseResumingException"}, {})
    transport = FakeTransport([resuming] * 5 + [(200, {}, {"records": []})])
    client = RdsDataApiClient(
        settings(), credentials=StaticCredentials(), transport=transport,
        sleep=sleep, monotonic_clock=lambda: elapsed,
    )
    repository = RdsDataApiPrincipalRepository(settings(), client)
    assert asyncio.run(repository.resolve_for_startup("known-subject")) is None
    assert elapsed == 15.0 and sleeps == [1.0, 2.0, 4.0, 4.0, 4.0]
    assert [call[3] for call in transport.calls] == [20.0, 19.0, 17.0, 13.0, 9.0, 5.0]


def test_five_second_analysis_budget_allows_a_four_second_transport() -> None:
    calls = []

    class DelayedTransport:
        async def call(self, *args):
            calls.append(args)
            await asyncio.sleep(4)
            return 200, {}, b'{"records":[]}'

    client = RdsDataApiClient(
        settings(), credentials=StaticCredentials(), transport=DelayedTransport()
    )
    assert asyncio.run(client.execute("SELECT pg_sleep(4)", timeout_seconds=5)) == DataApiResult(
        records=(), updated=0
    )
    assert len(calls) == 1
    assert calls[0][3] == pytest.approx(5.0, abs=0.1)


def test_explicit_request_budget_cancels_transport_without_replaying() -> None:
    calls = []
    cancelled = []

    class HangingTransport:
        async def call(self, *args):
            calls.append(args)
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.append(True)

    client = RdsDataApiClient(
        settings(),
        credentials=StaticCredentials(),
        transport=HangingTransport(),
    )
    with pytest.raises(RdsDataApiUnavailable, match="timed out"):
        asyncio.run(client.execute("SELECT 1", timeout_seconds=0.01))
    assert len(calls) == 1
    assert cancelled == [True]


def test_client_rejects_invalid_result_union() -> None:
    with pytest.raises(RdsDataApiUnavailable, match="field union"):
        decode_data_api_result(
            {
                "columnMetadata": [{"typeName": "text"}],
                "records": [[{"unknownValue": "secret"}]],
            }
        )


def test_app_selects_data_api_readiness_and_principal_adapters() -> None:
    app = create_app(settings())

    assert isinstance(app.state.readiness_probe, RdsDataApiReadinessProbe)
    assert isinstance(app.state.principal_repository, RdsDataApiPrincipalRepository)


def test_http_transport_reuses_connections_without_sharing_request_credentials(monkeypatch) -> None:
    from opengeo_api import rds_data

    clients = []
    calls = []

    class Client:
        def __init__(self, **options):
            self.options = options
            self.closed = False
            clients.append(self)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            self.closed = True

        async def post(self, url, **options):
            calls.append((self, url, options))
            return rds_data.httpx2.Response(200, json={"records": []})

    monkeypatch.setattr(rds_data.httpx2, "AsyncClient", Client)
    transport = rds_data.HttpxDataApiTransport()

    async def run():
        async with transport.connection_scope():
            await asyncio.gather(
                transport.call("https://data.test", {"Authorization": "first"}, b"first", 2),
                transport.call("https://data.test", {"Authorization": "second"}, b"second", 3),
            )
            assert len(clients) == 1
            assert not clients[0].closed
        assert clients[0].closed
        assert transport._client is None
        await transport.call("https://data.test", {}, b"cli", 1)
        assert len(clients) == 2
        assert clients[1].closed

    asyncio.run(run())
    assert calls[0][2]["headers"] == {"Authorization": "first"}
    assert calls[1][2]["headers"] == {"Authorization": "second"}
    assert [call[2]["content"] for call in calls] == [b"first", b"second", b"cli"]
    assert [call[2]["timeout"] for call in calls[:2]] == [2, 3]
    assert clients[0].options["limits"].max_connections == 10
    assert clients[0].options["limits"].max_keepalive_connections == 5


def test_app_lifespan_owns_data_api_connections_and_closes_on_failure(monkeypatch) -> None:
    from contextlib import asynccontextmanager

    from opengeo_api.rds_data import HttpxDataApiTransport

    events = []

    @asynccontextmanager
    async def scope(_self):
        events.append("open")
        try:
            yield
        finally:
            events.append("close")

    monkeypatch.setattr(HttpxDataApiTransport, "connection_scope", scope)
    app = create_app(settings())

    async def run():
        with pytest.raises(RuntimeError, match="shutdown"):
            async with app.router.lifespan_context(app):
                assert events == ["open"]
                raise RuntimeError("shutdown")

    asyncio.run(run())
    assert events == ["open", "close"]
