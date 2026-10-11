from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import UUID

from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.data_preservation import (
    CopyEstimate,
    DataPreservationAccessDenied,
    ExactObjectScope,
    FeatureCollectionScope,
    PmtilesDerivativeJob,
    PmtilesDerivativeSubmission,
    ProtectedCopyJob,
    ProtectedCopySubmission,
    RepositoryCopyEstimate,
    RepositoryProtectedCopyJob,
    RepositoryProtectedCopySubmission,
    WmsBoundedImageScope,
)
from opengeo_api.processing_dispatch import ProcessingDispatchUnavailable
from opengeo_api.tenant_database import TenantContext

USER_ID = UUID("20000000-0000-4000-8000-000000000001")
ORG_ID = UUID("10000000-0000-4000-8000-000000000001")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000001")
SOURCE_DATASET_ID = UUID("80000000-0000-4000-8000-000000000001")
DESTINATION_DATASET_ID = UUID("80000000-0000-4000-8000-000000000002")
VERSION_ID = UUID("83000000-0000-4000-8000-000000000001")
SOURCE_OBJECT_ID = UUID("82000000-0000-4000-8000-000000000001")
ESTIMATE_ID = UUID("85000000-0000-4000-8000-000000000001")
SNAPSHOT_JOB_ID = UUID("86000000-0000-4000-8000-000000000001")
PMTILES_JOB_ID = UUID("87000000-0000-4000-8000-000000000001")
REPOSITORY_COPY_JOB_ID = UUID("89000000-0000-4000-8000-000000000001")
IDEMPOTENCY_KEY = UUID("88000000-0000-4000-8000-000000000001")
NOW = datetime(2026, 8, 28, 12, tzinfo=UTC)
CHECKSUM = "a" * 64
REQUEST_CHECKSUM = "b" * 64


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


def estimate(*, source_type: str = "wms") -> CopyEstimate:
    if source_type == "wms":
        copy_method = "bounded_map_capture"
        capture_scope = {
            "kind": "bounded_image",
            "bounds": [-71.2, 42.1, -70.8, 42.5],
            "width": 1024,
            "height": 768,
        }
        output_format = "png"
        output_content_type = "image/png"
        maximum_output_bytes = 3_211_264
        maximum_requests = 1
    elif source_type == "pmtiles":
        copy_method = "exact_object_copy"
        capture_scope = {"kind": "exact_object"}
        output_format = "pmtiles"
        output_content_type = "application/vnd.pmtiles"
        maximum_output_bytes = 12_345
        maximum_requests = 1
    else:
        copy_method = "bounded_feature_capture"
        capture_scope = {
            "kind": "bounded_features",
            "bounds": [-71.2, 42.1, -70.8, 42.5],
            "maximum_features": 2_500,
            "page_size": 1_000,
        }
        output_format = "geojson"
        output_content_type = "application/geo+json"
        maximum_output_bytes = 2_500 * 16_384 + 65_536
        maximum_requests = 3
    return CopyEstimate(
        estimate_id=ESTIMATE_ID,
        project_id=PROJECT_ID,
        source_dataset_id=SOURCE_DATASET_ID,
        source_revision_number=3,
        source_type=source_type,  # type: ignore[arg-type]
        copy_method=copy_method,  # type: ignore[arg-type]
        capture_scope=capture_scope,
        output_format=output_format,  # type: ignore[arg-type]
        output_content_type=output_content_type,
        maximum_requests=maximum_requests,
        maximum_output_bytes=maximum_output_bytes,
        estimated_cost_usd=Decimal("0.000073"),
        estimate_checksum_sha256=CHECKSUM,
        created_by=USER_ID,
        created_at=NOW,
        expires_at=NOW + timedelta(minutes=30),
    )


def snapshot_job(*, state: str = "queued") -> ProtectedCopyJob:
    return ProtectedCopyJob(
        job_id=SNAPSHOT_JOB_ID,
        project_id=PROJECT_ID,
        estimate_id=ESTIMATE_ID,
        source_dataset_id=SOURCE_DATASET_ID,
        source_revision_number=3,
        destination_dataset_id=DESTINATION_DATASET_ID,
        destination_name="Protected MassGIS image",
        destination_classification="internal",
        copy_method="bounded_map_capture",
        capture_scope={
            "kind": "bounded_image",
            "bounds": [-71.2, 42.1, -70.8, 42.5],
            "width": 1024,
            "height": 768,
        },
        output_format="png",
        output_content_type="image/png",
        maximum_requests=1,
        maximum_output_bytes=3_211_264,
        estimated_cost_usd=Decimal("0.000073"),
        estimate_checksum_sha256=CHECKSUM,
        estimate_expires_at=NOW + timedelta(minutes=30),
        rights_basis="Agency open-data terms permit archival copy",
        attribution="MassGIS",
        request_checksum_sha256=REQUEST_CHECKSUM,
        idempotency_key=IDEMPOTENCY_KEY,
        state=state,  # type: ignore[arg-type]
        output_object_id=None,
        output_dataset_version_id=None,
        error_code=None,
        attempt_count=0,
        created_by=USER_ID,
        created_at=NOW,
        started_at=None,
        finished_at=NOW if state == "cancelled" else None,
    )


def pmtiles_job(*, state: str = "queued") -> PmtilesDerivativeJob:
    return PmtilesDerivativeJob(
        job_id=PMTILES_JOB_ID,
        project_id=PROJECT_ID,
        dataset_id=SOURCE_DATASET_ID,
        dataset_version_id=VERSION_ID,
        source_object_id=SOURCE_OBJECT_ID,
        bounds=(-71.2, 42.1, -70.8, 42.5),
        minimum_zoom=6,
        maximum_zoom=14,
        source_layer="massgis",
        request_checksum_sha256=REQUEST_CHECKSUM,
        idempotency_key=IDEMPOTENCY_KEY,
        state=state,  # type: ignore[arg-type]
        output_object_id=None,
        output_size_bytes=None,
        output_checksum_sha256=None,
        error_code=None,
        attempt_count=0,
        created_by=USER_ID,
        created_at=NOW,
        started_at=None,
        finished_at=NOW if state == "cancelled" else None,
    )


def repository_estimate() -> RepositoryCopyEstimate:
    return RepositoryCopyEstimate(
        estimate_id=ESTIMATE_ID,
        project_id=PROJECT_ID,
        source_dataset_id=SOURCE_DATASET_ID,
        connection_target_revision=3,
        provider_version_id="provider-version-7",
        output_format="geojson",
        output_content_type="application/geo+json",
        maximum_requests=1,
        maximum_output_bytes=12_345,
        estimated_cost_usd=Decimal("0.000007"),
        estimate_checksum_sha256=CHECKSUM,
        created_by=USER_ID,
        created_at=NOW,
        expires_at=NOW + timedelta(minutes=30),
    )


def repository_copy_job(*, state: str = "queued") -> RepositoryProtectedCopyJob:
    return RepositoryProtectedCopyJob(
        job_id=REPOSITORY_COPY_JOB_ID,
        project_id=PROJECT_ID,
        estimate_id=ESTIMATE_ID,
        source_dataset_id=SOURCE_DATASET_ID,
        destination_dataset_id=DESTINATION_DATASET_ID,
        destination_name="Protected repository object",
        destination_classification="internal",
        connection_target_revision=3,
        provider_version_id="provider-version-7",
        output_format="geojson",
        output_content_type="application/geo+json",
        maximum_requests=1,
        maximum_output_bytes=12_345,
        estimated_cost_usd=Decimal("0.000007"),
        estimate_checksum_sha256=CHECKSUM,
        estimate_expires_at=NOW + timedelta(minutes=30),
        rights_basis="Agency terms permit an archival copy",
        attribution="Example agency",
        request_checksum_sha256=REQUEST_CHECKSUM,
        idempotency_key=IDEMPOTENCY_KEY,
        state=state,  # type: ignore[arg-type]
        output_object_id=None,
        output_dataset_version_id=None,
        error_code=None,
        attempt_count=0,
        created_by=USER_ID,
        created_at=NOW,
        started_at=None,
        finished_at=NOW if state == "cancelled" else None,
    )


class MemoryRepository:
    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.snapshot = snapshot_job()
        self.pmtiles = pmtiles_job()
        self.repository_copy = repository_copy_job()

    async def create_copy_estimate(
        self, context, project_id, source_dataset_id, source_revision_number, spec, request_id
    ):
        self.calls.append(
            (
                "estimate",
                context,
                project_id,
                source_dataset_id,
                source_revision_number,
                spec,
                request_id,
            )
        )
        return estimate(source_type=spec.source_type)

    async def request_protected_copy(
        self, context, project_id, source_dataset_id, source_revision_number, request, request_id
    ):
        self.calls.append(
            (
                "snapshot.create",
                context,
                project_id,
                source_dataset_id,
                source_revision_number,
                request,
                request_id,
            )
        )
        return ProtectedCopySubmission(self.snapshot, True)

    async def list_protected_copies(self, context, project_id, source_dataset_id, page):
        self.calls.append(("snapshot.list", context, project_id, source_dataset_id, page))
        return (self.snapshot,)

    async def get_protected_copy(self, context, project_id, source_dataset_id, job_id):
        self.calls.append(("snapshot.get", context, project_id, source_dataset_id, job_id))
        return self.snapshot

    async def cancel_protected_copy(
        self, context, project_id, source_dataset_id, job_id, request_id
    ):
        self.calls.append(
            ("snapshot.cancel", context, project_id, source_dataset_id, job_id, request_id)
        )
        self.snapshot = snapshot_job(state="cancelled")
        return self.snapshot

    async def create_repository_copy_estimate(
        self, context, project_id, source_dataset_id, request_id
    ):
        self.calls.append(
            ("repository.estimate", context, project_id, source_dataset_id, request_id)
        )
        return repository_estimate()

    async def request_repository_protected_copy(
        self, context, project_id, source_dataset_id, request, request_id
    ):
        self.calls.append(
            (
                "repository.create",
                context,
                project_id,
                source_dataset_id,
                request,
                request_id,
            )
        )
        return RepositoryProtectedCopySubmission(self.repository_copy, True)

    async def list_repository_protected_copies(self, context, project_id, source_dataset_id, page):
        self.calls.append(("repository.list", context, project_id, source_dataset_id, page))
        return (self.repository_copy,)

    async def get_repository_protected_copy(self, context, project_id, source_dataset_id, job_id):
        self.calls.append(("repository.get", context, project_id, source_dataset_id, job_id))
        return self.repository_copy

    async def cancel_repository_protected_copy(
        self, context, project_id, source_dataset_id, job_id, request_id
    ):
        self.calls.append(
            (
                "repository.cancel",
                context,
                project_id,
                source_dataset_id,
                job_id,
                request_id,
            )
        )
        self.repository_copy = repository_copy_job(state="cancelled")
        return self.repository_copy

    async def request_pmtiles_derivative(
        self, context, project_id, dataset_id, dataset_version_id, request, request_id
    ):
        self.calls.append(
            (
                "pmtiles.create",
                context,
                project_id,
                dataset_id,
                dataset_version_id,
                request,
                request_id,
            )
        )
        return PmtilesDerivativeSubmission(self.pmtiles, True)

    async def list_pmtiles_derivatives(
        self, context, project_id, dataset_id, dataset_version_id, page
    ):
        self.calls.append(
            ("pmtiles.list", context, project_id, dataset_id, dataset_version_id, page)
        )
        return (self.pmtiles,)

    async def get_pmtiles_derivative(
        self, context, project_id, dataset_id, dataset_version_id, job_id
    ):
        self.calls.append(
            ("pmtiles.get", context, project_id, dataset_id, dataset_version_id, job_id)
        )
        return self.pmtiles

    async def cancel_pmtiles_derivative(
        self, context, project_id, dataset_id, dataset_version_id, job_id, request_id
    ):
        self.calls.append(
            (
                "pmtiles.cancel",
                context,
                project_id,
                dataset_id,
                dataset_version_id,
                job_id,
                request_id,
            )
        )
        self.pmtiles = pmtiles_job(state="cancelled")
        return self.pmtiles


class DeniedRepository(MemoryRepository):
    async def create_copy_estimate(self, *args, **kwargs):
        del args, kwargs
        raise DataPreservationAccessDenied("must not leak")


class SnapshotDispatcher:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.job_ids: list[UUID] = []

    async def dispatch_external_source_snapshot(self, job_id: UUID) -> None:
        self.job_ids.append(job_id)
        if self.fail:
            raise ProcessingDispatchUnavailable("queue unavailable")


class PmtilesDispatcher:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.job_ids: list[UUID] = []

    async def dispatch_pmtiles_derivative(self, job_id: UUID) -> None:
        self.job_ids.append(job_id)
        if self.fail:
            raise ProcessingDispatchUnavailable("queue unavailable")


class RepositoryCopyDispatcher:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.job_ids: list[UUID] = []

    async def dispatch_repository_object_copy(self, job_id: UUID) -> None:
        self.job_ids.append(job_id)
        if self.fail:
            raise ProcessingDispatchUnavailable("queue unavailable")


def api_client(
    repository: MemoryRepository | None = None,
    *,
    snapshot_dispatcher: SnapshotDispatcher | None = None,
    pmtiles_dispatcher: PmtilesDispatcher | None = None,
    repository_copy_dispatcher: RepositoryCopyDispatcher | None = None,
) -> TestClient:
    return TestClient(
        create_app(
            settings=Settings(env="test", expose_docs=True),
            readiness_probe=PassingProbe(),
            token_verifier=FakeVerifier(),
            principal_repository=FakePrincipalRepository(),
            data_preservation_repository=repository or MemoryRepository(),
            external_source_snapshot_dispatcher=(snapshot_dispatcher or SnapshotDispatcher()),
            pmtiles_derivative_dispatcher=pmtiles_dispatcher or PmtilesDispatcher(),
            repository_object_copy_dispatcher=(
                repository_copy_dispatcher or RepositoryCopyDispatcher()
            ),
        )
    )


def headers() -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(ORG_ID),
        "X-Request-ID": "request-preservation-123",
    }


def estimate_url() -> str:
    return f"/projects/{PROJECT_ID}/datasets/{SOURCE_DATASET_ID}/source/revisions/3/copy-estimates"


def snapshot_url(suffix: str = "") -> str:
    return (
        f"/projects/{PROJECT_ID}/datasets/{SOURCE_DATASET_ID}/source/revisions/3/"
        f"protected-copies{suffix}"
    )


def snapshot_collection_url(suffix: str = "") -> str:
    return f"/projects/{PROJECT_ID}/datasets/{SOURCE_DATASET_ID}/protected-copies{suffix}"


def pmtiles_url(suffix: str = "") -> str:
    return (
        f"/projects/{PROJECT_ID}/datasets/{SOURCE_DATASET_ID}/versions/{VERSION_ID}/"
        f"pmtiles-derivatives{suffix}"
    )


def repository_copy_estimate_url() -> str:
    return f"/projects/{PROJECT_ID}/datasets/{SOURCE_DATASET_ID}/repository-copy-estimates"


def repository_copy_url(suffix: str = "") -> str:
    return (
        f"/projects/{PROJECT_ID}/datasets/{SOURCE_DATASET_ID}/repository-protected-copies{suffix}"
    )


def snapshot_payload(**changes) -> dict[str, object]:
    return {
        "idempotency_key": str(IDEMPOTENCY_KEY),
        "estimate": {
            "estimate_id": str(ESTIMATE_ID),
            "estimate_checksum_sha256": CHECKSUM,
            "accepted": True,
        },
        "rights": {
            "confirmed": True,
            "basis": "Agency open-data terms permit archival copy",
            "attribution": "MassGIS",
        },
        "destination": {
            "name": "Protected MassGIS image",
            "description": "Pinned source revision",
            "classification": "internal",
        },
        **changes,
    }


def pmtiles_payload(**changes) -> dict[str, object]:
    return {
        "idempotency_key": str(IDEMPOTENCY_KEY),
        "bounds": [-71.2, 42.1, -70.8, 42.5],
        "min_zoom": 6,
        "max_zoom": 14,
        "source_layer": "massgis",
        **changes,
    }


def test_copy_estimate_contract_seals_supported_map_object_and_feature_scopes() -> None:
    repository = MemoryRepository()
    client = api_client(repository)

    wms = client.post(
        estimate_url(),
        headers=headers(),
        json={
            "source_type": "wms",
            "scope": {
                "kind": "bounded_image",
                "bounds": [-71.2, 42.1, -70.8, 42.5],
                "width": 1024,
                "height": 768,
            },
        },
    )
    pmtiles = client.post(
        estimate_url(),
        headers=headers(),
        json={"source_type": "pmtiles", "scope": {"kind": "exact_object"}},
    )
    arcgis = client.post(
        estimate_url(),
        headers=headers(),
        json={
            "source_type": "arcgis",
            "scope": {
                "kind": "bounded_features",
                "bounds": [-71.2, 42.1, -70.8, 42.5],
                "maximum_features": 2_500,
                "page_size": 1_000,
            },
        },
    )
    wfs = client.post(
        estimate_url(),
        headers=headers(),
        json={
            "source_type": "wfs",
            "scope": {
                "kind": "bounded_features",
                "bounds": [-71.2, 42.1, -70.8, 42.5],
                "maximum_features": 2_500,
                "page_size": 1_000,
            },
        },
    )

    assert wms.status_code == 201
    assert wms.json()["capture_scope"] == {
        "kind": "bounded_image",
        "bounds": [-71.2, 42.1, -70.8, 42.5],
        "width": 1024,
        "height": 768,
    }
    assert wms.json()["output_format"] == "png"
    assert pmtiles.status_code == 201
    assert pmtiles.json()["capture_scope"] == {"kind": "exact_object"}
    assert pmtiles.json()["output_format"] == "pmtiles"
    assert arcgis.status_code == 201
    assert arcgis.json()["copy_method"] == "bounded_feature_capture"
    assert arcgis.json()["maximum_requests"] == 3
    assert arcgis.json()["output_format"] == "geojson"
    assert wfs.status_code == 201
    assert isinstance(repository.calls[0][5].scope, WmsBoundedImageScope)
    assert isinstance(repository.calls[1][5].scope, ExactObjectScope)
    assert isinstance(repository.calls[2][5].scope, FeatureCollectionScope)
    assert isinstance(repository.calls[3][5].scope, FeatureCollectionScope)
    assert repository.calls[0][1] == TenantContext(USER_ID, ORG_ID)


def test_copy_estimate_rejects_unsupported_or_unbounded_source_types_before_repository() -> None:
    repository = MemoryRepository()
    client = api_client(repository)
    invalid = [
        {"source_type": "xyz", "scope": {"kind": "exact_object"}},
        {"source_type": "arcgis", "scope": {"kind": "bounded_image"}},
        {"source_type": "wfs", "scope": {"kind": "exact_object"}},
        {
            "source_type": "wms",
            "scope": {
                "kind": "bounded_image",
                "bounds": [-71.2, 42.1, -70.8, 42.5],
                "width": 4096,
                "height": 4097,
            },
        },
        {
            "source_type": "wms",
            "scope": {
                "kind": "bounded_image",
                "bounds": [-71.2, 42.1, -70.8, 86],
                "width": 1024,
                "height": 768,
            },
        },
    ]

    for payload in invalid:
        assert client.post(estimate_url(), headers=headers(), json=payload).status_code == 422

    assert repository.calls == []


def test_protected_copy_requires_acceptance_and_rights_then_dispatches_only_job_id() -> None:
    repository = MemoryRepository()
    dispatcher = SnapshotDispatcher()
    client = api_client(repository, snapshot_dispatcher=dispatcher)

    response = client.post(snapshot_url(), headers=headers(), json=snapshot_payload())

    assert response.status_code == 202
    assert dispatcher.job_ids == [SNAPSHOT_JOB_ID]
    assert response.json()["job_id"] == str(SNAPSHOT_JOB_ID)
    assert response.json()["cancellable"] is True
    assert "destination_bucket" not in response.text
    assert "source_url" not in response.text
    request = repository.calls[0][5]
    assert request.idempotency_key == IDEMPOTENCY_KEY
    assert request.estimate_checksum_sha256 == CHECKSUM
    assert request.rights_basis == "Agency open-data terms permit archival copy"
    assert request.destination_name == "Protected MassGIS image"


def test_protected_copy_rejects_missing_confirmation_and_client_storage_fields() -> None:
    repository = MemoryRepository()
    client = api_client(repository)
    invalid = [
        snapshot_payload(
            estimate={
                "estimate_id": str(ESTIMATE_ID),
                "estimate_checksum_sha256": CHECKSUM,
                "accepted": False,
            }
        ),
        snapshot_payload(
            rights={
                "confirmed": False,
                "basis": "Agency open-data terms permit archival copy",
                "attribution": "MassGIS",
            }
        ),
        snapshot_payload(destination_bucket="attacker-controlled"),
    ]

    for payload in invalid:
        assert client.post(snapshot_url(), headers=headers(), json=payload).status_code == 422

    assert repository.calls == []


def test_protected_copy_list_get_and_cancel_lifecycle() -> None:
    repository = MemoryRepository()
    client = api_client(repository)

    listed = client.get(snapshot_collection_url(), headers=headers())
    fetched = client.get(snapshot_collection_url(f"/{SNAPSHOT_JOB_ID}"), headers=headers())
    cancelled = client.post(
        snapshot_collection_url(f"/{SNAPSHOT_JOB_ID}/cancel"), headers=headers()
    )

    assert listed.status_code == 200
    assert [item["job_id"] for item in listed.json()] == [str(SNAPSHOT_JOB_ID)]
    assert fetched.status_code == 200
    assert cancelled.status_code == 200
    assert cancelled.json()["state"] == "cancelled"
    assert cancelled.json()["cancellable"] is False
    assert [call[0] for call in repository.calls] == [
        "snapshot.list",
        "snapshot.get",
        "snapshot.cancel",
    ]


def test_repository_copy_estimate_seals_exact_provider_version_and_cost() -> None:
    repository = MemoryRepository()
    response = api_client(repository).post(repository_copy_estimate_url(), headers=headers())

    assert response.status_code == 201
    assert response.json()["schema_version"] == ("opengeo.repository-object-copy-estimate.1.0.0")
    assert response.json()["copy_method"] == "exact_object_copy"
    assert response.json()["provider_version_id"] == "provider-version-7"
    assert response.json()["maximum_requests"] == 1
    assert response.json()["maximum_output_bytes"] == 12_345
    assert response.json()["estimated_cost_usd"] == "0.000007"
    assert repository.calls[0][0] == "repository.estimate"


def test_repository_copy_requires_reviewed_request_then_dispatches_only_job_id() -> None:
    repository = MemoryRepository()
    dispatcher = RepositoryCopyDispatcher()
    response = api_client(repository, repository_copy_dispatcher=dispatcher).post(
        repository_copy_url(), headers=headers(), json=snapshot_payload()
    )

    assert response.status_code == 202
    assert dispatcher.job_ids == [REPOSITORY_COPY_JOB_ID]
    assert response.json()["job_id"] == str(REPOSITORY_COPY_JOB_ID)
    assert response.json()["provider_version_id"] == "provider-version-7"
    assert response.json()["cancellable"] is True
    assert "source_bucket" not in response.text
    assert "secret" not in response.text
    request = repository.calls[0][4]
    assert request.estimate_id == ESTIMATE_ID
    assert request.idempotency_key == IDEMPOTENCY_KEY
    assert request.rights_basis == "Agency open-data terms permit archival copy"


def test_repository_copy_list_get_cancel_and_durable_dispatch_failure() -> None:
    repository = MemoryRepository()
    client = api_client(repository)

    listed = client.get(repository_copy_url(), headers=headers())
    fetched = client.get(repository_copy_url(f"/{REPOSITORY_COPY_JOB_ID}"), headers=headers())
    cancelled = client.post(
        repository_copy_url(f"/{REPOSITORY_COPY_JOB_ID}/cancel"), headers=headers()
    )

    assert listed.status_code == 200
    assert fetched.status_code == 200
    assert cancelled.status_code == 200
    assert cancelled.json()["state"] == "cancelled"
    assert [call[0] for call in repository.calls] == [
        "repository.list",
        "repository.get",
        "repository.cancel",
    ]

    repository = MemoryRepository()
    failed = api_client(
        repository,
        repository_copy_dispatcher=RepositoryCopyDispatcher(fail=True),
    ).post(repository_copy_url(), headers=headers(), json=snapshot_payload())
    assert failed.status_code == 503
    assert failed.json() == {"detail": "repository_object_copy_dispatch_unavailable"}
    assert repository.calls[0][0] == "repository.create"


def test_pmtiles_create_list_get_cancel_and_id_only_dispatch() -> None:
    repository = MemoryRepository()
    dispatcher = PmtilesDispatcher()
    client = api_client(repository, pmtiles_dispatcher=dispatcher)

    created = client.post(pmtiles_url(), headers=headers(), json=pmtiles_payload())
    listed = client.get(pmtiles_url(), headers=headers())
    fetched = client.get(pmtiles_url(f"/{PMTILES_JOB_ID}"), headers=headers())
    cancelled = client.post(pmtiles_url(f"/{PMTILES_JOB_ID}/cancel"), headers=headers())

    assert created.status_code == 202
    assert dispatcher.job_ids == [PMTILES_JOB_ID]
    assert created.json()["source_object_id"] == str(SOURCE_OBJECT_ID)
    assert created.json()["bounds"] == [-71.2, 42.1, -70.8, 42.5]
    assert listed.status_code == 200
    assert len(listed.json()) == 1
    assert fetched.status_code == 200
    assert cancelled.status_code == 200
    assert cancelled.json()["state"] == "cancelled"
    request = repository.calls[0][5]
    assert request.minimum_zoom == 6
    assert request.maximum_zoom == 14
    assert request.source_layer == "massgis"


def test_pmtiles_validation_rejects_bad_bounds_zoom_and_unknown_fields() -> None:
    repository = MemoryRepository()
    client = api_client(repository)

    for payload in (
        pmtiles_payload(bounds=[-70.8, 42.1, -71.2, 42.5]),
        pmtiles_payload(min_zoom=15, max_zoom=14),
        pmtiles_payload(destination_bucket="attacker-controlled"),
    ):
        assert client.post(pmtiles_url(), headers=headers(), json=payload).status_code == 422

    assert repository.calls == []


def test_durable_queued_job_survives_dispatch_unavailability() -> None:
    repository = MemoryRepository()
    client = api_client(repository, snapshot_dispatcher=SnapshotDispatcher(fail=True))

    response = client.post(snapshot_url(), headers=headers(), json=snapshot_payload())

    assert response.status_code == 503
    assert response.json() == {"detail": "external_source_snapshot_dispatch_unavailable"}
    assert repository.calls[0][0] == "snapshot.create"


def test_authentication_and_repository_access_denial_fail_closed() -> None:
    unauthenticated = api_client().post(
        estimate_url(),
        json={"source_type": "pmtiles", "scope": {"kind": "exact_object"}},
    )
    forbidden = api_client(DeniedRepository()).post(
        estimate_url(),
        headers=headers(),
        json={"source_type": "pmtiles", "scope": {"kind": "exact_object"}},
    )

    assert unauthenticated.status_code == 401
    assert forbidden.status_code == 403
    assert forbidden.json() == {"detail": "action_forbidden"}
