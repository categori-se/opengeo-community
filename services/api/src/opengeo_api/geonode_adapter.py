import hashlib
import json
from datetime import datetime
from typing import Any, Literal, cast
from uuid import UUID

from opengeo_api.resources import (
    GovernedResource,
    ImportedRelationship,
    ImportedResource,
    ResourceDraft,
    ResourceImportPlan,
    ResourceKind,
    ResourceMetadata,
    ResourceRelation,
    ResourceState,
)

GEONODE_VERSION: Literal["5.1.0"] = "5.1.0"
GEONODE_COMMIT: Literal["a1db97e81dfc26c16bb4ee1a5d2b408877af66c9"] = (
    "a1db97e81dfc26c16bb4ee1a5d2b408877af66c9"
)

_KIND_BY_RESOURCE_TYPE: dict[str, ResourceKind] = {
    "dataset": "dataset",
    "map": "map",
    "document": "document",
    "geostory": "story",
    "story": "story",
    "dashboard": "dashboard",
    "service": "service",
}
_RESOURCE_TYPE_BY_KIND = {
    "dataset": "dataset",
    "map": "map",
    "document": "document",
    "story": "geostory",
    "dashboard": "dashboard",
    "service": "service",
}
_KNOWN_FIELDS = frozenset(
    {
        "pk",
        "uuid",
        "resource_type",
        "subtype",
        "title",
        "abstract",
        "attribution",
        "language",
        "license",
        "keywords",
        "temporal_extent_start",
        "temporal_extent_end",
        "extent",
        "is_published",
        "is_approved",
        "advertised",
        "detail_url",
        "thumbnail_url",
        "links",
        "data",
        "styles",
        "perms",
        "owner",
        "date",
        "date_type",
        "edition",
        "purpose",
        "maintenance_frequency",
        "restriction_code_type",
        "constraints_other",
        "supplemental_information",
        "data_quality_statement",
        "category",
        "regions",
        "doi",
        "srid",
    }
)


def build_geonode_import_plan(
    *,
    source_url: str,
    resources: tuple[dict[str, Any], ...],
    relationships: tuple[dict[str, Any], ...],
) -> ResourceImportPlan:
    mapped: list[ImportedResource] = []
    fields: list[dict[str, str]] = []
    identifiers: set[str] = set()
    for index, source in enumerate(resources):
        identifier = str(source["uuid"])
        if identifier in identifiers:
            raise ValueError("GeoNode resource UUIDs must be unique")
        identifiers.add(identifier)
        kind = _resource_kind(source)
        extension = _extension(source)
        metadata = ResourceMetadata(
            title=cast(str, source["title"]),
            abstract=cast(str | None, source.get("abstract")),
            language=cast(str, source.get("language") or "en"),
            license=_named_text(source.get("license")),
            attribution=cast(str | None, source.get("attribution")),
            keywords=tuple(_keyword_text(value) for value in source.get("keywords", [])),
            spatial_extent=_extent(source.get("extent")),
            temporal_start=cast(datetime | None, source.get("temporal_extent_start")),
            temporal_end=cast(datetime | None, source.get("temporal_extent_end")),
            profile="opengeo.core.v1",
            extensions={"geonode": extension},
        )
        state: ResourceState = (
            "review" if source.get("is_approved") or source.get("is_published") else "draft"
        )
        content = _content(kind, source)
        draft = ResourceDraft(
            kind=kind,
            slug=f"geonode-{identifier.lower()}",
            dataset_id=None,
            map_id=None,
            visibility="restricted",
            state=state,
            metadata=metadata,
            content=content,
            provenance={
                "sourceSystem": "geonode",
                "sourceVersion": GEONODE_VERSION,
                "sourceCommit": GEONODE_COMMIT,
                "sourceUrl": source_url,
                "externalIdentifier": identifier,
            },
        )
        mapped.append(
            ImportedResource(
                identifier=identifier,
                source_payload_sha256=_sha256(source),
                draft=draft,
            )
        )
        fields.extend(_field_report(index, source, kind, extension))

    mapped_relationships: list[ImportedRelationship] = []
    for relationship in relationships:
        source_identifier = str(relationship["source_uuid"])
        target_identifier = str(relationship["target_uuid"])
        if source_identifier not in identifiers or target_identifier not in identifiers:
            raise ValueError("GeoNode relationships must resolve inside the import package")
        mapped_relationships.append(
            ImportedRelationship(
                source_identifier=source_identifier,
                target_identifier=target_identifier,
                relation=cast(ResourceRelation, relationship["relation"]),
            )
        )

    report = {
        "schemaVersion": "1.0.0",
        "source": {
            "product": "geonode",
            "version": GEONODE_VERSION,
            "commit": GEONODE_COMMIT,
            "url": source_url,
        },
        "summary": {
            "resources": len(mapped),
            "relationships": len(mapped_relationships),
            "mappedFields": sum(item["outcome"] == "mapped" for item in fields),
            "preservedExtensions": sum(item["outcome"] == "preserved_extension" for item in fields),
            "heldPublicationStates": sum(
                bool(item.get("is_published") or item.get("is_approved")) for item in resources
            ),
            "permissionBindingsRequired": sum(
                _entry_count(item.get("perms")) for item in resources
            ),
            "styleAttachmentsRequired": sum(_entry_count(item.get("styles")) for item in resources),
            "unsupported": 0,
        },
        "fields": fields,
        "warnings": [
            "Imported publication flags are held in restricted review state until "
            "OpenGeo permission and editorial review.",
            "GeoNode data/map bytes are not copied by this metadata package; imported "
            "resources remain unbound until governed data migration.",
            "GeoNode permission principals are preserved but never guessed; an organization "
            "member mapping is required before native resource grants are created.",
            "GeoNode style definitions are preserved but require explicit validation and "
            "attachment to a versioned OpenGeo portable style asset.",
        ],
    }
    return ResourceImportPlan(
        namespace="geonode",
        source_url=source_url,
        source_version=GEONODE_VERSION,
        resources=tuple(mapped),
        relationships=tuple(mapped_relationships),
        report=report,
    )


def export_geonode_resource(resource: GovernedResource) -> dict[str, Any]:
    summary = resource.summary
    geonode_identifier = next(
        (
            identifier.identifier
            for identifier in resource.external_identifiers
            if identifier.namespace == "geonode"
        ),
        str(summary.resource_id),
    )
    extension = resource.metadata_extensions.get("geonode", {})
    source_pk = extension.get("pk") if isinstance(extension, dict) else None
    document: dict[str, Any] = {
        "pk": source_pk,
        "uuid": geonode_identifier,
        "resource_type": _RESOURCE_TYPE_BY_KIND[summary.kind],
        "title": summary.title,
        "abstract": summary.abstract,
        "attribution": summary.attribution,
        "language": summary.language,
        "license": summary.license,
        "keywords": list(summary.keywords),
        "temporal_extent_start": (
            summary.temporal_start.isoformat() if summary.temporal_start else None
        ),
        "temporal_extent_end": summary.temporal_end.isoformat() if summary.temporal_end else None,
        "extent": (
            {"coords": list(summary.spatial_extent), "srid": "EPSG:4326"}
            if summary.spatial_extent
            else None
        ),
        "is_published": summary.state == "published",
        "is_approved": summary.state in {"review", "published", "archived"},
        "advertised": summary.visibility in {"organization", "public"},
        "_opengeo": {
            "resourceId": str(summary.resource_id),
            "projectId": str(summary.project_id),
            "version": summary.version_number,
            "visibility": summary.visibility,
            "state": summary.state,
            "metadataProfile": resource.metadata_profile,
            "metadataExtensions": resource.metadata_extensions,
            "content": resource.content,
            "provenance": resource.provenance,
            "relationships": [
                {
                    "sourceResourceId": str(item.source_resource_id),
                    "targetResourceId": str(item.target_resource_id),
                    "relation": item.relation,
                }
                for item in resource.relationships
            ],
        },
    }
    report = {
        "schemaVersion": "1.0.0",
        "target": {
            "product": "geonode",
            "version": GEONODE_VERSION,
            "commit": GEONODE_COMMIT,
        },
        "summary": {
            "mapped": 13,
            "preservedExtensions": 1,
            "unsupported": 0,
        },
        "fields": [
            {
                "path": "_opengeo",
                "outcome": "preserved_extension",
                "target": "GeoNode client-managed extension",
                "note": "OpenGeo content, provenance, relationships, and stronger "
                "governance remain reversible.",
            }
        ],
        "warnings": [
            "This portable resource document is not a claim that GeoNode will publish "
            "OpenGeo block content without an adapter."
        ],
    }
    return {"resource": document, "report": report}


def assert_safe_geonode_tree(value: Any, *, maximum_nodes: int = 20_000) -> None:
    sensitive = {
        "access_token",
        "api_key",
        "authorization",
        "client_secret",
        "cookie",
        "credentials",
        "password",
        "refresh_token",
        "secret",
        "token",
    }
    nodes = 0
    stack: list[tuple[Any, int]] = [(value, 0)]
    while stack:
        current, depth = stack.pop()
        nodes += 1
        if nodes > maximum_nodes:
            raise ValueError("GeoNode package exceeds the node limit")
        if depth > 32:
            raise ValueError("GeoNode package exceeds the nesting limit")
        if isinstance(current, dict):
            for key, nested in current.items():
                normalized_key = str(key).lower().replace("-", "_")
                if (
                    normalized_key in sensitive
                    or normalized_key.endswith("_password")
                    or normalized_key.endswith("_secret")
                    or normalized_key.endswith("_token")
                ):
                    raise ValueError("GeoNode package contains a sensitive field")
                stack.append((nested, depth + 1))
        elif isinstance(current, list):
            stack.extend((nested, depth + 1) for nested in current)


def _resource_kind(source: dict[str, Any]) -> ResourceKind:
    resource_type = str(source["resource_type"]).lower()
    if resource_type == "geoapp":
        resource_type = str(source.get("subtype") or "").lower()
    kind = _KIND_BY_RESOURCE_TYPE.get(resource_type)
    if kind is None:
        raise ValueError(f"unsupported GeoNode resource type: {resource_type}")
    return kind


def _extension(source: dict[str, Any]) -> dict[str, Any]:
    preserved = {key: value for key, value in source.items() if key not in _KNOWN_FIELDS}
    return {
        "pk": source.get("pk"),
        "uuid": str(source["uuid"]),
        "resourceType": source["resource_type"],
        "subtype": source.get("subtype"),
        "publication": {
            "isPublished": bool(source.get("is_published")),
            "isApproved": bool(source.get("is_approved")),
            "advertised": bool(source.get("advertised")),
        },
        "links": source.get("links", []),
        "thumbnailUrl": source.get("thumbnail_url"),
        "detailUrl": source.get("detail_url"),
        "permissions": source.get("perms"),
        "styles": source.get("styles"),
        "owner": source.get("owner"),
        "data": source.get("data"),
        "metadata": {
            key: source.get(key)
            for key in (
                "date",
                "date_type",
                "edition",
                "purpose",
                "maintenance_frequency",
                "restriction_code_type",
                "constraints_other",
                "supplemental_information",
                "data_quality_statement",
                "category",
                "regions",
                "doi",
                "srid",
            )
            if source.get(key) is not None
        },
        "unmapped": preserved,
    }


def _content(kind: ResourceKind, source: dict[str, Any]) -> dict[str, Any]:
    blocks: list[dict[str, Any]] = []
    detail_url = source.get("detail_url")
    if detail_url:
        blocks.append(
            {
                "id": "geonode-source",
                "type": "link",
                "url": detail_url,
                "label": "Original GeoNode resource",
            }
        )
    if kind in {"story", "dashboard"} and source.get("data") is not None:
        blocks.append(
            {
                "id": "geonode-application",
                "type": "preserved",
                "namespace": "geonode.geoapp",
                "label": "Preserved GeoNode application definition",
            }
        )
    return {"blocks": blocks}


def _field_report(
    index: int,
    source: dict[str, Any],
    kind: ResourceKind,
    extension: dict[str, Any],
) -> list[dict[str, str]]:
    prefix = f"resources[{index}]"
    mapped = [
        ("uuid", "externalIdentifiers.geonode"),
        ("resource_type", "kind"),
        ("title", "metadata.title"),
        ("abstract", "metadata.abstract"),
        ("attribution", "metadata.attribution"),
        ("language", "metadata.language"),
        ("license", "metadata.license"),
        ("keywords", "metadata.keywords"),
        ("extent", "metadata.spatialExtent"),
        ("temporal_extent_start", "metadata.temporalStart"),
        ("temporal_extent_end", "metadata.temporalEnd"),
    ]
    report = [
        {
            "path": f"{prefix}.{source_name}",
            "outcome": "mapped",
            "target": target,
            "note": f"Mapped into the OpenGeo {kind} resource version.",
        }
        for source_name, target in mapped
        if source.get(source_name) is not None
    ]
    if any(extension.get(key) not in (None, {}, []) for key in extension):
        report.append(
            {
                "path": prefix,
                "outcome": "preserved_extension",
                "target": "metadata.extensions.geonode",
                "note": "GeoNode-specific publication, links, permissions, application "
                "data, and unknown safe fields remain reversible.",
            }
        )
    if source.get("perms") not in (None, {}, []):
        report.append(
            {
                "path": f"{prefix}.perms",
                "outcome": "preserved_extension",
                "target": "metadata.extensions.geonode.permissions",
                "note": "Preserved for explicit GeoNode-principal to OpenGeo-member binding; "
                "no access grant is inferred.",
            }
        )
    if source.get("styles") not in (None, {}, []):
        report.append(
            {
                "path": f"{prefix}.styles",
                "outcome": "preserved_extension",
                "target": "metadata.extensions.geonode.styles",
                "note": "Preserved for validation and attachment as an immutable portable "
                "style revision.",
            }
        )
    return report


def _entry_count(value: Any) -> int:
    if value in (None, {}, []):
        return 0
    if isinstance(value, (dict, list)):
        return len(value)
    return 1


def _named_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("name", "label", "title", "identifier"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
    raise ValueError("GeoNode license must be a string or named object")


def _keyword_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("name", "label"):
            candidate = value.get(key)
            if isinstance(candidate, str):
                return candidate
    raise ValueError("GeoNode keyword must be a string or named object")


def _extent(value: Any) -> tuple[float, float, float, float] | None:
    if value is None:
        return None
    coords = value.get("coords") if isinstance(value, dict) else value
    if not isinstance(coords, list) or len(coords) != 4:
        raise ValueError("GeoNode extent must contain four coordinates")
    return cast(tuple[float, float, float, float], tuple(float(item) for item in coords))


def _sha256(value: dict[str, Any]) -> str:
    encoded = json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        default=_json_default,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _json_default(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    raise TypeError(f"unsupported GeoNode JSON value: {type(value).__name__}")
