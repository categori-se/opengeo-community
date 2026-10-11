from datetime import UTC, datetime
from typing import Any

from opengeo_api.features import FeatureCollection, FeaturePage, FeatureRecord

OGC_FEATURES_VERSION = "1.0.0"
OGC_FEATURES_STANDARD = "http://www.opengis.net/doc/IS/ogcapi-features-1/1.0"
OGC_CRS84 = "http://www.opengis.net/def/crs/OGC/1.3/CRS84"
OGC_OPENAPI_MEDIA_TYPE = "application/vnd.oai.openapi+json;version=3.0"
FEATURE_COLLECTION_ID = "features"


def project_dataset_features_base(project_id: Any, dataset_id: Any) -> str:
    return f"/projects/{project_id}/datasets/{dataset_id}/ogc/features"


def features_api_document(project_id: Any, dataset_id: Any) -> dict[str, Any]:
    """Describe the authenticated read-only surface without asserting conformance."""
    base = project_dataset_features_base(project_id, dataset_id)
    collection_parameter = {
        "name": "collectionId",
        "in": "path",
        "required": True,
        "schema": {"type": "string", "enum": [FEATURE_COLLECTION_ID]},
    }
    feature_parameter = {
        "name": "featureId",
        "in": "path",
        "required": True,
        "schema": {"type": "string", "format": "uuid"},
    }
    generation_parameter = {
        "name": "expected_generation",
        "in": "query",
        "required": False,
        "schema": {"type": "integer", "minimum": 1},
        "description": (
            "OpenGeo exact-read extension; returns 409 if the authoritative collection "
            "generation no longer matches."
        ),
    }
    return {
        "openapi": "3.0.3",
        "info": {
            "title": "OpenGeo governed dataset features API",
            "version": OGC_FEATURES_VERSION,
            "description": (
                "Authenticated read-only GeoJSON access to one governed feature collection. "
                "This compatibility description does not assert OGC conformance."
            ),
        },
        "servers": [{"url": base, "description": "Dataset-scoped Features API"}],
        "security": [{"bearerAuth": []}],
        "paths": {
            "/": {"get": _operation("getFeaturesLandingPage", "application/json")},
            "/api": {"get": _operation("getFeaturesApiDescription", OGC_OPENAPI_MEDIA_TYPE)},
            "/conformance": {"get": _operation("getFeaturesConformance", "application/json")},
            "/collections": {"get": _operation("getFeatureCollections", "application/json")},
            "/collections/{collectionId}": {
                "get": {
                    **_operation("getFeatureCollection", "application/json"),
                    "parameters": [collection_parameter],
                }
            },
            "/collections/{collectionId}/queryables": {
                "get": {
                    **_operation("getFeatureQueryables", "application/schema+json"),
                    "parameters": [collection_parameter, generation_parameter],
                },
            },
            "/collections/{collectionId}/items": {
                "get": {
                    **_operation("getFeatures", "application/geo+json"),
                    "parameters": [
                        collection_parameter,
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
                        _array_query_parameter("bbox", "number", minimum_items=4, maximum_items=6),
                        {
                            "name": "limit",
                            "in": "query",
                            "required": False,
                            "schema": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 100,
                                "default": 10,
                            },
                        },
                        {
                            "name": "offset",
                            "in": "query",
                            "required": False,
                            "schema": {"type": "integer", "minimum": 0, "default": 0},
                            "description": "OpenGeo paging extension; not a conformance claim.",
                        },
                        generation_parameter,
                    ],
                }
            },
            "/collections/{collectionId}/items/{featureId}": {
                "get": {
                    **_operation("getFeature", "application/geo+json"),
                    "parameters": [
                        collection_parameter,
                        feature_parameter,
                        generation_parameter,
                    ],
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
        "x-opengeo-read-only": True,
        "x-opengeo-conformance-claimed": False,
    }


def collection_document(
    collection: FeatureCollection,
    base: str,
) -> dict[str, Any]:
    properties = {field.name: _field_schema(field) for field in collection.fields}
    return {
        "id": FEATURE_COLLECTION_ID,
        "title": "Governed dataset features",
        "description": (
            "Stable-ID authoritative features from one OpenGeo dataset. Mutations use the "
            "separate expected-version editing API."
        ),
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
                "href": f"{base}/collections/{FEATURE_COLLECTION_ID}/queryables",
                "rel": "http://www.opengis.net/def/rel/ogc/1.0/queryables",
                "type": "application/schema+json",
            },
            {
                "href": f"{base}/collections/{FEATURE_COLLECTION_ID}",
                "rel": "self",
                "type": "application/json",
            },
            {
                "href": f"{base}/collections/{FEATURE_COLLECTION_ID}/items",
                "rel": "items",
                "type": "application/geo+json",
            },
        ],
        "opengeo:datasetId": str(collection.dataset_id),
        "opengeo:geometryType": collection.geometry_type,
        "opengeo:generation": collection.generation,
        "opengeo:featureCount": collection.feature_count,
        "opengeo:properties": properties,
        "opengeo:conformanceClaimed": False,
    }


def _field_schema(field: Any) -> dict[str, Any]:
    if field.type == "group":
        object_schema: dict[str, Any] = {
            "type": "object",
            "properties": {child.name: _field_schema(child) for child in field.fields},
            "additionalProperties": False,
        }
        required = [child.name for child in field.fields if child.required]
        if required:
            object_schema["required"] = required
        schema = (
            {
                "type": "array",
                "items": object_schema,
                "minItems": max(field.min_items or 0, 1 if field.required else 0),
                "maxItems": field.max_items or 20,
            }
            if field.repeat
            else object_schema
        )
        schema["x-opengeo-required"] = field.required
    else:
        schema = {"type": field.type, "required": field.required}
    if field.visible_when is not None:
        schema["x-opengeo-visible-when"] = {
            "field": field.visible_when.field,
            "equals": field.visible_when.equals,
        }
    return schema


def feature_document(feature: FeatureRecord, base: str) -> dict[str, Any]:
    return {
        "type": "Feature",
        "id": str(feature.feature_id),
        "bbox": list(feature.bbox),
        "geometry": feature.geometry,
        "properties": feature.properties,
        "links": [
            {
                "href": f"{base}/collections/{FEATURE_COLLECTION_ID}/items/{feature.feature_id}",
                "rel": "self",
                "type": "application/geo+json",
            },
            {
                "href": f"{base}/collections/{FEATURE_COLLECTION_ID}",
                "rel": "collection",
                "type": "application/json",
            },
        ],
        "opengeo:version": feature.version_number,
        "opengeo:updatedAt": feature.updated_at.isoformat(),
    }


def feature_page_document(
    page: FeaturePage,
    base: str,
    self_href: str,
    next_href: str | None,
    previous_href: str | None,
) -> dict[str, Any]:
    links: list[dict[str, Any]] = [
        {"href": self_href, "rel": "self", "type": "application/geo+json"},
        {
            "href": f"{base}/collections/{FEATURE_COLLECTION_ID}",
            "rel": "collection",
            "type": "application/json",
        },
    ]
    if next_href is not None:
        links.append({"href": next_href, "rel": "next", "type": "application/geo+json"})
    if previous_href is not None:
        links.append({"href": previous_href, "rel": "prev", "type": "application/geo+json"})
    return {
        "type": "FeatureCollection",
        "timeStamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "numberMatched": page.number_matched,
        "numberReturned": len(page.features),
        "features": [feature_document(feature, base) for feature in page.features],
        "links": links,
        "opengeo:collectionGeneration": page.collection.generation,
        "opengeo:conformanceClaimed": False,
    }


def _operation(operation_id: str, media_type: str) -> dict[str, Any]:
    return {
        "operationId": operation_id,
        "responses": {
            "200": {
                "description": "Successful response",
                "content": {media_type: {"schema": {"type": "object"}}},
            }
        },
    }


def _array_query_parameter(
    name: str,
    item_type: str,
    *,
    minimum_items: int,
    maximum_items: int,
) -> dict[str, Any]:
    return {
        "name": name,
        "in": "query",
        "required": False,
        "style": "form",
        "explode": False,
        "schema": {
            "type": "array",
            "items": {"type": item_type},
            "minItems": minimum_items,
            "maxItems": maximum_items,
        },
    }
