from datetime import UTC, datetime
from uuid import UUID

from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.ingestion import Page
from opengeo_api.processing_dispatch import ProcessingDispatchUnavailable
from opengeo_api.source_discoveries import (
    SourceDiscoveryAccessDenied,
    SourceDiscoveryJob,
    SourceDiscoverySubmission,
)

USER_ID = UUID("20000000-0000-4000-8000-000000000001")
ORG_ID = UUID("10000000-0000-4000-8000-000000000001")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000001")
JOB_ID = UUID("86000000-0000-4000-8000-000000000001")
IDEMPOTENCY_KEY = UUID("88000000-0000-4000-8000-000000000001")
NOW = datetime(2026, 8, 30, 12, tzinfo=UTC)


class PassingProbe:
    async def check(self) -> None:
        pass


class FakeVerifier:
    async def verify(self, token: str) -> VerifiedAccessToken:
        assert token == "valid-token"
        return VerifiedAccessToken("subject", "client", "user", (), ())


class FakePrincipalRepository:
    async def resolve(self, subject: str) -> Principal:
        assert subject == "subject"
        return Principal(
            user_id=USER_ID,
            subject=subject,
            email="user@example.test",
            display_name="User",
            memberships=(OrganizationMembership(ORG_ID, "member"),),
        )


def discovery_job(*, state: str = "queued", result=None) -> SourceDiscoveryJob:
    return SourceDiscoveryJob(
        job_id=JOB_ID,
        project_id=PROJECT_ID,
        source_type="arcgis",
        kind="catalog",
        service_url="https://example.test/arcgis/rest/services/open/FeatureServer",
        collection_ref=None,
        request_checksum_sha256="a" * 64,
        idempotency_key=IDEMPOTENCY_KEY,
        state=state,
        result=result,
        error_code=None,
        attempt_count=0,
        created_by=USER_ID,
        created_at=NOW,
        started_at=None,
        finished_at=None,
    )


class MemoryRepository:
    def __init__(self) -> None:
        self.job = discovery_job()
        self.calls: list[tuple] = []

    async def create(self, context, project_id, request, request_id):
        self.calls.append(("create", context, project_id, request, request_id))
        return SourceDiscoverySubmission(self.job, True)

    async def list(self, context, project_id, page: Page):
        self.calls.append(("list", context, project_id, page))
        return (self.job,)

    async def get(self, context, project_id, job_id):
        self.calls.append(("get", context, project_id, job_id))
        return self.job

    async def cancel(self, context, project_id, job_id, request_id):
        self.calls.append(("cancel", context, project_id, job_id, request_id))
        self.job = discovery_job(state="cancelled")
        return self.job


class DeniedRepository(MemoryRepository):
    async def create(self, *args, **kwargs):
        del args, kwargs
        raise SourceDiscoveryAccessDenied("must remain private")


class Dispatcher:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.job_ids: list[UUID] = []

    @property
    def available(self) -> bool:
        return not self.fail

    async def dispatch_external_source_discovery(self, job_id: UUID) -> None:
        self.job_ids.append(job_id)
        if self.fail:
            raise ProcessingDispatchUnavailable("private queue detail")


def api_client(repository=None, dispatcher=None) -> TestClient:
    return TestClient(
        create_app(
            settings=Settings(env="test", expose_docs=True),
            readiness_probe=PassingProbe(),
            token_verifier=FakeVerifier(),
            principal_repository=FakePrincipalRepository(),
            source_discovery_repository=repository or MemoryRepository(),
            external_source_discovery_dispatcher=dispatcher or Dispatcher(),
        )
    )


def headers() -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(ORG_ID),
        "X-Request-ID": "request-source-discovery-123",
    }


def url(suffix: str = "") -> str:
    return f"/projects/{PROJECT_ID}/source-discoveries{suffix}"


def payload(**changes) -> dict[str, object]:
    value: dict[str, object] = {
        "source_type": "arcgis",
        "kind": "catalog",
        "service_url": "https://example.test/arcgis/rest/services/open/FeatureServer",
        "collection_ref": None,
        "idempotency_key": str(IDEMPOTENCY_KEY),
    }
    value.update(changes)
    return value


def test_create_queues_only_the_persisted_job_identity() -> None:
    repository = MemoryRepository()
    dispatcher = Dispatcher()
    response = api_client(repository, dispatcher).post(url(), headers=headers(), json=payload())

    assert response.status_code == 202
    assert response.json()["state"] == "queued"
    assert response.json()["cancellable"] is True
    assert dispatcher.job_ids == [JOB_ID]
    assert repository.calls[0][0] == "create"
    assert repository.calls[0][3].service_url.endswith("/FeatureServer")


def test_catalog_request_rejects_credentials_queries_and_collection_selection() -> None:
    client = api_client()
    candidates = (
        payload(service_url="https://user:secret@example.test/FeatureServer"),
        payload(service_url="https://example.test/FeatureServer?token=secret"),
        payload(collection_ref="1"),
    )
    for candidate in candidates:
        response = client.post(url(), headers=headers(), json=candidate)
        assert response.status_code == 422
        assert "secret" not in response.text


def test_collection_request_requires_a_bounded_safe_reference() -> None:
    response = api_client().post(
        url(),
        headers=headers(),
        json=payload(kind="collection", collection_ref="100000"),
    )
    assert response.status_code == 422


def test_list_get_and_cancel_preserve_project_scope() -> None:
    repository = MemoryRepository()
    client = api_client(repository)

    listed = client.get(url("?limit=5&offset=0"), headers=headers())
    loaded = client.get(url(f"/{JOB_ID}"), headers=headers())
    cancelled = client.post(url(f"/{JOB_ID}/cancel"), headers=headers())

    assert listed.status_code == loaded.status_code == cancelled.status_code == 200
    assert cancelled.json()["state"] == "cancelled"
    assert cancelled.json()["cancellable"] is False
    assert [call[0] for call in repository.calls] == ["list", "get", "cancel"]


def test_completed_result_is_strictly_shaped() -> None:
    repository = MemoryRepository()
    repository.job = discovery_job(
        state="completed",
        result={
            "schema_version": "opengeo.external-source-discovery-result.1.0.0",
            "source_type": "arcgis",
            "kind": "catalog",
            "service_url": "https://example.test/arcgis/rest/services/open/FeatureServer",
            "collections": [
                {
                    "ref": "7",
                    "name": "Parcels",
                    "title": "Parcels",
                    "geometry_type": "MultiPolygon",
                    "bounds": None,
                }
            ],
            "source_definition": None,
            "limitations": ["Select one layer to inspect."],
        },
    )
    response = api_client(repository).get(url(f"/{JOB_ID}"), headers=headers())

    assert response.status_code == 200
    assert response.json()["result"]["collections"][0]["ref"] == "7"


def test_authorization_and_dispatch_failures_are_redacted() -> None:
    denied = api_client(DeniedRepository()).post(url(), headers=headers(), json=payload())
    unavailable = api_client(MemoryRepository(), Dispatcher(fail=True)).post(
        url(), headers=headers(), json=payload()
    )

    assert denied.status_code == 403
    assert denied.json() == {"detail": "action_forbidden"}
    assert unavailable.status_code == 503
    assert unavailable.json() == {"detail": "external_source_discovery_dispatch_unavailable"}
    assert "private" not in unavailable.text


def test_dataset_discovery_metadata_requires_dataset_access():
    from opengeo_api.ingestion import IngestionAccessDenied

    dataset_id = UUID("80000000-0000-4000-8000-000000000001")

    class Records(MemoryRepository):
        reads = 0

        async def get_dataset_document(self, context, selected):
            self.reads += 1
            assert selected == dataset_id and context.organization_id == ORG_ID
            return {"dataset_id": str(selected), "document": None}

    class Access:
        denied = False

        async def get_catalog_dataset(self, context, selected):
            if self.denied:
                raise IngestionAccessDenied("denied")

    records, access = Records(), Access()
    with api_client(records) as client:
        client.app.state.ingestion_repository = access
        path = f"/datasets/{dataset_id}/discovery-metadata"
        response = client.get(path, headers=headers())
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        access.denied = True
        assert client.get(path, headers=headers()).status_code == 403
        assert records.reads == 1


def test_large_metadata_download_verifies_exact_bytes_and_rechecks_layer_authority():
    import hashlib
    from types import SimpleNamespace

    from opengeo_api.ingestion import IngestionAccessDenied
    from opengeo_api.source_archiver import discovery_metadata_key

    body = b" " * 32_769
    document = {
        "status": "retained_object",
        "body_base64": None,
        "byte_length": len(body),
        "sha256": hashlib.sha256(body).hexdigest(),
        "retrieved_at": NOW.isoformat(),
        "object": {
            "bucket": "private-geodata",
            "key": discovery_metadata_key(ORG_ID, PROJECT_ID, JOB_ID),
            "version_id": "immutable-first",
            "etag": "a" * 32,
            "content_type": "application/octet-stream",
        },
    }

    class Records(MemoryRepository):
        async def get_dataset_document(self, context, selected):
            return {
                "dataset_id": str(selected),
                "discovery_job_id": str(JOB_ID),
                "source_type": "arcgis",
                "service_url": "https://example.test/FeatureServer",
                "collection_ref": "0",
                "document": document,
            }

    class Access:
        denied = False
        calls = 0

        async def get_catalog_dataset(self, context, selected):
            self.calls += 1
            if self.denied:
                raise IngestionAccessDenied("denied")

    class Storage:
        calls = 0
        revoke = False
        corrupt = False

        async def read_exact_object(self, spec):
            self.calls += 1
            assert spec.maximum_bytes == 2_097_152 and spec.version_id == "immutable-first"
            if self.revoke:
                access.denied = True
            return SimpleNamespace(body=b"x" * len(body) if self.corrupt else body)

    records, access, storage = Records(), Access(), Storage()
    with api_client(records) as client:
        client.app.state.ingestion_repository = access
        client.app.state.download_storage = storage
        path = f"/datasets/{USER_ID}/discovery-metadata"
        metadata = client.get(path, headers=headers())
        assert metadata.status_code == 200 and "object" not in metadata.json()["document"]
        assert storage.calls == 0
        response = client.get(path + "/response", headers=headers())
        assert response.status_code == 200 and response.content == body
        assert response.headers["content-length"] == str(len(body))
        assert response.headers["x-opengeo-source-sha256"] == document["sha256"]
        assert response.headers["x-opengeo-discovery-job-id"] == str(JOB_ID)
        assert response.headers["content-type"] == "application/octet-stream"
        assert response.headers["cache-control"] == "no-store"
        storage.revoke = True
        assert client.get(path + "/response", headers=headers()).status_code == 403
        before = storage.calls
        assert client.get(path + "/response", headers=headers()).status_code == 403
        assert storage.calls == before
        access.denied, storage.revoke, storage.corrupt = False, False, True
        assert client.get(path + "/response", headers=headers()).status_code == 503
        document["object"]["key"] = discovery_metadata_key(USER_ID, PROJECT_ID, JOB_ID)
        assert client.get(path + "/response", headers=headers()).status_code == 503
        document["status"] = "not_retained_size"
        assert client.get(path + "/response", headers=headers()).status_code == 404


def test_metadata_refresh_candidate_requires_layer_edit_and_does_not_dispatch() -> None:
    from types import SimpleNamespace

    class Datasets:
        editable = False

        async def get_catalog_dataset(self, context, dataset_id):
            assert context.organization_id == ORG_ID
            assert dataset_id == USER_ID
            return SimpleNamespace(capabilities=SimpleNamespace(edit=self.editable))

    class Candidates(MemoryRepository):
        async def get_refresh_document(self, context, dataset_id, project_id, job_id):
            self.calls.append((dataset_id, project_id, job_id))
            return {"dataset_id": str(dataset_id), "source_revision": 2}

    repository, dispatcher, datasets = Candidates(), Dispatcher(), Datasets()
    client = api_client(repository, dispatcher)
    client.app.state.ingestion_repository = datasets
    path = f"/datasets/{USER_ID}/metadata-refresh/{PROJECT_ID}/{JOB_ID}"
    assert client.get(path, headers=headers()).status_code == 403
    assert repository.calls == []
    datasets.editable = True
    response = client.get(path, headers=headers())
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["source_revision"] == 2
    assert repository.calls == [(USER_ID, PROJECT_ID, JOB_ID)]
    assert dispatcher.job_ids == []


def retained_refresh_client(*, inline=False):
    import base64
    import copy
    from hashlib import sha256
    from types import SimpleNamespace

    from opengeo_api.ingestion import IngestionAccessDenied
    from opengeo_api.metadata_refresh import append_refresh_source
    from opengeo_api.resource_knowledge import empty_knowledge
    from opengeo_api.source_archiver import discovery_metadata_key

    body = b' {"name": "source"}\n' if inline else b' {"name": "source"}' + b" " * 32_769
    document = {
        "status": "retained" if inline else "retained_object",
        "body_base64": base64.b64encode(body).decode() if inline else None,
        "byte_length": len(body),
        "sha256": sha256(body).hexdigest(),
        "retrieved_at": NOW.isoformat(),
    }
    if not inline:
        document["object"] = {
            "bucket": "private-geodata",
            "key": discovery_metadata_key(ORG_ID, PROJECT_ID, JOB_ID),
            "version_id": "immutable-first",
            "etag": "a" * 32,
            "content_type": "application/octet-stream",
        }
    candidate = {
        "dataset_id": str(USER_ID),
        "project_id": str(PROJECT_ID),
        "discovery_job_id": str(JOB_ID),
        "source_type": "arcgis",
        "service_url": "https://example.test/FeatureServer",
        "collection_ref": "0",
        "source_revision": 2,
        "document": document,
    }

    class Candidates(MemoryRepository):
        changed = False

        async def get_refresh_document(self, context, dataset_id, project_id, job_id):
            assert (context.organization_id, dataset_id, project_id, job_id) == (
                ORG_ID,
                USER_ID,
                PROJECT_ID,
                JOB_ID,
            )
            self.calls.append("candidate")
            return {**copy.deepcopy(candidate), "source_revision": 3 if self.changed else 2}

        async def get_knowledge_source_document(self, context, dataset_id, job_id):
            assert (context.organization_id, dataset_id, job_id) == (ORG_ID, USER_ID, JOB_ID)
            self.calls.append("accepted-source")
            return copy.deepcopy(candidate)

    class Datasets:
        denied = False
        editable = True
        writes = 0
        knowledge = empty_knowledge()

        async def get_catalog_dataset(self, context, dataset_id):
            if self.denied:
                raise IngestionAccessDenied("denied")
            return SimpleNamespace(capabilities=SimpleNamespace(edit=self.editable))

        async def save_dataset_knowledge(
            self, context, dataset_id, document, expected_version, *, refresh
        ):
            if self.denied:
                raise IngestionAccessDenied("denied")
            assert expected_version == 0 and refresh.source_revision == 2
            row = ("arcgis", candidate["service_url"], "0", candidate["document"], 2)
            self.knowledge = append_refresh_source(
                self.knowledge,
                row,
                JOB_ID,
                dataset_id=USER_ID,
                project_id=PROJECT_ID,
                verified_document=refresh.verified_document,
            )
            self.writes += 1
            return {"dataset_id": str(USER_ID), "version": 1, "document": self.knowledge}

    class Storage:
        calls = 0
        revoke = False
        change_source = False
        corrupt = False

        async def read_exact_object(self, spec):
            assert spec.maximum_bytes == 2_097_152 and spec.version_id == "immutable-first"
            self.calls += 1
            if self.revoke:
                datasets.denied = True
            if self.change_source:
                records.changed = True
            return SimpleNamespace(body=b"x" * len(body) if self.corrupt else body)

    records, datasets, storage, dispatcher = Candidates(), Datasets(), Storage(), Dispatcher()
    client = api_client(records, dispatcher)
    client.app.state.ingestion_repository = datasets
    client.app.state.download_storage = storage
    return client, records, datasets, storage, dispatcher, candidate, body


def test_stored_refresh_review_and_accept_preserve_exact_bytes_without_exposing_storage():
    for inline in [False, True]:
        client, _records, datasets, storage, dispatcher, candidate, body = retained_refresh_client(
            inline=inline
        )
        with client:
            path = f"/datasets/{USER_ID}/metadata-refresh/{PROJECT_ID}/{JOB_ID}"
            preview = client.get(path, headers=headers())
            assert preview.status_code == 200 and "object" not in preview.json()["document"]
            assert storage.calls == 0
            reviewed = client.get(path + "/response", headers=headers())
            assert reviewed.status_code == 200 and reviewed.content == body
            assert reviewed.headers["cache-control"] == "no-store"
            assert reviewed.headers["x-content-type-options"] == "nosniff"
            assert reviewed.headers["x-opengeo-source-sha256"] == candidate["document"]["sha256"]
            accepted = client.post(
                path + "/accept",
                headers=headers(),
                json={"expected_version": 0, "source_revision": 2},
            )
            assert accepted.status_code == 200 and datasets.writes == 1
            source = accepted.json()["document"]["metadata"]["source"][0]
            if inline:
                assert source["content"].encode() == body and storage.calls == 0
            else:
                assert "content" not in source and "object" not in source
                assert source["retainedResponse"]["byteLength"] == len(body) and storage.calls == 2
            assert dispatcher.job_ids == []


def test_stored_refresh_and_historical_reads_stop_on_revocation_and_corrupt_bytes():
    client, _records, datasets, storage, _, candidate, body = retained_refresh_client()
    with client:
        path = f"/datasets/{USER_ID}/metadata-refresh/{PROJECT_ID}/{JOB_ID}"
        historical = f"/datasets/{USER_ID}/metadata-sources/{JOB_ID}/response"
        datasets.editable = False
        assert client.get(path + "/response", headers=headers()).status_code == 403
        assert (
            client.post(
                path + "/accept",
                headers=headers(),
                json={"expected_version": 0, "source_revision": 2},
            ).status_code
            == 403
        )
        assert storage.calls == 0
        # Accepted Layer metadata is readable by a reader, without edit authority.
        assert client.get(historical, headers=headers()).content == body
        storage.revoke = True
        assert client.get(historical, headers=headers()).status_code == 403
        before = storage.calls
        assert (
            client.get(historical, headers=headers()).status_code == 403 and storage.calls == before
        )
        datasets.denied, datasets.editable, storage.revoke = False, True, False
        storage.corrupt = True
        assert client.get(path + "/response", headers=headers()).status_code == 503
        assert (
            client.post(
                path + "/accept",
                headers=headers(),
                json={"expected_version": 0, "source_revision": 2},
            ).status_code
            == 503
        )
        assert datasets.writes == 0
        storage.corrupt = False
        candidate["document"]["object"]["key"] = candidate["document"]["object"]["key"].replace(
            str(PROJECT_ID), str(USER_ID)
        )
        before = storage.calls
        assert (
            client.get(path + "/response", headers=headers()).status_code == 503
            and storage.calls == before
        )


def test_refresh_response_refuses_source_change_during_exact_storage_read():
    client, _, datasets, storage, _, _, _ = retained_refresh_client()
    with client:
        storage.change_source = True
        path = f"/datasets/{USER_ID}/metadata-refresh/{PROJECT_ID}/{JOB_ID}/response"
        assert client.get(path, headers=headers()).status_code == 409
        assert datasets.writes == 0 and storage.calls == 1
