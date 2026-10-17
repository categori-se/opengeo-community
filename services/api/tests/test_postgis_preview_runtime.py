import asyncio
import json
from contextlib import asynccontextmanager
from dataclasses import replace
from uuid import UUID

import pytest

from opengeo_api.connection_verification import PostgreSqlCredentials
from opengeo_api.connection_verification_runtime import (
    VerificationCommandInvalid,
    VerificationDependencyUnavailable,
)
from opengeo_api.postgis_preview import PreviewFailure, PreviewFeatures, PreviewSelection
from opengeo_api.postgis_preview_runtime import (
    COMMAND_SCHEMA,
    ERROR_SCHEMA,
    RESPONSE_SCHEMA,
    PostgreSqlPreviewReader,
    PreviewClaim,
    PreviewCommand,
    PreviewProcessor,
    RdsDataPreviewCoordinator,
    parse_preview_command,
)
from opengeo_api.rds_data import DataApiResult

JOB = UUID("8abcdef0-0000-4000-8000-000000000171")
ORG = UUID("10000000-0000-4000-8000-000000000171")
PROJECT = UUID("50000000-0000-4000-8000-000000000171")
DATASET = UUID("60000000-0000-4000-8000-000000000171")
CONNECTION = UUID("70000000-0000-4000-8000-000000000171")
DISCOVERY = UUID("9abcdef0-0000-4000-8000-000000000171")
SECRET = (
    "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/dev/connections/"
    f"{ORG}/{CONNECTION}-AbCd12"
)
CONFIG = {
    "service_kind": "postgis",
    "connection_id": str(CONNECTION),
    "connection_revision_number": 3,
    "catalog_discovery_id": str(DISCOVERY),
    "catalog_relation_ordinal": 1,
    "schema_name": "gis",
    "relation_name": "plots",
    "schema_fingerprint_sha256": "a" * 64,
    "geometry_column": "shape",
    "stable_key": "id",
}
FEATURES = PreviewFeatures(
    {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": "9223372036854775807",
                "geometry": {"type": "Point", "coordinates": [85, 27]},
                "properties": {"id": "9223372036854775807", "amount": "12345678901234567890.125"},
            }
        ],
    },
    {"id": "int64:string", "amount": "numeric:string"},
    False,
)


def claim():
    return PreviewClaim(
        JOB,
        ORG,
        PROJECT,
        DATASET,
        2,
        CONNECTION,
        3,
        "gis.example.test",
        5432,
        "research",
        ("gis",),
        "verify_full",
        "public_internet",
        SECRET,
        PreviewSelection("gis", "plots", "shape", "id", "a" * 64),
        (80.0, 20.0, 90.0, 30.0),
    )


class Coordinator:
    def __init__(self, *, claimed=True, accepted=True):
        self.claimed = claim() if claimed else None
        self.accepted = accepted
        self.calls = []

    async def claim(self, *args):
        self.calls.append(("claim", args))
        result, self.claimed = self.claimed, None
        return result

    async def complete(self, *args):
        self.calls.append(("complete", args))
        return self.accepted


class Loader:
    def __init__(self):
        self.references = []

    async def load(self, reference):
        self.references.append(reference)
        return PostgreSqlCredentials("reader", "private-password")


class Reader:
    def __init__(self, *, features=FEATURES, error=None):
        self.features = features
        self.error = error
        self.calls = 0

    async def preview(self, claimed, credentials):
        self.calls += 1
        if self.error:
            raise self.error
        return self.features


def test_strict_id_only_direct_command_routing_preserves_queue_handler(monkeypatch):
    command = {"schema": COMMAND_SCHEMA, "preview_id": str(JOB)}
    assert parse_preview_command(command) == PreviewCommand(JOB)
    for invalid in (
        {**command, "password": "secret"},
        {**command, "preview_id": str(JOB).upper()},
        {**command, "schema": "unknown"},
        {"schema": COMMAND_SCHEMA},
    ):
        with pytest.raises(VerificationCommandInvalid):
            parse_preview_command(invalid)
    from opengeo_api.connection_verification_runtime import handler

    coordinator, loader, reader = Coordinator(), Loader(), Reader()
    processor = PreviewProcessor(coordinator, loader, reader)
    monkeypatch.setattr("opengeo_api.postgis_preview_runtime.default_processor", lambda: processor)
    monkeypatch.setattr(
        "opengeo_api.connection_verification_runtime.default_processor",
        lambda: pytest.fail("verification runtime must not initialize for preview"),
    )
    result = handler(command, object())
    assert result["schemaVersion"] == RESPONSE_SCHEMA
    with pytest.raises(VerificationCommandInvalid):
        handler({**command, "host": "arbitrary.example.test"}, object())
    assert reader.calls == 1

    class VerificationProcessor:
        def __init__(self):
            self.commands = []

        async def process(self, command):
            self.commands.append(command)

    verification = VerificationProcessor()
    monkeypatch.setattr(
        "opengeo_api.connection_verification_runtime.default_processor", lambda: verification
    )
    assert handler(
        {
            "Records": [
                {
                    "messageId": "verification",
                    "body": json.dumps(
                        {
                            "schema": "opengeo.connection-verification.command.v1",
                            "verification_id": str(JOB),
                        }
                    ),
                }
            ]
        },
        object(),
    ) == {"batchItemFailures": []}
    assert len(verification.commands) == 1


def test_coordinator_fixed_functions_validate_scope_and_persist_only_counts():
    class Client:
        def __init__(self):
            self.records = (
                (
                    "claimed",
                    JOB,
                    ORG,
                    PROJECT,
                    DATASET,
                    2,
                    CONNECTION,
                    3,
                    "postgresql",
                    "gis.example.test",
                    5432,
                    "research",
                    ["gis"],
                    "verify_full",
                    "public_internet",
                    SECRET,
                    json.dumps(CONFIG),
                    "[80,20,90,30]",
                ),
            )
            self.calls = []

        async def execute(self, statement, parameters=()):
            self.calls.append((statement, parameters))
            return DataApiResult(self.records, 0)

    async def run():
        client = Client()
        coordinator = RdsDataPreviewCoordinator(client)
        assert await coordinator.claim(JOB, JOB, 20) == claim()
        assert "app.claim_external_postgis_preview(%s,%s,%s)" in client.calls[-1][0]
        assert client.calls[-1][1] == (JOB, JOB, 20)
        for status in (
            "not_found",
            "already_completed",
            "already_failed",
            "already_running",
            "already_cancelled",
            "not_previewable",
        ):
            client.records = ((status, *([None] * 17)),)
            assert await coordinator.claim(JOB, JOB, 20) is None
        original = Client().records[0]
        for index, value in (
            (1, ORG),
            (8, "mysql"),
            (13, "disable"),
            (14, "private_network"),
            (16, {**CONFIG, "connection_id": str(ORG)}),
            (16, {**CONFIG, "sql": "SELECT * FROM data"}),
            (17, "[-181,0,90,30]"),
        ):
            row = list(original)
            row[index] = value
            client.records = (tuple(row),)
            with pytest.raises(VerificationDependencyUnavailable):
                await coordinator.claim(JOB, JOB, 20)
        client.records = ((True,),)
        assert await coordinator.complete(JOB, JOB, 1, False, None)
        assert client.calls[-1] == (
            "SELECT app.complete_external_postgis_preview(%s,%s,%s,%s,%s)",
            (JOB, JOB, 1, False, None),
        )
        assert "Feature" not in repr(client.calls[-1]) and SECRET not in repr(client.calls[-1])

    asyncio.run(run())


def test_claim_precedes_secret_no_terminal_replay_and_revoked_finish_discards_data():
    async def run():
        for claimed, accepted in ((True, True), (False, True), (True, False)):
            coordinator, loader, reader = (
                Coordinator(claimed=claimed, accepted=accepted),
                Loader(),
                Reader(),
            )
            processor = PreviewProcessor(coordinator, loader, reader)
            result = await processor.process(PreviewCommand(JOB))
            assert reader.calls == len(loader.references) == int(claimed)
            if claimed and accepted:
                assert result["datasetId"] == str(DATASET)
                assert result["sourceVersion"] == 2 and result["connectionRevision"] == 3
                assert result["bbox"] == [80, 20, 90, 30] and result["limit"] == 100
                assert result["returned"] == 1 and result["geojson"] == FEATURES.geojson
                assert coordinator.calls[-1][1][2:] == (1, False, None)
                assert "private-password" not in json.dumps(result) and SECRET not in json.dumps(
                    result
                )
            else:
                assert set(result) == {"schemaVersion", "previewId", "code"}
                assert result["code"] == ("preview_stale" if claimed else "preview_unavailable")
            replay = await processor.process(PreviewCommand(JOB))
            assert replay["code"] == "preview_unavailable"
            assert reader.calls == int(claimed)

    asyncio.run(run())


def test_failure_timeout_and_whole_ascii_response_size_never_escape_features():
    async def run():
        for error, expected in (
            (RuntimeError("postgres://reader:private-password@host/data"), "preview_failed"),
            (TimeoutError(), "preview_timeout"),
            (PreviewFailure("preview_schema_changed"), "preview_schema_changed"),
        ):
            coordinator = Coordinator()
            result = await PreviewProcessor(coordinator, Loader(), Reader(error=error)).process(
                PreviewCommand(JOB)
            )
            assert result == {
                "schemaVersion": ERROR_SCHEMA,
                "previewId": str(JOB),
                "code": expected,
            }
            assert coordinator.calls[-1][1][2:] == (None, None, expected)
        large = json.loads(json.dumps(FEATURES.geojson))
        large["features"][0]["properties"]["unicode"] = "界" * 44_000
        assert len(json.dumps(large, ensure_ascii=False).encode()) < 262_144
        coordinator = Coordinator()
        result = await PreviewProcessor(
            coordinator, Loader(), Reader(features=replace(FEATURES, geojson=large))
        ).process(PreviewCommand(JOB))
        assert result["code"] == "preview_limits_exceeded"
        assert coordinator.calls[-1][1][2:] == (None, None, "preview_limits_exceeded")

    asyncio.run(run())


def test_cancellation_finishes_failed_once_and_never_requeues_provider_work():
    async def run():
        coordinator, loader, reader = (
            Coordinator(),
            Loader(),
            Reader(error=asyncio.CancelledError()),
        )
        processor = PreviewProcessor(coordinator, loader, reader)
        with pytest.raises(asyncio.CancelledError):
            await processor.process(PreviewCommand(JOB))
        assert coordinator.calls[-1][1][2:] == (None, None, "preview_failed")
        assert (await processor.process(PreviewCommand(JOB)))["code"] == "preview_unavailable"
        assert reader.calls == len(loader.references) == 1

    asyncio.run(run())


def test_reader_pins_validated_dns_uses_verified_connection_and_closes_on_failure(monkeypatch):
    events = []

    class Resolver:
        addresses = ("1.1.1.1",)

        async def resolve(self, host, port):
            events.append(("resolve", host, port))
            return self.addresses

    @asynccontextmanager
    async def connection(target, credentials, address):
        events.append(("connect", target, address))
        try:
            yield object()
        finally:
            events.append(("close",))

    async def read(connection, selected, schemas, bbox, *, cursor_name):
        events.append(("read", selected, schemas, bbox, cursor_name))
        if len(events) > 10:
            raise PreviewFailure("preview_schema_changed")
        return FEATURES

    monkeypatch.setattr(
        "opengeo_api.postgis_preview_runtime.verified_postgresql_connection", connection
    )
    monkeypatch.setattr("opengeo_api.postgis_preview_runtime.read_bounded_features", read)

    async def run():
        resolver = Resolver()
        reader = PostgreSqlPreviewReader(resolver=resolver)
        credentials = PostgreSqlCredentials("reader", "private-password")
        assert await reader.preview(claim(), credentials) == FEATURES
        assert events[0] == ("resolve", "gis.example.test", 5432)
        assert events[1][2] == "1.1.1.1" and events[-1] == ("close",)
        assert events[-2][-1] == f"opengeo_preview_{JOB.hex}"
        resolver.addresses = ("1.1.1.1", "169.254.169.254")
        with pytest.raises(PreviewFailure, match="preview_failed"):
            await reader.preview(claim(), credentials)
        assert len([event for event in events if event[0] == "connect"]) == 1
        resolver.addresses = ("1.1.1.1",)
        events.extend([("padding",)] * 10)
        with pytest.raises(PreviewFailure, match="preview_schema_changed"):
            await reader.preview(claim(), credentials)
        assert events[-1] == ("close",)

    asyncio.run(run())
