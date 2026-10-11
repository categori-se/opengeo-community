import asyncio
from types import SimpleNamespace
from uuid import UUID

import pytest

from opengeo_api.authorization import Action
from opengeo_api.catalog import CatalogAccessDenied, CatalogConflict, CatalogNotFound
from opengeo_api.managed_display_access import ManagedDisplayRepository
from test_layer_archive_access import tiled_descriptor

ORG, PROJECT, DATASET, VERSION, DISPLAY = [UUID(int=n) for n in range(1, 6)]
CONTEXT = SimpleNamespace(organization_id=ORG)


class Catalog:
    def __init__(self):
        self.active = True
        self.allowed = True
        self.queries = []
        self.actions = []
        self.rows = [[DISPLAY, "Display", None, tiled_descriptor()]]

    async def _run(self, context, operation):
        return await operation(self)

    async def _access(self, tx, context, project, dataset):
        assert (context, project, dataset) == (CONTEXT, PROJECT, DATASET)
        if not self.allowed:
            raise CatalogAccessDenied()
        return "authorized"

    def _require(self, action, roles):
        assert roles == "authorized"
        self.actions.append(action)

    async def fetch_one(self, sql, args):
        assert "state='active'" in sql
        assert args == (ORG, DATASET, VERSION)
        return [VERSION] if self.active else None

    async def fetch_all(self, sql, args):
        self.queries.append((sql, args))
        assert "source_version IS NULL AND enabled" in sql
        assert args[:4] == (ORG, PROJECT, DATASET, VERSION)
        return self.rows


def run(operation):
    return asyncio.run(operation)


def test_listing_is_version_bound_without_signing_or_storage():
    catalog = Catalog()
    store = ManagedDisplayRepository(catalog, lambda *args: pytest.fail("storage used"))
    result = run(store.list(CONTEXT, PROJECT, DATASET, VERSION))
    assert result["dataset_version_id"] == VERSION
    assert "source_version" not in result and "objects" not in result["archives"][0]
    assert catalog.actions == [Action.DATASET_VERSION_READ]


@pytest.mark.parametrize("failure", ["denied", "inactive", "absent", "geojson", "too_many"])
def test_fail_closed_before_ticket_issue(failure):
    catalog = Catalog()
    if failure == "denied":
        catalog.allowed = False
    elif failure == "inactive":
        catalog.active = False
    elif failure == "absent":
        catalog.rows = []
    elif failure == "too_many":
        catalog.rows *= 21
    else:
        from test_layer_archive_access import descriptor

        catalog.rows[0][3] = descriptor()
    store = ManagedDisplayRepository(catalog, lambda *args: pytest.fail("storage used"))
    with pytest.raises((CatalogAccessDenied, CatalogNotFound, CatalogConflict)):
        run(store.read_tickets(CONTEXT, PROJECT, DATASET, VERSION, DISPLAY))


@pytest.mark.parametrize("revoked", [False, True])
def test_tickets_require_download_permission_and_reauthorization(revoked):
    catalog = Catalog()
    calls = []

    class Storage:
        def __init__(self, bucket, prefix, owner):
            assert (bucket, prefix, owner) == ("fixture-bucket", "private/", "123456789012")

        def sign_download(self, key, version):
            calls.append((key, version))
            if revoked:
                catalog.allowed = False
            return {"url": "fixture-only"}

    operation = ManagedDisplayRepository(catalog, Storage).read_tickets(
        CONTEXT, PROJECT, DATASET, VERSION, DISPLAY
    )
    if revoked:
        with pytest.raises(CatalogAccessDenied):
            run(operation)
    else:
        result = run(operation)
        assert result["dataset_version_id"] == VERSION
        assert "source_url" not in result
        assert catalog.actions.count(Action.DATASET_DOWNLOAD) == 2
    assert calls == [("private/copy.geojson", "exact-version")]


def test_http_paths_cost_gate_and_private_cache_contract():
    from opengeo_api.managed_display_access import repository
    from test_catalog_routes import (
        ORG_ID,
        USER_ID,
        FakeCatalogRepository,
        api_client,
        headers,
    )

    calls = []

    class Store:
        async def list(self, context, project, dataset, version):
            assert (context.organization_id, context.user_id) == (ORG_ID, USER_ID)
            calls.append((project, dataset, version))
            return {"dataset_id": dataset, "dataset_version_id": version, "archives": []}

        async def read_tickets(self, context, project, dataset, version, display):
            await self.list(context, project, dataset, version)
            assert display == DISPLAY
            return {"objects": []}

    client = api_client(FakeCatalogRepository())
    client.app.dependency_overrides[repository] = Store
    path = f"/projects/{PROJECT}/datasets/{DATASET}/versions/{VERSION}/displays"
    response = client.get(path, headers=headers())
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    for consent in [False, "true", 1, None]:
        response = client.post(
            f"{path}/{DISPLAY}/read",
            headers=headers(),
            json={"acknowledge_storage_cost": consent},
        )
        assert response.status_code == 422
    assert len(calls) == 1
    response = client.post(
        f"{path}/{DISPLAY}/read",
        headers=headers(),
        json={"acknowledge_storage_cost": True},
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert calls == [(PROJECT, DATASET, VERSION)] * 2
    assert client.get(path).status_code == 401
