from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode

from opengeo_api.resources import GovernedResource, RecordResource, ResourceSummary

OGC_RECORDS_VERSION = "1.0.0"
OGC_RECORDS_STANDARD = "http://www.opengis.net/doc/IS/ogcapi-records-1/1.0"
OGC_RECORD_PROFILE = "http://www.opengis.net/def/profile/OGC/0/ogc-record"
OGC_CATALOG_PROFILE = "http://www.opengis.net/def/profile/OGC/0/ogc-catalog"
OGC_OPENAPI_MEDIA_TYPE = "application/vnd.oai.openapi+json;version=3.0"


def project_records_base(project_id: Any) -> str:
    return f"/projects/{project_id}/records"


def project_record_item_path(project_id: Any, resource_id: Any, language: str | None = None) -> str:
    path = f"{project_records_base(project_id)}/collections/resources/items/{resource_id}"
    return f"{path}?{urlencode({'language': language})}" if language else path


def records_api_document(project_id: Any) -> dict[str, Any]:
    """Describe the project-scoped Records surface without asserting conformance."""
    base = project_records_base(project_id)
    collection_parameter = {
        "name": "collectionId",
        "in": "path",
        "required": True,
        "schema": {"type": "string", "enum": ["resources"]},
    }
    record_parameter = {
        "name": "recordId",
        "in": "path",
        "required": True,
        "schema": {"type": "string", "format": "uuid"},
    }
    return {
        "openapi": "3.0.3",
        "info": {
            "title": "OpenGeo project records API",
            "version": OGC_RECORDS_VERSION,
            "description": (
                "Authenticated access to governed project records. This API description does "
                "not assert OGC conformance; consult the conformance resource."
            ),
        },
        "servers": [{"url": base, "description": "Project-scoped Records API"}],
        "security": [{"bearerAuth": []}],
        "paths": {
            "/": {
                "get": {
                    "operationId": "getRecordsLandingPage",
                    "responses": _api_responses("application/json"),
                }
            },
            "/conformance": {
                "get": {
                    "operationId": "getRecordsConformance",
                    "responses": _api_responses("application/json"),
                }
            },
            "/collections": {
                "get": {
                    "operationId": "getRecordCatalogs",
                    "responses": _api_responses("application/json"),
                }
            },
            "/collections/{collectionId}": {
                "get": {
                    "operationId": "getRecordCatalog",
                    "parameters": [collection_parameter],
                    "responses": _api_responses("application/ogc-catalog+json"),
                }
            },
            "/collections/{collectionId}/items": {
                "get": {
                    "operationId": "getRecords",
                    "parameters": [
                        collection_parameter,
                        _array_query_parameter("bbox", "number", minimum_items=4, maximum_items=6),
                        {
                            "name": "datetime",
                            "in": "query",
                            "required": False,
                            "style": "form",
                            "explode": False,
                            "schema": {"type": "string"},
                        },
                        {
                            "name": "limit",
                            "in": "query",
                            "required": False,
                            "style": "form",
                            "explode": False,
                            "schema": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 20,
                                "default": 10,
                            },
                        },
                        _array_query_parameter("q"),
                        _array_query_parameter(
                            "type",
                            allowed=[
                                "dataset",
                                "map",
                                "document",
                                "story",
                                "dashboard",
                                "service",
                            ],
                        ),
                        _array_query_parameter("ids", item_format="uuid"),
                        _array_query_parameter("externalIds"),
                        {
                            "name": "language",
                            "in": "query",
                            "required": False,
                            "schema": {"type": "string", "maxLength": 40},
                        },
                        {
                            "name": "offset",
                            "in": "query",
                            "required": False,
                            "schema": {"type": "integer", "minimum": 0, "default": 0},
                        },
                    ],
                    "responses": _api_responses("application/geo+json"),
                }
            },
            "/collections/{collectionId}/items/{recordId}": {
                "get": {
                    "operationId": "getRecord",
                    "parameters": [
                        collection_parameter,
                        record_parameter,
                        {
                            "name": "language",
                            "in": "query",
                            "required": False,
                            "schema": {"type": "string", "maxLength": 40},
                        },
                    ],
                    "responses": _api_responses("application/geo+json"),
                }
            },
        },
        "components": {
            "securitySchemes": {
                "bearerAuth": {
                    "type": "http",
                    "scheme": "bearer",
                    "bearerFormat": "JWT",
                    "description": "Access token issued by the shared auth.categori.se authority.",
                }
            }
        },
        "x-opengeo-conformance-claimed": False,
    }


def _api_responses(media_type: str) -> dict[str, Any]:
    return {
        "200": {
            "description": "Successful response",
            "content": {media_type: {"schema": {"type": "object"}}},
        }
    }


def _array_query_parameter(
    name: str,
    item_type: str = "string",
    *,
    item_format: str | None = None,
    allowed: list[str] | None = None,
    minimum_items: int | None = None,
    maximum_items: int | None = None,
) -> dict[str, Any]:
    items: dict[str, Any] = {"type": item_type}
    if item_format is not None:
        items["format"] = item_format
    if allowed is not None:
        items["enum"] = allowed
    schema: dict[str, Any] = {"type": "array", "items": items}
    if minimum_items is not None:
        schema["minItems"] = minimum_items
    if maximum_items is not None:
        schema["maxItems"] = maximum_items
    return {
        "name": name,
        "in": "query",
        "required": False,
        "style": "form",
        "explode": False,
        "schema": schema,
    }


def catalog_document(project_id: Any) -> dict[str, Any]:
    base = project_records_base(project_id)
    return {
        "id": "resources",
        "type": "Collection",
        "itemType": "record",
        "title": "Governed project resources",
        "description": ("Versioned datasets, maps, documents, stories, dashboards, and services."),
        "language": _language("en"),
        "links": [
            {
                "href": f"{base}/collections/resources",
                "rel": "self",
                "type": "application/ogc-catalog+json",
            },
            {
                "href": f"{base}/collections/resources/items",
                "rel": "items",
                "type": "application/geo+json",
            },
            {"href": OGC_CATALOG_PROFILE, "rel": "profile", "title": "OGC catalog"},
        ],
    }


def export_ogc_record(
    resource: GovernedResource | RecordResource,
    project_id: Any,
    requested_language: str | None = None,
) -> dict[str, Any]:
    summary = resource.summary
    translations = resource.translations
    primary = summary.language.lower()
    available = [primary, *sorted(language for language in translations if language != primary)]
    requested = requested_language.lower() if requested_language else primary
    selected = requested if requested in available else primary
    translation = translations.get(selected)
    if translation is None:
        title = summary.title
        abstract = summary.abstract
        attribution = summary.attribution
        keywords = list(summary.keywords)
    else:
        title = translation["title"]
        abstract = translation.get("abstract")
        attribution = translation.get("attribution")
        keywords = list(translation.get("keywords", []))

    properties: dict[str, Any] = {
        "created": _utc(summary.created_at),
        "updated": _utc(summary.updated_at),
        "type": summary.kind,
        "title": title,
        "language": _language(selected),
        "languages": [_language(language) for language in available if language != selected],
    }
    optional = {
        "description": abstract,
        "keywords": keywords or None,
        "license": summary.license,
        "rights": attribution,
    }
    properties.update({name: value for name, value in optional.items() if value is not None})
    external_ids = [
        {"scheme": item.namespace, "value": item.identifier}
        for item in resource.external_identifiers
    ]
    if summary.origin_namespace and summary.origin_identifier:
        origin = {
            "scheme": summary.origin_namespace,
            "value": summary.origin_identifier,
        }
        if origin not in external_ids:
            external_ids.append(origin)
    if external_ids:
        properties["externalIds"] = external_ids
    if requested != selected:
        properties["opengeo:languageFallback"] = {
            "requested": requested,
            "selected": selected,
        }

    links: list[dict[str, Any]] = [
        {
            "href": project_record_item_path(project_id, summary.resource_id, selected),
            "rel": "self",
            "type": "application/geo+json",
            "hreflang": selected,
            "title": f"Record in {selected}",
        },
        {
            "href": f"/projects/{project_id}/resources/{summary.resource_id}",
            "rel": "describes",
            "type": "application/json",
            "title": "Governed OpenGeo resource",
        },
        {
            "href": f"{project_records_base(project_id)}/collections/resources",
            "rel": "collection",
            "type": "application/ogc-catalog+json",
            "title": "Containing record catalog",
        },
        {
            "href": OGC_RECORD_PROFILE,
            "rel": "profile",
            "title": "OGC API Records record profile",
        },
    ]
    links.extend(
        {
            "href": project_record_item_path(project_id, summary.resource_id, language),
            "rel": "alternate",
            "type": "application/geo+json",
            "hreflang": language,
            "title": f"Record in {language}",
        }
        for language in available
        if language != selected
    )
    record: dict[str, Any] = {
        "type": "Feature",
        "id": str(summary.resource_id),
        "geometry": _geometry(summary),
        "properties": properties,
        "links": links,
    }
    time = _time(summary)
    if time is not None:
        record["time"] = time
    return {
        "target": "ogc_records_1_0",
        "targetVersion": OGC_RECORDS_VERSION,
        "mediaType": "application/geo+json",
        "status": "mapped",
        "document": record,
        "report": {
            "schemaVersion": "1.0.0",
            "standard": OGC_RECORDS_STANDARD,
            "requestedLanguage": requested_language,
            "selectedLanguage": selected,
            "availableLanguages": available,
            "fallback": requested != selected,
            "mapped": [
                "id",
                "kind",
                "title",
                "language",
                "created_at",
                "updated_at",
                *[name for name, value in optional.items() if value is not None],
                *(["spatial_extent"] if summary.spatial_extent else []),
                *(["temporal_extent"] if summary.temporal_start or summary.temporal_end else []),
                *(["external_identifiers"] if external_ids else []),
            ],
            "unmapped": ["metadata_extensions", "content", "provenance"],
            "conformanceClaimed": False,
        },
    }


def record_collection(
    resources: tuple[RecordResource, ...],
    project_id: Any,
    requested_language: str | None,
    number_matched: int,
    self_href: str,
    next_href: str | None,
    previous_href: str | None,
) -> dict[str, Any]:
    features = [
        export_ogc_record(resource, project_id, requested_language)["document"]
        for resource in resources
    ]
    links: list[dict[str, Any]] = [
        {"href": self_href, "rel": "self", "type": "application/geo+json"},
        {
            "href": OGC_CATALOG_PROFILE,
            "rel": "profile",
            "title": "OGC API Records catalog profile",
        },
    ]
    if next_href:
        links.append({"href": next_href, "rel": "next", "type": "application/geo+json"})
    if previous_href:
        links.append({"href": previous_href, "rel": "prev", "type": "application/geo+json"})
    return {
        "type": "FeatureCollection",
        "timeStamp": _utc(datetime.now(UTC)),
        "numberMatched": number_matched,
        "numberReturned": len(features),
        "features": features,
        "links": links,
    }


def _geometry(summary: ResourceSummary) -> dict[str, Any] | None:
    if summary.spatial_extent is None:
        return None
    min_x, min_y, max_x, max_y = summary.spatial_extent
    return {
        "type": "Polygon",
        "coordinates": [
            [
                [min_x, min_y],
                [max_x, min_y],
                [max_x, max_y],
                [min_x, max_y],
                [min_x, min_y],
            ]
        ],
    }


def _time(summary: ResourceSummary) -> dict[str, Any] | None:
    if summary.temporal_start is None and summary.temporal_end is None:
        return None
    return {
        "interval": [
            _utc(summary.temporal_start) if summary.temporal_start else "..",
            _utc(summary.temporal_end) if summary.temporal_end else "..",
        ]
    }


def _language(code: str) -> dict[str, str]:
    return {"code": code}


def _utc(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
