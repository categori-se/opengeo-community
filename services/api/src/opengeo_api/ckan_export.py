"""Offline, create-only CKAN payloads from the maintained STAC import plan."""

import re
from copy import deepcopy
from hashlib import sha256
from typing import Any
from urllib.parse import urlsplit

from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.metadata_adapters import (
    MetadataImportInvalid,
    build_metadata_import_plan,
    metadata_source_checksum,
)

CKAN_VERSION = "2.11.6"
CKAN_COMMIT = "a22d24505d1a5f75820d43cc3b0656c2c6b925a2"
_NAME = re.compile(r"[a-z0-9_-]{2,100}")
_TAG = re.compile(r"[\w .-]{2,100}", re.UNICODE)
_ROOT_FIELDS = {"name", "title", "notes", "url", "tags", "resources", "extras"}
_RESOURCE_FIELDS = {"url", "name", "description", "mimetype"}
_MAPPED_SOURCE_FIELDS = {
    "type",
    "stac_version",
    "id",
    "title",
    "description",
    "license",
    "keywords",
    "extent",
    "providers",
    "links",
}


def _reference(value: Any) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 2_048:
        raise MetadataImportInvalid("CKAN export requires bounded HTTPS references")
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or any(ord(char) < 33 for char in value)
        or "\\" in value
    ):
        raise MetadataImportInvalid("CKAN export refuses credential or query-bearing references")
    return value


def _reject_sensitive(value: Any) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key.casefold() in {"sensitivity", "classification"} and child != "public":
                raise MetadataImportInvalid("CKAN export refuses non-public sensitivity labels")
            if key.casefold() in {"private", "sensitive"} and child is not False:
                raise MetadataImportInvalid("CKAN export refuses sensitive metadata")
            _reject_sensitive(child)
    elif isinstance(value, list):
        for child in value:
            _reject_sensitive(child)
    elif isinstance(value, str) and urlsplit(value).scheme.casefold() in {"http", "https"}:
        _reference(value)


def validate_ckan_create_subset(payload: dict[str, Any]) -> None:
    """Derived structural checks; excludes CKAN plugins, database and authorization."""
    if set(payload) - _ROOT_FIELDS or not {"name", "title", "notes", "tags", "extras"} <= set(
        payload
    ):
        raise MetadataImportInvalid("CKAN create payload has unsupported fields")
    name = payload["name"]
    if not isinstance(name, str) or not _NAME.fullmatch(name) or name in {"new", "edit", "search"}:
        raise MetadataImportInvalid("CKAN create name is invalid")
    if any(not isinstance(payload[key], str) for key in ("title", "notes")):
        raise MetadataImportInvalid("CKAN create text fields must be strings")
    if "url" in payload:
        _reference(payload["url"])
    tags = payload["tags"]
    if not isinstance(tags, list) or len(tags) > 64:
        raise MetadataImportInvalid("CKAN create tags are invalid")
    for tag in tags:
        if (
            not isinstance(tag, dict)
            or set(tag) != {"name"}
            or not isinstance(tag["name"], str)
            or not _TAG.fullmatch(tag["name"])
        ):
            raise MetadataImportInvalid("CKAN create keyword is outside the supported tag subset")
    resources = payload.get("resources", [])
    if not isinstance(resources, list) or len(resources) > 32:
        raise MetadataImportInvalid("CKAN create resources are invalid")
    for resource in resources:
        if (
            not isinstance(resource, dict)
            or "url" not in resource
            or set(resource) - _RESOURCE_FIELDS
            or any(not isinstance(value, str) for value in resource.values())
        ):
            raise MetadataImportInvalid("CKAN create resource is outside the reference subset")
        _reference(resource["url"])
    extras = payload["extras"]
    if not isinstance(extras, list) or len(extras) > 16:
        raise MetadataImportInvalid("CKAN create extras are invalid")
    seen: set[str] = set()
    for extra in extras:
        if (
            not isinstance(extra, dict)
            or set(extra) != {"key", "value"}
            or not isinstance(extra["key"], str)
            or not extra["key"].startswith("opengeo:")
            or extra["key"] in seen
            or not isinstance(extra["value"], str)
        ):
            raise MetadataImportInvalid("CKAN create extras must be unique namespaced strings")
        seen.add(extra["key"])


def export_stac_ckan(document: dict[str, Any], *, namespace: str) -> dict[str, Any]:
    checksum = metadata_source_checksum(document)
    plan = build_metadata_import_plan(
        "stac_1_1",
        namespace,
        "stac-ckan-export",
        "restricted",
        document,
        checksum,
    )
    _reject_sensitive(document)
    metadata = plan.draft.metadata
    identity = sha256(canonical_json_bytes([namespace, plan.source_identifier])).hexdigest()
    provenance = dict(plan.draft.provenance)
    extras = {"opengeo:source": canonical_json_bytes(provenance).decode()}
    if metadata.license is not None:
        extras["opengeo:declared_license"] = metadata.license
    if metadata.spatial_extent is not None:
        extras["opengeo:spatial_extent"] = canonical_json_bytes(
            list(metadata.spatial_extent)
        ).decode()
    for label in ("temporal_start", "temporal_end"):
        if (date := getattr(metadata, label)) is not None:
            extras[f"opengeo:{label}"] = date.isoformat()
    providers = document.get("providers", [])
    links = document.get("links", [])
    if any(not isinstance(value, list) or len(value) > 32 for value in (providers, links)):
        raise MetadataImportInvalid("CKAN export admits at most 32 providers and links")
    publishers = []
    unmapped = sorted(set(document) - _MAPPED_SOURCE_FIELDS)
    for index, provider in enumerate(providers):
        if (
            not isinstance(provider, dict)
            or not isinstance(provider.get("name"), str)
            or not 1 <= len(provider["name"]) <= 300
            or not isinstance(provider.get("roles", []), list)
            or any(not isinstance(role, str) for role in provider.get("roles", []))
        ):
            raise MetadataImportInvalid("CKAN export provider is unsupported")
        if "publisher" in provider.get("roles", []):
            publishers.append(provider)
        else:
            unmapped.append(f"providers[{index}]")
    if publishers:
        extras["opengeo:publishers"] = canonical_json_bytes(publishers).decode()
    payload: dict[str, Any] = {
        "name": f"stac-{identity}",
        "title": metadata.title,
        "notes": metadata.abstract,
        "tags": [{"name": tag} for tag in metadata.keywords],
    }
    resources = []
    for link in links:
        if (
            not isinstance(link, dict)
            or not isinstance(link.get("rel"), str)
            or not 1 <= len(link["rel"]) <= 100
        ):
            raise MetadataImportInvalid("CKAN export link is unsupported")
        href = _reference(link.get("href"))
        if link["rel"] == "self":
            if "url" in payload:
                raise MetadataImportInvalid("CKAN export admits at most one self link")
            payload["url"] = href
        if link["rel"] == "enclosure":
            resource = {"url": href, "description": "Declared STAC enclosure reference"}
            for source, target in (("title", "name"), ("type", "mimetype")):
                if source in link:
                    if not isinstance(link[source], str) or not 1 <= len(link[source]) <= 1_000:
                        raise MetadataImportInvalid("CKAN export link text is unsupported")
                    resource[target] = link[source]
            resources.append(resource)
    if resources:
        payload["resources"] = resources
    if links:
        extras["opengeo:stac_links"] = canonical_json_bytes(links).decode()
    payload["extras"] = [{"key": key, "value": value} for key, value in sorted(extras.items())]
    validate_ckan_create_subset(payload)
    mapped = [
        "source namespace+identifier->name",
        "normalized title->title",
        "normalized abstract->notes",
        "normalized keywords->tags",
        "normalized known extents->namespaced extras",
        "source provenance and declared license->namespaced extras",
    ]
    losses = [
        "Namespaced extras preserve metadata; CKAN core does not interpret their semantics.",
        "The importer strips surrounding core text whitespace and parses date strings; "
        "export reformats dates as ISO 8601. Original values remain in source.",
    ]
    if publishers:
        mapped.append("retained STAC publisher providers->opengeo:publishers extra")
    if "url" in payload or resources:
        mapped.append("retained STAC self/enclosure links->url/reference resources")
    if links:
        mapped.append("all declared links->opengeo:stac_links extra")
    if any(link["rel"] not in {"self", "enclosure"} for link in links):
        losses.append("Other link relations remain custom metadata without native CKAN fields.")
    if plan.conversion_report["derived"]:
        losses.extend(plan.conversion_report["derived"])
    if unmapped:
        losses.append("Unmapped fields and non-publisher providers remain only in retained source.")
    return {
        "mode": "dry_run",
        "action": "package_create",
        "payload": payload,
        "source": {**provenance, "document": deepcopy(plan.source_document)},
        "importReport": deepcopy(plan.conversion_report),
        "report": {
            "target": f"CKAN {CKAN_VERSION} Action API v3 package_create",
            "referenceCommit": CKAN_COMMIT,
            "validation": "derived_subset_structure_only",
            "remoteWritePerformed": False,
            "mapped": mapped,
            "unmapped": sorted(unmapped),
            "unmappedScope": "Top-level fields and non-publisher provider records; unused "
            "nested extent properties remain only in retained source.",
            "losses": losses,
            "unasserted": [
                "license_id",
                "owner_org",
                "private",
                "state",
                "permissions",
                "groups",
                "remote access",
                "CKAN plugin compatibility",
                "server acceptance",
            ],
            "limits": [
                "Create only: package_update can delete omitted fields; review separately.",
                "No download, upload, remote write, harvesting or synchronization is performed.",
                "Destination ownership, visibility, authorization and name uniqueness need review.",
                "Sensitive-key/label and URL checks are bounded; prose is not classified.",
            ],
        },
    }
