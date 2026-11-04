"""Resolve exact map Style dependencies under current resource access."""

import json
from hashlib import sha256
from typing import Any
from uuid import UUID

from opengeo_api.authorization import Action
from opengeo_api.map_definitions import validate_map_definition
from opengeo_api.resources import (
    PostgresResourceRepository,
    ResourceAccessDenied,
    ResourceNotFound,
    ResourceStyle,
)
from opengeo_api.saved_map_rendering import SavedMapRenderUnsupported
from opengeo_api.tenant_database import TenantContext, TenantTransaction

PUBLIC_STYLE_PUBLICATION_LICENSES = frozenset({"CC-BY-4.0", "CC0-1.0", "PDDL-1.0"})
PUBLIC_STYLE_PUBLICATION_KEY = "opengeo.style-publications"


def _public_style_terms(extensions: Any, reference: dict[str, Any]) -> dict[str, str]:
    declaration = (
        extensions.get(PUBLIC_STYLE_PUBLICATION_KEY) if isinstance(extensions, dict) else None
    )
    if (
        not isinstance(declaration, dict)
        or set(declaration) != {"schemaVersion", "styles"}
        or declaration["schemaVersion"] != "opengeo.public-style-publications.1.0.0"
        or len(json.dumps(declaration, ensure_ascii=False).encode("utf-8")) > 8192
        or not isinstance(declaration["styles"], list)
        or not 1 <= len(declaration["styles"]) <= 64
    ):
        raise ValueError("style_publication_missing")
    keys = {"styleId", "versionNumber", "checksumSha256", "format", "license", "attribution"}
    seen = set()
    selected = None
    for entry in declaration["styles"]:
        if not isinstance(entry, dict) or set(entry) != keys:
            raise ValueError("style_publication_invalid")
        style_id = str(UUID(entry["styleId"]))
        version = entry["versionNumber"]
        checksum = entry["checksumSha256"]
        if (
            style_id != entry["styleId"]
            or type(version) is not int
            or not 1 <= version <= 9007199254740991
            or not isinstance(checksum, str)
            or len(checksum) != 64
            or any(char not in "0123456789abcdef" for char in checksum)
            or entry["format"] not in {"maplibre", "geostyler", "sld", "mapserver"}
            or entry["license"] not in PUBLIC_STYLE_PUBLICATION_LICENSES
            or not isinstance(entry["attribution"], str)
            or not 1 <= len(entry["attribution"].strip()) <= 2000
            or len(entry["attribution"]) > 2000
        ):
            raise ValueError("style_publication_invalid")
        identity = (style_id, version, checksum, entry["format"])
        if identity in seen:
            raise ValueError("style_publication_duplicated")
        seen.add(identity)
        if identity == (
            reference["styleId"],
            reference["versionNumber"],
            reference["checksumSha256"],
            reference["format"],
        ):
            selected = {"license": entry["license"], "attribution": entry["attribution"]}
    if selected is None:
        raise ValueError("style_publication_missing")
    return selected


async def resolve_public_saved_map_styles(
    transaction: TenantTransaction, context: TenantContext, definition: dict[str, Any]
) -> tuple[dict[str, ResourceStyle], list[dict[str, Any]]]:
    """Resolve curator-published exact Style pins, never requesting-user grants.

    The current metadata revision and separate Style terms form part of the
    returned public read seal. Callers compare that seal before/after object reads.
    """
    validate_map_definition(definition)
    resolved: dict[str, ResourceStyle] = {}
    dependencies: list[dict[str, Any]] = []
    cache: dict[tuple[Any, ...], tuple[ResourceStyle, dict[str, Any]]] = {}
    for layer in definition.get("layers", []):
        reference = layer.get("styleReference")
        if reference is None:
            continue
        key = (
            *(
                reference[name]
                for name in (
                    "projectId",
                    "resourceId",
                    "styleId",
                    "versionNumber",
                    "checksumSha256",
                    "format",
                )
            ),
            layer["datasetId"],
        )
        if key not in cache:
            statement = PostgresResourceRepository._style_select(current=False).replace(
                "SELECT style.id",
                "SELECT metadata.id, metadata.version_number, "
                "metadata.metadata_extensions, resource.state::text, resource.visibility::text, "
                "resource.dataset_id, style.id",
                1,
            )
            row = await transaction.fetch_one(
                statement
                + """
                JOIN app.governed_resources resource
                  ON resource.organization_id = style.organization_id
                 AND resource.project_id = style.project_id AND resource.id = style.resource_id
                JOIN app.governed_resource_versions metadata
                  ON metadata.organization_id = resource.organization_id
                 AND metadata.resource_id = resource.id
                 AND metadata.id = resource.current_version_id
                WHERE style.organization_id = %s AND style.project_id = %s
                  AND style.resource_id = %s AND style.id = %s
                  AND version.version_number = %s AND version.checksum_sha256 = %s
                  AND style.format::text = %s AND resource.dataset_id = %s
                  AND style.archived_at IS NULL
                  AND resource.state = 'published' AND resource.visibility = 'public'
                """,
                (
                    context.organization_id,
                    UUID(reference["projectId"]),
                    UUID(reference["resourceId"]),
                    UUID(reference["styleId"]),
                    reference["versionNumber"],
                    reference["checksumSha256"],
                    reference["format"],
                    UUID(layer["datasetId"]),
                ),
            )
            try:
                if (
                    row is None
                    or row[3:5] != ("published", "public")
                    or str(row[5]) != layer["datasetId"]
                ):
                    raise ValueError("style_not_public")
                style = PostgresResourceRepository._style(row[6:])
                if (
                    str(style.style_id) != reference["styleId"]
                    or str(style.resource_id) != reference["resourceId"]
                    or style.version_number != reference["versionNumber"]
                    or style.format != reference["format"]
                    or style.checksum_sha256 != reference["checksumSha256"]
                    or sha256(style.definition.encode("utf-8")).hexdigest()
                    != reference["checksumSha256"]
                    or type(row[1]) is not int
                    or row[1] < 1
                ):
                    raise ValueError("style_pin_changed")
                publication = {
                    "metadataVersionId": str(UUID(str(row[0]))),
                    "metadataVersionNumber": row[1],
                    "state": row[3],
                    "visibility": row[4],
                    **_public_style_terms(row[2], reference),
                }
            except (ValueError, TypeError, KeyError, AttributeError) as error:
                raise SavedMapRenderUnsupported(
                    "saved_map_style_unavailable",
                    "The selected Style is not explicitly published for public use.",
                ) from error
            cache[key] = style, publication
        style, publication = cache[key]
        resolved[layer["layerId"]] = style
        dependencies.append(
            {
                "layerId": layer["layerId"],
                "datasetId": layer["datasetId"],
                "reference": dict(reference),
                "publication": dict(publication),
            }
        )
    return resolved, dependencies


async def resolve_saved_map_styles(
    transaction: TenantTransaction, context: TenantContext, definition: dict[str, Any]
) -> dict[str, ResourceStyle]:
    validate_map_definition(definition)
    resolved: dict[str, ResourceStyle] = {}
    cache: dict[tuple[str, str, str, int, str, str, str], ResourceStyle] = {}
    for layer in definition.get("layers", []):
        reference = layer.get("styleReference")
        if reference is None:
            continue
        key = (
            reference["projectId"],
            reference["resourceId"],
            reference["styleId"],
            reference["versionNumber"],
            reference["checksumSha256"],
            reference["format"],
            layer["datasetId"],
        )
        if key in cache:
            resolved[layer["layerId"]] = cache[key]
            continue
        try:
            roles = await PostgresResourceRepository._resource_roles(
                transaction, context, UUID(reference["projectId"]), UUID(reference["resourceId"])
            )
            PostgresResourceRepository._require(Action.RESOURCE_READ, roles)
            row = await transaction.fetch_one(
                f"""{PostgresResourceRepository._style_select(current=False)}
                JOIN app.governed_resources resource
                  ON resource.organization_id = style.organization_id
                 AND resource.project_id = style.project_id AND resource.id = style.resource_id
                WHERE style.organization_id = %s AND style.project_id = %s
                  AND style.resource_id = %s AND style.id = %s
                  AND version.version_number = %s AND version.checksum_sha256 = %s
                  AND style.format::text = %s AND resource.dataset_id = %s
                """,
                (
                    context.organization_id,
                    UUID(reference["projectId"]),
                    UUID(reference["resourceId"]),
                    UUID(reference["styleId"]),
                    reference["versionNumber"],
                    reference["checksumSha256"],
                    reference["format"],
                    UUID(layer["datasetId"]),
                ),
            )
            if row is None:
                raise ResourceNotFound("style revision")
            style = PostgresResourceRepository._style(row)
            if sha256(style.definition.encode("utf-8")).hexdigest() != reference["checksumSha256"]:
                raise ResourceNotFound("style checksum")
        except (ResourceAccessDenied, ResourceNotFound) as error:
            raise SavedMapRenderUnsupported(
                "saved_map_style_unavailable",
                "A selected Style revision is unavailable or access has changed.",
            ) from error
        cache[key] = style
        resolved[layer["layerId"]] = style
    return resolved
