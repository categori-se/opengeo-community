import logging
from collections.abc import Awaitable
from datetime import datetime
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session, require_organization
from opengeo_api.authorization import DatasetPermissionRole
from opengeo_api.catalog import (
    DATASET_VERSION_LINEAGE_SCHEMA,
    CatalogAccessDenied,
    CatalogConflict,
    CatalogNotFound,
    CatalogRepository,
    CatalogStoreUnavailable,
    DatasetDerivativeLineage,
    DatasetLineageOrigin,
    DatasetObject,
    DatasetPermission,
    DatasetVersion,
    DatasetVersionLineage,
    PermissionGrant,
    PostgresCatalogRepository,
)
from opengeo_api.logging import get_request_id
from opengeo_api.s3_downloads import DownloadStorageUnavailable, DownloadTicket
from opengeo_api.tenant_database import TenantContext

logger = logging.getLogger(__name__)
router = APIRouter(tags=["dataset catalog"])


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DatasetObjectResponse(BaseModel):
    id: UUID
    role: str
    filename: str
    content_type: str
    size_bytes: int
    checksum_sha256: str
    created_at: datetime


class DatasetVersionResponse(BaseModel):
    id: UUID
    version_number: int
    parent_version_id: UUID | None
    state: str
    change_message: str | None
    feature_count: int | None
    extent: list[float] | None
    crs: str | None
    geometry_type: str | None
    schema_definition: dict[str, Any]
    quality_results: dict[str, Any]
    created_by: UUID
    created_at: datetime
    current: bool
    objects: list[DatasetObjectResponse]


class DatasetLineageOriginResponse(BaseModel):
    kind: Literal["managed_upload", "external_source_archive", "repository_object_copy"]
    operation_id: UUID
    source_dataset_id: UUID | None
    source_dataset_name: str | None
    source_revision_number: int | None
    input_object_id: UUID
    acquired_at: datetime


class _DatasetDerivativeLineageResponseFields(BaseModel):
    kind: Literal["pmtiles"]
    operation_id: UUID
    recipe: str
    source_object_id: UUID
    output_object_id: UUID
    bounds: tuple[float, float, float, float]
    minimum_zoom: int = Field(ge=0, le=22)
    maximum_zoom: int = Field(ge=0, le=22)
    source_layer: str
    request_checksum_sha256: str
    created_at: datetime


class DatasetDerivativeLineageResponse(_DatasetDerivativeLineageResponseFields):
    recipe: Literal["gdal-pmtiles-v1"]


class ConfigurableDatasetDerivativeLineageResponse(_DatasetDerivativeLineageResponseFields):
    recipe: Literal["gdal-pmtiles-v2"]
    options: dict[str, Any]
    software: dict[str, Any]


class DatasetVersionLineageResponse(BaseModel):
    schema_version: Literal["opengeo.dataset-version-lineage.1.0.0"]
    dataset_id: UUID
    version_id: UUID
    version_number: int = Field(ge=1)
    origins: list[DatasetLineageOriginResponse]
    derivatives: list[
        DatasetDerivativeLineageResponse | ConfigurableDatasetDerivativeLineageResponse
    ]
    derivatives_truncated: bool


class DatasetPermissionResponse(BaseModel):
    user_id: UUID
    email: str
    display_name: str
    role: DatasetPermissionRole
    granted_by: UUID
    created_at: datetime
    updated_at: datetime


class PutDatasetPermissionRequest(RequestModel):
    role: DatasetPermissionRole


class DownloadTicketResponse(BaseModel):
    url: str
    method: str
    expires_at: datetime


class DocumentPreviewPageResponse(RequestModel):
    number: int
    blocks: list[dict[str, Any]]


class SpatialPreviewResponse(RequestModel):
    schema_version: Literal["opengeo.spatial-preview.1.0.0"]
    dataset_version_id: UUID
    number_returned: int = Field(ge=0, le=5_000)
    number_matched: int | None = Field(default=None, ge=0)
    may_be_truncated: bool
    geojson: dict[str, Any]


class OcrDocumentPreviewPageResponse(RequestModel):
    number: int
    blocks: list[dict[str, Any]]
    text_source: Literal["embedded", "ocr", "none"] = Field(alias="textSource")


class OdtDocumentPreviewResponse(RequestModel):
    schema_version: Literal["opengeo.document-preview.1.0.0"] = Field(alias="schemaVersion")
    source_format: Literal["odt"] = Field(alias="sourceFormat")
    odf_version: Literal["1.2", "1.3", "1.4"] = Field(alias="odfVersion")
    title: str | None
    language: str | None
    pages: list[DocumentPreviewPageResponse]


class PdfDocumentExtractionResponse(RequestModel):
    engine: Literal["poppler-pdftotext"]
    mode: Literal["layout"]
    ocr_performed: Literal[False] = Field(alias="ocrPerformed")
    reading_order: Literal["heuristic"] = Field(alias="readingOrder")
    tagged: bool
    text_available: bool = Field(alias="textAvailable")


class PdfDocumentPreviewResponse(RequestModel):
    schema_version: Literal["opengeo.document-preview.2.0.0"] = Field(alias="schemaVersion")
    source_format: Literal["pdf"] = Field(alias="sourceFormat")
    pdf_version: Literal["1.0", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "2.0"] = Field(
        alias="pdfVersion"
    )
    title: str | None
    language: str | None
    extraction: PdfDocumentExtractionResponse
    pages: list[DocumentPreviewPageResponse]


class PdfOcrDocumentExtractionResponse(RequestModel):
    engine: Literal["poppler-pdftotext+tesseract"]
    mode: Literal["layout+page-ocr"]
    ocr_performed: Literal[True] = Field(alias="ocrPerformed")
    ocr_engine: Literal["tesseract"] = Field(alias="ocrEngine")
    ocr_engine_version: str = Field(alias="ocrEngineVersion")
    ocr_model: Literal[
        "eng",
        "Arabic",
        "Bengali",
        "Cyrillic",
        "Devanagari",
        "Ethiopic",
        "Greek",
        "Hangul",
        "HanS",
        "HanT",
        "Hebrew",
        "Japanese",
        "Latin",
        "Thai",
    ] = Field(alias="ocrModel")
    ocr_page_limit: Literal[32] = Field(alias="ocrPageLimit")
    ocr_pages: list[int] = Field(alias="ocrPages")
    ocr_pixel_limit: Literal[32_000_000] = Field(alias="ocrPixelLimit")
    ocr_maximum_dimension: int = Field(alias="ocrMaximumDimension")
    ocr_total_pixels: int = Field(alias="ocrTotalPixels")
    ocr_truncated: bool = Field(alias="ocrTruncated")
    reading_order: Literal["heuristic"] = Field(alias="readingOrder")
    tagged: bool
    text_available: bool = Field(alias="textAvailable")


class PdfOcrDocumentPreviewResponse(RequestModel):
    schema_version: Literal["opengeo.document-preview.3.0.0"] = Field(alias="schemaVersion")
    source_format: Literal["pdf"] = Field(alias="sourceFormat")
    pdf_version: Literal["1.0", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "2.0"] = Field(
        alias="pdfVersion"
    )
    title: str | None
    language: str | None
    extraction: PdfOcrDocumentExtractionResponse
    pages: list[OcrDocumentPreviewPageResponse]


DocumentPreviewResponse = (
    OdtDocumentPreviewResponse | PdfDocumentPreviewResponse | PdfOcrDocumentPreviewResponse
)


def repository_from_request(request: Request) -> CatalogRepository:
    repository = request.app.state.catalog_repository
    if not isinstance(repository, PostgresCatalogRepository):
        return cast(CatalogRepository, repository)
    return repository


def tenant_context(session: AuthSession) -> TenantContext:
    membership = require_organization(session)
    return TenantContext(session.principal.user_id, membership.organization_id)


async def execute_catalog[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except CatalogAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except CatalogNotFound as error:
        raise HTTPException(status_code=404, detail=f"{error.resource}_not_found") from error
    except CatalogConflict as error:
        raise HTTPException(status_code=409, detail={"code": error.code}) from error
    except DownloadStorageUnavailable as error:
        logger.error("catalog.download_storage_unavailable")
        raise HTTPException(status_code=503, detail="download_storage_unavailable") from error
    except CatalogStoreUnavailable as error:
        logger.error("catalog.store_unavailable", extra={"error_type": type(error).__name__})
        raise HTTPException(status_code=503, detail="catalog_store_unavailable") from error


def object_response(record: DatasetObject) -> DatasetObjectResponse:
    return DatasetObjectResponse(
        id=record.object_id,
        role=record.role,
        filename=record.filename,
        content_type=record.content_type,
        size_bytes=record.size_bytes,
        checksum_sha256=record.checksum_sha256,
        created_at=record.created_at,
    )


def version_response(record: DatasetVersion) -> DatasetVersionResponse:
    return DatasetVersionResponse(
        id=record.version_id,
        version_number=record.version_number,
        parent_version_id=record.parent_version_id,
        state=record.state,
        change_message=record.change_message,
        feature_count=record.feature_count,
        extent=record.extent,
        crs=record.crs,
        geometry_type=record.geometry_type,
        schema_definition=record.schema_definition,
        quality_results=record.quality_results,
        created_by=record.created_by,
        created_at=record.created_at,
        current=record.current,
        objects=[object_response(item) for item in record.objects],
    )


def lineage_origin_response(record: DatasetLineageOrigin) -> DatasetLineageOriginResponse:
    return DatasetLineageOriginResponse(
        kind=record.kind,
        operation_id=record.operation_id,
        source_dataset_id=record.source_dataset_id,
        source_dataset_name=record.source_dataset_name,
        source_revision_number=record.source_revision_number,
        input_object_id=record.input_object_id,
        acquired_at=record.acquired_at,
    )


def derivative_lineage_response(
    record: DatasetDerivativeLineage,
) -> DatasetDerivativeLineageResponse | ConfigurableDatasetDerivativeLineageResponse:
    response_type = (
        ConfigurableDatasetDerivativeLineageResponse
        if record.recipe == "gdal-pmtiles-v2"
        else DatasetDerivativeLineageResponse
    )
    return response_type.model_validate(
        dict(
            kind=record.kind,
            operation_id=record.operation_id,
            recipe=record.recipe,
            source_object_id=record.source_object_id,
            output_object_id=record.output_object_id,
            bounds=record.bounds,
            minimum_zoom=record.minimum_zoom,
            maximum_zoom=record.maximum_zoom,
            source_layer=record.source_layer,
            request_checksum_sha256=record.request_checksum_sha256,
            created_at=record.created_at,
            **(
                {"options": record.options, "software": record.software}
                if record.recipe == "gdal-pmtiles-v2"
                else {}
            ),
        )
    )


def lineage_response(record: DatasetVersionLineage) -> DatasetVersionLineageResponse:
    return DatasetVersionLineageResponse(
        schema_version=DATASET_VERSION_LINEAGE_SCHEMA,
        dataset_id=record.dataset_id,
        version_id=record.version_id,
        version_number=record.version_number,
        origins=[lineage_origin_response(item) for item in record.origins],
        derivatives=[derivative_lineage_response(item) for item in record.derivatives],
        derivatives_truncated=record.derivatives_truncated,
    )


def permission_response(record: DatasetPermission) -> DatasetPermissionResponse:
    return DatasetPermissionResponse(
        user_id=record.user_id,
        email=record.email,
        display_name=record.display_name,
        role=record.role,
        granted_by=record.granted_by,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def download_response(ticket: DownloadTicket) -> DownloadTicketResponse:
    return DownloadTicketResponse(
        url=ticket.url,
        method=ticket.method,
        expires_at=ticket.expires_at,
    )


@router.get(
    "/projects/{project_id}/datasets/{dataset_id}/versions",
    response_model=list[DatasetVersionResponse],
)
async def versions(
    project_id: UUID,
    dataset_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CatalogRepository, Depends(repository_from_request)],
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> list[DatasetVersionResponse]:
    records = await execute_catalog(
        repository.list_versions(tenant_context(session), project_id, dataset_id, limit, offset)
    )
    return [version_response(record) for record in records]


@router.get(
    "/projects/{project_id}/datasets/{dataset_id}/versions/{version_id}/lineage",
    response_model=DatasetVersionLineageResponse,
)
async def version_lineage(
    project_id: UUID,
    dataset_id: UUID,
    version_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CatalogRepository, Depends(repository_from_request)],
) -> DatasetVersionLineageResponse:
    record = await execute_catalog(
        repository.get_version_lineage(tenant_context(session), project_id, dataset_id, version_id)
    )
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return lineage_response(record)


@router.get(
    "/projects/{project_id}/datasets/{dataset_id}/versions/{version_id}/document-preview",
    response_model=DocumentPreviewResponse,
)
async def document_preview(
    project_id: UUID,
    dataset_id: UUID,
    version_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CatalogRepository, Depends(repository_from_request)],
) -> DocumentPreviewResponse:
    document = await execute_catalog(
        repository.get_document_preview(tenant_context(session), project_id, dataset_id, version_id)
    )
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    if document.get("sourceFormat") == "odt":
        return OdtDocumentPreviewResponse.model_validate(document)
    if document.get("schemaVersion") == "opengeo.document-preview.3.0.0":
        return PdfOcrDocumentPreviewResponse.model_validate(document)
    return PdfDocumentPreviewResponse.model_validate(document)


@router.get(
    "/projects/{project_id}/datasets/{dataset_id}/versions/{version_id}/spatial-preview",
    response_model=SpatialPreviewResponse,
)
async def spatial_preview(
    project_id: UUID,
    dataset_id: UUID,
    version_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CatalogRepository, Depends(repository_from_request)],
) -> SpatialPreviewResponse:
    preview = await execute_catalog(
        repository.get_spatial_preview(tenant_context(session), project_id, dataset_id, version_id)
    )
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return SpatialPreviewResponse.model_validate(preview)


@router.get(
    "/projects/{project_id}/datasets/{dataset_id}/permissions",
    response_model=list[DatasetPermissionResponse],
)
async def permissions(
    project_id: UUID,
    dataset_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CatalogRepository, Depends(repository_from_request)],
) -> list[DatasetPermissionResponse]:
    records = await execute_catalog(
        repository.list_permissions(tenant_context(session), project_id, dataset_id)
    )
    return [permission_response(record) for record in records]


@router.put(
    "/projects/{project_id}/datasets/{dataset_id}/permissions/{user_id}",
    response_model=DatasetPermissionResponse,
)
async def put_permission(
    project_id: UUID,
    dataset_id: UUID,
    user_id: UUID,
    payload: PutDatasetPermissionRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CatalogRepository, Depends(repository_from_request)],
) -> DatasetPermissionResponse:
    record = await execute_catalog(
        repository.put_permission(
            tenant_context(session),
            project_id,
            dataset_id,
            PermissionGrant(user_id, payload.role),
            get_request_id(),
        )
    )
    return permission_response(record)


@router.delete(
    "/projects/{project_id}/datasets/{dataset_id}/permissions/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_permission(
    project_id: UUID,
    dataset_id: UUID,
    user_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CatalogRepository, Depends(repository_from_request)],
) -> Response:
    await execute_catalog(
        repository.delete_permission(
            tenant_context(session), project_id, dataset_id, user_id, get_request_id()
        )
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/projects/{project_id}/datasets/{dataset_id}/versions/{version_id}/objects/{object_id}/download",
    response_model=DownloadTicketResponse,
)
async def download(
    project_id: UUID,
    dataset_id: UUID,
    version_id: UUID,
    object_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CatalogRepository, Depends(repository_from_request)],
) -> DownloadTicketResponse:
    ticket = await execute_catalog(
        repository.request_download(
            tenant_context(session),
            project_id,
            dataset_id,
            version_id,
            object_id,
            get_request_id(),
        )
    )
    return download_response(ticket)
