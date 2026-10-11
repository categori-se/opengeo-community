"""Authenticated STAC discovery, versioned Items and current-revision search."""

import json
from typing import Annotated, Any
from urllib.parse import urlencode
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.metadata_profiles import export_stac_1_1
from opengeo_api.record_routes import _parse_bbox, _parse_csv, _parse_datetime, _parse_ids
from opengeo_api.resource_routes import execute_resource, repository_from_request, tenant_context
from opengeo_api.resources import RecordFilters, ResourceRepository
from opengeo_api.stac import StacItemUnavailable, stac_item

router = APIRouter(tags=["STAC"])


@router.get("/projects/{project_id}/stac/collections/{resource_id}")
async def collection(
    project_id: UUID,
    resource_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> JSONResponse:
    if request.query_params:
        raise HTTPException(400, "unsupported_stac_parameter")
    resource = await execute_resource(
        repository.get_resource(tenant_context(session), project_id, resource_id)
    )
    document = export_stac_1_1(resource)["document"]
    if document is None or resource.summary.state == "archived":
        raise HTTPException(404, "stac_collection_not_found")
    href = str(request.url)
    document["links"] = _collection_links(href)
    try:
        item = stac_item(resource, href)
    except StacItemUnavailable:
        document["opengeo:itemAvailability"] = "known instant or closed temporal coverage required"
    else:
        document["links"].append(
            {"rel": "item", "href": item["links"][1]["href"], "type": "application/geo+json"}
        )
    return JSONResponse(document, headers={"Cache-Control": "private, no-store"})


@router.get("/projects/{project_id}/stac/collections/{resource_id}/items/{revision_id}")
async def item(
    project_id: UUID,
    resource_id: UUID,
    revision_id: str,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> JSONResponse:
    if request.query_params:
        raise HTTPException(400, "unsupported_stac_parameter")
    prefix = f"{resource_id}-v"
    version = revision_id.removeprefix(prefix)
    if (
        not revision_id.startswith(prefix)
        or not version.isascii()
        or not version.isdecimal()
        or len(version) > 9
        or version.startswith("0")
    ):
        raise HTTPException(404, "stac_item_not_found")
    resource = await execute_resource(
        repository.get_record_version(
            tenant_context(session), project_id, resource_id, int(version)
        )
    )
    try:
        document = stac_item(resource, str(request.url).rsplit("/items/", 1)[0])
    except StacItemUnavailable as error:
        raise HTTPException(404, "stac_item_temporal_coverage_unknown") from error
    return JSONResponse(
        document, media_type="application/geo+json", headers={"Cache-Control": "private, no-store"}
    )


class SearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    bbox: list[float] | None = Field(default=None, min_length=4, max_length=4)
    intersects: dict[str, Any] | None = None
    datetime: str | None = Field(default=None, max_length=100)
    collections: list[str] | None = Field(default=None, max_length=50)
    ids: list[str] | None = Field(default=None, max_length=50)
    limit: int = Field(default=10, ge=1, le=20)
    offset: int = Field(default=0, ge=0, le=100000)


async def _search(
    project_id: UUID,
    request: Request,
    session: AuthSession,
    repository: ResourceRepository,
    query: SearchRequest,
) -> JSONResponse:
    if query.bbox is not None and query.intersects is not None:
        raise HTTPException(400, "bbox_and_intersects_are_mutually_exclusive")
    collection_ids = (
        _parse_ids(",".join(query.collections)) if query.collections is not None else ()
    )
    identifiers = (
        _parse_csv(",".join(query.ids), 50, 60, "ids", 3050) if query.ids is not None else ()
    )
    for identifier in identifiers:
        try:
            resource_id, revision = identifier.rsplit("-v", 1)
            UUID(resource_id)
            if not revision.isdecimal() or int(revision) < 1:
                raise ValueError
        except ValueError as error:
            raise HTTPException(400, "invalid_stac_item_id") from error
    start, end = _parse_datetime(query.datetime)
    bbox = _parse_bbox(",".join(map(str, query.bbox))) if query.bbox is not None else None
    page = await execute_resource(
        repository.list_record_resources(
            tenant_context(session),
            project_id,
            RecordFilters(
                stac_items=True,
                stac_ids=identifiers,
                ids=collection_ids,
                intersects=query.intersects,
                bbox=bbox,
                temporal_start=start,
                temporal_end=end,
                limit=query.limit,
                offset=query.offset,
            ),
        )
    )
    base = str(request.url).split("/stac", 1)[0] + "/stac"
    items = [
        stac_item(record, f"{base}/collections/{record.summary.resource_id}")
        for record in page.resources
    ]
    links: list[dict[str, Any]] = []
    if query.offset + len(items) < page.number_matched:
        parameters: dict[str, Any] = query.model_dump(exclude_none=True)
        parameters["offset"] = query.offset + query.limit
        for key in ("bbox", "collections", "ids"):
            if key in parameters:
                parameters[key] = ",".join(map(str, parameters[key]))
        if "intersects" in parameters:
            parameters["intersects"] = json.dumps(parameters["intersects"], separators=(",", ":"))
        links.append(
            {
                "rel": "next",
                "href": f"{base}/search?{urlencode(parameters)}",
                "type": "application/geo+json",
                "method": "GET",
            }
        )
    return JSONResponse(
        {
            "type": "FeatureCollection",
            "features": items,
            "links": links,
            "numberMatched": page.number_matched,
            "numberReturned": len(items),
        },
        media_type="application/geo+json",
        headers={"Cache-Control": "private, no-store"},
    )


def _get_query(request: Request) -> SearchRequest:
    from pydantic import ValidationError

    allowed = set(SearchRequest.model_fields)
    if any(
        key not in allowed or len(request.query_params.getlist(key)) != 1
        for key in request.query_params
    ):
        raise HTTPException(400, "unsupported_or_duplicate_stac_parameter")
    values: dict[str, Any] = dict(request.query_params)
    try:
        for key in ("limit", "offset"):
            if key in values:
                values[key] = int(values[key])
        for key in ("ids", "collections"):
            if key in values:
                values[key] = values[key].split(",")
        if "intersects" in values:
            if len(values["intersects"].encode()) > 65536:
                raise ValueError("intersects exceeds geometry byte limit")
            values["intersects"] = json.loads(values["intersects"])
        if "bbox" in values:
            values["bbox"] = list(_parse_bbox(values["bbox"]) or ())
        return SearchRequest.model_validate(values)
    except (ValueError, ValidationError) as error:
        raise HTTPException(400, "invalid_stac_search") from error


@router.get("/projects/{project_id}/stac/search")
async def search_get(
    project_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> JSONResponse:
    return await _search(project_id, request, session, repository, _get_query(request))


@router.post("/projects/{project_id}/stac/search")
async def search_post(
    project_id: UUID,
    request: Request,
    query: SearchRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> JSONResponse:
    if request.query_params:
        raise HTTPException(400, "unsupported_stac_parameter")
    return await _search(project_id, request, session, repository, query)


@router.get("/projects/{project_id}/stac/collections/{resource_id}/items")
async def collection_items(
    project_id: UUID,
    resource_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> JSONResponse:
    query = _get_query(request)
    if query.collections is not None and query.collections != [str(resource_id)]:
        raise HTTPException(400, "collection_filter_conflict")
    query.collections = [str(resource_id)]
    return await _search(project_id, request, session, repository, query)


def _collection_links(href: str) -> list[dict[str, str]]:
    return [
        {"rel": "self", "href": href, "type": "application/json"},
        {"rel": "root", "href": href.split("/collections/")[0], "type": "application/json"},
        {"rel": "items", "href": f"{href}/items", "type": "application/geo+json"},
    ]


@router.get("/projects/{project_id}/stac")
async def landing(
    project_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> JSONResponse:
    if request.query_params:
        raise HTTPException(400, "unsupported_stac_parameter")
    await execute_resource(
        repository.list_record_resources(
            tenant_context(session), project_id, RecordFilters(stac_collections=True, limit=1)
        )
    )
    base = str(request.url).rstrip("/")
    return JSONResponse(
        {
            "type": "Catalog",
            "stac_version": "1.1.0",
            "id": str(project_id),
            "description": "Accessible spatial resources",
            "conformsTo": [],
            "links": [
                {"rel": "self", "href": base, "type": "application/json"},
                {"rel": "root", "href": base, "type": "application/json"},
                {"rel": "data", "href": f"{base}/collections", "type": "application/json"},
                *[
                    {
                        "rel": "search",
                        "href": f"{base}/search",
                        "type": "application/geo+json",
                        "method": method,
                    }
                    for method in ("GET", "POST")
                ],
            ],
        },
        headers={"Cache-Control": "private, no-store"},
    )


@router.get("/projects/{project_id}/stac/collections")
async def collections(
    project_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRepository, Depends(repository_from_request)],
) -> JSONResponse:
    if set(request.query_params) - {"limit", "offset"}:
        raise HTTPException(400, "unsupported_stac_parameter")
    query = _get_query(request)
    page = await execute_resource(
        repository.list_record_resources(
            tenant_context(session),
            project_id,
            RecordFilters(stac_collections=True, limit=query.limit, offset=query.offset),
        )
    )
    base = str(request.url).split("?", 1)[0]
    documents = []
    for record in page.resources:
        document = export_stac_1_1(record)["document"]
        href = f"{base}/{record.summary.resource_id}"
        document["links"] = _collection_links(href)
        documents.append(document)
    links = [{"rel": "self", "href": str(request.url), "type": "application/json"}]
    if query.offset + len(documents) < page.number_matched:
        links.append(
            {
                "rel": "next",
                "type": "application/json",
                "href": f"{base}?limit={query.limit}&offset={query.offset + query.limit}",
            }
        )
    return JSONResponse(
        {"collections": documents, "links": links, "numberMatched": page.number_matched},
        headers={"Cache-Control": "private, no-store"},
    )
