import json
import math
from collections.abc import Awaitable
from datetime import datetime
from typing import Annotated, Any, Literal, cast
from urllib.parse import urlencode
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, RedirectResponse, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from opengeo_api.arcgis_compat import (
    ARCGIS_CRS84_WKID,
    ARCGIS_MAX_FEATURES,
    ARCGIS_MAX_QUERY_BYTES,
    ARCGIS_WEB_MERCATOR_WKIDS,
    ArcgisCompatibilityError,
    feature_ids_document,
    feature_page_document,
    parse_envelope,
    parse_object_ids,
    parse_spatial_reference,
    parse_wkid,
    validate_callback,
)
from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.coverages import (
    CoverageAccessDenied,
    CoverageConflict,
    CoverageNotFound,
    CoverageRepository,
    CoverageStoreUnavailable,
    SpatialCoverage,
)
from opengeo_api.feature_routes import (
    execute_feature,
)
from opengeo_api.feature_routes import (
    repository_from_request as feature_repository_from_request,
)
from opengeo_api.features import (
    FeatureAccessDenied,
    FeatureConflict,
    FeatureInvalid,
    FeatureNotFound,
    FeatureRepository,
    FeatureStoreUnavailable,
)
from opengeo_api.logging import get_request_id
from opengeo_api.ogc_feature_routes import feature_item, feature_items
from opengeo_api.ogc_features import FEATURE_COLLECTION_ID, OGC_CRS84
from opengeo_api.resource_routes import tenant_context
from opengeo_api.sos import (
    SOS_MAX_OBSERVATIONS,
    SOS_PROCEDURE_DESCRIPTION_FORMAT,
    SOS_RESPONSE_FORMAT,
    SOS_VERSION,
    SosProfile,
    SosProfileError,
    describe_sensor_document,
    observation_document,
    observation_profile,
)
from opengeo_api.sos import (
    capabilities_document as sos_capabilities_document,
)
from opengeo_api.sos import (
    exception_report as sos_exception_report,
)
from opengeo_api.spatial_services import (
    SpatialService,
    SpatialServiceAccessDenied,
    SpatialServiceCollection,
    SpatialServiceConflict,
    SpatialServiceNotFound,
    SpatialServiceRepository,
    SpatialServiceStoreUnavailable,
)

router = APIRouter(tags=["administered spatial services"])
OGC_OPENAPI_MEDIA_TYPE = "application/vnd.oai.openapi+json;version=3.0"
EPSG3857 = "http://www.opengis.net/def/crs/EPSG/0/3857"
WEB_MERCATOR_QUAD = "WebMercatorQuad"
WEB_MERCATOR_QUAD_URI = "http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad"
WEB_MERCATOR_LIMIT = 20_037_508.342789244
MAX_TILE_MATRIX = 22

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
ServiceTitle = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)
]
Description = Annotated[
    str | None, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)
]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateSpatialServiceRequest(RequestModel):
    slug: Slug
    title: ServiceTitle
    description: Description = None


class CreateSpatialServiceCollectionRequest(RequestModel):
    collection_name: Slug
    dataset_id: UUID
    resource_id: UUID
    default_profile_id: UUID
    expected_feature_generation: int = Field(ge=1)
    expected_profile_version: int = Field(ge=1)
    title: Title
    description: Description = None


class SpatialServiceResponse(BaseModel):
    id: UUID
    project_id: UUID
    slug: str
    title: str
    description: str | None
    created_by: UUID
    created_at: datetime
    disabled_by: UUID | None
    disabled_at: datetime | None


class SpatialServiceCollectionResponse(BaseModel):
    id: UUID
    project_id: UUID
    service_id: UUID
    collection_name: str
    dataset_id: UUID
    resource_id: UUID
    default_profile_id: UUID
    sealed_feature_generation: int
    sealed_profile_version_id: UUID
    sealed_profile_version_number: int
    current_feature_generation: int
    current_profile_version_id: UUID
    current_profile_version_number: int
    stale: bool
    target_active: bool
    title: str
    description: str | None
    created_by: UUID
    created_at: datetime
    withdrawn_by: UUID | None
    withdrawn_at: datetime | None


def repository_from_request(request: Request) -> SpatialServiceRepository:
    return cast(SpatialServiceRepository, request.app.state.spatial_service_repository)


def coverage_repository_from_request(request: Request) -> CoverageRepository:
    return cast(CoverageRepository, request.app.state.coverage_repository)


async def execute_service[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except SpatialServiceAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except SpatialServiceNotFound as error:
        raise HTTPException(status_code=404, detail=f"{error.resource}_not_found") from error
    except SpatialServiceConflict as error:
        raise HTTPException(status_code=409, detail={"code": error.code}) from error
    except SpatialServiceStoreUnavailable as error:
        raise HTTPException(status_code=503, detail="spatial_service_store_unavailable") from error


async def execute_coverage[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except CoverageAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except CoverageNotFound as error:
        raise HTTPException(status_code=404, detail=f"{error.resource}_not_found") from error
    except CoverageConflict as error:
        raise HTTPException(status_code=409, detail={"code": error.code}) from error
    except CoverageStoreUnavailable as error:
        raise HTTPException(status_code=503, detail="coverage_store_unavailable") from error


@router.get(
    "/projects/{project_id}/spatial-services",
    response_model=list[SpatialServiceResponse],
)
async def list_spatial_services(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
) -> list[SpatialServiceResponse]:
    records = await execute_service(repository.list_services(tenant_context(session), project_id))
    return [_service_response(record) for record in records]


@router.post(
    "/projects/{project_id}/spatial-services",
    response_model=SpatialServiceResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_spatial_service(
    project_id: UUID,
    payload: CreateSpatialServiceRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
) -> SpatialServiceResponse:
    record = await execute_service(
        repository.create_service(
            tenant_context(session),
            project_id,
            payload.slug,
            payload.title,
            payload.description,
            get_request_id(),
        )
    )
    return _service_response(record)


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/disable",
    response_model=SpatialServiceResponse,
)
async def disable_spatial_service(
    project_id: UUID,
    service_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
) -> SpatialServiceResponse:
    record = await execute_service(
        repository.disable_service(
            tenant_context(session), project_id, service_id, get_request_id()
        )
    )
    return _service_response(record)


@router.get(
    "/projects/{project_id}/spatial-services/{service_id}/collections",
    response_model=list[SpatialServiceCollectionResponse],
)
async def list_spatial_service_collections(
    project_id: UUID,
    service_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
    include_withdrawn: bool = False,
) -> list[SpatialServiceCollectionResponse]:
    records = await execute_service(
        repository.list_collections(
            tenant_context(session),
            project_id,
            service_id,
            include_withdrawn=include_withdrawn,
        )
    )
    return [_collection_response(record) for record in records]


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/collections",
    response_model=SpatialServiceCollectionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_spatial_service_collection(
    project_id: UUID,
    service_id: UUID,
    payload: CreateSpatialServiceCollectionRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
) -> SpatialServiceCollectionResponse:
    record = await execute_service(
        repository.create_collection(
            tenant_context(session),
            project_id,
            service_id,
            payload.collection_name,
            payload.dataset_id,
            payload.resource_id,
            payload.default_profile_id,
            payload.expected_feature_generation,
            payload.expected_profile_version,
            payload.title,
            payload.description,
            get_request_id(),
        )
    )
    return _collection_response(record)


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/collections/{binding_id}/withdraw",
    response_model=SpatialServiceCollectionResponse,
)
async def withdraw_spatial_service_collection(
    project_id: UUID,
    service_id: UUID,
    binding_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
) -> SpatialServiceCollectionResponse:
    record = await execute_service(
        repository.withdraw_collection(
            tenant_context(session),
            project_id,
            service_id,
            binding_id,
            get_request_id(),
        )
    )
    return _collection_response(record)


@router.get("/projects/{project_id}/services/{service_slug}/ogc")
async def spatial_service_landing(
    project_id: UUID,
    service_slug: Slug,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
) -> JSONResponse:
    service = await execute_service(
        repository.get_active_service(tenant_context(session), project_id, service_slug)
    )
    base = _base(request, project_id, service_slug)
    return _json(
        {
            "title": service.title,
            "description": service.description
            or "Authenticated administered feature, map, tile, and coverage compatibility service.",
            "links": [
                {"href": base, "rel": "self", "type": "application/json"},
                {
                    "href": f"{base}/api",
                    "rel": "service-desc",
                    "type": OGC_OPENAPI_MEDIA_TYPE,
                },
                {
                    "href": f"{base}/conformance",
                    "rel": "conformance",
                    "type": "application/json",
                },
                {"href": f"{base}/collections", "rel": "data", "type": "application/json"},
                {
                    "href": (
                        f"{base[:-4]}/wmts?SERVICE=WMTS&REQUEST=GetCapabilities&VERSION=1.0.0"
                    ),
                    "rel": "service",
                    "type": "application/xml",
                    "title": "Authenticated seeded-cache-only WMTS 1.0 compatibility",
                },
                {
                    "href": (f"{base[:-4]}/wcs?SERVICE=WCS&REQUEST=GetCapabilities&VERSION=2.0.1"),
                    "rel": "service",
                    "type": "application/xml",
                    "title": "Authenticated exact-COG WCS 2.0.1 compatibility",
                },
            ],
        }
    )


@router.get("/projects/{project_id}/services/{service_slug}/ogc/api")
async def spatial_service_api(
    project_id: UUID,
    service_slug: Slug,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
) -> JSONResponse:
    await execute_service(
        repository.get_active_service(tenant_context(session), project_id, service_slug)
    )
    return JSONResponse(
        service_api_document(project_id, service_slug),
        media_type=OGC_OPENAPI_MEDIA_TYPE,
        headers=_private_headers(),
    )


@router.get("/projects/{project_id}/services/{service_slug}/ogc/conformance")
async def spatial_service_conformance(
    project_id: UUID,
    service_slug: Slug,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
) -> JSONResponse:
    await execute_service(
        repository.get_active_service(tenant_context(session), project_id, service_slug)
    )
    return _json(
        {
            "conformsTo": [],
            "opengeoStatus": {
                "implemented": [
                    "administered immutable collection bindings",
                    "shared-auth landing, OpenAPI, and collection discovery",
                    "authoritative direct CRS84 GeoJSON feature reads",
                    "exact-profile CRS84 and EPSG:3857 map aliases",
                    "WebMercatorQuad 256-pixel PNG tile aliases",
                    "bounded GeoMoose-compatible conventional XYZ and ArcGIS REST read aliases",
                    "durable seeded-cache-only WMTS 1.0 KVP compatibility",
                    "draft OGC API Coverages-shaped immutable COG discovery and exact retrieval",
                    "feature-generation and render-profile stale-seal rejection",
                ],
                "claim": (
                    "No OGC API Features, Maps, Tiles, Coverages, or WMTS conformance is claimed; "
                    "OGC API Coverages remains a candidate draft and applicable executable suites "
                    "plus deployed independent clients have not passed."
                ),
            },
        }
    )


@router.get("/projects/{project_id}/services/{service_slug}/ogc/collections")
async def spatial_service_collections(
    project_id: UUID,
    service_slug: Slug,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
    coverage_repository: Annotated[CoverageRepository, Depends(coverage_repository_from_request)],
) -> JSONResponse:
    context = tenant_context(session)
    service = await execute_service(
        repository.get_active_service(context, project_id, service_slug)
    )
    records = await execute_service(
        repository.list_collections(
            context, project_id, service.service_id, include_withdrawn=False
        )
    )
    coverages = await execute_coverage(
        coverage_repository.list_coverages(
            context, project_id, service.service_id, include_withdrawn=False
        )
    )
    base = _base(request, project_id, service_slug)
    documents = [
        *(_collection_document(record, base) for record in records),
        *(_coverage_collection_document(record, base) for record in coverages),
    ]
    documents.sort(key=lambda item: cast(str, item["id"]))
    return _json(
        {
            "collections": documents,
            "links": [{"href": f"{base}/collections", "rel": "self", "type": "application/json"}],
        }
    )


@router.get("/projects/{project_id}/services/{service_slug}/ogc/collections/{collection_name}")
async def spatial_service_collection(
    project_id: UUID,
    service_slug: Slug,
    collection_name: Slug,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
    coverage_repository: Annotated[CoverageRepository, Depends(coverage_repository_from_request)],
) -> JSONResponse:
    try:
        record = await repository.resolve_collection(
            tenant_context(session), project_id, service_slug, collection_name
        )
    except SpatialServiceNotFound as error:
        if error.resource != "spatial_service_collection":
            raise HTTPException(status_code=404, detail=f"{error.resource}_not_found") from error
        coverage = await execute_coverage(
            coverage_repository.resolve_coverage(
                tenant_context(session), project_id, service_slug, collection_name
            )
        )
        return _json(
            _coverage_collection_document(coverage, _base(request, project_id, service_slug))
        )
    return _json(_collection_document(record, _base(request, project_id, service_slug)))


@router.get(
    "/projects/{project_id}/services/{service_slug}/ogc/collections/{collection_name}/items"
)
async def spatial_service_items(
    project_id: UUID,
    service_slug: Slug,
    collection_name: Slug,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
    feature_repository: Annotated[FeatureRepository, Depends(feature_repository_from_request)],
    bbox: Annotated[str | None, Query(min_length=7, max_length=200)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 10,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> JSONResponse:
    _known_query(request, {"bbox", "limit", "offset", "filter", "filter-lang"})
    record = await _resolve(
        repository, session, project_id, service_slug, collection_name, require_fresh=True
    )
    response = await feature_items(
        project_id=project_id,
        dataset_id=record.dataset_id,
        collection_id=FEATURE_COLLECTION_ID,
        request=request,
        session=session,
        repository=feature_repository,
        bbox=bbox,
        limit=str(limit),
        offset=str(offset),
        expected_generation=record.sealed_feature_generation,
    )
    response.headers.update(_private_headers())
    return response


@router.get(
    "/projects/{project_id}/services/{service_slug}/ogc/collections/{collection_name}/queryables"
)
async def spatial_service_queryables(
    project_id: UUID,
    service_slug: Slug,
    collection_name: Slug,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
    feature_repository: Annotated[FeatureRepository, Depends(feature_repository_from_request)],
) -> JSONResponse:
    from opengeo_api.ogc_feature_routes import feature_queryables

    _known_query(request, set())
    record = await _resolve(
        repository, session, project_id, service_slug, collection_name, require_fresh=True
    )
    return await feature_queryables(
        project_id,
        record.dataset_id,
        FEATURE_COLLECTION_ID,
        request,
        session,
        feature_repository,
        record.sealed_feature_generation,
    )


@router.get(
    "/projects/{project_id}/services/{service_slug}/ogc/collections/"
    "{collection_name}/items/{feature_id}"
)
async def spatial_service_item(
    project_id: UUID,
    service_slug: Slug,
    collection_name: Slug,
    feature_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
    feature_repository: Annotated[FeatureRepository, Depends(feature_repository_from_request)],
) -> JSONResponse:
    _known_query(request, set())
    record = await _resolve(
        repository, session, project_id, service_slug, collection_name, require_fresh=True
    )
    response = await feature_item(
        project_id=project_id,
        dataset_id=record.dataset_id,
        collection_id=FEATURE_COLLECTION_ID,
        feature_id=feature_id,
        request=request,
        session=session,
        repository=feature_repository,
        expected_generation=record.sealed_feature_generation,
    )
    response.headers.update(_private_headers())
    return response


@router.get(
    "/projects/{project_id}/services/{service_slug}/sos/{collection_name}",
    name="spatial_service_sos",
)
async def spatial_service_sos(
    project_id: UUID,
    service_slug: Slug,
    collection_name: Slug,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
    feature_repository: Annotated[FeatureRepository, Depends(feature_repository_from_request)],
) -> Response:
    """Expose one sealed feature collection as one bounded SOS 2.0 offering."""

    try:
        parameters = _sos_parameters(request)
        _sos_require_service(parameters)
        operation = _sos_required(parameters, "request").casefold()
        record = await _resolve(
            repository,
            session,
            project_id,
            service_slug,
            collection_name,
            require_fresh=True,
        )
        page = await feature_repository.list_features(
            tenant_context(session),
            project_id,
            record.dataset_id,
            bbox=None,
            limit=1 if operation != "getobservation" else SOS_MAX_OBSERVATIONS,
            offset=0,
            expected_generation=record.sealed_feature_generation,
        )
        endpoint = str(
            request.url_for(
                "spatial_service_sos",
                project_id=project_id,
                service_slug=service_slug,
                collection_name=collection_name,
            )
        )
        profile = observation_profile(
            page.collection,
            endpoint=endpoint,
            collection_name=record.collection_name,
            title=record.title,
            description=record.description,
        )
        if operation == "getcapabilities":
            _sos_capabilities_parameters(parameters)
            return _sos_xml(sos_capabilities_document(profile))
        _sos_require_version(parameters)
        if operation == "describesensor":
            _sos_describe_parameters(parameters, profile)
            return _sos_xml(describe_sensor_document(profile))
        if operation == "getobservation":
            _sos_observation_parameters(parameters, profile)
            return _sos_xml(observation_document(profile, page))
        raise SosProfileError("request must be GetCapabilities, DescribeSensor, or GetObservation")
    except SosProfileError as error:
        return _sos_error("InvalidParameterValue", "request", str(error))
    except FeatureAccessDenied:
        return _sos_error("OperationProcessingFailed", "authorization", "action is forbidden", 403)
    except FeatureNotFound as error:
        return _sos_error(
            "InvalidParameterValue", error.resource, "feature resource was not found", 404
        )
    except FeatureConflict as error:
        return _sos_error("OperationProcessingFailed", "generation", error.code, 409)
    except FeatureInvalid as error:
        return _sos_error("InvalidParameterValue", "feature", str(error), 422)
    except FeatureStoreUnavailable:
        return _sos_error("NoApplicableCode", "store", "feature store is unavailable", 503)


@router.get(
    "/projects/{project_id}/services/{service_slug}/arcgis/rest/services/"
    "{collection_name}/FeatureServer/0/query/"
)
async def spatial_service_arcgis_feature_query(
    project_id: UUID,
    service_slug: Slug,
    collection_name: Slug,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
    feature_repository: Annotated[FeatureRepository, Depends(feature_repository_from_request)],
) -> Response:
    """Serve the exact bounded two-stage query used by GeoMoose 3.15.2."""
    parameters = _strict_query(
        request,
        {
            "f",
            "returnGeometry",
            "spatialRel",
            "geometry",
            "spatialReference",
            "geometryType",
            "inSR",
            "outSR",
            "outFields",
            "returnIdsOnly",
            "objectIds",
            "callback",
            "_",
        },
        maximum_bytes=ARCGIS_MAX_QUERY_BYTES,
    )
    try:
        if parameters.get("f", "json").casefold() not in {"json", "pjson"}:
            raise ArcgisCompatibilityError("arcgis_format_unsupported")
        if parameters.get("returnGeometry", "true").casefold() != "true":
            raise ArcgisCompatibilityError("arcgis_return_geometry_required")
        if parameters.get("spatialRel") != "esriSpatialRelIntersects":
            raise ArcgisCompatibilityError("arcgis_spatial_relation_unsupported")
        if parameters.get("geometryType") != "esriGeometryEnvelope":
            raise ArcgisCompatibilityError("arcgis_geometry_type_unsupported")
        if parameters.get("outFields") != "*":
            raise ArcgisCompatibilityError("arcgis_out_fields_unsupported")
        in_wkid = parse_wkid(
            _required(parameters, "inSR"),
            field="in_sr",
            allowed=ARCGIS_WEB_MERCATOR_WKIDS | {ARCGIS_CRS84_WKID},
        )
        out_wkid = parse_wkid(
            _required(parameters, "outSR"),
            field="out_sr",
            allowed=ARCGIS_WEB_MERCATOR_WKIDS | {ARCGIS_CRS84_WKID},
        )
        parse_spatial_reference(_required(parameters, "spatialReference"), expected_wkid=in_wkid)
        bbox = parse_envelope(_required(parameters, "geometry"), in_wkid=in_wkid)
        return_ids_only = _boolean(_required(parameters, "returnIdsOnly"), "return_ids_only")
        object_ids = parse_object_ids(parameters.get("objectIds"))
        if return_ids_only and object_ids is not None:
            raise ArcgisCompatibilityError("arcgis_ids_query_cannot_select_object_ids")
        if not return_ids_only and object_ids is None:
            raise ArcgisCompatibilityError("arcgis_object_ids_required")
        callback = validate_callback(parameters.get("callback"))
        cache_buster = parameters.get("_")
        if cache_buster is not None and (not cache_buster.isdigit() or len(cache_buster) > 20):
            raise ArcgisCompatibilityError("arcgis_cache_buster_invalid")
    except ArcgisCompatibilityError as error:
        raise HTTPException(status_code=400, detail={"code": error.code}) from error

    record = await _resolve(
        repository, session, project_id, service_slug, collection_name, require_fresh=True
    )
    page = await execute_feature(
        feature_repository.list_features(
            tenant_context(session),
            project_id,
            record.dataset_id,
            bbox=bbox,
            limit=ARCGIS_MAX_FEATURES,
            offset=0,
            expected_generation=record.sealed_feature_generation,
        )
    )
    try:
        document = (
            feature_ids_document(page)
            if return_ids_only
            else feature_page_document(
                page,
                out_wkid=out_wkid,
                object_ids=cast(tuple[int, ...], object_ids),
            )
        )
    except ArcgisCompatibilityError as error:
        raise HTTPException(status_code=409, detail={"code": error.code}) from error
    return _arcgis_response(document, callback=callback)


@router.get(
    "/projects/{project_id}/services/{service_slug}/arcgis/rest/services/"
    "{collection_name}/MapServer/export"
)
async def spatial_service_arcgis_map_export(
    project_id: UUID,
    service_slug: Slug,
    collection_name: Slug,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
) -> RedirectResponse:
    """Translate the exact OpenLayers TileArcGISRest image request to one governed render."""
    parameters = _strict_query(
        request,
        {
            "F",
            "FORMAT",
            "TRANSPARENT",
            "SIZE",
            "BBOX",
            "BBOXSR",
            "IMAGESR",
            "DPI",
            "LAYERS",
        },
        maximum_bytes=2_048,
    )
    try:
        if parameters.get("F", "image").casefold() != "image":
            raise ArcgisCompatibilityError("arcgis_map_format_unsupported")
        if parameters.get("FORMAT", "PNG32").casefold() not in {"png", "png8", "png24", "png32"}:
            raise ArcgisCompatibilityError("arcgis_map_image_format_unsupported")
        if parameters.get("TRANSPARENT", "true").casefold() != "true":
            raise ArcgisCompatibilityError("arcgis_map_transparency_required")
        width, height = _integer_pair(_required(parameters, "SIZE"), "size", 1, 2_048)
        if width * height > 4_194_304:
            raise ArcgisCompatibilityError("arcgis_map_pixel_budget_exceeded")
        bbox = _float_quad(_required(parameters, "BBOX"), "bbox")
        if any(not -WEB_MERCATOR_LIMIT <= value <= WEB_MERCATOR_LIMIT for value in bbox):
            raise ArcgisCompatibilityError("arcgis_map_bbox_outside_world")
        bbox_sr = parse_wkid(
            _required(parameters, "BBOXSR"),
            field="bbox_sr",
            allowed=ARCGIS_WEB_MERCATOR_WKIDS,
        )
        image_sr = parse_wkid(
            _required(parameters, "IMAGESR"),
            field="image_sr",
            allowed=ARCGIS_WEB_MERCATOR_WKIDS,
        )
        if bbox_sr != image_sr:
            raise ArcgisCompatibilityError("arcgis_map_spatial_reference_mismatch")
        _integer(parameters.get("DPI", "90"), "dpi", 1, 384)
        if parameters.get("LAYERS") not in {None, "show:0"}:
            raise ArcgisCompatibilityError("arcgis_map_layers_unsupported")
    except ArcgisCompatibilityError as error:
        raise HTTPException(status_code=400, detail={"code": error.code}) from error

    record = await _resolve(
        repository, session, project_id, service_slug, collection_name, require_fresh=True
    )
    return _redirect(
        _map_target(
            record,
            {
                "bbox": ",".join(format(value, ".15g") for value in bbox),
                "width": width,
                "height": height,
                "crs": EPSG3857,
                "f": "png",
                "transparent": "true",
            },
        )
    )


@router.get("/projects/{project_id}/services/{service_slug}/xyz/{collection_name}/{z}/{x}/{y}.png")
async def spatial_service_xyz_tile(
    project_id: UUID,
    service_slug: Slug,
    collection_name: Slug,
    z: int,
    x: int,
    y: int,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
) -> RedirectResponse:
    """Expose one conventional z/x/y alias for exact browser XYZ clients."""
    _known_query(request, set())
    bbox = web_mercator_tile_bbox(z, y, x)
    record = await _resolve(
        repository, session, project_id, service_slug, collection_name, require_fresh=True
    )
    return _redirect(
        _map_target(
            record,
            {
                "bbox": ",".join(format(value, ".15g") for value in bbox),
                "width": 256,
                "height": 256,
                "crs": EPSG3857,
                "f": "png",
                "transparent": "true",
            },
        )
    )


@router.get("/projects/{project_id}/services/{service_slug}/ogc/collections/{collection_name}/map")
async def spatial_service_map(
    project_id: UUID,
    service_slug: Slug,
    collection_name: Slug,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
    bbox: Annotated[str, Query(min_length=7, max_length=200)],
    width: Annotated[int, Query(ge=1, le=2048)] = 640,
    height: Annotated[int, Query(ge=1, le=2048)] = 480,
    crs: Literal[
        "http://www.opengis.net/def/crs/OGC/1.3/CRS84",
        "http://www.opengis.net/def/crs/EPSG/0/3857",
    ] = "http://www.opengis.net/def/crs/OGC/1.3/CRS84",
    output_format: Annotated[Literal["svg", "png"], Query(alias="f")] = "svg",
    background_color: Annotated[str | None, Query(pattern=r"^#[0-9a-fA-F]{6}$")] = None,
    transparent: bool = False,
) -> RedirectResponse:
    _known_query(
        request,
        {"bbox", "width", "height", "crs", "f", "background_color", "transparent"},
    )
    if width * height > 4_194_304:
        raise HTTPException(status_code=422, detail="map_pixel_budget_exceeded")
    record = await _resolve(
        repository, session, project_id, service_slug, collection_name, require_fresh=True
    )
    values: dict[str, str | int] = {
        "bbox": bbox,
        "width": width,
        "height": height,
        "crs": crs,
        "f": output_format,
        "transparent": str(transparent).lower(),
    }
    if background_color is not None:
        values["background_color"] = background_color.lower()
    return _redirect(_map_target(record, values))


@router.get(
    "/projects/{project_id}/services/{service_slug}/ogc/collections/{collection_name}/tiles"
)
async def spatial_service_tilesets(
    project_id: UUID,
    service_slug: Slug,
    collection_name: Slug,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
) -> JSONResponse:
    _known_query(request, set())
    record = await _resolve(
        repository, session, project_id, service_slug, collection_name, require_fresh=False
    )
    base = _base(request, project_id, service_slug)
    href = f"{base}/collections/{record.collection_name}/tiles/{WEB_MERCATOR_QUAD}"
    return _json(
        {
            "tilesets": [
                {
                    "title": f"{record.title} Web Mercator tiles",
                    "dataType": "map",
                    "crs": EPSG3857,
                    "tileMatrixSetURI": WEB_MERCATOR_QUAD_URI,
                    "links": [{"href": href, "rel": "self", "type": "application/json"}],
                    "opengeo:stale": record.stale,
                }
            ],
            "links": [
                {
                    "href": f"{base}/collections/{record.collection_name}/tiles",
                    "rel": "self",
                    "type": "application/json",
                }
            ],
            "opengeo:conformanceClaimed": False,
        }
    )


@router.get(
    "/projects/{project_id}/services/{service_slug}/ogc/collections/{collection_name}/tiles/"
    "{tile_matrix_set_id}"
)
async def spatial_service_tileset(
    project_id: UUID,
    service_slug: Slug,
    collection_name: Slug,
    tile_matrix_set_id: str,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
) -> JSONResponse:
    _known_query(request, set())
    if tile_matrix_set_id != WEB_MERCATOR_QUAD:
        raise HTTPException(status_code=404, detail="tile_matrix_set_not_found")
    record = await _resolve(
        repository, session, project_id, service_slug, collection_name, require_fresh=False
    )
    base = _base(request, project_id, service_slug)
    template = (
        f"{base}/collections/{record.collection_name}/tiles/{WEB_MERCATOR_QUAD}/"
        "{tileMatrix}/{tileRow}/{tileCol}?f=png"
    )
    return _json(
        {
            "title": f"{record.title} Web Mercator tiles",
            "dataType": "map",
            "crs": EPSG3857,
            "tileMatrixSetURI": WEB_MERCATOR_QUAD_URI,
            "links": [
                {
                    "href": template,
                    "rel": "item",
                    "type": "image/png",
                    "templated": True,
                }
            ],
            "opengeo:minimumTileMatrix": 0,
            "opengeo:maximumTileMatrix": MAX_TILE_MATRIX,
            "opengeo:tileSize": 256,
            "opengeo:stale": record.stale,
            "opengeo:conformanceClaimed": False,
        }
    )


@router.get(
    "/projects/{project_id}/services/{service_slug}/ogc/collections/{collection_name}/tiles/"
    "{tile_matrix_set_id}/{tile_matrix}/{tile_row}/{tile_col}"
)
async def spatial_service_tile(
    project_id: UUID,
    service_slug: Slug,
    collection_name: Slug,
    tile_matrix_set_id: str,
    tile_matrix: int,
    tile_row: int,
    tile_col: int,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(repository_from_request)],
    output_format: Annotated[Literal["png"], Query(alias="f")] = "png",
) -> RedirectResponse:
    _known_query(request, {"f"})
    if tile_matrix_set_id != WEB_MERCATOR_QUAD:
        raise HTTPException(status_code=404, detail="tile_matrix_set_not_found")
    bbox = web_mercator_tile_bbox(tile_matrix, tile_row, tile_col)
    record = await _resolve(
        repository, session, project_id, service_slug, collection_name, require_fresh=True
    )
    values: dict[str, str | int] = {
        "bbox": ",".join(format(value, ".15g") for value in bbox),
        "width": 256,
        "height": 256,
        "crs": EPSG3857,
        "f": output_format,
        "transparent": "true",
    }
    return _redirect(_map_target(record, values))


def service_api_document(project_id: UUID, service_slug: str) -> dict[str, Any]:
    base = f"/projects/{project_id}/services/{service_slug}/ogc"
    collection = _path_parameter("collectionId")
    feature = _path_parameter("featureId", format_name="uuid")
    tile_matrix_set = _path_parameter("tileMatrixSetId")
    tile_matrix = _path_parameter("tileMatrix", type_name="integer", minimum=0)
    tile_row = _path_parameter("tileRow", type_name="integer", minimum=0)
    tile_col = _path_parameter("tileCol", type_name="integer", minimum=0)
    bbox = {
        "name": "bbox",
        "in": "query",
        "required": True,
        "style": "form",
        "explode": False,
        "schema": {
            "type": "array",
            "items": {"type": "number"},
            "minItems": 4,
            "maxItems": 4,
        },
    }
    return {
        "openapi": "3.0.3",
        "info": {
            "title": "OpenGeo administered spatial service",
            "version": "0.1.0",
            "description": (
                "Authenticated immutable-seal compatibility pilot for feature, map, "
                "WebMercatorQuad tile, and candidate OGC API Coverages-shaped access. "
                "It makes no OGC conformance claim."
            ),
        },
        "servers": [{"url": base}],
        "security": [{"bearerAuth": []}],
        "paths": {
            "/": {"get": _operation("getSpatialServiceLanding", "application/json")},
            "/api": {"get": _operation("getSpatialServiceApi", OGC_OPENAPI_MEDIA_TYPE)},
            "/conformance": {"get": _operation("getSpatialServiceConformance", "application/json")},
            "/collections": {"get": _operation("getSpatialServiceCollections", "application/json")},
            "/collections/{collectionId}": {
                "get": _operation("getSpatialServiceCollection", "application/json", [collection])
            },
            "/collections/{collectionId}/queryables": {
                "get": _operation(
                    "getSpatialServiceQueryables", "application/schema+json", [collection]
                ),
            },
            "/collections/{collectionId}/items": {
                "get": _operation(
                    "getSpatialServiceItems",
                    "application/geo+json",
                    [
                        collection,
                        {**bbox, "required": False},
                        {
                            "name": "filter",
                            "in": "query",
                            "required": False,
                            "schema": {"type": "string", "maxLength": 10000},
                        },
                        {
                            "name": "filter-lang",
                            "in": "query",
                            "required": False,
                            "schema": {
                                "type": "string",
                                "enum": ["cql2-text", "cql2-json"],
                                "default": "cql2-text",
                            },
                        },
                        _query_parameter("limit", minimum=1, maximum=100, default=10),
                        _query_parameter("offset", minimum=0, maximum=10_000, default=0),
                    ],
                )
            },
            "/collections/{collectionId}/items/{featureId}": {
                "get": _operation(
                    "getSpatialServiceItem",
                    "application/geo+json",
                    [collection, feature],
                )
            },
            "/collections/{collectionId}/coverage": {
                "get": _operation(
                    "getSpatialServiceCoverage",
                    "image/tiff; application=geotiff",
                    [
                        collection,
                        {
                            "name": "derivative",
                            "in": "query",
                            "required": False,
                            "description": (
                                "Existing completed explicit derivative id; "
                                "reads never create work."
                            ),
                            "schema": {"type": "string", "format": "uuid"},
                        },
                    ],
                )
            },
            "/collections/{collectionId}/coverage/domainset": {
                "get": _operation(
                    "getSpatialServiceCoverageDomainSet",
                    "application/json",
                    [collection],
                )
            },
            "/collections/{collectionId}/coverage/rangetype": {
                "get": _operation(
                    "getSpatialServiceCoverageRangeType",
                    "application/json",
                    [collection],
                )
            },
            "/collections/{collectionId}/schema": {
                "get": _operation(
                    "getSpatialServiceCoverageSchema",
                    "application/schema+json",
                    [collection],
                )
            },
            "/collections/{collectionId}/map": {
                "get": _alias_operation(
                    "getSpatialServiceMap",
                    [
                        collection,
                        bbox,
                        _query_parameter("width", minimum=1, maximum=2048, default=640),
                        _query_parameter("height", minimum=1, maximum=2048, default=480),
                        _enum_query_parameter("crs", [OGC_CRS84, EPSG3857], OGC_CRS84),
                        _enum_query_parameter("f", ["svg", "png"], "svg"),
                        {
                            "name": "background_color",
                            "in": "query",
                            "required": False,
                            "schema": {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"},
                        },
                        {
                            "name": "transparent",
                            "in": "query",
                            "required": False,
                            "schema": {"type": "boolean", "default": False},
                        },
                    ],
                )
            },
            "/collections/{collectionId}/tiles": {
                "get": _operation("getSpatialServiceTilesets", "application/json", [collection])
            },
            "/collections/{collectionId}/tiles/{tileMatrixSetId}": {
                "get": _operation(
                    "getSpatialServiceTileset",
                    "application/json",
                    [collection, tile_matrix_set],
                )
            },
            (
                "/collections/{collectionId}/tiles/{tileMatrixSetId}/"
                "{tileMatrix}/{tileRow}/{tileCol}"
            ): {
                "get": _alias_operation(
                    "getSpatialServiceTile",
                    [
                        collection,
                        tile_matrix_set,
                        tile_matrix,
                        tile_row,
                        tile_col,
                        _enum_query_parameter("f", ["png"], "png"),
                    ],
                )
            },
        },
        "components": {
            "securitySchemes": {
                "bearerAuth": {
                    "type": "http",
                    "scheme": "bearer",
                    "bearerFormat": "JWT",
                    "description": "Access token issued by shared auth.categori.se.",
                }
            }
        },
        "x-opengeo-redirect-aliases": True,
        "x-opengeo-immutable-seals": True,
        "x-opengeo-conformance-claimed": False,
    }


def web_mercator_tile_bbox(
    tile_matrix: int, tile_row: int, tile_col: int
) -> tuple[float, float, float, float]:
    if not 0 <= tile_matrix <= MAX_TILE_MATRIX:
        raise HTTPException(status_code=404, detail="tile_matrix_not_found")
    matrix_width = 1 << tile_matrix
    if not 0 <= tile_row < matrix_width or not 0 <= tile_col < matrix_width:
        raise HTTPException(status_code=404, detail="tile_not_found")
    span = (2 * WEB_MERCATOR_LIMIT) / matrix_width
    west = -WEB_MERCATOR_LIMIT + tile_col * span
    east = west + span
    north = WEB_MERCATOR_LIMIT - tile_row * span
    south = north - span
    bbox = (west, south, east, north)
    if any(not math.isfinite(value) for value in bbox):
        raise HTTPException(status_code=404, detail="tile_not_found")
    return bbox


async def _resolve(
    repository: SpatialServiceRepository,
    session: AuthSession,
    project_id: UUID,
    service_slug: str,
    collection_name: str,
    *,
    require_fresh: bool,
) -> SpatialServiceCollection:
    record = await execute_service(
        repository.resolve_collection(
            tenant_context(session), project_id, service_slug, collection_name
        )
    )
    if require_fresh and record.stale:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "spatial_service_collection_stale",
                "sealed_feature_generation": record.sealed_feature_generation,
                "current_feature_generation": record.current_feature_generation,
                "sealed_profile_version": record.sealed_profile_version_number,
                "current_profile_version": record.current_profile_version_number,
                "target_active": record.target_active,
            },
        )
    return record


def _collection_document(record: SpatialServiceCollection, base: str) -> dict[str, Any]:
    root = f"{base}/collections/{record.collection_name}"
    service_root = base.removesuffix("/ogc")
    return {
        "id": record.collection_name,
        "title": record.title,
        "description": record.description,
        "itemType": "feature",
        "crs": [OGC_CRS84],
        "extent": {
            "spatial": {
                "bbox": [[-180.0, -90.0, 180.0, 90.0]],
                "crs": OGC_CRS84,
            }
        },
        "links": [
            {
                "href": f"{root}/queryables",
                "rel": "http://www.opengis.net/def/rel/ogc/1.0/queryables",
                "type": "application/schema+json",
            },
            {"href": root, "rel": "self", "type": "application/json"},
            {
                "href": (
                    f"{service_root.rsplit('/services/', 1)[0]}/records/collections/"
                    f"resources/items/{record.resource_id}"
                ),
                "rel": "describedby",
                "type": "application/geo+json",
                "title": "Governed metadata and recorded terms (requires resource access)",
            },
            {"href": f"{root}/items", "rel": "items", "type": "application/geo+json"},
            {
                "href": f"{root}/map",
                "rel": "https://www.opengis.net/def/rel/ogc/1.0/map",
                "type": "image/svg+xml",
            },
            {
                "href": f"{root}/tiles",
                "rel": "http://www.opengis.net/def/rel/ogc/1.0/tilesets-map",
                "type": "application/json",
            },
            {
                "href": (f"{service_root}/xyz/{record.collection_name}/{{z}}/{{x}}/{{y}}.png"),
                "rel": "item",
                "type": "image/png",
                "title": "Authenticated conventional XYZ alias",
                "templated": True,
            },
            {
                "href": (
                    f"{service_root}/arcgis/rest/services/{record.collection_name}/"
                    "FeatureServer/0/query/"
                ),
                "rel": "alternate",
                "type": "application/json",
                "title": "Authenticated bounded ArcGIS feature-query compatibility",
            },
            {
                "href": (
                    f"{service_root}/arcgis/rest/services/{record.collection_name}/MapServer/export"
                ),
                "rel": "alternate",
                "type": "image/png",
                "title": "Authenticated bounded ArcGIS map-export compatibility",
            },
            {
                "href": f"{service_root}/sos/{record.collection_name}",
                "rel": "alternate",
                "type": "application/xml",
                "title": "Authenticated bounded SOS 2.0 observation profile",
            },
        ],
        "opengeo:bindingId": str(record.binding_id),
        "opengeo:datasetId": str(record.dataset_id),
        "opengeo:resourceId": str(record.resource_id),
        "opengeo:defaultProfileId": str(record.default_profile_id),
        "opengeo:sealedFeatureGeneration": record.sealed_feature_generation,
        "opengeo:currentFeatureGeneration": record.current_feature_generation,
        "opengeo:sealedProfileVersion": record.sealed_profile_version_number,
        "opengeo:currentProfileVersion": record.current_profile_version_number,
        "opengeo:stale": record.stale,
        "opengeo:targetActive": record.target_active,
        "opengeo:conformanceClaimed": False,
    }


def _coverage_collection_document(record: SpatialCoverage, base: str) -> dict[str, Any]:
    root = f"{base}/collections/{record.coverage_name}"
    crs = _coverage_crs_uri(record.crs)
    return {
        "id": record.coverage_name,
        "title": record.title,
        "description": record.description,
        "itemType": "coverage",
        "crs": [crs],
        "storageCRS": crs,
        "extent": {"spatial": {"bbox": [list(record.extent)], "crs": crs}},
        "links": [
            {"href": root, "rel": "self", "type": "application/json"},
            *(
                {
                    "href": (
                        f"{base.removesuffix('/ogc').rsplit('/services/', 1)[0]}"
                        f"/records/collections/resources/items/{resource_id}"
                    ),
                    "rel": "describedby",
                    "type": "application/geo+json",
                    "title": "Current dataset metadata (requires resource access)",
                }
                for resource_id in (record.metadata_resource_id,)
                if resource_id is not None
            ),
            {
                "href": f"{root}/coverage",
                "rel": "http://www.opengis.net/def/rel/ogc/1.0/coverage",
                "type": "image/tiff; application=geotiff",
            },
            {
                "href": f"{root}/coverage/domainset",
                "rel": "http://www.opengis.net/def/rel/ogc/1.0/coverage-domainset",
                "type": "application/json",
            },
            {
                "href": f"{root}/coverage/rangetype",
                "rel": "http://www.opengis.net/def/rel/ogc/1.0/coverage-rangetype",
                "type": "application/json",
            },
            {
                "href": f"{root}/schema",
                "rel": "http://www.opengis.net/def/rel/ogc/1.0/schema",
                "type": "application/schema+json",
            },
        ],
        "opengeo:coverageId": str(record.coverage_id),
        "opengeo:datasetId": str(record.dataset_id),
        "opengeo:datasetVersionId": str(record.dataset_version_id),
        "opengeo:shape": [record.width, record.height],
        "opengeo:bandCount": record.band_count,
        "opengeo:stale": record.stale,
        "opengeo:targetActive": record.target_active,
        "opengeo:derivativesAreExplicit": True,
        "opengeo:conformanceClaimed": False,
    }


def _coverage_crs_uri(crs: str) -> str:
    authority, separator, code = crs.upper().partition(":")
    if separator and authority == "EPSG" and code.isdigit():
        return f"http://www.opengis.net/def/crs/EPSG/0/{code}"
    return crs


def _service_response(record: SpatialService) -> SpatialServiceResponse:
    return SpatialServiceResponse(
        id=record.service_id,
        project_id=record.project_id,
        slug=record.slug,
        title=record.title,
        description=record.description,
        created_by=record.created_by,
        created_at=record.created_at,
        disabled_by=record.disabled_by,
        disabled_at=record.disabled_at,
    )


def _collection_response(
    record: SpatialServiceCollection,
) -> SpatialServiceCollectionResponse:
    return SpatialServiceCollectionResponse(
        id=record.binding_id,
        project_id=record.project_id,
        service_id=record.service_id,
        collection_name=record.collection_name,
        dataset_id=record.dataset_id,
        resource_id=record.resource_id,
        default_profile_id=record.default_profile_id,
        sealed_feature_generation=record.sealed_feature_generation,
        sealed_profile_version_id=record.sealed_profile_version_id,
        sealed_profile_version_number=record.sealed_profile_version_number,
        current_feature_generation=record.current_feature_generation,
        current_profile_version_id=record.current_profile_version_id,
        current_profile_version_number=record.current_profile_version_number,
        stale=record.stale,
        target_active=record.target_active,
        title=record.title,
        description=record.description,
        created_by=record.created_by,
        created_at=record.created_at,
        withdrawn_by=record.withdrawn_by,
        withdrawn_at=record.withdrawn_at,
    )


def _base(request: Request, project_id: UUID, service_slug: str) -> str:
    return str(
        request.url_for("spatial_service_landing", project_id=project_id, service_slug=service_slug)
    ).rstrip("/")


def _map_target(record: SpatialServiceCollection, values: dict[str, str | int]) -> str:
    values = {**values, "expected_profile_version": record.sealed_profile_version_number}
    return (
        f"/projects/{record.project_id}/resources/{record.resource_id}/render-profiles/"
        f"{record.default_profile_id}/map?{urlencode(values)}"
    )


_SOS_QUERY_NAMES = frozenset(
    {
        "service",
        "request",
        "version",
        "acceptversions",
        "procedure",
        "proceduredescriptionformat",
        "offering",
        "observedproperty",
        "responseformat",
    }
)


def _sos_parameters(request: Request) -> dict[str, str]:
    if len(request.url.query.encode("utf8")) > 8_192:
        raise SosProfileError("SOS query exceeds 8192 bytes")
    if len(request.query_params.multi_items()) > len(_SOS_QUERY_NAMES):
        raise SosProfileError("SOS query has too many parameters")
    parameters: dict[str, str] = {}
    for raw_name, value in request.query_params.multi_items():
        name = raw_name.casefold()
        if name not in _SOS_QUERY_NAMES:
            raise SosProfileError(f"unsupported SOS parameter {raw_name[:100]}")
        if name in parameters:
            raise SosProfileError(f"duplicated SOS parameter {raw_name[:100]}")
        if len(raw_name) > 100 or not 1 <= len(value) <= 1_000:
            raise SosProfileError(f"invalid SOS parameter {raw_name[:100]}")
        parameters[name] = value
    return parameters


def _sos_required(parameters: dict[str, str], name: str) -> str:
    value = parameters.get(name)
    if value is None:
        raise SosProfileError(f"{name} is required")
    return value


def _sos_require_service(parameters: dict[str, str]) -> None:
    if _sos_required(parameters, "service").upper() != "SOS":
        raise SosProfileError("service must be SOS")


def _sos_require_version(parameters: dict[str, str]) -> None:
    if _sos_required(parameters, "version") != SOS_VERSION:
        raise SosProfileError(f"version must be {SOS_VERSION}")


def _sos_capabilities_parameters(parameters: dict[str, str]) -> None:
    unsupported = set(parameters) - {"service", "request", "version", "acceptversions"}
    if unsupported:
        raise SosProfileError(f"GetCapabilities does not accept {sorted(unsupported)[0]}")
    version = parameters.get("version")
    if version is not None and version != SOS_VERSION:
        raise SosProfileError(f"version must be {SOS_VERSION}")
    accepted = parameters.get("acceptversions")
    if accepted is not None:
        values = [value.strip() for value in accepted.split(",")]
        if SOS_VERSION not in values or any(not value for value in values):
            raise SosProfileError(f"acceptVersions must include {SOS_VERSION}")


def _sos_describe_parameters(parameters: dict[str, str], profile: SosProfile) -> None:
    unsupported = set(parameters) - {
        "service",
        "request",
        "version",
        "procedure",
        "proceduredescriptionformat",
    }
    if unsupported:
        raise SosProfileError(f"DescribeSensor does not accept {sorted(unsupported)[0]}")
    if _sos_required(parameters, "procedure") != profile.procedure:
        raise SosProfileError("procedure does not identify this offering")
    if _sos_required(parameters, "proceduredescriptionformat") != SOS_PROCEDURE_DESCRIPTION_FORMAT:
        raise SosProfileError(
            f"procedureDescriptionFormat must be {SOS_PROCEDURE_DESCRIPTION_FORMAT}"
        )


def _sos_observation_parameters(parameters: dict[str, str], profile: SosProfile) -> None:
    unsupported = set(parameters) - {
        "service",
        "request",
        "version",
        "procedure",
        "offering",
        "observedproperty",
        "responseformat",
    }
    if unsupported:
        raise SosProfileError(f"GetObservation does not accept {sorted(unsupported)[0]}")
    exact = {
        "procedure": profile.procedure,
        "offering": profile.offering,
        "observedproperty": profile.observed_property,
        "responseformat": SOS_RESPONSE_FORMAT,
    }
    for name, expected in exact.items():
        value = parameters.get(name)
        if value is not None and value != expected:
            raise SosProfileError(f"{name} does not identify this offering")


def _sos_xml(body: bytes, status_code: int = 200) -> Response:
    return Response(
        body,
        status_code=status_code,
        media_type="application/xml",
        headers=_private_headers(),
    )


def _sos_error(code: str, locator: str, message: str, status_code: int = 400) -> Response:
    return _sos_xml(sos_exception_report(code, locator, message), status_code=status_code)


def _known_query(request: Request, allowed: set[str]) -> None:
    unknown = set(request.query_params) - allowed
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"unsupported_query_parameter_{sorted(unknown)[0]}",
        )


def _strict_query(
    request: Request,
    allowed: set[str],
    *,
    maximum_bytes: int,
) -> dict[str, str]:
    if len(request.url.query.encode("utf8")) > maximum_bytes:
        raise HTTPException(status_code=400, detail={"code": "compatibility_query_too_large"})
    parameters: dict[str, str] = {}
    for key, value in request.query_params.multi_items():
        if key not in allowed:
            raise HTTPException(
                status_code=400,
                detail={"code": "compatibility_query_parameter_unsupported", "parameter": key},
            )
        if key in parameters:
            raise HTTPException(
                status_code=400,
                detail={"code": "compatibility_query_parameter_duplicate", "parameter": key},
            )
        parameters[key] = value
    return parameters


def _required(parameters: dict[str, str], name: str) -> str:
    value = parameters.get(name)
    if value is None or not value:
        raise ArcgisCompatibilityError(f"arcgis_{name.lower()}_required")
    return value


def _boolean(value: str, field: str) -> bool:
    normalized = value.casefold()
    if normalized not in {"true", "false"}:
        raise ArcgisCompatibilityError(f"arcgis_{field}_invalid")
    return normalized == "true"


def _integer(value: str, field: str, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise ArcgisCompatibilityError(f"arcgis_map_{field}_invalid") from error
    if not minimum <= parsed <= maximum:
        raise ArcgisCompatibilityError(f"arcgis_map_{field}_invalid")
    return parsed


def _integer_pair(value: str, field: str, minimum: int, maximum: int) -> tuple[int, int]:
    parts = value.split(",")
    if len(parts) != 2:
        raise ArcgisCompatibilityError(f"arcgis_map_{field}_invalid")
    return (
        _integer(parts[0], field, minimum, maximum),
        _integer(parts[1], field, minimum, maximum),
    )


def _float_quad(value: str, field: str) -> tuple[float, float, float, float]:
    parts = value.split(",")
    if len(parts) != 4:
        raise ArcgisCompatibilityError(f"arcgis_map_{field}_invalid")
    try:
        values = tuple(float(item) for item in parts)
    except ValueError as error:
        raise ArcgisCompatibilityError(f"arcgis_map_{field}_invalid") from error
    if any(not math.isfinite(item) for item in values) or not (
        values[0] < values[2] and values[1] < values[3]
    ):
        raise ArcgisCompatibilityError(f"arcgis_map_{field}_invalid")
    return cast(tuple[float, float, float, float], values)


def _arcgis_response(document: dict[str, Any], *, callback: str | None) -> Response:
    if callback is None:
        return JSONResponse(document, headers=_private_headers())
    body = f"{callback}({json.dumps(document, separators=(',', ':'), sort_keys=True)});"
    return Response(
        body,
        media_type="application/javascript",
        headers=_private_headers(),
    )


def _redirect(target: str) -> RedirectResponse:
    return RedirectResponse(
        target,
        status_code=status.HTTP_307_TEMPORARY_REDIRECT,
        headers={
            "Cache-Control": "private, no-store",
            "Referrer-Policy": "no-referrer",
            "Vary": "Authorization, X-OpenGeo-Organization, Accept",
        },
    )


def _json(document: dict[str, Any]) -> JSONResponse:
    return JSONResponse(document, headers=_private_headers())


def _private_headers() -> dict[str, str]:
    return {
        "Cache-Control": "private, no-store",
        "Vary": "Authorization, X-OpenGeo-Organization, Accept",
        "X-Content-Type-Options": "nosniff",
    }


def _operation(
    operation_id: str,
    media_type: str,
    parameters: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    operation: dict[str, Any] = {
        "operationId": operation_id,
        "responses": {
            "200": {
                "description": "Successful response",
                "content": {media_type: {"schema": {"type": "object"}}},
            }
        },
    }
    if parameters:
        operation["parameters"] = parameters
    return operation


def _alias_operation(operation_id: str, parameters: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "operationId": operation_id,
        "parameters": parameters,
        "responses": {
            "307": {
                "description": (
                    "Credential-free temporary alias to the governed native read; clients "
                    "must reapply their authority when following it on the same trusted origin."
                ),
                "headers": {"Location": {"schema": {"type": "string", "format": "uri-reference"}}},
            }
        },
    }


def _path_parameter(
    name: str,
    *,
    type_name: str = "string",
    format_name: str | None = None,
    minimum: int | None = None,
) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": type_name}
    if format_name is not None:
        schema["format"] = format_name
    if minimum is not None:
        schema["minimum"] = minimum
    return {"name": name, "in": "path", "required": True, "schema": schema}


def _query_parameter(name: str, *, minimum: int, maximum: int, default: int) -> dict[str, Any]:
    return {
        "name": name,
        "in": "query",
        "required": False,
        "schema": {
            "type": "integer",
            "minimum": minimum,
            "maximum": maximum,
            "default": default,
        },
    }


def _enum_query_parameter(name: str, values: list[str], default: str) -> dict[str, Any]:
    return {
        "name": name,
        "in": "query",
        "required": False,
        "schema": {"type": "string", "enum": values, "default": default},
    }
