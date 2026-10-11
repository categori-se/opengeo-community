import logging
import re
from asyncio import gather
from base64 import b64encode
from collections.abc import Awaitable
from hashlib import sha256
from typing import Annotated, Any, Literal, cast
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
from opengeo_api.document_previews import (
    PDF_VISUAL_PRESENTATION_SCHEMAS,
    DocumentPreviewInvalid,
    document_visual_page,
    parse_document_preview,
)
from opengeo_api.logging import get_request_id
from opengeo_api.rendering import (
    PostgresRenderRepository,
    RenderConflict,
    RenderedMapOutput,
    RenderNotFound,
    RenderRepository,
    RenderStoreUnavailable,
    SealedRenderOutput,
)
from opengeo_api.s3_downloads import (
    DownloadStorage,
    DownloadStorageUnavailable,
    ExactObject,
    ExactObjectSpec,
)
from opengeo_api.site_export import (
    SITE_CSP,
    SITE_CSS,
    SITE_JS,
    build_static_package,
    render_page_html,
)
from opengeo_api.site_layouts import SiteLayoutError, empty_print_layout, parse_print_layout
from opengeo_api.site_print import (
    PRINT_RASTER_DPI,
    SitePrintError,
    build_map_sheet_svg,
    build_print_page_png,
    build_print_pdf,
)
from opengeo_api.site_publications import (
    MAX_SITE_ASSET_BYTES,
    MAX_SITE_SNAPSHOT_BYTES,
    PostgresSitePublicationRepository,
    ProjectSite,
    PublicSiteDirectoryRecord,
    PublishedSite,
    PublishedSiteAsset,
    SiteAccessDenied,
    SiteAssetCandidate,
    SiteConflict,
    SiteDraft,
    SiteEdition,
    SiteMapSnapshotDraft,
    SiteNotFound,
    SitePage,
    SitePageDraft,
    SitePublicationDestination,
    SitePublicationRepository,
    SiteStoreUnavailable,
)
from opengeo_api.tenant_database import TenantContext

logger = logging.getLogger(__name__)
router = APIRouter(tags=["project site publishing"])
PUBLIC_SITE_USER_ID = UUID("00000000-0000-0000-0000-000000000000")

Slug = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        to_lower=True,
        min_length=1,
        max_length=160,
        pattern=r"^[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?$",
    ),
]
UnlistedToken = Annotated[
    str,
    StringConstraints(min_length=32, max_length=32, pattern=r"^[0-9a-f]{32}$"),
]
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
Description = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4_000)
]
NavigationLabel = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)
]
Language = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=2,
        max_length=40,
        pattern=r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$",
    ),
]
Reason = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1_000)]
ChangeMessage = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)
]
_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SitePageRequest(RequestModel):
    slug: Slug
    navigation_label: NavigationLabel
    resource_id: UUID
    resource_version: int = Field(ge=1)
    is_home: bool = False


class SiteDocumentRequest(RequestModel):
    title: Title
    description: Description | None = None
    language: Language = "en"
    theme: Literal["paper", "atlas", "minimal"] = "paper"
    theme_options: dict[str, str] = Field(default_factory=dict, max_length=8)
    print_layout: dict[str, Any] = Field(default_factory=empty_print_layout)
    pages: list[SitePageRequest] = Field(min_length=1, max_length=64)

    @field_validator("language", mode="after")
    @classmethod
    def normalize_language(cls, value: str) -> str:
        return value.lower()

    @field_validator("theme_options", mode="after")
    @classmethod
    def validate_theme_options(cls, value: dict[str, str]) -> dict[str, str]:
        allowed = {
            "accentColor",
            "footerText",
            "printPageSize",
            "printOrientation",
            "printLayout",
            "printLegend",
            "printNorthArrow",
            "printScaleBar",
        }
        if unknown := set(value) - allowed:
            raise ValueError(f"unknown theme option {sorted(unknown)[0]}")
        if "accentColor" in value and _COLOR.fullmatch(value["accentColor"]) is None:
            raise ValueError("accentColor must be a six-digit hexadecimal color")
        if "footerText" in value and not 1 <= len(value["footerText"].strip()) <= 500:
            raise ValueError("footerText must contain one to 500 characters")
        enums = {
            "printPageSize": {"letter", "legal", "tabloid", "a4", "a3", "a2", "a1", "a0"},
            "printOrientation": {"portrait", "landscape"},
            "printLayout": {"flow", "map-sheet"},
            "printLegend": {"true", "false"},
            "printNorthArrow": {"true", "false"},
            "printScaleBar": {"true", "false"},
        }
        normalized = {key: item.strip() for key, item in value.items()}
        for key, choices in enums.items():
            if key in normalized and normalized[key] not in choices:
                raise ValueError(f"{key} is invalid")
        return normalized

    @field_validator("pages", mode="after")
    @classmethod
    def validate_pages(cls, pages: list[SitePageRequest]) -> list[SitePageRequest]:
        if sum(page.is_home for page in pages) != 1:
            raise ValueError("exactly one site page must be home")
        slugs = [page.slug.casefold() for page in pages]
        resources = [page.resource_id for page in pages]
        if len(slugs) != len(set(slugs)):
            raise ValueError("site page slugs must be unique")
        if len(resources) != len(set(resources)):
            raise ValueError("a resource can appear as a page only once per site version")
        return pages

    @field_validator("print_layout", mode="after")
    @classmethod
    def validate_print_layout(cls, value: dict[str, Any]) -> dict[str, Any]:
        try:
            return parse_print_layout(value).as_json()
        except SiteLayoutError as error:
            raise ValueError(str(error)) from error

    @model_validator(mode="after")
    def validate_print_layout_pages(self) -> "SiteDocumentRequest":
        site_page_slugs = {page.slug for page in self.pages}
        layout_page_slugs = {
            page.site_page_slug for page in parse_print_layout(self.print_layout).pages
        }
        if not layout_page_slugs <= site_page_slugs:
            raise ValueError("site_print_layout_page_not_found")
        return self


class CreateSiteRequest(SiteDocumentRequest):
    slug: Slug


class UpdateSiteRequest(SiteDocumentRequest):
    expected_version: int = Field(ge=1)
    change_message: ChangeMessage


class SiteTransitionRequest(RequestModel):
    expected_version: int = Field(ge=1)
    reason: Reason | None = None


class SiteMapSnapshotRequest(RequestModel):
    resource_id: UUID
    render_job_id: UUID


class PublishSiteRequest(SiteTransitionRequest):
    map_snapshots: list[SiteMapSnapshotRequest] = Field(default_factory=list, max_length=16)

    @field_validator("map_snapshots", mode="after")
    @classmethod
    def validate_map_snapshots(
        cls, snapshots: list[SiteMapSnapshotRequest]
    ) -> list[SiteMapSnapshotRequest]:
        resources = [snapshot.resource_id for snapshot in snapshots]
        jobs = [snapshot.render_job_id for snapshot in snapshots]
        if len(resources) != len(set(resources)) or len(jobs) != len(set(jobs)):
            raise ValueError("site map snapshots must have unique resources and render jobs")
        return snapshots


class ConfigureSitePublicationDestinationRequest(RequestModel):
    expected_revision: int = Field(ge=1)
    reach: Literal["unpublished", "unlisted", "listed"]
    listed_slug: Slug | None = None
    is_primary: bool = False

    @model_validator(mode="after")
    def validate_destination(self) -> "ConfigureSitePublicationDestinationRequest":
        if self.reach == "listed" and self.listed_slug is None:
            raise ValueError("listed publication requires a human-readable path")
        if self.is_primary and self.reach != "listed":
            raise ValueError("only a listed publication can be the primary site")
        return self


class SitePageResponse(BaseModel):
    id: UUID
    slug: str
    navigation_label: str
    position: int
    is_home: bool
    resource_id: UUID
    resource_version_id: UUID
    resource_version_number: int
    resource_kind: str
    resource_title: str
    resource_state: str
    resource_visibility: str
    content: dict[str, Any]


class SiteEditionResponse(BaseModel):
    id: UUID
    site_id: UUID
    site_version_id: UUID
    site_version_number: int
    edition_number: int
    manifest: dict[str, Any]
    manifest_checksum_sha256: str
    published_by: UUID
    published_at: str
    revoked_by: UUID | None
    revoked_at: str | None
    publication_reach: Literal["unpublished", "unlisted", "listed"]
    listed_slug: str | None
    unlisted_token: str | None
    is_primary: bool


class SitePublicationDestinationResponse(BaseModel):
    revision: int
    reach: Literal["unpublished", "unlisted", "listed"]
    listed_slug: str | None
    is_primary: bool
    configured_by: UUID
    configured_at: str


class PublicSiteDirectoryRecordResponse(BaseModel):
    project_id: UUID
    project_name: str
    site_id: UUID
    edition_id: UUID
    listed_slug: str
    title: str
    description: str | None
    language: str
    theme: str
    page_count: int
    published_at: str
    is_primary: bool
    href: str
    primary_href: str | None


class PublicSiteDirectoryResponse(BaseModel):
    schema_version: Literal["opengeo.public-site-directory.1.0.0"]
    number_returned: int
    number_matched: int
    limit: int
    offset: int
    next_offset: int | None
    records: list[PublicSiteDirectoryRecordResponse]


class SiteResponse(BaseModel):
    id: UUID
    project_id: UUID
    slug: str
    version_id: UUID
    version_number: int
    state: str
    title: str
    description: str | None
    language: str
    theme: str
    theme_options: dict[str, Any]
    print_layout: dict[str, Any]
    change_message: str | None
    created_by: UUID
    created_at: str
    updated_by: UUID
    updated_at: str
    pages: list[SitePageResponse]
    active_edition: SiteEditionResponse | None
    publication_destination: SitePublicationDestinationResponse


class PublicationResponse(BaseModel):
    id: UUID
    resource_type: Literal["publication"] = "publication"
    access_container_id: UUID
    site: SiteResponse


class SiteAssetCandidateResponse(BaseModel):
    kind: Literal["image", "file", "document"]
    dataset_id: UUID
    dataset_name: str
    dataset_version_id: UUID
    dataset_version_number: int
    object_id: UUID
    role: str
    content_type: str
    size_bytes: int
    checksum_sha256: str
    filename: str


def repository_from_request(request: Request) -> SitePublicationRepository:
    repository = request.app.state.site_publication_repository
    if not isinstance(repository, PostgresSitePublicationRepository):
        return cast(SitePublicationRepository, repository)
    return repository


def render_repository_from_request(request: Request) -> RenderRepository:
    repository = request.app.state.render_repository
    if not isinstance(repository, PostgresRenderRepository):
        return cast(RenderRepository, repository)
    return repository


def download_storage_from_request(request: Request) -> DownloadStorage:
    return cast(DownloadStorage, request.app.state.download_storage)


def tenant_context(session: AuthSession) -> TenantContext:
    membership = require_organization(session)
    return TenantContext(session.principal.user_id, membership.organization_id)


def public_tenant_context(organization_id: UUID) -> TenantContext:
    return TenantContext(PUBLIC_SITE_USER_ID, organization_id)


async def execute_site[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except SiteAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except SiteNotFound as error:
        raise HTTPException(status_code=404, detail=f"{error.resource}_not_found") from error
    except SiteConflict as error:
        detail: dict[str, Any] = {"code": error.code}
        if error.current_version is not None:
            detail["current_version"] = error.current_version
        raise HTTPException(status_code=409, detail=detail) from error
    except SiteStoreUnavailable as error:
        logger.error("site.store_unavailable", extra={"error_type": type(error).__name__})
        raise HTTPException(status_code=503, detail="site_store_unavailable") from error


async def execute_public_site[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except (SiteNotFound, SiteConflict) as error:
        raise HTTPException(status_code=404, detail="site_edition_not_found") from error
    except SiteStoreUnavailable as error:
        logger.error("site.public_store_unavailable", extra={"error_type": type(error).__name__})
        raise HTTPException(status_code=503, detail="site_store_unavailable") from error


async def execute_public_snapshot(operation: Awaitable[RenderedMapOutput]) -> RenderedMapOutput:
    try:
        return await operation
    except (RenderNotFound, RenderConflict) as error:
        raise HTTPException(status_code=404, detail="site_snapshot_not_found") from error
    except (RenderStoreUnavailable, DownloadStorageUnavailable) as error:
        logger.error("site.snapshot_store_unavailable", extra={"error_type": type(error).__name__})
        raise HTTPException(status_code=503, detail="site_snapshot_store_unavailable") from error


async def execute_public_asset(operation: Awaitable[ExactObject]) -> ExactObject:
    try:
        return await operation
    except DownloadStorageUnavailable as error:
        logger.error("site.asset_store_unavailable", extra={"error_type": type(error).__name__})
        raise HTTPException(status_code=503, detail="site_asset_store_unavailable") from error


def _draft(payload: SiteDocumentRequest, *, change_message: str | None = None) -> SiteDraft:
    return SiteDraft(
        title=payload.title,
        description=payload.description,
        language=payload.language,
        theme=payload.theme,
        theme_options=payload.theme_options,
        print_layout=payload.print_layout,
        pages=tuple(
            SitePageDraft(
                slug=page.slug,
                navigation_label=page.navigation_label,
                resource_id=page.resource_id,
                resource_version=page.resource_version,
                is_home=page.is_home,
            )
            for page in payload.pages
        ),
        change_message=change_message,
    )


def asset_candidate_response(record: SiteAssetCandidate) -> SiteAssetCandidateResponse:
    return SiteAssetCandidateResponse(
        kind=record.kind,
        dataset_id=record.dataset_id,
        dataset_name=record.dataset_name,
        dataset_version_id=record.dataset_version_id,
        dataset_version_number=record.dataset_version_number,
        object_id=record.object_id,
        role=record.role,
        content_type=record.content_type,
        size_bytes=record.size_bytes,
        checksum_sha256=record.checksum_sha256,
        filename=record.filename,
    )


@router.get(
    "/projects/{project_id}/site-assets",
    response_model=list[SiteAssetCandidateResponse],
)
async def list_site_asset_candidates(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
) -> list[SiteAssetCandidateResponse]:
    records = await execute_site(
        repository.list_asset_candidates(tenant_context(session), project_id)
    )
    return [asset_candidate_response(record) for record in records]


@router.get("/projects/{project_id}/sites", response_model=list[SiteResponse])
async def list_sites(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
) -> list[SiteResponse]:
    records = await execute_site(repository.list_sites(tenant_context(session), project_id))
    return [site_response(record) for record in records]


@router.post(
    "/projects/{project_id}/sites",
    response_model=SiteResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_site(
    project_id: UUID,
    payload: CreateSiteRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
) -> SiteResponse:
    record = await execute_site(
        repository.create_site(
            tenant_context(session), project_id, payload.slug, _draft(payload), get_request_id()
        )
    )
    return site_response(record)


@router.get("/publications/{publication_id}", response_model=PublicationResponse)
async def get_publication(
    publication_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
) -> PublicationResponse:
    record = await execute_site(repository.get_publication(tenant_context(session), publication_id))
    response.headers["Cache-Control"] = "no-store"
    return PublicationResponse(
        id=record.site_id, access_container_id=record.project_id, site=site_response(record)
    )


@router.get("/projects/{project_id}/sites/{site_id}", response_model=SiteResponse)
async def get_site(
    project_id: UUID,
    site_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
) -> SiteResponse:
    return site_response(
        await execute_site(repository.get_site(tenant_context(session), project_id, site_id))
    )


@router.put("/projects/{project_id}/sites/{site_id}", response_model=SiteResponse)
async def update_site(
    project_id: UUID,
    site_id: UUID,
    payload: UpdateSiteRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
) -> SiteResponse:
    record = await execute_site(
        repository.update_site(
            tenant_context(session),
            project_id,
            site_id,
            payload.expected_version,
            _draft(payload, change_message=payload.change_message),
            get_request_id(),
        )
    )
    return site_response(record)


@router.put(
    "/projects/{project_id}/sites/{site_id}/publication-destination",
    response_model=SiteResponse,
)
async def configure_site_publication_destination(
    project_id: UUID,
    site_id: UUID,
    payload: ConfigureSitePublicationDestinationRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
) -> SiteResponse:
    record = await execute_site(
        repository.configure_site_publication_destination(
            tenant_context(session),
            project_id,
            site_id,
            payload.expected_revision,
            payload.reach,
            payload.listed_slug,
            payload.is_primary,
            get_request_id(),
        )
    )
    return site_response(record)


@router.post(
    "/projects/{project_id}/sites/{site_id}/review",
    response_model=SiteResponse,
)
async def submit_site_for_review(
    project_id: UUID,
    site_id: UUID,
    payload: SiteTransitionRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
) -> SiteResponse:
    record = await execute_site(
        repository.submit_site_for_review(
            tenant_context(session),
            project_id,
            site_id,
            payload.expected_version,
            payload.reason,
            get_request_id(),
        )
    )
    return site_response(record)


@router.post(
    "/projects/{project_id}/sites/{site_id}/publish",
    response_model=SiteResponse,
)
async def publish_site(
    project_id: UUID,
    site_id: UUID,
    payload: PublishSiteRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
) -> SiteResponse:
    record = await execute_site(
        repository.publish_site(
            tenant_context(session),
            project_id,
            site_id,
            payload.expected_version,
            payload.reason,
            tuple(
                SiteMapSnapshotDraft(
                    resource_id=snapshot.resource_id,
                    render_job_id=snapshot.render_job_id,
                )
                for snapshot in payload.map_snapshots
            ),
            get_request_id(),
        )
    )
    return site_response(record)


@router.get(
    "/projects/{project_id}/sites/{site_id}/editions",
    response_model=list[SiteEditionResponse],
)
async def list_editions(
    project_id: UUID,
    site_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
) -> list[SiteEditionResponse]:
    records = await execute_site(
        repository.list_editions(tenant_context(session), project_id, site_id)
    )
    return [edition_response(record) for record in records]


@router.post(
    "/projects/{project_id}/sites/{site_id}/editions/{edition_id}/revoke",
    response_model=SiteEditionResponse,
)
async def revoke_edition(
    project_id: UUID,
    site_id: UUID,
    edition_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
) -> SiteEditionResponse:
    record = await execute_site(
        repository.revoke_edition(
            tenant_context(session), project_id, site_id, edition_id, get_request_id()
        )
    )
    return edition_response(record)


@router.get("/public/site-assets/site.css", include_in_schema=False)
async def public_site_css() -> Response:
    return Response(
        SITE_CSS,
        media_type="text/css",
        headers={"Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff"},
    )


@router.get("/public/site-assets/site.js", include_in_schema=False)
async def public_site_js() -> Response:
    return Response(
        SITE_JS,
        media_type="text/javascript",
        headers={"Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff"},
    )


@router.get(
    "/public/organizations/{organization_id}/publications",
    response_model=PublicSiteDirectoryResponse,
    summary="List active human-readable publications for one OpenGeo account",
)
async def list_public_sites(
    organization_id: UUID,
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
    limit: Annotated[int, Query(ge=1, le=100)] = 24,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> PublicSiteDirectoryResponse:
    page = await execute_public_site(
        repository.list_public_sites(
            public_tenant_context(organization_id),
            limit=limit,
            offset=offset,
        )
    )
    returned = len(page.records)
    candidate_offset = offset + returned
    return PublicSiteDirectoryResponse(
        schema_version="opengeo.public-site-directory.1.0.0",
        number_returned=returned,
        number_matched=page.number_matched,
        limit=limit,
        offset=offset,
        next_offset=(candidate_offset if candidate_offset < page.number_matched else None),
        records=[
            public_site_directory_response(organization_id, record) for record in page.records
        ],
    )


@router.get(
    "/public/organizations/{organization_id}/publication",
    response_class=Response,
    summary="Read the account's active primary publication home page",
)
@router.get(
    "/public/organizations/{organization_id}/publication/{page_slug}",
    response_class=Response,
    summary="Read a page of the account's active primary publication",
)
async def public_primary_site_page(
    organization_id: UUID,
    http_request: Request,
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
    download_storage: Annotated[DownloadStorage, Depends(download_storage_from_request)],
    page_slug: Slug | None = None,
) -> Response:
    publication = await execute_public_site(
        repository.get_public_site_by_destination(
            public_tenant_context(organization_id),
            primary=True,
        )
    )
    site_root = (
        f"{str(http_request.base_url).rstrip('/')}"
        f"/public/organizations/{organization_id}/publication"
    )
    return await _public_site_page_response(
        publication,
        organization_id,
        publication.site.project_id,
        page_slug,
        site_root,
        http_request,
        repository,
        download_storage,
    )


@router.get(
    "/public/organizations/{organization_id}/publications/{site_slug}",
    response_class=Response,
    summary="Read an account publication by its human-readable path",
)
@router.get(
    "/public/organizations/{organization_id}/publications/{site_slug}/{page_slug}",
    response_class=Response,
    summary="Read a page of an account publication by its human-readable path",
)
async def public_listed_site_page(
    organization_id: UUID,
    site_slug: Slug,
    http_request: Request,
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
    download_storage: Annotated[DownloadStorage, Depends(download_storage_from_request)],
    page_slug: Slug | None = None,
) -> Response:
    publication = await execute_public_site(
        repository.get_public_site_by_destination(
            public_tenant_context(organization_id),
            listed_slug=site_slug,
        )
    )
    site_root = (
        f"{str(http_request.base_url).rstrip('/')}"
        f"/public/organizations/{organization_id}/publications/{site_slug}"
    )
    return await _public_site_page_response(
        publication,
        organization_id,
        publication.site.project_id,
        page_slug,
        site_root,
        http_request,
        repository,
        download_storage,
    )


@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/sites/{site_slug}/export.zip",
    response_class=Response,
    summary="Download the current revocable site edition as a portable static package",
)
async def export_public_site(
    organization_id: UUID,
    project_id: UUID,
    site_slug: Slug,
    http_request: Request,
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
    render_repository: Annotated[RenderRepository, Depends(render_repository_from_request)],
    download_storage: Annotated[DownloadStorage, Depends(download_storage_from_request)],
) -> Response:
    publication = await execute_public_site(
        repository.get_public_site(
            public_tenant_context(organization_id), project_id, site_slug=site_slug
        )
    )
    return await _package_response(
        publication,
        organization_id,
        project_id,
        http_request,
        repository,
        render_repository,
        download_storage,
    )


@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/site-editions/{edition_id}/export.zip",
    response_class=Response,
    summary="Download one exact, still-active site edition as a portable static package",
)
async def export_exact_public_site_edition(
    organization_id: UUID,
    project_id: UUID,
    edition_id: UUID,
    http_request: Request,
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
    render_repository: Annotated[RenderRepository, Depends(render_repository_from_request)],
    download_storage: Annotated[DownloadStorage, Depends(download_storage_from_request)],
) -> Response:
    publication = await execute_public_site(
        repository.get_public_site(
            public_tenant_context(organization_id), project_id, edition_id=edition_id
        )
    )
    return await _package_response(
        publication,
        organization_id,
        project_id,
        http_request,
        repository,
        render_repository,
        download_storage,
    )


@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/sites/{site_slug}/print.pdf",
    response_class=Response,
    summary="Download the current site edition as a deterministic print PDF",
)
async def print_public_site(
    organization_id: UUID,
    project_id: UUID,
    site_slug: Slug,
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
    render_repository: Annotated[RenderRepository, Depends(render_repository_from_request)],
    download_storage: Annotated[DownloadStorage, Depends(download_storage_from_request)],
) -> Response:
    publication = await execute_public_site(
        repository.get_public_site(
            public_tenant_context(organization_id), project_id, site_slug=site_slug
        )
    )
    return await _print_response(
        publication, organization_id, repository, render_repository, download_storage
    )


@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/site-editions/{edition_id}/print.pdf",
    response_class=Response,
    summary="Download one exact, still-active site edition as a deterministic print PDF",
)
async def print_exact_public_site_edition(
    organization_id: UUID,
    project_id: UUID,
    edition_id: UUID,
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
    render_repository: Annotated[RenderRepository, Depends(render_repository_from_request)],
    download_storage: Annotated[DownloadStorage, Depends(download_storage_from_request)],
) -> Response:
    publication = await execute_public_site(
        repository.get_public_site(
            public_tenant_context(organization_id), project_id, edition_id=edition_id
        )
    )
    return await _print_response(
        publication, organization_id, repository, render_repository, download_storage
    )


@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/sites/{site_slug}/print/"
    "pages/{page_slug}.png",
    response_class=Response,
    summary="Download one whole-page PNG from the current immutable site edition",
)
async def print_public_site_page_png(
    organization_id: UUID,
    project_id: UUID,
    site_slug: Slug,
    page_slug: Slug,
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
    render_repository: Annotated[RenderRepository, Depends(render_repository_from_request)],
    download_storage: Annotated[DownloadStorage, Depends(download_storage_from_request)],
) -> Response:
    publication = await execute_public_site(
        repository.get_public_site(
            public_tenant_context(organization_id), project_id, site_slug=site_slug
        )
    )
    return await _print_page_png_response(
        publication,
        page_slug,
        organization_id,
        repository,
        render_repository,
        download_storage,
    )


@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/site-editions/"
    "{edition_id}/print/pages/{page_slug}.png",
    response_class=Response,
    summary="Download one whole-page PNG from one exact, still-active site edition",
)
async def print_exact_public_site_page_png(
    organization_id: UUID,
    project_id: UUID,
    edition_id: UUID,
    page_slug: Slug,
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
    render_repository: Annotated[RenderRepository, Depends(render_repository_from_request)],
    download_storage: Annotated[DownloadStorage, Depends(download_storage_from_request)],
) -> Response:
    publication = await execute_public_site(
        repository.get_public_site(
            public_tenant_context(organization_id), project_id, edition_id=edition_id
        )
    )
    return await _print_page_png_response(
        publication,
        page_slug,
        organization_id,
        repository,
        render_repository,
        download_storage,
    )


@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/sites/{site_slug}/print/"
    "{resource_id}.svg",
    response_class=Response,
    summary="Read a self-contained printable SVG sheet for a map in the current edition",
)
async def print_public_site_map_sheet(
    organization_id: UUID,
    project_id: UUID,
    site_slug: Slug,
    resource_id: UUID,
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
    render_repository: Annotated[RenderRepository, Depends(render_repository_from_request)],
) -> Response:
    publication = await execute_public_site(
        repository.get_public_site(
            public_tenant_context(organization_id), project_id, site_slug=site_slug
        )
    )
    return await _map_sheet_response(
        publication, resource_id, organization_id, repository, render_repository
    )


@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/site-editions/"
    "{edition_id}/print/{resource_id}.svg",
    response_class=Response,
    summary="Read a self-contained printable SVG sheet for a map in one exact edition",
)
async def print_exact_public_site_map_sheet(
    organization_id: UUID,
    project_id: UUID,
    edition_id: UUID,
    resource_id: UUID,
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
    render_repository: Annotated[RenderRepository, Depends(render_repository_from_request)],
) -> Response:
    publication = await execute_public_site(
        repository.get_public_site(
            public_tenant_context(organization_id), project_id, edition_id=edition_id
        )
    )
    return await _map_sheet_response(
        publication, resource_id, organization_id, repository, render_repository
    )


@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/site-editions/"
    "{edition_id}/maps/{resource_id}.png",
    response_class=Response,
    summary="Read an immutable PNG map snapshot sealed into an active site edition",
)
async def public_site_map_snapshot(
    organization_id: UUID,
    project_id: UUID,
    edition_id: UUID,
    resource_id: UUID,
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
    render_repository: Annotated[RenderRepository, Depends(render_repository_from_request)],
) -> Response:
    publication = await execute_public_site(
        repository.get_public_site(
            public_tenant_context(organization_id), project_id, edition_id=edition_id
        )
    )
    reference = next(
        (
            candidate
            for candidate in publication.references
            if candidate.resource_id == resource_id and candidate.snapshot is not None
        ),
        None,
    )
    if reference is None or reference.snapshot is None:
        raise HTTPException(status_code=404, detail="site_snapshot_not_found")
    output = await _read_snapshot(
        publication, reference.resource_id, organization_id, repository, render_repository
    )
    digest = b64encode(bytes.fromhex(output.checksum_sha256)).decode("ascii")
    return Response(
        output.body,
        media_type="image/png",
        headers={
            "Content-Disposition": f'inline; filename="{resource_id}.png"',
            "Cache-Control": "public, max-age=60, must-revalidate",
            "ETag": f'"{output.checksum_sha256}"',
            "Digest": f"sha-256={digest}",
            "X-OpenGeo-Checksum-SHA256": output.checksum_sha256,
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/site-editions/"
    "{edition_id}/previews/{resource_id}.png",
    response_class=Response,
    summary="Read a bounded retained map preview from a listed Publication edition",
)
async def public_site_map_preview(
    organization_id: UUID,
    project_id: UUID,
    edition_id: UUID,
    resource_id: UUID,
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
    render_repository: Annotated[RenderRepository, Depends(render_repository_from_request)],
) -> Response:
    from opengeo_api.publication_previews import MAX_PUBLICATION_PREVIEW_BYTES

    publication = await execute_public_site(
        repository.get_public_site(
            public_tenant_context(organization_id), project_id, edition_id=edition_id
        )
    )
    reference = next(
        (item for item in publication.references if item.resource_id == resource_id), None
    )
    snapshot = reference.snapshot if reference else None
    if (
        publication.edition.publication_reach != "listed"
        or snapshot is None
        or snapshot.content_type != "image/png"
        or not 0 < snapshot.size_bytes <= MAX_PUBLICATION_PREVIEW_BYTES
    ):
        raise HTTPException(status_code=404, detail="site_preview_not_found")
    output = await _read_snapshot(
        publication,
        resource_id,
        organization_id,
        repository,
        render_repository,
        maximum_bytes=MAX_PUBLICATION_PREVIEW_BYTES,
    )
    return Response(
        output.body,
        media_type="image/png",
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "ETag": f'"{output.checksum_sha256}"',
        },
    )


@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/site-editions/"
    "{edition_id}/assets/{object_id}",
    response_class=Response,
    summary="Read one immutable governed asset sealed into an active site edition",
)
async def public_site_asset(
    organization_id: UUID,
    project_id: UUID,
    edition_id: UUID,
    object_id: UUID,
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
    download_storage: Annotated[DownloadStorage, Depends(download_storage_from_request)],
) -> Response:
    publication = await execute_public_site(
        repository.get_public_site(
            public_tenant_context(organization_id), project_id, edition_id=edition_id
        )
    )
    asset = next(
        (candidate for candidate in publication.assets if candidate.object_id == object_id),
        None,
    )
    if asset is None:
        raise HTTPException(status_code=404, detail="site_asset_not_found")
    exact = await _read_site_asset(
        publication,
        asset,
        organization_id,
        repository,
        download_storage,
    )
    digest = b64encode(bytes.fromhex(exact.checksum_sha256)).decode("ascii")
    disposition = "inline" if asset.kind == "image" else "attachment"
    return Response(
        exact.body,
        media_type=asset.content_type,
        headers={
            "Content-Disposition": f'{disposition}; filename="{asset.filename}"',
            "Cache-Control": "public, max-age=60, must-revalidate",
            "ETag": f'"{asset.checksum_sha256}"',
            "Digest": f"sha-256={digest}",
            "X-OpenGeo-Checksum-SHA256": asset.checksum_sha256,
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/site-editions/"
    "{edition_id}/assets/{object_id}/pages/{page_number}.jpg",
    response_class=Response,
    summary="Read one bounded visual PDF page sealed into an active site edition",
)
async def public_site_document_page(
    organization_id: UUID,
    project_id: UUID,
    edition_id: UUID,
    object_id: UUID,
    page_number: int,
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
    download_storage: Annotated[DownloadStorage, Depends(download_storage_from_request)],
) -> Response:
    if not 1 <= page_number <= 200:
        raise HTTPException(status_code=404, detail="site_document_page_not_found")
    publication = await execute_public_site(
        repository.get_public_site(
            public_tenant_context(organization_id), project_id, edition_id=edition_id
        )
    )
    asset = next(
        (
            candidate
            for candidate in publication.assets
            if candidate.object_id == object_id and candidate.kind == "document"
        ),
        None,
    )
    if asset is None:
        raise HTTPException(status_code=404, detail="site_document_page_not_found")
    exact = await _read_site_asset(
        publication,
        asset,
        organization_id,
        repository,
        download_storage,
    )
    try:
        preview = parse_document_preview(exact.body)
        image, checksum = document_visual_page(preview, page_number)
    except DocumentPreviewInvalid as error:
        raise HTTPException(status_code=404, detail="site_document_page_not_found") from error
    digest = b64encode(bytes.fromhex(checksum)).decode("ascii")
    return Response(
        image,
        media_type="image/jpeg",
        headers={
            "Content-Disposition": f'inline; filename="{object_id}-page-{page_number}.jpg"',
            "Cache-Control": "public, max-age=60, must-revalidate",
            "ETag": f'"{checksum}"',
            "Digest": f"sha-256={digest}",
            "X-OpenGeo-Checksum-SHA256": checksum,
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/sites/{site_slug}",
    response_class=Response,
    summary="Read the home page of the current revocable public site edition",
)
@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/sites/{site_slug}/{page_slug}",
    response_class=Response,
    summary="Read a page of the current revocable public site edition",
)
async def public_site_page(
    organization_id: UUID,
    project_id: UUID,
    site_slug: Slug,
    http_request: Request,
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
    download_storage: Annotated[DownloadStorage, Depends(download_storage_from_request)],
    page_slug: Slug | None = None,
) -> Response:
    publication = await execute_public_site(
        repository.get_public_site(
            public_tenant_context(organization_id), project_id, site_slug=site_slug
        )
    )
    base_url = str(http_request.base_url).rstrip("/")
    site_root = (
        f"{base_url}/public/organizations/{organization_id}/projects/{project_id}"
        f"/sites/{publication.edition.listed_slug}"
    )
    return await _public_site_page_response(
        publication,
        organization_id,
        project_id,
        page_slug,
        site_root,
        http_request,
        repository,
        download_storage,
    )


@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/unlisted/{unlisted_token}",
    response_class=Response,
    summary="Read the home page of one opaque unlisted site edition",
)
@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/unlisted/"
    "{unlisted_token}/{page_slug}",
    response_class=Response,
    summary="Read a page of one opaque unlisted site edition",
)
async def public_unlisted_site_page(
    organization_id: UUID,
    project_id: UUID,
    unlisted_token: UnlistedToken,
    http_request: Request,
    repository: Annotated[SitePublicationRepository, Depends(repository_from_request)],
    download_storage: Annotated[DownloadStorage, Depends(download_storage_from_request)],
    page_slug: Slug | None = None,
) -> Response:
    publication = await execute_public_site(
        repository.get_public_site(
            public_tenant_context(organization_id),
            project_id,
            unlisted_token=unlisted_token,
        )
    )
    base_url = str(http_request.base_url).rstrip("/")
    site_root = (
        f"{base_url}/public/organizations/{organization_id}/projects/{project_id}"
        f"/unlisted/{unlisted_token}"
    )
    return await _public_site_page_response(
        publication,
        organization_id,
        project_id,
        page_slug,
        site_root,
        http_request,
        repository,
        download_storage,
    )


async def _public_site_page_response(
    publication: PublishedSite,
    organization_id: UUID,
    project_id: UUID,
    page_slug: str | None,
    site_root: str,
    http_request: Request,
    repository: SitePublicationRepository,
    download_storage: DownloadStorage,
) -> Response:
    page = next(
        (
            candidate
            for candidate in publication.site.pages
            if (candidate.slug == page_slug if page_slug is not None else candidate.is_home)
        ),
        None,
    )
    if page is None:
        raise HTTPException(status_code=404, detail="site_page_not_found")
    base_url = str(http_request.base_url).rstrip("/")
    page_urls = {
        candidate.slug: (site_root if candidate.is_home else f"{site_root}/{candidate.slug}")
        for candidate in publication.site.pages
    }
    document_previews = await _document_previews(
        publication, page, organization_id, repository, download_storage
    )
    edition_asset_root = (
        f"{base_url}/public/organizations/{organization_id}/projects/{project_id}"
        f"/site-editions/{publication.edition.edition_id}/assets"
    )
    document = render_page_html(
        publication,
        page,
        page_urls=page_urls,
        css_url=f"{base_url}/public/site-assets/site.css",
        js_url=f"{base_url}/public/site-assets/site.js",
        public_project_root=(
            f"{base_url}/public/organizations/{organization_id}/projects/{project_id}"
        ),
        snapshot_urls={
            reference.resource_id: (
                f"{base_url}/public/organizations/{organization_id}/projects/{project_id}"
                f"/site-editions/{publication.edition.edition_id}/maps/"
                f"{reference.resource_id}.png"
            )
            for reference in publication.references
            if reference.snapshot is not None
        },
        asset_urls={
            asset.object_id: (
                f"{base_url}/public/organizations/{organization_id}/projects/{project_id}"
                f"/site-editions/{publication.edition.edition_id}/assets/{asset.object_id}"
            )
            for asset in publication.assets
        },
        document_previews=document_previews,
        document_visual_urls={
            object_id: {
                cast(int, page_record["number"]): (
                    f"{edition_asset_root}/{object_id}/pages/{page_record['number']}.jpg"
                )
                for page_record in cast(list[dict[str, Any]], preview["pages"])
            }
            for object_id, preview in document_previews.items()
            if preview.get("schemaVersion") in PDF_VISUAL_PRESENTATION_SCHEMAS
        },
    )
    unlisted = publication.edition.publication_reach == "unlisted"
    headers = {
        "Cache-Control": "public, max-age=60, must-revalidate",
        "ETag": f'"{publication.edition.manifest_checksum_sha256}-{page.slug}"',
        "Content-Security-Policy": SITE_CSP,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer" if unlisted else "strict-origin-when-cross-origin",
    }
    if unlisted:
        headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
    return Response(
        document,
        media_type="text/html",
        headers=headers,
    )


async def _package_response(
    publication: PublishedSite,
    organization_id: UUID,
    project_id: UUID,
    request: Request,
    repository: SitePublicationRepository,
    render_repository: RenderRepository,
    download_storage: DownloadStorage,
) -> Response:
    base_url = str(request.base_url).rstrip("/")
    package = build_static_package(
        publication,
        public_project_root=(
            f"{base_url}/public/organizations/{organization_id}/projects/{project_id}"
        ),
        map_images=await _snapshot_images(
            publication, organization_id, repository, render_repository
        ),
        site_assets=await _site_asset_bytes(
            publication, organization_id, repository, download_storage
        ),
    )
    checksum = sha256(package).hexdigest()
    digest = b64encode(bytes.fromhex(checksum)).decode("ascii")
    return Response(
        package,
        media_type="application/zip",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{publication.site.slug}-edition-'
                f'{publication.edition.edition_number}.zip"'
            ),
            "Cache-Control": "public, max-age=60, must-revalidate",
            "ETag": f'"{checksum}"',
            "Digest": f"sha-256={digest}",
            "X-OpenGeo-Checksum-SHA256": checksum,
            "X-Content-Type-Options": "nosniff",
        },
    )


async def _print_response(
    publication: PublishedSite,
    organization_id: UUID,
    repository: SitePublicationRepository,
    render_repository: RenderRepository,
    download_storage: DownloadStorage,
) -> Response:
    images = await _snapshot_images(publication, organization_id, repository, render_repository)
    assets = await _print_asset_images(publication, organization_id, repository, download_storage)
    try:
        document = build_print_pdf(publication, images, assets)
    except SitePrintError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    checksum = sha256(document).hexdigest()
    digest = b64encode(bytes.fromhex(checksum)).decode("ascii")
    return Response(
        document,
        media_type="application/pdf",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{publication.site.slug}-edition-'
                f'{publication.edition.edition_number}.pdf"'
            ),
            "Cache-Control": "public, max-age=60, must-revalidate",
            "ETag": f'"{checksum}"',
            "Digest": f"sha-256={digest}",
            "X-OpenGeo-Checksum-SHA256": checksum,
            "X-OpenGeo-Output-Mode": "request-driven",
            "X-Content-Type-Options": "nosniff",
        },
    )


async def _map_sheet_response(
    publication: PublishedSite,
    resource_id: UUID,
    organization_id: UUID,
    repository: SitePublicationRepository,
    render_repository: RenderRepository,
) -> Response:
    reference = next(
        (
            candidate
            for candidate in publication.references
            if candidate.resource_id == resource_id and candidate.snapshot is not None
        ),
        None,
    )
    if reference is None:
        raise HTTPException(status_code=404, detail="site_snapshot_not_found")
    output = await _read_snapshot(
        publication, reference.resource_id, organization_id, repository, render_repository
    )
    try:
        document = build_map_sheet_svg(publication, reference, output.body)
    except SitePrintError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    checksum = sha256(document).hexdigest()
    digest = b64encode(bytes.fromhex(checksum)).decode("ascii")
    return Response(
        document,
        media_type="image/svg+xml",
        headers={
            "Content-Disposition": f'inline; filename="{publication.site.slug}-{resource_id}.svg"',
            "Cache-Control": "public, max-age=60, must-revalidate",
            "ETag": f'"{checksum}"',
            "Digest": f"sha-256={digest}",
            "X-OpenGeo-Checksum-SHA256": checksum,
            "X-OpenGeo-Source-Checksum-SHA256": output.checksum_sha256,
            "X-OpenGeo-Output-Mode": "request-driven",
            "Content-Security-Policy": (
                "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox"
            ),
            "X-Content-Type-Options": "nosniff",
        },
    )


async def _print_page_png_response(
    publication: PublishedSite,
    page_slug: str,
    organization_id: UUID,
    repository: SitePublicationRepository,
    render_repository: RenderRepository,
    download_storage: DownloadStorage,
) -> Response:
    images = await _snapshot_images(publication, organization_id, repository, render_repository)
    assets = await _print_asset_images(publication, organization_id, repository, download_storage)
    try:
        document = build_print_page_png(publication, page_slug, images, assets)
    except SitePrintError as error:
        if str(error) == "site_print_page_not_found":
            raise HTTPException(status_code=404, detail=str(error)) from error
        raise HTTPException(status_code=422, detail=str(error)) from error
    checksum = sha256(document).hexdigest()
    digest = b64encode(bytes.fromhex(checksum)).decode("ascii")
    source_checksums = ",".join(
        [
            reference.snapshot.checksum_sha256
            for reference in publication.references
            if reference.snapshot is not None
        ]
        + [asset.checksum_sha256 for asset in publication.assets if asset.kind == "image"]
    )
    return Response(
        document,
        media_type="image/png",
        headers={
            "Content-Disposition": (
                f'inline; filename="{publication.site.slug}-{page_slug}-edition-'
                f'{publication.edition.edition_number}.png"'
            ),
            "Cache-Control": "public, max-age=60, must-revalidate",
            "ETag": f'"{checksum}"',
            "Digest": f"sha-256={digest}",
            "X-OpenGeo-Checksum-SHA256": checksum,
            "X-OpenGeo-Source-Checksums-SHA256": source_checksums,
            "X-OpenGeo-Print-DPI": str(PRINT_RASTER_DPI),
            "X-OpenGeo-Output-Mode": "request-driven",
            "X-Content-Type-Options": "nosniff",
        },
    )


async def _snapshot_images(
    publication: PublishedSite,
    organization_id: UUID,
    repository: SitePublicationRepository,
    render_repository: RenderRepository,
) -> dict[UUID, bytes]:
    resource_ids = [
        reference.resource_id
        for reference in publication.references
        if reference.snapshot is not None
    ]
    outputs = await gather(
        *(
            _read_snapshot(publication, resource_id, organization_id, repository, render_repository)
            for resource_id in resource_ids
        )
    )
    return {
        resource_id: output.body for resource_id, output in zip(resource_ids, outputs, strict=True)
    }


async def _site_asset_bytes(
    publication: PublishedSite,
    organization_id: UUID,
    repository: SitePublicationRepository,
    download_storage: DownloadStorage,
) -> dict[UUID, bytes]:
    outputs = await gather(
        *(
            _read_site_asset(
                publication,
                asset,
                organization_id,
                repository,
                download_storage,
            )
            for asset in publication.assets
        )
    )
    return {
        asset.object_id: output.body
        for asset, output in zip(publication.assets, outputs, strict=True)
    }


async def _document_previews(
    publication: PublishedSite,
    page: SitePage,
    organization_id: UUID,
    repository: SitePublicationRepository,
    download_storage: DownloadStorage,
) -> dict[UUID, dict[str, Any]]:
    object_ids: set[UUID] = set()
    blocks = page.resource_content.get("blocks")
    if isinstance(blocks, list):
        for block in blocks:
            if not isinstance(block, dict) or block.get("type") != "document":
                continue
            try:
                object_ids.add(UUID(str(block.get("object_id"))))
            except (TypeError, ValueError):
                continue
    assets = tuple(
        asset
        for asset in publication.assets
        if asset.kind == "document" and asset.object_id in object_ids
    )
    outputs = await gather(
        *(
            _read_site_asset(
                publication,
                asset,
                organization_id,
                repository,
                download_storage,
            )
            for asset in assets
        )
    )
    try:
        return {
            asset.object_id: parse_document_preview(output.body)
            for asset, output in zip(assets, outputs, strict=True)
        }
    except DocumentPreviewInvalid as error:
        raise HTTPException(status_code=404, detail="site_document_not_found") from error


async def _print_asset_images(
    publication: PublishedSite,
    organization_id: UUID,
    repository: SitePublicationRepository,
    download_storage: DownloadStorage,
) -> dict[UUID, bytes]:
    assets = tuple(asset for asset in publication.assets if asset.kind == "image")
    outputs = await gather(
        *(
            _read_site_asset(
                publication,
                asset,
                organization_id,
                repository,
                download_storage,
            )
            for asset in assets
        )
    )
    return {asset.object_id: output.body for asset, output in zip(assets, outputs, strict=True)}


async def _read_site_asset(
    publication: PublishedSite,
    asset: PublishedSiteAsset,
    organization_id: UUID,
    repository: SitePublicationRepository,
    download_storage: DownloadStorage,
) -> ExactObject:
    exact = await execute_public_asset(
        download_storage.read_exact_object(
            ExactObjectSpec(
                bucket=asset.bucket,
                key=asset.object_key,
                version_id=asset.storage_version_id,
                content_type=asset.content_type,
                size_bytes=asset.size_bytes,
                checksum_sha256=asset.checksum_sha256,
                maximum_bytes=MAX_SITE_ASSET_BYTES,
            )
        )
    )
    checked = await execute_public_site(
        repository.get_public_site(
            public_tenant_context(organization_id),
            publication.site.project_id,
            edition_id=publication.edition.edition_id,
        )
    )
    checked_asset = next(
        (candidate for candidate in checked.assets if candidate.object_id == asset.object_id),
        None,
    )
    if checked_asset != asset:
        raise HTTPException(status_code=404, detail="site_asset_not_found")
    return exact


async def _read_snapshot(
    publication: PublishedSite,
    resource_id: UUID,
    organization_id: UUID,
    repository: SitePublicationRepository,
    render_repository: RenderRepository,
    *,
    maximum_bytes: int = MAX_SITE_SNAPSHOT_BYTES,
) -> RenderedMapOutput:
    reference = next(
        (candidate for candidate in publication.references if candidate.resource_id == resource_id),
        None,
    )
    if reference is None or reference.snapshot is None:
        raise HTTPException(status_code=404, detail="site_snapshot_not_found")
    snapshot = reference.snapshot
    output = await execute_public_snapshot(
        render_repository.read_sealed_map_output(
            public_tenant_context(organization_id),
            publication.site.project_id,
            resource_id,
            snapshot.render_job_id,
            SealedRenderOutput(
                output_object_id=snapshot.output_object_id,
                storage_version_id=snapshot.storage_version_id,
                content_type=snapshot.content_type,
                size_bytes=snapshot.size_bytes,
                checksum_sha256=snapshot.checksum_sha256,
            ),
            maximum_bytes,
        )
    )
    checked = await execute_public_site(
        repository.get_public_site(
            public_tenant_context(organization_id),
            publication.site.project_id,
            edition_id=publication.edition.edition_id,
        )
    )
    checked_reference = next(
        (candidate for candidate in checked.references if candidate.resource_id == resource_id),
        None,
    )
    if checked_reference != reference:
        raise HTTPException(status_code=404, detail="site_snapshot_not_found")
    return output


def public_site_directory_response(
    organization_id: UUID,
    record: PublicSiteDirectoryRecord,
) -> PublicSiteDirectoryRecordResponse:
    href = f"/public/organizations/{organization_id}/publications/{record.listed_slug}"
    return PublicSiteDirectoryRecordResponse(
        project_id=record.project_id,
        project_name=record.project_name,
        site_id=record.site_id,
        edition_id=record.edition_id,
        listed_slug=record.listed_slug,
        title=record.title,
        description=record.description,
        language=record.language,
        theme=record.theme,
        page_count=record.page_count,
        published_at=record.published_at.isoformat(),
        is_primary=record.is_primary,
        href=href,
        primary_href=(
            f"/public/organizations/{organization_id}/publication" if record.is_primary else None
        ),
    )


def edition_response(record: SiteEdition) -> SiteEditionResponse:
    return SiteEditionResponse(
        id=record.edition_id,
        site_id=record.site_id,
        site_version_id=record.site_version_id,
        site_version_number=record.site_version_number,
        edition_number=record.edition_number,
        manifest=record.manifest,
        manifest_checksum_sha256=record.manifest_checksum_sha256,
        published_by=record.published_by,
        published_at=record.published_at.isoformat(),
        revoked_by=record.revoked_by,
        revoked_at=record.revoked_at.isoformat() if record.revoked_at else None,
        publication_reach=record.publication_reach,
        listed_slug=record.listed_slug,
        unlisted_token=record.unlisted_token,
        is_primary=record.is_primary,
    )


def site_response(record: ProjectSite) -> SiteResponse:
    destination = record.publication_destination
    if destination is None:
        raise SiteStoreUnavailable("site publication destination is unavailable")
    return SiteResponse(
        id=record.site_id,
        project_id=record.project_id,
        slug=record.slug,
        version_id=record.version_id,
        version_number=record.version_number,
        state=record.state,
        title=record.title,
        description=record.description,
        language=record.language,
        theme=record.theme,
        theme_options=record.theme_options,
        print_layout=record.print_layout,
        change_message=record.change_message,
        created_by=record.created_by,
        created_at=record.created_at.isoformat(),
        updated_by=record.updated_by,
        updated_at=record.updated_at.isoformat(),
        pages=[
            SitePageResponse(
                id=page.page_id,
                slug=page.slug,
                navigation_label=page.navigation_label,
                position=page.position,
                is_home=page.is_home,
                resource_id=page.resource_id,
                resource_version_id=page.resource_version_id,
                resource_version_number=page.resource_version_number,
                resource_kind=page.resource_kind,
                resource_title=page.resource_title,
                resource_state=page.resource_state,
                resource_visibility=page.resource_visibility,
                content=page.resource_content,
            )
            for page in record.pages
        ],
        active_edition=(
            edition_response(record.active_edition) if record.active_edition is not None else None
        ),
        publication_destination=publication_destination_response(destination),
    )


def publication_destination_response(
    record: SitePublicationDestination,
) -> SitePublicationDestinationResponse:
    return SitePublicationDestinationResponse(
        revision=record.revision,
        reach=record.reach,
        listed_slug=record.listed_slug,
        is_primary=record.is_primary,
        configured_by=record.configured_by,
        configured_at=record.configured_at.isoformat(),
    )
