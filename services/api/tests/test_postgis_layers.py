import asyncio
from dataclasses import replace
from uuid import UUID

import pytest

from opengeo_api.connections import ConnectionAccessDenied
from opengeo_api.external_sources import (
    ExternalSourceAccessDenied,
    ExternalSourceConflict,
    ExternalSourceDraft,
    ExternalSourceNotFound,
    PostgresExternalSourceRepository,
)
from opengeo_api.postgis_layers import (
    PostgisLayerSelection,
    PostgisPreviewFailure,
    PostgisPreviewLease,
    PostgresPostgisLayerRepository,
    RegisteredPostgisLayer,
)
from opengeo_api.tenant_database import TenantContext, TenantDatabaseConflict
from test_connection_routes import (
    CONNECTION_ID,
    ORG_ID,
    PROJECT_ID,
    USER_ID,
    FakeConnectionRepository,
    api_app,
    connection,
    headers,
    request,
)
from test_connection_routes import inline_threadpool as inline_threadpool

DATASET = UUID("93000000-0000-4000-8000-000000000479")
DISCOVERY = UUID("94000000-0000-4000-8000-000000000479")
PREVIEW = UUID("95000000-0000-4000-8000-000000000479")
KEY = UUID("96000000-0000-4000-8000-000000000479")
BBOX = (0.0, 0.0, 2.0, 2.0)
REGISTER_PATH = (
    f"/projects/{PROJECT_ID}/connections/{CONNECTION_ID}/catalog-discoveries/"
    f"{DISCOVERY}/relations/1/layers"
)
PREVIEW_PATH = f"/datasets/{DATASET}/postgis-preview"


def selection():
    return PostgisLayerSelection(1, "a" * 64, 'Shape " location', "Observations", None, None, KEY)


def result():
    return {
        "schemaVersion": "opengeo.postgis-preview.1.0.0", "previewId": str(PREVIEW),
        "datasetId": str(DATASET), "sourceVersion": 1, "connectionRevision": 1,
        "schemaFingerprint": "a" * 64, "observedAt": "2026-10-16T12:00:00Z",
        "bbox": list(BBOX), "limit": 100, "returned": 1, "truncated": False,
        "geojson": {"type": "FeatureCollection", "features": [{"type": "Feature", "id": "99",
            "properties": {"id": "99", "amount": "0.12345678901234567890"},
            "geometry": {"type": "Point", "coordinates": [1, 1]}}]},
        "propertyEncodings": {"id": "int64:string", "amount": "numeric:string"},
    }


class Store:
    state = "queued"
    failure = None

    def __init__(self):
        self.calls = []

    async def register(self, *args):
        self.calls.append(("register", args))
        if self.failure:
            raise self.failure
        return RegisteredPostgisLayer(DATASET, 1, True)

    async def prepare_preview(self, *args):
        self.calls.append(("prepare", args))
        if self.failure:
            raise self.failure
        return PostgisPreviewLease(PREVIEW, self.state)


class Client:
    available = True
    failure = None

    def __init__(self):
        self.calls = []
        self.value = result()

    async def preview(self, *args):
        self.calls.append(args)
        if self.failure:
            raise self.failure
        return self.value


def setup():
    app = api_app(FakeConnectionRepository())
    store, client = Store(), Client()
    app.state.postgis_layer_repository = store
    app.state.postgis_preview_client = client
    return app, store, client


def body():
    return {"expected_source_version": 1, "request_key": str(KEY), "bbox": list(BBOX)}


def test_registration_uses_frozen_authenticated_scope_and_rejects_untrusted_bindings():
    app, store, client = setup()
    payload = {
        "expected_connection_revision": 1, "schema_fingerprint_sha256": "a" * 64,
        "geometry_column": 'Shape " location', "name": "Observations", "request_key": str(KEY),
    }
    assert request(app, "POST", REGISTER_PATH, json_body=payload).status_code == 401
    response = request(app, "POST", REGISTER_PATH, request_headers=headers(), json_body=payload)
    assert response.status_code == 200
    assert response.json() == {"dataset_id": str(DATASET), "source_version": 1, "created": True}
    assert store.calls == [("register", (TenantContext(USER_ID, ORG_ID), PROJECT_ID,
                                        CONNECTION_ID, DISCOVERY, 1, selection()))]
    for invalid in ({**payload, "secret_arn": "never"},
                    {**payload, "expected_connection_revision": True},
                    {**payload, "geometry_column": "x\x00y"}):
        assert request(app, "POST", REGISTER_PATH, request_headers=headers(),
                       json_body=invalid).status_code == 422
    assert len(store.calls) == 1 and not client.calls


def test_preview_is_explicit_bounded_not_cached_and_does_not_replay_completed_bytes():
    app, store, client = setup()
    client.available = False
    assert request(app, "POST", PREVIEW_PATH, request_headers=headers(),
                   json_body=body()).status_code == 503
    assert not store.calls and not client.calls
    client.available = True
    response = request(app, "POST", PREVIEW_PATH, request_headers=headers(), json_body=body())
    assert response.status_code == 200 and response.json() == result()
    assert store.calls == [("prepare", (TenantContext(USER_ID, ORG_ID), DATASET, 1, KEY, BBOX))]
    assert client.calls == [(PREVIEW, DATASET, 1, BBOX)]
    for state in ("completed", "running", "failed"):
        store.state = state
        response = request(app, "POST", PREVIEW_PATH, request_headers=headers(), json_body=body())
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "postgis_preview_new_request_required"
    assert len(client.calls) == 1
    for invalid in ({**body(), "bbox": [0, 0, 0, 2]}, {**body(), "bbox": [True, 0, 2, 2]},
                    {**body(), "sql": "SELECT *"}, {**body(), "expected_source_version": True}):
        assert request(app, "POST", PREVIEW_PATH, request_headers=headers(),
                       json_body=invalid).status_code == 422


def test_preview_rejects_wrong_identity_and_sanitizes_stale_denied_and_failed_outcomes():
    app, store, client = setup()
    client.value = {**result(), "datasetId": str(ORG_ID)}
    assert request(app, "POST", PREVIEW_PATH, request_headers=headers(),
                   json_body=body()).status_code == 503
    for code, status in (("preview_stale", 409), ("preview_schema_changed", 409),
                         ("preview_limits_exceeded", 503), ("preview_timeout", 503)):
        client.failure = PostgisPreviewFailure(code)
        response = request(app, "POST", PREVIEW_PATH, request_headers=headers(), json_body=body())
        assert response.status_code == status and response.json()["detail"] == code
    for failure, status in ((ExternalSourceAccessDenied("deny"), 403),
                            (ExternalSourceNotFound("dataset"), 404),
                            (ExternalSourceConflict("postgis_source_conflict"), 409)):
        store.failure = failure
        response = request(app, "POST", PREVIEW_PATH, request_headers=headers(), json_body=body())
        assert response.status_code == status


class Transaction:
    authority = ("postgis", "active", True)

    def __init__(self):
        self.calls = []

    async def fetch_one(self, statement, parameters=()):
        self.calls.append((statement, parameters))
        if "register_external_postgis_layer" in statement:
            return DATASET, 1, False
        if "prepare_external_postgis_preview" in statement:
            return PREVIEW, "queued"
        return self.authority


class Executor:
    failure = None

    def __init__(self):
        self.tx = Transaction()

    async def run(self, context, operation):
        assert context == TenantContext(USER_ID, ORG_ID)
        if self.failure:
            raise self.failure
        return await operation(self.tx)


def test_repository_registration_requires_manage_and_uses_one_fixed_parameterized_function():
    class Connections:
        manage = False

        async def get_connection(self, *args):
            record = connection()
            return replace(record, capabilities=replace(record.capabilities, manage=self.manage))

    connections, executor = Connections(), Executor()
    repository = PostgresPostgisLayerRepository(executor, connections)
    args = (TenantContext(USER_ID, ORG_ID), PROJECT_ID, CONNECTION_ID, DISCOVERY, 1, selection())
    with pytest.raises(ConnectionAccessDenied):
        asyncio.run(repository.register(*args))
    assert not executor.tx.calls
    connections.manage = True
    registered = asyncio.run(repository.register(*args))
    assert registered == RegisteredPostgisLayer(DATASET, 1, False)
    sql, parameters = executor.tx.calls[-1]
    assert "FROM app.register_external_postgis_layer(" in sql
    assert 'Shape " location' not in sql
    assert parameters == (CONNECTION_ID, DISCOVERY, 1, 1, "a" * 64,
                          'Shape " location', "Observations", None, None, KEY)
    executor.failure = TenantDatabaseConflict("conflict")
    with pytest.raises(ExternalSourceConflict, match="postgis_source_conflict"):
        asyncio.run(repository.register(*args))


def test_repository_preview_reads_layer_grants_without_connection_manage_or_feature_persistence():
    class NoConnectionReads:
        async def get_connection(self, *args):
            pytest.fail("a Layer viewer must not need connection-manage access")

    executor = Executor()
    repository = PostgresPostgisLayerRepository(executor, NoConnectionReads())
    args = (TenantContext(USER_ID, ORG_ID), DATASET, 1, KEY, BBOX)
    assert asyncio.run(repository.prepare_preview(*args)) == PostgisPreviewLease(PREVIEW, "queued")
    authority_sql, authority_parameters = executor.tx.calls[0]
    assert "app.dataset_permissions" in authority_sql
    assert "app.effective_project_role(project.id)" in authority_sql
    assert authority_parameters[-2:] == (ORG_ID, DATASET)
    prepare_sql, parameters = executor.tx.calls[1]
    assert "app.prepare_external_postgis_preview(" in prepare_sql
    assert parameters[:3] == (DATASET, 1, KEY) and parameters[3].obj == list(BBOX)
    for authority, failure in ((None, ExternalSourceNotFound),
                               (("postgis", "active", False), ExternalSourceAccessDenied),
                               (("geojson", "active", True), ExternalSourceConflict)):
        executor.tx.authority = authority
        with pytest.raises(failure):
            asyncio.run(repository.prepare_preview(*args))


def test_generic_source_creation_cannot_create_credentialed_postgis_bindings():
    executor = Executor()
    repository = PostgresExternalSourceRepository(executor)
    draft = ExternalSourceDraft("Private", None, "internal", "postgis", "urn:fake", {}, ())
    with pytest.raises(ExternalSourceConflict, match="requires_catalog_registration"):
        asyncio.run(repository.create_source(
            TenantContext(USER_ID, ORG_ID), PROJECT_ID, draft, "req"
        ))
    assert not executor.tx.calls
