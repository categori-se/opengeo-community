import logging
import math
from collections.abc import Awaitable
from datetime import datetime
from pathlib import PurePosixPath
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
from opengeo_api.ingestion import (
    CatalogFilters,
    Dataset,
    DatasetClassification,
    DatasetFormat,
    DatasetSourceType,
    DatasetStatus,
    DatasetVersionState,
    IngestionAccessDenied,
    IngestionConflict,
    IngestionNotFound,
    IngestionProcessingHeld,
    IngestionRepository,
    IngestionStoreUnavailable,
    Page,
    PostgresIngestionRepository,
    ProcessingJobState,
    RepositoryObjectSource,
    UploadCompletion,
    UploadDatasetFormat,
    UploadDraft,
    UploadPurpose,
    UploadTicket,
)
from opengeo_api.logging import get_request_id
from opengeo_api.place_context import PlaceContextResolver, PlaceContextUnavailable
from opengeo_api.resource_knowledge import validate_knowledge
from opengeo_api.s3_uploads import UploadObjectNotFound, UploadStorageUnavailable
from opengeo_api.tenant_database import TenantContext

logger = logging.getLogger(__name__)
router = APIRouter(tags=["managed ingestion"])

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Description = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=10_000),
]
Filename = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=3,
        max_length=255,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._ -]*$",
    ),
]
ContentType = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=3,
        max_length=100,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9!#$&^_.+/-]*$",
    ),
]
Checksum = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=64,
        max_length=64,
        pattern=r"^[0-9A-Fa-f]{64}$",
    ),
]
Tag = Annotated[
    str,
    StringConstraints(strip_whitespace=True, to_lower=True, min_length=1, max_length=64),
]

_UPLOAD_FORMATS: dict[UploadDatasetFormat, tuple[frozenset[str], frozenset[str]]] = {
    "kml": (frozenset({".kml"}), frozenset({"application/vnd.google-earth.kml+xml"})),
    "geojson": (
        frozenset({".geojson", ".json"}),
        frozenset({"application/geo+json", "application/json"}),
    ),
    "csv": (frozenset({".csv"}), frozenset({"text/csv", "application/csv"})),
    "shapefile": (
        frozenset({".zip"}),
        frozenset({"application/zip", "application/x-zip-compressed"}),
    ),
    "geopackage": (
        frozenset({".gpkg"}),
        frozenset(
            {
                "application/geopackage+sqlite3",
                "application/vnd.sqlite3",
                "application/octet-stream",
            }
        ),
    ),
    "geoparquet": (
        frozenset({".parquet", ".geoparquet"}),
        frozenset(
            {
                "application/vnd.apache.parquet",
                "application/x-parquet",
                "application/octet-stream",
            }
        ),
    ),
    "cog": (
        frozenset({".tif", ".tiff"}),
        frozenset({"image/tiff", "image/geotiff", "application/geotiff"}),
    ),
    "pmtiles": (
        frozenset({".pmtiles"}),
        frozenset({"application/vnd.pmtiles", "application/octet-stream"}),
    ),
    "png": (frozenset({".png"}), frozenset({"image/png"})),
    "jpeg": (frozenset({".jpg", ".jpeg"}), frozenset({"image/jpeg"})),
    "pdf": (frozenset({".pdf"}), frozenset({"application/pdf"})),
    "odt": (
        frozenset({".odt"}),
        frozenset({"application/vnd.oasis.opendocument.text"}),
    ),
}

_MEDIA_UPLOAD_FORMATS: frozenset[UploadDatasetFormat] = frozenset({"png", "jpeg"})
_MAX_MEDIA_SOURCE_BYTES = 16 * 1024 * 1024
_DOCUMENT_UPLOAD_FORMATS: frozenset[UploadDatasetFormat] = frozenset({"pdf", "odt"})
_MAX_DOCUMENT_SOURCE_BYTES = 32 * 1024 * 1024


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DatasetResponse(BaseModel):
    spatial_search_available: bool | None = None
    preservation_summary: dict[str, Any] | None = None
    source_spatial_metadata: dict[str, Any] | None = None
    catalog_match_count: int | None = None
    id: UUID
    project_id: UUID
    name: str
    description: str | None
    classification: DatasetClassification
    source_type: DatasetSourceType
    format: DatasetFormat
    status: DatasetStatus
    owner_user_id: UUID
    current_version_id: UUID | None
    current_version_number: int | None
    current_version_state: DatasetVersionState | None
    feature_count: int | None
    extent: list[float] | None
    crs: str | None
    geometry_type: str | None
    quality_results: dict[str, Any]
    processing_job_state: ProcessingJobState | None
    processing_error_code: str | None
    tags: list[str]
    created_at: datetime
    updated_at: datetime
    capabilities: dict[str, bool]


class RequestUploadRequest(RequestModel):
    name: Name
    description: Description | None = None
    classification: DatasetClassification = "internal"
    format: UploadDatasetFormat
    filename: Filename
    content_type: ContentType
    size_bytes: int = Field(ge=1, le=5_368_709_120)
    checksum_sha256: Checksum
    tags: list[Tag] = Field(default_factory=list, max_length=12)
    purpose: UploadPurpose = "ingest"
    target_dataset_id: UUID | None = None
    expected_base_version_id: UUID | None = None

    @model_validator(mode="after")
    def validate_staged_target(self) -> "RequestUploadRequest":
        if (self.target_dataset_id is None) != (self.expected_base_version_id is None):
            raise ValueError("Staging requires both Layer and expected base version")
        return self

    @field_validator("content_type", "checksum_sha256", mode="after")
    @classmethod
    def normalize_lowercase_fields(cls, value: str) -> str:
        return value.lower()

    @field_validator("tags", mode="after")
    @classmethod
    def normalize_tags(cls, values: list[str]) -> list[str]:
        normalized = list(dict.fromkeys(values))
        if len(normalized) != len(values):
            raise ValueError("tags must be unique")
        return normalized

    @model_validator(mode="after")
    def validate_file_contract(self) -> "RequestUploadRequest":
        extensions, media_types = _UPLOAD_FORMATS[self.format]
        if PurePosixPath(self.filename).suffix.lower() not in extensions:
            raise ValueError("filename extension does not match format")
        if self.content_type not in media_types:
            raise ValueError("content_type does not match format")
        if self.purpose == "pmtiles_original" and (
            self.format != "geojson"
            or self.content_type != "application/geo+json"
            or self.target_dataset_id is not None
            or self.size_bytes > 512 * 1024 * 1024
        ):
            raise ValueError("PMTiles original preservation requires a new GeoJSON up to 512 MiB")
        return self


class UploadInstructionsResponse(BaseModel):
    url: str
    method: str
    fields: dict[str, str]


class UploadTicketResponse(BaseModel):
    upload_id: UUID
    dataset: DatasetResponse
    expires_at: datetime
    upload: UploadInstructionsResponse
    purpose: UploadPurpose = "ingest"


class UploadCompletionResponse(BaseModel):
    dataset: DatasetResponse
    dataset_version_id: UUID
    version_number: int
    processing_job_id: UUID | None
    processing_job_state: ProcessingJobState | None
    purpose: UploadPurpose = "ingest"

    @model_validator(mode="after")
    def validate_processing_job(self) -> "UploadCompletionResponse":
        if self.purpose == "pmtiles_original":
            if self.processing_job_id is not None or self.processing_job_state is not None:
                raise ValueError("Preserved originals have no ingestion job")
        elif self.processing_job_id is None or self.processing_job_state is None:
            raise ValueError("Ingestion completion requires a processing job")
        return self


class RepositoryObjectSourceResponse(BaseModel):
    dataset_id: UUID
    connection_id: UUID
    connection_target_revision: int
    provider: str
    bucket_name: str
    region_name: str
    object_prefix: str
    relative_path: str
    provider_version_id: str
    size_bytes: int
    last_modified: datetime
    content_type: str | None
    etag: str
    storage_class: str | None
    provider_checksum_sha256: str | None
    created_by: UUID
    created_at: datetime


def repository_from_request(request: Request) -> IngestionRepository:
    repository = request.app.state.ingestion_repository
    if not isinstance(repository, PostgresIngestionRepository):
        return cast(IngestionRepository, repository)
    return repository


def tenant_context(session: AuthSession) -> TenantContext:
    membership = require_organization(session)
    return TenantContext(session.principal.user_id, membership.organization_id)


def page_parameters(
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> Page:
    return Page(limit, offset)


PageDependency = Annotated[Page, Depends(page_parameters)]


def catalog_filter_parameters(
    bbox: Annotated[str | None, Query(max_length=200)] = None,
    place_uri: Annotated[
        str | None,
        Query(
            max_length=2048,
            pattern=(
                r"^(http://www.wikidata.org/entity/Q[1-9][0-9]{0,15}|https://sws.geonames.org/[1-9][0-9]*/)$"
            ),
        ),
    ] = None,
    query: Annotated[str | None, Query(min_length=1, max_length=200)] = None,
    owner_user_id: UUID | None = None,
    tag: Annotated[str | None, Query(min_length=1, max_length=64)] = None,
    geometry_type: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
    format: DatasetFormat | None = None,
    classification: DatasetClassification | None = None,
    source_type: DatasetSourceType | None = None,
    updated_after: datetime | None = None,
    updated_before: datetime | None = None,
) -> CatalogFilters:
    if updated_after is not None and updated_before is not None and updated_after > updated_before:
        raise HTTPException(status_code=422, detail="catalog_date_range_invalid")
    normalized_tag = tag.strip().lower() if tag else None
    normalized_geometry = geometry_type.strip() if geometry_type else None
    parsed_bbox = None
    if bbox is not None:
        try:
            values = tuple(float(item.strip()) for item in bbox.split(","))
            if len(values) != 4 or not all(math.isfinite(value) for value in values):
                raise ValueError()
            west, south, east, north = values
            if not (-180 <= west <= 180 and -180 <= east <= 180 and -90 <= south <= north <= 90):
                raise ValueError()
            parsed_bbox = values
        except ValueError as error:
            raise HTTPException(status_code=422, detail="catalog_bbox_invalid") from error
    return CatalogFilters(
        bbox=parsed_bbox,
        place_uri=place_uri,
        query=query.strip() if query else None,
        owner_user_id=owner_user_id,
        tag=normalized_tag,
        geometry_type=normalized_geometry,
        format=format,
        classification=classification,
        source_type=source_type,
        updated_after=updated_after,
        updated_before=updated_before,
    )


CatalogFiltersDependency = Annotated[CatalogFilters, Depends(catalog_filter_parameters)]


async def execute_ingestion[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except IngestionAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except IngestionNotFound as error:
        raise HTTPException(status_code=404, detail=f"{error.resource}_not_found") from error
    except IngestionConflict as error:
        response_status = 410 if error.code == "upload_expired" else 409
        raise HTTPException(status_code=response_status, detail={"code": error.code}) from error
    except IngestionProcessingHeld as error:
        raise HTTPException(status_code=503, detail=error.code) from error
    except UploadObjectNotFound as error:
        raise HTTPException(status_code=409, detail={"code": "upload_object_missing"}) from error
    except UploadStorageUnavailable as error:
        logger.error("ingestion.storage_unavailable")
        raise HTTPException(status_code=503, detail="upload_storage_unavailable") from error
    except IngestionStoreUnavailable as error:
        logger.error("ingestion.store_unavailable", extra={"error_type": type(error).__name__})
        raise HTTPException(status_code=503, detail="ingestion_store_unavailable") from error


def dataset_response(dataset: Dataset) -> DatasetResponse:
    return DatasetResponse(
        id=dataset.dataset_id,
        project_id=dataset.project_id,
        name=dataset.name,
        description=dataset.description,
        classification=dataset.classification,
        source_type=dataset.source_type,
        format=dataset.format,
        status=dataset.status,
        owner_user_id=dataset.owner_user_id,
        current_version_id=dataset.current_version_id,
        current_version_number=dataset.current_version_number,
        current_version_state=dataset.current_version_state,
        feature_count=dataset.feature_count,
        spatial_search_available=dataset.spatial_search_available,
        preservation_summary=dataset.preservation_summary,
        source_spatial_metadata=dataset.source_spatial_metadata,
        catalog_match_count=dataset.catalog_match_count,
        extent=dataset.extent,
        crs=dataset.crs,
        geometry_type=dataset.geometry_type,
        quality_results=dataset.quality_results,
        processing_job_state=dataset.processing_job_state,
        processing_error_code=dataset.processing_error_code,
        tags=list(dataset.tags),
        created_at=dataset.created_at,
        updated_at=dataset.updated_at,
        capabilities={
            "read": dataset.capabilities.read,
            "edit": dataset.capabilities.edit,
            "download": dataset.capabilities.download,
            "manage_permissions": dataset.capabilities.manage_permissions,
        },
    )


def ticket_response(ticket: UploadTicket) -> UploadTicketResponse:
    return UploadTicketResponse(
        upload_id=ticket.upload_id,
        dataset=dataset_response(ticket.dataset),
        expires_at=ticket.upload.expires_at,
        upload=UploadInstructionsResponse(
            url=ticket.upload.url,
            method=ticket.upload.method,
            fields=dict(ticket.upload.fields),
        ),
        purpose=ticket.purpose,
    )


def completion_response(completion: UploadCompletion) -> UploadCompletionResponse:
    return UploadCompletionResponse(
        dataset=dataset_response(completion.dataset),
        dataset_version_id=completion.dataset_version_id,
        version_number=completion.version_number,
        processing_job_id=completion.processing_job_id,
        processing_job_state=completion.processing_job_state,
        purpose=completion.purpose,
    )


def repository_object_source_response(
    source: RepositoryObjectSource,
) -> RepositoryObjectSourceResponse:
    return RepositoryObjectSourceResponse(
        dataset_id=source.dataset_id,
        connection_id=source.connection_id,
        connection_target_revision=source.connection_target_revision,
        provider=source.provider,
        bucket_name=source.bucket_name,
        region_name=source.region_name,
        object_prefix=source.object_prefix,
        relative_path=source.relative_path,
        provider_version_id=source.provider_version_id,
        size_bytes=source.size_bytes,
        last_modified=source.last_modified,
        content_type=source.content_type,
        etag=source.etag,
        storage_class=source.storage_class,
        provider_checksum_sha256=source.provider_checksum_sha256,
        created_by=source.created_by,
        created_at=source.created_at,
    )


class CatalogServiceReference(BaseModel):
    url: str
    kind: Literal["FeatureServer", "MapServer", "ImageServer", "WFS"]
    layer_id: str | None
    layer_url: str
    rendering_source: Literal["provider", "captured_copy"]
    source_version: int | None


class LayerCatalogResponse(BaseModel):
    dataset_id: UUID
    dataset_name: str
    project_id: UUID
    project_name: str
    format: str
    classification: DatasetClassification
    source_type: str
    updated_at: datetime
    map_id: UUID | None
    map_version: int | None
    layer_id: str | None
    title: str
    description: str | None
    style_field: str | None
    legend: dict[str, Any] | None
    geometry_type: str | None
    style_key: str | None
    service: CatalogServiceReference | None = None


@router.get("/catalog/layers", response_model=list[LayerCatalogResponse])
async def layer_catalog(
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[IngestionRepository, Depends(repository_from_request)],
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=100_000),
    query: str | None = Query(default=None, max_length=200),
    project_id: UUID | None = None,
    client_id: UUID | None = None,
    classification: DatasetClassification | None = None,
) -> list[LayerCatalogResponse]:
    records = await execute_ingestion(
        repository.search_layers(
            tenant_context(session),
            limit=limit,
            offset=offset,
            query=query,
            project_id=project_id,
            client_id=client_id,
            classification=classification,
        )
    )
    response.headers["Cache-Control"] = "no-store"
    return [LayerCatalogResponse.model_validate(record) for record in records]


@router.get("/datasets", response_model=list[DatasetResponse])
async def catalog(
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[IngestionRepository, Depends(repository_from_request)],
    page: PageDependency,
    filters: CatalogFiltersDependency,
    client_id: UUID | None = None,
    project_id: UUID | None = None,
) -> list[DatasetResponse]:
    records = await execute_ingestion(
        repository.search_datasets(
            tenant_context(session), page, filters, client_id=client_id, project_id=project_id
        )
    )
    return [dataset_response(record) for record in records]


class DatasetRefreshAcceptanceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_version_id: UUID
    evidence_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


@router.post("/datasets/{dataset_id}/refresh-reviews/{review_id}/accept")
async def accept_dataset_refresh_review(
    dataset_id: UUID,
    review_id: UUID,
    draft: DatasetRefreshAcceptanceRequest,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[IngestionRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    record = await execute_ingestion(
        repository.accept_dataset_refresh_review(
            tenant_context(session),
            dataset_id,
            review_id,
            draft.base_version_id,
            draft.evidence_sha256,
        )
    )
    response.headers["Cache-Control"] = "no-store"
    return record


class DatasetRefreshReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_version_id: UUID
    candidate_version_id: UUID


@router.post("/datasets/{dataset_id}/refresh-reviews")
async def create_dataset_refresh_review(
    dataset_id: UUID,
    draft: DatasetRefreshReviewRequest,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[IngestionRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    record = await execute_ingestion(
        repository.create_dataset_refresh_review(
            tenant_context(session), dataset_id, draft.base_version_id, draft.candidate_version_id
        )
    )
    response.headers["Cache-Control"] = "no-store"
    return record


class DatasetKnowledgeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(ge=0, le=2_147_483_646, strict=True)
    document: dict[str, Any]

    @field_validator("document")
    @classmethod
    def validate_document(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_knowledge(value)


class DatasetKnowledgeResponse(BaseModel):
    dataset_id: UUID
    version: int
    document: dict[str, Any]
    created_by: UUID | None
    created_at: datetime | None
    can_edit: bool


@router.get("/datasets/{dataset_id}/metadata", response_model=DatasetKnowledgeResponse)
async def get_dataset_knowledge(
    dataset_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[IngestionRepository, Depends(repository_from_request)],
    version: int | None = Query(default=None, ge=1, le=2_147_483_647),
) -> DatasetKnowledgeResponse:
    record = await execute_ingestion(
        repository.get_dataset_knowledge(tenant_context(session), dataset_id, version)
    )
    response.headers["Cache-Control"] = "no-store"
    return DatasetKnowledgeResponse.model_validate(record)


@router.put("/datasets/{dataset_id}/metadata", response_model=DatasetKnowledgeResponse)
async def save_dataset_knowledge(
    dataset_id: UUID,
    draft: DatasetKnowledgeRequest,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[IngestionRepository, Depends(repository_from_request)],
) -> DatasetKnowledgeResponse:
    record = await execute_ingestion(
        repository.save_dataset_knowledge(
            tenant_context(session), dataset_id, draft.document, draft.expected_version
        )
    )
    response.headers["Cache-Control"] = "no-store"
    return DatasetKnowledgeResponse.model_validate(record)


class PlaceContextRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    item: str = Field(pattern=r"^Q[1-9][0-9]{0,15}$")


@router.post("/datasets/{dataset_id}/place-context")
async def resolve_place_context(
    dataset_id: UUID,
    draft: PlaceContextRequest,
    request: Request,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[IngestionRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    record = await execute_ingestion(
        repository.get_dataset_knowledge(tenant_context(session), dataset_id)
    )
    if not record["can_edit"]:
        raise HTTPException(status_code=403, detail="Dataset edit access is required")
    resolver = getattr(request.app.state, "place_context_resolver", None)
    if resolver is None:
        resolver = PlaceContextResolver()
        request.app.state.place_context_resolver = resolver
    response.headers["Cache-Control"] = "no-store"
    try:
        return await resolver.resolve(draft.item)
    except PlaceContextUnavailable as error:
        raise HTTPException(
            status_code=503, detail="Place context unavailable; retry later"
        ) from error


class PlaceSearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True, min_length=2, max_length=120, pattern=r"^[^\x00-\x1f]+$"
        ),
    ]


@router.post("/datasets/{dataset_id}/place-search")
async def search_place_names(
    dataset_id: UUID,
    draft: PlaceSearchRequest,
    request: Request,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[IngestionRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    record = await execute_ingestion(
        repository.get_dataset_knowledge(tenant_context(session), dataset_id)
    )
    if not record["can_edit"]:
        raise HTTPException(status_code=403, detail="Dataset edit access is required")
    resolver = getattr(request.app.state, "place_context_resolver", None)
    if resolver is None:
        resolver = PlaceContextResolver()
        request.app.state.place_context_resolver = resolver
    response.headers["Cache-Control"] = "no-store"
    try:
        return await resolver.search(draft.query)
    except PlaceContextUnavailable as error:
        raise HTTPException(
            status_code=503, detail="Place context unavailable; retry later"
        ) from error


@router.get("/datasets/{dataset_id}", response_model=DatasetResponse)
async def get_catalog_dataset(
    dataset_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[IngestionRepository, Depends(repository_from_request)],
) -> DatasetResponse:
    record = await execute_ingestion(
        repository.get_catalog_dataset(tenant_context(session), dataset_id)
    )
    response.headers["Cache-Control"] = "no-store"
    return dataset_response(record)


@router.get("/projects/{project_id}/datasets", response_model=list[DatasetResponse])
async def datasets(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[IngestionRepository, Depends(repository_from_request)],
    page: PageDependency,
    filters: CatalogFiltersDependency,
) -> list[DatasetResponse]:
    records = await execute_ingestion(
        repository.list_datasets(tenant_context(session), project_id, page, filters)
    )
    return [dataset_response(record) for record in records]


@router.get("/projects/{project_id}/datasets/{dataset_id}", response_model=DatasetResponse)
async def get_dataset(
    project_id: UUID,
    dataset_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[IngestionRepository, Depends(repository_from_request)],
) -> DatasetResponse:
    record = await execute_ingestion(
        repository.get_dataset(tenant_context(session), project_id, dataset_id)
    )
    return dataset_response(record)


@router.get(
    "/projects/{project_id}/datasets/{dataset_id}/repository-object-source",
    response_model=RepositoryObjectSourceResponse,
)
async def get_repository_object_source(
    project_id: UUID,
    dataset_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[IngestionRepository, Depends(repository_from_request)],
) -> RepositoryObjectSourceResponse:
    source = await execute_ingestion(
        repository.get_repository_object_source(tenant_context(session), project_id, dataset_id)
    )
    return repository_object_source_response(source)


@router.put("/projects/{project_id}/datasets/{dataset_id}", response_model=DatasetResponse)
async def attach_dataset(
    project_id: UUID,
    dataset_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[IngestionRepository, Depends(repository_from_request)],
) -> DatasetResponse:
    record = await execute_ingestion(
        repository.attach_dataset(tenant_context(session), project_id, dataset_id, get_request_id())
    )
    return dataset_response(record)


@router.delete(
    "/projects/{project_id}/datasets/{dataset_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def detach_dataset(
    project_id: UUID,
    dataset_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[IngestionRepository, Depends(repository_from_request)],
) -> Response:
    await execute_ingestion(
        repository.detach_dataset(tenant_context(session), project_id, dataset_id, get_request_id())
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def allowed_upload_purposes(request: Request) -> frozenset[UploadPurpose]:
    mode = request.app.state.settings.worker_processing_mode
    if mode == "shared":
        return frozenset({"ingest", "pmtiles_original"})
    if mode == "pmtiles-v2":
        return frozenset({"pmtiles_original"})
    return frozenset()


@router.post(
    "/projects/{project_id}/uploads/request",
    response_model=UploadTicketResponse,
    status_code=status.HTTP_201_CREATED,
)
async def request_upload(
    project_id: UUID,
    payload: RequestUploadRequest,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[IngestionRepository, Depends(repository_from_request)],
) -> UploadTicketResponse:
    allowed_purposes = allowed_upload_purposes(request)
    if payload.purpose not in allowed_purposes:
        raise HTTPException(status_code=503, detail=IngestionProcessingHeld(payload.purpose).code)
    deployment_limit = request.app.state.settings.upload_max_bytes
    if payload.format in _MEDIA_UPLOAD_FORMATS:
        upload_limit = min(deployment_limit, _MAX_MEDIA_SOURCE_BYTES)
    elif payload.format == "kml":
        upload_limit = min(deployment_limit, 4 * 1024 * 1024)
    elif payload.format in _DOCUMENT_UPLOAD_FORMATS:
        upload_limit = min(deployment_limit, _MAX_DOCUMENT_SOURCE_BYTES)
    else:
        upload_limit = deployment_limit
    if payload.size_bytes > upload_limit:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "upload_size_exceeds_limit",
                "max_size_bytes": upload_limit,
            },
        )
    ticket = await execute_ingestion(
        repository.request_upload(
            tenant_context(session),
            project_id,
            UploadDraft(
                name=payload.name,
                description=payload.description,
                classification=payload.classification,
                format=payload.format,
                original_filename=payload.filename,
                content_type=payload.content_type,
                size_bytes=payload.size_bytes,
                checksum_sha256=payload.checksum_sha256,
                tags=tuple(payload.tags),
                purpose=payload.purpose,
            ),
            get_request_id(),
            allowed_purposes=allowed_purposes,
            **(
                {"staged_target": (payload.target_dataset_id, payload.expected_base_version_id)}
                if payload.target_dataset_id is not None
                and payload.expected_base_version_id is not None
                else {}
            ),
        )
    )
    return ticket_response(ticket)


@router.post(
    "/projects/{project_id}/uploads/{upload_id}/renew",
    response_model=UploadTicketResponse,
)
async def renew_upload(
    project_id: UUID,
    upload_id: UUID,
    response: Response,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[IngestionRepository, Depends(repository_from_request)],
) -> UploadTicketResponse:
    ticket = await execute_ingestion(
        repository.renew_upload(
            tenant_context(session),
            project_id,
            upload_id,
            get_request_id(),
            allowed_purposes=allowed_upload_purposes(request),
        )
    )
    response.headers["Cache-Control"] = "private, no-store"
    return ticket_response(ticket)


@router.post(
    "/projects/{project_id}/uploads/{upload_id}/complete",
    response_model=UploadCompletionResponse,
)
async def complete_upload(
    project_id: UUID,
    upload_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[IngestionRepository, Depends(repository_from_request)],
) -> UploadCompletionResponse:
    completion = await execute_ingestion(
        repository.complete_upload(
            tenant_context(session),
            project_id,
            upload_id,
            get_request_id(),
            allowed_purposes=allowed_upload_purposes(request),
        )
    )
    return completion_response(completion)
