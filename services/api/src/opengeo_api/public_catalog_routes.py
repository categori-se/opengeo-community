import math
from collections.abc import Awaitable
from datetime import datetime
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from opengeo_api.public_catalog import (
    PublicCatalogFacet,
    PublicCatalogFilters,
    PublicCatalogPreviewConflict,
    PublicCatalogRecord,
    PublicCatalogRepository,
    PublicCatalogStoreUnavailable,
    PublicDatasetDocumentPreview,
    PublicDocumentPreview,
    PublicMapPreview,
    PublicSpatialPreview,
)
from opengeo_api.resources import ResourceKind

router = APIRouter(tags=["public catalog"])


class ResponseModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PublicCatalogCommunityResponse(ResponseModel):
    organization_id: UUID
    organization_slug: str
    organization_name: str
    project_id: UUID
    project_name: str


class PublicCatalogPreviewResponse(ResponseModel):
    kind: Literal["map", "dataset", "dataset-document", "document", "metadata"]
    href: str


class PublicCatalogFreshnessResponse(ResponseModel):
    catalog_updated_at: datetime
    source_observed_at: datetime | None
    source_version: str | None


class PublicCatalogProvenanceResponse(ResponseModel):
    namespace: str | None
    identifier: str | None


class PublicCatalogRelationshipsResponse(ResponseModel):
    public_count: int
    detail_href: str


class PublicCatalogRatingsResponse(ResponseModel):
    count: int
    average: float | None


class PublicCatalogRecordResponse(ResponseModel):
    id: UUID
    kind: ResourceKind
    slug: str
    version_number: int
    title: str
    abstract: str | None
    language: str
    license: str | None
    attribution: str | None
    keywords: list[str]
    spatial_extent: list[float] | None
    temporal_start: datetime | None
    temporal_end: datetime | None
    created_at: datetime
    community: PublicCatalogCommunityResponse
    preview: PublicCatalogPreviewResponse
    freshness: PublicCatalogFreshnessResponse
    provenance: PublicCatalogProvenanceResponse
    relationships: PublicCatalogRelationshipsResponse
    ratings: PublicCatalogRatingsResponse


class PublicCatalogFacetResponse(ResponseModel):
    value: str
    label: str
    count: int


class PublicCatalogPageResponse(ResponseModel):
    schema_version: Literal["opengeo.public-catalog.1.5.0"]
    number_returned: int
    number_matched: int
    limit: int
    offset: int
    next_offset: int | None
    facet_sample_size: int
    facets_truncated: bool
    facets: dict[str, list[PublicCatalogFacetResponse]]
    records: list[PublicCatalogRecordResponse]


class PublicSpatialPreviewResponse(ResponseModel):
    schema_version: Literal["opengeo.public-spatial-preview.1.0.0"]
    resource_id: UUID
    resource_version_number: int = Field(ge=1)
    number_returned: int = Field(ge=0, le=5_000)
    number_matched: int | None = Field(default=None, ge=0)
    may_be_truncated: bool
    geojson: dict[str, Any]


class PublicDocumentPreviewResponse(ResponseModel):
    schema_version: Literal["opengeo.public-document-preview.1.0.0"]
    resource_id: UUID
    resource_version_number: int = Field(ge=1)
    resource_kind: Literal["document", "story", "dashboard"]
    renderer_version: str = Field(min_length=1, max_length=100)
    dependency_references_omitted: int = Field(ge=0, le=24)
    html: str = Field(min_length=1, max_length=256 * 1024)


class PublicDatasetDocumentPreviewResponse(ResponseModel):
    schema_version: Literal["opengeo.public-dataset-document-preview.1.0.0"]
    resource_id: UUID
    resource_version_number: int = Field(ge=1)
    dataset_version_number: int = Field(ge=1)
    source_format: Literal["pdf", "odt"]
    presentation_kind: Literal["semantic", "visual"]
    presentation: dict[str, Any]


class PublicMapPreviewLayerResponse(ResponseModel):
    layer_id: str = Field(min_length=1, max_length=160)
    title: str = Field(min_length=1, max_length=240)
    visible: bool
    opacity: float = Field(ge=0, le=1)
    order: int = Field(ge=-1_000_000, le=1_000_000)
    style: dict[str, Any]
    labels: dict[str, Any]
    number_returned: int = Field(ge=0, le=5_000)
    number_matched: int | None = Field(default=None, ge=0)
    may_be_truncated: bool
    geojson: dict[str, Any]


class PublicMapPreviewResponse(ResponseModel):
    schema_version: Literal["opengeo.public-map-preview.1.0.0"]
    resource_id: UUID
    resource_version_number: int = Field(ge=1)
    map_version: int = Field(ge=1)
    projection: Literal["mercator", "globe"]
    color_mode: Literal["light", "dark"]
    layers: list[PublicMapPreviewLayerResponse] = Field(max_length=64)


def repository_from_request(request: Request) -> PublicCatalogRepository:
    return cast(PublicCatalogRepository, request.app.state.public_catalog_repository)


def _bbox(value: str | None) -> tuple[float, float, float, float] | None:
    if value is None:
        return None
    try:
        coordinates = tuple(float(part.strip()) for part in value.split(","))
    except ValueError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "public_catalog_bbox_invalid"},
        ) from error
    if (
        len(coordinates) != 4
        or not all(math.isfinite(item) for item in coordinates)
        or not -180 <= coordinates[0] <= 180
        or not -180 <= coordinates[2] <= 180
        or not -90 <= coordinates[1] <= 90
        or not -90 <= coordinates[3] <= 90
        or coordinates[0] > coordinates[2]
        or coordinates[1] > coordinates[3]
    ):
        raise HTTPException(
            status_code=422,
            detail={"code": "public_catalog_bbox_invalid"},
        )
    return coordinates


def _record(record: PublicCatalogRecord) -> PublicCatalogRecordResponse:
    detail_href = (
        f"/public/organizations/{record.organization_id}/projects/"
        f"{record.project_id}/resources/{record.resource_id}"
    )
    preview_href = {
        "map": f"{detail_href}/map-preview",
        "dataset": f"{detail_href}/spatial-preview",
        "dataset-document": f"{detail_href}/dataset-document-preview",
        "document": f"{detail_href}/document-preview",
    }.get(record.preview_kind, detail_href)
    return PublicCatalogRecordResponse(
        id=record.resource_id,
        kind=record.kind,
        slug=record.slug,
        version_number=record.version_number,
        title=record.title,
        abstract=record.abstract,
        language=record.language,
        license=record.license,
        attribution=record.attribution,
        keywords=list(record.keywords),
        spatial_extent=list(record.spatial_extent) if record.spatial_extent is not None else None,
        temporal_start=record.temporal_start,
        temporal_end=record.temporal_end,
        created_at=record.created_at,
        community=PublicCatalogCommunityResponse(
            organization_id=record.organization_id,
            organization_slug=record.organization_slug,
            organization_name=record.organization_name,
            project_id=record.project_id,
            project_name=record.project_name,
        ),
        preview=PublicCatalogPreviewResponse(kind=record.preview_kind, href=preview_href),
        freshness=PublicCatalogFreshnessResponse(
            catalog_updated_at=record.updated_at,
            source_observed_at=record.origin_observed_at,
            source_version=record.origin_version,
        ),
        provenance=PublicCatalogProvenanceResponse(
            namespace=record.origin_namespace,
            identifier=record.origin_identifier,
        ),
        relationships=PublicCatalogRelationshipsResponse(
            public_count=record.public_relationship_count,
            detail_href=detail_href,
        ),
        ratings=PublicCatalogRatingsResponse(
            count=record.rating_count,
            average=record.rating_average,
        ),
    )


def _facet(record: PublicCatalogFacet) -> PublicCatalogFacetResponse:
    return PublicCatalogFacetResponse(value=record.value, label=record.label, count=record.count)


async def _execute[ResultT](operation: Awaitable[ResultT]) -> ResultT:
    try:
        return await operation
    except PublicCatalogStoreUnavailable as error:
        raise HTTPException(
            status_code=503,
            detail={"code": "public_catalog_unavailable"},
        ) from error
    except PublicCatalogPreviewConflict as error:
        raise HTTPException(status_code=409, detail={"code": error.code}) from error


@router.get(
    "/public/organizations/{organization_id}/resources",
    response_model=PublicCatalogPageResponse,
)
async def list_public_resources(
    organization_id: UUID,
    repository: Annotated[PublicCatalogRepository, Depends(repository_from_request)],
    query: Annotated[str | None, Query(min_length=1, max_length=200)] = None,
    kind: ResourceKind | None = None,
    project_id: UUID | None = None,
    keyword: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
    license: Annotated[str | None, Query(min_length=1, max_length=200)] = None,
    origin_namespace: Annotated[
        str | None,
        Query(min_length=1, max_length=64, pattern=r"^[a-z0-9][a-z0-9._-]{0,63}$"),
    ] = None,
    bbox: Annotated[str | None, Query(min_length=7, max_length=100)] = None,
    temporal_start: datetime | None = None,
    temporal_end: datetime | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 24,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> PublicCatalogPageResponse:
    if temporal_start is not None and temporal_end is not None and temporal_start > temporal_end:
        raise HTTPException(
            status_code=422,
            detail={"code": "public_catalog_temporal_order_invalid"},
        )
    page = await _execute(
        repository.list_public_resources(
            organization_id,
            PublicCatalogFilters(
                query=query,
                kind=kind,
                project_id=project_id,
                keyword=keyword,
                license=license,
                origin_namespace=origin_namespace,
                bbox=_bbox(bbox),
                temporal_start=temporal_start,
                temporal_end=temporal_end,
                limit=limit,
                offset=offset,
            ),
        )
    )
    returned = len(page.records)
    candidate_offset = offset + returned
    next_offset = (
        candidate_offset
        if returned > 0 and candidate_offset < page.number_matched and candidate_offset <= 10_000
        else None
    )
    return PublicCatalogPageResponse(
        schema_version="opengeo.public-catalog.1.5.0",
        number_returned=returned,
        number_matched=page.number_matched,
        limit=limit,
        offset=offset,
        next_offset=next_offset,
        facet_sample_size=page.facet_sample_size,
        facets_truncated=page.facets_truncated,
        facets={name: [_facet(item) for item in values] for name, values in page.facets.items()},
        records=[_record(record) for record in page.records],
    )


@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/resources/{resource_id}",
    response_model=PublicCatalogRecordResponse,
)
async def get_public_resource(
    organization_id: UUID,
    project_id: UUID,
    resource_id: UUID,
    repository: Annotated[PublicCatalogRepository, Depends(repository_from_request)],
) -> PublicCatalogRecordResponse:
    record = await _execute(
        repository.get_public_resource(organization_id, project_id, resource_id)
    )
    if record is None:
        raise HTTPException(status_code=404, detail={"code": "public_resource_not_found"})
    return _record(record)


@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/resources/"
    "{resource_id}/spatial-preview",
    response_model=PublicSpatialPreviewResponse,
)
async def get_public_spatial_preview(
    organization_id: UUID,
    project_id: UUID,
    resource_id: UUID,
    repository: Annotated[PublicCatalogRepository, Depends(repository_from_request)],
) -> PublicSpatialPreviewResponse:
    preview: PublicSpatialPreview | None = await _execute(
        repository.get_public_spatial_preview(organization_id, project_id, resource_id)
    )
    if preview is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "public_spatial_preview_not_found"},
        )
    return PublicSpatialPreviewResponse(
        schema_version="opengeo.public-spatial-preview.1.0.0",
        resource_id=preview.resource_id,
        resource_version_number=preview.resource_version_number,
        number_returned=preview.number_returned,
        number_matched=preview.number_matched,
        may_be_truncated=preview.may_be_truncated,
        geojson=preview.geojson,
    )


@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/resources/"
    "{resource_id}/document-preview",
    response_model=PublicDocumentPreviewResponse,
)
async def get_public_document_preview(
    organization_id: UUID,
    project_id: UUID,
    resource_id: UUID,
    repository: Annotated[PublicCatalogRepository, Depends(repository_from_request)],
) -> PublicDocumentPreviewResponse:
    preview: PublicDocumentPreview | None = await _execute(
        repository.get_public_document_preview(organization_id, project_id, resource_id)
    )
    if preview is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "public_document_preview_not_found"},
        )
    return PublicDocumentPreviewResponse(
        schema_version="opengeo.public-document-preview.1.0.0",
        resource_id=preview.resource_id,
        resource_version_number=preview.resource_version_number,
        resource_kind=preview.resource_kind,
        renderer_version=preview.renderer_version,
        dependency_references_omitted=preview.dependency_references_omitted,
        html=preview.html,
    )


@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/resources/"
    "{resource_id}/dataset-document-preview",
    response_model=PublicDatasetDocumentPreviewResponse,
)
async def get_public_dataset_document_preview(
    organization_id: UUID,
    project_id: UUID,
    resource_id: UUID,
    repository: Annotated[PublicCatalogRepository, Depends(repository_from_request)],
) -> PublicDatasetDocumentPreviewResponse:
    preview: PublicDatasetDocumentPreview | None = await _execute(
        repository.get_public_dataset_document_preview(
            organization_id,
            project_id,
            resource_id,
        )
    )
    if preview is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "public_dataset_document_preview_not_found"},
        )
    return PublicDatasetDocumentPreviewResponse(
        schema_version="opengeo.public-dataset-document-preview.1.0.0",
        resource_id=preview.resource_id,
        resource_version_number=preview.resource_version_number,
        dataset_version_number=preview.dataset_version_number,
        source_format=preview.source_format,
        presentation_kind=preview.presentation_kind,
        presentation=preview.presentation,
    )


@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/resources/"
    "{resource_id}/map-preview",
    response_model=PublicMapPreviewResponse,
)
async def get_public_map_preview(
    organization_id: UUID,
    project_id: UUID,
    resource_id: UUID,
    repository: Annotated[PublicCatalogRepository, Depends(repository_from_request)],
) -> PublicMapPreviewResponse:
    preview: PublicMapPreview | None = await _execute(
        repository.get_public_map_preview(organization_id, project_id, resource_id)
    )
    if preview is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "public_map_preview_not_found"},
        )
    return PublicMapPreviewResponse(
        schema_version="opengeo.public-map-preview.1.0.0",
        resource_id=preview.resource_id,
        resource_version_number=preview.resource_version_number,
        map_version=preview.map_version,
        projection=preview.projection,
        color_mode=preview.color_mode,
        layers=[
            PublicMapPreviewLayerResponse(
                layer_id=layer.layer_id,
                title=layer.title,
                visible=layer.visible,
                opacity=layer.opacity,
                order=layer.order,
                style=layer.style,
                labels=layer.labels,
                number_returned=layer.number_returned,
                number_matched=layer.number_matched,
                may_be_truncated=layer.may_be_truncated,
                geojson=layer.geojson,
            )
            for layer in preview.layers
        ],
    )
