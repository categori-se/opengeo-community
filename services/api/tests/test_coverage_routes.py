from dataclasses import replace
from datetime import UTC, datetime, timedelta
from email import policy
from email.parser import BytesParser
from uuid import UUID
from xml.etree import ElementTree as ET

import pytest
from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.coverages import (
    CoverageAccessDenied,
    CoverageConflict,
    CoverageDerivativeJob,
    CoverageDerivativeReclamation,
    CoverageDerivativeReclamationPreview,
    CoverageDerivativeReclamationSubmission,
    CoverageDerivativeRequest,
    CoverageDerivativeSubmission,
    CoverageNotFound,
    CoverageProcessingPolicy,
    SpatialCoverage,
)
from opengeo_api.s3_downloads import DownloadTicket, ExactObject
from opengeo_api.spatial_services import SpatialService, SpatialServiceNotFound
from opengeo_api.wcs import (
    GML_NS,
    OWS_NS,
    SWE_NS,
    WCS_GET_KVP_PROFILE,
    WCS_NS,
    WcsRequestError,
    capabilities_xml,
    describe_coverage_xml,
    parse_wcs_request,
    plan_wcs_subsets,
    wcs_subset_derivative_spec,
)

USER_ID = UUID("20000000-0000-4000-8000-000000000171")
ORG_ID = UUID("10000000-0000-4000-8000-000000000171")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000171")
SERVICE_ID = UUID("60000000-0000-4000-8000-000000000171")
COVERAGE_ID = UUID("70000000-0000-4000-8000-000000000171")
DATASET_ID = UUID("80000000-0000-4000-8000-000000000171")
DATASET_VERSION_ID = UUID("82000000-0000-4000-8000-000000000171")
OBJECT_ID = UUID("81000000-0000-4000-8000-000000000171")
DERIVATIVE_ID = UUID("71000000-0000-4000-8000-000000000171")
DERIVATIVE_OBJECT_ID = UUID("81100000-0000-4000-8000-000000000171")
RECLAMATION_ID = UUID("71100000-0000-4000-8000-000000000171")
NOW = datetime(2026, 8, 21, 16, tzinfo=UTC)


class PassingProbe:
    async def check(self) -> None:
        pass


class FakeVerifier:
    async def verify(self, token: str) -> VerifiedAccessToken:
        assert token == "valid-token"
        return VerifiedAccessToken("coverage-subject", "client", "user", (), ())


class FakePrincipalRepository:
    async def resolve(self, subject: str) -> Principal:
        assert subject == "coverage-subject"
        return Principal(
            user_id=USER_ID,
            subject=subject,
            email="coverage@example.test",
            display_name="Coverage Publisher",
            memberships=(OrganizationMembership(ORG_ID, "admin"),),
        )


class MemoryServiceRepository:
    def __init__(self) -> None:
        self.service = SpatialService(
            SERVICE_ID,
            PROJECT_ID,
            "earth-observation",
            "Earth observation",
            "Exact research rasters",
            USER_ID,
            NOW,
            None,
            None,
            ("wcs_2_0",),
        )

    async def get_active_service(self, context, project_id, slug):
        del context
        if project_id != PROJECT_ID or slug != self.service.slug:
            raise SpatialServiceNotFound("spatial_service")
        return self.service

    async def list_collections(self, context, project_id, service_id, *, include_withdrawn):
        del context, include_withdrawn
        if (project_id, service_id) != (PROJECT_ID, SERVICE_ID):
            raise SpatialServiceNotFound("spatial_service")
        return ()

    async def resolve_collection(self, context, project_id, service_slug, collection_name):
        del context, project_id, service_slug, collection_name
        raise SpatialServiceNotFound("spatial_service_collection")


class MemoryCoverageRepository:
    def __init__(self) -> None:
        self.coverage: SpatialCoverage | None = None
        self.derivative: CoverageDerivativeJob | None = None
        self.downloads = 0
        self.direct_reads = 0

    async def create_coverage(
        self,
        context,
        project_id,
        service_id,
        coverage_name,
        dataset_id,
        dataset_version_id,
        data_object_id,
        expected_dataset_version,
        title,
        description,
        request_id,
    ):
        del context, request_id
        if expected_dataset_version != 4:
            raise CoverageConflict("spatial_service_coverage_target_changed")
        self.coverage = SpatialCoverage(
            COVERAGE_ID,
            project_id,
            service_id,
            coverage_name,
            dataset_id,
            dataset_version_id,
            data_object_id,
            4,
            "EPSG:4326",
            (-77.25, 38.75, -76.75, 39.25),
            512,
            256,
            2,
            (
                {"index": 1, "data_type": "UInt16", "color_interpretation": "Gray"},
                {
                    "index": 2,
                    "source_index": 2,
                    "data_type": "UInt16",
                    "color_interpretation": "Alpha",
                },
            ),
            "opengeo-test",
            "organizations/example/elevation.tif",
            "cog-version-4",
            "image/tiff",
            4096,
            "a" * 64,
            dataset_version_id,
            4,
            title,
            description,
            USER_ID,
            NOW,
            None,
            None,
            True,
        )
        return self.coverage

    async def list_coverages(self, context, project_id, service_id, *, include_withdrawn):
        del context
        if (project_id, service_id) != (PROJECT_ID, SERVICE_ID):
            raise CoverageNotFound("spatial_service")
        if self.coverage is None:
            return ()
        if self.coverage.withdrawn_at is not None and not include_withdrawn:
            return ()
        return (self.coverage,)

    async def resolve_coverage(self, context, project_id, service_slug, coverage_name):
        del context
        if (
            project_id != PROJECT_ID
            or service_slug != "earth-observation"
            or self.coverage is None
            or coverage_name != self.coverage.coverage_name
            or self.coverage.withdrawn_at is not None
        ):
            raise CoverageNotFound("spatial_service_coverage")
        return self.coverage

    async def withdraw_coverage(self, context, project_id, service_id, coverage_id, request_id):
        del context, request_id
        if self.coverage is None or (project_id, service_id, coverage_id) != (
            PROJECT_ID,
            SERVICE_ID,
            COVERAGE_ID,
        ):
            raise CoverageNotFound("spatial_service_coverage")
        self.coverage = replace(self.coverage, withdrawn_by=USER_ID, withdrawn_at=NOW)
        return self.coverage

    async def request_coverage_download(
        self, context, project_id, service_slug, coverage_name, request_id
    ):
        del request_id
        coverage = await self.resolve_coverage(context, project_id, service_slug, coverage_name)
        if coverage.stale:
            raise CoverageConflict("spatial_service_coverage_stale")
        self.downloads += 1
        return DownloadTicket(
            "https://opengeo-test.s3.example.test/elevation.tif?versionId=cog-version-4",
            "GET",
            NOW + timedelta(minutes=5),
        )

    async def read_coverage_object(
        self, context, project_id, service_slug, coverage_name, maximum_bytes
    ):
        coverage = await self.resolve_coverage(context, project_id, service_slug, coverage_name)
        if coverage.size_bytes > maximum_bytes:
            raise CoverageConflict("spatial_service_coverage_direct_read_too_large")
        self.direct_reads += 1
        return ExactObject(
            b"II*\x00opengeo-source",
            coverage.content_type,
            coverage.size_bytes,
            coverage.checksum_sha256,
            coverage.storage_version_id,
        )

    async def request_derivative(
        self, context, project_id, service_id, coverage_id, request, request_id
    ):
        del context, request_id
        if self.coverage is None or (project_id, service_id, coverage_id) != (
            PROJECT_ID,
            SERVICE_ID,
            COVERAGE_ID,
        ):
            raise CoverageNotFound("spatial_service_coverage")
        if self.derivative is None:
            self.derivative = derivative_job(request=request.materialize(self.coverage))
        return CoverageDerivativeSubmission(self.derivative, self.derivative.state == "queued")

    async def find_derivative(self, context, project_id, service_id, coverage_id, request):
        del context
        if self.coverage is None or (project_id, service_id, coverage_id) != (
            PROJECT_ID,
            SERVICE_ID,
            COVERAGE_ID,
        ):
            raise CoverageNotFound("spatial_service_coverage")
        materialized = request.materialize(self.coverage)
        if (
            self.derivative is None
            or self.derivative.request_checksum_sha256 != materialized.checksum_sha256
            or self.derivative.reclamation_state == "completed"
        ):
            return None
        return self.derivative

    async def get_processing_policy(self, context, project_id, service_id):
        del context
        if (project_id, service_id) != (PROJECT_ID, SERVICE_ID):
            raise CoverageNotFound("spatial_service")
        return CoverageProcessingPolicy()

    async def list_derivatives(self, context, project_id, service_id, coverage_id):
        del context
        if (project_id, service_id, coverage_id) != (PROJECT_ID, SERVICE_ID, COVERAGE_ID):
            raise CoverageNotFound("spatial_service_coverage")
        return () if self.derivative is None else (self.derivative,)

    async def get_derivative(self, context, project_id, service_id, coverage_id, job_id):
        del context
        if self.derivative is None or (project_id, service_id, coverage_id, job_id) != (
            PROJECT_ID,
            SERVICE_ID,
            COVERAGE_ID,
            DERIVATIVE_ID,
        ):
            raise CoverageNotFound("spatial_coverage_derivative")
        return self.derivative

    async def cancel_derivative(
        self, context, project_id, service_id, coverage_id, job_id, request_id
    ):
        del request_id
        job = await self.get_derivative(context, project_id, service_id, coverage_id, job_id)
        if job.state != "queued":
            raise CoverageConflict("spatial_coverage_derivative_not_cancellable")
        self.derivative = replace(
            job,
            state="cancelled",
            error_code="cancelled_by_user",
            finished_at=NOW,
        )
        return self.derivative

    async def request_derivative_download(
        self, context, project_id, service_id, coverage_id, job_id, request_id
    ):
        del request_id
        job = await self.get_derivative(context, project_id, service_id, coverage_id, job_id)
        if job.state != "completed" or not job.output_available:
            raise CoverageConflict("spatial_coverage_derivative_not_ready")
        return DownloadTicket(
            f"https://opengeo-test.s3.example.test/derivative.tif?versionId={job_id}",
            "GET",
            NOW + timedelta(minutes=5),
        )

    async def read_derivative_object(
        self,
        context,
        project_id,
        service_id,
        coverage_id,
        job_id,
        maximum_bytes,
    ):
        job = await self.get_derivative(context, project_id, service_id, coverage_id, job_id)
        if (
            job.state != "completed"
            or not job.output_available
            or job.output_size_bytes is None
            or job.output_size_bytes > maximum_bytes
        ):
            raise CoverageConflict("spatial_coverage_derivative_not_ready")
        assert job.output_content_type is not None
        assert job.output_checksum_sha256 is not None
        assert job.output_storage_version_id is not None
        self.direct_reads += 1
        return ExactObject(
            b"II*\x00opengeo-derivative",
            job.output_content_type,
            job.output_size_bytes,
            job.output_checksum_sha256,
            job.output_storage_version_id,
        )

    async def preview_derivative_reclamation(
        self, context, project_id, service_id, coverage_id, job_id
    ):
        job = await self.get_derivative(context, project_id, service_id, coverage_id, job_id)
        if job.state != "completed" or not job.output_available:
            raise CoverageConflict("spatial_coverage_derivative_not_reclaimable")
        assert job.output_object_id is not None
        assert job.output_size_bytes is not None
        assert job.output_checksum_sha256 is not None
        assert job.finished_at is not None
        return CoverageDerivativeReclamationPreview(
            job.job_id,
            job.output_object_id,
            job.output_size_bytes,
            job.output_checksum_sha256,
            job.finished_at,
            NOW + timedelta(minutes=15),
            "f" * 64,
        )

    async def confirm_derivative_reclamation(
        self,
        context,
        project_id,
        service_id,
        coverage_id,
        job_id,
        preview_checksum_sha256,
        preview_expires_at,
        request_id,
    ):
        del request_id
        job = await self.get_derivative(context, project_id, service_id, coverage_id, job_id)
        if preview_checksum_sha256 != "f" * 64:
            raise CoverageConflict("spatial_coverage_derivative_reclamation_changed")
        assert job.output_object_id is not None
        assert job.output_size_bytes is not None
        assert job.output_checksum_sha256 is not None
        reclamation = CoverageDerivativeReclamation(
            RECLAMATION_ID,
            job.job_id,
            job.output_object_id,
            "queued",
            job.output_size_bytes,
            job.output_checksum_sha256,
            preview_checksum_sha256,
            preview_expires_at,
            None,
            0,
            None,
            USER_ID,
            NOW,
            None,
            None,
        )
        self.derivative = replace(job, reclamation_state="queued", output_available=False)
        return CoverageDerivativeReclamationSubmission(reclamation, True)


class MemoryDispatcher:
    def __init__(self) -> None:
        self.derivatives: list[UUID] = []
        self.reclamations: list[UUID] = []

    async def dispatch_render(self, job_id: UUID) -> None:
        del job_id

    async def dispatch_coverage_derivative(self, job_id: UUID) -> None:
        self.derivatives.append(job_id)

    async def dispatch_coverage_derivative_reclamation(self, reclamation_id: UUID) -> None:
        self.reclamations.append(reclamation_id)


def derivative_job(
    *,
    request: CoverageDerivativeRequest | None = None,
    state: str = "queued",
) -> CoverageDerivativeJob:
    derivative_request = request or CoverageDerivativeRequest(
        subset_extent=(-77.2, 38.8, -76.8, 39.2),
        target_crs="EPSG:3857",
        width=256,
        height=128,
        resampling="bilinear",
        request_schema_version=2,
        band_indexes=(1, 2),
        scale_mode="size",
        resolution=None,
    )
    completed = state == "completed"
    return CoverageDerivativeJob(
        job_id=DERIVATIVE_ID,
        project_id=PROJECT_ID,
        service_id=SERVICE_ID,
        coverage_id=COVERAGE_ID,
        coverage_name="elevation",
        request=derivative_request,
        request_checksum_sha256=derivative_request.checksum_sha256,
        state=state,
        output_object_id=DERIVATIVE_OBJECT_ID if completed else None,
        output_crs=derivative_request.target_crs if completed else None,
        output_extent=(-8590000.0, 4690000.0, -8550000.0, 4750000.0) if completed else None,
        output_width=derivative_request.width if completed else None,
        output_height=derivative_request.height if completed else None,
        output_band_count=2 if completed else None,
        output_bands=(
            (
                {"index": 1, "data_type": "UInt16", "color_interpretation": "Gray"},
                {"index": 2, "data_type": "UInt16", "color_interpretation": "Alpha"},
            )
            if completed
            else None
        ),
        output_content_type="image/tiff" if completed else None,
        output_size_bytes=8192 if completed else None,
        output_checksum_sha256="c" * 64 if completed else None,
        output_bucket="opengeo-test" if completed else None,
        output_object_key="organizations/example/derivative.tif" if completed else None,
        output_storage_version_id="derived-v1" if completed else None,
        error_code=None,
        attempt_count=1 if completed else 0,
        created_by=USER_ID,
        created_at=NOW,
        started_at=NOW if completed else None,
        finished_at=NOW - timedelta(days=2) if completed else None,
        source_available=True,
        reclamation_state=None,
        output_available=completed,
    )


def api_client(
    repository: MemoryCoverageRepository,
    dispatcher: MemoryDispatcher | None = None,
) -> TestClient:
    return TestClient(
        create_app(
            settings=Settings(env="test", expose_docs=True),
            readiness_probe=PassingProbe(),
            token_verifier=FakeVerifier(),
            principal_repository=FakePrincipalRepository(),
            spatial_service_repository=MemoryServiceRepository(),
            coverage_repository=repository,
            render_dispatcher=dispatcher,
        )
    )


def headers() -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(ORG_ID),
        "X-Request-ID": "coverage-request-123",
    }


def create_coverage(client: TestClient) -> dict[str, object]:
    response = client.post(
        f"/projects/{PROJECT_ID}/spatial-services/{SERVICE_ID}/coverages",
        headers=headers(),
        json={
            "coverage_name": "elevation",
            "dataset_id": str(DATASET_ID),
            "dataset_version_id": str(DATASET_VERSION_ID),
            "data_object_id": str(OBJECT_ID),
            "expected_dataset_version": 4,
            "title": "Elevation surface",
            "description": "Validated exact COG",
        },
    )
    assert response.status_code == 201
    return response.json()


def wcs_url(query: str) -> str:
    return f"/projects/{PROJECT_ID}/services/earth-observation/wcs?{query}"


def test_wcs_subset_preview_round_trips_the_exact_derivative_without_dispatch() -> None:
    repository = MemoryCoverageRepository()
    dispatcher = MemoryDispatcher()
    client = api_client(repository, dispatcher)
    create_coverage(client)
    endpoint = f"/projects/{PROJECT_ID}/services/earth-observation/coverages/elevation/subset-plan"
    parameters = [("subset", "Long(-77.10,-76.90)"), ("subset", "Lat(38.90)")]
    assert client.get(endpoint, params=parameters).status_code == 401
    result = client.get(endpoint, params=parameters, headers=headers())
    assert result.status_code == 200
    assert result.headers["cache-control"] == "private, no-store"
    planned = result.json()
    assert planned["coverage_id"] == str(COVERAGE_ID)
    assert planned["dataset_version_id"] == str(DATASET_VERSION_ID)
    assert planned["ordinary_reads_create_work"] is False
    assert repository.derivative is None and dispatcher.derivatives == []
    assert client.get(endpoint, params=parameters[::-1], headers=headers()).json() == planned
    derivative = client.post(
        f"/projects/{PROJECT_ID}/spatial-services/{SERVICE_ID}/coverages/{COVERAGE_ID}/derivatives",
        json=planned["derivative_request"],
        headers=headers(),
    )
    assert derivative.status_code == 202
    assert derivative.json()["request_checksum_sha256"] == planned["request_checksum_sha256"]
    assert dispatcher.derivatives == [DERIVATIVE_ID]


def test_wcs_subset_preview_rejects_invalid_unknown_stale_and_disabled_targets() -> None:
    repository = MemoryCoverageRepository()
    client = api_client(repository)
    create_coverage(client)
    endpoint = f"/projects/{PROJECT_ID}/services/earth-observation/coverages/elevation/subset-plan"
    for parameters, expected in [
        ([], 422),
        ([("subset", "Long(NaN)")], 400),
        ([("subset", "Other(1)")], 404),
        ([("subset", "Long(1)")] * 3, 422),
        ([("subset", "Long(-77)"), ("url", "https://outside.invalid")], 400),
    ]:
        assert client.get(endpoint, params=parameters, headers=headers()).status_code == expected
    assert repository.derivative is None
    assert repository.coverage is not None
    repository.coverage = replace(repository.coverage, current_dataset_version_number=5)
    assert (
        client.get(endpoint, params={"subset": "Long(-77.0)"}, headers=headers()).status_code == 409
    )
    services = client.app.state.spatial_service_repository
    services.service = replace(services.service, enabled_protocols=())
    assert (
        client.get(endpoint, params={"subset": "Long(-77.0)"}, headers=headers()).status_code == 404
    )


def test_shared_auth_coverage_administration_and_immutable_seal_response() -> None:
    repository = MemoryCoverageRepository()
    client = api_client(repository)
    endpoint = f"/projects/{PROJECT_ID}/spatial-services/{SERVICE_ID}/coverages"

    assert client.get(endpoint).status_code == 401
    created = create_coverage(client)
    assert created["sealed_dataset_version_number"] == 4
    assert created["checksum_sha256"] == "a" * 64
    assert created["stale"] is False
    assert "bucket" not in created and "object_key" not in created

    listed = client.get(endpoint, headers=headers())
    assert listed.status_code == 200
    assert listed.json() == [created]
    withdrawn = client.post(f"{endpoint}/{COVERAGE_ID}/withdraw", headers=headers())
    assert withdrawn.status_code == 200
    assert withdrawn.json()["withdrawn_by"] == str(USER_ID)
    assert client.get(endpoint, headers=headers()).json() == []


def test_wcs_discovery_and_description_are_bounded_private_and_non_claiming() -> None:
    repository = MemoryCoverageRepository()
    client = api_client(repository)
    create_coverage(client)

    capabilities = client.get(
        wcs_url("SERVICE=WCS&REQUEST=GetCapabilities&VERSION=2.0.1"), headers=headers()
    )
    assert capabilities.status_code == 200
    assert capabilities.headers["cache-control"] == "private, no-store"
    assert capabilities.headers["x-content-type-options"] == "nosniff"
    assert capabilities.headers["x-opengeo-conformance-claimed"] == "false"
    root = ET.fromstring(capabilities.content)
    assert root.tag == f"{{{WCS_NS}}}Capabilities"
    assert root.attrib["version"] == "2.0.1"
    assert root.findtext(f".//{{{WCS_NS}}}CoverageId") == "elevation"
    assert root.findtext(f".//{{{WCS_NS}}}formatSupported") == "image/tiff"
    operations = root.findall(f".//{{{OWS_NS}}}Operation")
    assert [operation.attrib["name"] for operation in operations] == [
        "GetCapabilities",
        "DescribeCoverage",
        "GetCoverage",
    ]
    assert root.find(f".//{{{OWS_NS}}}Profile") is None
    candidate = ET.fromstring(
        capabilities_xml(
            "Earth observation",
            None,
            "https://example.test/wcs",
            (repository.coverage,),
            profiles=(WCS_GET_KVP_PROFILE,),
        )
    )
    assert candidate.findtext(f".//{{{OWS_NS}}}Profile") == WCS_GET_KVP_PROFILE

    described = client.get(
        wcs_url("SERVICE=WCS&REQUEST=DescribeCoverage&VERSION=2.0.1&COVERAGEID=elevation"),
        headers=headers(),
    )
    assert described.status_code == 200
    description = ET.fromstring(described.content)
    assert description.findtext(f".//{{{GML_NS}}}low") == "0 0"
    assert description.findtext(f".//{{{GML_NS}}}high") == "511 255"
    assert description.findtext(f".//{{{GML_NS}}}lowerCorner") == "38.75 -77.25"
    assert description.findtext(f".//{{{GML_NS}}}Point/{{{GML_NS}}}pos") == (
        "39.2490234375 -77.24951171875"
    )
    assert [node.text for node in description.findall(f".//{{{GML_NS}}}offsetVector")] == [
        "0 0.0009765625",
        "-0.001953125 0",
    ]
    assert len(description.findall(f".//{{{SWE_NS}}}field")) == 2


class MultipleCoverageRepository(MemoryCoverageRepository):
    def __init__(self) -> None:
        super().__init__()
        self.resolved: list[str] = []
        self.other: SpatialCoverage | None = None
        self.deny_other = False

    async def resolve_coverage(self, context, project_id, service_slug, coverage_name):
        self.resolved.append(coverage_name)
        if coverage_name == "rainfall":
            assert project_id == PROJECT_ID and service_slug == "earth-observation"
            if self.deny_other:
                raise CoverageAccessDenied("spatial_service_coverage")
            if self.other is None:
                raise CoverageNotFound("spatial_service_coverage")
            return self.other
        return await super().resolve_coverage(context, project_id, service_slug, coverage_name)


def test_wcs_multiple_descriptions_preserve_order_metadata_and_unique_xml_ids() -> None:
    repository, dispatcher = MultipleCoverageRepository(), MemoryDispatcher()
    client = api_client(repository, dispatcher)
    create_coverage(client)
    assert repository.coverage is not None
    repository.other = replace(
        repository.coverage, coverage_name="rainfall", width=128, title="Rainfall"
    )
    query = "SERVICE=WCS&REQUEST=DescribeCoverage&VERSION=2.0.1&COVERAGEID="
    response = client.get(wcs_url(query + "rainfall,elevation,rainfall"), headers=headers())
    assert response.status_code == 200
    assert repository.resolved == ["rainfall", "elevation"]
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-opengeo-conformance-claimed"] == "false"
    root = ET.fromstring(response.content)
    descriptions = root.findall(f"{{{WCS_NS}}}CoverageDescription")
    assert [item.findtext(f"{{{WCS_NS}}}CoverageId") for item in descriptions] == [
        "rainfall",
        "elevation",
        "rainfall",
    ]
    assert [item.findtext(f".//{{{GML_NS}}}high") for item in descriptions] == [
        "127 255",
        "511 255",
        "127 255",
    ]
    ids = [
        item.attrib[f"{{{GML_NS}}}id"] for item in root.iter() if f"{{{GML_NS}}}id" in item.attrib
    ]
    assert len(ids) == len(set(ids)) == 9
    assert root.attrib == ET.fromstring(describe_coverage_xml(repository.coverage)).attrib
    single = client.get(wcs_url(query + "elevation"), headers=headers())
    assert single.content == describe_coverage_xml(repository.coverage)
    assert repository.downloads == repository.direct_reads == 0
    assert repository.derivative is None and dispatcher.derivatives == []


@pytest.mark.parametrize("failure,status", [("missing", 404), ("denied", 403), ("stale", 409)])
def test_wcs_multiple_descriptions_fail_without_partial_metadata(failure: str, status: int) -> None:
    repository, dispatcher = MultipleCoverageRepository(), MemoryDispatcher()
    client = api_client(repository, dispatcher)
    create_coverage(client)
    assert repository.coverage is not None
    if failure == "denied":
        repository.deny_other = True
    elif failure == "stale":
        repository.other = replace(repository.coverage, current_dataset_version_number=5)
    query = wcs_url(
        "SERVICE=WCS&REQUEST=DescribeCoverage&VERSION=2.0.1&COVERAGEID=elevation,rainfall"
    )
    assert client.get(query).status_code == 401
    assert repository.resolved == []
    response = client.get(query, headers=headers())
    assert response.status_code == status
    assert ET.fromstring(response.content).tag == f"{{{OWS_NS}}}ExceptionReport"
    assert b"Elevation surface" not in response.content
    assert repository.resolved == ["elevation", "rainfall"]
    repository.resolved.clear()
    services = client.app.state.spatial_service_repository
    services.service = replace(services.service, enabled_protocols=())
    assert client.get(query, headers=headers()).status_code == 404
    assert repository.resolved == []
    assert repository.downloads == repository.direct_reads == 0
    assert repository.derivative is None and dispatcher.derivatives == []


def test_wcs_description_identifier_lists_are_bounded_before_resolution() -> None:
    repository = MultipleCoverageRepository()
    client = api_client(repository)
    create_coverage(client)
    query = "SERVICE=WCS&REQUEST=DescribeCoverage&VERSION=2.0.1&COVERAGEID="
    for identifiers in (
        "",
        ",",
        "elevation,",
        ",elevation",
        "elevation, rainfall",
        "a/evil",
        ",".join(["elevation"] * 17),
        "a" * 2049,
    ):
        assert client.get(wcs_url(query + identifiers), headers=headers()).status_code == 400
    assert (
        client.get(
            wcs_url(query.replace("DescribeCoverage", "GetCoverage") + "elevation,elevation"),
            headers=headers(),
        ).status_code
        == 400
    )
    assert repository.resolved == []
    assert client.get(wcs_url(query + "Elevation"), headers=headers()).status_code == 404
    assert (
        client.get(wcs_url(query + ",".join(["elevation"] * 16)), headers=headers()).status_code
        == 200
    )
    assert repository.resolved == ["Elevation", "elevation"]
    assert repository.downloads == repository.direct_reads == 0


def test_wcs_fails_closed_when_the_versioned_service_metadata_disables_it() -> None:
    repository = MemoryCoverageRepository()
    client = api_client(repository)
    create_coverage(client)
    service_repository = client.app.state.spatial_service_repository
    service_repository.service = replace(
        service_repository.service,
        enabled_protocols=("wfs_2_0",),
    )

    response = client.get(
        wcs_url("SERVICE=WCS&REQUEST=GetCapabilities&VERSION=2.0.1"),
        headers=headers(),
    )

    assert response.status_code == 404
    exception = ET.fromstring(response.content).find(f"{{{OWS_NS}}}Exception")
    assert exception is not None
    assert exception.attrib == {
        "exceptionCode": "OperationNotSupported",
        "locator": "SERVICE",
    }
    assert repository.downloads == 0


def test_wcs_exact_getcoverage_redirects_without_dispatch_or_secret_headers() -> None:
    repository = MemoryCoverageRepository()
    client = api_client(repository)
    create_coverage(client)

    response = client.get(
        wcs_url(
            "SERVICE=WCS&REQUEST=GetCoverage&VERSION=2.0.1&COVERAGEID=elevation&FORMAT=image%2Ftiff"
        ),
        headers=headers(),
        follow_redirects=False,
    )
    assert response.status_code == 307
    assert response.headers["location"].endswith("versionId=cog-version-4")
    assert response.headers["x-opengeo-coverage-checksum-sha256"] == "a" * 64
    assert "authorization" not in response.headers["location"].lower()
    assert "x-opengeo-coverage-storage-version" not in response.headers
    assert repository.downloads == 1

    native = client.get(
        wcs_url("SERVICE=WCS&REQUEST=GetCoverage&VERSION=2.0.1&COVERAGEID=elevation"),
        headers=headers(),
        follow_redirects=False,
    )
    assert native.status_code == 307
    assert repository.downloads == 2


def test_wcs_explicit_multipart_returns_gml_metadata_and_exact_raster() -> None:
    repository = MemoryCoverageRepository()
    client = api_client(repository)
    create_coverage(client)

    response = client.get(
        wcs_url(
            "SERVICE=WCS&REQUEST=GetCoverage&VERSION=2.0.1&COVERAGEID=elevation&"
            "MEDIATYPE=multipart%2Frelated"
        ),
        headers=headers(),
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("multipart/related;")
    assert response.headers["x-opengeo-coverage-checksum-sha256"] == "a" * 64
    message = BytesParser(policy=policy.default).parsebytes(
        b"Content-Type: "
        + response.headers["content-type"].encode("ascii")
        + b"\r\nMIME-Version: 1.0\r\n\r\n"
        + response.content
    )
    parts = list(message.iter_parts())
    assert [part.get_content_type() for part in parts] == [
        "application/gml+xml",
        "image/tiff",
    ]
    document = ET.fromstring(parts[0].get_payload(decode=True))
    assert document.tag == "{http://www.opengis.net/gmlcov/1.0}RectifiedGridCoverage"
    assert document.findtext(f".//{{{GML_NS}}}fileReference") == "cid:elevation.tif"
    described = client.get(
        wcs_url("SERVICE=WCS&REQUEST=DescribeCoverage&VERSION=2.0.1&COVERAGEID=elevation"),
        headers=headers(),
    )
    description = ET.fromstring(described.content)
    for local_name, namespace in (
        ("boundedBy", GML_NS),
        ("domainSet", GML_NS),
        ("rangeType", "http://www.opengis.net/gmlcov/1.0"),
    ):
        described_element = description.find(f".//{{{namespace}}}{local_name}")
        result_element = document.find(f"{{{namespace}}}{local_name}")
        assert described_element is not None
        assert result_element is not None
        assert ET.tostring(described_element) == ET.tostring(result_element)
    assert parts[1].get_payload(decode=True) == b"II*\x00opengeo-source"
    assert repository.direct_reads == 1
    assert repository.downloads == 0


def test_wcs_strict_errors_reject_duplicates_unknown_work_and_alternate_encoding() -> None:
    repository = MemoryCoverageRepository()
    client = api_client(repository)
    create_coverage(client)
    queries = (
        "SERVICE=WCS&service=WCS&REQUEST=GetCapabilities",
        "SERVICE=WCS&REQUEST=GetCoverage&VERSION=2.0.1&COVERAGEID=elevation&"
        "FORMAT=image%2Ftiff&SUBSET=Lat(38.8,39.0)",
        "SERVICE=WCS&REQUEST=GetCoverage&VERSION=2.0.1&COVERAGEID=elevation&FORMAT=image%2Fpng",
    )
    statuses = []
    for query in queries:
        response = client.get(wcs_url(query), headers=headers())
        statuses.append(response.status_code)
        root = ET.fromstring(response.content)
        exception = root.find(f"{{{OWS_NS}}}Exception")
        assert exception is not None
    assert statuses == [400, 503, 501]
    assert repository.downloads == 0

    parsed = parse_wcs_request(
        [("service", "wcs"), ("request", "getcapabilities"), ("acceptversions", "2.0.1")]
    )
    assert parsed.operation == "GetCapabilities"
    unknown = client.get(
        wcs_url("SERVICE=WCS&REQUEST=DescribeCoverage&VERSION=2.0.1&COVERAGEID=CoverageId_Bogus"),
        headers=headers(),
    )
    assert unknown.status_code == 404
    exception = ET.fromstring(unknown.content).find(f"{{{OWS_NS}}}Exception")
    assert exception is not None
    assert exception.attrib["exceptionCode"] == "NoSuchCoverage"


def test_wcs_subset_plan_is_axis_aware_bounded_and_permutation_stable() -> None:
    repository = MemoryCoverageRepository()
    client = api_client(repository)
    create_coverage(client)
    assert repository.coverage is not None

    first = parse_wcs_request(
        [
            ("service", "WCS"),
            ("request", "GetCoverage"),
            ("version", "2.0.1"),
            ("coverageid", "elevation"),
            ("subset", "Long(-77.10,-76.90)"),
            ("subset", "Lat(38.90)"),
        ]
    )
    second = parse_wcs_request(
        [
            ("service", "WCS"),
            ("request", "GetCoverage"),
            ("version", "2.0.1"),
            ("coverageid", "elevation"),
            ("subset", "Lat(38.9000)"),
            ("subset", "Long(-77.100,-76.9000)"),
        ]
    )
    first_plan = plan_wcs_subsets(repository.coverage, first.subsets)
    second_plan = plan_wcs_subsets(repository.coverage, second.subsets)
    assert first_plan.extent == (-77.1, 38.9, -76.9, 38.9)
    assert first_plan.sliced_axes == ("Lat",)
    assert first_plan.canonical_key == "Lat(38.9)|Long(-77.1,-76.9)"
    assert second_plan == first_plan

    specification = wcs_subset_derivative_spec(repository.coverage, first_plan)
    materialized = specification.materialize(repository.coverage)
    assert materialized.subset_extent == (-77.099609375, 38.8984375, -76.900390625, 38.900390625)
    assert materialized.width == 204
    assert materialized.height == 1
    assert materialized.target_crs == "EPSG:4326"
    assert materialized.resampling == "nearest"

    invalid_subsets = (
        ("latitude(38.9)", "InvalidAxisLabel"),
        ("Lat(38.9)&SUBSET=Lat(39.0)", "InvalidAxisLabel"),
        ("Lat(39.1,38.9)", "InvalidSubsetting"),
        ("Lat(40)", "InvalidSubsetting"),
    )
    for query, expected_code in invalid_subsets:
        response = client.get(
            wcs_url(
                "SERVICE=WCS&REQUEST=GetCoverage&VERSION=2.0.1&COVERAGEID=elevation&SUBSET=" + query
            ),
            headers=headers(),
        )
        assert response.status_code == 404
        exception = ET.fromstring(response.content).find(f"{{{OWS_NS}}}Exception")
        assert exception is not None
        assert exception.attrib["exceptionCode"] == expected_code


def test_wcs_trim_selects_closed_interval_grid_points_without_rescaling() -> None:
    repository = MemoryCoverageRepository()
    client = api_client(repository)
    create_coverage(client)
    assert repository.coverage is not None
    coverage = replace(repository.coverage, extent=(0.0, 0.0, 8.0, 4.0), width=8, height=4)

    def recipe(*clauses):
        parsed = parse_wcs_request(
            [
                ("SERVICE", "WCS"),
                ("VERSION", "2.0.1"),
                ("REQUEST", "GetCoverage"),
                ("COVERAGEID", "elevation"),
                *(("SUBSET", clause) for clause in clauses),
            ]
        )
        return wcs_subset_derivative_spec(coverage, plan_wcs_subsets(coverage, parsed.subsets))

    for clauses in (("Long(0,8)", "Lat(0,4)"), ("Lat(0.5,3.5)", "Long(0.5,7.5)")):
        selected = recipe(*clauses)
        assert selected.subset_extent == coverage.extent
        assert (selected.width, selected.height) == (8, 4)
    selected = recipe("Long(1.5,4.5)", "Lat(1.2,2.8)")
    assert selected.subset_extent == (1, 1, 5, 3)
    assert (selected.width, selected.height) == (4, 2)
    assert recipe("Long(2.5,2.5)").width == 1
    native = recipe("Long(0,8.000000000000002)", "Lat(0,4.000000000000001)")
    assert native.subset_extent == coverage.extent
    with pytest.raises(WcsRequestError, match="outside"):
        recipe("Long(0,8.000001)")
    for clause in ("Long(2,2)", "Long(2.01,2.49)"):
        with pytest.raises(WcsRequestError, match="no source grid points"):
            recipe(clause)


def test_wcs_full_grid_trims_reuse_the_source_without_derivative_work() -> None:
    repository, dispatcher = MemoryCoverageRepository(), MemoryDispatcher()
    client = api_client(repository, dispatcher)
    create_coverage(client)
    assert repository.coverage is not None
    repository.coverage = replace(
        repository.coverage, extent=(0.0, 0.0, 8.0, 4.0), width=8, height=4
    )
    query = (
        "SERVICE=WCS&REQUEST=GetCoverage&VERSION=2.0.1&COVERAGEID=elevation&"
        "SUBSET=Long(0.5,7.5)&SUBSET=Lat(0.5,3.5)"
    )
    response = client.get(wcs_url(query), headers=headers(), follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["x-opengeo-coverage-checksum-sha256"] == "a" * 64
    response = client.get(wcs_url(query + "&MEDIATYPE=multipart/related"), headers=headers())
    assert response.status_code == 200
    assert b"opengeo-source" in response.content
    assert repository.derivative is None
    assert repository.downloads == repository.direct_reads == 1
    assert dispatcher.derivatives == []
    assert client.get(wcs_url(query)).status_code == 401
    repository.coverage = replace(repository.coverage, withdrawn_at=NOW)
    assert client.get(wcs_url(query), headers=headers()).status_code == 404
    assert repository.downloads == repository.direct_reads == 1


@pytest.mark.parametrize("crs,axes", [("EPSG:4326", ("Long", "Lat")), ("EPSG:3857", ("x", "y"))])
def test_wcs_open_trim_bounds_resolve_to_the_authorized_native_grid(crs, axes) -> None:
    repository, dispatcher = MemoryCoverageRepository(), MemoryDispatcher()
    client = api_client(repository, dispatcher)
    create_coverage(client)
    assert repository.coverage is not None
    repository.coverage = replace(
        repository.coverage, crs=crs, extent=(0.0, 0.0, 8.0, 4.0), width=8, height=4
    )
    endpoint = f"/projects/{PROJECT_ID}/services/earth-observation/coverages/elevation/subset-plan"
    x, y = axes
    for open_bounds, explicit in [
        ((f"{x}(*,5)", f"{y}(1,*)"), (f"{x}(0,5)", f"{y}(1,4)")),
        ((f"{x}(2,*)", f"{y}(*,3)"), (f"{x}(2,8)", f"{y}(0,3)")),
        ((f"{x}(*,*)", f"{y}(*,*)"), (f"{x}(0,8)", f"{y}(0,4)")),
    ]:
        preview = client.get(
            endpoint, params=[("subset", clause) for clause in open_bounds], headers=headers()
        )
        assert preview.status_code == 200
        assert preview.headers["cache-control"] == "private, no-store"
        expected = client.get(
            endpoint, params=[("subset", clause) for clause in explicit[::-1]], headers=headers()
        )
        assert preview.json() == expected.json()
    query = "SERVICE=WCS&REQUEST=GetCoverage&VERSION=2.0.1&COVERAGEID=elevation&SUBSET="
    full = query + f"{x}(*,*)&SUBSET={y}(*,*)"
    assert client.get(wcs_url(full), headers=headers(), follow_redirects=False).status_code == 307
    assert (
        client.get(wcs_url(full + "&MEDIATYPE=multipart/related"), headers=headers()).status_code
        == 200
    )
    assert client.get(wcs_url(query + f"{x}(*,5)"), headers=headers()).status_code == 503
    for clause, status in [
        (f"{x}(*)", 400),
        (f"{x}(,5)", 400),
        (f"{x}(*,NaN)", 400),
        (f"{x}(-Infinity,*)", 400),
        (f"{x}(*,9)", 404),
        (f"{x}(-1,*)", 404),
        ("unknown(*,*)", 404),
        (f"{x}(*,*)&SUBSET={x}(0,8)", 404),
    ]:
        assert client.get(wcs_url(query + clause), headers=headers()).status_code == status
    assert repository.downloads == repository.direct_reads == 1
    assert repository.derivative is None and dispatcher.derivatives == []


def test_wcs_subset_redirects_only_an_exact_prepared_derivative() -> None:
    repository = MemoryCoverageRepository()
    client = api_client(repository)
    create_coverage(client)
    assert repository.coverage is not None
    subset_query = (
        "SERVICE=WCS&REQUEST=GetCoverage&VERSION=2.0.1&COVERAGEID=elevation&"
        "SUBSET=Long(-77.10,-76.90)&SUBSET=Lat(38.90)"
    )
    missing = client.get(wcs_url(subset_query), headers=headers())
    assert missing.status_code == 503
    assert missing.headers["retry-after"] == "5"
    assert repository.derivative is None

    parsed = parse_wcs_request(
        [
            ("SERVICE", "WCS"),
            ("REQUEST", "GetCoverage"),
            ("VERSION", "2.0.1"),
            ("COVERAGEID", "elevation"),
            ("SUBSET", "Long(-77.10,-76.90)"),
            ("SUBSET", "Lat(38.90)"),
        ]
    )
    specification = wcs_subset_derivative_spec(
        repository.coverage, plan_wcs_subsets(repository.coverage, parsed.subsets)
    )
    repository.derivative = derivative_job(
        request=specification.materialize(repository.coverage), state="completed"
    )

    response = client.get(
        wcs_url(subset_query),
        headers=headers(),
        follow_redirects=False,
    )

    assert response.status_code == 307
    assert response.headers["location"].endswith(f"versionId={DERIVATIVE_ID}")
    assert response.headers["x-opengeo-coverage-checksum-sha256"] == "c" * 64
    assert repository.downloads == 0


def test_stale_coverage_is_hidden_from_discovery_and_fails_closed() -> None:
    repository = MemoryCoverageRepository()
    client = api_client(repository)
    create_coverage(client)
    assert repository.coverage is not None
    repository.coverage = replace(
        repository.coverage,
        current_dataset_version_id=UUID("82000000-0000-4000-8000-000000000172"),
        current_dataset_version_number=5,
    )

    capabilities = client.get(wcs_url("SERVICE=WCS&REQUEST=GetCapabilities"), headers=headers())
    assert ET.fromstring(capabilities.content).find(f".//{{{WCS_NS}}}CoverageId") is None
    described = client.get(
        wcs_url("SERVICE=WCS&REQUEST=DescribeCoverage&VERSION=2.0.1&COVERAGEID=elevation"),
        headers=headers(),
    )
    assert described.status_code == 409
    assert repository.downloads == 0


def test_derivative_request_is_explicit_idempotent_bounded_and_storage_opaque() -> None:
    repository = MemoryCoverageRepository()
    dispatcher = MemoryDispatcher()
    client = api_client(repository, dispatcher)
    create_coverage(client)
    endpoint = (
        f"/projects/{PROJECT_ID}/spatial-services/{SERVICE_ID}/coverages/{COVERAGE_ID}/derivatives"
    )
    payload = {
        "subset_extent": [-77.2, 38.8, -76.8, 39.2],
        "target_crs": "EPSG:3857",
        "width": 256,
        "height": 128,
        "resampling": "bilinear",
    }

    invalid = client.post(
        endpoint,
        headers=headers(),
        json={**payload, "width": 8192, "height": 8192},
    )
    assert invalid.status_code == 422
    created = client.post(endpoint, headers=headers(), json=payload)
    replayed = client.post(endpoint, headers=headers(), json=payload)

    assert created.status_code == 202
    assert replayed.status_code == 202
    assert created.json()["id"] == str(DERIVATIVE_ID)
    assert created.json()["state"] == "queued"
    assert created.json()["request_schema_version"] == 2
    assert created.json()["band_indexes"] == [1, 2]
    assert created.json()["scale_mode"] == "size"
    assert created.json()["requested_resolution"] is None
    assert created.json()["request_checksum_sha256"] == derivative_job().request_checksum_sha256
    assert "output_bucket" not in created.json()
    assert dispatcher.derivatives == [DERIVATIVE_ID, DERIVATIVE_ID]
    listed = client.get(endpoint, headers=headers())
    assert listed.status_code == 200
    assert listed.json()[0]["source_available"] is True


def test_range_resolution_policy_and_queued_cancellation_are_explicit() -> None:
    repository = MemoryCoverageRepository()
    client = api_client(repository, MemoryDispatcher())
    create_coverage(client)
    root = f"/projects/{PROJECT_ID}/spatial-services/{SERVICE_ID}"
    endpoint = f"{root}/coverages/{COVERAGE_ID}/derivatives"

    policy = client.get(f"{root}/coverage-processing-policy", headers=headers())
    assert policy.status_code == 200
    assert policy.json()["maximum_active_jobs_per_coverage"] == 4
    assert policy.json()["maximum_retained_jobs_per_coverage"] == 64
    assert policy.json()["cancellation_states"] == ["queued"]
    assert policy.json()["ordinary_reads_create_work"] is False

    invalid_crs = client.post(
        endpoint,
        headers=headers(),
        json={
            "subset_extent": [-77.2, 38.8, -76.8, 39.2],
            "target_crs": "EPSG:3857",
            "resolution": [0.01, 0.01],
            "band_indexes": [2],
        },
    )
    assert invalid_crs.status_code == 409
    assert invalid_crs.json()["detail"]["code"].endswith("resolution_crs_invalid")

    created = client.post(
        endpoint,
        headers=headers(),
        json={
            "subset_extent": [-77.2, 38.8, -76.8, 39.2],
            "target_crs": "EPSG:4326",
            "resolution": [0.01, 0.01],
            "band_indexes": [2],
            "resampling": "cubic",
        },
    )
    assert created.status_code == 202
    assert created.json()["target_width"] == 40
    assert created.json()["target_height"] == 40
    assert created.json()["band_indexes"] == [2]
    assert created.json()["scale_mode"] == "resolution"
    assert created.json()["requested_resolution"] == [0.01, 0.01]

    cancelled = client.post(f"{endpoint}/{DERIVATIVE_ID}/cancel", headers=headers())
    assert cancelled.status_code == 200
    assert cancelled.json()["state"] == "cancelled"
    assert cancelled.json()["error_code"] == "cancelled_by_user"
    assert client.post(f"{endpoint}/{DERIVATIVE_ID}/cancel", headers=headers()).status_code == 409


def test_completed_derivative_and_draft_ogc_coverage_reads_only_redirect_exact_objects() -> None:
    repository = MemoryCoverageRepository()
    client = api_client(repository, MemoryDispatcher())
    create_coverage(client)
    repository.derivative = derivative_job(state="completed")
    admin = (
        f"/projects/{PROJECT_ID}/spatial-services/{SERVICE_ID}/coverages/"
        f"{COVERAGE_ID}/derivatives/{DERIVATIVE_ID}"
    )
    root = f"/projects/{PROJECT_ID}/services/earth-observation/ogc/collections/elevation"

    detail = client.get(root, headers=headers())
    domain = client.get(f"{root}/coverage/domainset", headers=headers())
    range_type = client.get(f"{root}/coverage/rangetype", headers=headers())
    schema = client.get(f"{root}/schema", headers=headers())
    derivative_domain = client.get(
        f"{root}/coverage/domainset",
        headers=headers(),
        params={"derivative": str(DERIVATIVE_ID)},
    )
    derivative_range = client.get(
        f"{root}/coverage/rangetype",
        headers=headers(),
        params={"derivative": str(DERIVATIVE_ID)},
    )
    exact = client.get(f"{root}/coverage", headers=headers(), follow_redirects=False)
    derived = client.get(
        f"{root}/coverage",
        headers=headers(),
        params={"derivative": str(DERIVATIVE_ID)},
        follow_redirects=False,
    )
    admin_download = client.post(f"{admin}/download", headers=headers())

    assert detail.status_code == 200
    assert detail.json()["itemType"] == "coverage"
    assert detail.json()["opengeo:derivativesAreExplicit"] is True
    assert detail.json()["opengeo:conformanceClaimed"] is False
    assert domain.json()["grid"]["high"] == [511, 255]
    assert range_type.json()["field"][0]["name"] == "band-1"
    assert schema.json()["required"] == ["band-1", "band-2"]
    assert derivative_domain.json()["grid"]["high"] == [255, 127]
    assert derivative_domain.json()["opengeo:derivativeId"] == str(DERIVATIVE_ID)
    assert derivative_range.json()["field"][1]["name"] == "band-2"
    assert exact.status_code == 307
    assert exact.headers["x-opengeo-coverage-checksum-sha256"] == "a" * 64
    assert derived.status_code == 307
    assert derived.headers["x-opengeo-coverage-checksum-sha256"] == "c" * 64
    assert admin_download.status_code == 200
    assert admin_download.json()["method"] == "GET"
    assert repository.derivative.state == "completed"


def test_reclamation_requires_preview_then_dispatches_only_an_identity() -> None:
    repository = MemoryCoverageRepository()
    dispatcher = MemoryDispatcher()
    client = api_client(repository, dispatcher)
    create_coverage(client)
    repository.derivative = derivative_job(state="completed")
    root = (
        f"/projects/{PROJECT_ID}/spatial-services/{SERVICE_ID}/coverages/"
        f"{COVERAGE_ID}/derivatives/{DERIVATIVE_ID}"
    )

    preview = client.post(f"{root}/reclamation-preview", headers=headers())
    assert preview.status_code == 200
    assert preview.json()["physical_action"] == "delete_exact_storage_version"
    assert preview.json()["history_retained"] is True
    assert "bucket" not in preview.json()
    assert "storage_version_id" not in preview.json()

    reclaimed = client.post(
        f"{root}/reclaim",
        headers=headers(),
        json={
            "preview_checksum_sha256": preview.json()["preview_checksum_sha256"],
            "preview_expires_at": preview.json()["expires_at"],
        },
    )
    assert reclaimed.status_code == 202
    assert reclaimed.json()["state"] == "queued"
    assert dispatcher.reclamations == [RECLAMATION_ID]
    assert repository.derivative is not None
    assert repository.derivative.output_available is False
    assert client.post(f"{root}/download", headers=headers()).status_code == 409


def test_ogc_coverage_query_rejects_duplicates_unknowns_and_unready_derivatives() -> None:
    repository = MemoryCoverageRepository()
    client = api_client(repository, MemoryDispatcher())
    create_coverage(client)
    repository.derivative = derivative_job()
    root = f"/projects/{PROJECT_ID}/services/earth-observation/ogc/collections/elevation/coverage"

    assert client.get(f"{root}?unexpected=true", headers=headers()).status_code == 400
    duplicate = client.get(
        f"{root}?derivative={DERIVATIVE_ID}&derivative={DERIVATIVE_ID}", headers=headers()
    )
    assert duplicate.status_code == 400
    unready = client.get(root, headers=headers(), params={"derivative": str(DERIVATIVE_ID)})
    assert unready.status_code == 409


@pytest.mark.parametrize("resource_ids", [(), (UUID(int=91),)])
def test_coverage_discovery_preserves_metadata_identities(resource_ids) -> None:
    repository = MemoryCoverageRepository()
    client = api_client(repository, MemoryDispatcher())
    create_coverage(client)
    assert repository.coverage is not None
    repository.coverage = replace(
        repository.coverage, metadata_resource_id=resource_ids[0] if resource_ids else None
    )
    root = f"/projects/{PROJECT_ID}/services/earth-observation/ogc/collections"
    detail = client.get(f"{root}/elevation", headers=headers())
    listing = client.get(root, headers=headers())
    assert detail.status_code == listing.status_code == 200
    listed = next(item for item in listing.json()["collections"] if item["id"] == "elevation")
    for document in (detail.json(), listed):
        links = [link for link in document["links"] if link["rel"] == "describedby"]
        assert [link["href"] for link in links] == [
            f"http://testserver/projects/{PROJECT_ID}/records/collections/resources/items/{resource_id}"
            for resource_id in resource_ids
        ]
        assert all(link["type"] == "application/geo+json" for link in links)
        assert "license" not in document
