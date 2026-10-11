import asyncio
import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID
from xml.etree import ElementTree as ET

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.processing_dispatch import ProcessingDispatchUnavailable
from opengeo_api.render_routes import _wait_for_public_wms_map_job, _wait_for_wms_map_job
from opengeo_api.rendering import (
    MapCollection,
    ProjectMapCatalog,
    ProjectMapLayer,
    PublicWmsService,
    RenderAccessDenied,
    RenderConflict,
    RenderedMapOutput,
    RenderJob,
    RenderNotFound,
    RenderProfile,
    RenderRequest,
    RenderSubmission,
    WmsLayerPublication,
    render_request_checksum,
)
from opengeo_api.s3_downloads import DownloadTicket
from opengeo_api.tenant_database import TenantContext
from opengeo_api.wms import OGC_NAMESPACE, WMS_NAMESPACE

USER_ID = UUID("20000000-0000-4000-8000-0000000000c1")
ORG_ID = UUID("10000000-0000-4000-8000-0000000000c1")
PROJECT_ID = UUID("50000000-0000-4000-8000-0000000000c1")
RESOURCE_ID = UUID("a0000000-0000-4000-8000-0000000000c1")
SECOND_RESOURCE_ID = UUID("a0000000-0000-4000-8000-0000000000c2")
PROFILE_ID = UUID("a1000000-0000-4000-8000-0000000000c1")
SECOND_PROFILE_ID = UUID("a1000000-0000-4000-8000-0000000000c2")
PROFILE_VERSION_ID = UUID("a2000000-0000-4000-8000-0000000000c1")
RESOURCE_VERSION_ID = UUID("a3000000-0000-4000-8000-0000000000c1")
DATASET_ID = UUID("80000000-0000-4000-8000-0000000000c1")
DATASET_VERSION_ID = UUID("81000000-0000-4000-8000-0000000000c1")
STYLE_ID = UUID("a4000000-0000-4000-8000-0000000000c1")
STYLE_VERSION_ID = UUID("a5000000-0000-4000-8000-0000000000c1")
JOB_ID = UUID("a6000000-0000-4000-8000-0000000000c1")
OUTPUT_ID = UUID("a7000000-0000-4000-8000-0000000000c1")
IDEMPOTENCY_ID = UUID("a8000000-0000-4000-8000-0000000000c1")
PUBLICATION_ID = UUID("a9000000-0000-4000-8000-0000000000c1")
SECOND_PUBLICATION_ID = UUID("a9000000-0000-4000-8000-0000000000c2")
PUBLIC_SERVICE_ID = UUID("aa000000-0000-4000-8000-0000000000c1")
NOW = datetime(2026, 8, 20, 14, tzinfo=UTC)
DIRECT_MAP_MAX_BYTES_FOR_TEST = 4_194_304
MAP_SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'
MAP_PNG = b"\x89PNG\r\n\x1a\nexact-governed-map"


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


def profile(version: int = 1) -> RenderProfile:
    return RenderProfile(
        profile_id=PROFILE_ID,
        project_id=PROJECT_ID,
        resource_id=RESOURCE_ID,
        slug="roads-svg",
        version_number=version,
        title="Roads SVG",
        resource_version_id=RESOURCE_VERSION_ID,
        dataset_id=DATASET_ID,
        dataset_version_id=DATASET_VERSION_ID,
        style_id=STYLE_ID,
        style_version_id=STYLE_VERSION_ID,
        configuration={
            "schema": "opengeo.render.v1",
            "renderer": "opengeo.deterministic-svg.v1",
            "geometry": {"type": "line", "color": "#275d52"},
        },
        checksum_sha256="a" * 64,
        change_message="Revised" if version > 1 else None,
        created_by=USER_ID,
        created_at=NOW,
        updated_at=NOW,
    )


def second_profile() -> RenderProfile:
    return RenderProfile(
        profile_id=SECOND_PROFILE_ID,
        project_id=PROJECT_ID,
        resource_id=SECOND_RESOURCE_ID,
        slug="lakes-svg",
        version_number=2,
        title="Lakes SVG",
        resource_version_id=UUID("a3000000-0000-4000-8000-0000000000c2"),
        dataset_id=UUID("80000000-0000-4000-8000-0000000000c2"),
        dataset_version_id=UUID("81000000-0000-4000-8000-0000000000c2"),
        style_id=UUID("a4000000-0000-4000-8000-0000000000c2"),
        style_version_id=UUID("a5000000-0000-4000-8000-0000000000c2"),
        configuration={
            "schema": "opengeo.render.v1",
            "renderer": "opengeo.deterministic-svg.v1",
            "geometry": {"type": "fill", "color": "#357edd"},
        },
        checksum_sha256="d" * 64,
        change_message=None,
        created_by=USER_ID,
        created_at=NOW,
        updated_at=NOW,
    )


def publication(
    *,
    publication_id: UUID = PUBLICATION_ID,
    resource_id: UUID = RESOURCE_ID,
    name: str = "cite:RoadSegments",
    default_profile_id: UUID = PROFILE_ID,
    withdrawn: bool = False,
) -> WmsLayerPublication:
    return WmsLayerPublication(
        publication_id=publication_id,
        project_id=PROJECT_ID,
        resource_id=resource_id,
        name=name,
        default_profile_id=default_profile_id,
        created_by=USER_ID,
        created_at=NOW,
        withdrawn_by=USER_ID if withdrawn else None,
        withdrawn_at=NOW if withdrawn else None,
    )


def public_service(*, disabled: bool = False) -> PublicWmsService:
    return PublicWmsService(
        service_id=PUBLIC_SERVICE_ID,
        project_id=PROJECT_ID,
        title="Public research maps",
        created_by=USER_ID,
        created_at=NOW,
        disabled_by=USER_ID if disabled else None,
        disabled_at=NOW if disabled else None,
    )


def job(
    state="queued",
    output_size: int | None = None,
    *,
    bbox: tuple[float, float, float, float] = (84.0, 27.0, 86.0, 29.0),
    crs: str = "CRS:84",
    output_format: str = "svg",
    background_color: str | None = None,
    transparent: bool = False,
    width: int = 800,
    height: int = 600,
    request_checksum: str = "b" * 64,
) -> RenderJob:
    completed = state == "completed"
    content_type = "image/svg+xml" if output_format == "svg" else "image/png"
    body = MAP_SVG if output_format == "svg" else MAP_PNG
    return RenderJob(
        job_id=JOB_ID,
        project_id=PROJECT_ID,
        resource_id=RESOURCE_ID,
        profile_id=PROFILE_ID,
        profile_version_id=PROFILE_VERSION_ID,
        profile_version_number=1,
        dataset_id=DATASET_ID,
        dataset_version_id=DATASET_VERSION_ID,
        style_id=STYLE_ID,
        style_version_id=STYLE_VERSION_ID,
        bbox=bbox,
        crs=crs,  # type: ignore[arg-type]
        width=width,
        height=height,
        format=output_format,  # type: ignore[arg-type]
        background_color=background_color,
        transparent=transparent,
        request_checksum_sha256=request_checksum,
        state=state,
        attempt_count=1 if completed else 0,
        output_object_id=OUTPUT_ID if completed else None,
        output_content_type=content_type if completed else None,
        output_size_bytes=(len(body) if output_size is None else output_size)
        if completed
        else None,
        output_checksum_sha256="c" * 64 if completed else None,
        error_code=None,
        created_by=USER_ID,
        created_at=NOW,
        started_at=NOW if completed else None,
        finished_at=NOW if completed else None,
    )


class FakeRepository:
    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.map_job: RenderJob | None = None
        self.public_service_enabled = True

    async def get_map_collection(self, context, project_id, resource_id):
        self.calls.append(("get-map-collection", context, project_id, resource_id))
        return MapCollection(
            resource_id=RESOURCE_ID,
            slug="roads",
            title="Road network",
            description="Curated road centerlines",
            attribution="Open data office",
            spatial_extent=(84.0, 27.0, 86.0, 29.0),
            temporal_start=NOW,
            temporal_end=NOW,
        )

    async def get_project_map_catalog(self, context, project_id):
        self.calls.append(("get-project-map-catalog", context, project_id))
        return ProjectMapCatalog(
            "Research project",
            (
                ProjectMapLayer(
                    publication(),
                    MapCollection(
                        RESOURCE_ID,
                        "roads",
                        "Road network",
                        "Curated road centerlines",
                        "Open data office",
                        (84.0, 27.0, 86.0, 29.0),
                        NOW,
                        NOW,
                    ),
                    (profile(),),
                ),
                ProjectMapLayer(
                    publication(
                        publication_id=SECOND_PUBLICATION_ID,
                        resource_id=SECOND_RESOURCE_ID,
                        name="cite:Lakes",
                        default_profile_id=SECOND_PROFILE_ID,
                    ),
                    MapCollection(
                        SECOND_RESOURCE_ID,
                        "lakes",
                        "Lakes",
                        "Curated lakes",
                        "Open data office",
                        (83.0, 26.0, 87.0, 30.0),
                        NOW,
                        NOW,
                    ),
                    (second_profile(),),
                ),
            ),
        )

    async def list_wms_publications(self, context, project_id):
        self.calls.append(("list-wms-publications", context, project_id))
        return [publication()]

    async def create_wms_publication(
        self, context, project_id, resource_id, name, default_profile_id, request_id
    ):
        self.calls.append(
            (
                "create-wms-publication",
                context,
                project_id,
                resource_id,
                name,
                default_profile_id,
                request_id,
            )
        )
        return publication(name=name, default_profile_id=default_profile_id)

    async def withdraw_wms_publication(
        self, context, project_id, resource_id, publication_id, request_id
    ):
        self.calls.append(
            (
                "withdraw-wms-publication",
                context,
                project_id,
                resource_id,
                publication_id,
                request_id,
            )
        )
        return publication(withdrawn=True)

    async def list_public_wms_services(self, context, project_id):
        self.calls.append(("list-public-wms-services", context, project_id))
        return [public_service(disabled=not self.public_service_enabled)]

    async def create_public_wms_service(self, context, project_id, title, request_id):
        self.calls.append(("create-public-wms-service", context, project_id, title, request_id))
        return public_service()

    async def disable_public_wms_service(self, context, project_id, service_id, request_id):
        self.calls.append(
            ("disable-public-wms-service", context, project_id, service_id, request_id)
        )
        self.public_service_enabled = False
        return public_service(disabled=True)

    async def get_public_project_map_catalog(self, context, project_id, service_id):
        self.calls.append(("get-public-project-map-catalog", context, project_id, service_id))
        if (
            not self.public_service_enabled
            or context.organization_id != ORG_ID
            or project_id != PROJECT_ID
            or service_id != PUBLIC_SERVICE_ID
        ):
            raise RenderNotFound("public_wms_service")
        catalog = await self.get_project_map_catalog(context, project_id)
        return ProjectMapCatalog("Public research maps", catalog.layers)

    async def find_public_job_by_idempotency(
        self, context, project_id, service_id, resource_id, idempotency_key
    ):
        self.calls.append(
            (
                "find-public-job",
                context,
                project_id,
                service_id,
                resource_id,
                idempotency_key,
            )
        )
        if not self.public_service_enabled:
            raise RenderNotFound("public_wms_layer")
        return self.map_job

    async def find_public_composite_job_by_idempotency(
        self, context, project_id, service_id, resource_ids, idempotency_key
    ):
        self.calls.append(
            (
                "find-public-composite-job",
                context,
                project_id,
                service_id,
                resource_ids,
                idempotency_key,
            )
        )
        if not self.public_service_enabled:
            raise RenderNotFound("public_wms_layer")
        return self.map_job

    async def request_public_download(self, context, project_id, service_id, resource_id, job_id):
        self.calls.append(("public-download", context, project_id, service_id, resource_id, job_id))
        return DownloadTicket(
            "https://opengeo-render-test.s3.us-east-1.amazonaws.com/public-output.svg",
            "GET",
            NOW + timedelta(minutes=5),
        )

    async def request_public_composite_download(
        self, context, project_id, service_id, resource_ids, job_id
    ):
        self.calls.append(
            ("public-composite-download", context, project_id, service_id, resource_ids, job_id)
        )
        return DownloadTicket(
            "https://opengeo-render-test.s3.us-east-1.amazonaws.com/public-composite.svg",
            "GET",
            NOW + timedelta(minutes=5),
        )

    async def read_public_map_output(
        self, context, project_id, service_id, resource_id, job_id, maximum_bytes
    ):
        self.calls.append(
            (
                "read-public-map-output",
                context,
                project_id,
                service_id,
                resource_id,
                job_id,
                maximum_bytes,
            )
        )
        if not self.public_service_enabled:
            raise RenderNotFound("public_wms_layer")
        return RenderedMapOutput(
            body=MAP_SVG,
            filename="roads-public.svg",
            content_type="image/svg+xml",
            size_bytes=len(MAP_SVG),
            checksum_sha256="c" * 64,
            version_id="s3-version-public",
        )

    async def read_public_composite_map_output(
        self, context, project_id, service_id, resource_ids, job_id, maximum_bytes
    ):
        self.calls.append(
            (
                "read-public-composite-output",
                context,
                project_id,
                service_id,
                resource_ids,
                job_id,
                maximum_bytes,
            )
        )
        if not self.public_service_enabled:
            raise RenderNotFound("public_wms_layer")
        return RenderedMapOutput(
            body=MAP_SVG,
            filename="public-composite.svg",
            content_type="image/svg+xml",
            size_bytes=len(MAP_SVG),
            checksum_sha256="c" * 64,
            version_id="s3-version-public-composite",
        )

    async def list_profiles(self, context, project_id, resource_id):
        self.calls.append(("list", context, project_id, resource_id))
        return [profile()]

    async def get_profile(self, context, project_id, resource_id, profile_id):
        self.calls.append(("get-profile", context, project_id, resource_id, profile_id))
        return profile()

    async def create_profile(self, context, project_id, resource_id, draft, request_id):
        self.calls.append(("create", context, project_id, resource_id, draft, request_id))
        return profile()

    async def update_profile(
        self, context, project_id, resource_id, profile_id, expected_version, draft, request_id
    ):
        self.calls.append(
            (
                "update",
                context,
                project_id,
                resource_id,
                profile_id,
                expected_version,
                draft,
                request_id,
            )
        )
        return profile(expected_version + 1)

    async def request_render(
        self, context, project_id, resource_id, profile_id, request, request_id
    ):
        self.calls.append(
            ("request", context, project_id, resource_id, profile_id, request, request_id)
        )
        self.map_job = job(
            bbox=request.bbox,
            crs=request.crs,
            output_format=request.format,
            background_color=request.background_color,
            transparent=request.transparent,
            width=request.width,
            height=request.height,
        )
        return RenderSubmission(self.map_job, True)

    async def request_composite_render(self, context, project_id, layers, request, request_id):
        self.calls.append(("request-composite", context, project_id, layers, request, request_id))
        profiles = tuple(
            profile() if layer.profile_id == PROFILE_ID else second_profile() for layer in layers
        )
        self.map_job = job(
            bbox=request.bbox,
            crs=request.crs,
            output_format=request.format,
            background_color=request.background_color,
            transparent=request.transparent,
            width=request.width,
            height=request.height,
            request_checksum=render_request_checksum(profiles, request),
        )
        return RenderSubmission(self.map_job, True)

    async def find_job_by_idempotency(self, context, project_id, resource_id, idempotency_key):
        self.calls.append(("find-job", context, project_id, resource_id, idempotency_key))
        return self.map_job

    async def find_composite_job_by_idempotency(self, context, project_id, idempotency_key):
        self.calls.append(("find-composite", context, project_id, idempotency_key))
        return self.map_job

    async def get_job(self, context, project_id, resource_id, job_id):
        self.calls.append(("get-job", context, project_id, resource_id, job_id))
        assert self.map_job is not None
        return job(
            "completed",
            bbox=self.map_job.bbox,
            crs=self.map_job.crs,
            output_format=self.map_job.format,
            background_color=self.map_job.background_color,
            transparent=self.map_job.transparent,
            width=self.map_job.width,
            height=self.map_job.height,
        )

    async def get_composite_job(self, context, project_id, job_id):
        self.calls.append(("get-composite", context, project_id, job_id))
        assert self.map_job is not None
        return job(
            "completed",
            bbox=self.map_job.bbox,
            crs=self.map_job.crs,
            output_format=self.map_job.format,
            background_color=self.map_job.background_color,
            transparent=self.map_job.transparent,
            width=self.map_job.width,
            height=self.map_job.height,
            request_checksum=self.map_job.request_checksum_sha256,
        )

    async def request_download(self, context, project_id, resource_id, job_id, request_id):
        self.calls.append(("download", context, project_id, resource_id, job_id, request_id))
        extension = self.map_job.format if self.map_job is not None else "svg"
        return DownloadTicket(
            f"https://opengeo-render-test.s3.us-east-1.amazonaws.com/output.{extension}",
            "GET",
            NOW + timedelta(minutes=5),
        )

    async def request_composite_download(self, context, project_id, job_id, request_id):
        self.calls.append(("download-composite", context, project_id, job_id, request_id))
        return await self.request_download(context, project_id, RESOURCE_ID, job_id, request_id)

    async def read_map_output(
        self, context, project_id, resource_id, job_id, maximum_bytes, request_id
    ):
        self.calls.append(
            (
                "read-map-output",
                context,
                project_id,
                resource_id,
                job_id,
                maximum_bytes,
                request_id,
            )
        )
        output_format = self.map_job.format if self.map_job is not None else "svg"
        body = MAP_SVG if output_format == "svg" else MAP_PNG
        content_type = "image/svg+xml" if output_format == "svg" else "image/png"
        return RenderedMapOutput(
            body=body,
            filename=f"roads-output.{output_format}",
            content_type=content_type,
            size_bytes=len(body),
            checksum_sha256="c" * 64,
            version_id="s3-version-1",
        )

    async def read_composite_map_output(
        self, context, project_id, job_id, maximum_bytes, request_id
    ):
        self.calls.append(
            (
                "read-composite-output",
                context,
                project_id,
                job_id,
                maximum_bytes,
                request_id,
            )
        )
        assert self.map_job is not None
        body = MAP_SVG if self.map_job.format == "svg" else MAP_PNG
        content_type = "image/svg+xml" if self.map_job.format == "svg" else "image/png"
        return RenderedMapOutput(
            body=body,
            filename=f"project-output.{self.map_job.format}",
            content_type=content_type,
            size_bytes=len(body),
            checksum_sha256="c" * 64,
            version_id="s3-version-composition",
        )


class Dispatcher:
    def __init__(self, failure: bool = False) -> None:
        self.failure = failure
        self.jobs: list[UUID] = []

    async def dispatch_render(self, job_id: UUID) -> None:
        self.jobs.append(job_id)
        if self.failure:
            raise ProcessingDispatchUnavailable


def client(
    repository: FakeRepository,
    dispatcher: Dispatcher | None = None,
    settings: Settings | None = None,
) -> TestClient:
    return TestClient(
        create_app(
            settings=settings or Settings(env="test", expose_docs=True),
            readiness_probe=PassingProbe(),
            token_verifier=FakeVerifier(),
            principal_repository=FakePrincipalRepository(),
            render_repository=repository,
            render_dispatcher=dispatcher or Dispatcher(),
        )
    )


def headers() -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(ORG_ID),
        "X-Request-ID": "request-render-123",
    }


def profile_payload() -> dict:
    return {
        "slug": "roads-svg",
        "title": "Roads SVG",
        "style_id": str(STYLE_ID),
        "geometry_layer_id": "roads",
        "label_layer_id": "road-labels",
        "minimum_scale_denominator": 1_000,
        "maximum_scale_denominator": 2_000_000,
        "include_legend": True,
    }


def wms_map_parameters(style_id: str = str(PROFILE_ID)) -> dict[str, str]:
    return {
        "SERVICE": "WMS",
        "VERSION": "1.3.0",
        "REQUEST": "GetMap",
        "LAYERS": str(RESOURCE_ID),
        "STYLES": style_id,
        "CRS": "CRS:84",
        "BBOX": "84,27,86,29",
        "WIDTH": "800",
        "HEIGHT": "600",
        "FORMAT": "image/svg+xml",
        "TRANSPARENT": "FALSE",
        "EXCEPTIONS": "XML",
    }


def public_wms_path(*, organization_id: UUID = ORG_ID, service_id: UUID = PUBLIC_SERVICE_ID) -> str:
    return f"/public/organizations/{organization_id}/projects/{PROJECT_ID}/wms/{service_id}"


def public_wms_map_parameters() -> dict[str, str]:
    parameters = wms_map_parameters()
    parameters["LAYERS"] = "cite:RoadSegments"
    return parameters


def geomoose_wms_map_parameters() -> dict[str, str]:
    return {
        "SERVICE": "WMS",
        "VERSION": "1.1.1",
        "REQUEST": "GetMap",
        "FORMAT": "image/png",
        "TRANSPARENT": "true",
        "LAYERS": "cite:RoadSegments",
        "cross-origin": "anonymous",
        "SRS": "EPSG:3857",
        "STYLES": "",
        "WIDTH": "800",
        "HEIGHT": "800",
        "BBOX": "9000000,3000000,10000000,4000000",
    }


def test_profile_automation_and_render_output_flow_are_typed_and_attributed() -> None:
    repository = FakeRepository()
    dispatcher = Dispatcher()
    api = client(repository, dispatcher)
    base = f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}"

    created = api.post(f"{base}/render-profiles", headers=headers(), json=profile_payload())
    listed = api.get(f"{base}/render-profiles", headers=headers())
    fetched = api.get(f"{base}/render-profiles/{PROFILE_ID}", headers=headers())
    update = profile_payload()
    update.pop("slug")
    update.update(expected_version=1, change_message="Cartographic review")
    updated = api.put(f"{base}/render-profiles/{PROFILE_ID}", headers=headers(), json=update)
    queued = api.post(
        f"{base}/render-profiles/{PROFILE_ID}/renders",
        headers=headers(),
        json={
            "idempotency_key": str(IDEMPOTENCY_ID),
            "bbox": [84, 27, 86, 29],
            "width": 800,
            "height": 600,
            "format": "svg",
        },
    )
    completed = api.get(f"{base}/renders/{JOB_ID}", headers=headers())
    download = api.post(f"{base}/renders/{JOB_ID}/download", headers=headers())

    assert created.status_code == 201
    assert created.json()["configuration"]["schema"] == "opengeo.render.v1"
    assert listed.json()[0]["dataset_version_id"] == str(DATASET_VERSION_ID)
    assert fetched.json()["style_version_id"] == str(STYLE_VERSION_ID)
    assert updated.json()["version_number"] == 2
    assert queued.status_code == 202
    assert queued.json()["state"] == "queued"
    assert queued.json()["background_color"] is None
    assert queued.json()["transparent"] is False
    assert dispatcher.jobs == [JOB_ID]
    assert completed.json()["output_checksum_sha256"] == "c" * 64
    assert download.json()["method"] == "GET"
    assert repository.calls[0][4].geometry_layer_id == "roads"
    assert repository.calls[5][5].idempotency_key == IDEMPOTENCY_ID


def test_render_contract_rejects_ambiguous_or_excessive_requests_before_dispatch() -> None:
    repository = FakeRepository()
    dispatcher = Dispatcher()
    api = client(repository, dispatcher)
    base = f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}"
    same_layers = profile_payload()
    same_layers["label_layer_id"] = "roads"

    invalid_responses = [
        api.post(f"{base}/render-profiles", headers=headers(), json=same_layers),
        api.post(
            f"{base}/render-profiles/{PROFILE_ID}/renders",
            headers=headers(),
            json={
                "idempotency_key": str(IDEMPOTENCY_ID),
                "bbox": [86, 27, 84, 29],
                "width": 800,
                "height": 600,
            },
        ),
        api.post(
            f"{base}/render-profiles/{PROFILE_ID}/renders",
            headers=headers(),
            json={
                "idempotency_key": str(IDEMPOTENCY_ID),
                "bbox": [-180, -90, 180, 90],
                "width": 2048,
                "height": 2048,
                "unexpected": True,
            },
        ),
    ]

    assert all(response.status_code == 422 for response in invalid_responses)
    assert repository.calls == []
    assert dispatcher.jobs == []


def test_a_committed_queued_job_is_retryable_when_dispatch_is_temporarily_unavailable() -> None:
    repository = FakeRepository()
    dispatcher = Dispatcher(failure=True)
    response = client(repository, dispatcher).post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/render-profiles/{PROFILE_ID}/renders",
        headers=headers(),
        json={
            "idempotency_key": str(IDEMPOTENCY_ID),
            "bbox": [84, 27, 86, 29],
            "width": 800,
            "height": 600,
        },
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "render_dispatch_unavailable"}
    assert repository.calls[0][0] == "request"
    assert dispatcher.jobs == [JOB_ID]


def test_map_endpoint_is_deterministic_async_and_does_not_duplicate_work() -> None:
    repository = FakeRepository()
    dispatcher = Dispatcher()
    api = client(repository, dispatcher)
    path = f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/render-profiles/{PROFILE_ID}/map"
    parameters = {"bbox": "84,27,86,29", "width": 800, "height": 600, "f": "svg"}

    first = api.get(path, headers={**headers(), "Accept": "image/svg+xml"}, params=parameters)
    second = api.get(path, headers=headers(), params=parameters)

    assert first.status_code == 202
    assert first.headers["cache-control"] == "no-store"
    assert first.headers["retry-after"] == "5"
    assert first.headers["location"].endswith(f"/renders/{JOB_ID}")
    assert 'rel="monitor"' in first.headers["link"]
    assert first.json()["status"] == "accepted"
    assert first.json()["media_type"] == "image/svg+xml"
    assert first.json()["crs"].endswith("/CRS84")
    assert second.status_code == 202
    requests = [call for call in repository.calls if call[0] == "request"]
    finds = [call for call in repository.calls if call[0] == "find-job"]
    assert len(requests) == 2
    assert len(finds) == 2
    assert requests[0][5].idempotency_key == requests[1][5].idempotency_key
    assert requests[0][5].idempotency_key == finds[0][4] == finds[1][4]
    assert requests[0][5].expected_profile_version == 1
    assert dispatcher.jobs == [JOB_ID, JOB_ID]


def test_map_endpoint_rejects_a_stale_explicit_profile_seal_before_rendering() -> None:
    repository = FakeRepository()
    dispatcher = Dispatcher()
    response = client(repository, dispatcher).get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/render-profiles/{PROFILE_ID}/map",
        headers=headers(),
        params={
            "bbox": "84,27,86,29",
            "expected_profile_version": 2,
        },
    )

    assert response.status_code == 409
    assert response.json() == {
        "detail": {
            "code": "map_profile_version_conflict",
            "expected_version": 2,
            "current_version": 1,
        }
    }
    assert [call[0] for call in repository.calls] == ["get-profile"]
    assert dispatcher.jobs == []


def test_map_identity_distinguishes_format_and_crs() -> None:
    path = f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/render-profiles/{PROFILE_ID}/map"

    def queued_identity(parameters: dict[str, object], accept: str) -> UUID:
        repository = FakeRepository()
        response = client(repository).get(
            path,
            headers={**headers(), "Accept": accept},
            params={"width": 800, "height": 600, **parameters},
        )
        assert response.status_code == 202
        request_call = next(call for call in repository.calls if call[0] == "request")
        return request_call[5].idempotency_key

    svg_crs84 = queued_identity({"bbox": "84,27,86,29", "f": "svg"}, "image/svg+xml")
    png_crs84 = queued_identity({"bbox": "84,27,86,29", "f": "png"}, "image/png")
    svg_3857 = queued_identity(
        {
            "bbox": "9000000,3000000,10000000,4000000",
            "crs": "http://www.opengis.net/def/crs/EPSG/0/3857",
            "f": "svg",
        },
        "image/svg+xml",
    )
    colored_svg = queued_identity(
        {
            "bbox": "84,27,86,29",
            "f": "svg",
            "background_color": "#102030",
        },
        "image/svg+xml",
    )
    transparent_svg = queued_identity(
        {"bbox": "84,27,86,29", "f": "svg", "transparent": "true"},
        "image/svg+xml",
    )

    assert len({svg_crs84, png_crs84, svg_3857, colored_svg, transparent_svg}) == 5


def test_read_only_map_client_can_monitor_queued_work_without_redispatching() -> None:
    class ReadOnlyRepository(FakeRepository):
        async def request_render(self, *args, **kwargs):
            self.calls.append(("request-denied", *args))
            del kwargs
            raise RenderAccessDenied("action forbidden")

    repository = ReadOnlyRepository()
    repository.map_job = job()
    dispatcher = Dispatcher()
    response = client(repository, dispatcher).get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/render-profiles/{PROFILE_ID}/map",
        headers=headers(),
        params={"bbox": "84,27,86,29", "width": 800, "height": 600},
    )

    assert response.status_code == 202
    assert response.json()["job"]["id"] == str(JOB_ID)
    assert dispatcher.jobs == []


def test_map_endpoint_redirects_only_to_an_exact_completed_signed_output() -> None:
    repository = FakeRepository()
    repository.map_job = job("completed", output_size=DIRECT_MAP_MAX_BYTES_FOR_TEST + 1)
    api = client(repository)
    response = api.get(
        (f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/render-profiles/{PROFILE_ID}/map"),
        headers={**headers(), "Accept": "image/svg+xml"},
        params={"bbox": "84,27,86,29", "width": 800, "height": 600},
        follow_redirects=False,
    )

    assert response.status_code == 303
    assert response.headers["location"].endswith("/output.svg")
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert [call[0] for call in repository.calls] == [
        "get-profile",
        "find-job",
        "download",
    ]


def test_map_endpoint_returns_a_bounded_exact_svg_with_ogc_georeferencing_headers() -> None:
    repository = FakeRepository()
    repository.map_job = job("completed")
    response = client(repository).get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/render-profiles/{PROFILE_ID}/map",
        headers={**headers(), "Accept": "image/svg+xml"},
        params={"bbox": "84,27,86,29", "width": 800, "height": 600},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/svg+xml")
    assert response.headers["content-bbox"] == "84,27,86,29"
    assert response.headers["content-crs"] == ("<http://www.opengis.net/def/crs/OGC/1.3/CRS84>")
    assert response.headers["etag"] == '"' + "c" * 64 + '"'
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-security-policy"] == "default-src 'none'; sandbox"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.content.startswith(b"<svg")
    assert [call[0] for call in repository.calls] == [
        "get-profile",
        "find-job",
        "read-map-output",
    ]


def test_map_endpoint_returns_exact_epsg3857_png_with_distinct_identity() -> None:
    projected_bbox = (9_000_000.0, 3_000_000.0, 10_000_000.0, 4_000_000.0)
    repository = FakeRepository()
    repository.map_job = job(
        "completed",
        bbox=projected_bbox,
        crs="EPSG:3857",
        output_format="png",
    )
    response = client(repository).get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/render-profiles/{PROFILE_ID}/map",
        headers={**headers(), "Accept": "image/png"},
        params={
            "bbox": ",".join(str(value) for value in projected_bbox),
            "crs": "http://www.opengis.net/def/crs/EPSG/0/3857",
            "width": 800,
            "height": 600,
            "f": "png",
        },
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/png")
    assert response.headers["content-crs"] == ("<http://www.opengis.net/def/crs/EPSG/0/3857>")
    assert response.content == MAP_PNG
    assert [call[0] for call in repository.calls] == [
        "get-profile",
        "find-job",
        "read-map-output",
    ]


def test_resource_scoped_ogc_discovery_is_linked_authorized_and_honest() -> None:
    repository = FakeRepository()
    api = client(repository)
    base = f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/ogc"

    landing = api.get(base, headers=headers())
    conformance = api.get(f"{base}/conformance", headers=headers())
    collections = api.get(f"{base}/collections", headers=headers())
    collection = api.get(f"{base}/collections/{RESOURCE_ID}", headers=headers())

    assert landing.status_code == 200
    assert {link["rel"] for link in landing.json()["links"]} == {
        "self",
        "service-desc",
        "conformance",
        "data",
    }
    assert conformance.json() == {"conformsTo": []}
    assert collections.json()["collections"][0]["extent"]["spatial"]["bbox"] == [
        [84.0, 27.0, 86.0, 29.0]
    ]
    described = collection.json()
    assert described["id"] == str(RESOURCE_ID)
    assert described["attribution"] == "Open data office"
    map_links = [
        link
        for link in described["links"]
        if link["rel"] == "https://www.opengis.net/def/rel/ogc/1.0/map"
    ]
    assert all(
        link["href"].split("?", 1)[0].endswith(f"/styles/{PROFILE_ID}/map") for link in map_links
    )
    assert next(link for link in map_links if link["type"] == "image/png")["href"].endswith(
        "?f=png"
    )
    assert {link["type"] for link in map_links} == {"image/svg+xml", "image/png"}
    assert described["crs"] == [
        "http://www.opengis.net/def/crs/OGC/1.3/CRS84",
        "http://www.opengis.net/def/crs/EPSG/0/3857",
    ]
    assert all(
        response.headers["cache-control"] == "no-store"
        for response in (
            landing,
            conformance,
            collections,
            collection,
        )
    )


def test_discovered_map_link_uses_collection_extent_when_bbox_is_omitted() -> None:
    repository = FakeRepository()
    repository.map_job = job("completed")
    response = client(repository).get(
        (
            f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/ogc/collections/{RESOURCE_ID}"
            f"/styles/{PROFILE_ID}/map"
        ),
        headers={**headers(), "Accept": "image/svg+xml"},
        params={"width": 800, "height": 600},
    )

    assert response.status_code == 200
    assert response.headers["content-bbox"] == "84,27,86,29"
    assert [call[0] for call in repository.calls] == [
        "get-map-collection",
        "get-profile",
        "find-job",
        "read-map-output",
    ]


def test_wms_publication_lifecycle_preserves_exact_name_and_attribution() -> None:
    repository = FakeRepository()
    api = client(repository)
    base = f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/wms-publications"

    listed = api.get(f"/projects/{PROJECT_ID}/wms-publications", headers=headers())
    created = api.post(
        base,
        headers=headers(),
        json={"name": "cite:RoadSegments", "default_profile_id": str(PROFILE_ID)},
    )
    withdrawn = api.post(f"{base}/{PUBLICATION_ID}/withdraw", headers=headers())
    invalid = api.post(
        base,
        headers=headers(),
        json={"name": "cite/roads", "default_profile_id": str(PROFILE_ID)},
    )

    assert listed.status_code == 200
    assert listed.json()[0]["name"] == "cite:RoadSegments"
    assert created.status_code == 201
    assert created.json()["default_profile_id"] == str(PROFILE_ID)
    assert withdrawn.status_code == 200
    assert withdrawn.json()["withdrawn_by"] == str(USER_ID)
    assert invalid.status_code == 422
    assert [call[0] for call in repository.calls] == [
        "list-wms-publications",
        "create-wms-publication",
        "withdraw-wms-publication",
    ]
    assert repository.calls[1][4:6] == ("cite:RoadSegments", PROFILE_ID)
    assert repository.calls[1][-1] == "request-render-123"


def test_public_wms_service_lifecycle_is_managed_through_shared_auth() -> None:
    repository = FakeRepository()
    api = client(repository)
    base = f"/projects/{PROJECT_ID}/public-wms-services"

    listed = api.get(base, headers=headers())
    created = api.post(
        base,
        headers=headers(),
        json={"title": "Public research maps"},
    )
    disabled = api.post(
        f"{base}/{PUBLIC_SERVICE_ID}/disable",
        headers=headers(),
    )
    invalid = api.post(base, headers=headers(), json={"title": " "})
    openapi = api.get("/openapi.json")

    assert listed.status_code == 200
    assert listed.json()[0]["id"] == str(PUBLIC_SERVICE_ID)
    assert created.status_code == 201
    assert created.json()["title"] == "Public research maps"
    assert disabled.status_code == 200
    assert disabled.json()["disabled_by"] == str(USER_ID)
    assert invalid.status_code == 422
    assert openapi.status_code == 200
    assert (
        public_wms_path()
        .replace(str(ORG_ID), "{organization_id}")
        .replace(str(PROJECT_ID), "{project_id}")
        .replace(str(PUBLIC_SERVICE_ID), "{service_id}")
        in openapi.json()["paths"]
    )
    assert [call[0] for call in repository.calls] == [
        "list-public-wms-services",
        "create-public-wms-service",
        "disable-public-wms-service",
    ]
    assert repository.calls[1][3:] == ("Public research maps", "request-render-123")


def test_public_wms_capabilities_are_headerless_exact_name_and_bounded_to_sixteen_layers() -> None:
    repository = FakeRepository()
    response = client(repository).get(
        public_wms_path(),
        params={"SERVICE": "WMS", "REQUEST": "GetCapabilities", "VERSION": "1.3.0"},
    )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    root = ET.fromstring(response.content)
    namespace = {"wms": WMS_NAMESPACE, "xlink": "http://www.w3.org/1999/xlink"}
    assert root.findtext("wms:Service/wms:Title", namespaces=namespace) == (
        "OpenGeo — Public research maps"
    )
    assert root.findtext("wms:Service/wms:LayerLimit", namespaces=namespace) == "16"
    layers = root.findall("wms:Capability/wms:Layer/wms:Layer", namespace)
    assert [layer.findtext("wms:Name", namespaces=namespace) for layer in layers] == [
        "cite:RoadSegments",
        "cite:Lakes",
    ]
    online = root.find(
        "wms:Capability/wms:Request/wms:GetMap/wms:DCPType/wms:HTTP/wms:Get/wms:OnlineResource",
        namespace,
    )
    assert online is not None
    assert public_wms_path() in online.attrib["{http://www.w3.org/1999/xlink}href"]
    public_call = repository.calls[0]
    assert public_call[0] == "get-public-project-map-catalog"
    assert public_call[1].user_id.int == 0
    assert public_call[1].organization_id == ORG_ID


def test_public_wms_111_capabilities_are_headerless_and_geo_moose_compatible() -> None:
    repository = FakeRepository()
    response = client(repository).get(
        public_wms_path(),
        params={"SERVICE": "WMS", "REQUEST": "GetCapabilities", "VERSION": "1.1.1"},
    )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert b"WMS_MS_Capabilities.dtd" in response.content
    root = ET.fromstring(response.content)
    assert root.tag == "WMT_MS_Capabilities"
    assert root.attrib["version"] == "1.1.1"
    assert root.findtext("Service/Name") == "OGC:WMS"
    layers = root.findall("Capability/Layer/Layer")
    assert [layer.findtext("Name") for layer in layers] == [
        "cite:RoadSegments",
        "cite:Lakes",
    ]
    assert {node.text for node in layers[0].findall("SRS")} == {
        "EPSG:4326",
        "EPSG:3857",
    }


def test_public_wms_getmap_reads_only_an_exact_prewarmed_output() -> None:
    repository = FakeRepository()
    repository.map_job = job("completed", background_color="#ffffff")
    dispatcher = Dispatcher()
    response = client(repository, dispatcher).get(
        public_wms_path(),
        params=public_wms_map_parameters(),
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/svg+xml")
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["etag"] == '"' + "c" * 64 + '"'
    assert response.content == MAP_SVG
    assert dispatcher.jobs == []
    assert [call[0] for call in repository.calls] == [
        "get-public-project-map-catalog",
        "get-project-map-catalog",
        "find-public-job",
        "read-public-map-output",
    ]
    assert not any(call[0] in {"request", "request-composite"} for call in repository.calls)


def test_public_wms_accepts_exact_geomoose_3152_legacy_request_without_dispatch() -> None:
    class PngRepository(FakeRepository):
        async def read_public_map_output(
            self, context, project_id, service_id, resource_id, job_id, maximum_bytes
        ):
            self.calls.append(
                (
                    "read-public-map-output",
                    context,
                    project_id,
                    service_id,
                    resource_id,
                    job_id,
                    maximum_bytes,
                )
            )
            return RenderedMapOutput(
                body=MAP_PNG,
                filename="roads-public.png",
                content_type="image/png",
                size_bytes=len(MAP_PNG),
                checksum_sha256="c" * 64,
                version_id="s3-version-public-png",
            )

    projected_bbox = (9_000_000.0, 3_000_000.0, 10_000_000.0, 4_000_000.0)
    repository = PngRepository()
    repository.map_job = job(
        "completed",
        bbox=projected_bbox,
        crs="EPSG:3857",
        width=800,
        height=800,
        output_format="png",
        background_color="#ffffff",
        transparent=True,
    )
    dispatcher = Dispatcher()

    response = client(repository, dispatcher).get(
        public_wms_path(),
        params=geomoose_wms_map_parameters(),
    )

    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("image/png")
    assert response.content == MAP_PNG
    assert dispatcher.jobs == []
    assert not any(call[0] in {"request", "request-composite"} for call in repository.calls)


def test_public_wms_multilayer_getmap_reads_only_the_exact_prewarmed_composition() -> None:
    repository = FakeRepository()
    request = RenderRequest(
        idempotency_key=IDEMPOTENCY_ID,
        bbox=(84.0, 27.0, 86.0, 29.0),
        crs="CRS:84",
        width=800,
        height=600,
        format="svg",
        background_color="#ffffff",
        transparent=False,
        expected_profile_version=1,
    )
    repository.map_job = job(
        "completed",
        background_color="#ffffff",
        request_checksum=render_request_checksum((profile(), second_profile()), request),
    )
    parameters = public_wms_map_parameters()
    parameters["LAYERS"] = "cite:RoadSegments,cite:Lakes"
    parameters["STYLES"] = ""
    dispatcher = Dispatcher()

    response = client(repository, dispatcher).get(public_wms_path(), params=parameters)

    assert response.status_code == 200
    assert response.content == MAP_SVG
    assert dispatcher.jobs == []
    assert [call[0] for call in repository.calls] == [
        "get-public-project-map-catalog",
        "get-project-map-catalog",
        "find-public-composite-job",
        "read-public-composite-output",
    ]
    assert repository.calls[2][4] == (RESOURCE_ID, SECOND_RESOURCE_ID)
    assert repository.calls[3][4] == (RESOURCE_ID, SECOND_RESOURCE_ID)
    assert not any(call[0] in {"request", "request-composite"} for call in repository.calls)


def test_public_wms_identical_repeats_preserve_one_exact_prewarmed_occurrence_per_position() -> (
    None
):
    repository = FakeRepository()
    request = RenderRequest(
        idempotency_key=IDEMPOTENCY_ID,
        bbox=(84.0, 27.0, 86.0, 29.0),
        crs="CRS:84",
        width=800,
        height=600,
        format="svg",
        background_color="#ffffff",
        transparent=False,
        expected_profile_version=1,
    )
    repository.map_job = job(
        "completed",
        background_color="#ffffff",
        request_checksum=render_request_checksum((profile(),) * 16, request),
    )
    parameters = public_wms_map_parameters()
    parameters["LAYERS"] = ",".join(["cite:RoadSegments"] * 16)
    parameters["STYLES"] = ""
    dispatcher = Dispatcher()

    response = client(repository, dispatcher).get(public_wms_path(), params=parameters)

    assert response.status_code == 200
    assert response.content == MAP_SVG
    assert dispatcher.jobs == []
    assert [call[0] for call in repository.calls][-2:] == [
        "find-public-composite-job",
        "read-public-composite-output",
    ]
    assert repository.calls[-2][4] == (RESOURCE_ID,) * 16


def test_public_wms_multilayer_large_output_uses_the_exact_composite_download() -> None:
    repository = FakeRepository()
    request = RenderRequest(
        idempotency_key=IDEMPOTENCY_ID,
        bbox=(84.0, 27.0, 86.0, 29.0),
        crs="CRS:84",
        width=800,
        height=600,
        format="svg",
        background_color="#ffffff",
        transparent=False,
        expected_profile_version=1,
    )
    repository.map_job = job(
        "completed",
        output_size=DIRECT_MAP_MAX_BYTES_FOR_TEST + 1,
        background_color="#ffffff",
        request_checksum=render_request_checksum((profile(), second_profile()), request),
    )
    parameters = public_wms_map_parameters()
    parameters["LAYERS"] = "cite:RoadSegments,cite:Lakes"
    parameters["STYLES"] = f"{PROFILE_ID},{SECOND_PROFILE_ID}"

    response = client(repository).get(public_wms_path(), params=parameters, follow_redirects=False)

    assert response.status_code == 303
    assert response.headers["location"].endswith("/public-composite.svg")
    assert response.headers["cache-control"] == "no-store"
    assert [call[0] for call in repository.calls][-2:] == [
        "find-public-composite-job",
        "public-composite-download",
    ]


def test_public_wms_cache_miss_is_retryable_and_cannot_dispatch_work() -> None:
    repository = FakeRepository()
    dispatcher = Dispatcher()
    response = client(repository, dispatcher).get(
        public_wms_path(),
        params=public_wms_map_parameters(),
    )

    assert response.status_code == 503
    assert response.headers["retry-after"] == "5"
    exception = ET.fromstring(response.content).find(f"{{{OGC_NAMESPACE}}}ServiceException")
    assert exception is not None
    assert exception.attrib["code"] == "ServerBusy"
    assert "authenticated operator" in (exception.text or "")
    assert dispatcher.jobs == []
    assert not any(call[0].startswith("request") for call in repository.calls)


def test_public_wms_disabled_and_cross_tenant_urls_are_indistinguishable() -> None:
    disabled_repository = FakeRepository()
    disabled_repository.public_service_enabled = False
    disabled = client(disabled_repository).get(
        public_wms_path(),
        params={"SERVICE": "WMS", "REQUEST": "GetCapabilities", "VERSION": "1.3.0"},
    )
    wrong_tenant = client(FakeRepository()).get(
        public_wms_path(organization_id=UUID("10000000-0000-4000-8000-0000000000ff")),
        params={"SERVICE": "WMS", "REQUEST": "GetCapabilities", "VERSION": "1.3.0"},
    )

    assert disabled.status_code == wrong_tenant.status_code == 404
    disabled_exception = ET.fromstring(disabled.content).find(
        f"{{{OGC_NAMESPACE}}}ServiceException"
    )
    tenant_exception = ET.fromstring(wrong_tenant.content).find(
        f"{{{OGC_NAMESPACE}}}ServiceException"
    )
    assert disabled_exception is not None and tenant_exception is not None
    assert (
        disabled_exception.attrib
        == tenant_exception.attrib
        == {
            "code": "LayerNotDefined",
            "locator": "LAYERS",
        }
    )
    assert disabled_exception.text == tenant_exception.text


def test_public_wms_rechecks_policy_immediately_before_serving_output() -> None:
    class WithdrawnBeforeReadRepository(FakeRepository):
        async def read_public_map_output(self, *args, **kwargs):
            del args, kwargs
            self.public_service_enabled = False
            raise RenderNotFound("public_wms_layer")

    repository = WithdrawnBeforeReadRepository()
    repository.map_job = job("completed", background_color="#ffffff")
    response = client(repository).get(
        public_wms_path(),
        params=public_wms_map_parameters(),
    )

    assert response.status_code == 404
    exception = ET.fromstring(response.content).find(f"{{{OGC_NAMESPACE}}}ServiceException")
    assert exception is not None
    assert exception.attrib["code"] == "LayerNotDefined"


def test_wms_getcapabilities_advertises_the_governed_layer_style_and_crs() -> None:
    repository = FakeRepository()
    response = client(repository).get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/wms",
        headers=headers(),
        params={"service": "WMS", "request": "GetCapabilities", "version": "1.3.0"},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/xml")
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-security-policy"] == "default-src 'none'; sandbox"
    root = ET.fromstring(response.content)
    namespace = {"wms": WMS_NAMESPACE}
    child = root.findall("wms:Capability/wms:Layer/wms:Layer", namespace)[0]
    assert root.tag == f"{{{WMS_NAMESPACE}}}WMS_Capabilities"
    abstract = root.findtext("wms:Service/wms:Abstract", namespaces=namespace) or ""
    assert "bounded immutable render" in abstract
    assert "asynchronous" not in abstract
    assert child.findtext("wms:Name", namespaces=namespace) == str(RESOURCE_ID)
    assert {node.text for node in child.findall("wms:CRS", namespace)} == {
        "CRS:84",
        "EPSG:3857",
    }
    assert {
        node.text
        for node in root.findall("wms:Capability/wms:Request/wms:GetMap/wms:Format", namespace)
    } == {"image/svg+xml", "image/png"}
    assert {node.attrib["CRS"] for node in child.findall("wms:BoundingBox", namespace)} == {
        "CRS:84",
        "EPSG:3857",
    }
    assert child.findtext("wms:Style/wms:Name", namespaces=namespace) == str(PROFILE_ID)
    assert [call[0] for call in repository.calls] == ["get-map-collection", "list"]


def test_project_wms_capabilities_advertise_two_governed_layers_and_limit() -> None:
    repository = FakeRepository()
    response = client(repository).get(
        f"/projects/{PROJECT_ID}/wms",
        headers=headers(),
        params={"SERVICE": "WMS", "REQUEST": "GetCapabilities", "VERSION": "1.3.0"},
    )

    assert response.status_code == 200
    root = ET.fromstring(response.content)
    namespace = {"wms": WMS_NAMESPACE}
    assert root.findtext("wms:Service/wms:Title", namespaces=namespace) == (
        "OpenGeo — Research project"
    )
    assert root.findtext("wms:Service/wms:LayerLimit", namespaces=namespace) == "16"
    children = root.findall("wms:Capability/wms:Layer/wms:Layer", namespace)
    assert [child.findtext("wms:Name", namespaces=namespace) for child in children] == [
        "cite:RoadSegments",
        "cite:Lakes",
    ]
    assert [call[0] for call in repository.calls] == ["get-project-map-catalog"]


def test_project_wms_composes_ordered_layers_in_one_exact_job() -> None:
    repository = FakeRepository()
    dispatcher = Dispatcher()
    parameters = wms_map_parameters()
    parameters.update(
        LAYERS="cite:RoadSegments,cite:Lakes",
        STYLES=f"{PROFILE_ID},{SECOND_PROFILE_ID}",
        WIDTH="8",
        HEIGHT="5",
    )

    response = client(repository, dispatcher).get(
        f"/projects/{PROJECT_ID}/wms",
        headers=headers(),
        params=parameters,
    )

    assert response.status_code == 200
    assert response.content == MAP_SVG
    assert response.headers["content-bbox"] == "84,27,86,29"
    request_call = next(call for call in repository.calls if call[0] == "request-composite")
    selections = request_call[3]
    assert [(selection.resource_id, selection.profile_id) for selection in selections] == [
        (RESOURCE_ID, PROFILE_ID),
        (SECOND_RESOURCE_ID, SECOND_PROFILE_ID),
    ]
    assert [call[0] for call in repository.calls][-2:] == [
        "get-composite",
        "read-composite-output",
    ]
    assert dispatcher.jobs == [JOB_ID]


def test_project_wms_identical_repeats_preserve_every_governed_render_position() -> None:
    repository = FakeRepository()
    dispatcher = Dispatcher()
    parameters = wms_map_parameters()
    parameters.update(
        LAYERS=",".join(["cite:RoadSegments"] * 16),
        STYLES=",".join([str(PROFILE_ID)] * 16),
        WIDTH="8",
        HEIGHT="5",
    )

    response = client(repository, dispatcher).get(
        f"/projects/{PROJECT_ID}/wms",
        headers=headers(),
        params=parameters,
    )

    assert response.status_code == 200
    assert response.content == MAP_SVG
    request_call = next(call for call in repository.calls if call[0] == "request-composite")
    assert [(item.resource_id, item.profile_id) for item in request_call[3]] == [
        (RESOURCE_ID, PROFILE_ID)
    ] * 16
    assert dispatcher.jobs == [JOB_ID]


def test_project_wms_denies_composition_when_any_layer_loses_authority() -> None:
    class DeniedCompositionRepository(FakeRepository):
        async def request_composite_render(self, *args, **kwargs):
            del args, kwargs
            raise RenderAccessDenied

    repository = DeniedCompositionRepository()
    dispatcher = Dispatcher()
    parameters = wms_map_parameters()
    parameters.update(
        LAYERS="cite:RoadSegments,cite:Lakes",
        STYLES=f"{PROFILE_ID},{SECOND_PROFILE_ID}",
    )

    response = client(repository, dispatcher).get(
        f"/projects/{PROJECT_ID}/wms", headers=headers(), params=parameters
    )

    assert response.status_code == 403
    exception = ET.fromstring(response.content).find(f"{{{OGC_NAMESPACE}}}ServiceException")
    assert exception is not None
    assert exception.attrib["code"] == "AccessDenied"
    assert dispatcher.jobs == []


def test_wms_getmap_returns_the_same_bounded_exact_governed_svg() -> None:
    repository = FakeRepository()
    repository.map_job = job("completed", background_color="#ffffff")
    response = client(repository).get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/wms",
        # WMS negotiates the body through FORMAT, independently of HTTP Accept.
        headers={**headers(), "Accept": "text/xml"},
        params=wms_map_parameters(),
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/svg+xml")
    assert response.headers["content-bbox"] == "84,27,86,29"
    assert response.content == MAP_SVG
    assert [call[0] for call in repository.calls] == [
        "get-map-collection",
        "list",
        "get-profile",
        "find-job",
        "read-map-output",
    ]


def test_wms_getmap_returns_exact_epsg3857_png() -> None:
    projected_bbox = (9_000_000.0, 3_000_000.0, 10_000_000.0, 4_000_000.0)
    repository = FakeRepository()
    repository.map_job = job(
        "completed",
        bbox=projected_bbox,
        crs="EPSG:3857",
        output_format="png",
        background_color="#ffffff",
    )
    parameters = wms_map_parameters()
    parameters.update(
        CRS="EPSG:3857",
        BBOX=",".join(str(value) for value in projected_bbox),
        FORMAT="image/png",
    )
    response = client(repository).get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/wms",
        headers={**headers(), "Accept": "text/xml"},
        params=parameters,
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/png")
    assert response.headers["content-crs"] == ("<http://www.opengis.net/def/crs/EPSG/0/3857>")
    assert response.content == MAP_PNG


def test_wms_getmap_accepts_optional_service_and_outside_domain_exponent_bbox() -> None:
    requested_bbox = (-10.0, 90.0, 10.0, 110.0)
    repository = FakeRepository()
    repository.map_job = job(
        "completed",
        bbox=requested_bbox,
        width=8,
        height=5,
        background_color="#ffffff",
    )
    parameters = wms_map_parameters()
    parameters.pop("SERVICE")
    parameters.update(BBOX="-1E1,9E1,+1E1,1.1E2", WIDTH="8", HEIGHT="5")

    response = client(repository).get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/wms",
        headers=headers(),
        params=parameters,
    )

    assert response.status_code == 200
    assert response.headers["content-bbox"] == "-10,90,10,110"
    assert repository.map_job.bbox == requested_bbox
    assert any(call[0] == "find-job" for call in repository.calls)


def test_wms_empty_style_selects_the_first_advertised_governed_profile() -> None:
    repository = FakeRepository()
    repository.map_job = job("completed", background_color="#ffffff")
    response = client(repository).get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/wms",
        headers={**headers(), "Accept": "image/svg+xml"},
        params=wms_map_parameters(""),
    )

    assert response.status_code == 200
    get_profile_call = next(call for call in repository.calls if call[0] == "get-profile")
    assert get_profile_call[4] == PROFILE_ID


def test_wms_uncached_request_waits_for_and_returns_exact_completed_output() -> None:
    repository = FakeRepository()
    dispatcher = Dispatcher()
    response = client(repository, dispatcher).get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/wms",
        headers={**headers(), "Accept": "image/svg+xml"},
        params=wms_map_parameters(),
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/svg+xml")
    assert response.content == MAP_SVG
    assert response.headers["content-bbox"] == "84,27,86,29"
    assert response.headers["content-crs"].endswith("/CRS84>")
    assert [call[0] for call in repository.calls][-3:] == [
        "request",
        "get-job",
        "read-map-output",
    ]
    assert dispatcher.jobs == [JOB_ID]


def test_wms_getmap_forwards_standard_presentation_and_tolerates_vendor_parameters() -> None:
    repository = FakeRepository()
    dispatcher = Dispatcher()
    parameters = wms_map_parameters()
    parameters.update(
        WIDTH="1",
        HEIGHT="1",
        FORMAT="image/png",
        TRANSPARENT="1",
        BGCOLOR="0x10ABcf",
        EXCEPTIONS="INIMAGE",
        VENDOR_HINT="ignored",
    )

    response = client(repository, dispatcher).get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/wms",
        headers=headers(),
        params=parameters,
    )

    assert response.status_code == 200
    request_call = next(call for call in repository.calls if call[0] == "request")
    render_request = request_call[5]
    assert render_request.width == 1
    assert render_request.height == 1
    assert render_request.format == "png"
    assert render_request.background_color == "#10abcf"
    assert render_request.transparent is True
    assert dispatcher.jobs == [JOB_ID]


def test_wms_pending_request_times_out_as_retryable_xml_without_async_success() -> None:
    class PendingRepository(FakeRepository):
        async def get_job(self, context, project_id, resource_id, job_id):
            self.calls.append(("get-job", context, project_id, resource_id, job_id))
            assert self.map_job is not None
            return self.map_job

    repository = PendingRepository()
    dispatcher = Dispatcher()
    response = client(
        repository,
        dispatcher,
        Settings(
            env="test",
            expose_docs=True,
            wms_sync_wait_seconds=0.05,
            wms_sync_poll_seconds=0.01,
        ),
    ).get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/wms",
        headers={**headers(), "Accept": "image/svg+xml"},
        params=wms_map_parameters(),
    )

    assert response.status_code == 503
    assert response.headers["content-type"].startswith("text/xml")
    assert response.headers["retry-after"] == "5"
    assert "location" not in response.headers
    assert "link" not in response.headers
    exception = ET.fromstring(response.content).find(f"{{{OGC_NAMESPACE}}}ServiceException")
    assert exception is not None
    assert exception.attrib["code"] == "ServerBusy"
    assert "synchronous window" in (exception.text or "")
    assert len([call for call in repository.calls if call[0] == "get-job"]) >= 2
    assert dispatcher.jobs == [JOB_ID]


def test_wms_synchronous_window_bounds_a_slow_status_read() -> None:
    class SlowRepository(FakeRepository):
        async def get_job(self, context, project_id, resource_id, job_id):
            self.calls.append(("get-job", context, project_id, resource_id, job_id))
            await asyncio.sleep(1)
            assert self.map_job is not None
            return self.map_job

    repository = SlowRepository()
    repository.map_job = job("queued")
    initial = repository.map_job
    context = TenantContext(USER_ID, ORG_ID)
    started = time.monotonic()
    current = asyncio.run(
        _wait_for_wms_map_job(
            repository,
            context,
            PROJECT_ID,
            RESOURCE_ID,
            initial,
            0.05,
            0.01,
        )
    )

    assert current is initial
    assert time.monotonic() - started < 0.25
    assert len([call for call in repository.calls if call[0] == "get-job"]) == 1


@pytest.mark.parametrize(
    "public,composition", [(False, False), (False, True), (True, False), (True, True)]
)
@pytest.mark.parametrize("outcome", ["pending", "completed", "cancelled", "withdrawn"])
def test_wms_status_backoff_bounds_reads_and_preserves_authority(
    monkeypatch, public, composition, outcome
):
    clock = SimpleNamespace(now=0.0)
    sleeps = []
    reads = []
    initial = job("queued")
    completed = job("completed")
    context = TenantContext(USER_ID, ORG_ID)

    async def sleep(seconds):
        sleeps.append(seconds)
        if outcome == "cancelled":
            raise asyncio.CancelledError
        clock.now += seconds

    async def read(*args):
        # Every refresh carries the same exact authority and job identity.
        assert args[0] == context
        assert args[1] == PROJECT_ID
        if public:
            assert args[2] == PUBLIC_SERVICE_ID
            assert args[3] == ((RESOURCE_ID, SECOND_RESOURCE_ID) if composition else RESOURCE_ID)
            assert args[4] == IDEMPOTENCY_ID
        elif composition:
            assert args[2] == JOB_ID
        else:
            assert args[2:] == (RESOURCE_ID, JOB_ID)
        reads.append(clock.now)
        if outcome == "withdrawn":
            raise RenderNotFound("withdrawn")
        return completed if outcome == "completed" and clock.now >= 2.2 else initial

    monkeypatch.setattr(
        "opengeo_api.render_routes.time", SimpleNamespace(monotonic=lambda: clock.now)
    )
    monkeypatch.setattr("opengeo_api.render_routes.asyncio.sleep", sleep)
    repository = SimpleNamespace(
        get_job=read,
        get_composite_job=read,
        find_public_job_by_idempotency=read,
        find_public_composite_job_by_idempotency=read,
    )

    async def wait():
        if public:
            return await _wait_for_public_wms_map_job(
                repository,
                context,
                PROJECT_ID,
                PUBLIC_SERVICE_ID,
                (RESOURCE_ID, SECOND_RESOURCE_ID) if composition else (RESOURCE_ID,),
                IDEMPOTENCY_ID,
                initial,
                8.0,
                0.25,
            )
        return await _wait_for_wms_map_job(
            repository,
            context,
            PROJECT_ID,
            RESOURCE_ID,
            initial,
            8.0,
            0.25,
            composition=composition,
        )

    if outcome == "cancelled":
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(wait())
        assert reads == [0.0]
    elif outcome == "withdrawn":
        with pytest.raises(HTTPException) as error:
            asyncio.run(wait())
        assert error.value.status_code == 404
        assert reads == [0.0]
        assert sleeps == []
    else:
        current = asyncio.run(wait())
        assert reads[0] == 0.0
        assert sleeps[:2] == [0.25, 0.5]
        assert max(sleeps) <= 1.0
        if outcome == "pending":
            assert current is initial
            assert clock.now == 8.0
            assert len(reads) == 10  # Previously 32 refreshes in the same window.
        else:
            assert current is completed
            assert 2.2 <= clock.now <= 3.2


def test_wms_revalidates_the_completed_job_identity_after_waiting() -> None:
    class CollidingRepository(FakeRepository):
        async def get_job(self, context, project_id, resource_id, job_id):
            self.calls.append(("get-job", context, project_id, resource_id, job_id))
            return job(
                "completed",
                bbox=(83.0, 27.0, 86.0, 29.0),
                background_color="#ffffff",
            )

    repository = CollidingRepository()
    dispatcher = Dispatcher()
    response = client(repository, dispatcher).get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/wms",
        headers=headers(),
        params=wms_map_parameters(),
    )

    assert response.status_code == 409
    exception = ET.fromstring(response.content).find(f"{{{OGC_NAMESPACE}}}ServiceException")
    assert exception is not None
    assert exception.attrib["code"] == "NoApplicableCode"
    assert not [call for call in repository.calls if call[0] == "read-map-output"]
    assert dispatcher.jobs == [JOB_ID]


def test_wms_errors_are_xml_and_fail_before_render_dispatch() -> None:
    repository = FakeRepository()
    dispatcher = Dispatcher()
    api = client(repository, dispatcher)
    path = f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/wms"
    invalid_crs = wms_map_parameters()
    invalid_crs["CRS"] = "EPSG:4326"

    responses = [
        api.get(path, headers=headers(), params=invalid_crs),
        api.get(
            path,
            headers=headers(),
            params={**wms_map_parameters(), "LAYERS": str(PROFILE_ID)},
        ),
        api.get(
            path,
            headers=headers(),
            params={**wms_map_parameters(), "STYLES": str(RESOURCE_ID)},
        ),
        api.get(
            path,
            headers=headers(),
            params={**wms_map_parameters(), "TRANSPARENT": "sometimes"},
        ),
    ]

    assert [response.status_code for response in responses] == [400, 404, 404, 400]
    codes = [
        ET.fromstring(response.content).find(f"{{{OGC_NAMESPACE}}}ServiceException").attrib["code"]
        for response in responses
    ]
    assert codes == ["InvalidCRS", "LayerNotDefined", "StyleNotDefined", "InvalidParameterValue"]
    assert not [call for call in repository.calls if call[0] in {"request", "read-map-output"}]
    assert dispatcher.jobs == []


def test_map_endpoint_rejects_unsupported_or_malformed_queries_without_dispatch() -> None:
    repository = FakeRepository()
    dispatcher = Dispatcher()
    api = client(repository, dispatcher)
    path = f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/render-profiles/{PROFILE_ID}/map"

    unsupported_accept = api.get(
        path,
        headers={**headers(), "Accept": "image/png"},
        params={"bbox": "84,27,86,29"},
    )
    unsupported_format = api.get(
        path,
        headers=headers(),
        params={"bbox": "84,27,86,29", "f": "tiff"},
    )
    unsupported_crs = api.get(
        path,
        headers=headers(),
        params={"bbox": "84,27,86,29", "crs": "EPSG:3857"},
    )
    malformed_bbox = api.get(path, headers=headers(), params={"bbox": "86,27,84,29"})
    outside_crs_bbox = api.get(path, headers=headers(), params={"bbox": "-10,90,10,110"})

    assert unsupported_accept.status_code == 406
    assert unsupported_format.status_code == 406
    assert unsupported_crs.status_code == 400
    assert malformed_bbox.status_code == 400
    assert malformed_bbox.json()["detail"]["code"] == "invalid_bbox"
    assert outside_crs_bbox.status_code == 400
    assert outside_crs_bbox.json()["detail"]["code"] == "invalid_bbox"
    assert not [call for call in repository.calls if call[0] == "request"]
    assert dispatcher.jobs == []


def test_profile_conflict_and_openapi_routes_are_machine_readable() -> None:
    class ConflictRepository(FakeRepository):
        async def update_profile(self, *args, **kwargs):
            del args, kwargs
            raise RenderConflict("render_profile_version_conflict", current_version=4)

    api = client(ConflictRepository())
    update = profile_payload()
    update.pop("slug")
    update["expected_version"] = 1
    response = api.put(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/render-profiles/{PROFILE_ID}",
        headers=headers(),
        json=update,
    )
    assert response.status_code == 409
    assert response.json() == {
        "detail": {"code": "render_profile_version_conflict", "current_version": 4}
    }

    paths = api.get("/openapi.json").json()["paths"]
    assert {
        "/projects/{project_id}/resources/{resource_id}/ogc",
        "/projects/{project_id}/resources/{resource_id}/ogc/conformance",
        "/projects/{project_id}/resources/{resource_id}/ogc/collections",
        "/projects/{project_id}/resources/{resource_id}/ogc/collections/{collection_id}",
        (
            "/projects/{project_id}/resources/{resource_id}/ogc/collections/{collection_id}"
            "/styles/{profile_id}/map"
        ),
        "/projects/{project_id}/wms",
        "/projects/{project_id}/wms-publications",
        "/projects/{project_id}/resources/{resource_id}/wms",
        "/projects/{project_id}/resources/{resource_id}/wms-publications",
        (
            "/projects/{project_id}/resources/{resource_id}/wms-publications/"
            "{publication_id}/withdraw"
        ),
        "/projects/{project_id}/resources/{resource_id}/render-profiles",
        "/projects/{project_id}/resources/{resource_id}/render-profiles/{profile_id}",
        "/projects/{project_id}/resources/{resource_id}/render-profiles/{profile_id}/map",
        "/projects/{project_id}/resources/{resource_id}/render-profiles/{profile_id}/renders",
        "/projects/{project_id}/resources/{resource_id}/renders/{job_id}",
        "/projects/{project_id}/resources/{resource_id}/renders/{job_id}/download",
    } <= set(paths)
    wms_responses = paths["/projects/{project_id}/resources/{resource_id}/wms"]["get"]["responses"]
    assert "503" in wms_responses
    assert "202" not in wms_responses
