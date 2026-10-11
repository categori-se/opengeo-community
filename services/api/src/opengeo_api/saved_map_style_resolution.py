"""Resolve exact map Style dependencies under current resource access."""

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
