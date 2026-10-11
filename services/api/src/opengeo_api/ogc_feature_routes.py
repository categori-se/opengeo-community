import math
from typing import Annotated, Any, TypedDict
from urllib.parse import urlencode
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.cql2_features import scalar_queryables
from opengeo_api.feature_routes import execute_feature, repository_from_request
from opengeo_api.features import FeatureCollection, FeatureRepository
from opengeo_api.ogc_features import (
    FEATURE_COLLECTION_ID,
    OGC_CRS84,
    OGC_FEATURES_STANDARD,
    OGC_OPENAPI_MEDIA_TYPE,
    collection_document,
    feature_document,
    feature_page_document,
    features_api_document,
)
from opengeo_api.resource_routes import tenant_context

router = APIRouter(tags=["OGC API Features compatibility"])
ITEM_QUERY_PARAMETERS = frozenset(
    {"bbox", "limit", "offset", "expected_generation", "filter", "filter-lang"}
)


class _FilterOptions(TypedDict, total=False):
    cql2_filter: tuple[str, str]


@router.get("/projects/{project_id}/datasets/{dataset_id}/ogc/features")
async def features_landing(
    project_id: UUID,
    dataset_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    await _collection(repository, session, project_id, dataset_id)
    base = str(
        request.url_for("features_landing", project_id=project_id, dataset_id=dataset_id)
    ).rstrip("/")
    return {
        "title": "OpenGeo governed dataset features",
        "description": "Authenticated read-only GeoJSON from one authoritative collection.",
        "links": [
            {"href": base, "rel": "self", "type": "application/json"},
            {"href": f"{base}/api", "rel": "service-desc", "type": OGC_OPENAPI_MEDIA_TYPE},
            {"href": f"{base}/conformance", "rel": "conformance", "type": "application/json"},
            {"href": f"{base}/collections", "rel": "data", "type": "application/json"},
        ],
    }


@router.get("/projects/{project_id}/datasets/{dataset_id}/ogc/features/api")
async def features_api_description(
    project_id: UUID,
    dataset_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> JSONResponse:
    await _collection(repository, session, project_id, dataset_id)
    return JSONResponse(
        features_api_document(project_id, dataset_id), media_type=OGC_OPENAPI_MEDIA_TYPE
    )


@router.get("/projects/{project_id}/datasets/{dataset_id}/ogc/features/conformance")
async def features_conformance(
    project_id: UUID,
    dataset_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    await _collection(repository, session, project_id, dataset_id)
    return {
        "conformsTo": [],
        "opengeoStatus": {
            "standard": OGC_FEATURES_STANDARD,
            "readOnly": True,
            "implemented": [
                "landing page",
                "OpenAPI description",
                "single collection discovery",
                "GeoJSON feature collection and item reads",
                "bbox and bounded paging",
                "stable feature ids and OpenGeo versions",
            ],
            "claim": "No OGC conformance is claimed until official schema and ETS evidence pass.",
        },
    }


@router.get("/projects/{project_id}/datasets/{dataset_id}/ogc/features/collections")
async def feature_collections(
    project_id: UUID,
    dataset_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    collection = await _collection(repository, session, project_id, dataset_id)
    base = _base(request, project_id, dataset_id)
    return {
        "collections": [collection_document(collection, base)],
        "links": [{"href": f"{base}/collections", "rel": "self", "type": "application/json"}],
    }


@router.get("/projects/{project_id}/datasets/{dataset_id}/ogc/features/collections/{collection_id}")
async def feature_collection(
    project_id: UUID,
    dataset_id: UUID,
    collection_id: str,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    _require_collection(collection_id)
    collection = await _collection(repository, session, project_id, dataset_id)
    return collection_document(collection, _base(request, project_id, dataset_id))


@router.get(
    "/projects/{project_id}/datasets/{dataset_id}/ogc/features/collections/{collection_id}/queryables"
)
async def feature_queryables(
    project_id: UUID,
    dataset_id: UUID,
    collection_id: str,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
    expected_generation: Annotated[int | None, Query(ge=1)] = None,
) -> JSONResponse:
    _require_collection(collection_id)
    _validate_query(request, {"expected_generation"})
    page = await execute_feature(
        repository.list_features(
            tenant_context(session),
            project_id,
            dataset_id,
            bbox=None,
            limit=1,
            offset=0,
            expected_generation=expected_generation,
        )
    )
    document = scalar_queryables(
        {field.name: field.type for field in page.collection.fields}, str(request.url), spatial=True
    )
    document["opengeo:generation"] = page.collection.generation
    return JSONResponse(
        document,
        media_type="application/schema+json",
        headers={"Cache-Control": "private, no-store"},
    )


@router.get(
    "/projects/{project_id}/datasets/{dataset_id}/ogc/features/collections/{collection_id}/items"
)
async def feature_items(
    project_id: UUID,
    dataset_id: UUID,
    collection_id: str,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
    bbox: str | None = None,
    limit: str | None = None,
    offset: str | None = None,
    expected_generation: Annotated[int | None, Query(ge=1)] = None,
) -> JSONResponse:
    _require_collection(collection_id)
    _validate_query(request)
    expression = request.query_params.get("filter")
    language = request.query_params.get("filter-lang", "cql2-text")
    if (
        (expression is None and "filter-lang" in request.query_params)
        or (expression is not None and (not expression or len(expression.encode()) > 10_000))
        or language not in {"cql2-text", "cql2-json"}
    ):
        raise HTTPException(status_code=400, detail="invalid_cql2_filter_parameters")
    filter_options: _FilterOptions = (
        {"cql2_filter": (expression, language)} if expression is not None else {}
    )
    parsed_limit = _parse_integer(limit, "limit", default=10, minimum=1, maximum=100)
    parsed_offset = _parse_integer(offset, "offset", default=0, minimum=0)
    page = await execute_feature(
        repository.list_features(
            tenant_context(session),
            project_id,
            dataset_id,
            bbox=_parse_bbox(bbox),
            limit=parsed_limit,
            offset=parsed_offset,
            expected_generation=expected_generation,
            **filter_options,
        )
    )
    base = _base(request, project_id, dataset_id)
    next_href = (
        _page_href(request, parsed_offset + parsed_limit)
        if parsed_offset + len(page.features) < page.number_matched
        else None
    )
    previous_href = (
        _page_href(request, max(0, parsed_offset - parsed_limit)) if parsed_offset else None
    )
    return JSONResponse(
        feature_page_document(page, base, str(request.url), next_href, previous_href),
        media_type="application/geo+json",
        headers={"Content-Crs": f"<{OGC_CRS84}>"},
    )


@router.get(
    "/projects/{project_id}/datasets/{dataset_id}/ogc/features/collections/{collection_id}/items/{feature_id}"
)
async def feature_item(
    project_id: UUID,
    dataset_id: UUID,
    collection_id: str,
    feature_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
    expected_generation: Annotated[int | None, Query(ge=1)] = None,
) -> JSONResponse:
    _require_collection(collection_id)
    _validate_query(request, {"expected_generation"})
    feature = await execute_feature(
        repository.get_feature(
            tenant_context(session),
            project_id,
            dataset_id,
            feature_id,
            expected_generation=expected_generation,
        )
    )
    return JSONResponse(
        feature_document(feature, _base(request, project_id, dataset_id)),
        media_type="application/geo+json",
        headers={"Content-Crs": f"<{OGC_CRS84}>"},
    )


async def _collection(
    repository: FeatureRepository,
    session: AuthSession,
    project_id: UUID,
    dataset_id: UUID,
) -> FeatureCollection:
    page = await execute_feature(
        repository.list_features(
            tenant_context(session), project_id, dataset_id, bbox=None, limit=1, offset=0
        )
    )
    return page.collection


def _base(request: Request, project_id: UUID, dataset_id: UUID) -> str:
    return str(
        request.url_for("features_landing", project_id=project_id, dataset_id=dataset_id)
    ).rstrip("/")


def _require_collection(collection_id: str) -> None:
    if collection_id != FEATURE_COLLECTION_ID:
        raise HTTPException(status_code=404, detail="feature_collection_not_found")


def _validate_query(
    request: Request, allowed: frozenset[str] | set[str] = ITEM_QUERY_PARAMETERS
) -> None:
    if len(request.query_params.multi_items()) != len(request.query_params):
        raise HTTPException(status_code=400, detail="duplicate_query_parameter")
    unknown = set(request.query_params) - allowed
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"unsupported_query_parameter_{sorted(unknown)[0]}",
        )


def _parse_integer(
    value: str | None,
    name: str,
    *,
    default: int,
    minimum: int,
    maximum: int | None = None,
) -> int:
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=f"invalid_{name}") from error
    if str(parsed) != value or parsed < minimum or (maximum is not None and parsed > maximum):
        raise HTTPException(status_code=400, detail=f"invalid_{name}")
    return parsed


def _parse_bbox(value: str | None) -> tuple[float, float, float, float] | None:
    if value is None:
        return None
    try:
        parts = tuple(float(part) for part in value.split(","))
    except ValueError as error:
        raise HTTPException(status_code=400, detail="invalid_bbox") from error
    if len(parts) not in {4, 6} or any(not math.isfinite(part) for part in parts):
        raise HTTPException(status_code=400, detail="invalid_bbox")
    if len(parts) == 4:
        minimum_x, minimum_y, maximum_x, maximum_y = parts
    else:
        minimum_x, minimum_y, minimum_z, maximum_x, maximum_y, maximum_z = parts
        if minimum_z >= maximum_z:
            raise HTTPException(status_code=400, detail="invalid_bbox")
    if not -180 <= minimum_x < maximum_x <= 180 or not -90 <= minimum_y < maximum_y <= 90:
        raise HTTPException(status_code=400, detail="invalid_bbox")
    return minimum_x, minimum_y, maximum_x, maximum_y


def _page_href(request: Request, offset: int) -> str:
    parameters = list(request.query_params.multi_items())
    parameters = [(name, value) for name, value in parameters if name != "offset"]
    parameters.append(("offset", str(offset)))
    # Native OAPIF clients may consume pagination links without resolving them
    # against the response URL. Match the absolute self/discovery link contract.
    return str(request.url.replace(query=urlencode(parameters)))
