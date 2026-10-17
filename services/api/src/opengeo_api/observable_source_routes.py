import logging
from collections.abc import Awaitable
from datetime import UTC, datetime
from typing import Annotated, Any, Literal, cast
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session, require_organization
from opengeo_api.logging import get_request_id
from opengeo_api.observable_previews import PreviewCookieSigningUnavailable
from opengeo_api.observable_sources import (
    ObservableBuildJob,
    ObservableBuildPurpose,
    ObservableDataAttachment,
    ObservablePreviewCapabilityInvalid,
    ObservablePreviewRuntimeProfile,
    ObservablePublicFileReference,
    ObservableRevisionAttachment,
    ObservableRevisionReferencedFile,
    ObservableRevisionUpload,
    ObservableRightsStatus,
    ObservableSourceAccessDenied,
    ObservableSourceConflict,
    ObservableSourceFileUploadDraft,
    ObservableSourceFileUploadTicket,
    ObservableSourceNotFound,
    ObservableSourceProject,
    ObservableSourceRepository,
    ObservableSourceRevision,
    ObservableSourceRevisionDraft,
    ObservableSourceRevisionFile,
    ObservableSourceStoreUnavailable,
    PostgresObservableSourceRepository,
    preview_capability_runtime_profile,
    validate_observable_attachment_path,
    validate_observable_referenced_file_path,
    validate_observable_source_file,
)
from opengeo_api.processing_dispatch import (
    AwsSqsRenderDispatcher,
    ObservableBuildDispatcher,
    ProcessingDispatchUnavailable,
)
from opengeo_api.publication_artifact_references import artifact_backup_inputs
from opengeo_api.s3_uploads import UploadObjectNotFound, UploadStorageUnavailable
from opengeo_api.tenant_database import TenantContext

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Observable source authoring"])

Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
ChangeSummary = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)
]
RelativePath = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=512)
]
Checksum = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
ContentType = Literal[
    "text/markdown",
    "text/javascript",
    "text/css",
    "application/json",
    "application/x-ipynb+json",
    "application/geo+json",
    "text/csv",
    "text/plain",
    "text/html",
    "image/svg+xml",
    "image/png",
    "image/jpeg",
]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateObservableSourceProjectRequest(RequestModel):
    title: Title


class ObservableSourceFileDownloadRequest(RequestModel):
    relative_path: RelativePath


class ObservableSourceFileDownloadResponse(BaseModel):
    url: str
    method: Literal["GET"]
    expires_at: datetime
    relative_path: RelativePath
    content_type: ContentType
    size_bytes: int = Field(ge=1, le=4_194_304)
    checksum_sha256: Checksum
    bucket: str
    object_key: str
    s3_version_id: str


class ObservableSourceFileUploadRequest(RequestModel):
    relative_path: RelativePath
    content_type: ContentType
    size_bytes: int = Field(ge=1, le=4_194_304)
    checksum_sha256: Checksum

    @model_validator(mode="after")
    def validate_file_contract(self) -> "ObservableSourceFileUploadRequest":
        try:
            validate_observable_source_file(self.relative_path, self.content_type, self.size_bytes)
        except ObservableSourceConflict as error:
            raise ValueError(error.code) from error
        return self


class ObservableRevisionFileRequest(RequestModel):
    upload_id: UUID | None = None
    source_object_id: UUID | None = None
    relative_path: RelativePath

    @model_validator(mode="after")
    def validate_reference(self) -> "ObservableRevisionFileRequest":
        if (self.upload_id is None) == (self.source_object_id is None):
            raise ValueError("provide exactly one upload id or retained source object id")
        return self


class ObservableRevisionAttachmentRequest(RequestModel):
    attachment_id: UUID
    relative_path: RelativePath

    @field_validator("relative_path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        try:
            validate_observable_attachment_path(value)
        except ObservableSourceConflict as error:
            raise ValueError(error.code) from error
        return value


class ObservableRevisionReferencedFileRequest(RequestModel):
    reference_id: UUID
    relative_path: RelativePath

    @field_validator("relative_path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        try:
            validate_observable_referenced_file_path(value)
        except ObservableSourceConflict as error:
            raise ValueError(error.code) from error
        return value


class CreateObservableSourceRevisionRequest(RequestModel):
    expected_revision: int = Field(ge=0)
    title: Title
    rights_status: ObservableRightsStatus = "unreviewed"
    entry_path: RelativePath
    lockfile_path: RelativePath | None = None
    change_summary: ChangeSummary
    files: list[ObservableRevisionFileRequest] = Field(min_length=1, max_length=128)
    data_attachments: list[ObservableRevisionAttachmentRequest] = Field(
        default_factory=list, max_length=128
    )
    referenced_files: list[ObservableRevisionReferencedFileRequest] = Field(
        default_factory=list, max_length=128
    )

    @field_validator("files", mode="after")
    @classmethod
    def validate_files(
        cls, values: list[ObservableRevisionFileRequest]
    ) -> list[ObservableRevisionFileRequest]:
        paths = [item.relative_path for item in values]
        uploads = [(item.upload_id, item.source_object_id) for item in values]
        if paths != sorted(paths):
            raise ValueError("source revision files must be sorted by relative path")
        if len({path.casefold() for path in paths}) != len(paths):
            raise ValueError("source revision paths must be case-insensitively unique")
        if len(set(uploads)) != len(uploads):
            raise ValueError("source revision upload ids must be unique")
        return values

    @model_validator(mode="after")
    def validate_entry_and_lockfile(self) -> "CreateObservableSourceRevisionRequest":
        paths = {item.relative_path for item in self.files}
        bindings = [item.relative_path for item in self.data_attachments]
        public_paths = [item.relative_path for item in self.referenced_files]
        if bindings != sorted(bindings) or public_paths != sorted(public_paths):
            raise ValueError("attachment and referenced file paths must be sorted")
        bindings += public_paths
        if len(paths) + len(bindings) > 128:
            raise ValueError("attachment paths must be sorted and total files bounded to 128")
        combined = sorted(path.casefold() for path in [*paths, *bindings])
        if any(
            left == right or right.startswith(left + "/")
            for index, left in enumerate(combined)
            for right in combined[index + 1 :]
        ):
            raise ValueError("source and attachment paths must not collide")
        static_html = self.entry_path == "index.html" or self.entry_path.endswith("/index.html")
        jupyter = self.entry_path.lower().endswith(".ipynb")
        if self.entry_path not in paths or not (
            self.entry_path.lower().endswith(".md") or static_html or jupyter
        ):
            raise ValueError(
                "entry_path must name a Markdown file, static index.html or Jupyter notebook"
            )
        if jupyter:
            prefix = self.entry_path.rsplit("/", 1)[0] + "/" if "/" in self.entry_path else ""
            if self.lockfile_path is not None or any(
                not path.startswith(prefix) for path in [*paths, *bindings]
            ):
                raise ValueError(
                    "Jupyter notebooks require a lockfile-free source tree "
                    "under the entry directory"
                )
        if static_html:
            prefix = self.entry_path[: -len("index.html")]
            if self.lockfile_path is not None or any(
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
                for path in [*paths, *bindings]
            ):
                raise ValueError(
                    "static HTML accepts only public files under its entry directory, "
                    "without package or build configuration"
                )
        if self.lockfile_path is not None and (
            self.lockfile_path != "package-lock.json" or self.lockfile_path not in paths
        ):
            raise ValueError("only an included package-lock.json lockfile is supported")
        if "package.json" in paths and self.lockfile_path != "package-lock.json":
            raise ValueError("package.json requires the supported package-lock.json lockfile")
        return self


class CreateObservableBuildJobRequest(RequestModel):
    artifact_input_id: UUID | None = None
    purpose: ObservableBuildPurpose = "preview"
    idempotency_key: UUID | None = None
    output_profile: Literal["default-32m", "archive-96m"] = "default-32m"
    size_acknowledgment: Literal["allow-up-to-96-mib-output"] | None = None
    distribution_approval_id: UUID | None = None
    output_representation: Literal["single-html"] | None = None

    @model_validator(mode="after")
    def validate_output_consent(self) -> "CreateObservableBuildJobRequest":
        if (self.output_profile == "archive-96m") != (self.size_acknowledgment is not None):
            raise ValueError("expanded output requires its explicit size acknowledgment")
        return self


class ArchiveDistributionRightsRequest(RequestModel):
    attachment_id: UUID
    relative_path: RelativePath
    license: Literal["CC0-1.0", "CC-BY-4.0", "PDDL-1.0"]
    attribution: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)
    ]
    acknowledgment: Literal["publish-exact-archive-file"]


class ArtifactDistributionReleaseRequest(RequestModel):
    artifact_id: UUID
    version: int = Field(ge=1, le=2147483647)
    release_id: UUID
    acknowledgment: Literal["publish-exact-map-artifact"]


class ReferencedDistributionRightsRequest(RequestModel):
    reference_id: UUID
    relative_path: RelativePath
    license: Literal["CC0-1.0", "CC-BY-4.0", "PDDL-1.0"]
    attribution: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)
    ]
    acknowledgment: Literal["publish-exact-referenced-file"]


class CreateDistributionApprovalRequest(RequestModel):
    approval_id: UUID
    artifact_input_id: UUID | None = None
    output_profile: Literal["default-32m", "archive-96m"] = "default-32m"
    archive_rights: list[ArchiveDistributionRightsRequest] = Field(
        default_factory=list, max_length=128
    )
    artifact_releases: list[ArtifactDistributionReleaseRequest] = Field(
        default_factory=list, max_length=32
    )
    referenced_rights: list[ReferencedDistributionRightsRequest] = Field(
        default_factory=list, max_length=128
    )


class RevokeDistributionApprovalRequest(RequestModel):
    acknowledgment: Literal["revoke-input-distribution-approval"]


class ConnectGitHubRequest(RequestModel):
    connection_id: UUID


class GitHubConnectionResponse(RequestModel):
    id: UUID
    repository: str
    repository_id: int
    enabled: bool
    verified_at: datetime


class GitHubRevisionReceiptResponse(RequestModel):
    source_revision_id: UUID
    revision_number: int
    commit_sha: str
    tree_sha: str
    git_ref: str
    manifest_sha256: str
    created_at: datetime


class GitHubSourceSyncResponse(RequestModel):
    source_revision_id: UUID
    revision_number: int
    stage: Literal["pending", "syncing", "synced", "failed"]
    error_code: str | None
    updated_at: datetime


class GitHubSourceStatusResponse(RequestModel):
    source_project_id: UUID
    connection: GitHubConnectionResponse | None
    available_connections: list[GitHubConnectionResponse]
    can_connect: bool
    revisions: list[GitHubRevisionReceiptResponse]
    can_sync: bool = False
    sync_configured: bool = False
    current_revision_id: UUID | None = None
    syncs: list[GitHubSourceSyncResponse] = Field(default_factory=list)


class GitHubRetainedLogsResponse(RequestModel):
    state: Literal["retained", "unavailable"]
    text: str = Field(max_length=24000)
    truncated: bool
    checksum_sha256: Checksum | None
    captured_at: datetime


class GitHubDispatchResponse(RequestModel):
    build_job_id: UUID
    source_project_id: UUID
    stage: Literal["syncing", "ready", "dispatching", "dispatched", "completed", "failed"]
    source_commit: str | None
    workflow_sha: str
    run_id: int | None
    run_attempt: int | None
    run_status: str | None
    run_conclusion: str | None
    retained_logs: GitHubRetainedLogsResponse | None = None
    error_code: str | None
    updated_at: datetime
    repository: str


class FrameworkPublicationMountResponse(RequestModel):
    id: UUID
    hostname: str
    mount_path: str
    generation: int
    enabled: bool


class FrameworkPublicationOriginResponse(RequestModel):
    id: UUID
    hostname: str
    path_prefix: str


class FrameworkDeploymentResponse(RequestModel):
    stage: Literal["preparing", "copying", "activating", "deployed", "needs_attention"]
    completed_files: int = Field(ge=0, le=2048)
    total_files: int | None = Field(default=None, ge=0, le=2048)
    error_code: str | None = None
    updated_at: datetime
    release_prefix: str | None = None


class FrameworkPublicationReviewResponse(RequestModel):
    id: UUID
    build_job_id: UUID
    mount_id: UUID
    hostname: str
    mount_path: str
    result_checksum_sha256: Checksum
    output_tree_checksum_sha256: Checksum
    expected_generation: int
    previous_release_prefix: str
    reviewed_at: datetime
    expires_at: datetime
    approved_at: datetime | None
    deployment: FrameworkDeploymentResponse | None = None


class FrameworkPublicationStatusResponse(RequestModel):
    source_project_id: UUID
    can_publish: bool
    dispatch_configured: bool = False
    mounts: list[FrameworkPublicationMountResponse]
    reviews: list[FrameworkPublicationReviewResponse]
    can_configure_destinations: bool = False
    origins: list[FrameworkPublicationOriginResponse] = Field(default_factory=list)


class ReserveFrameworkDestinationRequest(RequestModel):
    reservation_id: UUID
    origin_id: UUID
    slug: Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]{0,79}$", min_length=1, max_length=80)]
    acknowledgment: Literal["reserve-address-without-publishing"]


class ReviewFrameworkPublicationRequest(RequestModel):
    review_id: UUID
    build_job_id: UUID
    mount_id: UUID
    result_checksum_sha256: Checksum
    distribution_approval_id: UUID | None = None


class ApproveFrameworkPublicationRequest(RequestModel):
    acknowledgment: Literal["publish-exact-previewed-output"]


class ObservableWorkflowResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: UUID
    source_storage_configured: bool
    build_dispatch_configured: bool
    private_preview_configured: bool
    public_promotion_available: Literal[False] = False
    configuration_only: Literal[True] = True


class ObservableBuildPolicyResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    compiler_image_digest: str
    framework_version: Literal["1.13.4"]
    lockfile_format: Literal["npm-package-lock-v3"]
    network_policy: Literal["deny_all"]
    resource_limits: dict[str, int]


class ObservableSourceProjectResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
    project_id: UUID
    site_id: UUID
    route_namespace: str
    title: str
    rights_status: ObservableRightsStatus
    owner_user_id: UUID
    current_revision_id: UUID | None
    current_revision_number: int
    build_policy: ObservableBuildPolicyResponse
    created_by: UUID
    created_at: datetime
    updated_by: UUID
    updated_at: datetime


class UploadInstructionsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str
    method: Literal["POST"]
    fields: dict[str, str]


class ObservableSourceFileUploadResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    upload_id: UUID
    source_project_id: UUID
    relative_path: str
    content_type: str
    size_bytes: int
    checksum_sha256: str
    expires_at: datetime
    upload: UploadInstructionsResponse


class ObservableSourceRevisionFileResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    relative_path: str
    source_object_id: UUID
    bucket: str
    object_key: str
    s3_version_id: str
    etag: str
    content_type: str
    size_bytes: int
    checksum_sha256: str


class RegisterObservableDataAttachmentRequest(RequestModel):
    dataset_id: UUID
    dataset_version_id: UUID
    data_object_id: UUID


class ObservableDataAttachmentResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

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
    revision_bound: Literal[False] = False
    build_input: Literal[False] = False
    publication_authorized: Literal[False] = False


class RegisterObservablePublicFileReferenceRequest(RequestModel):
    dataset_id: UUID
    source_version: int = Field(strict=True, ge=1, le=9_007_199_254_740_991)
    resource_id: UUID
    resource_version_id: UUID
    distribution_id: str = Field(min_length=1, max_length=1000)


class ObservablePublicFileReferenceResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

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
    kind: Literal["referenced-public-file"] = "referenced-public-file"
    custody: Literal["referenced"] = "referenced"
    revision_bound: Literal[False] = False
    build_input: Literal[False] = False
    publication_authorized: Literal[False] = False


class ObservableSourceRevisionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
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
    files: list[ObservableSourceRevisionFileResponse]


class ObservableBuildJobResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
    source_project_id: UUID
    source_revision_id: UUID
    source_revision_number: int
    purpose: ObservableBuildPurpose
    state: Literal["pending", "running", "succeeded", "failed", "cancelled"]
    request: dict[str, Any]
    request_checksum_sha256: str
    result: dict[str, Any] | None
    result_checksum_sha256: str | None
    attempt_count: int
    error_code: str | None
    created_by: UUID
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    updated_at: datetime
    execution_available: bool = False
    coordination_status: Literal[
        "not_configured", "configured", "dispatched", "dispatch_failed"
    ] = "not_configured"


class ObservablePreviewCapabilityResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    authorize_url: str
    expires_at: datetime
    publication_authorized: Literal[False] = False


class ExchangeObservablePreviewRequest(RequestModel):
    capability: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=128, max_length=512),
    ]


class CreateObservablePreviewRequest(RequestModel):
    runtime_profile: ObservablePreviewRuntimeProfile = "local_only"


class ObservablePreviewExchangeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entry_path: str
    expires_at: datetime
    publication_authorized: Literal[False] = False


def repository_from_request(request: Request) -> ObservableSourceRepository:
    repository = request.app.state.observable_source_repository
    if not isinstance(repository, PostgresObservableSourceRepository):
        return cast(ObservableSourceRepository, repository)
    return repository


class PublicationWorkspaceResponse(BaseModel):
    id: UUID
    kind: Literal["framework", "hosted_site", "site"]
    project_id: UUID | None
    project_name: str | None
    site_id: UUID | None
    source_project_id: UUID | None
    title: str
    current_revision: int
    hostname: str | None
    mount_path: str | None
    published_at: datetime | None
    published_revision: int | None
    status: Literal["draft", "published", "unmanaged", "adopted"]
    can_manage: bool


@router.get("/publication-workspaces", response_model=list[PublicationWorkspaceResponse])
async def publication_workspaces(
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
    limit: int = Query(default=100, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=100_000),
) -> list[PublicationWorkspaceResponse]:
    records = await execute_observable(
        repository.publication_workspaces(tenant_context(session), limit, offset)
    )
    response.headers["Cache-Control"] = "no-store"
    return [PublicationWorkspaceResponse.model_validate(record) for record in records]


def dispatcher_from_request(request: Request) -> ObservableBuildDispatcher:
    return cast(ObservableBuildDispatcher, request.app.state.observable_build_dispatcher)


def tenant_context(session: AuthSession) -> TenantContext:
    return TenantContext(
        user_id=session.principal.user_id,
        organization_id=require_organization(session).organization_id,
    )


async def execute_observable[ObservableResponse](
    operation: Awaitable[ObservableResponse],
) -> ObservableResponse:
    try:
        return await operation
    except ObservableSourceAccessDenied as error:
        raise HTTPException(status_code=403, detail="observable_source_action_forbidden") from error
    except ObservableSourceNotFound as error:
        raise HTTPException(status_code=404, detail=f"{error.resource}_not_found") from error
    except ObservablePreviewCapabilityInvalid as error:
        raise HTTPException(
            status_code=404, detail="observable_preview_capability_invalid"
        ) from error
    except ObservableSourceConflict as error:
        detail: dict[str, Any] = {"code": error.code}
        if error.current_revision is not None:
            detail["current_revision"] = error.current_revision
        raise HTTPException(status_code=409, detail=detail) from error
    except UploadObjectNotFound as error:
        raise HTTPException(
            status_code=409, detail={"code": "observable_source_upload_object_missing"}
        ) from error
    except (ObservableSourceStoreUnavailable, UploadStorageUnavailable) as error:
        logger.error("observable_source.store_unavailable")
        raise HTTPException(
            status_code=503, detail="observable_source_store_unavailable"
        ) from error


@router.get(
    "/projects/{project_id}/framework-workflow",
    response_model=ObservableWorkflowResponse,
)
async def get_observable_workflow(
    project_id: UUID,
    request: Request,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> ObservableWorkflowResponse:
    # Reuse the project read gate, including projects without a source identity.
    # Do not expose queue URLs, signing keys, bucket names or token material.
    await execute_observable(repository.list_projects(tenant_context(session), project_id))
    settings = request.app.state.settings
    response.headers["Cache-Control"] = "no-store"
    return ObservableWorkflowResponse(
        project_id=project_id,
        source_storage_configured=settings.source_upload_configured,
        build_dispatch_configured=dispatcher_from_request(request).available,
        private_preview_configured=(
            settings.observable_preview_origin is not None
            and request.app.state.observable_preview_cookie_signer.available
        ),
    )


@router.get(
    "/projects/{project_id}/source-projects/{source_project_id}/publications",
    response_model=FrameworkPublicationStatusResponse,
)
async def framework_publication_status(
    project_id: UUID,
    source_project_id: UUID,
    request: Request,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> FrameworkPublicationStatusResponse:
    result = await execute_observable(
        repository.publication_status(tenant_context(session), project_id, source_project_id)
    )
    result["dispatch_configured"] = request.app.state.framework_publication_dispatcher.available
    response.headers["Cache-Control"] = "no-store"
    return FrameworkPublicationStatusResponse.model_validate(result)


@router.post(
    "/projects/{project_id}/source-projects/{source_project_id}/publications/destinations",
    response_model=FrameworkPublicationStatusResponse,
)
async def reserve_framework_destination(
    project_id: UUID,
    source_project_id: UUID,
    body: ReserveFrameworkDestinationRequest,
    request: Request,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> FrameworkPublicationStatusResponse:
    await execute_observable(
        repository.reserve_publication_destination(
            tenant_context(session),
            project_id,
            source_project_id,
            body.reservation_id,
            body.origin_id,
            body.slug,
            body.acknowledgment,
        )
    )
    return await framework_publication_status(
        project_id, source_project_id, request, response, session, repository
    )


@router.post(
    "/projects/{project_id}/source-projects/{source_project_id}/publications/reviews",
    response_model=FrameworkPublicationStatusResponse,
)
async def review_framework_publication(
    project_id: UUID,
    source_project_id: UUID,
    body: ReviewFrameworkPublicationRequest,
    request: Request,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> FrameworkPublicationStatusResponse:
    await execute_observable(
        repository.review_publication(
            tenant_context(session),
            project_id,
            source_project_id,
            body.build_job_id,
            body.mount_id,
            body.result_checksum_sha256,
            body.review_id,
            **(
                {"distribution_approval_id": body.distribution_approval_id}
                if body.distribution_approval_id
                else {}
            ),
        )
    )
    return await framework_publication_status(
        project_id, source_project_id, request, response, session, repository
    )


@router.post(
    "/projects/{project_id}/source-projects/{source_project_id}/publications/reviews/{review_id}/approve",
    response_model=FrameworkPublicationStatusResponse,
    status_code=202,
)
async def approve_framework_publication(
    project_id: UUID,
    source_project_id: UUID,
    review_id: UUID,
    body: ApproveFrameworkPublicationRequest,
    request: Request,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> FrameworkPublicationStatusResponse:
    del body  # The explicit acknowledgment was validated; the DB pins its canonical value.
    dispatcher = request.app.state.framework_publication_dispatcher
    if not dispatcher.available:
        raise HTTPException(status_code=503, detail="framework_publication_dispatch_not_configured")
    await execute_observable(
        repository.approve_publication(
            tenant_context(session),
            project_id,
            source_project_id,
            review_id,
        )
    )
    try:
        await dispatcher.dispatch_framework_publication(review_id)
    except ProcessingDispatchUnavailable as error:
        # Approval persists. Retrying this same review sends only its original ID.
        raise HTTPException(
            status_code=503, detail="framework_publication_dispatch_unconfirmed"
        ) from error
    return await framework_publication_status(
        project_id, source_project_id, request, response, session, repository
    )


@router.get(
    "/projects/{project_id}/source-projects/{source_project_id}/github",
    response_model=GitHubSourceStatusResponse,
)
async def get_github_source_status(
    project_id: UUID,
    source_project_id: UUID,
    request: Request,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> GitHubSourceStatusResponse:
    result = await execute_observable(
        repository.github_status(tenant_context(session), project_id, source_project_id)
    )
    response.headers["Cache-Control"] = "no-store"
    return GitHubSourceStatusResponse.model_validate(
        {**result, "sync_configured": github_sync_configured(request)}
    )


@router.put(
    "/projects/{project_id}/source-projects/{source_project_id}/github",
    response_model=GitHubSourceStatusResponse,
)
async def connect_github_source(
    project_id: UUID,
    source_project_id: UUID,
    body: ConnectGitHubRequest,
    request: Request,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> GitHubSourceStatusResponse:
    result = await execute_observable(
        repository.connect_github(
            tenant_context(session), project_id, source_project_id, body.connection_id
        )
    )
    response.headers["Cache-Control"] = "no-store"
    # Repository selection is separate from disclosure of publication source.
    # Only the explicit revision-sync endpoint requests an export.
    return GitHubSourceStatusResponse.model_validate(
        {**result, "sync_configured": github_sync_configured(request)}
    )


def github_sync_configured(request: Request) -> bool:
    settings = request.app.state.settings
    return settings.observable_build_provider == "github" and bool(
        settings.observable_build_queue_url
    )


async def dispatch_saved_github_revision(
    request: Request,
    repository: ObservableSourceRepository,
    session: AuthSession,
    project_id: UUID,
    source_project_id: UUID,
    revision_id: UUID,
) -> str:
    if not github_sync_configured(request):
        return "unconfigured"
    try:
        pending = await repository.request_github_sync(
            tenant_context(session), project_id, source_project_id, revision_id
        )
        if not pending:
            return "not_pending"
        settings = request.app.state.settings
        await AwsSqsRenderDispatcher(
            settings, queue_url=settings.observable_build_queue_url
        ).dispatch_github_source_sync(revision_id)
        return "queued"
    except Exception:
        # Revision/connection is already committed. Do not invite a duplicate
        # save because its subsequent queue notification could not be confirmed.
        return "pending"


@router.post(
    "/projects/{project_id}/source-projects/{source_project_id}/revisions/{revision_id}/github-sync",
    response_model=GitHubSourceStatusResponse,
)
async def retry_github_source_sync(
    project_id: UUID,
    source_project_id: UUID,
    revision_id: UUID,
    request: Request,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> GitHubSourceStatusResponse:
    # Explicit retry must return authorization failures, not mask them as queue failure.
    await execute_observable(
        repository.request_github_sync(
            tenant_context(session), project_id, source_project_id, revision_id
        )
    )
    await dispatch_saved_github_revision(
        request, repository, session, project_id, source_project_id, revision_id
    )
    result = await execute_observable(
        repository.github_status(tenant_context(session), project_id, source_project_id)
    )
    response.headers["Cache-Control"] = "no-store"
    return GitHubSourceStatusResponse.model_validate(
        {**result, "sync_configured": github_sync_configured(request)}
    )


@router.get(
    "/projects/{project_id}/source-projects/{source_project_id}/github-builds",
    response_model=list[GitHubDispatchResponse],
)
async def get_github_dispatch_history(
    project_id: UUID,
    source_project_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0, le=100_000)] = 0,
) -> list[GitHubDispatchResponse]:
    records = await execute_observable(
        repository.github_dispatches(
            tenant_context(session), project_id, source_project_id, limit, offset
        )
    )
    response.headers["Cache-Control"] = "no-store"
    return [GitHubDispatchResponse.model_validate(record) for record in records]


@router.get(
    "/projects/{project_id}/source-projects",
    response_model=list[ObservableSourceProjectResponse],
)
async def list_observable_source_projects(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> list[ObservableSourceProjectResponse]:
    records = await execute_observable(
        repository.list_projects(tenant_context(session), project_id)
    )
    return [source_project_response(record) for record in records]


@router.post(
    "/projects/{project_id}/sites/{site_id}/source-project",
    response_model=ObservableSourceProjectResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_observable_source_project(
    project_id: UUID,
    site_id: UUID,
    payload: CreateObservableSourceProjectRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> ObservableSourceProjectResponse:
    record = await execute_observable(
        repository.create_project(
            tenant_context(session), project_id, site_id, payload.title, get_request_id()
        )
    )
    return source_project_response(record)


@router.get(
    "/projects/{project_id}/source-projects/{source_project_id}/data-attachments",
    response_model=list[ObservableDataAttachmentResponse],
)
async def list_observable_data_attachments(
    project_id: UUID,
    source_project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> list[ObservableDataAttachmentResponse]:
    records = await execute_observable(
        repository.list_data_attachments(tenant_context(session), project_id, source_project_id)
    )
    return [ObservableDataAttachmentResponse.model_validate(record) for record in records]


@router.post(
    "/projects/{project_id}/source-projects/{source_project_id}/data-attachments",
    response_model=ObservableDataAttachmentResponse,
)
async def register_observable_data_attachment(
    project_id: UUID,
    source_project_id: UUID,
    payload: RegisterObservableDataAttachmentRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> ObservableDataAttachmentResponse:
    # Re-registering an exact object returns the same attachment; it is not a
    # second capture and does not enqueue or authorize a compilation.
    record: ObservableDataAttachment = await execute_observable(
        repository.register_data_attachment(
            tenant_context(session),
            project_id,
            source_project_id,
            payload.dataset_id,
            payload.dataset_version_id,
            payload.data_object_id,
            get_request_id(),
        )
    )
    return ObservableDataAttachmentResponse.model_validate(record)


@router.get(
    "/projects/{project_id}/source-projects/{source_project_id}/public-file-references",
    response_model=list[ObservablePublicFileReferenceResponse],
)
async def list_observable_public_file_references(
    project_id: UUID,
    source_project_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> list[ObservablePublicFileReferenceResponse]:
    response.headers["Cache-Control"] = "no-store"
    records = await execute_observable(
        repository.list_public_file_references(
            tenant_context(session), project_id, source_project_id
        )
    )
    return [ObservablePublicFileReferenceResponse.model_validate(record) for record in records]


@router.post(
    "/projects/{project_id}/source-projects/{source_project_id}/public-file-references",
    response_model=ObservablePublicFileReferenceResponse,
)
async def register_observable_public_file_reference(
    project_id: UUID,
    source_project_id: UUID,
    payload: RegisterObservablePublicFileReferenceRequest,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> ObservablePublicFileReferenceResponse:
    response.headers["Cache-Control"] = "no-store"
    record: ObservablePublicFileReference = await execute_observable(
        repository.register_public_file_reference(
            tenant_context(session),
            project_id,
            source_project_id,
            payload.dataset_id,
            payload.source_version,
            payload.resource_id,
            payload.resource_version_id,
            payload.distribution_id,
            get_request_id(),
        )
    )
    return ObservablePublicFileReferenceResponse.model_validate(record)


@router.get(
    "/projects/{project_id}/source-projects/{source_project_id}",
    response_model=ObservableSourceProjectResponse,
)
async def get_observable_source_project(
    project_id: UUID,
    source_project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> ObservableSourceProjectResponse:
    return source_project_response(
        await execute_observable(
            repository.get_project(tenant_context(session), project_id, source_project_id)
        )
    )


@router.post(
    "/projects/{project_id}/source-projects/{source_project_id}/file-uploads",
    response_model=ObservableSourceFileUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
async def request_observable_source_file_upload(
    project_id: UUID,
    source_project_id: UUID,
    payload: ObservableSourceFileUploadRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> ObservableSourceFileUploadResponse:
    ticket = await execute_observable(
        repository.request_file_upload(
            tenant_context(session),
            project_id,
            source_project_id,
            ObservableSourceFileUploadDraft(
                relative_path=payload.relative_path,
                content_type=payload.content_type,
                size_bytes=payload.size_bytes,
                checksum_sha256=payload.checksum_sha256,
            ),
            get_request_id(),
        )
    )
    return source_upload_response(ticket)


@router.post(
    "/projects/{project_id}/source-projects/{source_project_id}/revisions",
    response_model=ObservableSourceRevisionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_observable_source_revision(
    project_id: UUID,
    source_project_id: UUID,
    payload: CreateObservableSourceRevisionRequest,
    request: Request,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> ObservableSourceRevisionResponse:
    record = await execute_observable(
        repository.create_revision(
            tenant_context(session),
            project_id,
            source_project_id,
            ObservableSourceRevisionDraft(
                expected_revision=payload.expected_revision,
                title=payload.title,
                rights_status=payload.rights_status,
                entry_path=payload.entry_path,
                lockfile_path=payload.lockfile_path,
                change_summary=payload.change_summary,
                files=tuple(
                    ObservableRevisionUpload(
                        upload_id=item.upload_id,
                        relative_path=item.relative_path,
                        source_object_id=item.source_object_id,
                    )
                    for item in payload.files
                ),
                data_attachments=tuple(
                    ObservableRevisionAttachment(
                        attachment_id=item.attachment_id, relative_path=item.relative_path
                    )
                    for item in payload.data_attachments
                ),
                referenced_files=tuple(
                    ObservableRevisionReferencedFile(
                        reference_id=item.reference_id, relative_path=item.relative_path
                    )
                    for item in payload.referenced_files
                ),
            ),
            get_request_id(),
        )
    )
    response.headers["X-OpenGeo-GitHub-Sync"] = "not_requested"
    return source_revision_response(record)


@router.get(
    "/projects/{project_id}/source-projects/{source_project_id}/revisions",
    response_model=list[ObservableSourceRevisionResponse],
)
async def list_observable_source_revisions(
    project_id: UUID,
    source_project_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> list[ObservableSourceRevisionResponse]:
    records = await execute_observable(
        repository.list_revisions(tenant_context(session), project_id, source_project_id)
    )
    response.headers["X-OpenGeo-Source-File-Reuse"] = "parent-revision-v1"
    response.headers["Access-Control-Expose-Headers"] = "X-OpenGeo-Source-File-Reuse"
    return [source_revision_response(record) for record in records]


@router.get(
    "/projects/{project_id}/source-projects/{source_project_id}/revisions/page",
    response_model=list[ObservableSourceRevisionResponse],
)
async def list_observable_source_revisions_page(
    project_id: UUID,
    source_project_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
    limit: Annotated[int, Query(ge=1, le=25)] = 25,
    before_revision: Annotated[int | None, Query(ge=1)] = None,
) -> list[ObservableSourceRevisionResponse]:
    records = await execute_observable(
        repository.list_revisions_page(
            tenant_context(session), project_id, source_project_id, limit, before_revision
        )
    )
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-OpenGeo-Source-File-Reuse"] = "parent-revision-v1"
    response.headers["Access-Control-Expose-Headers"] = "X-OpenGeo-Source-File-Reuse"
    return [source_revision_response(record) for record in records]


@router.get(
    "/projects/{project_id}/source-projects/{source_project_id}/revisions/"
    "{source_revision_id}/files/{relative_path:path}",
    response_class=Response,
)
async def read_observable_source_revision_file(
    project_id: UUID,
    source_project_id: UUID,
    source_revision_id: UUID,
    relative_path: RelativePath,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> Response:
    record = await execute_observable(
        repository.read_revision_file(
            tenant_context(session),
            project_id,
            source_project_id,
            source_revision_id,
            relative_path,
        )
    )
    return Response(
        content=record.body,
        media_type=record.content_type,
        headers={
            "Cache-Control": "private, no-store, max-age=0",
            "Content-Security-Policy": "default-src 'none'",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "X-OpenGeo-Source-Sha256": record.checksum_sha256,
        },
    )


@router.post(
    "/projects/{project_id}/source-projects/{source_project_id}/revisions/"
    "{source_revision_id}/file-download",
    response_model=ObservableSourceFileDownloadResponse,
)
async def request_observable_source_revision_file_download(
    project_id: UUID,
    source_project_id: UUID,
    source_revision_id: UUID,
    payload: ObservableSourceFileDownloadRequest,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> ObservableSourceFileDownloadResponse:
    record = await execute_observable(
        repository.request_revision_file_download(
            tenant_context(session),
            project_id,
            source_project_id,
            source_revision_id,
            payload.relative_path,
        )
    )
    response.headers["Cache-Control"] = "private, no-store, max-age=0"
    response.headers["Referrer-Policy"] = "no-referrer"
    return ObservableSourceFileDownloadResponse(
        url=record.download.url,
        method=cast(Literal["GET"], record.download.method),
        expires_at=record.download.expires_at,
        relative_path=record.file.relative_path,
        content_type=cast(ContentType, record.file.content_type),
        size_bytes=record.file.size_bytes,
        checksum_sha256=record.file.checksum_sha256,
        bucket=record.file.bucket,
        object_key=record.file.object_key,
        s3_version_id=record.file.s3_version_id,
    )


@router.post(
    "/projects/{project_id}/source-projects/{source_project_id}/revisions/"
    "{source_revision_id}/build-jobs",
    response_model=ObservableBuildJobResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_observable_build_job(
    project_id: UUID,
    source_project_id: UUID,
    source_revision_id: UUID,
    payload: CreateObservableBuildJobRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
    dispatcher: Annotated[ObservableBuildDispatcher, Depends(dispatcher_from_request)],
) -> ObservableBuildJobResponse:
    build_options: dict[str, Any] = {}
    if payload.artifact_input_id:
        build_options["artifact_input_id"] = payload.artifact_input_id
    if payload.output_profile != "default-32m":
        build_options.update(
            output_profile=payload.output_profile, size_acknowledgment=payload.size_acknowledgment
        )
    if payload.distribution_approval_id:
        build_options["distribution_approval_id"] = payload.distribution_approval_id
    if payload.output_representation is not None:
        build_options["output_representation"] = payload.output_representation
    record = await execute_observable(
        repository.create_build_job(
            tenant_context(session),
            project_id,
            source_project_id,
            source_revision_id,
            payload.purpose,
            get_request_id(),
            payload.idempotency_key,
            **build_options,
        )
    )
    if not dispatcher.available:
        return build_job_response(record)
    if record.state != "pending":
        return build_job_response(
            record, execution_available=True, coordination_status="configured"
        )
    try:
        await dispatcher.dispatch_observable_build(record.build_job_id)
    except ProcessingDispatchUnavailable:
        logger.warning("Observable build dispatch failed after durable staging")
        return build_job_response(
            record, execution_available=True, coordination_status="dispatch_failed"
        )
    return build_job_response(record, execution_available=True, coordination_status="dispatched")


@router.get(
    "/projects/{project_id}/source-projects/{source_project_id}/build-jobs",
    response_model=list[ObservableBuildJobResponse],
)
async def list_observable_build_jobs(
    project_id: UUID,
    source_project_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0, le=100_000)] = 0,
) -> list[ObservableBuildJobResponse]:
    records = await execute_observable(
        repository.list_build_jobs(
            tenant_context(session), project_id, source_project_id, limit, offset
        )
    )
    available = dispatcher_from_request(request).available
    return [
        build_job_response(
            record,
            execution_available=available,
            coordination_status="configured" if available else "not_configured",
        )
        for record in records
    ]


@router.get(
    "/projects/{project_id}/observable-build-jobs/{build_job_id}",
    response_model=ObservableBuildJobResponse,
)
async def get_observable_build_job(
    project_id: UUID,
    build_job_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> ObservableBuildJobResponse:
    record = await execute_observable(
        repository.get_build_job(tenant_context(session), project_id, build_job_id)
    )
    dispatcher = dispatcher_from_request(request)
    return build_job_response(
        record,
        execution_available=dispatcher.available,
        coordination_status="configured" if dispatcher.available else "not_configured",
    )


@router.post(
    "/projects/{project_id}/observable-build-jobs/{build_job_id}/dispatch",
    response_model=ObservableBuildJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def dispatch_observable_build_job(
    project_id: UUID,
    build_job_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> ObservableBuildJobResponse:
    dispatcher = dispatcher_from_request(request)
    if not dispatcher.available:
        raise HTTPException(status_code=503, detail="observable_build_execution_unavailable")
    record = await execute_observable(
        repository.authorize_build_dispatch(tenant_context(session), project_id, build_job_id)
    )
    try:
        await dispatcher.dispatch_observable_build(build_job_id)
    except ProcessingDispatchUnavailable as error:
        raise HTTPException(
            status_code=503, detail="observable_build_dispatch_unavailable"
        ) from error
    return build_job_response(record, execution_available=True, coordination_status="dispatched")


@router.post(
    "/projects/{project_id}/observable-build-jobs/{build_job_id}/preview-capabilities",
    response_model=ObservablePreviewCapabilityResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_observable_preview_capability(
    project_id: UUID,
    build_job_id: UUID,
    request: Request,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
    payload: CreateObservablePreviewRequest | None = None,
) -> ObservablePreviewCapabilityResponse:
    runtime_profile = payload.runtime_profile if payload is not None else "local_only"
    settings = request.app.state.settings
    preview_origin = (
        settings.observable_public_maps_preview_origin
        if runtime_profile == "public_maps_v1"
        else settings.observable_preview_origin
    )
    signer = request.app.state.observable_preview_cookie_signer
    if preview_origin is None or not signer.available:
        raise HTTPException(status_code=503, detail="observable_preview_delivery_unavailable")
    location = urlsplit(str(request.url))
    api_port = location.port
    api_authority = location.hostname or ""
    if api_port is not None and (location.scheme, api_port) not in {("https", 443), ("http", 80)}:
        api_authority += f":{api_port}"
    if preview_origin in {request.headers.get("origin"), f"{location.scheme}://{api_authority}"}:
        raise HTTPException(status_code=503, detail="observable_preview_origin_not_isolated")
    capability = await execute_observable(
        repository.create_preview_capability(
            tenant_context(session), project_id, build_job_id, get_request_id(), runtime_profile
        )
    )
    response.headers["Cache-Control"] = "no-store, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Referrer-Policy"] = "no-referrer"
    return ObservablePreviewCapabilityResponse(
        authorize_url=f"{preview_origin}/authorize/#cap={capability.capability}",
        expires_at=capability.expires_at,
    )


@router.post(
    "/observable-preview/exchange",
    response_model=ObservablePreviewExchangeResponse,
)
async def exchange_observable_preview_capability(
    payload: ExchangeObservablePreviewRequest,
    request: Request,
    response: Response,
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> ObservablePreviewExchangeResponse:
    settings = request.app.state.settings
    signer = request.app.state.observable_preview_cookie_signer
    if settings.observable_preview_origin is None or not signer.available:
        raise HTTPException(status_code=503, detail="observable_preview_delivery_unavailable")
    try:
        runtime_profile = preview_capability_runtime_profile(payload.capability)
    except ObservablePreviewCapabilityInvalid as error:
        raise HTTPException(
            status_code=404, detail="observable_preview_capability_invalid"
        ) from error
    preview_origin = (
        settings.observable_public_maps_preview_origin
        if runtime_profile == "public_maps_v1"
        else settings.observable_preview_origin
    )
    if preview_origin is None:
        raise HTTPException(status_code=503, detail="observable_preview_delivery_unavailable")
    if (
        request.headers.get("origin") != preview_origin
        or request.headers.get("sec-fetch-site") != "same-origin"
    ):
        raise HTTPException(status_code=403, detail="observable_preview_exchange_origin_invalid")
    grant = await execute_observable(repository.exchange_preview_capability(payload.capability))
    if grant.runtime_profile != runtime_profile:
        raise HTTPException(status_code=404, detail="observable_preview_capability_invalid")
    resource_url = f"{preview_origin}/{grant.output_prefix}*"
    try:
        cookies = signer.sign(resource_url, grant.expires_at)
    except (PreviewCookieSigningUnavailable, ValueError):
        logger.error("observable_preview.cookie_signing_unavailable")
        raise HTTPException(
            status_code=503, detail="observable_preview_delivery_unavailable"
        ) from None
    if set(cookies) != {
        "CloudFront-Policy",
        "CloudFront-Signature",
        "CloudFront-Key-Pair-Id",
    }:
        logger.error("observable_preview.cookie_signing_invalid")
        raise HTTPException(status_code=503, detail="observable_preview_delivery_unavailable")
    cookie_path = f"/{grant.output_prefix}"
    max_age = max(1, min(900, int((grant.expires_at - datetime.now(UTC)).total_seconds())))
    for name, value in cookies.items():
        response.set_cookie(
            name,
            value,
            max_age=max_age,
            path=cookie_path,
            secure=urlsplit(preview_origin).scheme == "https",
            httponly=True,
            samesite="strict",
        )
    response.headers["Cache-Control"] = "no-store, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
    entry_path = f"/{grant.output_prefix}{grant.entry_file.removeprefix('dist/')}"
    return ObservablePreviewExchangeResponse(entry_path=entry_path, expires_at=grant.expires_at)


def source_project_response(
    record: ObservableSourceProject,
) -> ObservableSourceProjectResponse:
    return ObservableSourceProjectResponse(
        id=record.source_project_id,
        project_id=record.project_id,
        site_id=record.site_id,
        route_namespace=record.route_namespace,
        title=record.title,
        rights_status=record.rights_status,
        owner_user_id=record.owner_user_id,
        current_revision_id=record.current_revision_id,
        current_revision_number=record.current_revision_number,
        build_policy=ObservableBuildPolicyResponse(
            compiler_image_digest=record.compiler_image_digest,
            framework_version="1.13.4",
            lockfile_format="npm-package-lock-v3",
            network_policy="deny_all",
            resource_limits=record.resource_limits,
        ),
        created_by=record.created_by,
        created_at=record.created_at,
        updated_by=record.updated_by,
        updated_at=record.updated_at,
    )


def source_upload_response(
    record: ObservableSourceFileUploadTicket,
) -> ObservableSourceFileUploadResponse:
    return ObservableSourceFileUploadResponse(
        upload_id=record.upload_id,
        source_project_id=record.source_project_id,
        relative_path=record.relative_path,
        content_type=record.content_type,
        size_bytes=record.size_bytes,
        checksum_sha256=record.checksum_sha256,
        expires_at=record.upload.expires_at,
        upload=UploadInstructionsResponse(
            url=record.upload.url,
            method="POST",
            fields=dict(record.upload.fields),
        ),
    )


def source_revision_response(
    record: ObservableSourceRevision,
) -> ObservableSourceRevisionResponse:
    return ObservableSourceRevisionResponse(
        id=record.revision_id,
        source_project_id=record.source_project_id,
        revision_number=record.revision_number,
        parent_revision_id=record.parent_revision_id,
        title=record.title,
        rights_status=record.rights_status,
        entry_path=record.entry_path,
        lockfile_path=record.lockfile_path,
        manifest=record.manifest,
        manifest_checksum_sha256=record.manifest_checksum_sha256,
        change_summary=record.change_summary,
        created_by=record.created_by,
        created_at=record.created_at,
        files=[source_revision_file_response(item) for item in record.files],
    )


def source_revision_file_response(
    record: ObservableSourceRevisionFile,
) -> ObservableSourceRevisionFileResponse:
    return ObservableSourceRevisionFileResponse(
        relative_path=record.relative_path,
        source_object_id=record.source_object_id,
        bucket=record.bucket,
        object_key=record.object_key,
        s3_version_id=record.s3_version_id,
        etag=record.etag,
        content_type=record.content_type,
        size_bytes=record.size_bytes,
        checksum_sha256=record.checksum_sha256,
    )


def build_job_response(
    record: ObservableBuildJob,
    *,
    execution_available: bool = False,
    coordination_status: Literal[
        "not_configured", "configured", "dispatched", "dispatch_failed"
    ] = "not_configured",
) -> ObservableBuildJobResponse:
    return ObservableBuildJobResponse(
        id=record.build_job_id,
        source_project_id=record.source_project_id,
        source_revision_id=record.source_revision_id,
        source_revision_number=record.source_revision_number,
        purpose=record.purpose,
        state=record.state,
        request=record.request,
        request_checksum_sha256=record.request_checksum_sha256,
        result=_redacted_build_result(record.result),
        result_checksum_sha256=record.result_checksum_sha256,
        attempt_count=record.attempt_count,
        error_code=record.error_code,
        created_by=record.created_by,
        created_at=record.created_at,
        started_at=record.started_at,
        finished_at=record.finished_at,
        updated_at=record.updated_at,
        execution_available=execution_available,
        coordination_status=coordination_status,
    )


def _redacted_build_result(result: dict[str, Any] | None) -> dict[str, Any] | None:
    if result is None:
        return None
    sandbox = result.get("sandbox")
    if not isinstance(sandbox, dict):
        sandbox = {}
    validation_report = result.get("validationReport")
    if not isinstance(validation_report, dict):
        validation_report = {}
    route_manifest = result.get("routeManifest")
    if not isinstance(route_manifest, list):
        route_manifest = []
    output_manifest = result.get("outputManifest")
    files = output_manifest.get("files", []) if isinstance(output_manifest, dict) else []
    return {
        "schemaVersion": "opengeo.observable-build-client-result.1.0.0",
        "buildJobId": result.get("buildJobId"),
        "requestChecksumSha256": result.get("requestChecksumSha256"),
        "compilerImageDigest": result.get("compilerImageDigest"),
        "inputManifestChecksumSha256": result.get("inputManifestChecksumSha256"),
        "outputTreeChecksumSha256": result.get("outputTreeChecksumSha256"),
        "sandbox": {
            key: sandbox.get(key)
            for key in (
                "credentialMode",
                "networkPolicy",
                "readOnlyInputs",
                "readOnlyBaseImage",
                "unprivilegedUser",
                "dockerSocket",
            )
        },
        "networkRequests": [],
        "validationReport": {
            key: validation_report.get(key)
            for key in (
                "entryPath",
                "fixedBuilderConfig",
                "frameworkVersion",
                "inputBytes",
                "inputFileCount",
                "lockfileVerified",
                "outputBytes",
                "outputFileCount",
                "prewarmedFrameworkCache",
                "publicationAuthorized",
                "coordinatorSchemaVersion",
                "inputObjectsReverified",
                "outputBytesReverified",
                "outputObjectsReverified",
            )
        },
        "routeManifest": [
            {"path": route.get("path"), "file": route.get("file")}
            for route in route_manifest
            if isinstance(route, dict)
        ],
        "outputManifest": {
            "files": [
                {
                    "path": file.get("path"),
                    "contentType": file.get("contentType"),
                    "sizeBytes": file.get("sizeBytes"),
                    "checksumSha256": file.get("checksumSha256"),
                }
                for file in files
                if isinstance(file, dict)
            ]
        },
        "publicationAuthorized": False,
    }


class PublicationArtifactReference(RequestModel):
    path: RelativePath
    artifact_id: UUID
    mode: Literal["current", "pinned"]
    version: Annotated[int | None, Field(ge=1, le=2_147_483_647)] = None


class PublicationArtifactReferencesRequest(RequestModel):
    expected_revision: Annotated[int, Field(ge=0, le=2_147_483_646)]
    references: Annotated[list[PublicationArtifactReference], Field(max_length=32)]


@router.get("/projects/{project_id}/source-projects/{source_project_id}/artifact-references")
async def read_publication_artifact_references(
    project_id: UUID,
    source_project_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return await execute_observable(
        repository.artifact_references(tenant_context(session), project_id, source_project_id)
    )


@router.get("/projects/{project_id}/source-projects/{source_project_id}/artifact-backup-inputs")
async def read_publication_artifact_backup_inputs(
    project_id: UUID,
    source_project_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
    expected_reference_revision: Annotated[int | None, Query(ge=0, le=2_147_483_647)] = None,
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return await execute_observable(
        artifact_backup_inputs(
            cast(PostgresObservableSourceRepository, repository),
            tenant_context(session),
            project_id,
            source_project_id,
            expected_reference_revision,
        )
    )


@router.put("/projects/{project_id}/source-projects/{source_project_id}/artifact-references")
async def write_publication_artifact_references(
    project_id: UUID,
    source_project_id: UUID,
    body: PublicationArtifactReferencesRequest,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return await execute_observable(
        repository.artifact_references(
            tenant_context(session),
            project_id,
            source_project_id,
            [item.model_dump(mode="json") for item in body.references],
            body.expected_revision,
        )
    )


class PreparePublicationArtifactInputs(RequestModel):
    expected_reference_revision: Annotated[int, Field(ge=1, le=2_147_483_647)]


@router.post(
    "/projects/{project_id}/source-projects/{source_project_id}/revisions/{revision_id}/artifact-inputs"
)
async def prepare_publication_artifact_inputs(
    project_id: UUID,
    source_project_id: UUID,
    revision_id: UUID,
    body: PreparePublicationArtifactInputs,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return await execute_observable(
        repository.prepare_artifact_inputs(
            tenant_context(session),
            project_id,
            source_project_id,
            revision_id,
            body.expected_reference_revision,
        )
    )


@router.get("/projects/{project_id}/source-projects/{source_project_id}/artifact-inputs/{input_id}")
async def read_publication_artifact_inputs(
    project_id: UUID,
    source_project_id: UUID,
    input_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return await execute_observable(
        repository.read_artifact_inputs(
            tenant_context(session), project_id, source_project_id, input_id
        )
    )


class ArtifactLeaseRequest(RequestModel):
    organization_id: UUID
    user_id: UUID
    coordinator_token: UUID


@router.post("/observable-build-leases/{build_job_id}/artifact-inputs")
async def resolve_publication_artifact_lease(
    build_job_id: UUID,
    payload: ArtifactLeaseRequest,
    response: Response,
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> list[dict[str, Any]]:
    # Capability authentication: the first repository query verifies the live job
    # token AND this exact actor/tenant before consulting any source permissions.
    response.headers["Cache-Control"] = "no-store"
    return await execute_observable(
        repository.resolve_artifact_lease(
            TenantContext(payload.user_id, payload.organization_id),
            build_job_id,
            payload.coordinator_token,
        )
    )


@router.get(
    "/projects/{project_id}/source-projects/{source_project_id}/revisions/{source_revision_id}/distribution-approvals"
)
async def distribution_input_review(
    project_id: UUID,
    source_project_id: UUID,
    source_revision_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
    artifact_input_id: UUID | None = None,
    build_job_id: UUID | None = None,
) -> dict[str, Any]:
    from opengeo_api.observable_distribution_approvals import review_distribution_inputs

    if not isinstance(repository, PostgresObservableSourceRepository):
        raise HTTPException(status_code=503, detail="distribution_approval_store_unavailable")
    response.headers["Cache-Control"] = "no-store"
    return await execute_observable(
        review_distribution_inputs(
            repository,
            tenant_context(session),
            project_id,
            source_project_id,
            source_revision_id,
            artifact_input_id,
            build_job_id,
        )
    )


@router.post(
    "/projects/{project_id}/source-projects/{source_project_id}/revisions/{source_revision_id}/distribution-approvals"
)
async def distribution_input_approval(
    project_id: UUID,
    source_project_id: UUID,
    source_revision_id: UUID,
    payload: CreateDistributionApprovalRequest,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    from opengeo_api.observable_distribution_approvals import create_distribution_approval

    if not isinstance(repository, PostgresObservableSourceRepository):
        raise HTTPException(status_code=503, detail="distribution_approval_store_unavailable")
    response.headers["Cache-Control"] = "no-store"
    return await execute_observable(
        create_distribution_approval(
            repository,
            tenant_context(session),
            project_id,
            source_project_id,
            source_revision_id,
            payload.artifact_input_id,
            payload.output_profile,
            [item.model_dump() for item in payload.archive_rights],
            [item.model_dump() for item in payload.artifact_releases],
            payload.approval_id,
            referenced_rights=[item.model_dump() for item in payload.referenced_rights],
        )
    )


@router.post(
    "/projects/{project_id}/source-projects/{source_project_id}/revisions/{source_revision_id}/distribution-approvals/{approval_id}/revoke"
)
async def distribution_input_revocation(
    project_id: UUID,
    source_project_id: UUID,
    source_revision_id: UUID,
    approval_id: UUID,
    payload: RevokeDistributionApprovalRequest,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ObservableSourceRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    from opengeo_api.observable_distribution_approvals import revoke_distribution_approval

    del payload
    if not isinstance(repository, PostgresObservableSourceRepository):
        raise HTTPException(status_code=503, detail="distribution_approval_store_unavailable")
    response.headers["Cache-Control"] = "no-store"
    return await execute_observable(
        revoke_distribution_approval(
            repository,
            tenant_context(session),
            project_id,
            source_project_id,
            source_revision_id,
            approval_id,
        )
    )
