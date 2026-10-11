from datetime import UTC, datetime
from typing import Annotated, Any, cast
from urllib.parse import urlencode
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.ogc_records import (
    OGC_CATALOG_PROFILE,
    OGC_OPENAPI_MEDIA_TYPE,
    OGC_RECORD_PROFILE,
    OGC_RECORDS_STANDARD,
    catalog_document,
    export_ogc_record,
    project_records_base,
    record_collection,
    records_api_document,
)
from opengeo_api.resource_routes import execute_resource, repository_from_request, tenant_context
from opengeo_api.resources import RecordFilters, ResourceKind, ResourceRepository

router = APIRouter(tags=["OGC API Records"])
KINDS: tuple[ResourceKind, ...] = (
    "dataset",
    "map",
    "document",
    "story",
    "dashboard",
    "service",
)
RECORD_ITEMS_QUERY_PARAMETERS = frozenset(
    {
        "bbox",
        "datetime",
        "limit",
        "offset",
        "q",
        "type",
        "ids",
        "externalIds",
        "language",
    }
)


@router.get("/projects/{project_id}/records")
async def records_landing(
    project_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    await _authorize_catalog(repository, session, project_id)
    # OGC discovery links are absolute so native GIS clients can follow them
    # without having to implement URI-reference resolution themselves.
    base = str(request.url_for("records_landing", project_id=project_id)).rstrip("/")
    return {
        "title": "OpenGeo governed resource records",
        "description": "Authenticated, project-scoped metadata records from immutable resources.",
        "links": [
            {"href": base, "rel": "self", "type": "application/json"},
            {
                "href": f"{base}/api",
                "rel": "service-desc",
                "type": OGC_OPENAPI_MEDIA_TYPE,
                "title": "OpenAPI definition for this project records API",
            },
            {
                "href": f"{base}/conformance",
                "rel": "conformance",
                "type": "application/json",
            },
            {
                "href": f"{base}/collections",
                "rel": "data",
                "type": "application/json",
            },
        ],
    }


@router.get("/projects/{project_id}/records/api")
async def records_api_description(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> JSONResponse:
    await _authorize_catalog(repository, session, project_id)
    return JSONResponse(records_api_document(project_id), media_type=OGC_OPENAPI_MEDIA_TYPE)


@router.get("/projects/{project_id}/records/conformance")
async def records_conformance(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    await _authorize_catalog(repository, session, project_id)
    return {
        "conformsTo": [],
        "opengeoStatus": {
            "standard": OGC_RECORDS_STANDARD,
            "implemented": [
                "record-core projection",
                "record collection paths",
                "GeoJSON encoding",
                "bbox, datetime, limit, q, type, ids, externalIds filters",
                "language query negotiation",
            ],
            "claim": "No OGC conformance is claimed until official schema and ETS evidence pass.",
        },
    }


@router.get("/projects/{project_id}/records/collections")
async def record_catalogs(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    await _authorize_catalog(repository, session, project_id)
    base = project_records_base(project_id)
    return {
        "collections": [catalog_document(project_id)],
        "links": [{"href": f"{base}/collections", "rel": "self", "type": "application/json"}],
    }


@router.get("/projects/{project_id}/records/collections/{collection_id}")
async def record_catalog(
    project_id: UUID,
    collection_id: str,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> JSONResponse:
    _require_collection(collection_id)
    await _authorize_catalog(repository, session, project_id)
    return JSONResponse(
        catalog_document(project_id),
        media_type="application/ogc-catalog+json",
        headers={"Link": f'<{OGC_CATALOG_PROFILE}>; rel="profile"'},
    )


@router.get("/projects/{project_id}/records/collections/{collection_id}/items")
async def record_items(
    project_id: UUID,
    collection_id: str,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
    bbox: str | None = None,
    datetime_value: Annotated[str | None, Query(alias="datetime")] = None,
    limit: str | None = None,
    offset: str | None = None,
    q: str | None = None,
    resource_type: Annotated[str | None, Query(alias="type")] = None,
    ids: str | None = None,
    external_ids: Annotated[str | None, Query(alias="externalIds")] = None,
    language: str | None = None,
) -> JSONResponse:
    _require_collection(collection_id)
    _validate_query(request, RECORD_ITEMS_QUERY_PARAMETERS)
    parsed_limit = _parse_bounded_integer(limit, "limit", default=10, minimum=1, maximum=20)
    parsed_offset = _parse_bounded_integer(offset, "offset", default=0, minimum=0)
    temporal_start, temporal_end = _parse_datetime(datetime_value)
    kinds = _parse_kinds(resource_type)
    record_ids = _parse_ids(ids)
    external = _parse_csv(external_ids, 50, 500, "externalIds", 4000)
    requested_language = _parse_language(language)
    page = await execute_resource(
        repository.list_record_resources(
            tenant_context(session),
            project_id,
            RecordFilters(
                query=_search_expression(q),
                kinds=kinds,
                ids=record_ids,
                external_ids=external,
                bbox=_parse_bbox(bbox),
                temporal_start=temporal_start,
                temporal_end=temporal_end,
                limit=parsed_limit,
                offset=parsed_offset,
            ),
        )
    )
    next_href = (
        _page_href(request, parsed_offset + parsed_limit)
        if parsed_offset + len(page.resources) < page.number_matched
        else None
    )
    previous_href = (
        _page_href(request, max(0, parsed_offset - parsed_limit)) if parsed_offset > 0 else None
    )
    document = record_collection(
        page.resources,
        project_id,
        requested_language,
        page.number_matched,
        str(request.url),
        next_href,
        previous_href,
    )
    return JSONResponse(
        document,
        media_type="application/geo+json",
        headers={"Link": f'<{OGC_RECORD_PROFILE}>; rel="profile"'},
    )


@router.get("/projects/{project_id}/records/collections/{collection_id}/items/{resource_id}")
async def record_item(
    project_id: UUID,
    collection_id: str,
    resource_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
    language: str | None = None,
) -> JSONResponse:
    _require_collection(collection_id)
    _validate_query(request, frozenset({"language"}))
    resource = await execute_resource(
        repository.get_resource(tenant_context(session), project_id, resource_id)
    )
    export = export_ogc_record(resource, project_id, _parse_language(language))
    selected = cast(str, export["report"]["selectedLanguage"])
    return JSONResponse(
        export["document"],
        media_type="application/geo+json",
        headers={
            "Content-Language": selected,
            "Link": f'<{OGC_RECORD_PROFILE}>; rel="profile"',
        },
    )


async def _authorize_catalog(
    repository: ResourceRepository, session: AuthSession, project_id: UUID
) -> None:
    await execute_resource(
        repository.list_record_resources(
            tenant_context(session), project_id, RecordFilters(limit=1)
        )
    )


def _require_collection(collection_id: str) -> None:
    if collection_id != "resources":
        raise HTTPException(status_code=404, detail="record_collection_not_found")


def _parse_csv(
    value: str | None,
    maximum: int,
    item_length: int,
    name: str,
    total_length: int | None = None,
) -> tuple[str, ...]:
    if value is None:
        return ()
    items = tuple(item.strip() for item in value.split(","))
    if (
        (total_length is not None and len(value) > total_length)
        or not items
        or len(items) > maximum
        or any(not item or len(item) > item_length for item in items)
    ):
        raise HTTPException(status_code=400, detail=f"invalid_{name}")
    return items


def _parse_kinds(value: str | None) -> tuple[ResourceKind, ...]:
    items = _parse_csv(value, len(KINDS), 20, "type", 200)
    if any(item not in KINDS for item in items):
        raise HTTPException(status_code=400, detail="invalid_type")
    return cast(tuple[ResourceKind, ...], items)


def _parse_ids(value: str | None) -> tuple[UUID, ...]:
    items = _parse_csv(value, 50, 36, "ids", 2000)
    try:
        return tuple(UUID(item) for item in items)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="invalid_ids") from error


def _parse_bbox(value: str | None) -> tuple[float, float, float, float] | None:
    if value is None:
        return None
    if len(value) > 200:
        raise HTTPException(status_code=400, detail="invalid_bbox")
    try:
        coordinates = tuple(float(item.strip()) for item in value.split(","))
    except ValueError as error:
        raise HTTPException(status_code=400, detail="invalid_bbox") from error
    if len(coordinates) not in {4, 6}:
        raise HTTPException(status_code=400, detail="invalid_bbox")
    if len(coordinates) == 6:
        min_x, min_y, min_z, max_x, max_y, max_z = coordinates
        if not (-1_000_000_000 <= min_z <= max_z <= 1_000_000_000):
            raise HTTPException(status_code=400, detail="invalid_bbox")
    else:
        min_x, min_y, max_x, max_y = coordinates
    if not (-180 <= min_x <= max_x <= 180 and -90 <= min_y <= max_y <= 90):
        raise HTTPException(status_code=400, detail="invalid_bbox")
    return min_x, min_y, max_x, max_y


def _parse_datetime(value: str | None) -> tuple[datetime | None, datetime | None]:
    if value is None:
        return None, None
    if len(value) > 100:
        raise HTTPException(status_code=400, detail="invalid_datetime")
    parts = value.split("/")
    if len(parts) > 2:
        raise HTTPException(status_code=400, detail="invalid_datetime")
    start = _parse_instant(parts[0])
    end = _parse_instant(parts[-1])
    if len(parts) == 1:
        end = start
    if start is not None and end is not None and start > end:
        raise HTTPException(status_code=400, detail="invalid_datetime")
    return start, end


def _parse_instant(value: str) -> datetime | None:
    if value == "..":
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise HTTPException(status_code=400, detail="invalid_datetime") from error
    if len(value) == 10:
        return parsed.replace(tzinfo=UTC)
    if parsed.tzinfo is None:
        raise HTTPException(status_code=400, detail="invalid_datetime")
    return parsed.astimezone(UTC)


def _search_expression(value: str | None) -> str | None:
    terms = _parse_csv(value, 10, 100, "q", 1000)
    if not terms:
        return None
    safe = [" ".join(term.replace('"', " ").split()) for term in terms]
    if any(not term for term in safe):
        raise HTTPException(status_code=400, detail="invalid_q")
    return " OR ".join(f'"{term}"' for term in safe)


def _parse_language(value: str | None) -> str | None:
    if value is None:
        return None
    if len(value) > 40:
        raise HTTPException(status_code=400, detail="invalid_language")
    normalized = value.strip().lower()
    parts = normalized.split("-")
    if (
        not 2 <= len(parts[0]) <= 3
        or not parts[0].isalpha()
        or any(not 2 <= len(part) <= 8 or not part.isalnum() for part in parts[1:])
    ):
        raise HTTPException(status_code=400, detail="invalid_language")
    return normalized


def _parse_bounded_integer(
    value: str | None,
    name: str,
    *,
    default: int,
    minimum: int,
    maximum: int | None = None,
) -> int:
    try:
        parsed = default if value is None else int(value)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=f"invalid_{name}") from error
    if parsed < minimum or (maximum is not None and parsed > maximum):
        raise HTTPException(status_code=400, detail=f"invalid_{name}")
    return parsed


def _validate_query(request: Request, allowed: frozenset[str]) -> None:
    names = [name for name, _ in request.query_params.multi_items()]
    if any(name not in allowed for name in names) or len(names) != len(set(names)):
        raise HTTPException(status_code=400, detail="invalid_query_parameter")


def _page_href(request: Request, offset: int) -> str:
    query = dict(request.query_params)
    query["offset"] = str(offset)
    return f"{request.url.path}?{urlencode(query)}"
