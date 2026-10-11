import asyncio
from collections import deque
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest

from opengeo_api.geonode_federation import GeoNodeFederationConfiguration
from opengeo_api.geonode_federations import (
    GeoNodeFederationAccessDenied,
    GeoNodeFederationConflict,
    PostgresGeoNodeFederationRepository,
    geonode_harvest_request_checksum,
)
from opengeo_api.ingestion import Page
from opengeo_api.tenant_database import TenantContext

ORG_ID = UUID("10000000-0000-4000-8000-000000000267")
USER_ID = UUID("20000000-0000-4000-8000-000000000267")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000267")
SOURCE_ID = UUID("60000000-0000-4000-8000-000000000267")
JOB_ID = UUID("70000000-0000-4000-8000-000000000267")
IDEMPOTENCY_KEY = UUID("80000000-0000-4000-8000-000000000267")
NOW = datetime(2026, 8, 31, 12, tzinfo=UTC)
REMOTE_ID = "11111111-1111-4111-8111-111111111111"


class FakeTransaction:
    def __init__(self, rows: list[Any]) -> None:
        self.rows = deque(rows)
        self.calls: list[tuple[str, str, tuple[Any, ...]]] = []

    async def fetch_one(self, statement, parameters=()):
        self.calls.append(("one", statement, tuple(parameters)))
        return self.rows.popleft()

    async def fetch_all(self, statement, parameters=()):
        self.calls.append(("all", statement, tuple(parameters)))
        value = self.rows.popleft()
        assert isinstance(value, list)
        return value

    async def execute(self, statement, parameters=()):
        self.calls.append(("execute", statement, tuple(parameters)))
        return 1


class FakeExecutor:
    def __init__(self, transaction: FakeTransaction) -> None:
        self.transaction = transaction

    async def run(self, context, operation):
        assert context == TenantContext(USER_ID, ORG_ID)
        return await operation(self.transaction)

    async def fetch_one(self, context, statement, parameters=()):
        del context, statement, parameters
        raise AssertionError("direct query not expected")


def configuration(**changes) -> GeoNodeFederationConfiguration:
    values = {
        "name": "Research catalog",
        "remote_url": "https://catalog.example.test/geonode",
        "scheduling_enabled": False,
        "refresh_interval_minutes": 1_440,
        "maximum_resources": 100,
        "credential_mode": "anonymous",
    }
    values.update(changes)
    return GeoNodeFederationConfiguration(**values)


def source_row(config=None, *, status="active") -> tuple[Any, ...]:
    value = config or configuration()
    return (
        SOURCE_ID,
        PROJECT_ID,
        value.name,
        value.remote_url,
        value.source_version,
        value.scheduling_enabled,
        value.refresh_interval_minutes,
        value.maximum_resources,
        value.credential_mode,
        value.configuration_checksum_sha256,
        status,
        USER_ID,
        NOW,
        NOW if status == "disabled" else None,
    )


def job_row(*, state="queued", result=None) -> tuple[Any, ...]:
    config = configuration()
    return (
        JOB_ID,
        SOURCE_ID,
        PROJECT_ID,
        config.configuration_checksum_sha256,
        geonode_harvest_request_checksum(SOURCE_ID, config.configuration_checksum_sha256),
        IDEMPOTENCY_KEY,
        state,
        result,
        None,
        0,
        USER_ID,
        NOW,
        None,
        None,
    )


def context() -> TenantContext:
    return TenantContext(USER_ID, ORG_ID)


def test_registers_one_exact_no_secret_source_and_replays_idempotently() -> None:
    transaction = FakeTransaction([("member",), (PROJECT_ID, "editor"), (None,), None])
    repository = PostgresGeoNodeFederationRepository(
        FakeExecutor(transaction),
        now=lambda: NOW,
        uuid_factory=lambda: SOURCE_ID,
    )

    submission = asyncio.run(repository.create_source(context(), PROJECT_ID, configuration()))

    assert submission.created is True
    assert submission.source.configuration == configuration()
    insert = next(
        call
        for call in transaction.calls
        if call[0] == "execute" and "geonode_federation_sources" in call[1]
    )
    assert configuration().configuration_checksum_sha256 in insert[2]
    assert all(
        token not in repr(insert[2]).lower()
        for token in ("password", "access_token", "authorization", "secret")
    )

    replay = PostgresGeoNodeFederationRepository(
        FakeExecutor(FakeTransaction([("member",), (PROJECT_ID, "editor"), (None,), source_row()]))
    )
    repeated = asyncio.run(replay.create_source(context(), PROJECT_ID, configuration()))
    assert repeated.created is False
    assert repeated.source.source_id == SOURCE_ID


def test_rejects_changed_configuration_for_the_same_remote_identity() -> None:
    changed = configuration(maximum_resources=50)
    repository = PostgresGeoNodeFederationRepository(
        FakeExecutor(FakeTransaction([("member",), (PROJECT_ID, "editor"), (None,), source_row()]))
    )
    with pytest.raises(GeoNodeFederationConflict, match="configuration_conflict"):
        asyncio.run(repository.create_source(context(), PROJECT_ID, changed))


def test_queues_only_a_sealed_harvest_identity_after_source_authorization() -> None:
    transaction = FakeTransaction(
        [("member",), (PROJECT_ID, "editor"), source_row(), (None,), None]
    )
    repository = PostgresGeoNodeFederationRepository(
        FakeExecutor(transaction),
        now=lambda: NOW,
        uuid_factory=lambda: JOB_ID,
    )

    submission = asyncio.run(
        repository.create_harvest(
            context(),
            PROJECT_ID,
            SOURCE_ID,
            IDEMPOTENCY_KEY,
            "geonode-harvest-267",
        )
    )

    assert submission.dispatch_required is True
    assert submission.job.job_id == JOB_ID
    assert submission.job.request_checksum_sha256 == geonode_harvest_request_checksum(
        SOURCE_ID, configuration().configuration_checksum_sha256
    )
    assert any(
        call[0] == "execute" and "geonode_harvest_jobs" in call[1] for call in transaction.calls
    )
    assert any(
        call[0] == "execute" and "federation.geonode.harvest.requested" in call[1]
        for call in transaction.calls
    )


def test_viewer_cannot_register_or_queue_but_can_read_fresh_resource_history() -> None:
    denied = PostgresGeoNodeFederationRepository(
        FakeExecutor(FakeTransaction([("member",), (PROJECT_ID, "viewer")]))
    )
    with pytest.raises(GeoNodeFederationAccessDenied):
        asyncio.run(denied.create_source(context(), PROJECT_ID, configuration()))

    resource_row = (
        SOURCE_ID,
        REMOTE_ID,
        "dataset",
        "Road network",
        "current",
        2,
        "a" * 64,
        NOW - timedelta(days=2),
        NOW - timedelta(days=3),
        NOW,
        NOW + timedelta(days=1),
        None,
    )
    transaction = FakeTransaction(
        [
            ("member",),
            (PROJECT_ID, "viewer"),
            source_row(),
            [resource_row],
        ]
    )
    repository = PostgresGeoNodeFederationRepository(FakeExecutor(transaction))
    resources = asyncio.run(
        repository.list_resources(context(), PROJECT_ID, SOURCE_ID, Page(25, 0))
    )
    assert resources[0].remote_identifier == REMOTE_ID
    assert resources[0].fresh_until == NOW + timedelta(days=1)
    query = next(call for call in transaction.calls if call[0] == "all")
    assert query[2][:3] == (ORG_ID, PROJECT_ID, SOURCE_ID)


def test_parses_append_only_resource_versions_without_widening_project_scope() -> None:
    version_row = (
        SOURCE_ID,
        REMOTE_ID,
        2,
        JOB_ID,
        "updated",
        "dataset",
        "Updated road network",
        "b" * 64,
        {"uuid": REMOTE_ID, "resource_type": "dataset", "title": "Updated road network"},
        NOW - timedelta(days=1),
        NOW,
    )
    transaction = FakeTransaction(
        [
            ("member",),
            (PROJECT_ID, "viewer"),
            source_row(),
            [version_row],
        ]
    )
    repository = PostgresGeoNodeFederationRepository(FakeExecutor(transaction))
    versions = asyncio.run(
        repository.list_resource_versions(context(), PROJECT_ID, SOURCE_ID, REMOTE_ID, Page(25, 0))
    )
    assert versions[0].action == "updated"
    assert versions[0].payload["uuid"] == REMOTE_ID
