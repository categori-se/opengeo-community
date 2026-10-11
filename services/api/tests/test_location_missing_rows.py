import asyncio
from uuid import uuid4

import pytest

from opengeo_api.ingestion import PostgresIngestionRepository
from opengeo_api.location_links import PostgresLocationLinksRepository
from opengeo_api.tenant_database import TenantContext
from opengeo_api.workspace_collections import PostgresCollectionRepository
from opengeo_api.workspace_locations import LocationNotFound, PostgresLocationRepository
from test_ingestion import ORG_ID, USER_ID, FakeExecutor, FakeStorage, FakeTransaction


@pytest.mark.parametrize("view", ["parent", "links"])
def test_missing_location_after_authorization_returns_not_found(view):
    context = TenantContext(USER_ID, ORG_ID)
    transaction = FakeTransaction(one=[(1, USER_ID, USER_ID, 1, "owner"), None])
    executor = FakeExecutor([transaction])
    locations = PostgresLocationRepository(executor)
    if view == "parent":
        operation = locations.parent(context, uuid4())
    else:
        links = PostgresLocationLinksRepository(
            executor,
            locations,
            PostgresCollectionRepository(executor),
            PostgresIngestionRepository(executor, FakeStorage()),
        )
        operation = links.read(context, uuid4())
    with pytest.raises(LocationNotFound):
        asyncio.run(operation)
    assert not any(call[0] == "execute" for call in transaction.calls)


def test_missing_parent_document_returns_not_found_without_exposing_a_partial_parent():
    context = TenantContext(USER_ID, ORG_ID)
    transaction = FakeTransaction(
        one=[
            (1, USER_ID, USER_ID, 1, "owner"),
            (1,),
            (uuid4(), [], None),
            (1, USER_ID, USER_ID, 1, "owner"),
            None,
        ]
    )
    locations = PostgresLocationRepository(FakeExecutor([transaction]))
    with pytest.raises(LocationNotFound):
        asyncio.run(locations.parent(context, uuid4()))
