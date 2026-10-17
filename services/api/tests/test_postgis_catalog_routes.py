import asyncio
import json
from dataclasses import asdict, replace
from urllib.parse import parse_qs
from uuid import UUID

import pytest

from opengeo_api.connections import ConnectionAccessDenied
from opengeo_api.postgis_catalog_store import (
    CatalogDiscoveryJob,
    PostgresCatalogDiscoveryRepository,
)
from opengeo_api.processing_dispatch import (
    AwsSqsConnectionVerificationDispatcher,
    ProcessingDispatchUnavailable,
)
from opengeo_api.tenant_database import TenantContext
from test_connection_routes import (
    CONNECTION_ID,
    NOW,
    ORG_ID,
    PROJECT_ID,
    USER_ID,
    FakeConnectionRepository,
    VerificationDispatcher,
    api_app,
    connection,
    headers,
    request,
)
from test_connection_routes import inline_threadpool as inline_threadpool
from test_processing_dispatch import Credentials, Transport, settings

JOB = UUID("83000000-0000-4000-8000-000000000479")
KEY = UUID("84000000-0000-4000-8000-000000000479")
PATH = f"/projects/{PROJECT_ID}/connections/{CONNECTION_ID}/catalog-discoveries"


def job(state="queued", count=0):
    return CatalogDiscoveryJob(
        JOB, CONNECTION_ID, 1, state, 0, count, False, None, USER_ID, NOW, None, None
    )


class Store:
    def __init__(self):
        self.calls = []

    async def list_jobs(self, *args):
        self.calls.append(("list", *args))
        return (job(),)

    async def request(self, *args):
        self.calls.append(("request", *args))
        return job()

    async def get(self, *args):
        self.calls.append(("get", *args))
        return job("completed", 1)

    async def cancel(self, *args):
        self.calls.append(("cancel", *args))
        return job("cancelled")

    async def relations(self, *args):
        self.calls.append(("relations", *args))
        return ((1, {"schema": "gis", "name": "roads", "stable_key": "id"}),), None


class Dispatcher(VerificationDispatcher):
    catalog_available = True
    failure = False

    async def dispatch_connection_catalog_discovery(self, discovery_id):
        self.dispatched.append(discovery_id)
        if self.failure:
            raise ProcessingDispatchUnavailable("unavailable")


def setup(dispatcher=None):
    dispatcher = dispatcher or Dispatcher()
    app = api_app(FakeConnectionRepository(), dispatcher)
    store = Store()
    app.state.connection_catalog_repository = store
    return app, store, dispatcher


def test_catalog_routes_are_authorized_reads_and_bounded_descriptor_pages():
    app, store, dispatcher = setup()
    assert request(app, "GET", PATH).status_code == 401
    listing = request(app, "GET", PATH, request_headers=headers())
    assert listing.status_code == 200
    assert listing.json()["available"] is True
    assert listing.json()["items"][0]["discovery_id"] == str(JOB)
    assert request(app, "GET", PATH + f"/{JOB}", request_headers=headers()).status_code == 200
    page = request(app, "GET", PATH + f"/{JOB}/relations", request_headers=headers())
    assert page.status_code == 200
    assert page.json()["next_ordinal"] is None
    assert page.json()["items"][0]["descriptor"]["stable_key"] == "id"
    assert store.calls[-1][-1] == 0
    assert all(call[1] == TenantContext(USER_ID, ORG_ID) for call in store.calls)
    assert dispatcher.dispatched == []
    assert "secret_arn" not in listing.text + page.text


def test_discovery_dispatch_is_opt_in_identity_only_and_same_key_recovers_submission(monkeypatch):
    async def immediate(function, *args):
        return function(*args)

    monkeypatch.setattr(asyncio, "to_thread", immediate)
    transport = Transport()
    queue = AwsSqsConnectionVerificationDispatcher(
        settings(), credentials=Credentials(), transport=transport
    )
    assert queue.catalog_available is False
    with pytest.raises(ProcessingDispatchUnavailable):
        asyncio.run(queue.dispatch_connection_catalog_discovery(JOB))
    assert transport.calls == []
    queue = AwsSqsConnectionVerificationDispatcher(
        settings().model_copy(update={"connection_catalog_discovery_enabled": True}),
        credentials=Credentials(),
        transport=transport,
    )
    asyncio.run(queue.dispatch_connection_catalog_discovery(JOB))
    fields = parse_qs(transport.calls[0][2].decode())
    assert json.loads(fields["MessageBody"][0]) == {
        "schema": "opengeo.connection-catalog-discovery.command.v1",
        "discovery_id": str(JOB),
    }
    disabled = VerificationDispatcher()
    app, store, _ = setup(disabled)
    body = {"expected_revision": 1, "request_key": str(KEY)}
    response = request(app, "POST", PATH, request_headers=headers(), json_body=body)
    assert response.status_code == 503 and not store.calls
    app, store, dispatcher = setup()
    dispatcher.failure = True
    first = request(app, "POST", PATH, request_headers=headers(), json_body=body)
    assert first.status_code == 503
    dispatcher.failure = False
    second = request(app, "POST", PATH, request_headers=headers(), json_body=body)
    assert second.status_code == 202
    assert [call[-1] for call in store.calls] == [KEY, KEY]
    assert dispatcher.dispatched == [JOB, JOB]
    invalid = request(
        app, "POST", PATH, request_headers=headers(), json_body={**body, "sql": "SELECT password"}
    )
    assert invalid.status_code == 422 and len(store.calls) == 2
    cancelled = request(app, "DELETE", PATH + f"/{JOB}", request_headers=headers())
    assert cancelled.status_code == 200 and cancelled.json()["state"] == "cancelled"
    assert dispatcher.dispatched == [JOB, JOB]


def test_store_checks_connection_authority_and_pages_without_aggregating_descriptors():
    class Connections:
        manage = False

        async def get_connection(self, *args):
            value = connection()
            return replace(value, capabilities=replace(value.capabilities, manage=self.manage))

    class Transaction:
        def __init__(self):
            self.calls = []

        async def fetch_one(self, statement, parameters=()):
            self.calls.append((statement, parameters))
            return tuple(asdict(job("completed", 11)).values())

        async def fetch_all(self, statement, parameters=()):
            self.calls.append((statement, parameters))
            return [(n, {"schema": "gis", "name": f"table{n}"}) for n in range(1, 11)]

    class Executor:
        tx = Transaction()

        async def run(self, context, operation):
            assert context == TenantContext(USER_ID, ORG_ID)
            return await operation(self.tx)

    connections = Connections()
    executor = Executor()
    repository = PostgresCatalogDiscoveryRepository(executor, connections)
    context = TenantContext(USER_ID, ORG_ID)
    with pytest.raises(ConnectionAccessDenied):
        asyncio.run(repository.request(context, PROJECT_ID, CONNECTION_ID, 1, KEY))
    assert not executor.tx.calls
    items, cursor = asyncio.run(repository.relations(context, PROJECT_ID, CONNECTION_ID, JOB, 0))
    assert len(items) == 10 and cursor == 10
    query, params = executor.tx.calls[-1]
    assert "LIMIT 10" in query and "jsonb_agg" not in query
    assert params == (ORG_ID, PROJECT_ID, JOB, 0)
