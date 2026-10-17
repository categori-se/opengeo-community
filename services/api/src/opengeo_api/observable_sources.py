import base64
import hashlib
import json
import re
import secrets
from asyncio import gather
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, Protocol, TypeVar, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.auth_models import OrganizationRole
from opengeo_api.authorization import Action, AuthorizationDenied, ProjectRole, Roles, authorize
from opengeo_api.github_publications import GitHubConnection, GitHubSourceReceipt
from opengeo_api.s3_downloads import (
    DownloadSpec,
    DownloadStorage,
    DownloadStorageUnavailable,
    DownloadTicket,
    ExactObjectSpec,
    UnavailableDownloadStorage,
)
from opengeo_api.s3_uploads import (
    StoredObject,
    UnavailableUploadStorage,
    UploadForm,
    UploadSpec,
    UploadStorage,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)

ObservableRightsStatus = Literal["unreviewed", "approved", "rejected"]
ObservableBuildPurpose = Literal["preview", "release_candidate"]
ObservableBuildState = Literal["pending", "running", "succeeded", "failed", "cancelled"]
ObservablePreviewRuntimeProfile = Literal["local_only", "public_maps_v1"]
ObservableOperationResult = TypeVar("ObservableOperationResult")

OBSERVABLE_FRAMEWORK_VERSION = "1.13.4"
OBSERVABLE_LOCKFILE_FORMAT = "npm-package-lock-v3"
OBSERVABLE_NETWORK_POLICY = "deny_all"
OBSERVABLE_SOURCE_MANIFEST_SCHEMA = "opengeo.observable-source-revision.1.0.0"
OBSERVABLE_SOURCE_DATA_MANIFEST_SCHEMA = "opengeo.observable-source-revision.2.0.0"
OBSERVABLE_SOURCE_REFERENCED_MANIFEST_SCHEMA = "opengeo.observable-source-revision.3.0.0"
OBSERVABLE_MAX_ATTACHMENT_BYTES = 67_108_864
OBSERVABLE_BUILD_REQUEST_SCHEMA = "opengeo.observable-build-request.1.0.0"
OBSERVABLE_BUILD_LIMITS: dict[str, int] = {
    "cpuMillis": 1_000,
    "memoryMiB": 2_048,
    "timeoutSeconds": 120,
    "maxInputFiles": 128,
    "maxInputBytes": 16_777_216,
    "maxOutputFiles": 512,
    "maxOutputBytes": 33_554_432,
}
_SOURCE_PATH = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,7}$"
)
_OUTPUT_PATH = re.compile(
    r"^dist/[A-Za-z0-9_@][A-Za-z0-9._@-]{0,99}"
    r"(?:/[A-Za-z0-9_@][A-Za-z0-9._@-]{0,99}){0,7}$"
)
_OUTPUT_PREFIX = re.compile(
    r"^organizations/([0-9a-f-]{36})/projects/([0-9a-f-]{36})/"
    r"source-projects/([0-9a-f-]{36})/builds/([0-9a-f-]{36})/output/$"
)
_CAPABILITY_TOKEN = re.compile(r"^[A-Za-z0-9_-]{128,512}$")
_CAPABILITY_SECRET = re.compile(r"^[A-Za-z0-9_-]{43}$")
_FORBIDDEN_DIRECTORY = re.compile(
    r"(^|/)(?:node_modules|dist|build|cache|\.git|\.aws|\.ssh)(?:/|$)", re.IGNORECASE
)
_SECRET_FILE = re.compile(
    r"(^|/)(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|"
    r"tokens?(?:\..*)?|id_rsa|[^/]+\.(?:pem|key|p12|pfx))$",
    re.IGNORECASE,
)
_SOURCE_MEDIA: tuple[tuple[re.Pattern[str], frozenset[str]], ...] = (
    (
        re.compile(r"\.ipynb$", re.IGNORECASE),
        frozenset({"application/x-ipynb+json", "application/json"}),
    ),
    (re.compile(r"\.md$", re.IGNORECASE), frozenset({"text/markdown"})),
    (re.compile(r"\.(?:js|mjs)$", re.IGNORECASE), frozenset({"text/javascript"})),
    (re.compile(r"\.css$", re.IGNORECASE), frozenset({"text/css"})),
    (
        re.compile(r"\.geojson$", re.IGNORECASE),
        frozenset({"application/json", "application/geo+json"}),
    ),
    (
        re.compile(r"\.json$", re.IGNORECASE),
        frozenset({"application/json"}),
    ),
    (re.compile(r"\.csv$", re.IGNORECASE), frozenset({"text/csv"})),
    (re.compile(r"\.txt$", re.IGNORECASE), frozenset({"text/plain"})),
    (re.compile(r"\.html$", re.IGNORECASE), frozenset({"text/html"})),
    (re.compile(r"\.svg$", re.IGNORECASE), frozenset({"image/svg+xml"})),
    (re.compile(r"\.png$", re.IGNORECASE), frozenset({"image/png"})),
    (re.compile(r"\.(?:jpg|jpeg)$", re.IGNORECASE), frozenset({"image/jpeg"})),
)


class ObservableSourceStoreUnavailable(RuntimeError):
    pass


class ObservableSourceAccessDenied(RuntimeError):
    pass


class ObservableSourceNotFound(RuntimeError):
    def __init__(self, resource: str) -> None:
        self.resource = resource
        super().__init__(resource)


class ObservableSourceConflict(RuntimeError):
    def __init__(self, code: str, *, current_revision: int | None = None) -> None:
        self.code = code
        self.current_revision = current_revision
        super().__init__(code)


class ObservablePreviewCapabilityInvalid(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ObservableSourceProject:
    source_project_id: UUID
    project_id: UUID
    site_id: UUID
    route_namespace: str
    title: str
    rights_status: ObservableRightsStatus
    owner_user_id: UUID
    current_revision_id: UUID | None
    current_revision_number: int
    compiler_image_digest: str
    framework_version: str
    lockfile_format: str
    network_policy: str
    resource_limits: dict[str, int]
    created_by: UUID
    created_at: datetime
    updated_by: UUID
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class ObservableSourceFileUploadDraft:
    relative_path: str
    content_type: str
    size_bytes: int
    checksum_sha256: str


@dataclass(frozen=True, slots=True)
class ObservableSourceFileUploadTicket:
    upload_id: UUID
    source_project_id: UUID
    relative_path: str
    content_type: str
    size_bytes: int
    checksum_sha256: str
    upload: UploadForm


@dataclass(frozen=True, slots=True)
class ObservableRevisionUpload:
    upload_id: UUID | None
    relative_path: str
    source_object_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class ObservableRevisionAttachment:
    attachment_id: UUID
    relative_path: str


@dataclass(frozen=True, slots=True)
class ObservableRevisionReferencedFile:
    reference_id: UUID
    relative_path: str


@dataclass(frozen=True, slots=True)
class ObservableSourceRevisionDraft:
    expected_revision: int
    title: str
    rights_status: ObservableRightsStatus
    entry_path: str
    lockfile_path: str | None
    change_summary: str
    files: tuple[ObservableRevisionUpload, ...]
    data_attachments: tuple[ObservableRevisionAttachment, ...] = ()
    referenced_files: tuple[ObservableRevisionReferencedFile, ...] = ()


@dataclass(frozen=True, slots=True)
class ObservableSourceRevisionFile:
    relative_path: str
    source_object_id: UUID
    bucket: str
    object_key: str
    s3_version_id: str
    etag: str
    content_type: str
    size_bytes: int
    checksum_sha256: str


@dataclass(frozen=True, slots=True)
class ObservableSourceRevision:
    revision_id: UUID
    source_project_id: UUID
    revision_number: int
    parent_revision_id: UUID | None
    title: str
    rights_status: ObservableRightsStatus
    entry_path: str
    lockfile_path: str | None
    manifest: dict[str, Any]
    manifest_checksum_sha256: str
    change_summary: str
    created_by: UUID
    created_at: datetime
    files: tuple[ObservableSourceRevisionFile, ...]


@dataclass(frozen=True, slots=True)
class ObservableSourceFileContent:
    relative_path: str
    content_type: str
    size_bytes: int
    checksum_sha256: str
    body: bytes


@dataclass(frozen=True, slots=True)
class ObservableSourceFileDownloadTicket:
    file: ObservableSourceRevisionFile
    download: DownloadTicket


@dataclass(frozen=True, slots=True)
class ObservableDataAttachment:
    id: UUID
    source_project_id: UUID
    dataset_id: UUID
    dataset_version_id: UUID
    data_object_id: UUID
    s3_version_id: str
    checksum_sha256: str
    size_bytes: int
    content_type: str
    created_by: UUID
    created_at: datetime
    available: bool


@dataclass(frozen=True, slots=True)
class ObservablePublicFileReference:
    id: UUID
    source_project_id: UUID
    dataset_id: UUID
    source_version: int
    resource_id: UUID
    resource_version_id: UUID
    resource_version_number: int
    distribution_id: str
    url: str
    content_type: str
    size_bytes: int
    checksum_sha256: str
    created_by: UUID
    created_at: datetime
    available: bool


@dataclass(frozen=True, slots=True)
class ObservableBuildJob:
    build_job_id: UUID
    source_project_id: UUID
    source_revision_id: UUID
    source_revision_number: int
    purpose: ObservableBuildPurpose
    state: ObservableBuildState
    request: dict[str, Any]
    request_checksum_sha256: str
    output_prefix: str
    result: dict[str, Any] | None
    result_checksum_sha256: str | None
    attempt_count: int
    error_code: str | None
    created_by: UUID
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class ObservablePreviewCapability:
    capability: str
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class ObservablePreviewGrant:
    output_prefix: str
    entry_file: str
    expires_at: datetime
    runtime_profile: ObservablePreviewRuntimeProfile = "local_only"


@dataclass(frozen=True, slots=True)
class _ParsedPreviewCapability:
    capability_id: UUID
    organization_id: UUID
    user_id: UUID
    runtime_profile: ObservablePreviewRuntimeProfile = "local_only"


@dataclass(frozen=True, slots=True)
class _UploadIntent:
    upload_id: UUID
    relative_path: str
    content_type: str
    size_bytes: int
    checksum_sha256: str
    bucket: str
    object_key: str
    expires_at: datetime


class ObservableSourceRepository(Protocol):
    async def resolve_artifact_lease(
        self, context: TenantContext, job_id: UUID, token: UUID
    ) -> list[dict[str, Any]]: ...

    async def prepare_artifact_inputs(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        revision_id: UUID,
        expected_reference_revision: int,
    ) -> dict[str, Any]: ...

    async def read_artifact_inputs(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        input_id: UUID,
    ) -> dict[str, Any]: ...

    async def artifact_references(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        references: list[dict[str, Any]] | None = None,
        expected_revision: int | None = None,
    ) -> dict[str, Any]: ...

    async def reserve_publication_destination(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        reservation_id: UUID,
        origin_id: UUID,
        slug: str,
        acknowledgment: str,
    ) -> None: ...

    async def publication_workspaces(
        self, context: TenantContext, limit: int = 100, offset: int = 0
    ) -> list[dict[str, Any]]: ...

    async def github_dispatches(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        limit: int = 25,
        offset: int = 0,
    ) -> list[dict[str, Any]]: ...

    async def publication_status(
        self, context: TenantContext, project_id: UUID, source_project_id: UUID
    ) -> dict[str, Any]: ...

    async def review_publication(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        build_job_id: UUID,
        mount_id: UUID,
        checksum: str,
        review_id: UUID,
        distribution_approval_id: UUID | None = None,
    ) -> None: ...

    async def approve_publication(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        review_id: UUID,
    ) -> None: ...

    async def github_status(
        self, context: TenantContext, project_id: UUID, source_project_id: UUID
    ) -> dict[str, Any]: ...

    async def request_github_sync(
        self, context: TenantContext, project_id: UUID, source_project_id: UUID, revision_id: UUID
    ) -> bool: ...

    async def connect_github(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        connection_id: UUID,
    ) -> dict[str, Any]: ...

    async def list_data_attachments(
        self, context: TenantContext, project_id: UUID, source_project_id: UUID
    ) -> tuple[ObservableDataAttachment, ...]: ...

    async def register_data_attachment(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        dataset_id: UUID,
        dataset_version_id: UUID,
        data_object_id: UUID,
        request_id: str,
    ) -> ObservableDataAttachment: ...

    async def list_public_file_references(
        self, context: TenantContext, project_id: UUID, source_project_id: UUID
    ) -> tuple[ObservablePublicFileReference, ...]: ...

    async def register_public_file_reference(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        dataset_id: UUID,
        source_version: int,
        resource_id: UUID,
        resource_version_id: UUID,
        distribution_id: str,
        request_id: str,
    ) -> ObservablePublicFileReference: ...

    async def list_projects(
        self, context: TenantContext, project_id: UUID
    ) -> tuple[ObservableSourceProject, ...]: ...

    async def create_project(
        self,
        context: TenantContext,
        project_id: UUID,
        site_id: UUID,
        title: str,
        request_id: str,
    ) -> ObservableSourceProject: ...

    async def get_project(
        self, context: TenantContext, project_id: UUID, source_project_id: UUID
    ) -> ObservableSourceProject: ...

    async def request_file_upload(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        draft: ObservableSourceFileUploadDraft,
        request_id: str,
    ) -> ObservableSourceFileUploadTicket: ...

    async def create_revision(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        draft: ObservableSourceRevisionDraft,
        request_id: str,
    ) -> ObservableSourceRevision: ...

    async def list_revisions(
        self, context: TenantContext, project_id: UUID, source_project_id: UUID
    ) -> tuple[ObservableSourceRevision, ...]: ...

    async def list_revisions_page(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        limit: int = 25,
        before_revision: int | None = None,
    ) -> tuple[ObservableSourceRevision, ...]: ...

    async def read_revision_file(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        revision_id: UUID,
        relative_path: str,
    ) -> ObservableSourceFileContent: ...

    async def request_revision_file_download(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        revision_id: UUID,
        relative_path: str,
    ) -> ObservableSourceFileDownloadTicket: ...

    async def create_build_job(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        source_revision_id: UUID,
        purpose: ObservableBuildPurpose,
        request_id: str,
        idempotency_key: UUID | None = None,
        artifact_input_id: UUID | None = None,
        output_profile: str = "default-32m",
        size_acknowledgment: str | None = None,
        distribution_approval_id: UUID | None = None,
        output_representation: Literal["single-html"] | None = None,
    ) -> ObservableBuildJob: ...

    async def get_build_job(
        self, context: TenantContext, project_id: UUID, build_job_id: UUID
    ) -> ObservableBuildJob: ...

    async def list_build_jobs(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        limit: int = 25,
        offset: int = 0,
    ) -> tuple[ObservableBuildJob, ...]: ...

    async def authorize_build_dispatch(
        self, context: TenantContext, project_id: UUID, build_job_id: UUID
    ) -> ObservableBuildJob: ...

    async def create_preview_capability(
        self,
        context: TenantContext,
        project_id: UUID,
        build_job_id: UUID,
        request_id: str,
        runtime_profile: ObservablePreviewRuntimeProfile = "local_only",
    ) -> ObservablePreviewCapability: ...

    async def exchange_preview_capability(self, capability: str) -> ObservablePreviewGrant: ...


class PostgresObservableSourceRepository:
    def __init__(
        self,
        executor: TenantTransactionExecutor,
        storage: UploadStorage | None = None,
        compiler_image_digest: str | None = None,
        download_storage: DownloadStorage | None = None,
        github_builds: bool = False,
        artifact_builds: bool = False,
    ) -> None:
        self._executor = executor
        self._storage = storage or UnavailableUploadStorage()
        self._compiler_image_digest = compiler_image_digest
        self._download_storage = download_storage or UnavailableDownloadStorage()
        self._github_builds = github_builds
        self._artifact_builds = artifact_builds

    async def resolve_artifact_lease(
        self, context: TenantContext, job_id: UUID, token: UUID
    ) -> list[dict[str, Any]]:
        from opengeo_api.publication_artifact_leases import resolve_artifact_lease

        return await resolve_artifact_lease(self, context, job_id, token)

    async def prepare_artifact_inputs(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        revision_id: UUID,
        expected_reference_revision: int,
    ) -> dict[str, Any]:
        from opengeo_api.publication_artifact_inputs import prepare_artifact_inputs

        return await prepare_artifact_inputs(
            self, context, project_id, source_project_id, revision_id, expected_reference_revision
        )

    async def read_artifact_inputs(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        input_id: UUID,
    ) -> dict[str, Any]:
        from opengeo_api.publication_artifact_inputs import read_artifact_inputs

        return await read_artifact_inputs(self, context, project_id, source_project_id, input_id)

    async def artifact_references(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        references: list[dict[str, Any]] | None = None,
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        from opengeo_api.publication_artifact_references import artifact_references

        return await artifact_references(
            self, context, project_id, source_project_id, references, expected_revision
        )

    async def publication_workspaces(
        self, context: TenantContext, limit: int = 100, offset: int = 0
    ) -> list[dict[str, Any]]:
        """One permission-scoped index; no builds, bucket listings or per-project fan-out."""
        if not 1 <= limit <= 100 or not 0 <= offset <= 100_000:
            raise ObservableSourceConflict("publication_directory_page_invalid")

        async def operation(transaction: TenantTransaction) -> list[dict[str, Any]]:
            rows = await transaction.fetch_all(
                """
                WITH member AS (
                  SELECT role FROM app.organization_memberships
                  WHERE organization_id=%s AND user_id=%s
                ), managed AS (
                  SELECT COALESCE(mount.id, source.id) AS id, 'framework' AS kind,
                    project.id AS project_id, project.name AS project_name,
                    site.id AS site_id, source.id AS source_project_id, source.title,
                    source.current_revision_number AS current_revision,
                    origin.hostname, mount.mount_path,
                    published.published_at, published.revision_number AS published_revision,
                    CASE WHEN published.published_at IS NOT NULL
                      THEN 'published'
                      WHEN mount.mount_path='/' AND origin.enabled THEN 'adopted'
                      ELSE 'draft' END AS status,
                    (member.role='admin' OR app.effective_project_role(project.id)::text
                      IN ('owner','editor')) AS can_manage
                  FROM app.observable_source_projects source
                  JOIN app.projects project ON project.id=source.project_id
                    AND project.organization_id=source.organization_id
                  JOIN app.project_sites site ON site.id=source.site_id
                    AND site.organization_id=source.organization_id
                  CROSS JOIN member
                  LEFT JOIN app.framework_publication_mounts mount
                    ON mount.source_project_id=source.id
                    AND mount.organization_id=source.organization_id AND mount.enabled
                  LEFT JOIN app.framework_publication_origins origin
                    ON origin.id=mount.origin_id AND origin.enabled
                  LEFT JOIN LATERAL (
                    SELECT job.updated_at AS published_at, revision.revision_number
                    FROM app.framework_publication_reviews review
                    JOIN app.framework_publication_jobs job
                      ON job.review_id=review.id AND job.stage='deployed'
                    JOIN app.observable_build_jobs build ON build.id=review.build_job_id
                    JOIN app.observable_source_revisions revision
                      ON revision.id=build.source_revision_id
                    WHERE review.mount_id=mount.id AND review.organization_id=source.organization_id
                    ORDER BY job.updated_at DESC, review.id LIMIT 1
                  ) published ON true
                  WHERE source.organization_id=%s AND project.status='active'
                    AND (member.role='admin' OR app.effective_project_role(project.id) IS NOT NULL)
                ), hosted AS (
                  SELECT origin.id, 'hosted_site' AS kind, NULL::uuid AS project_id,
                    NULL::text AS project_name, NULL::uuid AS site_id,
                    NULL::uuid AS source_project_id,
                    origin.hostname AS title, 0 AS current_revision, origin.hostname,
                    '/' AS mount_path, NULL::timestamptz AS published_at,
                    NULL::integer AS published_revision, 'unmanaged' AS status, false AS can_manage
                  FROM app.framework_publication_origins origin CROSS JOIN member
                  WHERE origin.organization_id=%s AND origin.enabled AND member.role='admin'
                    AND NOT EXISTS (SELECT 1 FROM app.framework_publication_mounts mount
                      WHERE mount.origin_id=origin.id AND mount.mount_path='/' AND mount.enabled)
                ), sites AS (
                  SELECT site.id, 'site' AS kind, project.id AS project_id,
                    project.name AS project_name, site.id AS site_id,
                    NULL::uuid AS source_project_id, version.title,
                    site.current_version_number AS current_revision,
                    NULL::text AS hostname, NULL::text AS mount_path,
                    edition.published_at, edition.site_version_number AS published_revision,
                    CASE WHEN edition.id IS NULL THEN 'draft' ELSE 'published' END AS status,
                    (member.role='admin' OR app.effective_project_role(project.id)::text
                      IN ('owner','editor')) AS can_manage
                  FROM app.project_sites site
                  JOIN app.projects project ON project.id=site.project_id
                    AND project.organization_id=site.organization_id
                  JOIN app.project_site_versions version ON version.id=site.current_version_id
                    AND version.site_id=site.id AND version.organization_id=site.organization_id
                  CROSS JOIN member
                  LEFT JOIN LATERAL (
                    SELECT id, published_at, site_version_number
                    FROM app.project_site_editions
                    WHERE site_id=site.id AND organization_id=site.organization_id
                      AND revoked_at IS NULL
                    ORDER BY edition_number DESC LIMIT 1
                  ) edition ON true
                  WHERE site.organization_id=%s AND project.status='active'
                    AND (member.role='admin' OR app.effective_project_role(project.id) IS NOT NULL)
                    AND NOT EXISTS (SELECT 1 FROM app.observable_source_projects source
                      WHERE source.site_id=site.id AND source.organization_id=site.organization_id)
                ), records AS (
                  SELECT * FROM managed UNION ALL SELECT * FROM hosted UNION ALL SELECT * FROM sites
                )
                SELECT id,kind,project_id,project_name,site_id,source_project_id,
                  title,current_revision,
                  hostname,mount_path,published_at,published_revision,status,can_manage
                FROM records ORDER BY lower(title), mount_path NULLS FIRST, id LIMIT %s OFFSET %s
                """,
                (
                    context.organization_id,
                    context.user_id,
                    context.organization_id,
                    context.organization_id,
                    context.organization_id,
                    limit,
                    offset,
                ),
            )
            names = (
                "id",
                "kind",
                "project_id",
                "project_name",
                "site_id",
                "source_project_id",
                "title",
                "current_revision",
                "hostname",
                "mount_path",
                "published_at",
                "published_revision",
                "status",
                "can_manage",
            )
            return [dict(zip(names, row, strict=True)) for row in rows]

        return await self._run(context, operation)

    async def github_dispatches(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        limit: int = 25,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        if not 1 <= limit <= 100 or not 0 <= offset <= 100_000:
            raise ObservableSourceConflict("observable_build_page_invalid")

        async def operation(transaction: TenantTransaction) -> list[dict[str, Any]]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_READ, roles)
            try:
                self._require(Action.SITE_MANAGE, roles)
                can_read_logs = True
            except ObservableSourceAccessDenied:
                can_read_logs = False
            await self._load_project(transaction, context, project_id, source_project_id)
            rows = await transaction.fetch_all(
                """SELECT job.id, dispatch.stage, dispatch.source_commit, dispatch.workflow_sha,
                          dispatch.run_id, dispatch.run_attempt, dispatch.error_code,
                          dispatch.updated_at, connection.repository,
                          dispatch.run_status, dispatch.run_conclusion,
                          CASE WHEN %s THEN dispatch.retained_logs ELSE NULL END
                   FROM app.observable_build_jobs job
                   LEFT JOIN app.observable_github_dispatches dispatch
                     ON dispatch.build_job_id = job.id
                     AND dispatch.organization_id = job.organization_id
                   LEFT JOIN app.github_publication_connections connection
                     ON connection.organization_id = dispatch.organization_id
                    AND connection.id = dispatch.connection_id
                   WHERE job.organization_id = %s AND job.project_id = %s
                     AND job.source_project_id = %s
                   ORDER BY job.created_at DESC, job.id DESC LIMIT %s OFFSET %s""",
                (
                    can_read_logs,
                    context.organization_id,
                    project_id,
                    source_project_id,
                    limit,
                    offset,
                ),
            )
            return [
                {
                    "build_job_id": row[0],
                    "source_project_id": source_project_id,
                    "stage": row[1],
                    "source_commit": row[2],
                    "workflow_sha": row[3],
                    "run_id": row[4],
                    "run_attempt": row[5],
                    "error_code": row[6],
                    "updated_at": row[7],
                    "repository": row[8],
                    "run_status": row[9],
                    "run_conclusion": row[10],
                    "retained_logs": row[11],
                }
                for row in rows
                if row[1] is not None
            ]

        return await self._run(context, operation)

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ObservableOperationResult]],
    ) -> ObservableOperationResult:
        try:
            return await self._executor.run(context, operation)
        except TenantDatabaseConflict as error:
            raise ObservableSourceConflict("observable_source_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise ObservableSourceStoreUnavailable("Observable source operation failed") from error

    async def publication_status(
        self, context: TenantContext, project_id: UUID, source_project_id: UUID
    ) -> dict[str, Any]:
        async def operation(transaction: TenantTransaction) -> dict[str, Any]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_READ, roles)
            await self._load_project(transaction, context, project_id, source_project_id)
            mounts = await transaction.fetch_all(
                """SELECT mount.id, origin.hostname, mount.mount_path, origin.generation,
                          mount.enabled AND origin.enabled
                   FROM app.framework_publication_mounts mount
                   JOIN app.framework_publication_origins origin ON origin.id = mount.origin_id
                     AND origin.organization_id = mount.organization_id
                   WHERE mount.organization_id = %s AND mount.project_id = %s
                     AND mount.source_project_id = %s ORDER BY origin.hostname, mount.mount_path""",
                (context.organization_id, project_id, source_project_id),
            )
            reviews = await transaction.fetch_all(
                """SELECT review.id, review.build_job_id, review.mount_id, review.hostname,
                          review.mount_path, review.result_checksum_sha256,
                          review.output_tree_checksum_sha256, review.expected_generation,
                          review.previous_release_prefix, review.reviewed_at, review.expires_at,
                          approval.approved_at,
                          CASE WHEN job.review_id IS NULL THEN NULL ELSE jsonb_build_object(
                            'stage', job.stage, 'completed_files', job.completed_files,
                            'total_files', jsonb_array_length(job.plan->'files'),
                            'error_code', job.error_code, 'updated_at', job.updated_at,
                            'release_prefix', CASE WHEN job.stage = 'deployed'
                              THEN job.receipt->>'targetPrefix' ELSE NULL END
                          ) END AS deployment
                   FROM app.framework_publication_reviews review
                   LEFT JOIN app.framework_publication_approvals approval
                     ON approval.review_id = review.id
                     AND approval.organization_id = review.organization_id
                   LEFT JOIN app.framework_publication_jobs job ON job.review_id = review.id
                     AND job.organization_id = review.organization_id
                     AND job.project_id = review.project_id
                   WHERE review.organization_id = %s AND review.project_id = %s
                     AND review.source_project_id = %s
                   ORDER BY review.reviewed_at DESC, review.id DESC LIMIT 25""",
                (context.organization_id, project_id, source_project_id),
            )
            try:
                authorize(Action.SITE_PUBLISH, roles)
                can_publish = True
            except AuthorizationDenied:
                can_publish = False
            origins = (
                await transaction.fetch_all(
                    """SELECT id, hostname, self_service_prefix
                   FROM app.framework_publication_origins
                   WHERE organization_id = %s AND enabled AND self_service_prefix IS NOT NULL
                     AND (%s OR project_reservation_limit > 0)
                   ORDER BY hostname, self_service_prefix LIMIT 100""",
                    (context.organization_id, roles.organization == "admin"),
                )
                if can_publish
                else []
            )
            return {
                "source_project_id": source_project_id,
                "can_publish": can_publish,
                "can_configure_destinations": can_publish and bool(origins),
                "origins": [
                    dict(zip(("id", "hostname", "path_prefix"), row, strict=True))
                    for row in origins
                ],
                "mounts": [
                    dict(
                        zip(
                            ("id", "hostname", "mount_path", "generation", "enabled"),
                            row,
                            strict=True,
                        )
                    )
                    for row in mounts
                ],
                "reviews": [
                    dict(
                        zip(
                            (
                                "id",
                                "build_job_id",
                                "mount_id",
                                "hostname",
                                "mount_path",
                                "result_checksum_sha256",
                                "output_tree_checksum_sha256",
                                "expected_generation",
                                "previous_release_prefix",
                                "reviewed_at",
                                "expires_at",
                                "approved_at",
                                "deployment",
                            ),
                            row,
                            strict=True,
                        )
                    )
                    for row in reviews
                ],
            }

        return await self._run(context, operation)

    async def reserve_publication_destination(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        reservation_id: UUID,
        origin_id: UUID,
        slug: str,
        acknowledgment: str,
    ) -> None:
        async def operation(transaction: TenantTransaction) -> None:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_PUBLISH, roles)
            await self._load_project(transaction, context, project_id, source_project_id)
            await transaction.fetch_one(
                "SELECT app.reserve_framework_publication_mount(%s, %s, %s, %s, %s, %s)",
                (reservation_id, project_id, source_project_id, origin_id, slug, acknowledgment),
            )

        await self._run(context, operation)

    async def review_publication(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        build_job_id: UUID,
        mount_id: UUID,
        checksum: str,
        review_id: UUID,
        distribution_approval_id: UUID | None = None,
    ) -> None:
        async def operation(transaction: TenantTransaction) -> None:
            self._require(
                Action.SITE_PUBLISH, await self._project_roles(transaction, context, project_id)
            )
            await self._load_project(transaction, context, project_id, source_project_id)
            job = await self._load_build_job(transaction, context, project_id, build_job_id)
            if job.source_project_id != source_project_id:
                raise ObservableSourceNotFound("build_job")
            if job.state != "succeeded" or job.result_checksum_sha256 != checksum:
                raise ObservableSourceConflict("framework_exact_successful_output_required")
            revision = await self._load_revision(
                transaction, context, project_id, source_project_id, job.source_revision_id
            )
            if revision.rights_status != "approved":
                raise ObservableSourceConflict("framework_source_rights_approval_required")
            if distribution_approval_id is not None:
                from opengeo_api.observable_distribution_approvals import read_distribution_approval

                await read_distribution_approval(
                    self,
                    transaction,
                    context,
                    project_id,
                    source_project_id,
                    job.source_revision_id,
                    distribution_approval_id,
                    job.request["compilerImageDigest"],
                    job.request.get("outputProfile", "default-32m"),
                    job.request.get("artifactInputsChecksumSha256"),
                )
                await transaction.fetch_one(
                    "SELECT app.review_framework_publication_with_inputs(%s,%s,%s,%s,%s,%s)",
                    (
                        review_id,
                        project_id,
                        build_job_id,
                        mount_id,
                        checksum,
                        distribution_approval_id,
                    ),
                )
            else:
                await transaction.fetch_one(
                    "SELECT app.review_framework_publication(%s,%s,%s,%s,%s)",
                    (review_id, project_id, build_job_id, mount_id, checksum),
                )

        await self._run(context, operation)

    async def approve_publication(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        review_id: UUID,
    ) -> None:
        async def operation(transaction: TenantTransaction) -> None:
            self._require(
                Action.SITE_PUBLISH, await self._project_roles(transaction, context, project_id)
            )
            row = await transaction.fetch_one(
                "SELECT id FROM app.framework_publication_reviews WHERE organization_id = %s "
                "AND project_id = %s AND source_project_id = %s AND id = %s",
                (context.organization_id, project_id, source_project_id, review_id),
            )
            if row is None:
                raise ObservableSourceNotFound("publication_review")
            await transaction.fetch_one(
                "SELECT app.approve_framework_publication(%s, %s, %s)",
                (review_id, project_id, "publish-exact-previewed-output"),
            )

        await self._run(context, operation)

    async def request_github_sync(
        self, context: TenantContext, project_id: UUID, source_project_id: UUID, revision_id: UUID
    ) -> bool:
        async def operation(transaction: TenantTransaction) -> bool:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_MANAGE, roles)
            await self._load_revision(
                transaction, context, project_id, source_project_id, revision_id
            )
            row = await transaction.fetch_one(
                "SELECT app.request_github_source_sync(%s)", (revision_id,)
            )
            return row is not None and row[0] is True

        return await self._run(context, operation)

    async def github_status(
        self, context: TenantContext, project_id: UUID, source_project_id: UUID
    ) -> dict[str, Any]:
        async def operation(transaction: TenantTransaction) -> dict[str, Any]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_READ, roles)
            project = await self._load_project(transaction, context, project_id, source_project_id)
            link = await transaction.fetch_one(
                """SELECT connection.id, connection.repository, connection.repository_id,
                          connection.enabled, connection.verified_at, link.created_at
                   FROM app.observable_github_links link
                   JOIN app.github_publication_connections connection
                     ON connection.organization_id = link.organization_id
                    AND connection.id = link.connection_id
                   WHERE link.organization_id = %s AND link.project_id = %s
                     AND link.source_project_id = %s""",
                (context.organization_id, project_id, source_project_id),
            )
            can_manage = True
            try:
                self._require(Action.SITE_MANAGE, roles)
            except ObservableSourceAccessDenied:
                can_manage = False
            available = (
                await transaction.fetch_all(
                    """SELECT id, repository, repository_id, enabled, verified_at
                   FROM app.github_publication_connections
                   WHERE organization_id = %s AND enabled ORDER BY repository, id""",
                    (context.organization_id,),
                )
                if can_manage
                else []
            )
            receipts = await transaction.fetch_all(
                """SELECT receipt.source_revision_id, revision.revision_number,
                          receipt.commit_sha, receipt.tree_sha, receipt.git_ref,
                          receipt.manifest_sha256, receipt.created_at
                   FROM app.observable_github_revision_receipts receipt
                   JOIN app.observable_source_revisions revision
                     ON revision.organization_id = receipt.organization_id
                    AND revision.id = receipt.source_revision_id
                   WHERE receipt.organization_id = %s AND receipt.project_id = %s
                     AND receipt.source_project_id = %s
                   ORDER BY revision.revision_number DESC LIMIT 25""",
                (context.organization_id, project_id, source_project_id),
            )

            syncs = await transaction.fetch_all(
                """SELECT sync.source_revision_id, revision.revision_number, sync.stage,
                          sync.error_code, sync.updated_at
                   FROM app.observable_github_syncs sync
                   JOIN app.observable_source_revisions revision
                     ON revision.id = sync.source_revision_id
                     AND revision.organization_id = sync.organization_id
                   WHERE sync.organization_id = %s AND sync.project_id = %s
                     AND sync.source_project_id = %s
                   ORDER BY revision.revision_number DESC LIMIT 25""",
                (context.organization_id, project_id, source_project_id),
            )

            def connection(row: tuple[Any, ...]) -> dict[str, Any]:
                return {
                    "id": row[0],
                    "repository": row[1],
                    "repository_id": row[2],
                    "enabled": row[3],
                    "verified_at": row[4],
                }

            return {
                "source_project_id": source_project_id,
                "connection": None if link is None else connection(link),
                "available_connections": [connection(row) for row in available],
                "can_connect": can_manage and link is None,
                "can_sync": can_manage and link is not None and bool(link[3]),
                "current_revision_id": project.current_revision_id,
                "syncs": [
                    dict(
                        zip(
                            (
                                "source_revision_id",
                                "revision_number",
                                "stage",
                                "error_code",
                                "updated_at",
                            ),
                            row,
                            strict=True,
                        )
                    )
                    for row in syncs
                ],
                "revisions": [
                    {
                        "source_revision_id": row[0],
                        "revision_number": row[1],
                        "commit_sha": row[2],
                        "tree_sha": row[3],
                        "git_ref": row[4],
                        "manifest_sha256": row[5],
                        "created_at": row[6],
                    }
                    for row in receipts
                ],
            }

        return await self._run(context, operation)

    async def connect_github(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        connection_id: UUID,
    ) -> dict[str, Any]:
        async def operation(transaction: TenantTransaction) -> None:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_MANAGE, roles)
            await self._load_project(transaction, context, project_id, source_project_id)
            await transaction.fetch_one(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))::text",
                (f"github-source-link:{context.organization_id}:{source_project_id}",),
            )
            existing = await transaction.fetch_one(
                """SELECT connection_id FROM app.observable_github_links
                   WHERE organization_id = %s AND project_id = %s AND source_project_id = %s""",
                (context.organization_id, project_id, source_project_id),
            )
            if existing is not None:
                if existing[0] != connection_id:
                    raise ObservableSourceConflict("github_connection_already_selected")
                return
            enabled = await transaction.fetch_one(
                """SELECT id FROM app.github_publication_connections
                   WHERE organization_id = %s AND id = %s AND enabled""",
                (context.organization_id, connection_id),
            )
            if enabled is None:
                raise ObservableSourceNotFound("github_connection")
            await transaction.execute(
                """INSERT INTO app.observable_github_links
                   (organization_id, project_id, source_project_id, connection_id, created_by)
                   VALUES (%s, %s, %s, %s, %s)""",
                (
                    context.organization_id,
                    project_id,
                    source_project_id,
                    connection_id,
                    context.user_id,
                ),
            )

        await self._run(context, operation)
        return await self.github_status(context, project_id, source_project_id)

    @staticmethod
    async def _github_build_connection(
        transaction: TenantTransaction, context: TenantContext
    ) -> tuple[UUID, GitHubConnection]:
        # The operator's build grant is independent of an author's optional
        # repository mirror. Never create a source link merely to compile.
        rows = await transaction.fetch_all(
            """SELECT id, installation_id, repository_id, repository
               FROM app.github_publication_connections
               WHERE organization_id = %s AND enabled
                 AND build_workflow_id IS NOT NULL AND runtime_sha IS NOT NULL
               ORDER BY id LIMIT 2""",
            (context.organization_id,),
        )
        if not rows:
            raise ObservableSourceConflict("github_build_connection_not_configured")
        if len(rows) != 1:
            raise ObservableSourceConflict("github_build_connection_ambiguous")
        row = rows[0]
        return cast(UUID, row[0]), GitHubConnection(row[1], row[2], row[3])

    async def prepare_github_build(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        revision_id: UUID,
    ) -> tuple[UUID, GitHubConnection]:
        async def operation(transaction: TenantTransaction) -> tuple[UUID, GitHubConnection]:
            self._require(
                Action.SITE_MANAGE, await self._project_roles(transaction, context, project_id)
            )
            await self._load_revision(
                transaction, context, project_id, source_project_id, revision_id
            )
            return await self._github_build_connection(transaction, context)

        return await self._run(context, operation)

    async def prepare_github_export(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        revision_id: UUID,
    ) -> tuple[UUID, GitHubConnection, ObservableSourceRevision]:
        async def operation(
            transaction: TenantTransaction,
        ) -> tuple[UUID, GitHubConnection, ObservableSourceRevision]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_MANAGE, roles)
            revision = await self._load_revision(
                transaction, context, project_id, source_project_id, revision_id
            )
            row = await transaction.fetch_one(
                """SELECT connection.id, connection.installation_id,
                          connection.repository_id, connection.repository
                   FROM app.observable_github_links link
                   JOIN app.github_publication_connections connection
                     ON connection.organization_id = link.organization_id
                    AND connection.id = link.connection_id
                   JOIN app.projects project ON project.organization_id = link.organization_id
                    AND project.id = link.project_id AND project.status = 'active'
                   WHERE link.organization_id = %s AND link.project_id = %s
                     AND link.source_project_id = %s AND connection.enabled""",
                (context.organization_id, project_id, source_project_id),
            )
            if row is None:
                raise ObservableSourceConflict("github_connection_unavailable")
            return cast(UUID, row[0]), GitHubConnection(row[1], row[2], row[3]), revision

        return await self._run(context, operation)

    async def retain_github_receipt(
        self,
        context: TenantContext,
        project_id: UUID,
        connection_id: UUID,
        receipt: GitHubSourceReceipt,
    ) -> None:
        async def operation(transaction: TenantTransaction) -> None:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_MANAGE, roles)
            revision = await self._load_revision(
                transaction, context, project_id, receipt.source_project_id, receipt.revision_id
            )
            manifest = json.dumps(
                {
                    "schema": "opengeo.github-source.1.0.0",
                    "source_project_id": str(receipt.source_project_id),
                    "revision_id": str(receipt.revision_id),
                    "created_at": revision.created_at.astimezone(UTC).isoformat(),
                    "files": [
                        {
                            "path": file.relative_path,
                            "size_bytes": file.size_bytes,
                            "sha256": file.checksum_sha256,
                        }
                        for file in sorted(revision.files, key=lambda item: item.relative_path)
                    ],
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
            if hashlib.sha256(manifest).hexdigest() != receipt.manifest_sha256:
                raise ObservableSourceConflict("github_receipt_source_mismatch")
            await transaction.fetch_one(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))::text",
                (f"github-receipt:{context.organization_id}:{receipt.revision_id}",),
            )
            expected = (
                connection_id,
                receipt.repository_id,
                receipt.commit_sha,
                receipt.tree_sha,
                receipt.ref,
                receipt.manifest_sha256,
            )
            existing = await transaction.fetch_one(
                """SELECT connection_id, repository_id, commit_sha, tree_sha,
                          git_ref, manifest_sha256
                   FROM app.observable_github_revision_receipts
                   WHERE organization_id = %s AND project_id = %s
                     AND source_project_id = %s AND source_revision_id = %s""",
                (
                    context.organization_id,
                    project_id,
                    receipt.source_project_id,
                    receipt.revision_id,
                ),
            )
            if existing is not None:
                if existing != expected:
                    raise ObservableSourceConflict("github_receipt_conflict")
                return
            await transaction.execute(
                """INSERT INTO app.observable_github_revision_receipts
                   (organization_id, project_id, source_project_id, source_revision_id,
                    connection_id, repository_id, commit_sha, tree_sha, git_ref, manifest_sha256,
                    created_by)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (
                    context.organization_id,
                    project_id,
                    receipt.source_project_id,
                    receipt.revision_id,
                    *expected,
                    context.user_id,
                ),
            )

        await self._run(context, operation)

    @staticmethod
    def _attachment_select() -> str:
        return """
            SELECT attachment.id, attachment.source_project_id, attachment.dataset_id,
                   attachment.dataset_version_id, attachment.data_object_id,
                   attachment.s3_version_id, attachment.checksum_sha256,
                   attachment.size_bytes, attachment.content_type,
                   attachment.created_by, attachment.created_at,
                   EXISTS (
                     SELECT 1 FROM app.project_datasets linked
                     JOIN app.projects project
                       ON project.organization_id = linked.organization_id
                      AND project.id = linked.project_id AND project.status = 'active'
                     JOIN app.datasets dataset
                       ON dataset.organization_id = linked.organization_id
                      AND dataset.id = linked.dataset_id
                     JOIN app.dataset_versions version
                       ON version.organization_id = dataset.organization_id
                      AND version.dataset_id = dataset.id
                      AND version.id = attachment.dataset_version_id
                     JOIN app.data_objects object
                       ON object.organization_id = dataset.organization_id
                      AND object.dataset_id = dataset.id
                      AND object.id = attachment.data_object_id
                     JOIN app.organization_memberships member
                       ON member.organization_id = dataset.organization_id
                      AND member.user_id = app.current_user_id()
                     LEFT JOIN app.dataset_permissions permission
                       ON permission.organization_id = dataset.organization_id
                      AND permission.dataset_id = dataset.id
                      AND permission.user_id = member.user_id
                     WHERE linked.organization_id = attachment.organization_id
                       AND linked.project_id = attachment.project_id
                       AND linked.dataset_id = attachment.dataset_id
                       AND dataset.status = 'active' AND version.state = 'active'
                       AND object.s3_version_id = attachment.s3_version_id
                       AND object.checksum_sha256 = attachment.checksum_sha256
                       AND object.size_bytes = attachment.size_bytes
                       AND object.content_type = attachment.content_type
                       AND (member.role = 'admin' OR dataset.owner_user_id = member.user_id
                         OR app.effective_project_role(linked.project_id, member.user_id)::text
                           IN ('owner', 'editor')
                         OR permission.role::text IN ('manage', 'edit', 'download'))
                   ) AS available
            FROM app.observable_data_attachments attachment
        """

    async def list_data_attachments(
        self, context: TenantContext, project_id: UUID, source_project_id: UUID
    ) -> tuple[ObservableDataAttachment, ...]:
        async def operation(transaction: TenantTransaction) -> tuple[ObservableDataAttachment, ...]:
            self._require(
                Action.SITE_READ, await self._project_roles(transaction, context, project_id)
            )
            await self._load_project(transaction, context, project_id, source_project_id)
            rows = await transaction.fetch_all(
                f"""{self._attachment_select()}
                WHERE attachment.organization_id = %s AND attachment.project_id = %s
                  AND attachment.source_project_id = %s
                ORDER BY attachment.created_at, attachment.id LIMIT 128
                """,
                (context.organization_id, project_id, source_project_id),
            )
            return tuple(ObservableDataAttachment(*row) for row in rows)

        return await self._run(context, operation)

    async def register_data_attachment(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        dataset_id: UUID,
        dataset_version_id: UUID,
        data_object_id: UUID,
        request_id: str,
    ) -> ObservableDataAttachment:
        async def operation(transaction: TenantTransaction) -> ObservableDataAttachment:
            self._require(
                Action.SITE_MANAGE, await self._project_roles(transaction, context, project_id)
            )
            await self._load_project(transaction, context, project_id, source_project_id)
            inserted = await transaction.fetch_one(
                """
                INSERT INTO app.observable_data_attachments
                  (organization_id, project_id, source_project_id, dataset_id,
                   dataset_version_id, data_object_id, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (organization_id, source_project_id, dataset_version_id, data_object_id)
                  DO NOTHING
                RETURNING id
                """,
                (
                    context.organization_id,
                    project_id,
                    source_project_id,
                    dataset_id,
                    dataset_version_id,
                    data_object_id,
                    context.user_id,
                ),
            )
            row = await transaction.fetch_one(
                f"""{self._attachment_select()}
                WHERE attachment.organization_id = %s AND attachment.project_id = %s
                  AND attachment.source_project_id = %s AND attachment.dataset_id = %s
                  AND attachment.dataset_version_id = %s AND attachment.data_object_id = %s
                """,
                (
                    context.organization_id,
                    project_id,
                    source_project_id,
                    dataset_id,
                    dataset_version_id,
                    data_object_id,
                ),
            )
            if row is None or not row[11]:
                raise ObservableSourceConflict("observable_data_attachment_unavailable")
            result = ObservableDataAttachment(*row)
            if inserted is not None:
                await self._record_event(
                    transaction,
                    context,
                    project_id,
                    "observable.data_attachment.registered",
                    source_project_id,
                    request_id,
                    {
                        "attachment_id": str(result.id),
                        "dataset_id": str(dataset_id),
                        "dataset_version_id": str(dataset_version_id),
                        "data_object_id": str(data_object_id),
                    },
                )
            return result

        return await self._run(context, operation)

    @staticmethod
    def _public_file_reference_select() -> str:
        return """
            SELECT reference.id, reference.source_project_id, reference.dataset_id,
                   reference.source_version, reference.resource_id,
                   reference.resource_version_id, reference.resource_version_number,
                   reference.distribution_id, reference.source_url, reference.content_type,
                   reference.size_bytes, reference.checksum_sha256, reference.created_by,
                   reference.created_at,
                   app.observable_public_file_reference_available(
                     reference.organization_id, reference.project_id, reference.id) AS available
            FROM app.observable_public_file_references reference
        """

    async def list_public_file_references(
        self, context: TenantContext, project_id: UUID, source_project_id: UUID
    ) -> tuple[ObservablePublicFileReference, ...]:
        async def operation(
            transaction: TenantTransaction,
        ) -> tuple[ObservablePublicFileReference, ...]:
            self._require(
                Action.SITE_READ, await self._project_roles(transaction, context, project_id)
            )
            await self._load_project(transaction, context, project_id, source_project_id)
            rows = await transaction.fetch_all(
                self._public_file_reference_select()
                + """ WHERE reference.organization_id = %s AND reference.project_id = %s
                     AND reference.source_project_id = %s
                     ORDER BY reference.created_at, reference.id LIMIT 128""",
                (context.organization_id, project_id, source_project_id),
            )
            return tuple(ObservablePublicFileReference(*row) for row in rows)

        return await self._run(context, operation)

    async def register_public_file_reference(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        dataset_id: UUID,
        source_version: int,
        resource_id: UUID,
        resource_version_id: UUID,
        distribution_id: str,
        request_id: str,
    ) -> ObservablePublicFileReference:
        if (
            type(source_version) is not int
            or not 1 <= source_version <= 9_007_199_254_740_991
            or not isinstance(distribution_id, str)
            or not 1 <= len(distribution_id) <= 1000
        ):
            raise ObservableSourceConflict("observable_public_file_reference_invalid")

        async def operation(transaction: TenantTransaction) -> ObservablePublicFileReference:
            self._require(
                Action.SITE_MANAGE, await self._project_roles(transaction, context, project_id)
            )
            await self._load_project(transaction, context, project_id, source_project_id)
            # The insertion guard derives and locks current source/resource facts;
            # no caller-provided URL, digest or size enters this immutable registry.
            inserted = await transaction.fetch_one(
                """INSERT INTO app.observable_public_file_references
                     (organization_id, project_id, source_project_id, dataset_id,
                      source_version, resource_id, resource_version_id, distribution_id, created_by)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (organization_id, source_project_id, dataset_id, source_version,
                                resource_id, resource_version_id, distribution_id) DO NOTHING
                   RETURNING id""",
                (
                    context.organization_id,
                    project_id,
                    source_project_id,
                    dataset_id,
                    source_version,
                    resource_id,
                    resource_version_id,
                    distribution_id,
                    context.user_id,
                ),
            )
            row = await transaction.fetch_one(
                self._public_file_reference_select()
                + """ WHERE reference.organization_id = %s AND reference.project_id = %s
                     AND reference.source_project_id = %s AND reference.dataset_id = %s
                     AND reference.source_version = %s AND reference.resource_id = %s
                     AND reference.resource_version_id = %s AND reference.distribution_id = %s""",
                (
                    context.organization_id,
                    project_id,
                    source_project_id,
                    dataset_id,
                    source_version,
                    resource_id,
                    resource_version_id,
                    distribution_id,
                ),
            )
            if row is None or not row[14]:
                raise ObservableSourceConflict("observable_public_file_reference_unavailable")
            result = ObservablePublicFileReference(*row)
            if inserted is not None:
                await self._record_event(
                    transaction,
                    context,
                    project_id,
                    "observable.public_file_reference.registered",
                    source_project_id,
                    request_id,
                    {
                        "reference_id": str(result.id),
                        "dataset_id": str(dataset_id),
                        "source_version": source_version,
                        "resource_id": str(resource_id),
                        "resource_version_id": str(resource_version_id),
                        "distribution_id": distribution_id,
                    },
                )
            return result

        return await self._run(context, operation)

    async def list_projects(
        self, context: TenantContext, project_id: UUID
    ) -> tuple[ObservableSourceProject, ...]:
        async def operation(
            transaction: TenantTransaction,
        ) -> tuple[ObservableSourceProject, ...]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_READ, roles)
            rows = await transaction.fetch_all(
                f"""{self._project_select()}
                WHERE source.organization_id = %s AND source.project_id = %s
                ORDER BY lower(source.title), source.id
                """,
                (context.organization_id, project_id),
            )
            return tuple(self._project(row) for row in rows)

        return await self._run(context, operation)

    async def create_project(
        self,
        context: TenantContext,
        project_id: UUID,
        site_id: UUID,
        title: str,
        request_id: str,
    ) -> ObservableSourceProject:
        if self._compiler_image_digest is None:
            raise ObservableSourceStoreUnavailable("Observable builder policy is not configured")
        source_project_id = uuid4()

        async def operation(transaction: TenantTransaction) -> ObservableSourceProject:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_MANAGE, roles)
            site = await transaction.fetch_one(
                """
                SELECT slug
                FROM app.project_sites
                WHERE organization_id = %s AND project_id = %s AND id = %s
                """,
                (context.organization_id, project_id, site_id),
            )
            if site is None:
                raise ObservableSourceNotFound("site")
            await transaction.execute(
                """
                INSERT INTO app.observable_source_projects
                  (id, organization_id, project_id, site_id, route_namespace,
                   title, rights_status, owner_user_id, compiler_image_digest,
                   framework_version, lockfile_format, network_policy,
                   resource_limits, created_by, updated_by)
                VALUES (%s, %s, %s, %s, %s, %s, 'unreviewed', %s, %s,
                        %s, %s, %s, %s, %s, %s)
                """,
                (
                    source_project_id,
                    context.organization_id,
                    project_id,
                    site_id,
                    cast(str, site[0]),
                    title,
                    context.user_id,
                    self._compiler_image_digest,
                    OBSERVABLE_FRAMEWORK_VERSION,
                    OBSERVABLE_LOCKFILE_FORMAT,
                    OBSERVABLE_NETWORK_POLICY,
                    Jsonb(OBSERVABLE_BUILD_LIMITS),
                    context.user_id,
                    context.user_id,
                ),
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "observable.source_project.created",
                source_project_id,
                request_id,
                {
                    "siteId": str(site_id),
                    "routeNamespace": cast(str, site[0]),
                    "compilerImageDigest": self._compiler_image_digest,
                    "networkPolicy": OBSERVABLE_NETWORK_POLICY,
                },
            )
            return await self._load_project(transaction, context, project_id, source_project_id)

        return await self._run(context, operation)

    async def get_project(
        self, context: TenantContext, project_id: UUID, source_project_id: UUID
    ) -> ObservableSourceProject:
        async def operation(transaction: TenantTransaction) -> ObservableSourceProject:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_READ, roles)
            return await self._load_project(transaction, context, project_id, source_project_id)

        return await self._run(context, operation)

    async def request_file_upload(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        draft: ObservableSourceFileUploadDraft,
        request_id: str,
    ) -> ObservableSourceFileUploadTicket:
        validate_observable_source_file(draft.relative_path, draft.content_type, draft.size_bytes)

        async def preauthorize(transaction: TenantTransaction) -> None:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_MANAGE, roles)
            await self._load_project(transaction, context, project_id, source_project_id)

        await self._run(context, preauthorize)
        upload_id = uuid4()
        object_key = (
            f"organizations/{context.organization_id}/projects/{project_id}/"
            f"source-projects/{source_project_id}/uploads/{upload_id}/files/"
            f"{draft.relative_path}"
        )
        upload = await self._storage.create_upload_form(
            UploadSpec(
                key=object_key,
                content_type=draft.content_type,
                size_bytes=draft.size_bytes,
                checksum_sha256=draft.checksum_sha256,
            )
        )

        async def register(transaction: TenantTransaction) -> None:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_MANAGE, roles)
            await self._load_project(transaction, context, project_id, source_project_id)
            await transaction.execute(
                """
                INSERT INTO app.observable_source_file_upload_intents
                  (id, organization_id, project_id, source_project_id,
                   relative_path, expected_content_type, expected_size_bytes,
                   expected_sha256, bucket, object_key, created_by, expires_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    upload_id,
                    context.organization_id,
                    project_id,
                    source_project_id,
                    draft.relative_path,
                    draft.content_type,
                    draft.size_bytes,
                    draft.checksum_sha256,
                    self._storage.bucket,
                    object_key,
                    context.user_id,
                    upload.expires_at,
                ),
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "observable.source_file.upload.requested",
                source_project_id,
                request_id,
                {
                    "uploadId": str(upload_id),
                    "relativePath": draft.relative_path,
                    "sizeBytes": draft.size_bytes,
                    "checksumSha256": draft.checksum_sha256,
                },
            )

        await self._run(context, register)
        return ObservableSourceFileUploadTicket(
            upload_id=upload_id,
            source_project_id=source_project_id,
            relative_path=draft.relative_path,
            content_type=draft.content_type,
            size_bytes=draft.size_bytes,
            checksum_sha256=draft.checksum_sha256,
            upload=upload,
        )

    async def create_revision(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        draft: ObservableSourceRevisionDraft,
        request_id: str,
    ) -> ObservableSourceRevision:
        self._validate_revision_draft(draft)
        uploads = tuple(item for item in draft.files if item.upload_id is not None)
        retained = tuple(item for item in draft.files if item.source_object_id is not None)

        async def load_intents(
            transaction: TenantTransaction,
        ) -> tuple[_UploadIntent, ...]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_MANAGE, roles)
            project = await self._load_project(transaction, context, project_id, source_project_id)
            if project.current_revision_number != draft.expected_revision:
                raise ObservableSourceConflict(
                    "observable_revision_conflict",
                    current_revision=project.current_revision_number,
                )
            rows = await transaction.fetch_all(
                """
                SELECT id, relative_path, expected_content_type,
                       expected_size_bytes, expected_sha256, bucket, object_key,
                       expires_at
                FROM app.observable_source_file_upload_intents
                WHERE organization_id = %s AND project_id = %s
                  AND source_project_id = %s
                  AND id = ANY(%s::uuid[])
                  AND state = 'pending'
                  AND created_by = %s
                  AND expires_at > clock_timestamp()
                ORDER BY relative_path
                """,
                (
                    context.organization_id,
                    project_id,
                    source_project_id,
                    [item.upload_id for item in uploads],
                    context.user_id,
                ),
            )
            if len(rows) != len(uploads):
                raise ObservableSourceConflict("observable_source_upload_invalid")
            intents = tuple(self._upload_intent(row) for row in rows)
            expected = {item.upload_id: item.relative_path for item in uploads}
            if any(expected.get(item.upload_id) != item.relative_path for item in intents):
                raise ObservableSourceConflict("observable_source_upload_path_mismatch")
            return intents

        intents = await self._run(context, load_intents)
        stored_objects = await gather(
            *(self._storage.inspect_object(intent.object_key) for intent in intents)
        )
        for intent, stored in zip(intents, stored_objects, strict=True):
            self._verify_stored_object(intent, stored)
        object_ids = {intent.upload_id: uuid4() for intent in intents}
        revision_id = uuid4()
        next_revision = draft.expected_revision + 1
        parent_revision_id: UUID | None = None

        async def commit(transaction: TenantTransaction) -> ObservableSourceRevision:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_MANAGE, roles)
            head = await transaction.fetch_one(
                """
                SELECT current_revision_id, current_revision_number
                FROM app.observable_source_projects
                WHERE organization_id = %s AND project_id = %s AND id = %s
                FOR UPDATE
                """,
                (context.organization_id, project_id, source_project_id),
            )
            if head is None:
                raise ObservableSourceNotFound("source_project")
            current_revision = cast(int, head[1])
            if current_revision != draft.expected_revision:
                raise ObservableSourceConflict(
                    "observable_revision_conflict", current_revision=current_revision
                )
            nonlocal parent_revision_id
            parent_revision_id = cast(UUID | None, head[0])
            locked_rows = await transaction.fetch_all(
                """
                SELECT id, relative_path, expected_content_type,
                       expected_size_bytes, expected_sha256, bucket, object_key,
                       expires_at
                FROM app.observable_source_file_upload_intents
                WHERE organization_id = %s AND project_id = %s
                  AND source_project_id = %s
                  AND id = ANY(%s::uuid[])
                  AND state = 'pending'
                  AND created_by = %s
                  AND expires_at > clock_timestamp()
                ORDER BY relative_path
                FOR UPDATE
                """,
                (
                    context.organization_id,
                    project_id,
                    source_project_id,
                    [item.upload_id for item in uploads],
                    context.user_id,
                ),
            )
            locked = tuple(self._upload_intent(row) for row in locked_rows)
            if locked != intents:
                raise ObservableSourceConflict("observable_source_upload_invalid")
            retained_files: list[dict[str, Any]] = []
            if retained:
                # Resolve only from the locked, expected parent. Never accept a
                # client-provided storage address or another source's object.
                rows = await transaction.fetch_all(
                    """
                    SELECT file.relative_path, object.id, object.bucket,
                           object.object_key, object.s3_version_id, object.etag,
                           object.content_type, object.size_bytes, object.checksum_sha256
                    FROM app.observable_source_revision_files file
                    JOIN app.observable_source_objects object
                      ON object.organization_id = file.organization_id
                     AND object.project_id = file.project_id
                     AND object.source_project_id = file.source_project_id
                     AND object.id = file.source_object_id
                    WHERE file.organization_id = %s AND file.project_id = %s
                      AND file.source_project_id = %s AND file.source_revision_id = %s
                      AND file.source_object_id = ANY(%s::uuid[])
                    """,
                    (
                        context.organization_id,
                        project_id,
                        source_project_id,
                        parent_revision_id,
                        [item.source_object_id for item in retained],
                    ),
                )
                expected = {item.source_object_id: item.relative_path for item in retained}
                if len(rows) != len(retained) or any(
                    expected.get(row[1]) != row[0] for row in rows
                ):
                    raise ObservableSourceConflict("observable_source_reuse_invalid")
                for row in rows:
                    file = self._revision_file(row)
                    if not file.s3_version_id or file.s3_version_id == "null":
                        raise ObservableSourceConflict("observable_source_reuse_invalid")
                    retained_files.append(
                        {
                            "path": file.relative_path,
                            "objectId": str(file.source_object_id),
                            "bucket": file.bucket,
                            "objectKey": file.object_key,
                            "s3VersionId": file.s3_version_id,
                            "etag": file.etag,
                            "contentType": file.content_type,
                            "sizeBytes": file.size_bytes,
                            "checksumSha256": file.checksum_sha256,
                        }
                    )
            by_upload = dict(zip((item.upload_id for item in intents), stored_objects, strict=True))
            for intent in intents:
                stored = by_upload[intent.upload_id]
                await transaction.execute(
                    """
                    INSERT INTO app.observable_source_objects
                      (id, organization_id, project_id, source_project_id,
                       upload_intent_id, relative_path, bucket, object_key,
                       s3_version_id, etag, content_type, size_bytes,
                       checksum_sha256, created_by)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                            %s, %s, %s, %s)
                    """,
                    (
                        object_ids[intent.upload_id],
                        context.organization_id,
                        project_id,
                        source_project_id,
                        intent.upload_id,
                        intent.relative_path,
                        stored.bucket,
                        stored.key,
                        stored.version_id,
                        stored.etag,
                        stored.content_type,
                        stored.size_bytes,
                        stored.checksum_sha256,
                        context.user_id,
                    ),
                )
            ordered = sorted(intents, key=lambda item: item.relative_path)
            manifest_files = [
                self._manifest_file(
                    intent,
                    by_upload[intent.upload_id],
                    object_ids[intent.upload_id],
                )
                for intent in ordered
            ]
            manifest_files = sorted(manifest_files + retained_files, key=lambda item: item["path"])
            if sum(item["sizeBytes"] for item in manifest_files) > 16_777_216:
                raise ObservableSourceConflict("observable_source_size_limit")
            manifest = {
                "schemaVersion": OBSERVABLE_SOURCE_MANIFEST_SCHEMA,
                "sourceProjectId": str(source_project_id),
                "revisionId": str(revision_id),
                "revisionNumber": next_revision,
                "entryPath": draft.entry_path,
                "lockfilePath": draft.lockfile_path,
                "files": manifest_files,
            }
            if draft.data_attachments:
                rows = await transaction.fetch_all(
                    self._attachment_select()
                    + """ WHERE attachment.organization_id = %s
                        AND attachment.project_id = %s AND attachment.source_project_id = %s
                        AND attachment.id = ANY(%s::uuid[])""",
                    (
                        context.organization_id,
                        project_id,
                        source_project_id,
                        [item.attachment_id for item in draft.data_attachments],
                    ),
                )
                attachments = {cast(UUID, row[0]): ObservableDataAttachment(*row) for row in rows}
                if any(
                    item.attachment_id not in attachments
                    or not attachments[item.attachment_id].available
                    for item in draft.data_attachments
                ):
                    raise ObservableSourceConflict("observable_data_attachment_unavailable")
                pins: list[dict[str, Any]] = []
                for binding in draft.data_attachments:
                    attachment = attachments[binding.attachment_id]
                    validate_observable_attachment_path(binding.relative_path)
                    validate_observable_attachment_media(
                        binding.relative_path, attachment.content_type
                    )
                    pins.append(
                        {
                            "path": binding.relative_path,
                            "attachmentId": str(attachment.id),
                            "datasetId": str(attachment.dataset_id),
                            "datasetVersionId": str(attachment.dataset_version_id),
                            "dataObjectId": str(attachment.data_object_id),
                            "s3VersionId": attachment.s3_version_id,
                            "checksumSha256": attachment.checksum_sha256,
                            "sizeBytes": attachment.size_bytes,
                            "contentType": attachment.content_type,
                        }
                    )
                if sum(item["sizeBytes"] for item in pins) > OBSERVABLE_MAX_ATTACHMENT_BYTES:
                    raise ObservableSourceConflict("observable_data_attachment_size_limit")
                manifest["schemaVersion"] = OBSERVABLE_SOURCE_DATA_MANIFEST_SCHEMA
                manifest["dataAttachments"] = pins
            if draft.referenced_files:
                rows = await transaction.fetch_all(
                    self._public_file_reference_select()
                    + """ WHERE reference.organization_id = %s AND reference.project_id = %s
                         AND reference.source_project_id = %s AND reference.id = ANY(%s::uuid[])""",
                    (
                        context.organization_id,
                        project_id,
                        source_project_id,
                        [item.reference_id for item in draft.referenced_files],
                    ),
                )
                references = {
                    cast(UUID, row[0]): ObservablePublicFileReference(*row) for row in rows
                }
                public_pins: list[dict[str, Any]] = []
                for reference_binding in draft.referenced_files:
                    reference = references.get(reference_binding.reference_id)
                    if reference is None or not reference.available:
                        raise ObservableSourceConflict(
                            "observable_public_file_reference_unavailable"
                        )
                    validate_observable_referenced_file_path(reference_binding.relative_path)
                    validate_observable_attachment_media(
                        reference_binding.relative_path, reference.content_type
                    )
                    public_pins.append(
                        {
                            "referenceId": str(reference.id),
                            "path": reference_binding.relative_path,
                            "kind": "referenced-public-file",
                            "custody": "referenced",
                            "datasetId": str(reference.dataset_id),
                            "sourceVersion": reference.source_version,
                            "resourceId": str(reference.resource_id),
                            "resourceVersionId": str(reference.resource_version_id),
                            "resourceVersionNumber": reference.resource_version_number,
                            "distributionId": reference.distribution_id,
                            "url": reference.url,
                            "contentType": reference.content_type,
                            "sizeBytes": reference.size_bytes,
                            "checksumSha256": reference.checksum_sha256,
                        }
                    )
                archive_pins = cast(list[dict[str, Any]], manifest.get("dataAttachments", []))
                if (
                    sum(item["sizeBytes"] for item in archive_pins + public_pins)
                    > OBSERVABLE_MAX_ATTACHMENT_BYTES
                ):
                    raise ObservableSourceConflict("observable_data_attachment_size_limit")
                manifest["schemaVersion"] = OBSERVABLE_SOURCE_REFERENCED_MANIFEST_SCHEMA
                manifest["dataAttachments"] = archive_pins
                manifest["referencedFiles"] = public_pins
            await transaction.execute(
                """
                INSERT INTO app.observable_source_revisions
                  (id, organization_id, project_id, source_project_id,
                   revision_number, parent_revision_id, title, rights_status,
                   entry_path, lockfile_path, manifest,
                   manifest_checksum_sha256, change_summary, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s::app.observable_source_rights_status, %s, %s,
                        %s, %s, %s, %s)
                """,
                (
                    revision_id,
                    context.organization_id,
                    project_id,
                    source_project_id,
                    next_revision,
                    parent_revision_id,
                    draft.title,
                    draft.rights_status,
                    draft.entry_path,
                    draft.lockfile_path,
                    Jsonb(manifest),
                    "0" * 64,
                    draft.change_summary,
                    context.user_id,
                ),
            )
            for position, manifest_file in enumerate(manifest_files):
                await transaction.execute(
                    """
                    INSERT INTO app.observable_source_revision_files
                      (organization_id, project_id, source_project_id,
                       source_revision_id, relative_path, source_object_id,
                       position, created_by)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        context.organization_id,
                        project_id,
                        source_project_id,
                        revision_id,
                        manifest_file["path"],
                        UUID(manifest_file["objectId"]),
                        position,
                        context.user_id,
                    ),
                )
            await transaction.execute(
                """
                UPDATE app.observable_source_projects
                SET current_revision_id = %s, current_revision_number = %s,
                    title = %s, rights_status = %s::app.observable_source_rights_status,
                    updated_by = %s
                WHERE organization_id = %s AND project_id = %s AND id = %s
                """,
                (
                    revision_id,
                    next_revision,
                    draft.title,
                    draft.rights_status,
                    context.user_id,
                    context.organization_id,
                    project_id,
                    source_project_id,
                ),
            )
            for intent in intents:
                await transaction.execute(
                    """
                    UPDATE app.observable_source_file_upload_intents
                    SET state = 'committed', completed_object_id = %s,
                        completed_at = clock_timestamp()
                    WHERE organization_id = %s AND source_project_id = %s AND id = %s
                    """,
                    (
                        object_ids[intent.upload_id],
                        context.organization_id,
                        source_project_id,
                        intent.upload_id,
                    ),
                )
            await self._record_event(
                transaction,
                context,
                project_id,
                "observable.source_revision.created",
                source_project_id,
                request_id,
                {
                    "revisionId": str(revision_id),
                    "revisionNumber": next_revision,
                    "parentRevisionId": (
                        str(parent_revision_id) if parent_revision_id is not None else None
                    ),
                    "entryPath": draft.entry_path,
                    "fileCount": len(manifest_files),
                    "inputBytes": sum(item["sizeBytes"] for item in manifest_files),
                    "uploadedFileCount": len(intents),
                    "reusedFileCount": len(retained_files),
                    "rightsStatus": draft.rights_status,
                },
            )
            return await self._load_revision(
                transaction, context, project_id, source_project_id, revision_id
            )

        return await self._run(context, commit)

    async def list_revisions(
        self, context: TenantContext, project_id: UUID, source_project_id: UUID
    ) -> tuple[ObservableSourceRevision, ...]:
        async def operation(
            transaction: TenantTransaction,
        ) -> tuple[ObservableSourceRevision, ...]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_READ, roles)
            await self._load_project(transaction, context, project_id, source_project_id)
            rows = await transaction.fetch_all(
                """
                SELECT id
                FROM app.observable_source_revisions
                WHERE organization_id = %s AND project_id = %s
                  AND source_project_id = %s
                ORDER BY revision_number DESC
                """,
                (context.organization_id, project_id, source_project_id),
            )
            return tuple(
                [
                    await self._load_revision(
                        transaction,
                        context,
                        project_id,
                        source_project_id,
                        cast(UUID, row[0]),
                    )
                    for row in rows
                ]
            )

        return await self._run(context, operation)

    async def list_revisions_page(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        limit: int = 25,
        before_revision: int | None = None,
    ) -> tuple[ObservableSourceRevision, ...]:
        if type(limit) is not int or not 1 <= limit <= 25:
            raise ValueError("Source revision page limit must be 1 through 25")
        if before_revision is not None and (
            type(before_revision) is not int or before_revision < 1
        ):
            raise ValueError("Source revision cursor must be positive")

        async def operation(transaction: TenantTransaction) -> tuple[ObservableSourceRevision, ...]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_READ, roles)
            await self._load_project(transaction, context, project_id, source_project_id)
            cursor_sql = " AND revision_number < %s" if before_revision is not None else ""
            params: tuple[Any, ...] = (context.organization_id, project_id, source_project_id)
            if before_revision is not None:
                params += (before_revision,)
            page = await transaction.fetch_all(
                f"""WITH page AS (
                    SELECT id, revision_number,
                      octet_length(concat_ws('', source_project_id::text, revision_number::text,
                        parent_revision_id::text, title, rights_status::text, entry_path,
                        lockfile_path, manifest::text, manifest_checksum_sha256,
                        change_summary, created_by::text, created_at::text)) AS header_bytes
                    FROM app.observable_source_revisions
                    WHERE organization_id = %s AND project_id = %s
                      AND source_project_id = %s {cursor_sql}
                    ORDER BY revision_number DESC LIMIT %s
                )
                SELECT page.id, 1024 + 6 * page.header_bytes + COALESCE((
                    SELECT SUM(1024 + 6 * octet_length(concat_ws('', file.relative_path,
                        object.id::text, object.bucket, object.object_key, object.s3_version_id,
                        object.etag, object.content_type, object.size_bytes::text,
                        object.checksum_sha256)))
                    FROM app.observable_source_revision_files file
                    JOIN app.observable_source_objects object
                      ON object.organization_id = file.organization_id
                     AND object.source_project_id = file.source_project_id
                     AND object.id = file.source_object_id
                    WHERE file.organization_id = %s AND file.project_id = %s
                      AND file.source_project_id = %s AND file.source_revision_id = page.id
                ), 0) AS estimated_bytes
                FROM page ORDER BY page.revision_number DESC""",
                (*params, limit, context.organization_id, project_id, source_project_id),
            )
            if not page:
                return ()
            # Conservative escaping/field overhead, not a measured Data API wire-byte total.
            if len(page) > limit or sum(int(row[1]) for row in page) > 524_288:
                raise ObservableSourceConflict("observable_source_revision_metadata_limit")
            ids = tuple(cast(UUID, row[0]) for row in page)
            placeholders = ", ".join(["%s"] * len(ids))
            rows = await transaction.fetch_all(
                f"""SELECT id, source_project_id, revision_number, parent_revision_id,
                           title, rights_status::text, entry_path, lockfile_path,
                           manifest, manifest_checksum_sha256, change_summary,
                           created_by, created_at, octet_length(manifest::text)
                    FROM app.observable_source_revisions
                    WHERE organization_id = %s AND project_id = %s
                      AND source_project_id = %s AND id IN ({placeholders})
                    ORDER BY revision_number DESC""",
                (context.organization_id, project_id, source_project_id, *ids),
            )
            if tuple(row[0] for row in rows) != ids:
                raise ObservableSourceConflict("observable_source_revision_metadata_changed")
            if sum(int(row[13]) for row in rows) > 2_097_152:
                raise ObservableSourceConflict("observable_source_revision_metadata_limit")
            files = await transaction.fetch_all(
                f"""SELECT file.source_revision_id, file.relative_path, object.id, object.bucket,
                           object.object_key, object.s3_version_id, object.etag,
                           object.content_type, object.size_bytes, object.checksum_sha256
                    FROM app.observable_source_revision_files file
                    JOIN app.observable_source_objects object
                      ON object.organization_id = file.organization_id
                     AND object.source_project_id = file.source_project_id
                     AND object.id = file.source_object_id
                    WHERE file.organization_id = %s AND file.project_id = %s
                      AND file.source_project_id = %s
                      AND file.source_revision_id IN ({placeholders})
                    ORDER BY file.source_revision_id, file.position LIMIT %s""",
                (context.organization_id, project_id, source_project_id, *ids, len(ids) * 128 + 1),
            )
            if (
                len(files) > len(ids) * 128
                or len(json.dumps(files, default=str).encode()) > 2_097_152
            ):
                raise ObservableSourceConflict("observable_source_revision_metadata_limit")
            grouped: dict[UUID, list[tuple[Any, ...]]] = {revision_id: [] for revision_id in ids}
            for file in files:
                revision_id = cast(UUID, file[0])
                if revision_id not in grouped or len(grouped[revision_id]) >= 128:
                    raise ObservableSourceConflict("observable_source_revision_metadata_limit")
                grouped[revision_id].append(file[1:])
            return tuple(
                self._revision_record(row[:13], grouped[cast(UUID, row[0])]) for row in rows
            )

        return await self._run(context, operation)

    async def read_revision_file(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        revision_id: UUID,
        relative_path: str,
    ) -> ObservableSourceFileContent:
        async def authorize_and_load(
            transaction: TenantTransaction,
        ) -> ObservableSourceRevisionFile:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_READ, roles)
            revision = await self._load_revision(
                transaction, context, project_id, source_project_id, revision_id
            )
            file = next(
                (item for item in revision.files if item.relative_path == relative_path),
                None,
            )
            if file is None:
                raise ObservableSourceNotFound("source_file")
            return file

        file = await self._run(context, authorize_and_load)
        try:
            stored = await self._download_storage.read_exact_object(
                ExactObjectSpec(
                    bucket=file.bucket,
                    key=file.object_key,
                    version_id=file.s3_version_id,
                    content_type=file.content_type,
                    size_bytes=file.size_bytes,
                    checksum_sha256=file.checksum_sha256,
                    maximum_bytes=4_194_304,
                )
            )
        except DownloadStorageUnavailable as error:
            raise ObservableSourceStoreUnavailable(
                "Observable source file could not be read"
            ) from error
        confirmed = await self._run(context, authorize_and_load)
        if confirmed != file:
            raise ObservableSourceConflict("observable_source_file_changed")
        return ObservableSourceFileContent(
            relative_path=file.relative_path,
            content_type=stored.content_type,
            size_bytes=stored.size_bytes,
            checksum_sha256=stored.checksum_sha256,
            body=stored.body,
        )

    async def request_revision_file_download(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        revision_id: UUID,
        relative_path: str,
    ) -> ObservableSourceFileDownloadTicket:
        async def authorize_and_load(
            transaction: TenantTransaction,
        ) -> ObservableSourceRevisionFile:
            self._require(
                Action.SITE_READ, await self._project_roles(transaction, context, project_id)
            )
            revision = await self._load_revision(
                transaction, context, project_id, source_project_id, revision_id
            )
            file = next(
                (item for item in revision.files if item.relative_path == relative_path), None
            )
            if file is None:
                raise ObservableSourceNotFound("source_file")
            validate_observable_source_file(file.relative_path, file.content_type, file.size_bytes)
            prefix = (
                f"organizations/{context.organization_id}/projects/{project_id}/"
                f"source-projects/{source_project_id}/uploads/"
            )
            if (
                re.fullmatch(
                    rf"{re.escape(prefix)}[0-9a-f-]{{36}}/files/{re.escape(file.relative_path)}",
                    file.object_key,
                )
                is None
                or not file.s3_version_id
                or file.s3_version_id == "null"
                or re.fullmatch(r"[0-9a-f]{64}", file.checksum_sha256) is None
            ):
                raise ObservableSourceConflict("observable_source_file_invalid")
            return file

        file = await self._run(context, authorize_and_load)
        try:
            download = await self._download_storage.create_download_url(
                DownloadSpec(
                    bucket=file.bucket,
                    key=file.object_key,
                    version_id=file.s3_version_id,
                    filename=file.relative_path.rsplit("/", 1)[-1],
                )
            )
        except DownloadStorageUnavailable as error:
            raise ObservableSourceStoreUnavailable(
                "Observable source file download is unavailable"
            ) from error
        confirmed = await self._run(context, authorize_and_load)
        if confirmed != file:
            raise ObservableSourceConflict("observable_source_file_changed")
        return ObservableSourceFileDownloadTicket(file=file, download=download)

    async def create_build_job(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        source_revision_id: UUID,
        purpose: ObservableBuildPurpose,
        request_id: str,
        idempotency_key: UUID | None = None,
        artifact_input_id: UUID | None = None,
        output_profile: str = "default-32m",
        size_acknowledgment: str | None = None,
        distribution_approval_id: UUID | None = None,
        output_representation: Literal["single-html"] | None = None,
    ) -> ObservableBuildJob:
        build_job_id = idempotency_key or uuid4()

        async def operation(transaction: TenantTransaction) -> ObservableBuildJob:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_MANAGE, roles)
            project = await self._load_project(
                transaction, context, project_id, source_project_id, for_share=True
            )
            revision = await self._load_revision(
                transaction, context, project_id, source_project_id, source_revision_id
            )
            if (
                revision.manifest.get("schemaVersion")
                == OBSERVABLE_SOURCE_REFERENCED_MANIFEST_SCHEMA
            ):
                if (purpose != "preview" and distribution_approval_id is None) or (
                    purpose == "preview" and distribution_approval_id is not None
                ):
                    raise ObservableSourceConflict(
                        "observable_referenced_file_publication_unavailable"
                    )
                if artifact_input_id is not None or (
                    purpose == "preview"
                    and output_representation is None
                    and output_profile != "default-32m"
                ):
                    raise ObservableSourceConflict(
                        "observable_referenced_file_composition_unsupported"
                    )
                await transaction.fetch_one(
                    "SELECT app.validate_observable_revision_input_bindings(%s,%s,%s,%s)",
                    (
                        context.organization_id,
                        project_id,
                        source_project_id,
                        Jsonb(revision.manifest),
                    ),
                )
            localized = output_representation is not None
            if localized and (
                output_representation != "single-html"
                or revision.entry_path not in {"index.md", "src/index.md"}
            ):
                raise ObservableSourceConflict("observable_localized_entry_unsupported")
            if localized and artifact_input_id is not None:
                raise ObservableSourceConflict("observable_localized_artifact_unsupported")
            from opengeo_api.publication_artifact_references import latest_references

            reference_set = await latest_references(transaction, context, source_project_id)
            artifact_inputs = None
            if artifact_input_id is not None:
                if not self._artifact_builds:
                    raise ObservableSourceConflict("publication_artifact_staging_unavailable")
                if purpose != "preview" and distribution_approval_id is None:
                    raise ObservableSourceConflict("publication_artifact_release_unavailable")
                from opengeo_api.publication_artifact_inputs import read_inputs_in_transaction

                artifact_inputs = await read_inputs_in_transaction(
                    self, transaction, context, project_id, source_project_id, artifact_input_id
                )
                if artifact_inputs["manifest"]["sourceRevisionId"] != str(source_revision_id):
                    raise ObservableSourceConflict("publication_artifact_source_revision_mismatch")
            elif reference_set["references"]:
                raise ObservableSourceConflict("publication_artifact_staging_unavailable")
            if self._github_builds:
                await self._github_build_connection(transaction, context)
            # The existing durable primary key is the request identity. Serialize
            # retries before checking it; reauthorize on every retry and never
            # reuse a job belonging to a different actor or source revision.
            if idempotency_key is not None:
                await transaction.fetch_one(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))::text",
                    ("observable-build:" + str(build_job_id),),
                )
                row = await transaction.fetch_one(
                    "SELECT id FROM app.observable_build_jobs "
                    "WHERE organization_id = %s AND project_id = %s AND id = %s",
                    (context.organization_id, project_id, build_job_id),
                )
                if row is not None:
                    previous = await self._load_build_job(
                        transaction, context, project_id, build_job_id
                    )
                    if (
                        previous.created_by != context.user_id
                        or previous.source_project_id != source_project_id
                        or previous.source_revision_id != source_revision_id
                        or previous.purpose != purpose
                        or previous.request.get("outputProfile", "default-32m") != output_profile
                        or previous.request.get("sizeAcknowledgment") != size_acknowledgment
                        or previous.request.get("outputRepresentation") != output_representation
                        or previous.request.get("distributionApprovalId")
                        != (str(distribution_approval_id) if distribution_approval_id else None)
                        or previous.request.get("artifactInputsChecksumSha256")
                        != (
                            artifact_inputs["manifest_checksum_sha256"] if artifact_inputs else None
                        )
                    ):
                        raise ObservableSourceConflict("observable_build_idempotency_mismatch")
                    from opengeo_api.publication_artifact_leases import reauthorize_artifact_request

                    await reauthorize_artifact_request(
                        self,
                        transaction,
                        context,
                        project_id,
                        source_project_id,
                        source_revision_id,
                        previous.request,
                    )
                    return previous
            if (
                revision.manifest.get("schemaVersion") == OBSERVABLE_SOURCE_DATA_MANIFEST_SCHEMA
                and purpose != "preview"
                and distribution_approval_id is None
                and not (localized and not revision.manifest.get("dataAttachments"))
            ):
                raise ObservableSourceConflict("observable_data_attachment_publication_unavailable")
            if purpose == "release_candidate" and revision.rights_status != "approved":
                raise ObservableSourceConflict("observable_source_rights_unapproved")
            from opengeo_api.observable_distribution_approvals import (
                SIZE_ACKNOWLEDGMENT,
                read_distribution_approval,
            )

            if (
                output_profile not in {"default-32m", "archive-96m"}
                or (
                    (output_profile == "archive-96m")
                    != (size_acknowledgment == SIZE_ACKNOWLEDGMENT)
                )
                or (output_profile == "default-32m" and size_acknowledgment is not None)
            ):
                raise ObservableSourceConflict("observable_output_profile_consent_required")
            if output_profile == "archive-96m" and not (
                revision.manifest.get("dataAttachments") or revision.manifest.get("referencedFiles")
            ):
                raise ObservableSourceConflict("observable_output_profile_archive_required")
            distribution_approval = None
            if distribution_approval_id is not None:
                distribution_approval = await read_distribution_approval(
                    self,
                    transaction,
                    context,
                    project_id,
                    source_project_id,
                    source_revision_id,
                    distribution_approval_id,
                    project.compiler_image_digest,
                    output_profile,
                    artifact_inputs["manifest_checksum_sha256"] if artifact_inputs else None,
                )
            lockfile_checksum = next(
                (
                    item.checksum_sha256
                    for item in revision.files
                    if item.relative_path == revision.lockfile_path
                ),
                None,
            )
            request = {
                "schemaVersion": OBSERVABLE_BUILD_REQUEST_SCHEMA,
                "sourceProjectId": str(source_project_id),
                "sourceRevisionId": str(source_revision_id),
                "sourceRevisionNumber": revision.revision_number,
                "sourceManifestChecksumSha256": revision.manifest_checksum_sha256,
                "purpose": purpose,
                "compilerImageDigest": project.compiler_image_digest,
                "frameworkVersion": project.framework_version,
                "lockfileFormat": project.lockfile_format,
                "lockfileChecksumSha256": lockfile_checksum,
                "networkPolicy": project.network_policy,
                "resourceLimits": project.resource_limits,
            }
            if artifact_inputs is not None:
                request.update(
                    schemaVersion="opengeo.observable-build-request.2.0.0",
                    artifactInputsChecksumSha256=artifact_inputs["manifest_checksum_sha256"],
                )
            if (
                localized
                or output_profile != "default-32m"
                or distribution_approval is not None
                or (artifact_inputs is not None and revision.manifest.get("dataAttachments"))
            ):
                request.update(
                    schemaVersion=(
                        "opengeo.observable-build-request.4.0.0"
                        if localized
                        else "opengeo.observable-build-request.3.0.0"
                    ),
                    outputProfile=output_profile,
                    sizeAcknowledgment=size_acknowledgment,
                    distributionApprovalId=distribution_approval["id"]
                    if distribution_approval
                    else None,
                    distributionApprovalChecksumSha256=distribution_approval[
                        "manifest_checksum_sha256"
                    ]
                    if distribution_approval
                    else None,
                )
                if localized:
                    request["outputRepresentation"] = "single-html"
            # A new browser request ID does not imply new compilation. Serialize
            # equivalent requests per actor/source, then reuse an authorized job
            # with exactly the same immutable inputs and compiler policy. Failed
            # jobs are excluded so an explicit new attempt remains possible.
            await transaction.fetch_one(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))::text",
                (
                    f"observable-build-inputs:{context.organization_id}:{source_project_id}:{context.user_id}",
                ),
            )
            reusable = await transaction.fetch_one(
                """SELECT id FROM app.observable_build_jobs
                   WHERE organization_id = %s AND project_id = %s
                     AND source_project_id = %s AND source_revision_id = %s
                     AND created_by = %s AND request = %s::jsonb
                     AND (state IN ('pending', 'running')
                       OR (state = 'succeeded' AND result_checksum_sha256 IS NOT NULL))
                   ORDER BY CASE WHEN state = 'succeeded' THEN 0 ELSE 1 END,
                     created_at DESC, id
                   LIMIT 1""",
                (
                    context.organization_id,
                    project_id,
                    source_project_id,
                    source_revision_id,
                    context.user_id,
                    Jsonb(request),
                ),
            )
            if reusable is not None:
                previous = await self._load_build_job(transaction, context, project_id, reusable[0])
                if (
                    previous.created_by != context.user_id
                    or previous.source_project_id != source_project_id
                    or previous.source_revision_id != source_revision_id
                    or previous.request != request
                    or previous.state not in {"pending", "running", "succeeded"}
                ):
                    raise ObservableSourceConflict("observable_build_reuse_mismatch")
                return previous
            output_prefix = (
                f"organizations/{context.organization_id}/projects/{project_id}/"
                f"source-projects/{source_project_id}/builds/{build_job_id}/output/"
            )
            await transaction.execute(
                """
                INSERT INTO app.observable_build_jobs
                  (id, organization_id, project_id, source_project_id,
                   source_revision_id, source_revision_number, purpose,
                   request, request_checksum_sha256, output_prefix, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s::app.observable_build_purpose, %s, %s, %s, %s)
                """,
                (
                    build_job_id,
                    context.organization_id,
                    project_id,
                    source_project_id,
                    source_revision_id,
                    revision.revision_number,
                    purpose,
                    Jsonb(request),
                    "0" * 64,
                    output_prefix,
                    context.user_id,
                ),
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "observable.build_job.staged",
                source_project_id,
                request_id,
                {
                    "buildJobId": str(build_job_id),
                    "sourceRevisionId": str(source_revision_id),
                    "sourceRevisionNumber": revision.revision_number,
                    "purpose": purpose,
                    "executionAvailable": False,
                },
            )
            return await self._load_build_job(transaction, context, project_id, build_job_id)

        return await self._run(context, operation)

    async def get_build_job(
        self, context: TenantContext, project_id: UUID, build_job_id: UUID
    ) -> ObservableBuildJob:
        async def operation(transaction: TenantTransaction) -> ObservableBuildJob:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_READ, roles)
            return await self._load_build_job(transaction, context, project_id, build_job_id)

        return await self._run(context, operation)

    async def list_build_jobs(
        self,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        limit: int = 25,
        offset: int = 0,
    ) -> tuple[ObservableBuildJob, ...]:
        if not 1 <= limit <= 100 or not 0 <= offset <= 100_000:
            raise ObservableSourceConflict("observable_build_page_invalid")

        async def operation(transaction: TenantTransaction) -> tuple[ObservableBuildJob, ...]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_READ, roles)
            await self._load_project(transaction, context, project_id, source_project_id)
            rows = await transaction.fetch_all(
                """
                SELECT id, source_project_id, source_revision_id,
                       source_revision_number, purpose::text, state::text,
                       request, request_checksum_sha256, output_prefix, result,
                       result_checksum_sha256, attempt_count, error_code,
                       created_by, created_at, started_at, finished_at, updated_at
                FROM app.observable_build_jobs
                WHERE organization_id = %s AND project_id = %s AND source_project_id = %s
                ORDER BY created_at DESC, id DESC LIMIT %s OFFSET %s
                """,
                (context.organization_id, project_id, source_project_id, limit, offset),
            )
            return tuple(self._build_job(row) for row in rows)

        return await self._run(context, operation)

    async def authorize_build_dispatch(
        self, context: TenantContext, project_id: UUID, build_job_id: UUID
    ) -> ObservableBuildJob:
        async def operation(transaction: TenantTransaction) -> ObservableBuildJob:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SITE_MANAGE, roles)
            record = await self._load_build_job(transaction, context, project_id, build_job_id)
            if record.state != "pending":
                raise ObservableSourceConflict("observable_build_not_pending")
            await self._require_reference_staging_ready(
                transaction,
                context,
                project_id,
                record.source_project_id,
                record.source_revision_id,
            )
            from opengeo_api.publication_artifact_leases import reauthorize_artifact_request

            await reauthorize_artifact_request(
                self,
                transaction,
                context,
                project_id,
                record.source_project_id,
                record.source_revision_id,
                record.request,
            )
            return record

        return await self._run(context, operation)

    async def create_preview_capability(
        self,
        context: TenantContext,
        project_id: UUID,
        build_job_id: UUID,
        request_id: str,
        runtime_profile: ObservablePreviewRuntimeProfile = "local_only",
    ) -> ObservablePreviewCapability:
        capability_id = uuid4()
        capability = _encode_preview_capability(capability_id, context, runtime_profile)
        token_checksum = hashlib.sha256(capability.encode("ascii")).hexdigest()

        async def operation(transaction: TenantTransaction) -> ObservablePreviewCapability:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(
                Action.SITE_MANAGE if runtime_profile == "public_maps_v1" else Action.SITE_READ,
                roles,
            )
            job = await self._load_build_job(transaction, context, project_id, build_job_id)
            if job.state != "succeeded" or job.result is None:
                raise ObservableSourceConflict("observable_preview_build_not_ready")
            await self._require_reference_staging_ready(
                transaction, context, project_id, job.source_project_id, job.source_revision_id
            )
            if runtime_profile == "public_maps_v1":
                rights = await transaction.fetch_one(
                    """
                    SELECT rights_status::text FROM app.observable_source_revisions
                    WHERE organization_id=%s AND project_id=%s
                      AND source_project_id=%s AND id=%s
                    """,
                    (
                        context.organization_id,
                        project_id,
                        job.source_project_id,
                        job.source_revision_id,
                    ),
                )
                if rights is None or rights[0] != "approved":
                    raise ObservableSourceConflict("observable_source_rights_unapproved")
            from opengeo_api.publication_artifact_leases import reauthorize_artifact_request

            await reauthorize_artifact_request(
                self,
                transaction,
                context,
                project_id,
                job.source_project_id,
                job.source_revision_id,
                job.request,
            )
            row = await transaction.fetch_one(
                """
                INSERT INTO app.observable_preview_capabilities
                  (id, organization_id, project_id, build_job_id, requested_by,
                   token_checksum_sha256, expires_at)
                VALUES (%s, %s, %s, %s, %s, %s,
                        clock_timestamp() + interval '60 seconds')
                RETURNING expires_at
                """,
                (
                    capability_id,
                    context.organization_id,
                    project_id,
                    build_job_id,
                    context.user_id,
                    token_checksum,
                ),
            )
            if row is None:
                raise ObservableSourceStoreUnavailable("preview capability insert failed")
            expires_at = cast(datetime, row[0])
            await self._record_event(
                transaction,
                context,
                project_id,
                "observable.preview_capability.created",
                job.source_project_id,
                request_id,
                {
                    "buildJobId": str(build_job_id),
                    "capabilityId": str(capability_id),
                    "expiresAt": expires_at.isoformat(),
                    "publicationAuthorized": False,
                    "runtimeProfile": runtime_profile,
                },
            )
            return ObservablePreviewCapability(capability=capability, expires_at=expires_at)

        return await self._run(context, operation)

    async def exchange_preview_capability(self, capability: str) -> ObservablePreviewGrant:
        parsed = _parse_preview_capability(capability)
        context = TenantContext(
            user_id=parsed.user_id,
            organization_id=parsed.organization_id,
        )

        async def operation(transaction: TenantTransaction) -> ObservablePreviewGrant:
            row = await transaction.fetch_one(
                """
                SELECT issued.output_prefix, issued.entry_file, issued.cookie_expires_at,
                       job.project_id, job.source_project_id, job.source_revision_id, job.request
                FROM app.consume_observable_preview_capability(%s, %s, %s, %s) AS issued
                JOIN app.observable_preview_capabilities capability ON capability.id=%s
                JOIN app.observable_build_jobs job ON job.organization_id=capability.organization_id
                  AND job.id=capability.build_job_id
                """,
                (
                    parsed.capability_id,
                    parsed.organization_id,
                    parsed.user_id,
                    hashlib.sha256(capability.encode("ascii")).hexdigest(),
                    parsed.capability_id,
                ),
            )
            if row is None:
                raise ObservablePreviewCapabilityInvalid("preview capability is invalid")
            await self._require_reference_staging_ready(
                transaction, context, row[3], row[4], row[5]
            )
            if parsed.runtime_profile == "public_maps_v1":
                self._require(
                    Action.SITE_MANAGE,
                    await self._project_roles(transaction, context, row[3]),
                )
            from opengeo_api.publication_artifact_leases import reauthorize_artifact_request

            await reauthorize_artifact_request(
                self, transaction, context, row[3], row[4], row[5], row[6]
            )
            output_prefix = cast(str, row[0])
            entry_file = cast(str, row[1])
            prefix_match = _OUTPUT_PREFIX.fullmatch(output_prefix)
            if (
                prefix_match is None
                or prefix_match.group(1) != str(parsed.organization_id)
                or _OUTPUT_PATH.fullmatch(entry_file) is None
                or entry_file.startswith("dist/.")
                or "/." in entry_file
                or not entry_file.endswith(".html")
            ):
                raise ObservablePreviewCapabilityInvalid("preview capability output is invalid")
            return ObservablePreviewGrant(
                output_prefix=output_prefix,
                entry_file=entry_file,
                expires_at=cast(datetime, row[2]),
                runtime_profile=parsed.runtime_profile,
            )

        return await self._run(context, operation)

    @staticmethod
    async def _require_reference_staging_ready(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        source_revision_id: UUID,
    ) -> None:
        row = await transaction.fetch_one(
            """SELECT manifest->>'schemaVersion',
                      CASE WHEN manifest->>'schemaVersion' =
                        'opengeo.observable-source-revision.3.0.0' THEN manifest END
               FROM app.observable_source_revisions
               WHERE organization_id = %s AND project_id = %s
                 AND source_project_id = %s AND id = %s""",
            (context.organization_id, project_id, source_project_id, source_revision_id),
        )
        if row is None:
            raise ObservableSourceNotFound("source_revision")
        if row[0] == OBSERVABLE_SOURCE_REFERENCED_MANIFEST_SCHEMA:
            await transaction.fetch_one(
                "SELECT app.validate_observable_revision_input_bindings(%s,%s,%s,%s)",
                (context.organization_id, project_id, source_project_id, Jsonb(row[1])),
            )

    async def _load_project(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        *,
        for_share: bool = False,
    ) -> ObservableSourceProject:
        if for_share:
            # Acquire the servicing lock in its own statement. Reading the
            # effective policy afterward gets a fresh READ COMMITTED snapshot
            # if a transition committed while this statement was waiting.
            locked = await transaction.fetch_one(
                """SELECT id FROM app.observable_source_projects
                   WHERE organization_id = %s AND project_id = %s AND id = %s
                   FOR SHARE""",
                (context.organization_id, project_id, source_project_id),
            )
            if locked is None:
                raise ObservableSourceNotFound("source_project")
        row = await transaction.fetch_one(
            f"""{self._project_select()}
            WHERE source.organization_id = %s AND source.project_id = %s
              AND source.id = %s
            """,
            (context.organization_id, project_id, source_project_id),
        )
        if row is None:
            raise ObservableSourceNotFound("source_project")
        return self._project(row)

    async def _load_revision(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        source_project_id: UUID,
        revision_id: UUID,
    ) -> ObservableSourceRevision:
        row = await transaction.fetch_one(
            """
            SELECT id, source_project_id, revision_number, parent_revision_id,
                   title, rights_status::text, entry_path, lockfile_path,
                   manifest, manifest_checksum_sha256, change_summary,
                   created_by, created_at
            FROM app.observable_source_revisions
            WHERE organization_id = %s AND project_id = %s
              AND source_project_id = %s AND id = %s
            """,
            (context.organization_id, project_id, source_project_id, revision_id),
        )
        if row is None:
            raise ObservableSourceNotFound("source_revision")
        files = await transaction.fetch_all(
            """
            SELECT file.relative_path, object.id, object.bucket,
                   object.object_key, object.s3_version_id, object.etag,
                   object.content_type, object.size_bytes,
                   object.checksum_sha256
            FROM app.observable_source_revision_files file
            JOIN app.observable_source_objects object
              ON object.organization_id = file.organization_id
             AND object.source_project_id = file.source_project_id
             AND object.id = file.source_object_id
            WHERE file.organization_id = %s AND file.project_id = %s
              AND file.source_project_id = %s AND file.source_revision_id = %s
            ORDER BY file.position
            """,
            (context.organization_id, project_id, source_project_id, revision_id),
        )
        return self._revision_record(row, files)

    async def _load_build_job(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        build_job_id: UUID,
    ) -> ObservableBuildJob:
        row = await transaction.fetch_one(
            """
            SELECT id, source_project_id, source_revision_id,
                   source_revision_number, purpose::text, state::text,
                   request, request_checksum_sha256, output_prefix, result,
                   result_checksum_sha256, attempt_count, error_code,
                   created_by, created_at, started_at, finished_at, updated_at
            FROM app.observable_build_jobs
            WHERE organization_id = %s AND project_id = %s AND id = %s
            """,
            (context.organization_id, project_id, build_job_id),
        )
        if row is None:
            raise ObservableSourceNotFound("build_job")
        return self._build_job(row)

    async def _project_roles(
        self, transaction: TenantTransaction, context: TenantContext, project_id: UUID
    ) -> Roles:
        organization = await transaction.fetch_one(
            """
            SELECT role::text FROM app.organization_memberships
            WHERE organization_id = %s AND user_id = %s
            """,
            (context.organization_id, context.user_id),
        )
        if organization is None:
            raise ObservableSourceAccessDenied("organization membership required")
        project = await transaction.fetch_one(
            """
            SELECT project.id, app.effective_project_role(project.id, %s)::text
            FROM app.projects project
            WHERE project.organization_id = %s AND project.id = %s
            """,
            (context.user_id, context.organization_id, project_id),
        )
        if project is None:
            raise ObservableSourceNotFound("project")
        return Roles(
            organization=cast(OrganizationRole, organization[0]),
            project=cast(ProjectRole | None, project[1]),
        )

    @staticmethod
    def _require(action: Action, roles: Roles) -> None:
        try:
            authorize(action, roles)
        except AuthorizationDenied as error:
            raise ObservableSourceAccessDenied("action forbidden") from error

    @staticmethod
    async def _record_event(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        event_type: str,
        resource_id: UUID,
        request_id: str,
        payload: dict[str, Any],
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.activity_events
              (organization_id, actor_user_id, project_id, event_type,
               resource_type, resource_id, request_id, payload)
            VALUES (%s, %s, %s, %s, 'observable_source_project', %s, %s, %s)
            """,
            (
                context.organization_id,
                context.user_id,
                project_id,
                event_type,
                resource_id,
                request_id,
                Jsonb(payload),
            ),
        )

    @staticmethod
    def _validate_revision_draft(draft: ObservableSourceRevisionDraft) -> None:
        if any((item.upload_id is None) == (item.source_object_id is None) for item in draft.files):
            raise ObservableSourceConflict("observable_source_file_reference_invalid")
        references = [(item.upload_id, item.source_object_id) for item in draft.files]
        if len(set(references)) != len(references):
            raise ObservableSourceConflict("observable_source_file_reference_invalid")
        paths = [item.relative_path for item in draft.files]
        if paths != sorted(paths):
            raise ObservableSourceConflict("observable_source_manifest_not_sorted")
        if len({path.casefold() for path in paths}) != len(paths):
            raise ObservableSourceConflict("observable_source_path_collision")
        if draft.entry_path not in paths:
            raise ObservableSourceConflict("observable_source_entry_missing")
        static_html = draft.entry_path == "index.html" or draft.entry_path.endswith("/index.html")
        jupyter = draft.entry_path.lower().endswith(".ipynb")
        if not static_html and not jupyter and not draft.entry_path.lower().endswith(".md"):
            raise ObservableSourceConflict("observable_source_entry_invalid")
        if jupyter:
            prefix = draft.entry_path.rsplit("/", 1)[0] + "/" if "/" in draft.entry_path else ""
            if draft.lockfile_path is not None or any(
                not path.startswith(prefix)
                for path in [
                    *paths,
                    *(item.relative_path for item in draft.data_attachments),
                    *(item.relative_path for item in draft.referenced_files),
                ]
            ):
                raise ObservableSourceConflict("jupyter_source_tree_invalid")
        if static_html:
            prefix = draft.entry_path[: -len("index.html")]
            if draft.lockfile_path is not None or any(
                not path.startswith(prefix)
                or path.lower().endswith(".md")
                or path.rsplit("/", 1)[-1].lower()
                in {
                    "package.json",
                    "package-lock.json",
                    "observablehq.config.js",
                    "observablehq.config.mjs",
                    "observablehq.config.cjs",
                    "opengeo.observable.json",
                }
                for path in [
                    *paths,
                    *(item.relative_path for item in draft.data_attachments),
                    *(item.relative_path for item in draft.referenced_files),
                ]
            ):
                raise ObservableSourceConflict("static_html_public_tree_invalid")
        if draft.lockfile_path is not None and draft.lockfile_path not in paths:
            raise ObservableSourceConflict("observable_source_lockfile_missing")
        if "package.json" in paths and draft.lockfile_path != "package-lock.json":
            raise ObservableSourceConflict("observable_source_lockfile_required")
        binding_paths = [item.relative_path for item in draft.data_attachments]
        if binding_paths != sorted(binding_paths):
            raise ObservableSourceConflict("observable_data_attachment_not_sorted")
        public_paths = [item.relative_path for item in draft.referenced_files]
        if public_paths != sorted(public_paths):
            raise ObservableSourceConflict("observable_public_file_reference_not_sorted")
        for path in public_paths:
            validate_observable_referenced_file_path(path)
        binding_paths += public_paths
        if len(paths) + len(binding_paths) > 128:
            raise ObservableSourceConflict("observable_source_file_limit")
        for path in binding_paths:
            validate_observable_attachment_path(path)
        combined = sorted(path.casefold() for path in paths + binding_paths)
        if any(
            left == right or right.startswith(left + "/")
            for index, left in enumerate(combined)
            for right in combined[index + 1 :]
        ):
            raise ObservableSourceConflict("observable_source_path_collision")

    @staticmethod
    def _verify_stored_object(intent: _UploadIntent, stored: StoredObject) -> None:
        if (
            stored.bucket != intent.bucket
            or stored.key != intent.object_key
            or stored.content_type != intent.content_type
            or stored.size_bytes != intent.size_bytes
            or stored.checksum_sha256 != intent.checksum_sha256
            or not stored.version_id
            or stored.version_id == "null"
            or not stored.etag
        ):
            raise ObservableSourceConflict("observable_source_upload_object_mismatch")

    @staticmethod
    def _manifest_file(
        intent: _UploadIntent, stored: StoredObject, object_id: UUID
    ) -> dict[str, Any]:
        return {
            "path": intent.relative_path,
            "objectId": str(object_id),
            "bucket": stored.bucket,
            "objectKey": stored.key,
            "s3VersionId": stored.version_id,
            "etag": stored.etag,
            "contentType": stored.content_type,
            "sizeBytes": stored.size_bytes,
            "checksumSha256": stored.checksum_sha256,
        }

    @staticmethod
    def _project_select() -> str:
        return """
            SELECT source.id, source.project_id, source.site_id,
                   source.route_namespace, source.title,
                   source.rights_status::text, source.owner_user_id,
                   source.current_revision_id, source.current_revision_number,
                   app.observable_effective_compiler_digest(source.organization_id, source.id),
                   source.framework_version,
                   source.lockfile_format, source.network_policy,
                   source.resource_limits, source.created_by, source.created_at,
                   source.updated_by, source.updated_at
            FROM app.observable_source_projects source
        """

    @staticmethod
    def _project(row: tuple[Any, ...]) -> ObservableSourceProject:
        return ObservableSourceProject(
            source_project_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            site_id=cast(UUID, row[2]),
            route_namespace=cast(str, row[3]),
            title=cast(str, row[4]),
            rights_status=cast(ObservableRightsStatus, row[5]),
            owner_user_id=cast(UUID, row[6]),
            current_revision_id=cast(UUID | None, row[7]),
            current_revision_number=cast(int, row[8]),
            compiler_image_digest=cast(str, row[9]),
            framework_version=cast(str, row[10]),
            lockfile_format=cast(str, row[11]),
            network_policy=cast(str, row[12]),
            resource_limits=cast(dict[str, int], row[13]),
            created_by=cast(UUID, row[14]),
            created_at=cast(datetime, row[15]),
            updated_by=cast(UUID, row[16]),
            updated_at=cast(datetime, row[17]),
        )

    @staticmethod
    def _upload_intent(row: tuple[Any, ...]) -> _UploadIntent:
        return _UploadIntent(
            upload_id=cast(UUID, row[0]),
            relative_path=cast(str, row[1]),
            content_type=cast(str, row[2]),
            size_bytes=cast(int, row[3]),
            checksum_sha256=cast(str, row[4]),
            bucket=cast(str, row[5]),
            object_key=cast(str, row[6]),
            expires_at=cast(datetime, row[7]),
        )

    def _revision_record(
        self,
        row: tuple[Any, ...],
        files: Sequence[tuple[Any, ...]],
    ) -> ObservableSourceRevision:
        return ObservableSourceRevision(
            revision_id=cast(UUID, row[0]),
            source_project_id=cast(UUID, row[1]),
            revision_number=cast(int, row[2]),
            parent_revision_id=cast(UUID | None, row[3]),
            title=cast(str, row[4]),
            rights_status=cast(ObservableRightsStatus, row[5]),
            entry_path=cast(str, row[6]),
            lockfile_path=cast(str | None, row[7]),
            manifest=cast(dict[str, Any], row[8]),
            manifest_checksum_sha256=cast(str, row[9]),
            change_summary=cast(str, row[10]),
            created_by=cast(UUID, row[11]),
            created_at=cast(datetime, row[12]),
            files=tuple(self._revision_file(item) for item in files),
        )

    @staticmethod
    def _revision_file(row: tuple[Any, ...]) -> ObservableSourceRevisionFile:
        return ObservableSourceRevisionFile(
            relative_path=cast(str, row[0]),
            source_object_id=cast(UUID, row[1]),
            bucket=cast(str, row[2]),
            object_key=cast(str, row[3]),
            s3_version_id=cast(str, row[4]),
            etag=cast(str, row[5]),
            content_type=cast(str, row[6]),
            size_bytes=cast(int, row[7]),
            checksum_sha256=cast(str, row[8]),
        )

    @staticmethod
    def _build_job(row: tuple[Any, ...]) -> ObservableBuildJob:
        return ObservableBuildJob(
            build_job_id=cast(UUID, row[0]),
            source_project_id=cast(UUID, row[1]),
            source_revision_id=cast(UUID, row[2]),
            source_revision_number=cast(int, row[3]),
            purpose=cast(ObservableBuildPurpose, row[4]),
            state=cast(ObservableBuildState, row[5]),
            request=cast(dict[str, Any], row[6]),
            request_checksum_sha256=cast(str, row[7]),
            output_prefix=cast(str, row[8]),
            result=cast(dict[str, Any] | None, row[9]),
            result_checksum_sha256=cast(str | None, row[10]),
            attempt_count=cast(int, row[11]),
            error_code=cast(str | None, row[12]),
            created_by=cast(UUID, row[13]),
            created_at=cast(datetime, row[14]),
            started_at=cast(datetime | None, row[15]),
            finished_at=cast(datetime | None, row[16]),
            updated_at=cast(datetime, row[17]),
        )


def validate_observable_attachment_path(relative_path: str) -> None:
    if (
        not 1 <= len(relative_path) <= 512
        or _SOURCE_PATH.fullmatch(relative_path) is None
        or _FORBIDDEN_DIRECTORY.search(relative_path) is not None
        or _SECRET_FILE.search(relative_path) is not None
        or not re.search(
            r"\.(?:json|geojson|csv|txt|png|jpe?g|tiff?)$", relative_path, re.IGNORECASE
        )
        or relative_path.rsplit("/", 1)[-1].lower() in {"package.json", "package-lock.json"}
    ):
        raise ObservableSourceConflict("observable_data_attachment_path_invalid")


def validate_observable_referenced_file_path(relative_path: str) -> None:
    validate_observable_attachment_path(relative_path)
    if not relative_path.lower().endswith((".tif", ".tiff")):
        raise ObservableSourceConflict("observable_public_file_reference_path_invalid")


def validate_observable_attachment_media(relative_path: str, content_type: str) -> None:
    validate_observable_attachment_path(relative_path)
    if re.search(r"\.tiff?$", relative_path, re.IGNORECASE):
        if content_type not in {"image/tiff", "image/geotiff"}:
            raise ObservableSourceConflict("observable_source_media_unsupported")
        return
    # Archive admission does not expand executable source or source-upload limits.
    validate_observable_source_file(relative_path, content_type, 1)


def validate_observable_source_file(relative_path: str, content_type: str, size_bytes: int) -> None:
    if (
        not 1 <= len(relative_path) <= 512
        or _SOURCE_PATH.fullmatch(relative_path) is None
        or _FORBIDDEN_DIRECTORY.search(relative_path) is not None
        or _SECRET_FILE.search(relative_path) is not None
        or not 1 <= size_bytes <= 4_194_304
    ):
        raise ObservableSourceConflict("observable_source_path_invalid")
    supported = next(
        (allowed for pattern, allowed in _SOURCE_MEDIA if pattern.search(relative_path)),
        None,
    )
    if supported is None or content_type not in supported:
        raise ObservableSourceConflict("observable_source_media_unsupported")


def _encode_preview_capability(
    capability_id: UUID,
    context: TenantContext,
    runtime_profile: ObservablePreviewRuntimeProfile = "local_only",
) -> str:
    if runtime_profile not in {"local_only", "public_maps_v1"}:
        raise ObservableSourceConflict("observable_preview_runtime_profile_invalid")
    payload_values = {
        "capabilityId": str(capability_id),
        "organizationId": str(context.organization_id),
        "userId": str(context.user_id),
        "secret": secrets.token_urlsafe(32),
    }
    if runtime_profile == "public_maps_v1":
        payload_values["runtimeProfile"] = runtime_profile
    payload = json.dumps(
        payload_values,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf8")
    return base64.urlsafe_b64encode(payload).rstrip(b"=").decode("ascii")


def preview_capability_runtime_profile(capability: str) -> ObservablePreviewRuntimeProfile:
    """Select the exchange origin; the stored full-token checksum authenticates this later."""
    return _parse_preview_capability(capability).runtime_profile


def _unique_preview_payload(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    payload = dict(pairs)
    if len(payload) != len(pairs):
        raise ValueError("duplicate capability keys")
    return payload


def _parse_preview_capability(capability: str) -> _ParsedPreviewCapability:
    try:
        if _CAPABILITY_TOKEN.fullmatch(capability) is None:
            raise ValueError("capability shape")
        padding_length = (-len(capability)) % 4
        decoded = base64.b64decode(
            f"{capability}{'=' * padding_length}",
            altchars=b"-_",
            validate=True,
        )
        payload = json.loads(decoded, object_pairs_hook=_unique_preview_payload)
        required_keys = {
            "capabilityId",
            "organizationId",
            "userId",
            "secret",
        }
        if not isinstance(payload, dict) or set(payload) not in (
            required_keys,
            required_keys | {"runtimeProfile"},
        ):
            raise ValueError("capability payload")
        runtime_profile: ObservablePreviewRuntimeProfile = "local_only"
        if "runtimeProfile" in payload:
            if payload["runtimeProfile"] != "public_maps_v1":
                raise ValueError("capability runtime profile")
            runtime_profile = "public_maps_v1"
        if any(not isinstance(payload[key], str) for key in required_keys):
            raise ValueError("capability field type")
        secret = payload["secret"]
        if not isinstance(secret, str) or _CAPABILITY_SECRET.fullmatch(secret) is None:
            raise ValueError("capability entropy")
        return _ParsedPreviewCapability(
            capability_id=UUID(payload["capabilityId"]),
            organization_id=UUID(payload["organizationId"]),
            user_id=UUID(payload["userId"]),
            runtime_profile=runtime_profile,
        )
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise ObservablePreviewCapabilityInvalid("preview capability is invalid") from error
