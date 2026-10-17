import asyncio
import base64
import hashlib
import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

import anyio.to_thread
import httpx2 as httpx
import pytest
from fastapi import FastAPI

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.authorization import Roles
from opengeo_api.cognito_provisioning import AwsCredentials
from opengeo_api.config import Settings
from opengeo_api.observable_sources import (
    OBSERVABLE_BUILD_LIMITS,
    ObservableBuildJob,
    ObservableDataAttachment,
    ObservablePreviewCapability,
    ObservablePreviewCapabilityInvalid,
    ObservablePreviewGrant,
    ObservableRevisionAttachment,
    ObservableRevisionUpload,
    ObservableSourceAccessDenied,
    ObservableSourceConflict,
    ObservableSourceFileContent,
    ObservableSourceFileDownloadTicket,
    ObservableSourceFileUploadTicket,
    ObservableSourceNotFound,
    ObservableSourceProject,
    ObservableSourceRevision,
    ObservableSourceRevisionDraft,
    ObservableSourceRevisionFile,
    ObservableSourceStoreUnavailable,
    PostgresObservableSourceRepository,
    _encode_preview_capability,
    preview_capability_runtime_profile,
    validate_observable_attachment_media,
    validate_observable_source_file,
)
from opengeo_api.processing_dispatch import ProcessingDispatchUnavailable
from opengeo_api.s3_downloads import AwsS3DownloadStorage, DownloadTicket
from opengeo_api.s3_uploads import StoredObject, UploadForm
from opengeo_api.tenant_database import TenantContext

USER_ID = UUID("20000000-0000-4000-8000-000000000459")
ORG_ID = UUID("10000000-0000-4000-8000-000000000459")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000459")
SITE_ID = UUID("a0000000-0000-4000-8000-000000000459")
SOURCE_PROJECT_ID = UUID("b0000000-0000-4000-8000-000000000459")
MARKDOWN_UPLOAD_ID = UUID("c0000000-0000-4000-8000-000000000459")
LOCK_UPLOAD_ID = UUID("c0000000-0000-4000-8000-000000000460")
REVISION_ID = UUID("d0000000-0000-4000-8000-000000000459")
BUILD_ID = UUID("e0000000-0000-4000-8000-000000000459")
NOW = datetime(2026, 8, 22, 18, tzinfo=UTC)
DIGEST = f"sha256:{'c' * 64}"


@pytest.fixture(autouse=True)
def inline_threadpool(monkeypatch: pytest.MonkeyPatch) -> None:
    async def run_sync(function, *args, **kwargs):
        del kwargs
        return function(*args)

    monkeypatch.setattr(anyio.to_thread, "run_sync", run_sync)


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
            email="author@example.test",
            display_name="Author",
            memberships=(OrganizationMembership(ORG_ID, "admin"),),
        )


def source_project() -> ObservableSourceProject:
    return ObservableSourceProject(
        source_project_id=SOURCE_PROJECT_ID,
        project_id=PROJECT_ID,
        site_id=SITE_ID,
        route_namespace="field-report",
        title="Field report source",
        rights_status="unreviewed",
        owner_user_id=USER_ID,
        current_revision_id=None,
        current_revision_number=0,
        compiler_image_digest=DIGEST,
        framework_version="1.13.4",
        lockfile_format="npm-package-lock-v3",
        network_policy="deny_all",
        resource_limits=dict(OBSERVABLE_BUILD_LIMITS),
        created_by=USER_ID,
        created_at=NOW,
        updated_by=USER_ID,
        updated_at=NOW,
    )


def source_revision() -> ObservableSourceRevision:
    files = (
        ObservableSourceRevisionFile(
            relative_path="package-lock.json",
            source_object_id=UUID("f0000000-0000-4000-8000-000000000459"),
            bucket="source.opengeo.tools",
            object_key="private/lock",
            s3_version_id="lock-v1",
            etag="lock-etag",
            content_type="application/json",
            size_bytes=18,
            checksum_sha256="b" * 64,
        ),
        ObservableSourceRevisionFile(
            relative_path="src/index.md",
            source_object_id=UUID("f0000000-0000-4000-8000-000000000460"),
            bucket="source.opengeo.tools",
            object_key="private/index",
            s3_version_id="index-v1",
            etag="index-etag",
            content_type="text/markdown",
            size_bytes=12,
            checksum_sha256="a" * 64,
        ),
    )
    manifest = {
        "schemaVersion": "opengeo.observable-source-revision.1.0.0",
        "sourceProjectId": str(SOURCE_PROJECT_ID),
        "revisionId": str(REVISION_ID),
        "revisionNumber": 1,
        "entryPath": "src/index.md",
        "lockfilePath": "package-lock.json",
        "files": [],
    }
    return ObservableSourceRevision(
        revision_id=REVISION_ID,
        source_project_id=SOURCE_PROJECT_ID,
        revision_number=1,
        parent_revision_id=None,
        title="Field report source",
        rights_status="unreviewed",
        entry_path="src/index.md",
        lockfile_path="package-lock.json",
        manifest=manifest,
        manifest_checksum_sha256="d" * 64,
        change_summary="Import exact source tree",
        created_by=USER_ID,
        created_at=NOW,
        files=files,
    )


class MemoryObservableSourceRepository:
    def __init__(self) -> None:
        self.project = source_project()
        self.revisions: list[ObservableSourceRevision] = []
        self.job: ObservableBuildJob | None = None
        self.calls: list[tuple] = []
        self.capability_consumed = False
        self.preview_capability: str | None = None

    async def publication_workspaces(self, context, limit, offset):
        self.calls.append(("publication-workspaces", context, limit, offset))
        return [
            {
                "id": SOURCE_PROJECT_ID,
                "kind": "framework",
                "project_id": PROJECT_ID,
                "project_name": "Field report",
                "site_id": SITE_ID,
                "source_project_id": SOURCE_PROJECT_ID,
                "title": "Field report source",
                "current_revision": 2,
                "hostname": "opengeo.tools",
                "mount_path": "/report/",
                "published_at": NOW,
                "published_revision": 1,
                "status": "published",
                "can_manage": True,
            }
        ]

    async def list_projects(self, context, project_id):
        self.calls.append(("list", context, project_id))
        return (self.project,)

    async def create_project(self, context, project_id, site_id, title, request_id):
        self.calls.append(("create", context, project_id, site_id, title, request_id))
        self.project = replace(self.project, title=title)
        return self.project

    async def get_project(self, context, project_id, source_project_id):
        self.calls.append(("get", context, project_id, source_project_id))
        return self.project

    async def request_file_upload(self, context, project_id, source_project_id, draft, request_id):
        self.calls.append(("upload", context, draft, request_id))
        upload_id = (
            LOCK_UPLOAD_ID if draft.relative_path == "package-lock.json" else MARKDOWN_UPLOAD_ID
        )
        return ObservableSourceFileUploadTicket(
            upload_id=upload_id,
            source_project_id=source_project_id,
            relative_path=draft.relative_path,
            content_type=draft.content_type,
            size_bytes=draft.size_bytes,
            checksum_sha256=draft.checksum_sha256,
            upload=UploadForm(
                url="https://s3.us-east-1.amazonaws.com/source.opengeo.tools",
                method="POST",
                fields={"key": f"private/{draft.relative_path}"},
                expires_at=NOW + timedelta(minutes=15),
            ),
        )

    async def create_revision(self, context, project_id, source_project_id, draft, request_id):
        self.calls.append(("revision", context, draft, request_id))
        record = source_revision()
        self.revisions = [record]
        self.project = replace(
            self.project,
            current_revision_id=REVISION_ID,
            current_revision_number=1,
        )
        return record

    async def list_revisions(self, context, project_id, source_project_id):
        self.calls.append(("revisions", context, project_id, source_project_id))
        return tuple(self.revisions)

    async def list_revisions_page(
        self, context, project_id, source_project_id, limit=25, before_revision=None
    ):
        self.calls.append(
            ("revisions-page", context, project_id, source_project_id, limit, before_revision)
        )
        return tuple(
            revision
            for revision in self.revisions
            if before_revision is None or revision.revision_number < before_revision
        )[:limit]

    async def read_revision_file(
        self, context, project_id, source_project_id, revision_id, relative_path
    ):
        self.calls.append(("read_file", context, project_id, revision_id, relative_path))
        assert source_project_id == SOURCE_PROJECT_ID
        assert relative_path == "src/index.md"
        return ObservableSourceFileContent(
            relative_path=relative_path,
            content_type="text/markdown",
            size_bytes=6,
            checksum_sha256="17b18d36ebed0aef68729cb969167c56e10eae5d9b31f356203b4a7ffae0b01b",
            body=b"# Map\n",
        )

    async def request_revision_file_download(
        self, context, project_id, source_project_id, revision_id, relative_path
    ):
        self.calls.append(
            ("file_download", context, project_id, source_project_id, revision_id, relative_path)
        )
        file = next(item for item in source_revision().files if item.relative_path == relative_path)
        return ObservableSourceFileDownloadTicket(
            file, DownloadTicket("https://s3.us-east-1.amazonaws.com/exact-version", "GET", NOW)
        )

    async def create_build_job(
        self,
        context,
        project_id,
        source_project_id,
        source_revision_id,
        purpose,
        request_id,
        idempotency_key=None,
    ):
        self.calls.append(("build", context, purpose, request_id))
        if idempotency_key is not None and self.job is not None:
            assert self.job.build_job_id == idempotency_key
            return self.job
        if purpose == "release_candidate":
            raise ObservableSourceConflict("observable_source_rights_unapproved")
        request = {
            "schemaVersion": "opengeo.observable-build-request.1.0.0",
            "sourceRevisionId": str(source_revision_id),
            "compilerImageDigest": DIGEST,
            "networkPolicy": "deny_all",
            "resourceLimits": OBSERVABLE_BUILD_LIMITS,
        }
        self.job = ObservableBuildJob(
            build_job_id=idempotency_key or BUILD_ID,
            source_project_id=source_project_id,
            source_revision_id=source_revision_id,
            source_revision_number=1,
            purpose=purpose,
            state="pending",
            request=request,
            request_checksum_sha256="e" * 64,
            output_prefix="private/build/output/",
            result=None,
            result_checksum_sha256=None,
            attempt_count=0,
            error_code=None,
            created_by=USER_ID,
            created_at=NOW,
            started_at=None,
            finished_at=None,
            updated_at=NOW,
        )
        return self.job

    async def get_build_job(self, context, project_id, build_job_id):
        self.calls.append(("get_build", context, project_id, build_job_id))
        assert self.job is not None
        return self.job

    async def list_build_jobs(self, context, project_id, source_project_id, limit=25, offset=0):
        self.calls.append(("build_history", context, project_id, source_project_id, limit, offset))
        return (self.job,) if self.job is not None and offset == 0 else ()

    async def authorize_build_dispatch(self, context, project_id, build_job_id):
        self.calls.append(("authorize_dispatch", context, project_id, build_job_id))
        assert self.job is not None
        if self.job.state != "pending":
            raise ObservableSourceConflict("observable_build_not_pending")
        return self.job

    async def create_preview_capability(
        self, context, project_id, build_job_id, request_id, runtime_profile="local_only"
    ):
        self.calls.append(
            ("preview_capability", context, project_id, build_job_id, request_id, runtime_profile)
        )
        assert self.job is not None
        if self.job.state != "succeeded":
            raise ObservableSourceConflict("observable_preview_build_not_ready")
        self.preview_capability = _encode_preview_capability(BUILD_ID, context, runtime_profile)
        return ObservablePreviewCapability(
            capability=self.preview_capability,
            expires_at=NOW + timedelta(seconds=60),
        )

    async def exchange_preview_capability(self, capability):
        self.calls.append(("preview_exchange", capability))
        if capability != self.preview_capability or self.capability_consumed:
            raise ObservablePreviewCapabilityInvalid("invalid")
        self.capability_consumed = True
        return ObservablePreviewGrant(
            output_prefix=(
                f"organizations/{ORG_ID}/projects/{PROJECT_ID}/source-projects/"
                f"{SOURCE_PROJECT_ID}/builds/{BUILD_ID}/output/"
            ),
            entry_file="dist/index.html",
            expires_at=NOW + timedelta(minutes=15),
            runtime_profile=preview_capability_runtime_profile(capability),
        )


class FakePreviewCookieSigner:
    available = True

    def __init__(self) -> None:
        self.calls: list[tuple[str, datetime]] = []

    def sign(self, resource_url: str, expires_at: datetime) -> dict[str, str]:
        self.calls.append((resource_url, expires_at))
        return {
            "CloudFront-Policy": "policy-value",
            "CloudFront-Signature": "signature-value",
            "CloudFront-Key-Pair-Id": "KEYPAIR123",
        }


class FakeBuildDispatcher:
    def __init__(self, *, available: bool = True, fail: bool = False) -> None:
        self._available = available
        self.fail = fail
        self.jobs: list[UUID] = []

    @property
    def available(self) -> bool:
        return self._available

    async def dispatch_observable_build(self, build_job_id: UUID) -> None:
        self.jobs.append(build_job_id)
        if self.fail:
            raise ProcessingDispatchUnavailable("queue unavailable")


class DirectAsgiClient:
    def __init__(self, app: FastAPI) -> None:
        self.app = app

    def get(self, path: str, *, headers: dict[str, str] | None = None) -> httpx.Response:
        return self.request("GET", path, headers=headers)

    def post(
        self,
        path: str,
        *,
        headers: dict[str, str] | None = None,
        json: dict | None = None,
    ) -> httpx.Response:
        return self.request("POST", path, headers=headers, json_body=json)

    def request(
        self,
        method: str,
        path: str,
        *,
        headers: dict[str, str] | None = None,
        json_body: dict | None = None,
    ) -> httpx.Response:
        body = b"" if json_body is None else json.dumps(json_body).encode()
        request_headers = list((headers or {}).items())
        if json_body is not None:
            request_headers.extend(
                [("content-type", "application/json"), ("content-length", str(len(body)))]
            )

        async def invoke() -> httpx.Response:
            incoming = [{"type": "http.request", "body": body, "more_body": False}]
            outgoing: list[dict] = []

            async def receive():
                if incoming:
                    return incoming.pop(0)
                return {"type": "http.disconnect"}

            async def send(message):
                outgoing.append(message)

            await self.app(
                {
                    "type": "http",
                    "asgi": {"version": "3.0", "spec_version": "2.3"},
                    "http_version": "1.1",
                    "method": method,
                    "scheme": "http",
                    "path": path.partition("?")[0],
                    "raw_path": path.partition("?")[0].encode(),
                    "query_string": path.partition("?")[2].encode(),
                    "root_path": "",
                    "headers": [
                        (key.lower().encode(), value.encode()) for key, value in request_headers
                    ],
                    "client": ("127.0.0.1", 12345),
                    "server": ("testserver", 80),
                },
                receive,
                send,
            )
            start = next(
                message for message in outgoing if message["type"] == "http.response.start"
            )
            response_body = b"".join(
                message.get("body", b"")
                for message in outgoing
                if message["type"] == "http.response.body"
            )
            return httpx.Response(
                start["status"],
                headers=start.get("headers", []),
                content=response_body,
            )

        return asyncio.run(invoke())


def client(
    repository: MemoryObservableSourceRepository,
    *,
    preview: bool = False,
    public_maps_preview: bool = False,
    preview_origin: str | None = None,
    signer: FakePreviewCookieSigner | None = None,
    dispatcher: FakeBuildDispatcher | None = None,
) -> DirectAsgiClient:
    return DirectAsgiClient(
        create_app(
            settings=Settings(
                env="test",
                expose_docs=True,
                observable_preview_origin=(
                    preview_origin or "https://preview.studio.opengeo.tools" if preview else None
                ),
                observable_public_maps_preview_origin=(
                    "https://maps-preview.studio.opengeo.tools" if public_maps_preview else None
                ),
            ),
            readiness_probe=PassingProbe(),
            token_verifier=FakeVerifier(),
            principal_repository=FakePrincipalRepository(),
            observable_source_repository=repository,
            observable_build_dispatcher=dispatcher,
            observable_preview_cookie_signer=signer,
        )
    )


def headers() -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(ORG_ID),
        "X-Request-ID": "observable-source-request-1",
    }


def revision_payload() -> dict:
    return {
        "expected_revision": 0,
        "title": "Field report source",
        "rights_status": "unreviewed",
        "entry_path": "src/index.md",
        "lockfile_path": "package-lock.json",
        "change_summary": "Import exact source tree",
        "files": [
            {
                "upload_id": str(LOCK_UPLOAD_ID),
                "relative_path": "package-lock.json",
            },
            {
                "upload_id": str(MARKDOWN_UPLOAD_ID),
                "relative_path": "src/index.md",
            },
        ],
    }


@pytest.mark.parametrize("configured", [False, True])
def test_workflow_configuration_is_authorized_redacted_and_never_claims_activation(
    configured: bool,
) -> None:
    repository = MemoryObservableSourceRepository()
    api = client(
        repository,
        preview=configured,
        signer=FakePreviewCookieSigner() if configured else None,
        dispatcher=FakeBuildDispatcher(available=configured),
    )
    url = f"/projects/{PROJECT_ID}/framework-workflow"
    assert api.get(url).status_code == 401
    result = api.get(url, headers=headers())
    assert result.status_code == 200
    assert result.headers["Cache-Control"] == "no-store"
    assert result.json() == {
        "project_id": str(PROJECT_ID),
        "source_storage_configured": False,
        "build_dispatch_configured": configured,
        "private_preview_configured": configured,
        "public_promotion_available": False,
        "configuration_only": True,
    }
    assert repository.calls[-1][0] == "list"
    assert repository.calls[-1][1].organization_id == ORG_ID


def test_revision_advertises_and_accepts_parent_file_reuse_without_changing_response_shape():
    repository = MemoryObservableSourceRepository()
    repository.revisions = [source_revision()]
    api = client(repository)
    url = f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/revisions"
    response = api.get(url, headers=headers())
    assert response.status_code == 200
    assert response.headers["X-OpenGeo-Source-File-Reuse"] == "parent-revision-v1"
    assert "X-OpenGeo-Source-File-Reuse" in response.headers["Access-Control-Expose-Headers"]
    assert "supports_file_reuse" not in response.json()[0]
    payload = revision_payload()
    payload["files"][0] = {
        "relative_path": "package-lock.json",
        "source_object_id": str(LOCK_UPLOAD_ID),
    }
    assert api.post(url, headers=headers(), json=payload).status_code == 201
    assert repository.calls[-1][2].files[0].source_object_id == LOCK_UPLOAD_ID
    assert repository.calls[-1][2].files[0].upload_id is None


def test_revision_accepts_only_explicit_sorted_archive_bindings() -> None:
    repository = MemoryObservableSourceRepository()
    api = client(repository)
    url = f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/revisions"
    payload = revision_payload()
    payload["data_attachments"] = [
        {"attachment_id": str(BUILD_ID), "relative_path": "src/data/water.geojson"}
    ]
    assert api.post(url, headers=headers(), json=payload).status_code == 201
    assert repository.calls[-1][2].data_attachments[0].attachment_id == BUILD_ID
    assert repository.calls[-1][2].data_attachments[0].relative_path == "src/data/water.geojson"
    for path in ["src/index.md", "../water.geojson", "package.json", "src/data/run.js"]:
        payload["data_attachments"] = [{"attachment_id": str(BUILD_ID), "relative_path": path}]
        assert api.post(url, headers=headers(), json=payload).status_code == 422
    payload["data_attachments"] = [
        {
            "attachment_id": str(BUILD_ID),
            "relative_path": "src/data/water.geojson",
            "checksum_sha256": "a" * 64,
        }
    ]
    assert api.post(url, headers=headers(), json=payload).status_code == 422
    payload["data_attachments"] = [
        {"attachment_id": str(BUILD_ID), "relative_path": path}
        for path in ["src/data/z.geojson", "src/data/a.geojson"]
    ]
    assert api.post(url, headers=headers(), json=payload).status_code == 422
    payload["data_attachments"] = [
        {"attachment_id": str(BUILD_ID), "relative_path": path}
        for path in ["src/data/a.csv", "src/data/a.csv-extra", "src/data/a.csv/b.csv"]
    ]
    assert api.post(url, headers=headers(), json=payload).status_code == 422


def test_tiff_archive_admission_preserves_source_upload_and_media_boundaries() -> None:
    for path in ["src/data/elevation.tif", "src/data/elevation.TIFF"]:
        for media in ["image/tiff", "image/geotiff"]:
            validate_observable_attachment_media(path, media)
            with pytest.raises(ObservableSourceConflict):
                validate_observable_source_file(path, media, 1)
        for media in ["text/javascript", "application/octet-stream", "image/png"]:
            with pytest.raises(ObservableSourceConflict):
                validate_observable_attachment_media(path, media)
    for path in ["../elevation.tif", "src/data/run.js", "src/.aws/elevation.tif"]:
        with pytest.raises(ObservableSourceConflict):
            validate_observable_attachment_media(path, "image/tiff")


def test_framework_publication_routes_keep_review_separate_from_unconfigured_dispatch() -> None:
    class PublicationRepository(MemoryObservableSourceRepository):
        def __init__(self):
            super().__init__()
            self.reviews = []

        async def publication_status(self, context, project_id, source_project_id):
            assert context.user_id == USER_ID and context.organization_id == ORG_ID
            assert project_id == PROJECT_ID and source_project_id == SOURCE_PROJECT_ID
            return {
                "source_project_id": source_project_id,
                "can_publish": True,
                "mounts": [],
                "reviews": [],
            }

        async def review_publication(
            self, context, project_id, source_project_id, build, mount, checksum, review
        ):
            assert (build, mount, review) == (BUILD_ID, SITE_ID, REVISION_ID)
            assert checksum == "a" * 64
            self.reviews.append(review)

        async def approve_publication(self, *args):
            pytest.fail("Do not accept approval when the publisher is unconfigured")

    repository = PublicationRepository()
    api = client(repository)
    url = f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/publications"
    assert api.get(url).status_code == 401
    response = api.get(url, headers=headers())
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["dispatch_configured"] is False
    response = api.post(
        url + "/reviews",
        headers=headers(),
        json={
            "review_id": str(REVISION_ID),
            "build_job_id": str(BUILD_ID),
            "mount_id": str(SITE_ID),
            "result_checksum_sha256": "a" * 64,
        },
    )
    assert response.status_code == 200
    assert repository.reviews == [REVISION_ID]
    response = api.post(
        url + f"/reviews/{REVISION_ID}/approve",
        headers=headers(),
        json={"acknowledgment": "publish-exact-previewed-output"},
    )
    assert response.status_code == 503


def test_destination_reservation_route_requires_an_explicit_scoped_request_and_does_not_publish():
    class Repository(MemoryObservableSourceRepository):
        def __init__(self):
            super().__init__()
            self.reservations = []

        async def publication_status(self, context, project_id, source_project_id):
            return {
                "source_project_id": source_project_id,
                "can_publish": True,
                "mounts": [],
                "reviews": [],
                "can_configure_destinations": True,
                "origins": [
                    {"id": SITE_ID, "hostname": "opengeo.tools", "path_prefix": "/publications/"}
                ],
            }

        async def reserve_publication_destination(
            self, context, project, source, reservation, origin, slug, acknowledgment
        ):
            assert (context.organization_id, context.user_id, project, source) == (
                ORG_ID,
                USER_ID,
                PROJECT_ID,
                SOURCE_PROJECT_ID,
            )
            assert (reservation, origin, slug, acknowledgment) == (
                REVISION_ID,
                SITE_ID,
                "atlas",
                "reserve-address-without-publishing",
            )
            self.reservations.append(reservation)

        async def approve_publication(self, *args):
            pytest.fail("Reserving an address must not publish")

    repository = Repository()
    api = client(repository)
    url = f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/publications/destinations"
    body = {
        "reservation_id": str(REVISION_ID),
        "origin_id": str(SITE_ID),
        "slug": "atlas",
        "acknowledgment": "reserve-address-without-publishing",
    }
    assert api.post(url, json=body).status_code == 401
    for change in [
        {"slug": "../atlas"},
        {"slug": "/atlas/"},
        {"acknowledgment": "publish"},
        {"hostname": "unapproved.test"},
        {"mount_path": "/"},
    ]:
        assert api.post(url, headers=headers(), json={**body, **change}).status_code == 422
    assert repository.reservations == []
    response = api.post(url, headers=headers(), json=body)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["origins"][0]["path_prefix"] == "/publications/"
    assert response.json()["dispatch_configured"] is False
    assert repository.reservations == [REVISION_ID]


def test_destination_repository_requires_publication_authority_before_any_mutation():
    transaction = SimpleNamespace(fetch_one=AsyncMock(return_value=(REVISION_ID,)))

    async def run(context, operation):
        return await operation(transaction)

    repository = PostgresObservableSourceRepository(executor=SimpleNamespace(run=run))
    repository._project_roles = AsyncMock(
        return_value=Roles(organization="member", project="editor")
    )
    repository._load_project = AsyncMock(return_value=source_project())
    context = TenantContext(organization_id=ORG_ID, user_id=USER_ID)
    args = (
        context,
        PROJECT_ID,
        SOURCE_PROJECT_ID,
        REVISION_ID,
        SITE_ID,
        "atlas",
        "reserve-address-without-publishing",
    )
    with pytest.raises(ObservableSourceAccessDenied):
        asyncio.run(repository.reserve_publication_destination(*args))
    transaction.fetch_one.assert_not_awaited()
    repository._project_roles.return_value = Roles(organization="member", project="owner")
    asyncio.run(repository.reserve_publication_destination(*args))
    repository._load_project.assert_awaited_once_with(
        transaction, context, PROJECT_ID, SOURCE_PROJECT_ID
    )
    assert transaction.fetch_one.await_args.args[1] == (
        REVISION_ID,
        PROJECT_ID,
        SOURCE_PROJECT_ID,
        SITE_ID,
        "atlas",
        "reserve-address-without-publishing",
    )


@pytest.mark.parametrize(
    "role,project_role,allowed",
    [
        ("admin", None, True),
        ("member", "owner", True),
        ("member", "reviewer", True),
        ("member", "editor", False),
        ("member", "viewer", False),
    ],
)
def test_publication_status_lists_only_authorized_delegated_hosting(role, project_role, allowed):
    async def fetch_all(sql, params):
        if "SELECT id, hostname, self_service_prefix" in sql:
            assert allowed
            assert params == (ORG_ID, role == "admin")
            assert "AND enabled AND self_service_prefix IS NOT NULL" in sql
            assert "AND (%s OR project_reservation_limit > 0)" in sql
            return [(SITE_ID, "opengeo.tools", "/publications/")]
        return []

    transaction = SimpleNamespace(fetch_all=AsyncMock(side_effect=fetch_all))

    async def run(context, operation):
        return await operation(transaction)

    repository = PostgresObservableSourceRepository(executor=SimpleNamespace(run=run))
    repository._project_roles = AsyncMock(
        return_value=Roles(organization=role, project=project_role)
    )
    repository._load_project = AsyncMock(return_value=source_project())
    context = TenantContext(organization_id=ORG_ID, user_id=USER_ID)
    result = asyncio.run(repository.publication_status(context, PROJECT_ID, SOURCE_PROJECT_ID))
    assert result["can_configure_destinations"] is allowed
    assert result["origins"] == (
        [{"id": SITE_ID, "hostname": "opengeo.tools", "path_prefix": "/publications/"}]
        if allowed
        else []
    )
    assert transaction.fetch_all.await_count == (3 if allowed else 2)


def test_github_project_connection_routes_require_auth_and_return_durable_scope() -> None:
    connection_id = UUID("a9000000-0000-4000-8000-000000000490")

    class GitHubRepository(MemoryObservableSourceRepository):
        selected = None

        async def github_status(self, context, project_id, source_project_id):
            assert context.organization_id == ORG_ID
            assert context.user_id == USER_ID
            assert project_id == PROJECT_ID and source_project_id == SOURCE_PROJECT_ID
            return {
                "source_project_id": source_project_id,
                "connection": self.selected,
                "can_connect": self.selected is None,
                "available_connections": [],
                "revisions": [],
                "current_revision_id": REVISION_ID,
            }

        async def request_github_sync(self, *args):
            pytest.fail("Selecting a repository must not export private source")

        async def connect_github(self, context, project_id, source_project_id, selected):
            assert selected == connection_id
            self.selected = {
                "id": selected,
                "repository": "owner/private",
                "repository_id": 123,
                "enabled": True,
                "verified_at": NOW,
            }
            return await self.github_status(context, project_id, source_project_id)

    api = client(GitHubRepository())
    url = f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/github"
    assert api.get(url).status_code == 401
    assert api.get(url, headers=headers()).json()["connection"] is None
    result = api.request(
        "PUT", url, headers=headers(), json_body={"connection_id": str(connection_id)}
    )
    assert result.status_code == 200
    assert result.headers["Cache-Control"] == "no-store"
    assert result.json()["connection"]["repository"] == "owner/private"
    assert api.get(url, headers=headers()).json()["connection"] == result.json()["connection"]


@pytest.mark.parametrize("queue_fails", [False, True])
def test_save_stays_private_until_explicit_source_export(monkeypatch, queue_fails):
    class Repository(MemoryObservableSourceRepository):
        async def request_github_sync(self, context, project, source, revision):
            assert (project, source, revision) == (PROJECT_ID, SOURCE_PROJECT_ID, REVISION_ID)
            assert self.revisions, "Save must commit before queue notification"
            return True

        async def github_status(self, context, project, source):
            return {
                "source_project_id": source,
                "connection": None,
                "can_connect": False,
                "available_connections": [],
                "revisions": [],
            }

    sent = []

    class Queue:
        def __init__(self, settings, queue_url):
            assert queue_url.endswith("/github-builds")

        async def dispatch_github_source_sync(self, revision):
            sent.append(revision)
            if queue_fails:
                raise ProcessingDispatchUnavailable("Queue unavailable")

    monkeypatch.setattr("opengeo_api.observable_source_routes.AwsSqsRenderDispatcher", Queue)
    repository = Repository()
    api = client(repository)
    api.app.state.settings = Settings(
        env="test",
        aws_region="us-east-1",
        geodata_bucket="geodata.example",
        geodata_kms_key_arn="arn:aws:kms:us-east-1:111111111111:key/11111111-1111-4111-8111-111111111111",
        observable_build_provider="github",
        observable_build_queue_url="https://sqs.us-east-1.amazonaws.com/111111111111/github-builds",
    )
    response = api.post(
        f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/revisions",
        headers=headers(),
        json=revision_payload(),
    )
    assert response.status_code == 201
    assert response.json()["id"] == str(REVISION_ID)
    assert response.headers["X-OpenGeo-GitHub-Sync"] == "not_requested"
    assert sent == []
    assert [call[0] for call in repository.calls] == ["revision"]
    explicit = api.post(
        f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/revisions/{REVISION_ID}/github-sync",
        headers=headers(),
    )
    assert explicit.status_code == 200
    assert sent == [REVISION_ID]


def test_publication_response_retains_deployment_progress():
    from opengeo_api.observable_source_routes import FrameworkPublicationReviewResponse

    result = FrameworkPublicationReviewResponse.model_validate(
        {
            "id": REVISION_ID,
            "build_job_id": BUILD_ID,
            "mount_id": SITE_ID,
            "hostname": "opengeo.tools",
            "mount_path": "/analysis/reading-beyond-visible/",
            "result_checksum_sha256": "a" * 64,
            "output_tree_checksum_sha256": "b" * 64,
            "expected_generation": 1,
            "previous_release_prefix": "releases/previous",
            "reviewed_at": NOW,
            "expires_at": NOW,
            "approved_at": NOW,
            "deployment": {
                "stage": "copying",
                "completed_files": 2,
                "total_files": 8,
                "error_code": None,
                "updated_at": NOW,
                "release_prefix": None,
            },
        }
    )
    assert result.model_dump()["deployment"]["completed_files"] == 2


@pytest.mark.parametrize("mode", ["v1", "v2", "unavailable", "oversize", "wrong-media"])
def test_repository_seals_derived_archive_facts_without_reading_archive_bytes(mode: str) -> None:
    source = StoredObject(
        "source.opengeo.tools",
        "source/index.md",
        "source-v1",
        "etag",
        "text/markdown",
        12,
        "a" * 64,
    )
    captured = []
    attachment = (
        BUILD_ID,
        SOURCE_PROJECT_ID,
        ORG_ID,
        REVISION_ID,
        MARKDOWN_UPLOAD_ID,
        "archive-v1",
        "c" * 64,
        67_108_865 if mode == "oversize" else 18_930_972,
        "text/javascript" if mode == "wrong-media" else "application/geo+json",
        USER_ID,
        NOW,
        mode != "unavailable",
    )

    class Transaction:
        async def fetch_all(self, sql, params):
            if "observable_data_attachments attachment" in sql:
                assert params == (ORG_ID, PROJECT_ID, SOURCE_PROJECT_ID, [BUILD_ID])
                return [attachment]
            assert "observable_source_file_upload_intents" in sql
            return [
                (
                    MARKDOWN_UPLOAD_ID,
                    "src/index.md",
                    "text/markdown",
                    12,
                    "a" * 64,
                    source.bucket,
                    source.key,
                    NOW + timedelta(minutes=15),
                )
            ]

        async def fetch_one(self, sql, params):
            assert "current_revision_id" in sql
            return (None, 0)

        async def execute(self, sql, params):
            if "INSERT INTO app.observable_source_revisions" in sql:
                assert "%s::app.observable_source_rights_status" in sql
                captured.append(params[10].obj)
            if "UPDATE app.observable_source_projects" in sql:
                assert "rights_status = %s::app.observable_source_rights_status" in sql

    async def run(context, operation):
        return await operation(Transaction())

    storage = SimpleNamespace(inspect_object=AsyncMock(return_value=source))
    repository = PostgresObservableSourceRepository(
        executor=SimpleNamespace(run=run), storage=storage
    )
    repository._project_roles = AsyncMock(return_value=Roles(organization="admin"))
    repository._load_project = AsyncMock(return_value=source_project())
    repository._load_revision = AsyncMock(return_value=source_revision())
    draft = ObservableSourceRevisionDraft(
        expected_revision=0,
        title="Archive source",
        rights_status="unreviewed",
        entry_path="src/index.md",
        lockfile_path=None,
        change_summary="Bind exact data",
        files=(ObservableRevisionUpload(MARKDOWN_UPLOAD_ID, "src/index.md"),),
        data_attachments=()
        if mode == "v1"
        else (ObservableRevisionAttachment(BUILD_ID, "src/data/water.geojson"),),
    )
    operation = repository.create_revision(
        TenantContext(organization_id=ORG_ID, user_id=USER_ID),
        PROJECT_ID,
        SOURCE_PROJECT_ID,
        draft,
        "test-bind",
    )
    if mode in {"unavailable", "oversize", "wrong-media"}:
        with pytest.raises(ObservableSourceConflict):
            asyncio.run(operation)
        assert not captured
    else:
        asyncio.run(operation)
        assert len(captured) == 1
        if mode == "v1":
            assert captured[0]["schemaVersion"] == "opengeo.observable-source-revision.1.0.0"
            assert "dataAttachments" not in captured[0]
        else:
            assert captured[0]["schemaVersion"] == "opengeo.observable-source-revision.2.0.0"
            assert captured[0]["dataAttachments"] == [
                {
                    "path": "src/data/water.geojson",
                    "attachmentId": str(BUILD_ID),
                    "datasetId": str(ORG_ID),
                    "datasetVersionId": str(REVISION_ID),
                    "dataObjectId": str(MARKDOWN_UPLOAD_ID),
                    "s3VersionId": "archive-v1",
                    "checksumSha256": "c" * 64,
                    "sizeBytes": 18_930_972,
                    "contentType": "application/geo+json",
                }
            ]
    storage.inspect_object.assert_awaited_once_with("source/index.md")


@pytest.mark.parametrize("manager", [False, True])
def test_github_history_only_queries_log_content_for_source_managers(manager):
    async def fetch_all(sql, params):
        assert "CASE WHEN %s THEN dispatch.retained_logs ELSE NULL END" in sql
        assert params == (manager, ORG_ID, PROJECT_ID, SOURCE_PROJECT_ID, 25, 0)
        return []

    async def run(context, operation):
        return await operation(SimpleNamespace(fetch_all=fetch_all))

    repository = PostgresObservableSourceRepository(executor=SimpleNamespace(run=run))
    repository._project_roles = AsyncMock(
        return_value=Roles(organization="member", project="owner" if manager else "viewer")
    )
    repository._load_project = AsyncMock(return_value=source_project())
    assert (
        asyncio.run(
            repository.github_dispatches(
                TenantContext(organization_id=ORG_ID, user_id=USER_ID),
                PROJECT_ID,
                SOURCE_PROJECT_ID,
            )
        )
        == []
    )


def test_repository_rejects_archive_publication_until_rights_are_supported() -> None:
    async def run(context, operation):
        return await operation(SimpleNamespace(fetch_one=AsyncMock(return_value=None)))

    repository = PostgresObservableSourceRepository(executor=SimpleNamespace(run=run))
    repository._project_roles = AsyncMock(return_value=Roles(organization="admin"))
    repository._load_project = AsyncMock(return_value=source_project())
    repository._load_revision = AsyncMock(
        return_value=replace(
            source_revision(),
            manifest={"schemaVersion": "opengeo.observable-source-revision.2.0.0"},
        )
    )
    with pytest.raises(ObservableSourceConflict) as caught:
        asyncio.run(
            repository.create_build_job(
                TenantContext(organization_id=ORG_ID, user_id=USER_ID),
                PROJECT_ID,
                SOURCE_PROJECT_ID,
                REVISION_ID,
                "release_candidate",
                "test-build",
            )
        )
    assert caught.value.code == "observable_data_attachment_publication_unavailable"


@pytest.mark.parametrize("configured", [0, 1, 2])
def test_canonical_build_grant_is_separate_from_source_repository_link(configured) -> None:
    calls = []

    async def fetch_all(sql, parameters):
        calls.append((sql, parameters))
        assert "observable_github_links" not in sql
        assert "organization_id = %s AND enabled" in sql
        assert "build_workflow_id IS NOT NULL AND runtime_sha IS NOT NULL" in sql
        assert "LIMIT 2" in sql
        assert parameters == (ORG_ID,)
        return [(BUILD_ID, 7, 123, "owner/compiler")] * configured

    transaction = SimpleNamespace(fetch_all=fetch_all, execute=AsyncMock())

    async def run(context, operation):
        return await operation(transaction)

    repository = PostgresObservableSourceRepository(executor=SimpleNamespace(run=run))
    repository._project_roles = AsyncMock(return_value=Roles(organization="admin"))
    repository._load_revision = AsyncMock(return_value=source_revision())
    operation = repository.prepare_github_build(
        TenantContext(organization_id=ORG_ID, user_id=USER_ID),
        PROJECT_ID,
        SOURCE_PROJECT_ID,
        REVISION_ID,
    )
    if configured == 1:
        connection_id, connection = asyncio.run(operation)
        assert connection_id == BUILD_ID and connection.repository == "owner/compiler"
    else:
        with pytest.raises(ObservableSourceConflict) as caught:
            asyncio.run(operation)
        assert caught.value.code == (
            "github_build_connection_not_configured"
            if configured == 0
            else "github_build_connection_ambiguous"
        )
    assert len(calls) == 1
    transaction.execute.assert_not_awaited()


def test_build_policy_read_follows_the_servicing_lock_in_a_new_statement() -> None:
    calls = []
    marker = source_project()

    async def fetch_one(sql, parameters):
        calls.append((sql, parameters))
        return (SOURCE_PROJECT_ID,) if len(calls) == 1 else marker

    transaction = SimpleNamespace(fetch_one=fetch_one)
    repository = PostgresObservableSourceRepository(executor=SimpleNamespace())
    repository._project = lambda row: row
    context = TenantContext(organization_id=ORG_ID, user_id=USER_ID)
    assert (
        asyncio.run(
            repository._load_project(
                transaction, context, PROJECT_ID, SOURCE_PROJECT_ID, for_share=True
            )
        )
        == marker
    )
    assert len(calls) == 2
    assert "FOR SHARE" in calls[0][0]
    assert "observable_effective_compiler_digest" not in calls[0][0]
    assert "observable_effective_compiler_digest" in calls[1][0]
    assert all(parameters == (ORG_ID, PROJECT_ID, SOURCE_PROJECT_ID) for _, parameters in calls)


@pytest.mark.parametrize("mismatch", [None, "actor", "source", "revision", "purpose"])
@pytest.mark.parametrize("github_builds", [False, True])
def test_build_request_identity_replays_without_insert_or_event(
    mismatch: str | None, github_builds: bool
) -> None:
    previous = replace(succeeded_build_job(), state="pending")
    if mismatch == "actor":
        previous = replace(previous, created_by=ORG_ID)
    elif mismatch == "source":
        previous = replace(previous, source_project_id=ORG_ID)
    elif mismatch == "revision":
        previous = replace(previous, source_revision_id=ORG_ID)
    elif mismatch == "purpose":
        previous = replace(previous, purpose="release_candidate")

    transaction = SimpleNamespace(
        fetch_one=AsyncMock(side_effect=[None, (None,), (BUILD_ID,)]),
        fetch_all=AsyncMock(return_value=[(BUILD_ID, 7, 123, "owner/compiler")]),
        execute=AsyncMock(),
    )

    async def run(context, operation):
        return await operation(transaction)

    repository = PostgresObservableSourceRepository(
        executor=SimpleNamespace(run=run), github_builds=github_builds
    )
    repository._project_roles = AsyncMock(return_value=Roles(organization="admin"))
    repository._load_project = AsyncMock(
        return_value=replace(source_project(), compiler_image_digest="sha256:" + "a" * 64)
    )
    repository._load_revision = AsyncMock(return_value=source_revision())
    repository._load_build_job = AsyncMock(return_value=previous)
    repository._record_event = AsyncMock()
    context = TenantContext(organization_id=ORG_ID, user_id=USER_ID)
    operation = repository.create_build_job(
        context, PROJECT_ID, SOURCE_PROJECT_ID, REVISION_ID, "preview", "retry", BUILD_ID
    )
    if mismatch:
        with pytest.raises(ObservableSourceConflict, match="observable_build_idempotency_mismatch"):
            asyncio.run(operation)
    else:
        assert asyncio.run(operation) == previous
    transaction.execute.assert_not_awaited()
    repository._record_event.assert_not_awaited()
    references, first, second = transaction.fetch_one.await_args_list
    assert "publication_artifact_reference_sets" in references.args[0]
    assert "pg_advisory_xact_lock" in first.args[0]
    assert first.args[1] == ("observable-build:" + str(BUILD_ID),)
    assert second.args[1] == (ORG_ID, PROJECT_ID, BUILD_ID)
    repository._load_project.assert_awaited_once_with(
        transaction, context, PROJECT_ID, SOURCE_PROJECT_ID, for_share=True
    )
    if github_builds:
        transaction.fetch_all.assert_awaited_once()
        assert "observable_github_links" not in transaction.fetch_all.await_args.args[0]
    else:
        transaction.fetch_all.assert_not_awaited()


@pytest.mark.parametrize("state", ["pending", "running", "succeeded", None])
@pytest.mark.parametrize("compiler_digest", [DIGEST, "sha256:" + "a" * 64])
@pytest.mark.parametrize(
    "entry_path",
    [
        "src/index.md",
        "index.html",
        "map.html",
        "notebook.html",
        "analysis.ipynb",
    ],
)
@pytest.mark.parametrize("purpose", ["preview", "release_candidate"])
def test_equivalent_build_inputs_reuse_job_without_new_execution_record(
    state, compiler_digest, entry_path, purpose
) -> None:
    requests = []
    original = source_revision()
    framework = entry_path.endswith(".md")
    entry = replace(
        original.files[-1],
        relative_path=entry_path,
        content_type=(
            "text/markdown"
            if framework
            else "application/x-ipynb+json"
            if entry_path.endswith(".ipynb")
            else "text/html"
        ),
    )
    revision = replace(
        original,
        entry_path=entry_path,
        rights_status="approved",
        lockfile_path=original.lockfile_path if framework else None,
        files=(original.files[0], entry) if framework else (entry,),
        manifest={
            **original.manifest,
            "entryPath": entry_path,
            "lockfilePath": original.lockfile_path if framework else None,
        },
    )

    async def fetch_one(sql, params):
        if "publication_artifact_reference_sets" in sql:
            return None
        if "pg_advisory_xact_lock" in sql:
            assert params == (f"observable-build-inputs:{ORG_ID}:{SOURCE_PROJECT_ID}:{USER_ID}",)
            return (None,)
        assert "request = %s::jsonb" in sql
        assert "state IN ('pending', 'running')" in sql
        assert "result_checksum_sha256 IS NOT NULL" in sql
        assert params[:5] == (ORG_ID, PROJECT_ID, SOURCE_PROJECT_ID, REVISION_ID, USER_ID)
        requests.append(params[5].obj)
        return (BUILD_ID,) if state else None

    transaction = SimpleNamespace(fetch_one=fetch_one, execute=AsyncMock())

    async def run(context, operation):
        return await operation(transaction)

    async def load_job(_transaction, _context, _project, build_id):
        return replace(
            succeeded_build_job(),
            build_job_id=build_id,
            request=requests[0],
            state=state or "pending",
            purpose=purpose,
        )

    repository = PostgresObservableSourceRepository(executor=SimpleNamespace(run=run))
    repository._project_roles = AsyncMock(return_value=Roles(organization="admin"))
    repository._load_project = AsyncMock(
        return_value=replace(source_project(), compiler_image_digest=compiler_digest)
    )
    repository._load_revision = AsyncMock(return_value=revision)
    repository._load_build_job = load_job
    repository._record_event = AsyncMock()
    context = TenantContext(organization_id=ORG_ID, user_id=USER_ID)
    result = asyncio.run(
        repository.create_build_job(
            context, PROJECT_ID, SOURCE_PROJECT_ID, REVISION_ID, purpose, "new-browser-request"
        )
    )
    assert requests[0]["compilerImageDigest"] == compiler_digest
    assert requests[0]["sourceManifestChecksumSha256"] == revision.manifest_checksum_sha256
    assert requests[0]["purpose"] == purpose
    assert requests[0]["lockfileChecksumSha256"] == ("b" * 64 if framework else None)
    if state:
        assert result.build_job_id == BUILD_ID
        transaction.execute.assert_not_awaited()
        repository._record_event.assert_not_awaited()
    else:
        assert result.build_job_id != BUILD_ID
        transaction.execute.assert_awaited_once()
        repository._record_event.assert_awaited_once()


@pytest.mark.parametrize("mismatch", ["author", "source", "revision", "compiler", "failed"])
def test_build_reuse_rechecks_loaded_job_identity(mismatch) -> None:
    requests = []

    async def fetch_one(sql, params):
        if "publication_artifact_reference_sets" in sql:
            return None
        if "pg_advisory_xact_lock" in sql:
            return (None,)
        requests.append(params[-1].obj)
        return (BUILD_ID,)

    transaction = SimpleNamespace(fetch_one=fetch_one, execute=AsyncMock())

    async def run(context, operation):
        return await operation(transaction)

    async def load_job(*args):
        changes = {
            "author": {"created_by": UUID(int=800)},
            "source": {"source_project_id": UUID(int=801)},
            "revision": {"source_revision_id": UUID(int=802)},
            "compiler": {"request": {**requests[0], "compilerImageDigest": "sha256:" + "0" * 64}},
            "failed": {"state": "failed"},
        }
        return replace(replace(succeeded_build_job(), request=requests[0]), **changes[mismatch])

    repository = PostgresObservableSourceRepository(executor=SimpleNamespace(run=run))
    repository._project_roles = AsyncMock(return_value=Roles(organization="admin"))
    repository._load_project = AsyncMock(return_value=source_project())
    repository._load_revision = AsyncMock(return_value=source_revision())
    repository._load_build_job = load_job
    repository._record_event = AsyncMock()
    with pytest.raises(ObservableSourceConflict, match="observable_build_reuse_mismatch"):
        asyncio.run(
            repository.create_build_job(
                TenantContext(organization_id=ORG_ID, user_id=USER_ID),
                PROJECT_ID,
                SOURCE_PROJECT_ID,
                REVISION_ID,
                "preview",
                "recheck",
            )
        )
    transaction.execute.assert_not_awaited()
    repository._record_event.assert_not_awaited()


def test_mixed_archive_and_artifact_preview_uses_new_protocol_without_public_consent(
    monkeypatch,
) -> None:
    from opengeo_api import publication_artifact_inputs

    requests = []
    saved = source_revision()
    saved = replace(
        saved,
        manifest={
            **saved.manifest,
            "schemaVersion": "opengeo.observable-source-revision.2.0.0",
            "dataAttachments": [{"path": "src/data/original.tif", "sizeBytes": 128}],
        },
    )
    monkeypatch.setattr(
        publication_artifact_inputs,
        "read_inputs_in_transaction",
        AsyncMock(
            return_value={
                "manifest": {"sourceRevisionId": str(REVISION_ID), "artifacts": []},
                "manifest_checksum_sha256": "e" * 64,
            }
        ),
    )

    async def fetch_one(sql, params):
        if "publication_artifact_reference_sets" in sql or "pg_advisory_xact_lock" in sql:
            return None
        requests.append(params[-1].obj)
        return (BUILD_ID,)

    transaction = SimpleNamespace(fetch_one=fetch_one, execute=AsyncMock())

    async def run(context, operation):
        return await operation(transaction)

    async def load_job(*args):
        return replace(succeeded_build_job(), request=requests[0])

    repository = PostgresObservableSourceRepository(SimpleNamespace(run=run), artifact_builds=True)
    repository._project_roles = AsyncMock(return_value=Roles(organization="admin"))
    repository._load_project = AsyncMock(return_value=source_project())
    repository._load_revision = AsyncMock(return_value=saved)
    repository._load_build_job = load_job
    asyncio.run(
        repository.create_build_job(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            SOURCE_PROJECT_ID,
            REVISION_ID,
            "preview",
            "mixed-inputs",
            artifact_input_id=UUID(int=997),
        )
    )
    assert requests[0]["schemaVersion"] == "opengeo.observable-build-request.3.0.0"
    assert requests[0]["outputProfile"] == "default-32m"
    assert requests[0]["sizeAcknowledgment"] is None
    assert requests[0]["distributionApprovalId"] is None
    assert requests[0]["distributionApprovalChecksumSha256"] is None
    assert requests[0]["resourceLimits"] == source_project().resource_limits
    transaction.execute.assert_not_awaited()


@pytest.mark.parametrize(
    "case,purpose,expected",
    [
        ("legacy", "preview", None),
        ("legacy", "release_candidate", None),
        ("native", "preview", None),
        ("native", "release_candidate", None),
        ("root-entry", "preview", None),
        ("empty-data-manifest", "release_candidate", None),
        ("empty-artifact", "preview", "observable_localized_artifact_unsupported"),
        ("empty-artifact", "release_candidate", "observable_localized_artifact_unsupported"),
        ("html-entry", "preview", "observable_localized_entry_unsupported"),
        ("other-markdown", "preview", "observable_localized_entry_unsupported"),
        ("html-artifact", "preview", "observable_localized_artifact_unsupported"),
        ("data", "preview", None),
        ("data", "release_candidate", "observable_data_attachment_publication_unavailable"),
        ("approved-data", "release_candidate", None),
        ("expanded-data", "preview", None),
        ("expanded-approved-data", "release_candidate", None),
        ("referenced-approved", "release_candidate", None),
        ("referenced-localized-approved", "release_candidate", None),
        ("expanded-no-data", "preview", "observable_output_profile_archive_required"),
        ("expanded-no-ack", "preview", "observable_output_profile_consent_required"),
        ("unapproved-source", "release_candidate", "observable_source_rights_unapproved"),
        ("idempotency-representation", "preview", "observable_build_idempotency_mismatch"),
    ],
)
def test_native_localization_build_admission_preserves_existing_authority(
    case, purpose, expected, monkeypatch
) -> None:
    from opengeo_api import observable_distribution_approvals, publication_artifact_inputs

    requests = []
    localized = case not in {"legacy", "referenced-approved"}
    data = case in {"data", "approved-data", "expanded-data", "expanded-approved-data"}
    approved = case in {
        "approved-data",
        "expanded-approved-data",
        "referenced-approved",
        "referenced-localized-approved",
    }
    artifacts = case in {"empty-artifact", "html-artifact"}
    expanded = case.startswith("expanded-")
    entry_path = (
        "index.md"
        if case == "root-entry"
        else "index.html"
        if case == "html-entry"
        else "src/other.md"
        if case == "other-markdown"
        else "src/index.md"
    )
    original = source_revision()
    manifest = {**original.manifest, "entryPath": entry_path}
    if data or case == "empty-data-manifest":
        manifest.update(
            schemaVersion="opengeo.observable-source-revision.2.0.0",
            dataAttachments=[{"path": "src/data/original.tif"}] if data else [],
        )
    if case.startswith("referenced-"):
        manifest.update(
            schemaVersion="opengeo.observable-source-revision.3.0.0",
            dataAttachments=[],
            referencedFiles=[{"path": "src/data/original.tif"}],
        )
    revision = replace(
        original,
        entry_path=entry_path,
        manifest=manifest,
        rights_status="unreviewed" if case == "unapproved-source" else "approved",
    )
    snapshot = {
        "manifest": {
            "sourceRevisionId": str(REVISION_ID),
            "artifacts": [{"path": "src/map.html", "output": {"contentType": "text/html"}}]
            if case == "html-artifact"
            else [],
        },
        "manifest_checksum_sha256": "e" * 64,
    }
    artifact_read = AsyncMock(return_value=snapshot)
    monkeypatch.setattr(publication_artifact_inputs, "read_inputs_in_transaction", artifact_read)
    approval_read = AsyncMock(
        return_value={"id": str(ORG_ID), "manifest_checksum_sha256": "f" * 64}
    )
    monkeypatch.setattr(
        observable_distribution_approvals, "read_distribution_approval", approval_read
    )

    async def fetch_one(sql, params):
        if "validate_observable_revision_input_bindings" in sql:
            assert case.startswith("referenced-")
            return ([],)
        if "publication_artifact_reference_sets" in sql or "pg_advisory_xact_lock" in sql:
            return None
        if "request = %s::jsonb" in sql:
            requests.append(params[-1].obj)
            return None
        assert case == "idempotency-representation" and "SELECT id" in sql
        return (BUILD_ID,)

    transaction = SimpleNamespace(fetch_one=fetch_one, execute=AsyncMock())

    async def run(context, operation):
        return await operation(transaction)

    async def load_job(*args):
        return replace(
            succeeded_build_job(),
            purpose=purpose,
            request=requests[0] if requests else succeeded_build_job().request,
        )

    repository = PostgresObservableSourceRepository(SimpleNamespace(run=run), artifact_builds=True)
    repository._project_roles = AsyncMock(return_value=Roles(organization="admin"))
    repository._load_project = AsyncMock(return_value=source_project())
    repository._load_revision = AsyncMock(return_value=revision)
    repository._load_build_job = load_job
    repository._record_event = AsyncMock()
    operation = repository.create_build_job(
        TenantContext(USER_ID, ORG_ID),
        PROJECT_ID,
        SOURCE_PROJECT_ID,
        REVISION_ID,
        purpose,
        "native-localization",
        idempotency_key=BUILD_ID if case == "idempotency-representation" else None,
        artifact_input_id=UUID(int=997) if artifacts else None,
        output_profile="archive-96m" if expanded else "default-32m",
        size_acknowledgment="allow-up-to-96-mib-output"
        if expanded and case != "expanded-no-ack"
        else None,
        distribution_approval_id=ORG_ID if approved else None,
        output_representation="single-html" if localized else None,
    )
    if expected:
        with pytest.raises(ObservableSourceConflict, match=expected):
            asyncio.run(operation)
        transaction.execute.assert_not_awaited()
        repository._record_event.assert_not_awaited()
    else:
        result = asyncio.run(operation)
        request = result.request
        transaction.execute.assert_awaited_once()
        assert request["resourceLimits"] == source_project().resource_limits
        assert request["schemaVersion"] == (
            "opengeo.observable-build-request.4.0.0"
            if localized
            else "opengeo.observable-build-request.3.0.0"
            if approved
            else "opengeo.observable-build-request.1.0.0"
        )
        if localized:
            assert request["outputRepresentation"] == "single-html"
            assert request["outputProfile"] == ("archive-96m" if expanded else "default-32m")
            assert request["distributionApprovalId"] == (str(ORG_ID) if approved else None)
            assert request["distributionApprovalChecksumSha256"] == ("f" * 64 if approved else None)
        else:
            assert "outputRepresentation" not in request
            if approved:
                assert request["outputProfile"] == "default-32m"
                assert request["distributionApprovalId"] == str(ORG_ID)
            else:
                assert "outputProfile" not in request
    assert approval_read.await_count == int(approved)
    if artifacts:
        artifact_read.assert_not_awaited()


def test_native_localization_request_literal_is_forwarded_without_changing_defaults():
    class Repository(MemoryObservableSourceRepository):
        async def create_build_job(self, *args, **options):
            self.native_options = options
            return await super().create_build_job(*args)

    repository = Repository()
    api = client(repository)
    url = f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/revisions/{REVISION_ID}/build-jobs"
    assert api.post(url, headers=headers(), json={}).status_code == 201
    assert repository.native_options == {}
    assert (
        api.post(url, headers=headers(), json={"output_representation": "single-html"}).status_code
        == 201
    )
    assert repository.native_options == {"output_representation": "single-html"}
    assert (
        api.post(url, headers=headers(), json={"output_representation": "anything"}).status_code
        == 422
    )


def test_build_history_reauthorizes_before_reading_and_scopes_every_query() -> None:
    transaction = SimpleNamespace(fetch_all=AsyncMock(return_value=[]))

    async def run(context, operation):
        return await operation(transaction)

    repository = PostgresObservableSourceRepository(executor=SimpleNamespace(run=run))
    repository._project_roles = AsyncMock(return_value=Roles(organization="member"))
    repository._load_project = AsyncMock(return_value=source_project())
    context = TenantContext(organization_id=ORG_ID, user_id=USER_ID)
    with pytest.raises(ObservableSourceAccessDenied):
        asyncio.run(repository.list_build_jobs(context, PROJECT_ID, SOURCE_PROJECT_ID))
    transaction.fetch_all.assert_not_awaited()
    repository._load_project.assert_not_awaited()
    repository._project_roles.return_value = Roles(organization="admin")
    assert (
        asyncio.run(repository.list_build_jobs(context, PROJECT_ID, SOURCE_PROJECT_ID, 10, 20))
        == ()
    )
    call = transaction.fetch_all.await_args
    assert call.args[1] == (ORG_ID, PROJECT_ID, SOURCE_PROJECT_ID, 10, 20)
    assert "ORDER BY created_at DESC, id DESC" in call.args[0]
    repository._load_project.assert_awaited_once_with(
        transaction, context, PROJECT_ID, SOURCE_PROJECT_ID
    )
    for limit, offset in [(0, 0), (101, 0), (25, -1), (25, 100_001)]:
        with pytest.raises(ObservableSourceConflict, match="observable_build_page_invalid"):
            asyncio.run(
                repository.list_build_jobs(context, PROJECT_ID, SOURCE_PROJECT_ID, limit, offset)
            )


def succeeded_build_job() -> ObservableBuildJob:
    prefix = (
        f"organizations/{ORG_ID}/projects/{PROJECT_ID}/source-projects/"
        f"{SOURCE_PROJECT_ID}/builds/{BUILD_ID}/output/"
    )
    return ObservableBuildJob(
        build_job_id=BUILD_ID,
        source_project_id=SOURCE_PROJECT_ID,
        source_revision_id=REVISION_ID,
        source_revision_number=1,
        purpose="preview",
        state="succeeded",
        request={
            "schemaVersion": "opengeo.observable-build-request.1.0.0",
            "sourceRevisionId": str(REVISION_ID),
            "compilerImageDigest": DIGEST,
            "networkPolicy": "deny_all",
            "resourceLimits": OBSERVABLE_BUILD_LIMITS,
        },
        request_checksum_sha256="e" * 64,
        output_prefix=prefix,
        result={
            "schemaVersion": "opengeo.observable-build-result.1.0.0",
            "buildJobId": str(BUILD_ID),
            "requestChecksumSha256": "e" * 64,
            "compilerImageDigest": DIGEST,
            "inputManifestChecksumSha256": "d" * 64,
            "outputPrefix": prefix,
            "outputTreeChecksumSha256": "f" * 64,
            "sandbox": {
                "credentialMode": "none",
                "networkPolicy": "deny_all",
                "readOnlyInputs": True,
                "readOnlyBaseImage": True,
                "unprivilegedUser": True,
                "dockerSocket": False,
            },
            "networkRequests": [],
            "validationReport": {
                "entryPath": "src/index.md",
                "fixedBuilderConfig": True,
                "frameworkVersion": "1.13.4",
                "inputBytes": 256,
                "inputFileCount": 2,
                "lockfileVerified": True,
                "outputBytes": 128,
                "outputFileCount": 1,
                "prewarmedFrameworkCache": True,
                "publicationAuthorized": False,
                "coordinatorSchemaVersion": "opengeo.observable-coordinator.1.0.0",
                "inputObjectsReverified": True,
                "outputBytesReverified": True,
                "outputObjectsReverified": True,
            },
            "routeManifest": [{"path": "/", "file": "dist/index.html"}],
            "outputManifest": {
                "files": [
                    {
                        "path": "dist/index.html",
                        "bucket": "source.opengeo.tools",
                        "objectKey": f"{prefix}index.html",
                        "s3VersionId": "output-v1",
                        "etag": "output-etag",
                        "contentType": "text/html",
                        "sizeBytes": 128,
                        "checksumSha256": "a" * 64,
                    }
                ]
            },
        },
        result_checksum_sha256="b" * 64,
        attempt_count=1,
        error_code=None,
        created_by=USER_ID,
        created_at=NOW,
        started_at=NOW,
        finished_at=NOW,
        updated_at=NOW,
    )


def test_public_reference_routes_keep_id_only_registration_private_and_idempotent():
    from opengeo_api.observable_sources import ObservablePublicFileReference

    class References(MemoryObservableSourceRepository):
        def __init__(self):
            super().__init__()
            self.reference = None

        async def register_public_file_reference(
            self,
            context,
            project,
            source,
            dataset,
            version,
            resource,
            edition,
            distribution,
            request_id,
        ):
            assert context == TenantContext(USER_ID, ORG_ID)
            assert (project, source) == (PROJECT_ID, SOURCE_PROJECT_ID)
            self.calls.append(("public-reference", request_id))
            if self.reference is None:
                self.reference = ObservablePublicFileReference(
                    BUILD_ID,
                    source,
                    dataset,
                    version,
                    resource,
                    edition,
                    4,
                    distribution,
                    "https://data.example.com/original.tif",
                    "image/tiff",
                    64_912_721,
                    "c" * 64,
                    USER_ID,
                    NOW,
                    True,
                )
            return self.reference

        async def list_public_file_references(self, context, project, source):
            assert context == TenantContext(USER_ID, ORG_ID)
            assert (project, source) == (PROJECT_ID, SOURCE_PROJECT_ID)
            return () if self.reference is None else (self.reference,)

    repository = References()
    api = client(repository)
    path = f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/public-file-references"
    payload = {
        "dataset_id": str(SITE_ID),
        "source_version": 1,
        "resource_id": str(REVISION_ID),
        "resource_version_id": str(MARKDOWN_UPLOAD_ID),
        "distribution_id": "urn:distribution:original",
    }
    assert api.post(path, json=payload).status_code == api.get(path).status_code == 401
    assert api.get(path, headers=headers()).json() == []
    for forged in ("url", "checksum_sha256", "size_bytes", "content_type", "bucket", "object_key"):
        assert (
            api.post(path, json=payload | {forged: "untrusted"}, headers=headers()).status_code
            == 422
        )
    assert (
        api.post(path, json=payload | {"source_version": True}, headers=headers()).status_code
        == 422
    )
    assert repository.calls == []
    first = api.post(path, json=payload, headers=headers())
    assert first.status_code == 200 and first.headers["Cache-Control"] == "no-store"
    assert api.post(path, json=payload, headers=headers()).json() == first.json()
    assert api.get(path, headers=headers()).json() == [first.json()]
    result = first.json()
    assert result["kind"] == "referenced-public-file" and result["custody"] == "referenced"
    assert result["size_bytes"] == 64_912_721 and result["resource_version_number"] == 4
    assert all(
        result[key] is False for key in ("revision_bound", "build_input", "publication_authorized")
    )
    assert "bucket" not in result and "s3_version_id" not in result
    repository.reference = replace(repository.reference, available=False)
    assert api.get(path, headers=headers()).json()[0]["available"] is False
    assert all(call[0] == "public-reference" for call in repository.calls)


def test_public_reference_routes_preserve_authority_denial():
    class Denied(MemoryObservableSourceRepository):
        async def register_public_file_reference(self, *args):
            raise ObservableSourceAccessDenied("source denied")

        async def list_public_file_references(self, *args):
            raise ObservableSourceAccessDenied("source denied")

    api = client(Denied())
    path = f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/public-file-references"
    assert api.get(path, headers=headers()).status_code == 403
    assert (
        api.post(
            path,
            headers=headers(),
            json={
                "dataset_id": str(SITE_ID),
                "source_version": 1,
                "resource_id": str(REVISION_ID),
                "resource_version_id": str(MARKDOWN_UPLOAD_ID),
                "distribution_id": "urn:distribution:original",
            },
        ).status_code
        == 403
    )


def test_revision_accepts_only_sorted_tiff_reference_bindings_and_shared_path_bounds():
    repository = MemoryObservableSourceRepository()
    api = client(repository)
    path = f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/revisions"
    payload = revision_payload() | {
        "referenced_files": [{"reference_id": str(BUILD_ID), "relative_path": "src/data/a.tif"}]
    }
    assert api.post(path, json=payload, headers=headers()).status_code == 201
    draft = repository.calls[-1][2]
    assert draft.referenced_files[0].reference_id == BUILD_ID
    assert draft.referenced_files[0].relative_path == "src/data/a.tif"
    before = len(repository.calls)
    invalid = [
        [{"reference_id": str(BUILD_ID), "relative_path": "src/data/a.csv"}],
        [{"reference_id": str(BUILD_ID), "relative_path": "src/index.md/data.tif"}],
        [
            {"reference_id": str(BUILD_ID), "relative_path": "src/data/b.tif"},
            {"reference_id": str(BUILD_ID), "relative_path": "src/data/a.tif"},
        ],
        [
            {"reference_id": str(BUILD_ID), "relative_path": "src/data/a.tif"},
            {"reference_id": str(BUILD_ID), "relative_path": "src/data/A.TIF"},
        ],
        [
            {
                "reference_id": str(BUILD_ID),
                "relative_path": "src/data/a.tif",
                "url": "https://forged.test/x",
            }
        ],
        [
            {"reference_id": str(BUILD_ID), "relative_path": f"src/data/{index:03}.tif"}
            for index in range(127)
        ],
    ]
    for bindings in invalid:
        assert (
            api.post(
                path, json=payload | {"referenced_files": bindings}, headers=headers()
            ).status_code
            == 422
        )
    assert (
        api.post(
            path,
            headers=headers(),
            json=payload
            | {
                "data_attachments": [
                    {"attachment_id": str(BUILD_ID), "relative_path": "src/data/a.tif"}
                ]
            },
        ).status_code
        == 422
    )
    assert len(repository.calls) == before


@pytest.mark.parametrize("purpose", ["release_candidate"])
def test_referenced_public_builds_remain_unadmitted_before_artifact_or_storage_reads(purpose):
    transaction = SimpleNamespace(fetch_one=AsyncMock(), fetch_all=AsyncMock(), execute=AsyncMock())

    async def run(context, operation):
        return await operation(transaction)

    repository = PostgresObservableSourceRepository(executor=SimpleNamespace(run=run))
    repository._project_roles = AsyncMock(return_value=Roles(organization="admin"))
    repository._load_project = AsyncMock(return_value=source_project())
    repository._load_revision = AsyncMock(
        return_value=replace(
            source_revision(),
            manifest={"schemaVersion": "opengeo.observable-source-revision.3.0.0"},
        )
    )
    with pytest.raises(
        ObservableSourceConflict, match="observable_referenced_file_publication_unavailable"
    ):
        asyncio.run(
            repository.create_build_job(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                SOURCE_PROJECT_ID,
                REVISION_ID,
                purpose,
                "test",
            )
        )
    transaction.fetch_one.assert_not_awaited()
    transaction.fetch_all.assert_not_awaited()
    transaction.execute.assert_not_awaited()


@pytest.mark.parametrize("localized", [False, True])
def test_referenced_preview_reauthorizes_before_reuse_artifact_or_storage_reads(localized):
    async def fetch_one(sql, params):
        assert "validate_observable_revision_input_bindings" in sql
        assert params[:3] == (ORG_ID, PROJECT_ID, SOURCE_PROJECT_ID)
        assert params[3].obj["schemaVersion"] == "opengeo.observable-source-revision.3.0.0"
        raise ObservableSourceConflict("observable_public_file_reference_unavailable")

    transaction = SimpleNamespace(fetch_one=AsyncMock(side_effect=fetch_one),
                                  fetch_all=AsyncMock(), execute=AsyncMock())
    async def run(context, operation):
        return await operation(transaction)
    repository = PostgresObservableSourceRepository(executor=SimpleNamespace(run=run))
    repository._project_roles = AsyncMock(return_value=Roles(organization="admin"))
    repository._load_project = AsyncMock(return_value=source_project())
    repository._load_revision = AsyncMock(
        return_value=replace(source_revision(),
            manifest={"schemaVersion": "opengeo.observable-source-revision.3.0.0"})
    )
    with pytest.raises(
        ObservableSourceConflict, match="observable_public_file_reference_unavailable"
    ):
        asyncio.run(repository.create_build_job(TenantContext(USER_ID, ORG_ID), PROJECT_ID,
            SOURCE_PROJECT_ID, REVISION_ID, "preview", "test", idempotency_key=BUILD_ID,
            output_profile="archive-96m" if localized else "default-32m",
            size_acknowledgment="allow-up-to-96-mib-output" if localized else None,
            output_representation="single-html" if localized else None))
    transaction.fetch_one.assert_awaited_once()
    transaction.fetch_all.assert_not_awaited()
    transaction.execute.assert_not_awaited()


@pytest.mark.parametrize("options,code", [
    ({"artifact_input_id": BUILD_ID}, "observable_referenced_file_composition_unsupported"),
    ({"output_profile": "archive-96m"}, "observable_referenced_file_composition_unsupported"),
    ({"distribution_approval_id": BUILD_ID}, "observable_referenced_file_publication_unavailable"),
])
def test_referenced_preview_keeps_unsupported_compositions_closed(options, code):
    transaction = SimpleNamespace(fetch_one=AsyncMock(), fetch_all=AsyncMock(), execute=AsyncMock())
    async def run(context, operation):
        return await operation(transaction)
    repository = PostgresObservableSourceRepository(executor=SimpleNamespace(run=run))
    repository._project_roles = AsyncMock(return_value=Roles(organization="admin"))
    repository._load_project = AsyncMock(return_value=source_project())
    repository._load_revision = AsyncMock(return_value=replace(source_revision(),
        manifest={"schemaVersion": "opengeo.observable-source-revision.3.0.0"}))
    with pytest.raises(ObservableSourceConflict, match=code):
        asyncio.run(repository.create_build_job(TenantContext(USER_ID, ORG_ID), PROJECT_ID,
            SOURCE_PROJECT_ID, REVISION_ID, "preview", "test", **options))
    transaction.fetch_one.assert_not_awaited()
    transaction.fetch_all.assert_not_awaited()
    transaction.execute.assert_not_awaited()


@pytest.mark.parametrize("operation", ["issue", "exchange"])
def test_referenced_revision_preview_issuance_and_exchange_recheck_current_pins(operation):
    queries = []
    capability = _encode_preview_capability(BUILD_ID, TenantContext(USER_ID, ORG_ID))

    async def fetch_one(sql, params):
        queries.append((sql, params))
        if "manifest->>'schemaVersion'" in sql:
            assert params == (ORG_ID, PROJECT_ID, SOURCE_PROJECT_ID, REVISION_ID)
            return (
                "opengeo.observable-source-revision.3.0.0",
                {"referencedFiles": [{"referenceId": str(BUILD_ID)}]},
            )
        if "validate_observable_revision_input_bindings" in sql:
            assert params[:3] == (ORG_ID, PROJECT_ID, SOURCE_PROJECT_ID)
            assert params[3].obj == {"referencedFiles": [{"referenceId": str(BUILD_ID)}]}
            raise ObservableSourceConflict("observable_public_file_reference_unavailable")
        assert "consume_observable_preview_capability" in sql
        return (
            succeeded_build_job().output_prefix,
            "dist/index.html",
            NOW + timedelta(minutes=15),
            PROJECT_ID,
            SOURCE_PROJECT_ID,
            REVISION_ID,
            {},
        )

    async def run(context, work):
        return await work(SimpleNamespace(fetch_one=fetch_one))

    repository = PostgresObservableSourceRepository(executor=SimpleNamespace(run=run))
    repository._project_roles = AsyncMock(return_value=Roles(organization="admin"))
    repository._load_build_job = AsyncMock(return_value=succeeded_build_job())
    repository._record_event = AsyncMock()
    work = (
        repository.create_preview_capability(
            TenantContext(USER_ID, ORG_ID), PROJECT_ID, BUILD_ID, "preview"
        )
        if operation == "issue"
        else repository.exchange_preview_capability(capability)
    )
    with pytest.raises(
        ObservableSourceConflict, match="observable_public_file_reference_unavailable"
    ):
        asyncio.run(work)
    assert not any("INSERT INTO" in sql for sql, _ in queries)
    repository._record_event.assert_not_awaited()


def test_attachment_registration_is_authenticated_idempotent_and_not_a_build_input() -> None:
    class Attachments(MemoryObservableSourceRepository):
        def __init__(self):
            super().__init__()
            self.attachment = None

        async def register_data_attachment(
            self,
            context,
            project_id,
            source_project_id,
            dataset_id,
            dataset_version_id,
            data_object_id,
            request_id,
        ):
            assert context.organization_id == ORG_ID
            assert context.user_id == USER_ID
            assert project_id == PROJECT_ID and source_project_id == SOURCE_PROJECT_ID
            self.calls.append(("attachment", request_id))
            if self.attachment is None:
                self.attachment = ObservableDataAttachment(
                    BUILD_ID,
                    source_project_id,
                    dataset_id,
                    dataset_version_id,
                    data_object_id,
                    "archive-v1",
                    "a" * 64,
                    18_930_972,
                    "application/geo+json",
                    USER_ID,
                    NOW,
                    True,
                )
            return self.attachment

        async def list_data_attachments(self, context, project_id, source_project_id):
            assert context.organization_id == ORG_ID and project_id == PROJECT_ID
            assert source_project_id == SOURCE_PROJECT_ID
            return () if self.attachment is None else (self.attachment,)

    repository = Attachments()
    api = client(repository)
    path = f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/data-attachments"
    payload = {
        "dataset_id": str(SITE_ID),
        "dataset_version_id": str(REVISION_ID),
        "data_object_id": str(MARKDOWN_UPLOAD_ID),
    }
    assert api.post(path, json=payload).status_code == 401
    assert api.get(path).status_code == 401
    assert api.get(path, headers=headers()).json() == []
    for forged in ["checksum_sha256", "bucket", "object_key", "size_bytes", "s3_version_id"]:
        assert (
            api.post(path, json={**payload, forged: "untrusted"}, headers=headers()).status_code
            == 422
        )
    assert repository.calls == []
    first = api.post(path, json=payload, headers=headers())
    assert first.status_code == 200
    assert api.post(path, json=payload, headers=headers()).json() == first.json()
    assert api.get(path, headers=headers()).json() == [first.json()]
    result = first.json()
    assert result["size_bytes"] == 18_930_972
    assert result["available"] is True
    assert result["revision_bound"] is False
    assert result["build_input"] is False
    assert result["publication_authorized"] is False
    assert "bucket" not in result and "object_key" not in result
    assert all(call[0] == "attachment" for call in repository.calls)


def test_attachment_routes_preserve_repository_access_denial() -> None:
    class Denied(MemoryObservableSourceRepository):
        async def list_data_attachments(self, *args):
            raise ObservableSourceAccessDenied("project denied")

        async def register_data_attachment(self, *args):
            raise ObservableSourceAccessDenied("project denied")

    api = client(Denied())
    path = f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/data-attachments"
    assert api.get(path, headers=headers()).status_code == 403
    assert (
        api.post(
            path,
            headers=headers(),
            json={
                "dataset_id": str(SITE_ID),
                "dataset_version_id": str(REVISION_ID),
                "data_object_id": str(MARKDOWN_UPLOAD_ID),
            },
        ).status_code
        == 403
    )


@pytest.mark.parametrize("media_type", ["application/x-ipynb+json", "application/json"])
def test_native_notebook_upload_request_accepts_supported_media_types(media_type) -> None:
    from opengeo_api.observable_source_routes import ObservableSourceFileUploadRequest

    request = ObservableSourceFileUploadRequest(
        relative_path="index.ipynb",
        content_type=media_type,
        size_bytes=300,
        checksum_sha256="a" * 64,
    )
    assert request.content_type == media_type


def test_native_notebook_media_type_does_not_admit_other_source_extensions() -> None:
    from pydantic import ValidationError

    from opengeo_api.observable_source_routes import ObservableSourceFileUploadRequest

    with pytest.raises(ValidationError):
        ObservableSourceFileUploadRequest(
            relative_path="index.html",
            content_type="application/x-ipynb+json",
            size_bytes=300,
            checksum_sha256="a" * 64,
        )


def test_authenticated_exact_source_revision_and_inert_build_job_flow() -> None:
    repository = MemoryObservableSourceRepository()
    api = client(repository)
    assert api.get(f"/projects/{PROJECT_ID}/source-projects").status_code == 401

    created = api.post(
        f"/projects/{PROJECT_ID}/sites/{SITE_ID}/source-project",
        headers=headers(),
        json={"title": "Field report source"},
    )
    assert created.status_code == 201
    assert created.json()["build_policy"] == {
        "compiler_image_digest": DIGEST,
        "framework_version": "1.13.4",
        "lockfile_format": "npm-package-lock-v3",
        "network_policy": "deny_all",
        "resource_limits": OBSERVABLE_BUILD_LIMITS,
    }
    for path, content_type, size, checksum in [
        ("package-lock.json", "application/json", 18, "b" * 64),
        ("src/index.md", "text/markdown", 12, "a" * 64),
    ]:
        upload = api.post(
            f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/file-uploads",
            headers=headers(),
            json={
                "relative_path": path,
                "content_type": content_type,
                "size_bytes": size,
                "checksum_sha256": checksum,
            },
        )
        assert upload.status_code == 201
        assert upload.json()["relative_path"] == path
        assert upload.json()["upload"]["method"] == "POST"

    revision = api.post(
        f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/revisions",
        headers=headers(),
        json=revision_payload(),
    )
    assert revision.status_code == 201
    assert revision.json()["manifest_checksum_sha256"] == "d" * 64
    assert [item["relative_path"] for item in revision.json()["files"]] == [
        "package-lock.json",
        "src/index.md",
    ]
    source_file = api.get(
        f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/revisions/"
        f"{REVISION_ID}/files/src/index.md",
        headers=headers(),
    )
    assert source_file.status_code == 200
    assert source_file.content == b"# Map\n"
    assert source_file.headers["content-type"] == "text/markdown; charset=utf-8"
    assert source_file.headers["cache-control"] == "private, no-store, max-age=0"
    assert source_file.headers["x-opengeo-source-sha256"] == (
        "17b18d36ebed0aef68729cb969167c56e10eae5d9b31f356203b4a7ffae0b01b"
    )

    staged = api.post(
        f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/revisions/"
        f"{REVISION_ID}/build-jobs",
        headers=headers(),
        json={"purpose": "preview"},
    )
    assert staged.status_code == 201
    assert staged.json()["state"] == "pending"
    assert staged.json()["execution_available"] is False
    assert staged.json()["coordination_status"] == "not_configured"
    assert staged.json()["request"]["networkPolicy"] == "deny_all"
    loaded = api.get(f"/projects/{PROJECT_ID}/observable-build-jobs/{BUILD_ID}", headers=headers())
    assert loaded.json() == staged.json()
    history = api.get(
        f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/build-jobs", headers=headers()
    )
    assert history.status_code == 200
    assert history.json() == [staged.json()]
    assert "output_prefix" not in history.json()[0]
    assert (
        api.get(
            f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/build-jobs?limit=101",
            headers=headers(),
        ).status_code
        == 422
    )
    assert (
        api.get(
            f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/build-jobs?offset=-1",
            headers=headers(),
        ).status_code
        == 422
    )
    assert repository.calls[0][1].organization_id == ORG_ID


def test_source_file_download_route_is_authenticated_exact_and_no_store() -> None:
    repository = MemoryObservableSourceRepository()
    api = client(repository)
    path = (
        f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/revisions/"
        f"{REVISION_ID}/file-download"
    )
    assert api.post(path, json={"relative_path": "src/index.md"}).status_code == 401
    assert (
        api.post(
            path,
            headers=headers(),
            json={"relative_path": "src/index.md", "object_key": "another-object"},
        ).status_code
        == 422
    )
    assert repository.calls == []
    response = api.post(path, headers=headers(), json={"relative_path": "src/index.md"})
    assert response.status_code == 200
    body = response.json()
    file = source_revision().files[1]
    assert body == {
        "url": "https://s3.us-east-1.amazonaws.com/exact-version",
        "method": "GET",
        "expires_at": "2026-08-22T18:00:00Z",
        "relative_path": file.relative_path,
        "content_type": file.content_type,
        "size_bytes": file.size_bytes,
        "checksum_sha256": file.checksum_sha256,
        "bucket": file.bucket,
        "object_key": file.object_key,
        "s3_version_id": file.s3_version_id,
    }
    assert response.headers["cache-control"] == "private, no-store, max-age=0"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert repository.calls == [
        (
            "file_download",
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            SOURCE_PROJECT_ID,
            REVISION_ID,
            "src/index.md",
        )
    ]


@pytest.mark.parametrize("rights_status", ["unreviewed", "rejected"])
def test_source_file_download_presigns_retained_version_without_storage_reads(
    rights_status,
) -> None:
    context = TenantContext(USER_ID, ORG_ID)
    file = replace(
        source_revision().files[1],
        object_key=(
            f"organizations/{ORG_ID}/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/"
            f"uploads/{MARKDOWN_UPLOAD_ID}/files/src/index.md"
        ),
    )
    transactions = []

    async def run(actual_context, operation):
        assert actual_context == context
        transaction = object()
        transactions.append(transaction)
        return await operation(transaction)

    def unexpected_storage_read(*args, **kwargs):
        pytest.fail("Issuing a source-file ticket must not read S3 or its checksum")

    storage = AwsS3DownloadStorage(
        Settings(
            env="test",
            aws_region="us-east-1",
            geodata_bucket="source.opengeo.tools",
            geodata_kms_key_arn=(
                "arn:aws:kms:us-east-1:111111111111:key/11111111-1111-4111-8111-111111111111"
            ),
        ),
        credentials=SimpleNamespace(load=lambda: AwsCredentials("example", "secret", "session")),
        transport=SimpleNamespace(get=unexpected_storage_read),
        now=lambda: NOW,
    )
    repository = PostgresObservableSourceRepository(
        SimpleNamespace(run=run), download_storage=storage
    )
    repository._project_roles = AsyncMock(
        return_value=Roles(organization="member", project="viewer")
    )
    repository._load_revision = AsyncMock(
        return_value=replace(source_revision(), rights_status=rights_status, files=(file,))
    )
    result = asyncio.run(
        repository.request_revision_file_download(
            context, PROJECT_ID, SOURCE_PROJECT_ID, REVISION_ID, file.relative_path
        )
    )
    assert result.file == file
    destination = urlsplit(result.download.url)
    query = parse_qs(destination.query)
    assert destination.hostname == "s3.us-east-1.amazonaws.com"
    assert destination.path == f"/{file.bucket}/{file.object_key}"
    assert query["versionId"] == ["index-v1"]
    assert query["response-content-disposition"] == ['attachment; filename="index.md"']
    assert len(transactions) == 2
    assert repository._project_roles.await_count == repository._load_revision.await_count == 2
    for call, transaction in zip(
        repository._load_revision.await_args_list, transactions, strict=True
    ):
        assert call.args == (transaction, context, PROJECT_ID, SOURCE_PROJECT_ID, REVISION_ID)


@pytest.mark.parametrize(
    "failure",
    [
        "no-grant",
        "revoked",
        "missing-file",
        "foreign-key",
        "unversioned",
        "changed-version",
        "unconfigured-storage",
    ],
)
def test_source_file_download_fails_closed_before_returning_a_ticket(failure) -> None:
    context = TenantContext(USER_ID, ORG_ID)
    file = replace(
        source_revision().files[1],
        object_key=(
            f"organizations/{ORG_ID}/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/"
            f"uploads/{MARKDOWN_UPLOAD_ID}/files/src/index.md"
        ),
    )
    if failure == "foreign-key":
        file = replace(file, object_key=file.object_key.replace(str(ORG_ID), str(USER_ID), 1))
    elif failure == "unversioned":
        file = replace(file, s3_version_id="null")

    async def run(actual_context, operation):
        assert actual_context == context
        return await operation(object())

    storage = SimpleNamespace(
        create_download_url=AsyncMock(
            return_value=DownloadTicket("signed-exact-version", "GET", NOW)
        ),
        read_exact_object=AsyncMock(side_effect=AssertionError("source byte read")),
    )
    repository = PostgresObservableSourceRepository(
        SimpleNamespace(run=run),
        download_storage=None if failure == "unconfigured-storage" else storage,
    )
    readable = Roles(organization="member", project="viewer")
    denied = Roles(organization="member")
    repository._project_roles = AsyncMock(
        side_effect=(
            [denied]
            if failure == "no-grant"
            else [readable, denied]
            if failure == "revoked"
            else [readable, readable]
        )
    )
    revision = replace(source_revision(), files=() if failure == "missing-file" else (file,))
    repository._load_revision = AsyncMock(
        side_effect=[revision, replace(revision, files=(replace(file, s3_version_id="changed"),))]
        if failure == "changed-version"
        else None,
        return_value=revision,
    )
    error_type = (
        ObservableSourceAccessDenied
        if failure in {"no-grant", "revoked"}
        else ObservableSourceNotFound
        if failure == "missing-file"
        else ObservableSourceStoreUnavailable
        if failure == "unconfigured-storage"
        else ObservableSourceConflict
    )
    with pytest.raises(error_type):
        asyncio.run(
            repository.request_revision_file_download(
                context, PROJECT_ID, SOURCE_PROJECT_ID, REVISION_ID, "src/index.md"
            )
        )
    storage.read_exact_object.assert_not_awaited()
    assert storage.create_download_url.await_count == (
        1 if failure in {"revoked", "changed-version"} else 0
    )


@pytest.mark.parametrize("changed", ["account", "project", "source", "revision"])
def test_source_file_download_loads_only_exact_tenant_and_revision_membership(changed) -> None:
    context = TenantContext(USER_ID, ORG_ID)
    project_id, source_id, revision_id = PROJECT_ID, SOURCE_PROJECT_ID, REVISION_ID
    if changed == "account":
        context = TenantContext(USER_ID, SITE_ID)
    elif changed == "project":
        project_id = SITE_ID
    elif changed == "source":
        source_id = SITE_ID
    else:
        revision_id = SITE_ID
    queries = []

    class Transaction:
        async def fetch_one(self, sql, params):
            assert "FROM app.observable_source_revisions" in sql
            assert "organization_id = %s AND project_id = %s" in sql
            assert "source_project_id = %s AND id = %s" in sql
            queries.append(params)
            assert params != (ORG_ID, PROJECT_ID, SOURCE_PROJECT_ID, REVISION_ID)
            return None

        async def fetch_all(self, sql, params):
            pytest.fail("An unavailable revision must not reveal file storage identities")

    async def run(actual_context, operation):
        assert actual_context == context
        return await operation(Transaction())

    storage = SimpleNamespace(create_download_url=AsyncMock(), read_exact_object=AsyncMock())
    repository = PostgresObservableSourceRepository(
        SimpleNamespace(run=run), download_storage=storage
    )
    repository._project_roles = AsyncMock(
        return_value=Roles(organization="member", project="viewer")
    )
    with pytest.raises(ObservableSourceNotFound):
        asyncio.run(
            repository.request_revision_file_download(
                context, project_id, source_id, revision_id, "src/index.md"
            )
        )
    assert queries == [(context.organization_id, project_id, source_id, revision_id)]
    storage.create_download_url.assert_not_awaited()
    storage.read_exact_object.assert_not_awaited()


def test_source_requests_reject_unsafe_paths_ambiguous_manifests_and_unknown_fields() -> None:
    api = client(MemoryObservableSourceRepository())
    upload_url = f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/file-uploads"
    for path in ["../index.md", "node_modules/pkg/index.js", "credentials.json"]:
        response = api.post(
            upload_url,
            headers=headers(),
            json={
                "relative_path": path,
                "content_type": "text/markdown",
                "size_bytes": 12,
                "checksum_sha256": "a" * 64,
            },
        )
        assert response.status_code == 422
    wrong_media = api.post(
        upload_url,
        headers=headers(),
        json={
            "relative_path": "src/index.md",
            "content_type": "text/javascript",
            "size_bytes": 12,
            "checksum_sha256": "a" * 64,
        },
    )
    assert wrong_media.status_code == 422

    payload = revision_payload()
    payload["files"].reverse()
    assert (
        api.post(
            f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/revisions",
            headers=headers(),
            json=payload,
        ).status_code
        == 422
    )
    payload = revision_payload()
    payload["entry_path"] = "src/missing.md"
    assert (
        api.post(
            f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/revisions",
            headers=headers(),
            json=payload,
        ).status_code
        == 422
    )


def test_configured_build_dispatch_is_identity_only_and_retryable_by_job_id() -> None:
    repository = MemoryObservableSourceRepository()
    dispatcher = FakeBuildDispatcher()
    api = client(repository, dispatcher=dispatcher)
    staged = api.post(
        f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/revisions/"
        f"{REVISION_ID}/build-jobs",
        headers=headers(),
        json={"purpose": "preview"},
    )
    assert staged.status_code == 201
    assert staged.json()["execution_available"] is True
    assert staged.json()["coordination_status"] == "dispatched"
    assert dispatcher.jobs == [BUILD_ID]

    loaded = api.get(f"/projects/{PROJECT_ID}/observable-build-jobs/{BUILD_ID}", headers=headers())
    assert loaded.json()["coordination_status"] == "configured"
    retried = api.post(
        f"/projects/{PROJECT_ID}/observable-build-jobs/{BUILD_ID}/dispatch",
        headers=headers(),
    )
    assert retried.status_code == 202
    assert retried.json()["coordination_status"] == "dispatched"
    assert dispatcher.jobs == [BUILD_ID, BUILD_ID]


@pytest.mark.parametrize("state", ["pending", "running", "succeeded", "failed", "cancelled"])
def test_replayed_build_request_never_redispatches_running_or_terminal_work(state: str) -> None:
    repository = MemoryObservableSourceRepository()
    repository.job = replace(succeeded_build_job(), state=state)
    dispatcher = FakeBuildDispatcher()
    api = client(repository, dispatcher=dispatcher)
    url = (
        f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/revisions/"
        f"{REVISION_ID}/build-jobs"
    )
    response = api.post(
        url, headers=headers(), json={"purpose": "preview", "idempotency_key": str(BUILD_ID)}
    )
    assert response.status_code == 201
    assert response.json()["id"] == str(BUILD_ID)
    assert response.json()["state"] == state
    assert dispatcher.jobs == ([BUILD_ID] if state == "pending" else [])
    assert api.post(url, headers=headers(), json={"idempotency_key": "invalid"}).status_code == 422


def test_failed_dispatch_preserves_the_durable_job_and_unavailable_retry_fails_first() -> None:
    repository = MemoryObservableSourceRepository()
    dispatcher = FakeBuildDispatcher(fail=True)
    api = client(repository, dispatcher=dispatcher)
    staged = api.post(
        f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/revisions/"
        f"{REVISION_ID}/build-jobs",
        headers=headers(),
        json={"purpose": "preview"},
    )
    assert staged.status_code == 201
    assert staged.json()["id"] == str(BUILD_ID)
    assert staged.json()["coordination_status"] == "dispatch_failed"
    assert repository.job is not None
    retried = api.post(
        f"/projects/{PROJECT_ID}/observable-build-jobs/{BUILD_ID}/dispatch",
        headers=headers(),
    )
    assert retried.status_code == 503
    assert retried.json() == {"detail": "observable_build_dispatch_unavailable"}

    unavailable = client(repository)
    before = len(repository.calls)
    rejected = unavailable.post(
        f"/projects/{PROJECT_ID}/observable-build-jobs/{BUILD_ID}/dispatch",
        headers=headers(),
    )
    assert rejected.status_code == 503
    assert len(repository.calls) == before


def test_unreviewed_release_candidate_fails_closed_without_changing_preview_job() -> None:
    repository = MemoryObservableSourceRepository()
    api = client(repository)
    response = api.post(
        f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/revisions/"
        f"{REVISION_ID}/build-jobs",
        headers=headers(),
        json={"purpose": "release_candidate"},
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "observable_source_rights_unapproved"
    assert repository.job is None


def test_openapi_exposes_source_revision_and_nonpublishing_build_boundaries() -> None:
    document = client(MemoryObservableSourceRepository()).get("/openapi.json").json()
    assert "/projects/{project_id}/sites/{site_id}/source-project" in document["paths"]
    assert (
        "/projects/{project_id}/source-projects/{source_project_id}/revisions/"
        "{source_revision_id}/build-jobs"
    ) in document["paths"]
    schema = document["components"]["schemas"]["ObservableBuildJobResponse"]
    assert "execution_available" in schema["properties"]


@pytest.mark.parametrize("body", [None, {}, {"runtime_profile": "local_only"}])
def test_private_preview_uses_one_time_fragment_exchange_and_path_scoped_cookies(body) -> None:
    repository = MemoryObservableSourceRepository()
    repository.job = succeeded_build_job()
    signer = FakePreviewCookieSigner()
    api = client(repository, preview=True, signer=signer)
    endpoint = f"/projects/{PROJECT_ID}/observable-build-jobs/{BUILD_ID}/preview-capabilities"
    assert api.post(endpoint).status_code == 401
    created = api.post(endpoint, headers=headers(), **({"json": body} if body is not None else {}))
    assert created.status_code == 201
    assert created.headers["cache-control"] == "no-store, max-age=0"
    assert created.headers["referrer-policy"] == "no-referrer"
    assert created.json()["authorize_url"] == (
        "https://preview.studio.opengeo.tools/authorize/#cap=" + repository.preview_capability
    )
    capability = repository.preview_capability
    assert "runtimeProfile" not in json.loads(base64.urlsafe_b64decode(capability + "=="))
    assert created.json()["publication_authorized"] is False
    denied = api.post(
        "/observable-preview/exchange",
        json={"capability": capability},
    )
    assert denied.status_code == 403
    assert not any(call[0] == "preview_exchange" for call in repository.calls)
    exchanged = api.post(
        "/observable-preview/exchange",
        headers={
            "Origin": "https://preview.studio.opengeo.tools",
            "Sec-Fetch-Site": "same-origin",
        },
        json={"capability": capability},
    )
    assert exchanged.status_code == 200
    entry_path = (
        f"/organizations/{ORG_ID}/projects/{PROJECT_ID}/source-projects/"
        f"{SOURCE_PROJECT_ID}/builds/{BUILD_ID}/output/index.html"
    )
    assert exchanged.json()["entry_path"] == entry_path
    assert exchanged.json()["publication_authorized"] is False
    assert exchanged.headers["cache-control"] == "no-store, max-age=0"
    assert exchanged.headers["content-security-policy"] == (
        "default-src 'none'; frame-ancestors 'none'"
    )
    assert signer.calls[0][0] == (
        "https://preview.studio.opengeo.tools" + entry_path.removesuffix("index.html") + "*"
    )
    set_cookies = exchanged.headers.get_list("set-cookie")
    assert len(set_cookies) == 3
    for cookie in set_cookies:
        assert "Secure" in cookie
        assert "HttpOnly" in cookie
        assert "SameSite=strict" in cookie
        assert f"Path={entry_path.removesuffix('index.html')}" in cookie
        assert "Domain=" not in cookie
    replay = api.post(
        "/observable-preview/exchange",
        headers={
            "Origin": "https://preview.studio.opengeo.tools",
            "Sec-Fetch-Site": "same-origin",
        },
        json={"capability": capability},
    )
    assert replay.status_code == 404
    assert replay.json()["detail"] == "observable_preview_capability_invalid"


def test_loopback_preview_retains_one_time_authority_and_private_cookie_scope() -> None:
    repository = MemoryObservableSourceRepository()
    repository.job = succeeded_build_job()
    origin = "http://127.0.0.1:8766"
    api = client(repository, preview=True, preview_origin=origin, signer=FakePreviewCookieSigner())
    endpoint = f"/projects/{PROJECT_ID}/observable-build-jobs/{BUILD_ID}/preview-capabilities"
    created = api.post(endpoint, headers=headers())
    assert created.status_code == 201
    assert created.json()["authorize_url"].startswith(origin + "/authorize/#cap=")
    payload = {"capability": repository.preview_capability}
    denied = api.post(
        "/observable-preview/exchange", json=payload,
        headers={"Origin": "http://127.0.0.1:8767", "Sec-Fetch-Site": "same-origin"},
    )
    assert denied.status_code == 403 and not denied.headers.get_list("set-cookie")
    exchange_headers = {"Origin": origin, "Sec-Fetch-Site": "same-origin"}
    exchanged = api.post("/observable-preview/exchange", json=payload, headers=exchange_headers)
    assert exchanged.status_code == 200
    for cookie in exchanged.headers.get_list("set-cookie"):
        assert "Secure" not in cookie and "HttpOnly" in cookie and "SameSite=strict" in cookie
        assert f"Path=/organizations/{ORG_ID}/projects/{PROJECT_ID}/source-projects/" in cookie
        assert "Domain=" not in cookie
    replay = api.post("/observable-preview/exchange", json=payload, headers=exchange_headers)
    assert replay.status_code == 404


def test_public_maps_preview_binds_exchange_and_cookies_to_selected_origin() -> None:
    repository = MemoryObservableSourceRepository()
    repository.job = succeeded_build_job()
    signer = FakePreviewCookieSigner()
    api = client(repository, preview=True, public_maps_preview=True, signer=signer)
    endpoint = f"/projects/{PROJECT_ID}/observable-build-jobs/{BUILD_ID}/preview-capabilities"
    created = api.post(endpoint, headers=headers(), json={"runtime_profile": "public_maps_v1"})
    assert created.status_code == 201
    assert created.json()["authorize_url"].startswith(
        "https://maps-preview.studio.opengeo.tools/authorize/#cap="
    )
    capability = repository.preview_capability
    assert preview_capability_runtime_profile(capability) == "public_maps_v1"
    for origin, fetch_site in [
        ("https://preview.studio.opengeo.tools", "same-origin"),
        ("https://studio.opengeo.tools", "same-origin"),
        ("https://maps-preview.studio.opengeo.tools", "same-site"),
    ]:
        denied = api.post(
            "/observable-preview/exchange",
            headers={"Origin": origin, "Sec-Fetch-Site": fetch_site},
            json={"capability": capability},
        )
        assert denied.status_code == 403
        assert not denied.headers.get_list("set-cookie")
    assert not any(call[0] == "preview_exchange" for call in repository.calls)
    exchanged = api.post(
        "/observable-preview/exchange",
        headers={
            "Origin": "https://maps-preview.studio.opengeo.tools",
            "Sec-Fetch-Site": "same-origin",
        },
        json={"capability": capability},
    )
    assert exchanged.status_code == 200
    prefix = (
        f"/organizations/{ORG_ID}/projects/{PROJECT_ID}/source-projects/"
        f"{SOURCE_PROJECT_ID}/builds/{BUILD_ID}/output/"
    )
    assert signer.calls[0][0] == f"https://maps-preview.studio.opengeo.tools{prefix}*"
    assert exchanged.json()["entry_path"] == prefix + "index.html"
    assert exchanged.json()["publication_authorized"] is False
    for cookie in exchanged.headers.get_list("set-cookie"):
        assert f"Path={prefix}" in cookie
        assert "Secure" in cookie and "HttpOnly" in cookie and "SameSite=strict" in cookie
        assert "Domain=" not in cookie

    # A legacy capability cannot borrow the enabled map origin either.
    created = api.post(endpoint, headers=headers())
    assert created.status_code == 201
    exchange_count = sum(call[0] == "preview_exchange" for call in repository.calls)
    denied = api.post(
        "/observable-preview/exchange",
        headers={
            "Origin": "https://maps-preview.studio.opengeo.tools",
            "Sec-Fetch-Site": "same-origin",
        },
        json={"capability": repository.preview_capability},
    )
    assert denied.status_code == 403
    assert sum(call[0] == "preview_exchange" for call in repository.calls) == exchange_count


def test_public_maps_preview_is_disabled_until_configured_and_request_profile_is_strict() -> None:
    repository = MemoryObservableSourceRepository()
    repository.job = succeeded_build_job()
    api = client(repository, preview=True, signer=FakePreviewCookieSigner())
    endpoint = f"/projects/{PROJECT_ID}/observable-build-jobs/{BUILD_ID}/preview-capabilities"
    denied = api.post(endpoint, headers=headers(), json={"runtime_profile": "public_maps_v1"})
    assert denied.status_code == 503
    for body in [
        {"runtime_profile": "all_network"},
        {"runtime_profile": None},
        {"runtime_profile": 1},
        {"runtime_profile": "public_maps_v1", "origin": "https://unreviewed.test"},
    ]:
        assert api.post(endpoint, headers=headers(), json=body).status_code == 422
    capability = _encode_preview_capability(
        BUILD_ID, TenantContext(USER_ID, ORG_ID), "public_maps_v1"
    )
    denied = api.post(
        "/observable-preview/exchange",
        headers={
            "Origin": "https://maps-preview.studio.opengeo.tools",
            "Sec-Fetch-Site": "same-origin",
        },
        json={"capability": capability},
    )
    assert denied.status_code == 503
    assert not repository.calls


@pytest.mark.parametrize(
    ("profile", "role", "rights", "error"),
    [
        ("local_only", "viewer", "unreviewed", None),
        ("public_maps_v1", "viewer", "approved", ObservableSourceAccessDenied),
        ("public_maps_v1", "editor", "unreviewed", ObservableSourceConflict),
        ("public_maps_v1", "owner", "rejected", ObservableSourceConflict),
        ("public_maps_v1", "owner", None, ObservableSourceConflict),
        ("public_maps_v1", "editor", "approved", None),
    ],
)
def test_preview_profile_creation_checks_authority_and_exact_immutable_revision(
    profile, role, rights, error
) -> None:
    calls = []

    async def fetch_one(sql, parameters):
        calls.append((sql, parameters))
        if "manifest->>'schemaVersion'" in sql:
            assert parameters == (ORG_ID, PROJECT_ID, SOURCE_PROJECT_ID, REVISION_ID)
            return ("opengeo.observable-source-revision.1.0.0",)
        if "FROM app.observable_source_revisions" in sql:
            assert parameters == (ORG_ID, PROJECT_ID, SOURCE_PROJECT_ID, REVISION_ID)
            return (rights,) if rights is not None else None
        assert "INSERT INTO app.observable_preview_capabilities" in sql
        assert "interval '60 seconds'" in sql
        return (NOW + timedelta(seconds=60),)

    transaction = SimpleNamespace(fetch_one=fetch_one)

    async def run(context, operation):
        assert context == TenantContext(USER_ID, ORG_ID)
        return await operation(transaction)

    repository = PostgresObservableSourceRepository(executor=SimpleNamespace(run=run))
    repository._project_roles = AsyncMock(return_value=Roles(organization="member", project=role))
    repository._load_build_job = AsyncMock(return_value=succeeded_build_job())
    repository._record_event = AsyncMock()
    operation = repository.create_preview_capability(
        TenantContext(USER_ID, ORG_ID), PROJECT_ID, BUILD_ID, "preview-profile", profile
    )
    if error is not None:
        with pytest.raises(error) as caught:
            asyncio.run(operation)
        if error is ObservableSourceConflict:
            assert caught.value.code == "observable_source_rights_unapproved"
        assert not any("INSERT INTO" in sql for sql, _ in calls)
        if role == "viewer":
            assert not calls
        repository._record_event.assert_not_awaited()
        return
    result = asyncio.run(operation)
    assert preview_capability_runtime_profile(result.capability) == profile
    assert calls[-1][1][-1] == hashlib.sha256(result.capability.encode("ascii")).hexdigest()
    if profile == "local_only":
        assert len(calls) == 2  # Schema admission does not acquire a public-rights gate.


@pytest.mark.parametrize("profile", ["local_only", "public_maps_v1"])
def test_preview_profile_checksum_rejects_profile_tampering_and_rechecks_manager(profile) -> None:
    capability = _encode_preview_capability(BUILD_ID, TenantContext(USER_ID, ORG_ID), profile)
    checksum = hashlib.sha256(capability.encode("ascii")).hexdigest()
    prefix = (
        f"organizations/{ORG_ID}/projects/{PROJECT_ID}/source-projects/"
        f"{SOURCE_PROJECT_ID}/builds/{BUILD_ID}/output/"
    )

    async def fetch_one(sql, parameters):
        if "manifest->>'schemaVersion'" in sql:
            assert parameters == (ORG_ID, PROJECT_ID, SOURCE_PROJECT_ID, REVISION_ID)
            return ("opengeo.observable-source-revision.1.0.0",)
        assert "app.consume_observable_preview_capability" in sql
        assert parameters[:3] == (BUILD_ID, ORG_ID, USER_ID)
        if parameters[3] != checksum:
            return None
        return (
            prefix,
            "dist/index.html",
            NOW + timedelta(minutes=15),
            PROJECT_ID,
            SOURCE_PROJECT_ID,
            REVISION_ID,
            {"schemaVersion": "v1"},
        )

    async def run(context, operation):
        assert context == TenantContext(USER_ID, ORG_ID)
        return await operation(SimpleNamespace(fetch_one=fetch_one))

    repository = PostgresObservableSourceRepository(executor=SimpleNamespace(run=run))
    repository._project_roles = AsyncMock(
        return_value=Roles(organization="member", project="viewer")
    )
    payload = json.loads(base64.urlsafe_b64decode(capability + "=="))
    if profile == "local_only":
        payload["runtimeProfile"] = "public_maps_v1"
    else:
        del payload["runtimeProfile"]
    tampered = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    with pytest.raises(ObservablePreviewCapabilityInvalid):
        asyncio.run(repository.exchange_preview_capability(tampered))
    repository._project_roles.assert_not_awaited()
    if profile == "public_maps_v1":
        with pytest.raises(ObservableSourceAccessDenied):
            asyncio.run(repository.exchange_preview_capability(capability))
        repository._project_roles.assert_awaited_once()
        repository._project_roles.return_value = Roles(organization="member", project="editor")
    grant = asyncio.run(repository.exchange_preview_capability(capability))
    assert grant.runtime_profile == profile
    assert grant.output_prefix == prefix
    if profile == "local_only":
        repository._project_roles.assert_not_awaited()


@pytest.mark.parametrize(
    "change",
    [
        {"runtimeProfile": "local_only"},
        {"runtimeProfile": "public_maps_v2"},
        {"runtimeProfile": None},
        {"runtimeProfile": ["public_maps_v1"]},
        {"userId": 12},
        {"unreviewedOrigin": "https://unreviewed.test"},
    ],
)
def test_preview_capability_parser_rejects_unrecognized_shapes_and_profiles(change) -> None:
    capability = _encode_preview_capability(BUILD_ID, TenantContext(USER_ID, ORG_ID))
    payload = json.loads(base64.urlsafe_b64decode(capability + "=="))
    payload.update(change)
    invalid = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    with pytest.raises(ObservablePreviewCapabilityInvalid):
        preview_capability_runtime_profile(invalid)


def test_build_response_redacts_every_storage_coordinate_from_success_evidence() -> None:
    repository = MemoryObservableSourceRepository()
    repository.job = succeeded_build_job()
    response = client(repository).get(
        f"/projects/{PROJECT_ID}/observable-build-jobs/{BUILD_ID}",
        headers=headers(),
    )
    assert response.status_code == 200
    payload = response.json()
    assert "output_prefix" not in payload
    assert payload["result"]["schemaVersion"] == ("opengeo.observable-build-client-result.1.0.0")
    assert payload["result"]["publicationAuthorized"] is False
    serialized = response.text
    for forbidden in ["source.opengeo.tools", "objectKey", "s3VersionId", "etag", "outputPrefix"]:
        assert forbidden not in serialized


def test_publication_workspaces_require_login_and_return_bounded_no_store_index() -> None:
    repository = MemoryObservableSourceRepository()
    api = client(repository)
    assert api.get("/publication-workspaces").status_code == 401
    response = api.get("/publication-workspaces?limit=10&offset=20", headers=headers())
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()[0]["published_revision"] == 1
    assert response.json()[0]["current_revision"] == 2
    assert repository.calls[-1] == (
        "publication-workspaces",
        TenantContext(USER_ID, ORG_ID),
        10,
        20,
    )
    assert api.get("/publication-workspaces?limit=101", headers=headers()).status_code == 422
    assert api.get("/publication-workspaces?offset=-1", headers=headers()).status_code == 422


def test_publication_index_is_one_scoped_read_without_object_or_worker_access() -> None:
    calls = []

    async def fetch_all(sql, parameters):
        calls.append((sql, parameters))
        return []

    async def run(context, operation):
        assert context == TenantContext(USER_ID, ORG_ID)
        return await operation(SimpleNamespace(fetch_all=fetch_all))

    repository = PostgresObservableSourceRepository(executor=SimpleNamespace(run=run))
    assert asyncio.run(repository.publication_workspaces(TenantContext(USER_ID, ORG_ID))) == []
    assert len(calls) == 1
    sql, parameters = calls[0]
    assert parameters == (ORG_ID, USER_ID, ORG_ID, ORG_ID, ORG_ID, 100, 0)
    assert "app.effective_project_role(project.id) IS NOT NULL" in sql
    assert "job.stage='deployed'" in sql
    assert "member.role='admin'" in sql
    for statement in ("INSERT ", "UPDATE ", "DELETE "):
        assert statement not in sql
    with pytest.raises(ObservableSourceConflict):
        asyncio.run(repository.publication_workspaces(TenantContext(USER_ID, ORG_ID), limit=101))


def test_revisions_page_route_preserves_shape_and_current_authority():
    repository = MemoryObservableSourceRepository()
    repository.revisions = [source_revision()]
    url = f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/revisions/page"
    response = client(repository).get(url + "?limit=2&before_revision=4", headers=headers())
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["X-OpenGeo-Source-File-Reuse"] == "parent-revision-v1"
    assert response.json()[0]["id"] == str(REVISION_ID)
    call = repository.calls[-1]
    assert call[0] == "revisions-page" and call[1].organization_id == ORG_ID
    assert call[2:] == (PROJECT_ID, SOURCE_PROJECT_ID, 2, 4)
    assert client(repository).get(url).status_code == 401


@pytest.mark.parametrize(
    "query", ["limit=0", "limit=26", "before_revision=0", "before_revision=-1"]
)
def test_revisions_page_route_rejects_invalid_query(query):
    repository = MemoryObservableSourceRepository()
    response = client(repository).get(
        f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/revisions/page?{query}",
        headers=headers(),
    )
    assert response.status_code == 422
    assert repository.calls == []
