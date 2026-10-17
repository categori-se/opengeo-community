"""Discover saved layer presentations and registered service connections."""

import re
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

from opengeo_api.tenant_database import TenantContext, TenantTransaction, TenantTransactionExecutor


def catalog_service_reference(
    url: Any, source_type: Any, source_version: Any
) -> dict[str, Any] | None:
    """Describe a recorded public service address, without fetching or exposing credentials.

    This is provenance from an authorized saved map, not a service health claim.
    The address may also come from a readable registered connection with no map.
    Storage locations, signed URLs and arbitrary configuration never leave here.
    """
    if (
        not isinstance(url, str)
        or len(url) > 2048
        or not url.isascii()
        or re.search(r"[\s\\%\x00-\x1f\x7f]", url)
    ):
        return None
    try:
        parsed = urlsplit(url)
        if (
            parsed.scheme != "https"
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.port not in (None, 443)
            or not re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", parsed.hostname or "")
            or re.search(r"\.(?:localhost|local|internal)$", parsed.hostname or "")
        ):
            return None
    except ValueError:
        return None
    if not re.fullmatch(r"/[A-Za-z0-9_./~-]+", parsed.path):
        return None
    if any(segment in (".", "..") for segment in parsed.path.split("/")):
        return None
    if source_type in {"cog", "cog-raster"}:
        if not parsed.path.lower().endswith((".tif", ".tiff")):
            return None
        return {
            "url": url,
            "kind": "COG",
            "layer_id": None,
            "layer_url": url,
            "rendering_source": "provider",
            "source_version": source_version
            if type(source_version) is int and source_version > 0
            else None,
        }
    if source_type == "wfs":
        endpoint = urlunsplit(("https", parsed.hostname, parsed.path.rstrip("/"), "", ""))
        return {
            "url": endpoint,
            "kind": "WFS",
            "layer_id": None,
            "layer_url": endpoint,
            "rendering_source": "provider",
            "source_version": source_version
            if type(source_version) is int and source_version > 0
            else None,
        }
    match = re.fullmatch(r"(.*/(FeatureServer|MapServer|ImageServer))(?:/([0-9]+))?/?", parsed.path)
    if not match or (match[2] == "ImageServer" and match[3] is not None):
        return None
    if any(segment in (".", "..") for segment in parsed.path.split("/")):
        return None
    service_url = urlunsplit(("https", parsed.hostname, match[1], "", ""))
    return {
        "url": service_url,
        "kind": match[2],
        "layer_id": match[3],
        "layer_url": service_url + ("/" + match[3] if match[3] is not None else ""),
        "rendering_source": "captured_copy" if source_type == "geojson-archive" else "provider",
        "source_version": source_version
        if type(source_version) is int and source_version > 0
        else None,
    }


async def search_layer_records(
    executor: TenantTransactionExecutor,
    context: TenantContext,
    *,
    limit: int = 25,
    offset: int = 0,
    query: str | None = None,
    project_id: UUID | None = None,
    client_id: UUID | None = None,
    classification: str | None = None,
) -> list[dict[str, Any]]:
    if not 1 <= limit <= 100 or not 0 <= offset <= 100_000:
        raise ValueError("Invalid catalog page")
    if query is not None and len(query) > 200:
        raise ValueError("Invalid catalog query")

    async def operation(transaction: TenantTransaction) -> list[dict[str, Any]]:
        rows = await transaction.fetch_all(
            """
            WITH member AS (
              SELECT role FROM app.organization_memberships
              WHERE organization_id=%s AND user_id=%s
            ), authorized AS (
              SELECT DISTINCT ON (dataset.id, project.id)
                dataset.id, dataset.organization_id, dataset.name,
                dataset.description, dataset.format::text, dataset.classification::text,
                dataset.source_type::text, dataset.updated_at, dataset.status::text,
                project.id AS project_id, project.name AS project_name,
                (member.role='admin' OR membership.role IS NOT NULL) AS can_read_maps
              FROM app.datasets dataset CROSS JOIN member
              JOIN app.project_datasets link ON link.dataset_id=dataset.id
                AND link.organization_id=dataset.organization_id
              JOIN app.projects project ON project.id=link.project_id
                AND project.organization_id=dataset.organization_id
              CROSS JOIN LATERAL (
                SELECT app.effective_project_role(project.id)::text AS role
              ) membership
              LEFT JOIN app.dataset_permissions permission ON permission.dataset_id=dataset.id
                AND permission.organization_id=dataset.organization_id
                AND permission.user_id=app.current_user_id()
              WHERE dataset.organization_id=%s
                AND (member.role='admin' OR membership.role IS NOT NULL
                  OR permission.role IS NOT NULL OR dataset.owner_user_id=app.current_user_id())
                AND (%s::uuid IS NULL OR project.id=%s)
                AND (%s::uuid IS NULL OR project.client_id=%s)
                AND (%s::text IS NULL OR dataset.classification::text=%s)
              ORDER BY dataset.id, project.id
            ), entries AS (
              SELECT dataset.*, view.map_id, view.map_version, view.layer_id,
                COALESCE(view.title, dataset.name) AS title,
                COALESCE(view.description, dataset.description) AS layer_description,
                view.style_field, view.legend,
                COALESCE(view.geometry_type, connection.geometry_type) AS geometry_type,
                view.style_key,
                COALESCE(view.provider_url, connection.source_url) AS provider_url,
                COALESCE(view.map_source_type, connection.source_type) AS map_source_type,
                COALESCE(view.source_version, to_jsonb(connection.version_number)) AS source_version
              FROM authorized dataset
              LEFT JOIN LATERAL (
                SELECT DISTINCT ON (layer->>'layerId', style_key, provider_url)
                  map.id AS map_id, map.version AS map_version,
                  layer->>'layerId' AS layer_id, layer->>'title' AS title,
                  layer->>'description' AS description,
                  layer->'style'->'graduated'->>'field' AS style_field,
                  COALESCE(layer->'style'->'graduated', '{}'::jsonb) AS legend,
                  layer->>'geometryType' AS geometry_type,
                  layer->>'sourceType' AS map_source_type,
                  layer->'sourceVersion' AS source_version,
                  CASE WHEN layer->>'sourceType'='geojson-archive'
                    THEN layer #>> '{sourceConfiguration,authoritativeUrl}'
                    ELSE layer->>'sourceUrl' END AS provider_url,
                  md5((COALESCE(layer->'style','{}'::jsonb)-'combinedAnalysis')::text)
                    AS style_key
                FROM app.maps map
                CROSS JOIN LATERAL jsonb_array_elements(map.definition->'layers') layer
                WHERE dataset.can_read_maps AND map.organization_id=%s
                  AND map.project_id=dataset.project_id AND map.status='active'
                  AND layer->>'datasetId'=dataset.id::text
                ORDER BY layer->>'layerId', style_key, provider_url,
                  (layer->>'visible'='true') DESC, map.id
              ) view ON true
              LEFT JOIN LATERAL (
                SELECT revision.source_url, source.source_type::text AS source_type,
                  revision.version_number,
                  CASE WHEN source.source_type::text IN ('imageserver','mapserver','cog')
                    THEN 'Raster'
                    ELSE revision.configuration->>'geometry_type' END AS geometry_type
                FROM app.external_sources source
                JOIN app.external_source_revisions revision
                  ON revision.organization_id=source.organization_id
                  AND revision.dataset_id=source.dataset_id
                WHERE dataset.can_read_maps AND view.map_id IS NULL AND dataset.status='active'
                  AND source.organization_id=dataset.organization_id
                  AND source.dataset_id=dataset.id
                  AND source.source_type::text IN ('arcgis','wfs','imageserver','mapserver','cog')
                  AND source.access_mode::text='direct_browser'
                  AND source.credential_mode::text='none'
                ORDER BY revision.version_number DESC LIMIT 1
              ) connection ON true
            )
            SELECT id, name, project_id, project_name, format, classification,
              source_type, updated_at, map_id, map_version, layer_id, title,
              layer_description, style_field, legend, geometry_type, style_key,
              provider_url, map_source_type, source_version
            FROM entries
            WHERE (%s::text IS NULL OR
              strpos(lower(concat_ws(' ',title,layer_description,name,style_field)), lower(%s)) > 0)
            ORDER BY lower(title), id, project_id, layer_id, style_key, provider_url
            LIMIT %s OFFSET %s
            """,
            (
                context.organization_id,
                context.user_id,
                context.organization_id,
                project_id,
                project_id,
                client_id,
                client_id,
                classification,
                classification,
                context.organization_id,
                query,
                query,
                limit,
                offset,
            ),
        )
        fields = (
            "dataset_id",
            "dataset_name",
            "project_id",
            "project_name",
            "format",
            "classification",
            "source_type",
            "updated_at",
            "map_id",
            "map_version",
            "layer_id",
            "title",
            "description",
            "style_field",
            "legend",
            "geometry_type",
            "style_key",
        )
        records = []
        for row in rows:
            record = dict(zip(fields, row[:-3], strict=True))
            record["service"] = catalog_service_reference(
                row[-3], "wfs" if record["source_type"] == "wfs" else row[-2], row[-1]
            )
            records.append(record)
        return records

    return await executor.run(context, operation)
