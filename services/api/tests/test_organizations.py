import asyncio
from uuid import UUID

import pytest

from opengeo_api.organizations import (
    OrganizationBackendUnavailable,
    PostgresOrganizationRepository,
)
from opengeo_api.tenant_database import TenantContext, TenantDatabaseUnavailable

USER_ID = UUID("20000000-0000-4000-8000-000000000001")
ORGANIZATION_ID = UUID("10000000-0000-4000-8000-000000000001")


class FakeExecutor:
    def __init__(self, row) -> None:
        self.row = row
        self.calls = []

    async def fetch_one(self, context, statement, parameters=()):
        self.calls.append((context, statement, parameters))
        return self.row


class FailingExecutor:
    async def fetch_one(self, context, statement, parameters=()):
        del context, statement, parameters
        raise TenantDatabaseUnavailable("secret backend reason")


def context() -> TenantContext:
    return TenantContext(user_id=USER_ID, organization_id=ORGANIZATION_ID)


def test_repository_maps_only_the_context_organization() -> None:
    executor = FakeExecutor((ORGANIZATION_ID, "Organization A", "organization-a", "active"))
    repository = PostgresOrganizationRepository(executor)

    result = asyncio.run(repository.get_current(context()))

    assert result is not None
    assert result.organization_id == ORGANIZATION_ID
    assert result.slug == "organization-a"
    assert executor.calls[0][0] == context()
    assert executor.calls[0][2] == (ORGANIZATION_ID,)
    assert "WHERE id = %s" in executor.calls[0][1]


@pytest.mark.parametrize(
    "row",
    [
        (ORGANIZATION_ID, "Organization A", "organization-a", "deleted"),
        ("not-a-uuid", "Organization A", "organization-a", "active"),
        (ORGANIZATION_ID,),
    ],
)
def test_repository_fails_closed_on_invalid_database_rows(row) -> None:
    repository = PostgresOrganizationRepository(FakeExecutor(row))

    with pytest.raises(OrganizationBackendUnavailable):
        asyncio.run(repository.get_current(context()))


def test_repository_sanitizes_executor_failures() -> None:
    repository = PostgresOrganizationRepository(FailingExecutor())

    with pytest.raises(OrganizationBackendUnavailable) as caught:
        asyncio.run(repository.get_current(context()))

    assert "secret" not in str(caught.value)
