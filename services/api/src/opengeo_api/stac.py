"""STAC projections of governed resource metadata, without copying provider assets."""

from datetime import UTC
from typing import Any

from opengeo_api.metadata_profiles import export_stac_1_1
from opengeo_api.resources import GovernedResource, RecordResource


class StacItemUnavailable(ValueError):
    """A resource lacks the known spatiotemporal metadata required for an Item."""


def item_id(resource: GovernedResource | RecordResource) -> str:
    return f"{resource.summary.resource_id}-v{resource.summary.version_number}"


def stac_item(resource: GovernedResource | RecordResource, collection_href: str) -> dict[str, Any]:
    summary = resource.summary
    start, end = summary.temporal_start, summary.temporal_end
    if summary.kind not in {"dataset", "service"} or start is None or end is None:
        raise StacItemUnavailable("STAC Items require a known instant or closed temporal interval")
    if start.tzinfo is None or end.tzinfo is None or end < start:
        raise StacItemUnavailable("STAC Item temporal coverage is invalid")
    collection = export_stac_1_1(resource)["document"]
    properties: dict[str, Any] = {
        "title": summary.title,
        "datetime": start.astimezone(UTC).isoformat() if start == end else None,
        "opengeo:resourceId": str(summary.resource_id),
        "opengeo:metadataVersion": summary.version_number,
        "opengeo:license": summary.license,
        "opengeo:metadataExtensions": collection["opengeo:metadataExtensions"],
    }
    if start != end:
        properties.update(
            start_datetime=start.astimezone(UTC).isoformat(),
            end_datetime=end.astimezone(UTC).isoformat(),
        )
    geometry = None
    if summary.spatial_extent is not None:
        geometry = _extent_geometry(summary.spatial_extent)
        properties["opengeo:geometrySource"] = "metadata bounding extent; not a measured footprint"
    identifier = item_id(resource)
    document: dict[str, Any] = {
        "type": "Feature",
        "stac_version": "1.1.0",
        "stac_extensions": [],
        "id": identifier,
        "collection": str(summary.resource_id),
        "geometry": geometry,
        "properties": properties,
        "assets": collection.get("assets", {}),
        "links": [
            {"rel": "collection", "href": collection_href, "type": "application/json"},
            {
                "rel": "self",
                "href": f"{collection_href}/items/{identifier}",
                "type": "application/geo+json",
            },
        ],
    }
    if geometry is not None:
        document["bbox"] = list(summary.spatial_extent or ())
    return document


def _extent_geometry(extent: tuple[float, float, float, float]) -> dict[str, Any]:
    west, south, east, north = extent
    if west > east:
        parts = [
            _extent_geometry((west, south, 180, north)),
            _extent_geometry((-180, south, east, north)),
        ]
        if all(part["type"] == "Polygon" for part in parts):
            return {"type": "MultiPolygon", "coordinates": [p["coordinates"] for p in parts]}
        return {
            "type": "MultiLineString",
            "coordinates": [[[west, south], [180, north]], [[-180, south], [east, north]]],
        }
    if west == east and south == north:
        return {"type": "Point", "coordinates": [west, south]}
    if west == east or south == north:
        return {"type": "LineString", "coordinates": [[west, south], [east, north]]}
    return {
        "type": "Polygon",
        "coordinates": [
            [[west, south], [east, south], [east, north], [west, north], [west, south]]
        ],
    }
