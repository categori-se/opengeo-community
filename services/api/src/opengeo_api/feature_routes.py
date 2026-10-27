import asyncio
import hashlib
import logging
from collections.abc import Awaitable
from typing import Annotated, Any, Literal, cast
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.cql2_features import Cql2Invalid
from opengeo_api.features import (
    AttributeQueryStep,
    FeatureAccessDenied,
    FeatureCollection,
    FeatureConflict,
    FeatureDeletion,
    FeatureDraft,
    FeatureField,
    FeatureFieldType,
    FeatureInvalid,
    FeatureLockRecord,
    FeatureMutation,
    FeatureNotFound,
    FeaturePage,
    FeatureRecord,
    FeatureRepository,
    FeatureRevision,
    FeatureStoreUnavailable,
    FeatureStructureMutation,
    FeatureTombstone,
    FeatureTombstonePage,
    GeometryType,
    PostgresFeatureRepository,
    SpatialQueryStep,
    feature_field_document,
    normalize_fields,
    normalize_geometry,
    normalize_query_geometry,
)
from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.logging import get_request_id
from opengeo_api.resource_routes import tenant_context
from opengeo_api.vector_analysis import AnalysisOperation, AnalysisRequest

logger = logging.getLogger(__name__)
router = APIRouter(tags=["governed feature editing"])
ChangeMessage = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)
]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FeatureFieldConditionRequest(RequestModel):
    field: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    equals: str | int | float | bool | None = None
    value_field: Annotated[str, StringConstraints(min_length=1, max_length=100)] | None = None
    operator: Literal["eq", "ne", "gt", "gte", "lt", "lte"] = "eq"


class FeatureFieldRequest(RequestModel):
    name: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    type: FeatureFieldType
    required: bool = False
    label: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
        | None
    ) = None
    description: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
        | None
    ) = None
    choices: list[Annotated[str, StringConstraints(min_length=1, max_length=200)]] = Field(
        default_factory=list, max_length=32
    )
    minimum: int | float | None = None
    maximum: int | float | None = None
    min_length: int | None = Field(default=None, ge=1, le=2000)
    max_length: int | None = Field(default=None, ge=1, le=2000)
    attachment: bool = False
    calculation: Any = None
    visible_when: FeatureFieldConditionRequest | None = None
    fields: list["FeatureFieldRequest"] = Field(default_factory=list, max_length=64)
    repeat: bool = False
    min_items: int | None = Field(default=None, ge=0, le=20)
    max_items: int | None = Field(default=None, ge=1, le=20)


class GeoJsonFeatureRequest(RequestModel):
    type: Literal["Feature"] = "Feature"
    id: UUID | None = None
    geometry: dict[str, Any]
    properties: dict[str, Any] = Field(default_factory=dict)


class CreateFeatureCollectionRequest(RequestModel):
    geometry_type: GeometryType
    fields: list[FeatureFieldRequest] = Field(default_factory=list, max_length=64)
    features: list[GeoJsonFeatureRequest] = Field(default_factory=list, max_length=100)


class CreateFeatureRequest(GeoJsonFeatureRequest):
    change_message: ChangeMessage | None = None


class UpdateFeatureRequest(RequestModel):
    expected_version: int = Field(ge=1)
    lock_token: UUID | None = None
    geometry: dict[str, Any]
    properties: dict[str, Any] = Field(default_factory=dict)
    change_message: ChangeMessage | None = None


class RestoreFeatureRequest(RequestModel):
    expected_version: int = Field(ge=2)
    revision_version: int = Field(ge=1)
    change_message: ChangeMessage | None = None


class SeparateMultipolygonPartsRequest(RequestModel):
    feature_id: UUID
    expected_version: int = Field(ge=1)
    lock_token: UUID | None = None
    retained_part_index: int = Field(default=0, ge=0, le=255)
    change_message: ChangeMessage | None = None


class FeatureExpectedVersionRequest(RequestModel):
    feature_id: UUID
    expected_version: int = Field(ge=1)
    lock_token: UUID | None = None


class AcquireFeatureLockRequest(RequestModel):
    expected_version: int = Field(ge=1)
    lock_token: UUID
    lease_seconds: int = Field(default=120, ge=30, le=300)


class MergeMultipolygonFeaturesRequest(RequestModel):
    retained_feature_id: UUID
    features: list[FeatureExpectedVersionRequest] = Field(min_length=2, max_length=20)
    change_message: ChangeMessage | None = None
    geometry_operation: Literal["collect", "dissolve"] = "collect"


class AttributeQueryStepRequest(RequestModel):
    kind: Literal["attribute"]
    field: Annotated[str, StringConstraints(pattern=r"^[A-Za-z_][A-Za-z0-9_.:-]{0,99}$")]
    operator: Literal[
        "equals",
        "not_equals",
        "contains",
        "starts_with",
        "greater_than",
        "greater_than_or_equal",
        "less_than",
        "less_than_or_equal",
        "is_null",
    ]
    value: Any = None
    case_sensitive: bool = False


class SpatialQueryStepRequest(RequestModel):
    kind: Literal["spatial"]
    relation: Literal["intersects", "within"] = "intersects"
    geometry: dict[str, Any]
    buffer_meters: float = Field(default=0, ge=0, le=100_000)


class FeatureQueryRequest(RequestModel):
    schema_version: Literal["opengeo.feature-query.1.0.0", "opengeo.feature-query.1.1.0"] = (
        "opengeo.feature-query.1.1.0"
    )
    combine: Literal["all"] = "all"
    steps: list[AttributeQueryStepRequest | SpatialQueryStepRequest] = Field(
        min_length=1, max_length=4
    )
    limit: int = Field(default=100, ge=1, le=100)
    offset: int = Field(default=0, ge=0, le=10_000)
    expected_generation: int | None = Field(default=None, ge=1)


def repository_from_request(request: Request) -> FeatureRepository:
    repository = request.app.state.feature_repository
    if not isinstance(repository, PostgresFeatureRepository):
        return cast(FeatureRepository, repository)
    return repository


async def execute_feature[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except FeatureAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except FeatureNotFound as error:
        raise HTTPException(status_code=404, detail=f"{error.resource}_not_found") from error
    except FeatureConflict as error:
        detail: dict[str, Any] = {"code": error.code}
        if error.current_version is not None:
            detail["current_version"] = error.current_version
        raise HTTPException(status_code=409, detail=detail) from error
    except Cql2Invalid as error:
        raise HTTPException(
            status_code=400, detail={"code": "invalid_cql2_filter", "message": str(error)}
        ) from error
    except FeatureInvalid as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "feature_validation_failed", "message": str(error)},
        ) from error
    except FeatureStoreUnavailable as error:
        logger.error("feature.store_unavailable", extra={"error_type": type(error).__name__})
        raise HTTPException(status_code=503, detail="feature_store_unavailable") from error


@router.post(
    "/projects/{project_id}/datasets/{dataset_id}/feature-collection",
    status_code=status.HTTP_201_CREATED,
)
async def create_feature_collection(
    project_id: UUID,
    dataset_id: UUID,
    payload: CreateFeatureCollectionRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> JSONResponse:
    fields = _fields(payload.fields)
    drafts = tuple(_draft(feature) for feature in payload.features)
    page = await execute_feature(
        repository.create_collection(
            tenant_context(session),
            project_id,
            dataset_id,
            payload.geometry_type,
            fields,
            drafts,
            get_request_id(),
        )
    )
    return _page_response(page, status_code=status.HTTP_201_CREATED)


@router.get("/projects/{project_id}/datasets/{dataset_id}/feature-collection")
async def get_feature_collection(
    project_id: UUID,
    dataset_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    page = await execute_feature(
        repository.list_features(
            tenant_context(session), project_id, dataset_id, bbox=None, limit=1, offset=0
        )
    )
    return _collection_document(page.collection)


@router.get("/projects/{project_id}/datasets/{dataset_id}/features")
async def list_features(
    project_id: UUID,
    dataset_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
    bbox: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> JSONResponse:
    page = await execute_feature(
        repository.list_features(
            tenant_context(session),
            project_id,
            dataset_id,
            bbox=_bbox(bbox),
            limit=limit,
            offset=offset,
        )
    )
    return _page_response(page)


@router.post("/projects/{project_id}/datasets/{dataset_id}/feature-query")
async def query_features(
    project_id: UUID,
    dataset_id: UUID,
    payload: FeatureQueryRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> JSONResponse:
    steps, query_document = _query_steps(payload)
    page = await execute_feature(
        repository.query_features(
            tenant_context(session),
            project_id,
            dataset_id,
            steps=steps,
            limit=payload.limit,
            offset=payload.offset,
            expected_generation=payload.expected_generation,
        )
    )
    canonical_query = canonical_json_bytes(query_document)
    document = _page_document(page)
    document["opengeo:query"] = query_document
    document["opengeo:querySha256"] = hashlib.sha256(canonical_query).hexdigest()
    document["opengeo:collectionGeneration"] = page.collection.generation
    return JSONResponse(
        document,
        media_type="application/geo+json",
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post(
    "/projects/{project_id}/datasets/{dataset_id}/features",
    status_code=status.HTTP_201_CREATED,
)
async def create_feature(
    project_id: UUID,
    dataset_id: UUID,
    payload: CreateFeatureRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> JSONResponse:
    mutation = await execute_feature(
        repository.create_feature(
            tenant_context(session),
            project_id,
            dataset_id,
            _draft(payload),
            payload.change_message,
            get_request_id(),
        )
    )
    return _mutation_response(mutation, status_code=status.HTTP_201_CREATED)


@router.get("/projects/{project_id}/datasets/{dataset_id}/feature-tombstones")
async def list_deleted_features(
    project_id: UUID,
    dataset_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> dict[str, Any]:
    page = await execute_feature(
        repository.list_deleted_features(
            tenant_context(session),
            project_id,
            dataset_id,
            limit=limit,
            offset=offset,
        )
    )
    return _tombstone_page_document(page)


@router.post("/projects/{project_id}/datasets/{dataset_id}/features/separate-parts")
async def separate_multipolygon_parts(
    project_id: UUID,
    dataset_id: UUID,
    payload: SeparateMultipolygonPartsRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> JSONResponse:
    mutation = await execute_feature(
        repository.separate_multipolygon_parts(
            tenant_context(session),
            project_id,
            dataset_id,
            payload.feature_id,
            payload.expected_version,
            payload.retained_part_index,
            payload.change_message,
            get_request_id(),
            payload.lock_token,
        )
    )
    return _structure_mutation_response(mutation, "separate_parts")


@router.post("/projects/{project_id}/datasets/{dataset_id}/features/merge-parts")
async def merge_multipolygon_features(
    project_id: UUID,
    dataset_id: UUID,
    payload: MergeMultipolygonFeaturesRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> JSONResponse:
    mutation = await execute_feature(
        repository.merge_multipolygon_features(
            tenant_context(session),
            project_id,
            dataset_id,
            payload.retained_feature_id,
            tuple(
                (item.feature_id, item.expected_version, item.lock_token)
                for item in payload.features
            ),
            payload.change_message,
            get_request_id(),
            geometry_operation=payload.geometry_operation,
        )
    )
    return _structure_mutation_response(
        mutation, "merge_parts", geometry_operation=payload.geometry_operation
    )


@router.get("/projects/{project_id}/datasets/{dataset_id}/feature-locks")
async def list_feature_locks(
    project_id: UUID,
    dataset_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    locks = await execute_feature(
        repository.list_feature_locks(tenant_context(session), project_id, dataset_id)
    )
    return {
        "locks": [_feature_lock_document(feature_lock) for feature_lock in locks],
        "number_returned": len(locks),
        "limit": 100,
    }


@router.put("/projects/{project_id}/datasets/{dataset_id}/features/{feature_id}/lock")
async def acquire_feature_lock(
    project_id: UUID,
    dataset_id: UUID,
    feature_id: UUID,
    payload: AcquireFeatureLockRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    feature_lock = await execute_feature(
        repository.acquire_feature_lock(
            tenant_context(session),
            project_id,
            dataset_id,
            feature_id,
            payload.expected_version,
            payload.lock_token,
            payload.lease_seconds,
            get_request_id(),
        )
    )
    return _feature_lock_document(feature_lock)


@router.delete("/projects/{project_id}/datasets/{dataset_id}/features/{feature_id}/lock")
async def release_feature_lock(
    project_id: UUID,
    dataset_id: UUID,
    feature_id: UUID,
    lock_token: Annotated[UUID, Query()],
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    release = await execute_feature(
        repository.release_feature_lock(
            tenant_context(session),
            project_id,
            dataset_id,
            feature_id,
            lock_token,
            get_request_id(),
        )
    )
    return {"feature_id": str(release.feature_id), "released": release.released}


@router.get("/projects/{project_id}/datasets/{dataset_id}/features/{feature_id}")
async def get_feature(
    project_id: UUID,
    dataset_id: UUID,
    feature_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> JSONResponse:
    feature = await execute_feature(
        repository.get_feature(tenant_context(session), project_id, dataset_id, feature_id)
    )
    return JSONResponse(_feature_document(feature), media_type="application/geo+json")


@router.put("/projects/{project_id}/datasets/{dataset_id}/features/{feature_id}")
async def update_feature(
    project_id: UUID,
    dataset_id: UUID,
    feature_id: UUID,
    payload: UpdateFeatureRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> JSONResponse:
    mutation = await execute_feature(
        repository.update_feature(
            tenant_context(session),
            project_id,
            dataset_id,
            feature_id,
            payload.expected_version,
            _draft(payload, feature_id),
            payload.change_message,
            get_request_id(),
            payload.lock_token,
        )
    )
    return _mutation_response(mutation)


@router.delete("/projects/{project_id}/datasets/{dataset_id}/features/{feature_id}")
async def delete_feature(
    project_id: UUID,
    dataset_id: UUID,
    feature_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
    expected_version: Annotated[int, Query(ge=1)],
    change_message: Annotated[ChangeMessage | None, Query()] = None,
    lock_token: Annotated[UUID | None, Query()] = None,
) -> dict[str, Any]:
    deletion = await execute_feature(
        repository.delete_feature(
            tenant_context(session),
            project_id,
            dataset_id,
            feature_id,
            expected_version,
            change_message,
            get_request_id(),
            lock_token,
        )
    )
    return _deletion_document(deletion)


@router.post("/projects/{project_id}/datasets/{dataset_id}/features/{feature_id}/restore")
async def restore_feature(
    project_id: UUID,
    dataset_id: UUID,
    feature_id: UUID,
    payload: RestoreFeatureRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> JSONResponse:
    mutation = await execute_feature(
        repository.restore_feature(
            tenant_context(session),
            project_id,
            dataset_id,
            feature_id,
            payload.expected_version,
            payload.revision_version,
            payload.change_message,
            get_request_id(),
        )
    )
    return _mutation_response(mutation)


@router.get("/projects/{project_id}/datasets/{dataset_id}/features/{feature_id}/history")
async def list_feature_history(
    project_id: UUID,
    dataset_id: UUID,
    feature_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict[str, Any]:
    revisions = await execute_feature(
        repository.list_feature_history(
            tenant_context(session), project_id, dataset_id, feature_id, limit, offset
        )
    )
    return {
        "feature_id": str(feature_id),
        "revisions": [_revision_document(revision) for revision in revisions],
        "number_returned": len(revisions),
        "limit": limit,
        "offset": offset,
    }


def _draft(payload: Any, feature_id: UUID | None = None) -> FeatureDraft:
    try:
        geometry_type, geometry, bbox = normalize_geometry(payload.geometry)
    except FeatureInvalid as error:
        raise _validation_error(error) from error
    return FeatureDraft(
        feature_id=feature_id or payload.id or uuid4(),
        geometry_type=geometry_type,
        geometry=geometry,
        bbox=bbox,
        properties=dict(payload.properties),
    )


def _fields(values: list[FeatureFieldRequest]) -> tuple[FeatureField, ...]:
    try:
        return normalize_fields([field.model_dump() for field in values])
    except FeatureInvalid as error:
        raise _validation_error(error) from error


def _validation_error(error: FeatureInvalid) -> HTTPException:
    return HTTPException(
        status_code=422,
        detail={"code": "feature_validation_failed", "message": str(error)},
    )


def _bbox(value: str | None) -> tuple[float, float, float, float] | None:
    if value is None:
        return None
    try:
        parts = tuple(float(part) for part in value.split(","))
    except ValueError as error:
        raise HTTPException(status_code=422, detail="invalid_bbox") from error
    if (
        len(parts) != 4
        or not -180 <= parts[0] < parts[2] <= 180
        or not -90 <= parts[1] < parts[3] <= 90
    ):
        raise HTTPException(status_code=422, detail="invalid_bbox")
    return parts


def _query_steps(
    payload: FeatureQueryRequest,
) -> tuple[tuple[AttributeQueryStep | SpatialQueryStep, ...], dict[str, Any]]:
    steps: list[AttributeQueryStep | SpatialQueryStep] = []
    documents: list[dict[str, Any]] = []
    for request in payload.steps:
        if isinstance(request, AttributeQueryStepRequest):
            attribute_step = AttributeQueryStep(
                field=request.field,
                operator=request.operator,
                value=request.value,
                case_sensitive=request.case_sensitive,
            )
            steps.append(attribute_step)
            documents.append(
                {
                    "kind": "attribute",
                    "field": attribute_step.field,
                    "operator": attribute_step.operator,
                    "value": attribute_step.value,
                    "case_sensitive": attribute_step.case_sensitive,
                }
            )
            continue
        try:
            geometry = normalize_query_geometry(request.geometry)
        except FeatureInvalid as error:
            raise _validation_error(error) from error
        spatial_step = SpatialQueryStep(
            relation=request.relation,
            geometry=geometry,
            buffer_meters=float(request.buffer_meters),
        )
        steps.append(spatial_step)
        documents.append(
            {
                "kind": "spatial",
                "relation": spatial_step.relation,
                "geometry": spatial_step.geometry,
                "buffer_meters": int(spatial_step.buffer_meters)
                if spatial_step.buffer_meters.is_integer()
                else spatial_step.buffer_meters,
            }
        )
    return tuple(steps), {
        "schema_version": payload.schema_version,
        "combine": payload.combine,
        "steps": documents,
        "limit": payload.limit,
        "offset": payload.offset,
        "expected_generation": payload.expected_generation,
        "sort": "feature_id",
    }


def _collection_document(collection: FeatureCollection) -> dict[str, Any]:
    return {
        "dataset_id": str(collection.dataset_id),
        "geometry_type": collection.geometry_type,
        "fields": [feature_field_document(field) for field in collection.fields],
        "generation": collection.generation,
        "feature_count": collection.feature_count,
        "created_by": str(collection.created_by),
        "created_at": collection.created_at.isoformat(),
        "updated_by": str(collection.updated_by),
        "updated_at": collection.updated_at.isoformat(),
    }


def _feature_document(feature: FeatureRecord) -> dict[str, Any]:
    return {
        "type": "Feature",
        "id": str(feature.feature_id),
        "bbox": list(feature.bbox),
        "geometry": feature.geometry,
        "properties": feature.properties,
        "opengeo:version": feature.version_number,
        "opengeo:createdBy": str(feature.created_by),
        "opengeo:createdAt": feature.created_at.isoformat(),
        "opengeo:updatedBy": str(feature.updated_by),
        "opengeo:updatedAt": feature.updated_at.isoformat(),
    }


def _feature_lock_document(feature_lock: FeatureLockRecord) -> dict[str, Any]:
    return {
        "feature_id": str(feature_lock.feature_id),
        "feature_version": feature_lock.feature_version,
        "lock_token": str(feature_lock.lock_token) if feature_lock.lock_token else None,
        "held_by_current_user": feature_lock.held_by_current_user,
        "acquired_at": feature_lock.acquired_at.isoformat(),
        "expires_at": feature_lock.expires_at.isoformat(),
    }


def _page_document(page: FeaturePage) -> dict[str, Any]:
    return {
        "type": "FeatureCollection",
        "features": [_feature_document(feature) for feature in page.features],
        "numberMatched": page.number_matched,
        "numberReturned": len(page.features),
        "opengeo:collection": _collection_document(page.collection),
        "opengeo:limit": page.limit,
        "opengeo:offset": page.offset,
    }


def _page_response(page: FeaturePage, *, status_code: int = 200) -> JSONResponse:
    document = _page_document(page)
    return JSONResponse(document, status_code=status_code, media_type="application/geo+json")


def _mutation_response(mutation: FeatureMutation, *, status_code: int = 200) -> JSONResponse:
    document = _feature_document(mutation.feature)
    document["opengeo:collectionGeneration"] = mutation.collection.generation
    return JSONResponse(document, status_code=status_code, media_type="application/geo+json")


def _structure_mutation_response(
    mutation: FeatureStructureMutation,
    operation: Literal["separate_parts", "merge_parts"],
    *,
    geometry_operation: Literal["collect", "dissolve"] = "collect",
) -> JSONResponse:
    document = {
        "operation": operation,
        "retained_feature": _feature_document(mutation.retained_feature),
        "created_features": [_feature_document(feature) for feature in mutation.created_features],
        "deleted_features": [
            _deletion_document(deletion) for deletion in mutation.deleted_features
        ],
        "collection_generation": mutation.collection.generation,
        "feature_count": mutation.collection.feature_count,
    }
    if geometry_operation == "dissolve":
        document["geometry_operation"] = geometry_operation
    return JSONResponse(document, media_type="application/geo+json")


def _deletion_document(deletion: FeatureDeletion) -> dict[str, Any]:
    return {
        "feature_id": str(deletion.feature_id),
        "deleted_version": deletion.deleted_version,
        "collection_generation": deletion.collection_generation,
    }


def _tombstone_document(tombstone: FeatureTombstone) -> dict[str, Any]:
    return {
        "feature_id": str(tombstone.feature_id),
        "deleted_version": tombstone.deleted_version,
        "deleted_by": str(tombstone.deleted_by),
        "deleted_at": tombstone.deleted_at.isoformat(),
        "updated_at": tombstone.updated_at.isoformat(),
    }


def _tombstone_page_document(page: FeatureTombstonePage) -> dict[str, Any]:
    return {
        "tombstones": [_tombstone_document(item) for item in page.tombstones],
        "number_matched": page.number_matched,
        "number_returned": len(page.tombstones),
        "limit": page.limit,
        "offset": page.offset,
    }


def _revision_document(revision: FeatureRevision) -> dict[str, Any]:
    return {
        "version": revision.version_number,
        "operation": revision.operation,
        "geometry_type": revision.geometry_type,
        "geometry": revision.geometry,
        "properties": revision.properties,
        "changed_by": str(revision.changed_by),
        "change_message": revision.change_message,
        "request_id": revision.request_id,
        "created_at": revision.created_at.isoformat(),
    }


class AnalysisPreviewRequest(RequestModel):
    operation: AnalysisOperation
    source_generation: int = Field(ge=1)
    target_dataset_id: UUID | None = None
    target_generation: int | None = Field(default=None, ge=1)
    distance_meters: float | None = Field(default=None, gt=0, le=100000, allow_inf_nan=False)
    preview_id: UUID | None = None


@router.post("/projects/{project_id}/datasets/{dataset_id}/analysis-preview")
async def analysis_preview(
    project_id: UUID,
    dataset_id: UUID,
    payload: AnalysisPreviewRequest,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> JSONResponse:
    result = await preview_until_disconnected(
        request,
        repository.preview_analysis(
            tenant_context(session), project_id, dataset_id, AnalysisRequest(**payload.model_dump())
        ),
    )
    return JSONResponse(
        result, media_type="application/geo+json", headers={"Cache-Control": "private, no-store"}
    )


@router.post("/projects/{project_id}/datasets/{dataset_id}/analysis-preview/{preview_id}/cancel")
async def cancel_analysis_preview(
    project_id: UUID,
    dataset_id: UUID,
    preview_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> JSONResponse:
    requested = await execute_feature(
        repository.cancel_analysis_preview(
            tenant_context(session), project_id, dataset_id, preview_id
        )
    )
    return JSONResponse(
        {
            "preview_id": str(preview_id),
            "state": "cancellation_requested" if requested else "not_running",
        },
        headers={"Cache-Control": "private, no-store"},
    )


async def preview_until_disconnected[ResponseT](
    request: Request,
    operation: Awaitable[ResponseT],
) -> ResponseT:
    """Cancel and drain read-only preview work when its consumer leaves."""
    task = asyncio.create_task(execute_feature(operation))
    try:
        while True:
            done, _ = await asyncio.wait({task}, timeout=0.1)
            if done:
                return task.result()
            if await request.is_disconnected():
                raise HTTPException(status_code=499, detail="analysis_preview_cancelled")
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@router.get("/feature-attachments/{version_id}")
async def resolve_attachment(
    version_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> JSONResponse:
    result = await execute_feature(
        repository.resolve_attachment(tenant_context(session), version_id)
    )
    return JSONResponse(result, headers={"Cache-Control": "private, no-store"})
