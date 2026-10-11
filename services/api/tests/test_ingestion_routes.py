from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.ingestion import (
    Dataset,
    DatasetCapabilities,
    IngestionConflict,
    IngestionStoreUnavailable,
    RepositoryObjectSource,
    UploadCompletion,
    UploadTicket,
)
from opengeo_api.s3_uploads import UploadForm, UploadObjectNotFound
from opengeo_api.tenant_database import TenantContext

USER_ID = UUID("20000000-0000-4000-8000-000000000001")
ORG_ID = UUID("10000000-0000-4000-8000-000000000001")
OTHER_ORG_ID = UUID("10000000-0000-4000-8000-000000000002")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000001")
DATASET_ID = UUID("80000000-0000-4000-8000-000000000001")
UPLOAD_ID = UUID("81000000-0000-4000-8000-000000000001")
VERSION_ID = UUID("83000000-0000-4000-8000-000000000001")
JOB_ID = UUID("84000000-0000-4000-8000-000000000001")
NOW = datetime(2026, 8, 20, 12, tzinfo=UTC)
SHA256 = "a" * 64


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


def dataset(*, processing: bool = False) -> Dataset:
    return Dataset(
        dataset_id=DATASET_ID,
        project_id=PROJECT_ID,
        name="Road network",
        description="Authoritative roads",
        classification="restricted",
        source_type="upload",
        format="geopackage",
        status="processing" if processing else "draft",
        owner_user_id=USER_ID,
        current_version_id=VERSION_ID if processing else None,
        current_version_number=1 if processing else None,
        current_version_state="queued" if processing else None,
        feature_count=None,
        extent=None,
        crs=None,
        geometry_type=None,
        quality_results={},
        processing_job_state="queued" if processing else None,
        processing_error_code=None,
        tags=("roads", "transport"),
        created_at=NOW,
        updated_at=NOW,
        capabilities=DatasetCapabilities(True, True, True, False),
    )


class FakeIngestionRepository:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def search_layers(self, context, **filters):
        self.calls.append(("search_layers", context, filters))
        return [
            {
                "dataset_id": DATASET_ID,
                "dataset_name": "Screening data",
                "project_id": PROJECT_ID,
                "project_name": "Screening",
                "format": "geojson",
                "classification": "public",
                "source_type": "external",
                "updated_at": NOW,
                "map_id": None,
                "map_version": None,
                "layer_id": None,
                "title": "Screening data",
                "description": None,
                "style_field": None,
                "legend": None,
                "geometry_type": None,
                "style_key": None,
            }
        ]

    async def list_datasets(self, context, project_id, page, filters=None):
        self.calls.append(("list_datasets", context, project_id, page, filters))
        return [dataset(processing=True)]

    async def search_datasets(self, context, page, filters=None, client_id=None, project_id=None):
        self.calls.append(("search_datasets", context, page, filters, client_id, project_id))
        return [dataset(processing=True)]

    async def get_catalog_dataset(self, context, dataset_id):
        self.calls.append(("get_catalog_dataset", context, dataset_id))
        return dataset(processing=True)

    async def get_dataset(self, context, project_id, dataset_id):
        self.calls.append(("get_dataset", context, project_id, dataset_id))
        return dataset(processing=True)

    async def get_repository_object_source(self, context, project_id, dataset_id):
        self.calls.append(("get_repository_object_source", context, project_id, dataset_id))
        return RepositoryObjectSource(
            dataset_id=dataset_id,
            connection_id=UUID("a0000000-0000-4000-8000-000000000065"),
            connection_target_revision=3,
            provider="s3",
            bucket_name="example-geodata",
            region_name="us-east-1",
            object_prefix="usa/ma/",
            relative_path="environment/screen.geojson",
            provider_version_id="version-0001",
            size_bytes=4096,
            last_modified=NOW,
            content_type="application/geo+json",
            etag='"etag-0001"',
            storage_class="STANDARD",
            provider_checksum_sha256="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            created_by=USER_ID,
            created_at=NOW,
        )

    async def attach_dataset(self, context, project_id, dataset_id, request_id):
        self.calls.append(("attach_dataset", context, project_id, dataset_id, request_id))
        return dataset(processing=True)

    async def detach_dataset(self, context, project_id, dataset_id, request_id):
        self.calls.append(("detach_dataset", context, project_id, dataset_id, request_id))

    async def request_upload(self, context, project_id, draft, request_id):
        self.calls.append(("request_upload", context, project_id, draft, request_id))
        return UploadTicket(
            upload_id=UPLOAD_ID,
            dataset=dataset(),
            upload=UploadForm(
                url="https://geodata-test.s3.us-east-1.amazonaws.com/",
                method="POST",
                fields={"key": "exact-key", "policy": "opaque-signature"},
                expires_at=NOW + timedelta(minutes=15),
            ),
        )

    async def complete_upload(self, context, project_id, upload_id, request_id):
        self.calls.append(("complete_upload", context, project_id, upload_id, request_id))
        return UploadCompletion(dataset(processing=True), VERSION_ID, 1, JOB_ID, "queued")


class ConflictingRepository(FakeIngestionRepository):
    async def complete_upload(self, *args, **kwargs):
        del args, kwargs
        raise IngestionConflict("upload_verification_failed")


class MissingObjectRepository(FakeIngestionRepository):
    async def complete_upload(self, *args, **kwargs):
        del args, kwargs
        raise UploadObjectNotFound("missing")


class FailingRepository(FakeIngestionRepository):
    async def list_datasets(self, *args, **kwargs):
        del args, kwargs
        raise IngestionStoreUnavailable("password=must-not-leak")


def api_client(repository: FakeIngestionRepository, *, upload_max_bytes: int = 2048) -> TestClient:
    return TestClient(
        create_app(
            settings=Settings(env="test", expose_docs=True, upload_max_bytes=upload_max_bytes),
            readiness_probe=PassingProbe(),
            token_verifier=FakeVerifier(),
            principal_repository=FakePrincipalRepository(),
            ingestion_repository=repository,
        )
    )


def headers(organization_id: UUID = ORG_ID) -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(organization_id),
        "X-Request-ID": "request-ingestion-123",
    }


def upload_payload(**changes):
    return {
        "name": " Road network ",
        "description": " Authoritative roads ",
        "classification": "restricted",
        "format": "geopackage",
        "filename": "roads.gpkg",
        "content_type": "APPLICATION/GEOPACKAGE+SQLITE3",
        "size_bytes": 1234,
        "checksum_sha256": SHA256.upper(),
        "tags": [" Roads ", "Transport"],
        **changes,
    }


def test_request_contract_normalizes_metadata_and_returns_only_exact_upload_instructions() -> None:
    repository = FakeIngestionRepository()

    response = api_client(repository).post(
        f"/projects/{PROJECT_ID}/uploads/request",
        headers=headers(),
        json=upload_payload(),
    )

    assert response.status_code == 201
    assert response.json()["upload_id"] == str(UPLOAD_ID)
    assert response.json()["dataset"]["status"] == "draft"
    assert response.json()["upload"] == {
        "url": "https://geodata-test.s3.us-east-1.amazonaws.com/",
        "method": "POST",
        "fields": {"key": "exact-key", "policy": "opaque-signature"},
    }
    call = repository.calls[0]
    assert call[1] == TenantContext(USER_ID, ORG_ID)
    assert call[2] == PROJECT_ID
    assert call[3].name == "Road network"
    assert call[3].content_type == "application/geopackage+sqlite3"
    assert call[3].checksum_sha256 == SHA256
    assert call[3].tags == ("roads", "transport")
    assert call[4] == "request-ingestion-123"


def test_format_extension_media_type_size_tags_and_unknown_fields_fail_before_repository() -> None:
    repository = FakeIngestionRepository()
    client = api_client(repository)
    invalid_payloads = [
        upload_payload(filename="roads.zip"),
        upload_payload(content_type="application/zip"),
        upload_payload(filename="../roads.gpkg"),
        upload_payload(size_bytes=2049),
        upload_payload(tags=["roads", "ROADS"]),
        upload_payload(organization_id=str(OTHER_ORG_ID)),
    ]

    for payload in invalid_payloads:
        response = client.post(
            f"/projects/{PROJECT_ID}/uploads/request", headers=headers(), json=payload
        )
        assert response.status_code == 422

    assert repository.calls == []


def test_media_and_documents_use_the_same_shared_auth_and_private_upload_contract() -> None:
    for format_name, filename, content_type in (
        ("png", "field-photo.png", "image/png"),
        ("jpeg", "field-photo.jpeg", "image/jpeg"),
        ("pdf", "research-report.pdf", "application/pdf"),
        (
            "odt",
            "research-report.odt",
            "application/vnd.oasis.opendocument.text",
        ),
    ):
        repository = FakeIngestionRepository()
        response = api_client(repository).post(
            f"/projects/{PROJECT_ID}/uploads/request",
            headers=headers(),
            json=upload_payload(
                format=format_name,
                filename=filename,
                content_type=content_type,
            ),
        )

        assert response.status_code == 201
        assert repository.calls[0][0] == "request_upload"
        assert repository.calls[0][3].format == format_name
        assert repository.calls[0][3].content_type == content_type


def test_media_upload_contract_has_a_format_specific_16_mib_safety_limit() -> None:
    repository = FakeIngestionRepository()
    client = api_client(repository, upload_max_bytes=32 * 1024 * 1024)
    media = client.post(
        f"/projects/{PROJECT_ID}/uploads/request",
        headers=headers(),
        json=upload_payload(
            format="png",
            filename="field-photo.png",
            content_type="image/png",
            size_bytes=16 * 1024 * 1024 + 1,
        ),
    )
    dataset = client.post(
        f"/projects/{PROJECT_ID}/uploads/request",
        headers=headers(),
        json=upload_payload(size_bytes=16 * 1024 * 1024 + 1),
    )

    assert media.status_code == 422
    assert media.json() == {
        "detail": {"code": "upload_size_exceeds_limit", "max_size_bytes": 16 * 1024 * 1024}
    }
    assert dataset.status_code == 201
    assert len(repository.calls) == 1


@pytest.mark.parametrize(
    ("format_name", "filename", "content_type"),
    [
        ("pdf", "research-report.pdf", "application/pdf"),
        ("odt", "research-report.odt", "application/vnd.oasis.opendocument.text"),
    ],
)
def test_document_upload_contract_has_a_format_specific_32_mib_safety_limit(
    format_name: str, filename: str, content_type: str
) -> None:
    repository = FakeIngestionRepository()
    client = api_client(repository, upload_max_bytes=64 * 1024 * 1024)
    document = client.post(
        f"/projects/{PROJECT_ID}/uploads/request",
        headers=headers(),
        json=upload_payload(
            format=format_name,
            filename=filename,
            content_type=content_type,
            size_bytes=32 * 1024 * 1024 + 1,
        ),
    )
    accepted = client.post(
        f"/projects/{PROJECT_ID}/uploads/request",
        headers=headers(),
        json=upload_payload(
            format=format_name,
            filename=filename,
            content_type=content_type,
            size_bytes=32 * 1024 * 1024,
        ),
    )

    assert document.status_code == 422
    assert document.json() == {
        "detail": {"code": "upload_size_exceeds_limit", "max_size_bytes": 32 * 1024 * 1024}
    }
    assert accepted.status_code == 201
    assert len(repository.calls) == 1


def test_forged_organization_is_rejected_before_repository() -> None:
    repository = FakeIngestionRepository()
    response = api_client(repository).post(
        f"/projects/{PROJECT_ID}/uploads/request",
        headers=headers(OTHER_ORG_ID),
        json=upload_payload(),
    )

    assert response.status_code == 403
    assert repository.calls == []


def test_catalog_and_completion_responses_expose_logical_state_not_s3_location() -> None:
    repository = FakeIngestionRepository()
    client = api_client(repository)

    catalog = client.get(f"/projects/{PROJECT_ID}/datasets", headers=headers())
    completed = client.post(
        f"/projects/{PROJECT_ID}/uploads/{UPLOAD_ID}/complete", headers=headers()
    )

    assert catalog.status_code == 200
    assert catalog.json()[0]["current_version_number"] == 1
    assert catalog.json()[0]["quality_results"] == {}
    assert catalog.json()[0]["processing_job_state"] == "queued"
    assert catalog.json()[0]["processing_error_code"] is None
    assert "bucket" not in catalog.text
    assert completed.status_code == 200
    assert completed.json()["dataset_version_id"] == str(VERSION_ID)
    assert completed.json()["processing_job_state"] == "queued"
    assert repository.calls[-1] == (
        "complete_upload",
        TenantContext(USER_ID, ORG_ID),
        PROJECT_ID,
        UPLOAD_ID,
        "request-ingestion-123",
    )


def test_repository_dataset_exposes_exact_source_metadata_without_authority() -> None:
    repository = FakeIngestionRepository()
    response = api_client(repository).get(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/repository-object-source",
        headers=headers(),
    )

    assert response.status_code == 200
    assert response.json() == {
        "dataset_id": str(DATASET_ID),
        "connection_id": "a0000000-0000-4000-8000-000000000065",
        "connection_target_revision": 3,
        "provider": "s3",
        "bucket_name": "example-geodata",
        "region_name": "us-east-1",
        "object_prefix": "usa/ma/",
        "relative_path": "environment/screen.geojson",
        "provider_version_id": "version-0001",
        "size_bytes": 4096,
        "last_modified": NOW.isoformat().replace("+00:00", "Z"),
        "content_type": "application/geo+json",
        "etag": '"etag-0001"',
        "storage_class": "STANDARD",
        "provider_checksum_sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        "created_by": str(USER_ID),
        "created_at": NOW.isoformat().replace("+00:00", "Z"),
    }
    assert "role_arn" not in response.text
    assert "secret_arn" not in response.text
    assert repository.calls[-1] == (
        "get_repository_object_source",
        TenantContext(USER_ID, ORG_ID),
        PROJECT_ID,
        DATASET_ID,
    )


def test_existing_dataset_can_be_attached_and_detached_without_copying_data() -> None:
    repository = FakeIngestionRepository()
    client = api_client(repository)

    attached = client.put(f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}", headers=headers())
    detached = client.delete(f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}", headers=headers())

    assert attached.status_code == 200
    assert attached.json()["id"] == str(DATASET_ID)
    assert attached.json()["project_id"] == str(PROJECT_ID)
    assert detached.status_code == 204
    assert detached.content == b""
    assert repository.calls[-2:] == [
        (
            "attach_dataset",
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            DATASET_ID,
            "request-ingestion-123",
        ),
        (
            "detach_dataset",
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            DATASET_ID,
            "request-ingestion-123",
        ),
    ]


def test_organization_catalog_accepts_bounded_discovery_filters() -> None:
    repository = FakeIngestionRepository()
    response = api_client(repository).get(
        "/datasets",
        headers=headers(),
        params={
            "query": "rainfall",
            "client_id": str(PROJECT_ID),
            "project_id": str(PROJECT_ID),
            "owner_user_id": str(USER_ID),
            "tag": "climate",
            "geometry_type": "Polygon",
            "format": "geopackage",
            "classification": "restricted",
            "source_type": "upload",
            "updated_after": "2026-01-01T00:00:00Z",
            "updated_before": "2026-12-31T23:59:59Z",
            "limit": 25,
        },
    )

    assert response.status_code == 200
    call = repository.calls[0]
    assert call[0] == "search_datasets"
    assert call[1] == TenantContext(USER_ID, ORG_ID)
    assert call[2].limit == 25
    assert call[3].query == "rainfall"
    assert call[3].tag == "climate"
    assert call[4] == PROJECT_ID
    assert call[5] == PROJECT_ID


def test_catalog_rejects_unbounded_or_reversed_filters_before_repository() -> None:
    repository = FakeIngestionRepository()
    client = api_client(repository)
    for parameters in (
        {"query": "x" * 201},
        {"limit": 101},
        {
            "updated_after": "2026-12-31T00:00:00Z",
            "updated_before": "2026-01-01T00:00:00Z",
        },
    ):
        assert client.get("/datasets", headers=headers(), params=parameters).status_code == 422
    assert repository.calls == []


def test_completion_and_store_failures_are_machine_readable_and_sanitized() -> None:
    conflict = api_client(ConflictingRepository()).post(
        f"/projects/{PROJECT_ID}/uploads/{UPLOAD_ID}/complete", headers=headers()
    )
    missing = api_client(MissingObjectRepository()).post(
        f"/projects/{PROJECT_ID}/uploads/{UPLOAD_ID}/complete", headers=headers()
    )
    failed = api_client(FailingRepository()).get(
        f"/projects/{PROJECT_ID}/datasets", headers=headers()
    )

    assert conflict.status_code == 409
    assert conflict.json() == {"detail": {"code": "upload_verification_failed"}}
    assert missing.status_code == 409
    assert missing.json() == {"detail": {"code": "upload_object_missing"}}
    assert failed.status_code == 503
    assert failed.json() == {"detail": "ingestion_store_unavailable"}
    assert "password" not in failed.text


def test_openapi_exposes_managed_upload_and_catalog_contracts() -> None:
    paths = api_client(FakeIngestionRepository()).get("/openapi.json").json()["paths"]

    assert {
        "/datasets",
        "/projects/{project_id}/datasets",
        "/projects/{project_id}/datasets/{dataset_id}",
        "/projects/{project_id}/uploads/request",
        "/projects/{project_id}/uploads/{upload_id}/complete",
    } <= set(paths)


def test_layer_catalog_filters_are_scoped_and_paged_without_storage_addresses() -> None:
    repository = FakeIngestionRepository()
    api = api_client(repository)
    assert api.get("/catalog/layers").status_code == 401
    result = api.get(
        f"/catalog/layers?query=heat&project_id={PROJECT_ID}&limit=25&offset=24", headers=headers()
    )
    assert result.status_code == 200
    assert result.headers["cache-control"] == "no-store"
    assert result.json()[0]["dataset_id"] == str(DATASET_ID)
    assert result.json()[0]["map_id"] is None
    call, context, filters = repository.calls[-1]
    assert call == "search_layers" and context == TenantContext(USER_ID, ORG_ID)
    assert filters["query"] == "heat" and filters["offset"] == 24
    assert filters["project_id"] == PROJECT_ID
    for forbidden in ("sourceUrl", "objectKey", "bucket", "credentials"):
        assert forbidden not in result.text
    assert api.get("/catalog/layers?limit=101", headers=headers()).status_code == 422
    assert api.get("/catalog/layers?offset=-1", headers=headers()).status_code == 422


def test_catalog_identity_read_does_not_require_a_project_url() -> None:
    repository = FakeIngestionRepository()
    response = api_client(repository).get(f"/datasets/{DATASET_ID}", headers=headers())
    assert response.status_code == 200
    assert response.json()["id"] == str(DATASET_ID)
    assert response.headers["cache-control"] == "no-store"
    assert repository.calls == [("get_catalog_dataset", TenantContext(USER_ID, ORG_ID), DATASET_ID)]


def test_metadata_routes_roundtrip_exact_documents_and_bound_versions():
    from opengeo_api.resource_knowledge import empty_knowledge

    class KnowledgeRepository(FakeIngestionRepository):
        async def get_dataset_knowledge(self, context, dataset_id, version=None):
            self.calls.append(("read", context, dataset_id, version))
            return {
                "dataset_id": dataset_id,
                "version": 0,
                "document": empty_knowledge(),
                "created_by": None,
                "created_at": None,
                "can_edit": True,
            }

        async def save_dataset_knowledge(self, context, dataset_id, document, expected_version):
            self.calls.append(("save", context, dataset_id, document, expected_version))
            return {
                "dataset_id": dataset_id,
                "version": 1,
                "document": document,
                "created_by": USER_ID,
                "created_at": NOW,
                "can_edit": True,
            }

    repository = KnowledgeRepository()
    client = api_client(repository)
    path = f"/datasets/{DATASET_ID}/metadata"
    response = client.get(path, headers=headers())
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    response = client.put(
        path,
        headers=headers(),
        json={
            "expected_version": 0,
            "document": empty_knowledge(),
        },
    )
    assert response.status_code == 200
    assert response.json()["version"] == 1
    for version in (0, -1, 2**31):
        assert client.get(path, headers=headers(), params={"version": version}).status_code == 422
    for draft in (
        {"expected_version": True, "document": empty_knowledge()},
        {"expected_version": 0, "document": {"schemaVersion": "bad"}},
    ):
        assert client.put(path, headers=headers(), json=draft).status_code == 422
    assert len(repository.calls) == 2


@pytest.mark.parametrize(
    "endpoint,body,invalid",
    [
        ("place-context", {"item": "Q3037"}, {"item": "https://example.org"}),
        ("place-search", {"query": "Kathmandu"}, {"query": "  "}),
    ],
)
def test_place_context_requires_dataset_edit_before_provider_lookup(endpoint, body, invalid):
    class Repository(FakeIngestionRepository):
        allowed = False

        async def get_dataset_knowledge(self, context, dataset_id, version=None):
            assert context.organization_id == ORG_ID
            return {"can_edit": self.allowed}

    class Resolver:
        calls = 0

        async def resolve(self, item):
            self.calls += 1
            return {"item": item, "relationships": []}

        search = resolve

    repository = Repository()
    client = api_client(repository)
    resolver = Resolver()
    client.app.state.place_context_resolver = resolver
    path = f"/datasets/{DATASET_ID}/{endpoint}"
    assert client.post(path, headers=headers(), json=body).status_code == 403
    assert resolver.calls == 0
    repository.allowed = True
    response = client.post(path, headers=headers(), json=body)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert resolver.calls == 1
    invalid_response = client.post(path, headers=headers(), json=invalid)
    assert invalid_response.status_code == 422
    assert resolver.calls == 1


def test_kml_upload_retains_exact_source_contract_and_matches_worker_size_limit() -> None:
    repository = FakeIngestionRepository()
    client = api_client(repository, upload_max_bytes=64 * 1024 * 1024)
    payload = upload_payload(
        format="kml",
        filename="survey.kml",
        content_type="application/vnd.google-earth.kml+xml",
        size_bytes=4 * 1024 * 1024,
    )
    response = client.post(
        f"/projects/{PROJECT_ID}/uploads/request", headers=headers(), json=payload
    )
    assert response.status_code == 201
    request = repository.calls[0][3]
    assert request.format == "kml"
    assert request.original_filename == "survey.kml"
    assert request.checksum_sha256 == SHA256
    assert request.content_type == "application/vnd.google-earth.kml+xml"
    repository.calls.clear()
    for changes in (
        {"size_bytes": 4 * 1024 * 1024 + 1},
        {"filename": "survey.kmz"},
        {"content_type": "application/zip"},
    ):
        rejected = client.post(
            f"/projects/{PROJECT_ID}/uploads/request",
            headers=headers(),
            json={**payload, **changes},
        )
        assert rejected.status_code == 422
    assert repository.calls == []
    unauthenticated = client.post(f"/projects/{PROJECT_ID}/uploads/request", json=payload)
    assert unauthenticated.status_code == 401


def test_renew_upload_scopes_identity_and_prevents_ticket_caching():
    class RenewalRepository(FakeIngestionRepository):
        async def renew_upload(self, context, project_id, upload_id, request_id):
            assert upload_id == UPLOAD_ID
            return await self.request_upload(context, project_id, None, request_id)

    repository = RenewalRepository()
    client = api_client(repository)
    path = f"/projects/{PROJECT_ID}/uploads/{UPLOAD_ID}/renew"
    assert client.post(path).status_code == 401
    assert repository.calls == []
    response = client.post(path, headers=headers())
    assert response.status_code == 200
    assert response.json()["upload_id"] == str(UPLOAD_ID)
    assert response.headers["cache-control"] == "private, no-store"
    assert repository.calls[0][1:3] == (TenantContext(USER_ID, ORG_ID), PROJECT_ID)
