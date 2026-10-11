import json
from datetime import datetime
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Request, status
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.logging import get_request_id
from opengeo_api.resource_routes import tenant_context
from opengeo_api.spatial_catalog_admin import (
    CATALOG_LIMITS,
    AssignStyleOperation,
    CatalogOperation,
    CreateStoreOperation,
    DisableLayerGroupOperation,
    DisableStoreOperation,
    LayerGroupDraft,
    MetadataDraft,
    PostgresSpatialCatalogRepository,
    PutLayerGroupOperation,
    SpatialCatalogBulkResult,
    SpatialCatalogRepository,
    SpatialCatalogSnapshot,
    SpatialServiceCollectionStyle,
    SpatialServiceLayerGroup,
    SpatialServiceMetadata,
    SpatialServiceStore,
    StoreDraft,
    StyleDraft,
    UpdateMetadataOperation,
    WithdrawStyleOperation,
)
from opengeo_api.spatial_service_routes import execute_service

router = APIRouter(tags=["spatial catalog administration"])

Slug = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        to_lower=True,
        min_length=1,
        max_length=100,
        pattern=r"^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$",
    ),
]
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
Abstract = Annotated[
    str | None, StringConstraints(strip_whitespace=True, min_length=1, max_length=8000)
]
Description = Annotated[
    str | None, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)
]
ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
ChangeMessage = Annotated[
    str | None, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)
]
Protocol = Literal[
    "ogc_api_features",
    "wfs_2_0",
    "wms_1_1",
    "wms_1_3",
    "wmts_1_0",
    "wcs_2_0",
    "arcgis_features",
]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ServiceContactRequest(RequestModel):
    name: Annotated[
        str | None, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)
    ] = None
    organization: Annotated[
        str | None, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)
    ] = None
    position: Annotated[
        str | None, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)
    ] = None
    email: Annotated[
        str | None,
        StringConstraints(
            strip_whitespace=True,
            to_lower=True,
            min_length=3,
            max_length=254,
            pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$",
        ),
    ] = None
    phone: Annotated[
        str | None, StringConstraints(strip_whitespace=True, min_length=3, max_length=40)
    ] = None


class UpdateServiceMetadataRequest(RequestModel):
    expected_version: int = Field(ge=1)
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    abstract: Abstract = None
    namespace_uri: Annotated[
        str | None,
        StringConstraints(
            strip_whitespace=True,
            min_length=9,
            max_length=2048,
            pattern=r"^https?://[^\s]+$",
        ),
    ] = None
    keywords: list[ShortText] = Field(default_factory=list, max_length=32)
    fees: Annotated[
        str | None, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)
    ] = None
    access_constraints: list[ShortText] = Field(default_factory=list, max_length=16)
    contact: ServiceContactRequest = Field(default_factory=ServiceContactRequest)
    enabled_protocols: list[Protocol] = Field(min_length=1, max_length=8)
    change_message: ChangeMessage = None

    @field_validator("keywords", "access_constraints", "enabled_protocols", mode="after")
    @classmethod
    def unique_values(cls, value: list[Any]) -> list[Any]:
        if len(value) != len(set(value)):
            raise ValueError("catalog metadata arrays must not contain duplicates")
        return value


class CreateStoreRequest(RequestModel):
    slug: Slug
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    description: Description = None
    kind: Literal["managed_project", "external_source", "postgresql_connection"]
    dataset_id: UUID | None = None
    external_connection_id: UUID | None = None
    sealed_source_revision_number: int | None = Field(default=None, ge=1)
    sealed_connection_revision_number: int | None = Field(default=None, ge=1)
    configuration: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_binding(self) -> "CreateStoreRequest":
        shape = (
            (
                self.kind == "managed_project"
                and self.dataset_id is None
                and self.external_connection_id is None
                and self.sealed_source_revision_number is None
                and self.sealed_connection_revision_number is None
            )
            or (
                self.kind == "external_source"
                and self.dataset_id is not None
                and self.external_connection_id is None
                and self.sealed_source_revision_number is not None
                and self.sealed_connection_revision_number is None
            )
            or (
                self.kind == "postgresql_connection"
                and self.dataset_id is None
                and self.external_connection_id is not None
                and self.sealed_source_revision_number is None
                and self.sealed_connection_revision_number is not None
            )
        )
        if not shape:
            raise ValueError("catalog store binding does not match its kind")
        _bounded_json(self.configuration, 8192, "catalog store configuration")
        return self


class PutLayerGroupRequest(RequestModel):
    expected_version: int = Field(ge=0)
    title: Title
    description: Description = None
    mode: Literal["single", "opaque_container", "named", "container", "earth_observation"]
    member_collection_ids: list[UUID] = Field(min_length=1, max_length=64)
    change_message: ChangeMessage = None

    @field_validator("member_collection_ids", mode="after")
    @classmethod
    def unique_members(cls, value: list[UUID]) -> list[UUID]:
        if len(value) != len(set(value)):
            raise ValueError("layer group members must be unique")
        return value


class AssignCollectionStyleRequest(RequestModel):
    style_name: Slug
    style_id: UUID
    expected_style_version: int = Field(ge=1)
    render_profile_id: UUID
    expected_profile_version: int = Field(ge=1)
    is_default: bool = False


class BulkUpdateMetadataOperation(RequestModel):
    operation: Literal["update_metadata"]
    metadata: UpdateServiceMetadataRequest


class BulkCreateStoreOperation(RequestModel):
    operation: Literal["create_store"]
    store: CreateStoreRequest


class BulkDisableStoreOperation(RequestModel):
    operation: Literal["disable_store"]
    store_id: UUID


class BulkPutLayerGroupOperation(RequestModel):
    operation: Literal["put_layer_group"]
    slug: Slug
    layer_group: PutLayerGroupRequest


class BulkDisableLayerGroupOperation(RequestModel):
    operation: Literal["disable_layer_group"]
    group_id: UUID


class BulkAssignStyleOperation(RequestModel):
    operation: Literal["assign_style"]
    collection_id: UUID
    style: AssignCollectionStyleRequest


class BulkWithdrawStyleOperation(RequestModel):
    operation: Literal["withdraw_style"]
    binding_id: UUID


BulkOperation = Annotated[
    BulkUpdateMetadataOperation
    | BulkCreateStoreOperation
    | BulkDisableStoreOperation
    | BulkPutLayerGroupOperation
    | BulkDisableLayerGroupOperation
    | BulkAssignStyleOperation
    | BulkWithdrawStyleOperation,
    Field(discriminator="operation"),
]


class ApplySpatialCatalogBulkRequest(RequestModel):
    operations: list[BulkOperation] = Field(min_length=1, max_length=64)

    @model_validator(mode="after")
    def bounded_request(self) -> "ApplySpatialCatalogBulkRequest":
        _bounded_json(
            self.model_dump(mode="json"),
            CATALOG_LIMITS["bulkRequestBytes"],
            "catalog bulk request",
        )
        return self


class SpatialServiceMetadataResponse(BaseModel):
    version_id: UUID
    service_id: UUID
    version_number: int
    title: str
    abstract: str | None
    namespace_uri: str | None
    keywords: list[str]
    fees: str | None
    access_constraints: list[str]
    contact: dict[str, Any]
    enabled_protocols: list[str]
    change_message: str | None
    created_by: UUID
    created_at: datetime


class SpatialServiceStoreResponse(BaseModel):
    id: UUID
    project_id: UUID
    service_id: UUID
    slug: str
    title: str
    description: str | None
    kind: str
    dataset_id: UUID | None
    external_connection_id: UUID | None
    sealed_source_revision_number: int | None
    sealed_connection_revision_number: int | None
    configuration: dict[str, Any]
    created_by: UUID
    created_at: datetime
    disabled_by: UUID | None
    disabled_at: datetime | None


class SpatialServiceLayerGroupResponse(BaseModel):
    id: UUID
    project_id: UUID
    service_id: UUID
    slug: str
    version_id: UUID
    version_number: int
    title: str
    description: str | None
    mode: str
    member_collection_ids: list[UUID]
    change_message: str | None
    created_by: UUID
    created_at: datetime
    updated_by: UUID
    updated_at: datetime
    disabled_by: UUID | None
    disabled_at: datetime | None


class SpatialServiceCollectionStyleResponse(BaseModel):
    id: UUID
    project_id: UUID
    service_id: UUID
    collection_id: UUID
    style_name: str
    style_id: UUID
    sealed_style_version_id: UUID
    sealed_style_version_number: int
    current_style_version_id: UUID
    current_style_version_number: int
    render_profile_id: UUID | None
    sealed_profile_version_id: UUID | None
    sealed_profile_version_number: int | None
    current_profile_version_id: UUID | None
    current_profile_version_number: int | None
    consumable: bool
    stale: bool
    is_default: bool
    created_by: UUID
    created_at: datetime
    withdrawn_by: UUID | None
    withdrawn_at: datetime | None


class SpatialCatalogResponse(BaseModel):
    metadata: SpatialServiceMetadataResponse
    stores: list[SpatialServiceStoreResponse]
    layer_groups: list[SpatialServiceLayerGroupResponse]
    styles: list[SpatialServiceCollectionStyleResponse]
    limits: dict[str, int]
    semantics: dict[str, str]


class SpatialCatalogBulkResponse(BaseModel):
    applied_operations: int
    operation_results: list[dict[str, Any]]
    catalog: SpatialCatalogResponse


def repository_from_request(request: Request) -> SpatialCatalogRepository:
    return cast(SpatialCatalogRepository, request.app.state.spatial_catalog_repository)


@router.get(
    "/projects/{project_id}/spatial-services/{service_id}/catalog",
    response_model=SpatialCatalogResponse,
)
async def get_spatial_catalog(
    project_id: UUID,
    service_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialCatalogRepository, Depends(repository_from_request)],
) -> SpatialCatalogResponse:
    record = await execute_service(
        repository.get_catalog(tenant_context(session), project_id, service_id)
    )
    return _catalog_response(record)


@router.put(
    "/projects/{project_id}/spatial-services/{service_id}/catalog/metadata",
    response_model=SpatialServiceMetadataResponse,
)
async def update_spatial_catalog_metadata(
    project_id: UUID,
    service_id: UUID,
    payload: UpdateServiceMetadataRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialCatalogRepository, Depends(repository_from_request)],
) -> SpatialServiceMetadataResponse:
    record = await execute_service(
        repository.update_metadata(
            tenant_context(session),
            project_id,
            service_id,
            _metadata_draft(payload),
            get_request_id(),
        )
    )
    return _metadata_response(record)


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/catalog/stores",
    response_model=SpatialServiceStoreResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_spatial_catalog_store(
    project_id: UUID,
    service_id: UUID,
    payload: CreateStoreRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialCatalogRepository, Depends(repository_from_request)],
) -> SpatialServiceStoreResponse:
    record = await execute_service(
        repository.create_store(
            tenant_context(session), project_id, service_id, _store_draft(payload), get_request_id()
        )
    )
    return _store_response(record)


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/catalog/stores/{store_id}/disable",
    response_model=SpatialServiceStoreResponse,
)
async def disable_spatial_catalog_store(
    project_id: UUID,
    service_id: UUID,
    store_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialCatalogRepository, Depends(repository_from_request)],
) -> SpatialServiceStoreResponse:
    record = await execute_service(
        repository.disable_store(
            tenant_context(session), project_id, service_id, store_id, get_request_id()
        )
    )
    return _store_response(record)


@router.put(
    "/projects/{project_id}/spatial-services/{service_id}/catalog/layer-groups/{slug}",
    response_model=SpatialServiceLayerGroupResponse,
)
async def put_spatial_catalog_layer_group(
    project_id: UUID,
    service_id: UUID,
    slug: Slug,
    payload: PutLayerGroupRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialCatalogRepository, Depends(repository_from_request)],
) -> SpatialServiceLayerGroupResponse:
    record = await execute_service(
        repository.put_layer_group(
            tenant_context(session),
            project_id,
            service_id,
            _group_draft(slug, payload),
            get_request_id(),
        )
    )
    return _group_response(record)


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/catalog/layer-groups/{group_id}/disable",
    response_model=SpatialServiceLayerGroupResponse,
)
async def disable_spatial_catalog_layer_group(
    project_id: UUID,
    service_id: UUID,
    group_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialCatalogRepository, Depends(repository_from_request)],
) -> SpatialServiceLayerGroupResponse:
    record = await execute_service(
        repository.disable_layer_group(
            tenant_context(session), project_id, service_id, group_id, get_request_id()
        )
    )
    return _group_response(record)


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/catalog/collections/{collection_id}/styles",
    response_model=SpatialServiceCollectionStyleResponse,
    status_code=status.HTTP_201_CREATED,
)
async def assign_spatial_catalog_style(
    project_id: UUID,
    service_id: UUID,
    collection_id: UUID,
    payload: AssignCollectionStyleRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialCatalogRepository, Depends(repository_from_request)],
) -> SpatialServiceCollectionStyleResponse:
    record = await execute_service(
        repository.assign_style(
            tenant_context(session),
            project_id,
            service_id,
            _style_draft(collection_id, payload),
            get_request_id(),
        )
    )
    return _style_response(record)


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/catalog/styles/{binding_id}/withdraw",
    response_model=SpatialServiceCollectionStyleResponse,
)
async def withdraw_spatial_catalog_style(
    project_id: UUID,
    service_id: UUID,
    binding_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialCatalogRepository, Depends(repository_from_request)],
) -> SpatialServiceCollectionStyleResponse:
    record = await execute_service(
        repository.withdraw_style(
            tenant_context(session), project_id, service_id, binding_id, get_request_id()
        )
    )
    return _style_response(record)


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/catalog/bulk",
    response_model=SpatialCatalogBulkResponse,
)
async def apply_spatial_catalog_bulk(
    project_id: UUID,
    service_id: UUID,
    payload: ApplySpatialCatalogBulkRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialCatalogRepository, Depends(repository_from_request)],
) -> SpatialCatalogBulkResponse:
    result = await execute_service(
        repository.apply_bulk(
            tenant_context(session),
            project_id,
            service_id,
            tuple(_operation(item) for item in payload.operations),
            get_request_id(),
        )
    )
    return _bulk_response(result)


def _metadata_draft(payload: UpdateServiceMetadataRequest) -> MetadataDraft:
    return MetadataDraft(
        expected_version=payload.expected_version,
        title=payload.title,
        abstract=payload.abstract,
        namespace_uri=payload.namespace_uri,
        keywords=tuple(payload.keywords),
        fees=payload.fees,
        access_constraints=tuple(payload.access_constraints),
        contact=payload.contact.model_dump(exclude_none=True),
        enabled_protocols=tuple(payload.enabled_protocols),
        change_message=payload.change_message,
    )


def _store_draft(payload: CreateStoreRequest) -> StoreDraft:
    return StoreDraft(
        slug=payload.slug,
        title=payload.title,
        description=payload.description,
        kind=payload.kind,
        dataset_id=payload.dataset_id,
        external_connection_id=payload.external_connection_id,
        sealed_source_revision_number=payload.sealed_source_revision_number,
        sealed_connection_revision_number=payload.sealed_connection_revision_number,
        configuration=payload.configuration,
    )


def _group_draft(slug: str, payload: PutLayerGroupRequest) -> LayerGroupDraft:
    return LayerGroupDraft(
        slug=slug,
        expected_version=payload.expected_version,
        title=payload.title,
        description=payload.description,
        mode=payload.mode,
        member_collection_ids=tuple(payload.member_collection_ids),
        change_message=payload.change_message,
    )


def _style_draft(collection_id: UUID, payload: AssignCollectionStyleRequest) -> StyleDraft:
    return StyleDraft(
        collection_id=collection_id,
        style_name=payload.style_name,
        style_id=payload.style_id,
        expected_style_version=payload.expected_style_version,
        render_profile_id=payload.render_profile_id,
        expected_profile_version=payload.expected_profile_version,
        is_default=payload.is_default,
    )


def _operation(payload: BulkOperation) -> CatalogOperation:
    if isinstance(payload, BulkUpdateMetadataOperation):
        return UpdateMetadataOperation("update_metadata", _metadata_draft(payload.metadata))
    if isinstance(payload, BulkCreateStoreOperation):
        return CreateStoreOperation("create_store", _store_draft(payload.store))
    if isinstance(payload, BulkDisableStoreOperation):
        return DisableStoreOperation("disable_store", payload.store_id)
    if isinstance(payload, BulkPutLayerGroupOperation):
        return PutLayerGroupOperation(
            "put_layer_group", _group_draft(payload.slug, payload.layer_group)
        )
    if isinstance(payload, BulkDisableLayerGroupOperation):
        return DisableLayerGroupOperation("disable_layer_group", payload.group_id)
    if isinstance(payload, BulkAssignStyleOperation):
        return AssignStyleOperation(
            "assign_style", _style_draft(payload.collection_id, payload.style)
        )
    return WithdrawStyleOperation("withdraw_style", payload.binding_id)


def _catalog_response(record: SpatialCatalogSnapshot) -> SpatialCatalogResponse:
    return SpatialCatalogResponse(
        metadata=_metadata_response(record.metadata),
        stores=[_store_response(item) for item in record.stores],
        layer_groups=[_group_response(item) for item in record.layer_groups],
        styles=[_style_response(item) for item in record.styles],
        limits=dict(CATALOG_LIMITS),
        semantics={
            "namespace": "one project-scoped service identifier",
            "layerOrder": "the first layer-group member draws on top",
            "styleHistory": "style assignments seal exact governed style revisions",
            "bulk": "all operations commit together or none commit",
        },
    )


def _metadata_response(record: SpatialServiceMetadata) -> SpatialServiceMetadataResponse:
    return SpatialServiceMetadataResponse(
        version_id=record.version_id,
        service_id=record.service_id,
        version_number=record.version_number,
        title=record.title,
        abstract=record.abstract,
        namespace_uri=record.namespace_uri,
        keywords=list(record.keywords),
        fees=record.fees,
        access_constraints=list(record.access_constraints),
        contact=record.contact,
        enabled_protocols=list(record.enabled_protocols),
        change_message=record.change_message,
        created_by=record.created_by,
        created_at=record.created_at,
    )


def _store_response(record: SpatialServiceStore) -> SpatialServiceStoreResponse:
    return SpatialServiceStoreResponse(
        id=record.store_id,
        project_id=record.project_id,
        service_id=record.service_id,
        slug=record.slug,
        title=record.title,
        description=record.description,
        kind=record.kind,
        dataset_id=record.dataset_id,
        external_connection_id=record.external_connection_id,
        sealed_source_revision_number=record.sealed_source_revision_number,
        sealed_connection_revision_number=record.sealed_connection_revision_number,
        configuration=record.configuration,
        created_by=record.created_by,
        created_at=record.created_at,
        disabled_by=record.disabled_by,
        disabled_at=record.disabled_at,
    )


def _group_response(record: SpatialServiceLayerGroup) -> SpatialServiceLayerGroupResponse:
    return SpatialServiceLayerGroupResponse(
        id=record.group_id,
        project_id=record.project_id,
        service_id=record.service_id,
        slug=record.slug,
        version_id=record.version_id,
        version_number=record.version_number,
        title=record.title,
        description=record.description,
        mode=record.mode,
        member_collection_ids=list(record.member_collection_ids),
        change_message=record.change_message,
        created_by=record.created_by,
        created_at=record.created_at,
        updated_by=record.updated_by,
        updated_at=record.updated_at,
        disabled_by=record.disabled_by,
        disabled_at=record.disabled_at,
    )


def _style_response(
    record: SpatialServiceCollectionStyle,
) -> SpatialServiceCollectionStyleResponse:
    return SpatialServiceCollectionStyleResponse(
        id=record.binding_id,
        project_id=record.project_id,
        service_id=record.service_id,
        collection_id=record.collection_id,
        style_name=record.style_name,
        style_id=record.style_id,
        sealed_style_version_id=record.sealed_style_version_id,
        sealed_style_version_number=record.sealed_style_version_number,
        current_style_version_id=record.current_style_version_id,
        current_style_version_number=record.current_style_version_number,
        render_profile_id=record.render_profile_id,
        sealed_profile_version_id=record.sealed_profile_version_id,
        sealed_profile_version_number=record.sealed_profile_version_number,
        current_profile_version_id=record.current_profile_version_id,
        current_profile_version_number=record.current_profile_version_number,
        consumable=record.consumable,
        stale=record.stale,
        is_default=record.is_default,
        created_by=record.created_by,
        created_at=record.created_at,
        withdrawn_by=record.withdrawn_by,
        withdrawn_at=record.withdrawn_at,
    )


def _bulk_response(record: SpatialCatalogBulkResult) -> SpatialCatalogBulkResponse:
    return SpatialCatalogBulkResponse(
        applied_operations=record.applied_operations,
        operation_results=list(record.operation_results),
        catalog=_catalog_response(record.snapshot),
    )


def _bounded_json(value: Any, maximum_bytes: int, label: str) -> None:
    try:
        encoded = json.dumps(
            value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} is not JSON serializable") from error
    if len(encoded) > maximum_bytes:
        raise ValueError(f"{label} exceeds its byte limit")


__all__ = ["PostgresSpatialCatalogRepository", "router"]
