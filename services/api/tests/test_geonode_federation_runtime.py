import asyncio
import json
from collections import deque
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from opengeo_api.geonode_federation import (
    GeoNodeFederationConfiguration,
    GeoNodeFederationFailure,
    GeoNodeHarvestSnapshot,
)
from opengeo_api.geonode_federation_runtime import (
    GeoNodeHarvestClaim,
    GeoNodeHarvestCommand,
    GeoNodeHarvestDependencyUnavailable,
    GeoNodeHarvestProcessor,
    RdsDataGeoNodeHarvestCoordinator,
)
from opengeo_api.rds_data import DataApiResult
from opengeo_api.source_archiver_runtime import (
    SourceArchiveCommandInvalid,
    handle_sqs_event,
    parse_geonode_harvest_command,
    parse_source_worker_command,
)

JOB_ID = UUID("70000000-0000-4000-8000-000000000268")
WORKER_ID = UUID("80000000-0000-4000-8000-000000000268")
NOW = datetime(2026, 8, 31, 12, tzinfo=UTC)
URL = "https://catalog.example.test/geonode"


def configuration() -> GeoNodeFederationConfiguration:
    return GeoNodeFederationConfiguration(
        "Research catalog",
        URL,
        False,
        1_440,
        100,
        "anonymous",
    )


def claim() -> GeoNodeHarvestClaim:
    return GeoNodeHarvestClaim(JOB_ID, configuration(), 1)


def snapshot() -> GeoNodeHarvestSnapshot:
    return GeoNodeHarvestSnapshot(
        URL,
        configuration().source_fingerprint,
        NOW,
        NOW + timedelta(days=1),
        0,
        False,
        (),
        "a" * 64,
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
    def __init__(self, record: GeoNodeHarvestClaim | None = None) -> None:
        self.record = claim() if record is None else record
        self.calls: list[tuple] = []
        self.release_state = "queued"

    async def claim(self, job_id, worker_id, lease_seconds):
        self.calls.append(("claim", job_id, worker_id, lease_seconds))
        return self.record

    async def complete(self, job_id, worker_id, value):
        self.calls.append(("complete", job_id, worker_id, value))
        return True

    async def fail(self, job_id, worker_id, code):
        self.calls.append(("fail", job_id, worker_id, code))
        return True

    async def release(self, job_id, worker_id, code):
        self.calls.append(("release", job_id, worker_id, code))
        return self.release_state


class Engine:
    def __init__(self, failure: GeoNodeFederationFailure | None = None) -> None:
        self.failure = failure
        self.configurations = []

    async def harvest(self, value, *, observed_at):
        self.configurations.append((value, observed_at))
        if self.failure is not None:
            raise self.failure
        return snapshot()


def test_rds_coordinator_claims_only_exact_anonymous_geonode_configuration() -> None:
    config = configuration()
    api = DataApi(
        [
            result(
                (
                    "claimed",
                    JOB_ID,
                    config.name,
                    config.remote_url,
                    config.source_fingerprint,
                    "5.1.0",
                    False,
                    1_440,
                    100,
                    "anonymous",
                    1,
                )
            )
        ]
    )
    coordinator = RdsDataGeoNodeHarvestCoordinator(api)

    record = asyncio.run(coordinator.claim(JOB_ID, WORKER_ID, 120))

    assert record == claim()
    assert "app.claim_geonode_harvest" in api.calls[0][0]
    assert api.calls[0][1] == (JOB_ID, WORKER_ID, 120)
    assert "credential" not in repr(record).lower()


def test_rds_coordinator_rejects_changed_fingerprint_or_credential_mode() -> None:
    config = configuration()
    candidates = (
        (
            "claimed",
            JOB_ID,
            config.name,
            config.remote_url,
            "f" * 64,
            "5.1.0",
            False,
            1_440,
            100,
            "anonymous",
            1,
        ),
        (
            "claimed",
            JOB_ID,
            config.name,
            config.remote_url,
            config.source_fingerprint,
            "5.1.0",
            False,
            1_440,
            100,
            "password",
            1,
        ),
    )
    for candidate in candidates:
        coordinator = RdsDataGeoNodeHarvestCoordinator(DataApi([result(candidate)]))
        try:
            asyncio.run(coordinator.claim(JOB_ID, WORKER_ID, 120))
        except GeoNodeHarvestDependencyUnavailable as error:
            assert "password" not in str(error)
        else:
            raise AssertionError("unsafe GeoNode claim was accepted")


def test_processor_completes_one_bounded_snapshot() -> None:
    coordinator = Coordinator()
    engine = Engine()
    processor = GeoNodeHarvestProcessor(
        coordinator,
        engine,
        uuid_factory=lambda: WORKER_ID,
        now=lambda: NOW,
    )

    assert asyncio.run(processor.process(GeoNodeHarvestCommand(JOB_ID))) is True
    assert [call[0] for call in coordinator.calls] == ["claim", "complete"]
    assert coordinator.calls[1][3]["source"]["version"] == "5.1.0"
    assert engine.configurations == [(configuration(), NOW)]


def test_processor_records_terminal_failure_and_requests_retryable_sqs_replay() -> None:
    terminal = Coordinator()
    terminal_processor = GeoNodeHarvestProcessor(
        terminal,
        Engine(GeoNodeFederationFailure("geonode_harvest_response_unsafe")),
        uuid_factory=lambda: WORKER_ID,
        now=lambda: NOW,
    )
    assert asyncio.run(terminal_processor.process(GeoNodeHarvestCommand(JOB_ID))) is False
    assert terminal.calls[-1][-1] == "geonode_harvest_response_unsafe"

    retry = Coordinator()
    retry_processor = GeoNodeHarvestProcessor(
        retry,
        Engine(GeoNodeFederationFailure("geonode_harvest_upstream_unavailable", retryable=True)),
        uuid_factory=lambda: WORKER_ID,
        now=lambda: NOW,
    )
    try:
        asyncio.run(retry_processor.process(GeoNodeHarvestCommand(JOB_ID)))
    except GeoNodeHarvestDependencyUnavailable:
        pass
    else:
        raise AssertionError("retryable GeoNode result did not request SQS retry")
    assert retry.calls[-1][-1] == "geonode_harvest_upstream_unavailable"


def test_command_parser_accepts_only_one_exact_harvest_identity() -> None:
    body = json.dumps(
        {
            "schema": "opengeo.geonode-harvest.command.1.0.0",
            "harvest_job_id": str(JOB_ID),
        }
    )
    command = parse_geonode_harvest_command(body)
    assert command == GeoNodeHarvestCommand(JOB_ID)
    assert parse_source_worker_command(body) == command

    for value in (
        "{}",
        body[:-1],
        json.dumps(
            {
                "schema": "opengeo.geonode-harvest.command.1.0.0",
                "harvest_job_id": str(JOB_ID),
                "remote_url": "https://example.test/private",
            }
        ),
    ):
        try:
            parse_geonode_harvest_command(value)
        except SourceArchiveCommandInvalid:
            pass
        else:
            raise AssertionError("unsafe GeoNode harvest command was accepted")


class Processor:
    def __init__(self) -> None:
        self.commands = []

    async def process(self, command):
        self.commands.append(command)
        return True


def test_shared_on_demand_worker_routes_the_geonode_command_without_url_or_secret() -> None:
    archive = Processor()
    discovery = Processor()
    harvest = Processor()
    event = {
        "Records": [
            {
                "messageId": "harvest-1",
                "body": json.dumps(
                    {
                        "schema": "opengeo.geonode-harvest.command.1.0.0",
                        "harvest_job_id": str(JOB_ID),
                    }
                ),
            }
        ]
    }

    response = asyncio.run(
        handle_sqs_event(event, archive, discovery, harvest)  # type: ignore[arg-type]
    )

    assert response == {"batchItemFailures": []}
    assert archive.commands == []
    assert discovery.commands == []
    assert harvest.commands == [GeoNodeHarvestCommand(JOB_ID)]
