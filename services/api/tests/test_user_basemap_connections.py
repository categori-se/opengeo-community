import asyncio
from uuid import UUID

import pytest

from opengeo_api.connections import StoredConnectionSecret
from opengeo_api.tenant_database import TenantContext, TenantDatabaseUnavailable
from opengeo_api.user_basemap_connections import PostgresUserBasemapConnectionRepository
from opengeo_api.user_connections import (
    UserConnectionAccessDenied,
    UserConnectionStoreUnavailable,
)

ORG_ID = UUID("10000000-0000-4000-8000-000000000056")
USER_ID = UUID("20000000-0000-4000-8000-000000000056")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000056")
CONNECTION_ID = UUID("c0000000-0000-4000-8000-000000000056")
BINDING_ID = UUID("c1000000-0000-4000-8000-000000000056")
SECRET_ARN = (
    "arn:aws:secretsmanager:us-east-1:222222222222:secret:"
    "opengeo/dev/browser-connections/version-AbCd12"
)
CONTEXT = TenantContext(ORG_ID, USER_ID)


class RecordingSecretStore:
    def __init__(self) -> None:
        self.created = 0
        self.reads = 0
        self.discarded: list[str] = []

    async def create_user_basemap_connection(self, *args) -> StoredConnectionSecret:
        del args
        self.created += 1
        return StoredConnectionSecret(SECRET_ARN, ("api_key",))

    async def get_user_basemap_connection_api_key(self, reference: str) -> str:
        assert reference == SECRET_ARN
        self.reads += 1
        return "client-visible-browser-key"

    async def discard(self, reference: str) -> None:
        self.discarded.append(reference)


class RotationPrepareTransaction:
    async def fetch_one(self, statement, parameters=()):
        del parameters
        if "FROM app.organization_memberships" in statement:
            return ("member",)
        if "prepare_user_basemap_connection_credential_rotation" in statement:
            return (None, 0)
        raise AssertionError(statement)

    async def fetch_all(self, statement, parameters=()):
        raise AssertionError((statement, parameters))

    async def execute(self, statement, parameters=()):
        raise AssertionError((statement, parameters))


class FailingRotationCommitExecutor:
    def __init__(self) -> None:
        self.calls = 0

    async def run(self, context, operation):
        assert context == CONTEXT
        self.calls += 1
        if self.calls == 2:
            raise TenantDatabaseUnavailable("commit unavailable")
        return await operation(RotationPrepareTransaction())


def test_rotation_discards_the_new_secret_if_the_database_commit_fails() -> None:
    executor = FailingRotationCommitExecutor()
    secrets = RecordingSecretStore()
    repository = PostgresUserBasemapConnectionRepository(executor, secrets)

    with pytest.raises(UserConnectionStoreUnavailable):
        asyncio.run(
            repository.rotate_api_key(
                CONTEXT,
                CONNECTION_ID,
                0,
                "client-visible-browser-key",
                "request-basemap-rotation",
            )
        )

    assert executor.calls == 2
    assert secrets.created == 1
    assert secrets.discarded == [SECRET_ARN]


class NoProjectAccessTransaction:
    async def fetch_one(self, statement, parameters=()):
        del parameters
        if "FROM app.organization_memberships" in statement:
            return ("member",)
        if "FROM app.projects project" in statement:
            return (None,)
        raise AssertionError(statement)

    async def fetch_all(self, statement, parameters=()):
        raise AssertionError((statement, parameters))

    async def execute(self, statement, parameters=()):
        raise AssertionError((statement, parameters))


class SingleTransactionExecutor:
    async def run(self, context, operation):
        assert context == CONTEXT
        return await operation(NoProjectAccessTransaction())


def test_style_resolution_checks_project_access_before_reading_secrets() -> None:
    secrets = RecordingSecretStore()
    repository = PostgresUserBasemapConnectionRepository(SingleTransactionExecutor(), secrets)

    with pytest.raises(UserConnectionAccessDenied):
        asyncio.run(
            repository.resolve_style(
                CONTEXT,
                PROJECT_ID,
                BINDING_ID,
                "dark",
                "request-basemap-style",
            )
        )

    assert secrets.reads == 0


class CartoResolutionTransaction:
    async def fetch_one(self, statement, parameters=()):
        del parameters
        if "FROM app.organization_memberships" in statement:
            return ("member",)
        if "FROM app.projects project" in statement:
            return ("viewer",)
        if "prepare_project_basemap_style_resolution" in statement:
            return ("carto", CONNECTION_ID, "CARTO basemaps", SECRET_ARN, 2)
        raise AssertionError(statement)

    async def fetch_all(self, statement, parameters=()):
        raise AssertionError((statement, parameters))

    async def execute(self, statement, parameters=()):
        assert "INSERT INTO app.activity_events" in statement
        assert parameters[3] == "project.basemap_style.resolved"


class CartoResolutionExecutor:
    async def run(self, context, operation):
        assert context == CONTEXT
        return await operation(CartoResolutionTransaction())


def test_carto_resolution_builds_only_the_bounded_keyed_raster_template() -> None:
    secrets = RecordingSecretStore()
    repository = PostgresUserBasemapConnectionRepository(CartoResolutionExecutor(), secrets)

    resolved = asyncio.run(
        repository.resolve_style(
            CONTEXT,
            PROJECT_ID,
            BINDING_ID,
            "positron",
            "request-carto-basemap",
        )
    )

    assert resolved.provider == "carto"
    assert resolved.resource_kind == "raster"
    assert resolved.resource_url == (
        "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png?key=client-visible-browser-key"
    )
    assert secrets.reads == 1
