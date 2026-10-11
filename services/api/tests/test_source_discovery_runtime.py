import asyncio
import json
from collections import deque
from typing import Any
from uuid import UUID

from opengeo_api.rds_data import DataApiResult, compile_data_api_statement
from opengeo_api.source_archiver_runtime import (
    SourceArchiveCommand,
    SourceArchiveCommandInvalid,
    handle_sqs_event,
    parse_source_discovery_command,
    parse_source_worker_command,
)
from opengeo_api.source_discovery import (
    SourceDiscoveryFailure,
    SourceDiscoveryResult,
)
from opengeo_api.source_discovery_runtime import (
    RdsDataSourceDiscoveryCoordinator,
    SourceDiscoveryClaim,
    SourceDiscoveryCommand,
    SourceDiscoveryDependencyUnavailable,
    SourceDiscoveryProcessor,
)

JOB_ID = UUID("91000000-0000-4000-8000-000000000001")
WORKER_ID = UUID("92000000-0000-4000-8000-000000000001")
ORG_ID = UUID("10000000-0000-4000-8000-000000000001")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000001")
SERVICE_URL = "https://example.test/arcgis/rest/services/open/FeatureServer"


def claim() -> SourceDiscoveryClaim:
    return SourceDiscoveryClaim(
        JOB_ID, "arcgis", "catalog", SERVICE_URL, None, 1, ORG_ID, PROJECT_ID
    )


def result(*records: tuple[Any, ...]) -> DataApiResult:
    return DataApiResult(tuple(records), 0)


class DataApi:
    def __init__(self, results: list[DataApiResult]) -> None:
        self.results = deque(results)
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    async def execute(self, statement, parameters=(), transaction_id=None):
        assert transaction_id is None
        self.calls.append((statement, tuple(parameters)))
        return self.results.popleft()


class Coordinator:
    def __init__(self, record: SourceDiscoveryClaim | None = None) -> None:
        self.record = claim() if record is None else record
        self.calls: list[tuple] = []
        self.release_state = "queued"

    async def claim(self, job_id, worker_id, lease_seconds):
        self.calls.append(("claim", job_id, worker_id, lease_seconds))
        return self.record

    async def complete(self, job_id, worker_id, value, document=None):
        self.calls.append(("complete", job_id, worker_id, value, document))
        return True

    async def fail(self, job_id, worker_id, code):
        self.calls.append(("fail", job_id, worker_id, code))
        return True

    async def release(self, job_id, worker_id, code):
        self.calls.append(("release", job_id, worker_id, code))
        return self.release_state


class Engine:
    def __init__(self, failure: SourceDiscoveryFailure | None = None) -> None:
        self.failure = failure
        self.specs = []

    async def discover(self, spec):
        self.specs.append(spec)
        if self.failure is not None:
            raise self.failure
        return SourceDiscoveryResult(
            "arcgis",
            "catalog",
            SERVICE_URL,
            (
                {
                    "ref": "7",
                    "name": "Parcels",
                    "title": "Parcels",
                    "geometry_type": "MultiPolygon",
                    "bounds": None,
                },
            ),
            None,
            ("Select one layer.",),
        )


def test_rds_coordinator_claims_only_the_fixed_discovery_contract() -> None:
    api = DataApi(
        [result(("claimed", JOB_ID, "arcgis", "catalog", SERVICE_URL, None, 1, ORG_ID, PROJECT_ID))]
    )
    coordinator = RdsDataSourceDiscoveryCoordinator(api)

    record = asyncio.run(coordinator.claim(JOB_ID, WORKER_ID, 120))

    assert record == claim()
    assert "app.claim_external_source_discovery_document(%s, %s, %s::integer)" in api.calls[0][0]
    assert api.calls[0][1] == (JOB_ID, WORKER_ID, 120)
    sql, parameters = compile_data_api_statement(*api.calls[0])
    assert "app.claim_external_source_discovery_document(:p0, :p1, :p2::integer)" in sql
    assert parameters[2] == {"name": "p2", "value": {"longValue": 120}}


def test_rds_coordinator_rejects_changed_identity_or_unbounded_claim_fields() -> None:
    candidates = (
        (
            "claimed",
            UUID("91000000-0000-4000-8000-000000000002"),
            "arcgis",
            "catalog",
            SERVICE_URL,
            None,
            1,
        ),
        ("claimed", JOB_ID, "arcgis", "catalog", f"{SERVICE_URL}?token=secret", None, 1),
        ("claimed", JOB_ID, "unknown", "catalog", SERVICE_URL, None, 1),
    )
    for candidate in candidates:
        coordinator = RdsDataSourceDiscoveryCoordinator(
            DataApi([result((*candidate, ORG_ID, PROJECT_ID))])
        )
        try:
            asyncio.run(coordinator.claim(JOB_ID, WORKER_ID, 120))
        except SourceDiscoveryDependencyUnavailable as error:
            assert "secret" not in str(error)
        else:
            raise AssertionError("unsafe claim was accepted")


def test_processor_completes_one_bounded_result() -> None:
    coordinator = Coordinator()
    engine = Engine()
    processor = SourceDiscoveryProcessor(
        coordinator,
        engine,
        uuid_factory=lambda: WORKER_ID,
    )

    assert asyncio.run(processor.process(SourceDiscoveryCommand(JOB_ID))) is True
    assert [call[0] for call in coordinator.calls] == ["claim", "complete"]
    assert coordinator.calls[1][3]["collections"][0]["ref"] == "7"
    assert engine.specs[0].service_url == SERVICE_URL


def test_processor_fails_terminal_parser_errors_and_retries_network_errors() -> None:
    terminal = Coordinator()
    terminal_processor = SourceDiscoveryProcessor(
        terminal,
        Engine(SourceDiscoveryFailure("discovery_response_invalid")),
        uuid_factory=lambda: WORKER_ID,
    )
    assert asyncio.run(terminal_processor.process(SourceDiscoveryCommand(JOB_ID))) is False
    assert terminal.calls[-1][-1] == "discovery_response_invalid"

    retry = Coordinator()
    retry_processor = SourceDiscoveryProcessor(
        retry,
        Engine(SourceDiscoveryFailure("upstream_unavailable", retryable=True)),
        uuid_factory=lambda: WORKER_ID,
    )
    try:
        asyncio.run(retry_processor.process(SourceDiscoveryCommand(JOB_ID)))
    except SourceDiscoveryDependencyUnavailable:
        pass
    else:
        raise AssertionError("retryable result did not request SQS retry")
    assert retry.calls[-1][-1] == "upstream_unavailable"


def test_command_parser_accepts_only_one_exact_job_identity() -> None:
    body = json.dumps(
        {
            "schema": "opengeo.external-source-discovery.command.1.0.0",
            "discovery_job_id": str(JOB_ID),
        }
    )
    command = parse_source_discovery_command(body)
    assert command == SourceDiscoveryCommand(JOB_ID)
    assert parse_source_worker_command(body) == command

    archive = json.dumps(
        {
            "schema": "opengeo.external-source-snapshot.command.1.0.0",
            "snapshot_job_id": str(JOB_ID),
        }
    )
    assert parse_source_worker_command(archive) == SourceArchiveCommand(JOB_ID)

    for value in (
        "{}",
        body[:-1],
        json.dumps(
            {
                "schema": "opengeo.external-source-discovery.command.1.0.0",
                "discovery_job_id": str(JOB_ID),
                "service_url": "https://example.test/private",
            }
        ),
    ):
        try:
            parse_source_discovery_command(value)
        except SourceArchiveCommandInvalid:
            pass
        else:
            raise AssertionError("unsafe discovery command was accepted")


class ArchiveProcessor:
    def __init__(self) -> None:
        self.commands = []

    async def process(self, command):
        self.commands.append(command)
        return True


class DiscoveryProcessor:
    def __init__(self) -> None:
        self.commands = []

    async def process(self, command):
        self.commands.append(command)
        return True


def test_shared_on_demand_worker_routes_snapshot_and_discovery_commands() -> None:
    archive = ArchiveProcessor()
    discovery = DiscoveryProcessor()
    event = {
        "Records": [
            {
                "messageId": "snapshot-1",
                "body": json.dumps(
                    {
                        "schema": "opengeo.external-source-snapshot.command.1.0.0",
                        "snapshot_job_id": str(JOB_ID),
                    }
                ),
            },
            {
                "messageId": "discovery-1",
                "body": json.dumps(
                    {
                        "schema": "opengeo.external-source-discovery.command.1.0.0",
                        "discovery_job_id": str(JOB_ID),
                    }
                ),
            },
        ]
    }

    response = asyncio.run(handle_sqs_event(event, archive, discovery))  # type: ignore[arg-type]

    assert response == {"batchItemFailures": []}
    assert archive.commands == [SourceArchiveCommand(JOB_ID)]
    assert discovery.commands == [SourceDiscoveryCommand(JOB_ID)]


def test_coordinator_preserves_document_with_the_same_completion_call():
    from opengeo_api.source_discovery import retained_document

    api = DataApi([result((True,))])
    coordinator = RdsDataSourceDiscoveryCoordinator(api)
    document = retained_document(b'{"original": true}\n')
    assert asyncio.run(coordinator.complete(JOB_ID, WORKER_ID, {"normalized": True}, document))
    statement, parameters = api.calls[0]
    assert "complete_external_source_discovery_document" in statement
    assert parameters[3].obj == document
    assert len(api.calls) == 1


def test_large_response_retention_and_retry_reopens_first_bytes_without_provider_fetch():
    from dataclasses import replace
    from hashlib import sha256

    from opengeo_api.source_archiver import discovery_metadata_key
    from opengeo_api.source_discovery import SourceDiscoveryEngine

    base = json.dumps({"layers": [{"id": 7, "type": "Feature Layer", "name": "First"}]}).encode()
    body = base + b" " * (2_097_152 - len(base))

    class Fetcher:
        calls = 0

        async def fetch_document(self, *args, **kwargs):
            self.calls += 1
            return body

    class Storage:
        saved = None
        writes = 0
        reads = 0

        async def store_discovery_document(self, key, raw, retrieved):
            self.writes += 1
            assert key == discovery_metadata_key(ORG_ID, PROJECT_ID, JOB_ID)
            assert raw == body
            self.saved = (
                raw,
                {
                    "status": "retained_object",
                    "body_base64": None,
                    "byte_length": len(raw),
                    "sha256": sha256(raw).hexdigest(),
                    "retrieved_at": retrieved,
                    "object": {"key": key},
                },
            )
            return self.saved

        async def read_discovery_document(self, key):
            self.reads += 1
            return self.saved

    fetcher, saved, coordinator = Fetcher(), Storage(), Coordinator()
    engine = SourceDiscoveryEngine(fetcher)
    processor = SourceDiscoveryProcessor(coordinator, engine, document_storage=saved)
    assert asyncio.run(processor.process(SourceDiscoveryCommand(JOB_ID)))
    first = coordinator.calls[-1][4]
    assert first["status"] == "retained_object" and first["byte_length"] == 2_097_152
    coordinator.record = replace(coordinator.record, attempt_count=2)
    assert asyncio.run(processor.process(SourceDiscoveryCommand(JOB_ID)))
    assert fetcher.calls == 1 and saved.writes == 1 and saved.reads == 1
    assert coordinator.calls[-1][4] == first
    assert coordinator.calls[-1][3]["collections"][0]["name"] == "First"
