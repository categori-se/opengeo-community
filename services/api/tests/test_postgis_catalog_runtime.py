import asyncio
import json
import traceback
from dataclasses import replace
from uuid import UUID, uuid4

import pytest

from opengeo_api.connection_verification import PostgreSqlCredentials
from opengeo_api.connection_verification_runtime import (
    VerificationCommandInvalid,
    VerificationDependencyUnavailable,
)
from opengeo_api.postgis_catalog import CatalogDescription, RelationDescriptor
from opengeo_api.postgis_catalog_runtime import (
    COMMAND_SCHEMA,
    CatalogDiscoveryClaim,
    CatalogDiscoveryCommand,
    CatalogDiscoveryFailure,
    CatalogDiscoveryProcessor,
    PostgreSqlCatalogReader,
    RdsDataCatalogDiscoveryCoordinator,
    parse_catalog_discovery_command,
)
from opengeo_api.rds_data import DataApiResult

JOB = UUID("8abcdef0-0000-4000-8000-000000000170")
ORG = UUID("10000000-0000-4000-8000-000000000170")
PROJECT = UUID("50000000-0000-4000-8000-000000000170")
CONNECTION = UUID("70000000-0000-4000-8000-000000000170")
SECRET = (
    "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/dev/connections/"
    f"{ORG}/{CONNECTION}-AbCd12"
)
CATALOG = {"schemaVersion": "opengeo.postgis-catalog.1.0.0", "relations": [], "truncated": False}


def claim():
    return CatalogDiscoveryClaim(
        JOB,
        ORG,
        PROJECT,
        CONNECTION,
        1,
        "gis.example.test",
        5432,
        "research",
        ("gis",),
        "verify_full",
        "public_internet",
        SECRET,
    )


class Coordinator:
    def __init__(self, claimed=True):
        self.claimed = claim() if claimed else None
        self.calls = []
        self.completions = []
        self.releases = []
        self.release_result = "queued"

    async def claim(self, *args):
        self.calls.append(args)
        return self.claimed

    async def complete(self, *args):
        self.completions.append(args)
        return True

    async def release(self, *args):
        self.releases.append(args)
        return self.release_result


class Loader:
    def __init__(self):
        self.references = []

    async def load(self, reference):
        self.references.append(reference)
        return PostgreSqlCredentials("reader", "private-password")


class Reader:
    def __init__(self, error=None):
        self.calls = []
        self.error = error

    async def discover(self, claimed, credentials):
        self.calls.append((claimed, credentials))
        if self.error:
            raise self.error
        return CATALOG


def test_id_only_commands_and_mixed_queue_keep_exact_partial_failure_ids(monkeypatch):
    body = json.dumps({"schema": COMMAND_SCHEMA, "discovery_id": str(JOB)})
    assert parse_catalog_discovery_command(body) == CatalogDiscoveryCommand(JOB)
    for invalid in (
        "x" * 513,
        "not-json",
        body.replace(str(JOB), str(JOB).upper()),
        json.dumps({"schema": COMMAND_SCHEMA, "discovery_id": str(JOB), "password": "secret"}),
        json.dumps({"schema": "unknown", "discovery_id": str(JOB)}),
    ):
        with pytest.raises(VerificationCommandInvalid):
            parse_catalog_discovery_command(invalid)
    coordinator = Coordinator()
    processor = CatalogDiscoveryProcessor(coordinator, Loader(), Reader())
    monkeypatch.setattr("opengeo_api.postgis_catalog_runtime.default_processor", lambda: processor)

    class VerificationProcessor:
        def __init__(self):
            self.calls = []

        async def process(self, command):
            self.calls.append(command)

    from opengeo_api.connection_verification_runtime import handle_sqs_event

    verification = VerificationProcessor()
    outcome = asyncio.run(
        handle_sqs_event(
            {
                "Records": [
                    {"messageId": "catalog", "body": body},
                    {"messageId": "unknown", "body": body.replace(COMMAND_SCHEMA, "unknown")},
                    {
                        "messageId": "verification",
                        "body": json.dumps(
                            {
                                "schema": "opengeo.connection-verification.command.v1",
                                "verification_id": str(JOB),
                            }
                        ),
                    },
                ]
            },
            verification,
        )
    )
    assert outcome == {"batchItemFailures": [{"itemIdentifier": "unknown"}]}
    assert len(coordinator.completions) == len(verification.calls) == 1


def test_coordinator_uses_only_fixed_functions_and_checks_claim_identity():
    class Client:
        def __init__(self):
            self.calls = []
            self.records = (
                (
                    "claimed",
                    JOB,
                    ORG,
                    PROJECT,
                    CONNECTION,
                    1,
                    "postgresql",
                    "gis.example.test",
                    5432,
                    "research",
                    ["gis"],
                    "verify_full",
                    "public_internet",
                    SECRET,
                    1,
                ),
            )

        async def execute(self, statement, parameters=()):
            self.calls.append((statement, parameters))
            return DataApiResult(self.records, 0)

    async def run():
        client = Client()
        coordinator = RdsDataCatalogDiscoveryCoordinator(client)
        token = uuid4()
        assert await coordinator.claim(JOB, token, 20) == claim()
        assert client.calls[-1][1] == (JOB, token, 20)
        assert "app.claim_external_connection_catalog_discovery(%s, %s, %s)" in client.calls[-1][0]
        for status in (
            "busy",
            "not_found",
            "already_completed",
            "already_failed",
            "already_cancelled",
            "not_discoverable",
            "attempts_exhausted",
        ):
            client.records = ((status, *([None] * 14)),)
            assert await coordinator.claim(JOB, token, 20) is None
        client.records = (("claimed", uuid4(), *Client().records[0][2:]),)
        with pytest.raises(VerificationDependencyUnavailable):
            await coordinator.claim(JOB, token, 20)
        client.records = ((True,),)
        assert await coordinator.complete(JOB, token, CATALOG, None) is True
        assert (
            "app.complete_external_connection_catalog_discovery(%s, %s, %s, %s)"
            in client.calls[-1][0]
        )
        assert client.calls[-1][1][2].obj == CATALOG
        client.records = (("queued",),)
        assert await coordinator.release(JOB, token, 3) == "queued"
        assert client.calls[-1][1] == (JOB, token, 3)

    asyncio.run(run())


def test_processor_claims_before_loading_and_does_not_replay_terminal_work():
    for claimed in (True, False):
        coordinator, loader, reader = Coordinator(claimed), Loader(), Reader()
        result = asyncio.run(
            CatalogDiscoveryProcessor(coordinator, loader, reader).process(
                CatalogDiscoveryCommand(JOB)
            )
        )
        assert result is claimed
        assert len(loader.references) == len(reader.calls) == int(claimed)
        if claimed:
            assert coordinator.completions[0][2:] == (CATALOG, None)
            assert coordinator.completions[0][1] == coordinator.calls[0][1]
            serialized = repr(coordinator.completions) + repr(reader.calls)
            assert SECRET not in serialized and "private-password" not in serialized
        assert coordinator.releases == []


def test_processor_sanitizes_results_releases_dependencies_and_preserves_cancellation():
    for error, expected in (
        (CatalogDiscoveryFailure("postgis_required"), "postgis_required"),
        (CatalogDiscoveryFailure("read_only_transaction_required"), "catalog_description_failed"),
        (TimeoutError(), "catalog_timeout"),
    ):
        coordinator = Coordinator()
        asyncio.run(
            CatalogDiscoveryProcessor(coordinator, Loader(), Reader(error)).process(
                CatalogDiscoveryCommand(JOB)
            )
        )
        assert coordinator.completions[0][2:] == (None, expected)
    for terminal in (False, True):
        coordinator = Coordinator()
        coordinator.release_result = "failed" if terminal else "queued"
        processor = CatalogDiscoveryProcessor(
            coordinator, Loader(), Reader(RuntimeError("private-password"))
        )
        if terminal:
            assert asyncio.run(processor.process(CatalogDiscoveryCommand(JOB))) is False
        else:
            with pytest.raises(VerificationDependencyUnavailable) as caught:
                asyncio.run(processor.process(CatalogDiscoveryCommand(JOB)))
            assert "private-password" not in "".join(traceback.format_exception(caught.value))
        assert len(coordinator.releases) == 1 and coordinator.releases[0][2] == 3
    coordinator = Coordinator()
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(
            CatalogDiscoveryProcessor(
                coordinator, Loader(), Reader(asyncio.CancelledError())
            ).process(CatalogDiscoveryCommand(JOB))
        )
    assert len(coordinator.releases) == 1 and coordinator.completions == []


class Resolver:
    def __init__(self, *addresses):
        self.addresses = addresses or ("8.8.8.8",)
        self.calls = []

    async def resolve(self, host, port):
        self.calls.append((host, port))
        return self.addresses


def transport(monkeypatch, *, probe=(True, True, True), rollback_error=None):
    recorded = {"rolled_back": False, "closed": False}

    class Cursor:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def execute(self, statement):
            recorded["probe"] = statement

        async def fetchone(self):
            return probe

    class Connection:
        def cursor(self):
            return Cursor()

        async def rollback(self):
            recorded["rolled_back"] = True
            if rollback_error:
                raise rollback_error

        async def close(self):
            recorded["closed"] = True

    async def connect(**kwargs):
        recorded["kwargs"] = kwargs
        return Connection()

    monkeypatch.setattr("psycopg.AsyncConnection.connect", connect)
    return recorded


def test_catalog_reader_reuses_one_verified_pinned_connection_and_bounded_core(monkeypatch):
    recorded = transport(monkeypatch)
    resolver = Resolver()

    async def catalog(cursor, *, allowed_schemas, limits):
        assert allowed_schemas == ("gis",) and limits.max_columns == 64
        assert "pg_catalog.pg_extension" in recorded["probe"]
        return CatalogDescription(
            (RelationDescriptor("gis", "roads", "r", (), None, ("stable_key_unavailable",)),), False
        )

    monkeypatch.setattr("opengeo_api.postgis_catalog_runtime.discover_postgis_catalog", catalog)
    result = asyncio.run(
        PostgreSqlCatalogReader(resolver=resolver).discover(
            claim(), PostgreSqlCredentials("reader", "private-password")
        )
    )
    assert resolver.calls == [("gis.example.test", 5432)]
    assert result["schemaVersion"] == "opengeo.postgis-catalog.1.0.0"
    assert len(result["relations"][0]["schema_fingerprint_sha256"]) == 64
    options = recorded["kwargs"]
    assert options["host"] == "gis.example.test" and options["hostaddr"] == "8.8.8.8"
    assert options["sslmode"] == "verify-full" and options["target_session_attrs"] == "read-only"
    assert "statement_timeout=4000" in options["options"]
    assert recorded["rolled_back"] and recorded["closed"]
    for probe, code in (
        ((False, True, True), "verification_failed"),
        ((True, False, True), "tls_verification_failed"),
        ((True, True, False), "postgis_required"),
    ):
        recorded = transport(monkeypatch, probe=probe)
        with pytest.raises(CatalogDiscoveryFailure, match=code):
            asyncio.run(
                PostgreSqlCatalogReader(resolver=Resolver()).discover(
                    claim(), PostgreSqlCredentials("reader", "private-password")
                )
            )
        assert recorded["rolled_back"] and recorded["closed"]
    with pytest.raises(CatalogDiscoveryFailure, match="unsafe_network_target"):
        asyncio.run(
            PostgreSqlCatalogReader(resolver=Resolver("8.8.8.8", "127.0.0.1")).discover(
                claim(), PostgreSqlCredentials("reader", "private-password")
            )
        )


def test_reader_bounds_result_and_cleans_up_cancellation_and_provider_errors(monkeypatch):
    credentials = PostgreSqlCredentials("reader", "private-password")
    for failure, expected in (
        (TimeoutError(), "catalog_timeout"),
        (RuntimeError("private-password"), "catalog_description_failed"),
        (asyncio.CancelledError(), None),
    ):
        recorded = transport(monkeypatch, rollback_error=RuntimeError("private-password"))

        async def broken(*args, failure=failure, **kwargs):
            raise failure

        monkeypatch.setattr("opengeo_api.postgis_catalog_runtime.discover_postgis_catalog", broken)
        with pytest.raises(
            CatalogDiscoveryFailure if expected else asyncio.CancelledError
        ) as caught:
            asyncio.run(PostgreSqlCatalogReader(resolver=Resolver()).discover(claim(), credentials))
        if expected:
            assert caught.value.code == expected
            assert "private-password" not in "".join(traceback.format_exception(caught.value))
        assert recorded["rolled_back"] and recorded["closed"]
    for size, count, expected in (
        (50_000, 1, "catalog_descriptor_limit_exceeded"),
        (12_000, 100, "catalog_metadata_limit_exceeded"),
    ):
        recorded = transport(monkeypatch)

        async def oversized(*args, size=size, count=count, **kwargs):
            relation = replace(
                RelationDescriptor("gis", "roads", "r", (), None, ()), name="x" * size
            )
            return CatalogDescription((relation,) * count, False)

        monkeypatch.setattr(
            "opengeo_api.postgis_catalog_runtime.discover_postgis_catalog", oversized
        )
        with pytest.raises(CatalogDiscoveryFailure, match=expected):
            asyncio.run(PostgreSqlCatalogReader(resolver=Resolver()).discover(claim(), credentials))
        assert recorded["rolled_back"] and recorded["closed"]
