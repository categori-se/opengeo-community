import hashlib
import json
from copy import deepcopy
from datetime import datetime
from typing import Any, Literal, cast
from uuid import UUID

from opengeo_api.geonode_publications import convert_publication, publication_data
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
        "_opengeo",
    }
)


def build_geonode_import_plan(
    *,
    source_url: str,
    resources: tuple[dict[str, Any], ...],
    relationships: tuple[dict[str, Any], ...],
    normalized_metadata: tuple[ResourceMetadata, ...] | None = None,
) -> ResourceImportPlan:
    if normalized_metadata is not None and len(normalized_metadata) != len(resources):
        raise ValueError("normalized GeoNode metadata must match the resource package")
    mapped: list[ImportedResource] = []
    fields: list[dict[str, str]] = []
    publications: list[dict[str, Any]] = []
    identifiers: set[str] = set()
    for index, source in enumerate(resources):
        identifier = str(source["uuid"])
        if identifier in identifiers:
            raise ValueError("GeoNode resource UUIDs must be unique")
        identifiers.add(identifier)
        kind = _resource_kind(source)
        publication_blocks: list[dict[str, Any]] = []
        if kind in {"story", "dashboard"} and source.get("data") is not None:
            assert_safe_geonode_tree(publication_data(source["data"]))
            publication_blocks, conversion = convert_publication(kind, source["data"])
            publications.append({"resourceIdentifier": identifier, **conversion})
        extension = _extension(source)
        if source.get("_opengeo") is not None and normalized_metadata is None:
            raise ValueError("portable GeoNode metadata requires native request validation")
        metadata = (
            normalized_metadata[index]
            if normalized_metadata is not None
            else ResourceMetadata(
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
        )
        state: ResourceState = (
            "review" if source.get("is_approved") or source.get("is_published") else "draft"
        )
        content = _content(kind, source, publication_blocks)
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
            "normalizedFields": sum(item["outcome"] == "normalized" for item in fields),
            "preservedExtensions": sum(item["outcome"] == "preserved_extension" for item in fields),
            "heldPublicationStates": sum(
                bool(item.get("is_published") or item.get("is_approved")) for item in resources
            ),
            "permissionBindingsRequired": sum(
                _entry_count(item.get("perms")) for item in resources
            ),
            "styleAttachmentsRequired": sum(_entry_count(item.get("styles")) for item in resources),
            "unsupported": 0,
            "convertedPublications": sum(bool(item["blocks"]) for item in publications),
            "publicationLosses": sum(len(item["losses"]) for item in publications),
        },
        "publications": publications,
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
            "Portable source custody retains first and current evidence, not a full "
            "history of intermediate carrier edits.",
            "The bounded GeoStory title/text profile becomes native reading content. "
            "Unsupported application elements remain in source custody and the conversion "
            "report; offlineReady applies only when that report has no losses.",
        ],
    }
    _bound_report(report)
    return ResourceImportPlan(
        namespace="geonode",
        source_url=source_url,
        source_version=GEONODE_VERSION,
        resources=tuple(mapped),
        relationships=tuple(mapped_relationships),
        report=report,
    )


def geonode_import_readback_report(
    plan: ResourceImportPlan, records: tuple[GovernedResource, ...]
) -> dict[str, Any]:
    """Describe committed content, including an unchanged pre-converter import.

    Identical source imports intentionally reuse existing identities and revisions.
    Never imply that a newly proposed conversion overwrote that authored content.
    """
    report = deepcopy(plan.report)
    contents = {
        candidate.identifier: (candidate.draft.content, records[index].content)
        for index, candidate in enumerate(plan.resources)
        if index < len(records)
    }
    for publication in report["publications"]:
        proposed, committed = contents.get(publication["resourceIdentifier"], ({}, {}))
        expected = {
            block["id"]: block
            for block in proposed.get("blocks", [])
            if block["id"] in {item["blockId"] for item in publication["blocks"]}
        }
        actual = {block.get("id"): block for block in committed.get("blocks", [])}
        applied = bool(expected) and all(
            actual.get(key) == block for key, block in expected.items()
        )
        publication["conversionApplied"] = applied
        publication["offlineReady"] = publication["offlineReady"] and applied
        if expected and not applied:
            publication["losses"].append(
                {
                    "path": "data",
                    "code": "existing_content_preserved",
                    "detail": "Existing authored content was preserved. Review the proposed "
                    "conversion and save it deliberately before publishing.",
                }
            )
    report["summary"]["convertedPublications"] = sum(
        item["conversionApplied"] for item in report["publications"]
    )
    report["summary"]["publicationLosses"] = sum(
        len(item["losses"]) for item in report["publications"]
    )
    return report


def geonode_metadata_values(source: dict[str, Any]) -> dict[str, Any]:
    """Prepare inert portable metadata for the normal ResourceMetadataRequest validator."""
    assert_safe_geonode_tree(source)
    kind = _resource_kind(source)
    if kind in {"story", "dashboard"} and source.get("data") is not None:
        assert_safe_geonode_tree(publication_data(source["data"]))
        # Reject invalid/oversized generated content at the request boundary,
        # before a repository can commit any resources in this package.
        convert_publication(kind, source["data"])
    portable = source.get("_opengeo")
    if portable is not None and not isinstance(portable, dict):
        raise ValueError("portable OpenGeo metadata must be an object")
    portable = portable or {}
    extensions = deepcopy(portable.get("metadataExtensions", {}))
    if not isinstance(extensions, dict):
        raise ValueError("portable metadata extensions must be an object")
    # This namespace is an actual current-resource publication assertion, not an
    # inert metadata value. Preserve it without authorizing the imported resource.
    authority = extensions.pop("opengeo.style-publications", None)
    preserved = {
        key: deepcopy(value)
        for key, value in portable.items()
        if key not in {"metadataExtensions", "translations"}
    }
    if authority is not None:
        preserved["sourceAuthorityExtensions"] = {"opengeo.style-publications": authority}
    key = _custody_namespace(extensions)
    original = extensions.get(key, {})
    if not isinstance(original, dict):
        raise ValueError("portable GeoNode custody extension must be an object")
    incoming = _extension(source)
    custody = deepcopy(original)
    original_fields = {
        name: deepcopy(value) for name, value in original.items() if name in incoming
    }
    for name, value in incoming.items():
        if name in {"metadata", "unmapped"}:
            previous = custody.get(name, {})
            if not isinstance(previous, dict):
                raise ValueError("portable source metadata must be an object")
            custody[name] = {**previous, **value}
        elif value not in (None, [], {}) or name not in custody:
            custody[name] = value
    if original_fields and any(custody[name] != value for name, value in original_fields.items()):
        custody.setdefault("sourceFieldsFirst", original_fields)
    if preserved:
        # Keep first/current evidence, never a recursive chain of carrier snapshots.
        previous = custody.get("opengeo")
        if previous is not None and previous != preserved:
            custody.setdefault("opengeoFirst", previous)
        custody["opengeo"] = preserved
    extensions[key] = custody
    return {
        "title": source["title"],
        "abstract": source.get("abstract"),
        "language": source.get("language") or "en",
        "license": _named_text(source.get("license")),
        "attribution": source.get("attribution"),
        "keywords": [_keyword_text(value) for value in source.get("keywords", [])],
        "spatial_extent": _extent(source.get("extent")),
        "temporal_start": source.get("temporal_extent_start"),
        "temporal_end": source.get("temporal_extent_end"),
        "extensions": extensions,
        "translations": portable.get("translations", {}),
        # Source profile/managed-profile identifiers are evidence, never authority.
        "profile": "opengeo.core.v1",
    }


def _custody_namespace(extensions: dict[str, Any]) -> str:
    return "geonode" if isinstance(extensions.get("geonode", {}), dict) else "geonode.import"


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
    if not isinstance(extension, dict):
        extension = resource.metadata_extensions.get("geonode.import", {})
    source_pk = extension.get("pk") if isinstance(extension, dict) else None
    document: dict[str, Any] = {}
    if isinstance(extension, dict):
        unknown = extension.get("unmapped", {})
        if isinstance(unknown, dict):
            document.update(
                {key: deepcopy(value) for key, value in unknown.items() if key not in _KNOWN_FIELDS}
            )
        metadata = extension.get("metadata", {})
        if isinstance(metadata, dict):
            document.update(deepcopy(metadata))
        for source_name, extension_name in (
            ("detail_url", "detailUrl"),
            ("thumbnail_url", "thumbnailUrl"),
            ("links", "links"),
        ):
            if extension.get(extension_name) is not None:
                document[source_name] = deepcopy(extension[extension_name])
    document.update(
        {
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
            "temporal_extent_end": summary.temporal_end.isoformat()
            if summary.temporal_end
            else None,
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
                "translations": resource.translations,
                "content": resource.content,
                "provenance": resource.provenance,
                "externalIdentifiers": [
                    {
                        "namespace": item.namespace,
                        "identifier": item.identifier,
                        "sourceUrl": item.source_url,
                        "sourceVersion": item.source_version,
                        "sourcePayloadSHA256": item.source_payload_sha256,
                        "importedAt": item.imported_at.isoformat(),
                    }
                    for item in resource.external_identifiers
                ],
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
    )
    fields: list[dict[str, str]] = []
    core = {
        "uuid",
        "resource_type",
        "title",
        "abstract",
        "attribution",
        "language",
        "license",
        "keywords",
        "temporal_extent_start",
        "temporal_extent_end",
        "extent",
    }
    for name, value in document.items():
        if name == "_opengeo":
            continue
        outcome = (
            "not_present"
            if value is None
            else "mapped"
            if name in core
            else "editorial_hint"
            if name in {"is_published", "is_approved", "advertised"}
            else "preserved_source"
        )
        fields.append(
            {
                "path": name,
                "outcome": outcome,
                "target": name,
                "note": "No upstream PK is fabricated."
                if name == "pk"
                else "Native metadata projection."
                if name in core
                else "Editorial hint only; no grants."
                if outcome == "editorial_hint"
                else "Exact source representation retained.",
            }
        )
    for name, value in document["_opengeo"].items():
        if name == "translations":
            for language, translation in value.items():
                for field in translation:
                    fields.append(
                        {
                            "path": f"_opengeo.translations.{language}.{field}",
                            "outcome": "preserved_extension",
                            "target": "OpenGeo portable metadata",
                            "note": "Portable translation; GeoNode support unclaimed.",
                        }
                    )
        elif name == "metadataExtensions":
            for namespace, extension_value in value.items():
                paths = [f"_opengeo.metadataExtensions.{namespace}"]
                if namespace in {"geonode", "geonode.import"} and isinstance(extension_value, dict):
                    paths = []
                    for field, item in extension_value.items():
                        if field in {"metadata", "unmapped"} and isinstance(item, dict):
                            paths.extend(
                                f"_opengeo.metadataExtensions.{namespace}.{field}.{key}"
                                for key in item
                            )
                        else:
                            paths.append(f"_opengeo.metadataExtensions.{namespace}.{field}")
                for path in paths:
                    fields.append(
                        {
                            "path": path,
                            "outcome": "preserved_extension",
                            "target": "OpenGeo portable metadata",
                            "note": "Source value; no style, permission or profile authority.",
                        }
                    )
        else:
            fields.append(
                {
                    "path": f"_opengeo.{name}",
                    "outcome": "preserved_extension",
                    "target": "OpenGeo portable source evidence",
                    "note": "Inert evidence; native identity/content/authority not restored.",
                }
            )
    report = {
        "schemaVersion": "1.0.0",
        "target": {
            "product": "geonode",
            "version": GEONODE_VERSION,
            "commit": GEONODE_COMMIT,
        },
        "summary": {
            "mapped": sum(item["outcome"] == "mapped" for item in fields),
            "preservedExtensions": sum(item["outcome"] == "preserved_extension" for item in fields),
            "preservedSourceFields": sum(item["outcome"] == "preserved_source" for item in fields),
            "editorialHints": sum(item["outcome"] == "editorial_hint" for item in fields),
            "notPresent": sum(item["outcome"] == "not_present" for item in fields),
            "unsupported": 0,
        },
        "fields": fields,
        "warnings": [
            "This portable resource document is not a claim that GeoNode will publish "
            "OpenGeo block content without an adapter."
        ],
    }
    assert_safe_geonode_tree(document)
    _bound_report(report)
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
            if key in source
        },
        "unmapped": preserved,
    }


def _content(
    kind: ResourceKind, source: dict[str, Any], publication_blocks: list[dict[str, Any]]
) -> dict[str, Any]:
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
    blocks.extend(publication_blocks)
    return {"blocks": blocks}


def _field_report(
    index: int,
    source: dict[str, Any],
    kind: ResourceKind,
    extension: dict[str, Any],
) -> list[dict[str, str]]:
    prefix = f"resources[{index}]"
    portable = source.get("_opengeo") or {}
    custody = _custody_namespace(portable.get("metadataExtensions", {}))
    mapped = {
        "uuid": "externalIdentifiers.geonode",
        "resource_type": "kind",
        "subtype": "kind",
        "title": "metadata.title",
        "abstract": "metadata.abstract",
        "attribution": "metadata.attribution",
        "language": "metadata.language",
        "license": "metadata.license",
        "keywords": "metadata.keywords",
        "extent": "metadata.spatialExtent",
        "temporal_extent_start": "metadata.temporalStart",
        "temporal_extent_end": "metadata.temporalEnd",
    }
    preserved = {
        "pk": "pk",
        "is_published": "publication.isPublished",
        "is_approved": "publication.isApproved",
        "advertised": "publication.advertised",
        "links": "links",
        "thumbnail_url": "thumbnailUrl",
        "detail_url": "detailUrl",
        "perms": "permissions",
        "styles": "styles",
        "owner": "owner",
        "data": "data",
    }
    report: list[dict[str, str]] = []
    for name, value in source.items():
        if value in (None, [], {}) and (
            name in extension["metadata"] or name in extension["unmapped"]
        ):
            category = "metadata" if name in extension["metadata"] else "unmapped"
            report.append(
                {
                    "path": f"{prefix}.{name}",
                    "outcome": "preserved_extension",
                    "target": f"metadata.extensions.{custody}.{category}.{name}",
                    "note": "Explicit empty/null source value retained.",
                }
            )
            continue
        if value is None or value == [] or value == {}:
            continue
        if name == "_opengeo":
            for field, item in value.items():
                if field == "translations":
                    for language, translation in item.items():
                        source_path = f"{prefix}._opengeo.translations.{language}"
                        target_path = f"metadata.translations.{language.lower()}"
                        for translated_field in translation:
                            report.append(
                                {
                                    "path": f"{source_path}.{translated_field}",
                                    "outcome": "preserved_extension",
                                    "target": f"{target_path}.{translated_field}",
                                    "note": "Native validation; GeoNode support unclaimed.",
                                }
                            )
                elif field == "metadataExtensions":
                    for namespace in item:
                        report.append(
                            {
                                "path": f"{prefix}._opengeo.metadataExtensions.{namespace}",
                                "outcome": "preserved_extension",
                                "target": (
                                    f"metadata.extensions.{custody}.opengeo."
                                    "sourceAuthorityExtensions"
                                )
                                if namespace == "opengeo.style-publications"
                                else f"metadata.extensions.{namespace}",
                                "note": "Publication assertions remain inert source evidence."
                                if namespace == "opengeo.style-publications"
                                else "First/current source custody; no edit-history chain."
                                if namespace in {custody, "geonode.import"}
                                else "Native extension validation; GeoNode support unclaimed.",
                            }
                        )
                else:
                    report.append(
                        {
                            "path": f"{prefix}._opengeo.{field}",
                            "outcome": "preserved_extension",
                            "target": f"metadata.extensions.{custody}.opengeo.{field}",
                            "note": "Inert source evidence; no native identity or authority.",
                        }
                    )
            continue
        if name in mapped:
            normalized = (
                (name == "license" and isinstance(value, dict))
                or (name == "keywords" and any(isinstance(item, dict) for item in value))
                or (name == "language" and value != value.lower())
            )
            report.append(
                {
                    "path": f"{prefix}.{name}",
                    "outcome": "normalized" if normalized else "mapped",
                    "target": mapped[name],
                    "note": "Named objects/case normalize; representation changes."
                    if normalized
                    else f"Mapped into the OpenGeo {kind} resource version.",
                }
            )
        else:
            target = preserved.get(name)
            if target is None:
                target = (
                    ("metadata." + name) if name in extension["metadata"] else ("unmapped." + name)
                )
            report.append(
                {
                    "path": f"{prefix}.{name}",
                    "outcome": "preserved_extension",
                    "target": f"metadata.extensions.{custody}." + target,
                    "note": "Inert source value; native authority needs review.",
                }
            )
    return report


def _bound_report(report: dict[str, Any]) -> None:
    encoded = json.dumps(report, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > 16_384:
        raise ValueError("GeoNode conversion report exceeds the 16 KiB limit")


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
