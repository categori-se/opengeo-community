"""Current public eligibility for retained managed-vector/live-raster snapshots.

The publisher asserts output terms separately. Browser provenance is preserved;
these checks do not turn that snapshot into a server-attested compilation.
"""

import json
import re
from typing import Any
from urllib.parse import urlencode, urlsplit
from uuid import UUID

from psycopg.types.json import Jsonb

from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.map_definitions import external_map_configuration
from opengeo_api.portable_artifacts import validate_portable_manifest, validate_portable_origin
from opengeo_api.rendering import RenderConflict
from opengeo_api.saved_map_publication import PUBLIC_SAVED_MAP_LICENSES
from opengeo_api.tenant_database import TenantContext, TenantTransaction


def _public_origin(url: str) -> str:
    parsed = urlsplit(url)
    host = (parsed.hostname or "").lower().rstrip(".")
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or parsed.fragment
        or parsed.port not in (None, 443)
        or not host
        or "." not in host
        or ":" in host
        or re.fullmatch(r"[\d.]+", host)
        or host == "localhost"
        or host.endswith((".localhost", ".local", ".internal", ".home.arpa"))
        or host == "opengeo.tools"
        or host.endswith(".opengeo.tools")
        or re.search(
            r"token|key|secret|signature|credential|authorization|session", parsed.query, re.I
        )
        or re.search(r"/api(?:/|$)", parsed.path, re.I)
        or any(ord(char) < 33 or ord(char) == 127 or char in "\\\"<>'" for char in url)
    ):
        raise ValueError("nonpublic_tile_url")
    return f"https://{host}"


def _tile_url(layer: dict[str, Any]) -> str:
    url: str = layer["sourceUrl"]
    config: dict[str, Any] = layer["sourceConfiguration"]
    if layer["sourceType"] == "xyz-raster":
        if urlsplit(url).query or not all(token in url for token in ("{z}", "{x}", "{y}")):
            raise ValueError("invalid_xyz_url")
        return str(url)
    if layer["sourceType"] == "imageserver-raster":
        if urlsplit(url).query or not url.rstrip("/").endswith("/ImageServer"):
            raise ValueError("invalid_imageserver_url")
        query = {
            "f": "image",
            "bbox": "{bbox-epsg-3857}",
            "bboxSR": "3857",
            "imageSR": "3857",
            "size": f"{config['tileSize']},{config['tileSize']}",
            "format": config["imageFormat"],
            "interpolation": config["interpolation"],
            "adjustAspectRatio": "false",
        }
        if config.get("bandIds"):
            query["bandIds"] = ",".join(str(band) for band in config["bandIds"])
        raster_ids = config.get("rasterIds", [])
        if (
            not isinstance(raster_ids, list)
            or len(raster_ids) > 32
            or any(
                type(record_id) is not int or not 0 <= record_id <= 2147483647
                for record_id in raster_ids
            )
            or len(set(raster_ids)) != len(raster_ids)
        ):
            raise ValueError("invalid_raster_ids")
        if raster_ids:
            query["mosaicRule"] = json.dumps(
                {"mosaicMethod": "esriMosaicLockRaster", "lockRasterIds": raster_ids},
                separators=(",", ":"),
            )
        return (
            url.rstrip("/")
            + "/exportImage?"
            + urlencode(query).replace("%7Bbbox-epsg-3857%7D", "{bbox-epsg-3857}")
        )
    raise ValueError("unsupported_raster")


def public_portable_origins(manifest: dict[str, Any], definition: dict[str, Any]) -> list[str]:
    """CSP origins from exact saved source references, after public eligibility checks."""
    _, _, origins = _requested_sources(manifest, definition)
    return origins


def _requested_sources(
    manifest: dict[str, Any], definition: dict[str, Any]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    dependencies = manifest.get("dependencies")
    if not isinstance(dependencies, list) or not 1 <= len(dependencies) <= 128:
        raise RenderConflict("artifact_public_sources_unsupported")
    sources: dict[str, dict[str, Any]] = {}
    for layer in definition.get("layers", []):
        if layer.get("sourceType") == "governed-dataset" and layer.get("datasetVersionId"):
            key = f"dataset_{layer['datasetId']}_version_{layer['datasetVersionId']}-source"
        elif layer.get("sourceType") in ("xyz-raster", "imageserver-raster"):
            key = f"{layer['layerId']}-source"
        else:
            continue
        if key in sources and layer.get("styleReference"):
            sources[key] = layer
        else:
            sources.setdefault(key, layer)
    managed, referenced, network = [], [], []
    origins: set[str] = set()
    seen = set()
    for dependency in dependencies:
        if not isinstance(dependency, dict):
            raise RenderConflict("artifact_public_sources_unsupported")
        dependency_id = dependency.get("id")
        if not isinstance(dependency_id, str):
            raise RenderConflict("artifact_public_sources_unsupported")
        key = dependency_id
        layer = sources.get(key)
        if layer is None or key in seen or layer.get("styleReference") is not None:
            raise RenderConflict("artifact_public_sources_unsupported")
        seen.add(key)
        try:
            dataset_id = str(UUID(layer["datasetId"]))
            version = layer["sourceVersion"]
            if isinstance(version, bool) or not isinstance(version, int) or version < 1:
                raise ValueError("invalid_source_version")
            if layer["sourceType"] == "governed-dataset":
                if (
                    dependency.get("mode") != "embedded"
                    or dependency.get("mediaType") != "application/geo+json"
                    or dependency.get("accessUrls") != []
                ):
                    raise ValueError("unsupported_managed_source")
                managed.append(
                    {
                        "dataset_id": dataset_id,
                        "version_id": str(UUID(layer["datasetVersionId"])),
                        "version_number": version,
                    }
                )
            else:
                tile_url = _tile_url(layer)
                # Earlier browser snapshots unescaped the record-lock JSON too.
                # Accept only that exact historical representation, preserving
                # immutable saved definitions and editions without URL parsing.
                legacy_tile_url = (
                    tile_url.replace("%7B", "{").replace("%7D", "}")
                    if layer["sourceType"] == "imageserver-raster"
                    else tile_url
                )
                access_urls = dependency.get("accessUrls")
                origin = _public_origin(tile_url)
                if (
                    layer.get("tileUrl") not in (tile_url, legacy_tile_url)
                    or dependency.get("mode") != "live"
                    or dependency.get("mediaType") is not None
                    or access_urls not in ([tile_url], [legacy_tile_url])
                ):
                    raise ValueError("source_url_mismatch")
                referenced.append(
                    {
                        "dataset_id": dataset_id,
                        "version_number": version,
                        "source_type": layer["sourceType"].removesuffix("-raster"),
                        "source_url": layer["sourceUrl"],
                        "configuration": layer["sourceConfiguration"],
                    }
                )
                network.append({"id": key, "accessUrls": access_urls})
                origins.add(origin)
        except (ValueError, TypeError, KeyError) as error:
            raise RenderConflict("artifact_public_sources_unsupported") from error
    selected = manifest.get("build", {}).get("selectedSourceIds")
    if (
        not isinstance(selected, list)
        or any(not isinstance(key, str) for key in selected)
        or len(selected) != len(seen)
        or set(selected) != seen
        or manifest.get("networkDependencies") != network
    ):
        raise RenderConflict("artifact_public_sources_unsupported")
    return managed, referenced, sorted(origins)


async def public_portable_seal(
    tx: TenantTransaction, context: TenantContext, target: tuple[Any, ...]
) -> None:
    manifest, map_version, definition = target[13:16]
    try:
        validate_portable_manifest(canonical_json_bytes(manifest))
        validate_portable_origin(
            manifest, map_id=target[1], map_version=map_version, definition=definition
        )
    except (ValueError, TypeError, KeyError) as error:
        raise RenderConflict("artifact_public_origin_invalid") from error
    requested, referenced, _ = _requested_sources(manifest, definition)

    if requested:
        rows = await tx.fetch_all(
            """SELECT requested.dataset_id, requested.version_id
               FROM jsonb_to_recordset(%s::jsonb)
                 requested(dataset_id uuid,version_id uuid,version_number bigint)
               JOIN app.project_datasets attached ON attached.organization_id=%s
                 AND attached.project_id=%s AND attached.dataset_id=requested.dataset_id
               JOIN app.datasets dataset ON dataset.organization_id=attached.organization_id
                 AND dataset.id=attached.dataset_id AND dataset.status='active'
                 AND dataset.classification='public'
               JOIN app.dataset_versions version ON version.organization_id=dataset.organization_id
                 AND version.dataset_id=dataset.id AND version.id=requested.version_id
                 AND version.version_number=requested.version_number AND version.state='active'
               JOIN app.governed_resources resource
               ON resource.organization_id=dataset.organization_id
                 AND resource.project_id=attached.project_id AND resource.dataset_id=dataset.id
                 AND resource.kind='dataset' AND resource.state='published'
                 AND resource.visibility='public'
               JOIN app.governed_resource_versions metadata
                 ON metadata.organization_id=resource.organization_id
                 AND metadata.resource_id=resource.id AND metadata.id=resource.current_version_id
                 AND metadata.license=ANY(%s::text[]) AND length(trim(metadata.attribution))>0
                 AND metadata.provenance->>'datasetVersionId'=requested.version_id::text""",
            (
                Jsonb(requested),
                context.organization_id,
                target[2],
                sorted(PUBLIC_SAVED_MAP_LICENSES),
            ),
        )
        expected = {(item["dataset_id"], item["version_id"]) for item in requested}
        if {(str(row[0]), str(row[1])) for row in rows} != expected:
            raise RenderConflict("artifact_source_not_public")

    if referenced:
        # Referencing a public provider does not redistribute its image bytes.
        # Require the owner's published metadata decision bound to this exact
        # external revision, independently of the output's own license.
        rows = await tx.fetch_all(
            """SELECT requested.dataset_id, requested.version_number,revision.configuration
               FROM jsonb_to_recordset(%s::jsonb) requested(dataset_id uuid,
                 version_number bigint,source_type text,source_url text,configuration jsonb)
               JOIN app.project_datasets attached ON attached.organization_id=%s
                 AND attached.project_id=%s AND attached.dataset_id=requested.dataset_id
               JOIN app.datasets dataset ON dataset.organization_id=attached.organization_id
                 AND dataset.id=attached.dataset_id AND dataset.status='active'
                 AND dataset.classification='public'
               JOIN app.external_sources source ON source.organization_id=dataset.organization_id
                 AND source.dataset_id=dataset.id AND source.source_type::text=requested.source_type
                 AND source.access_mode='direct_browser' AND source.credential_mode='none'
               JOIN app.external_source_revisions revision
                 ON revision.organization_id=source.organization_id
                 AND revision.dataset_id=source.dataset_id
                 AND revision.version_number=requested.version_number
                 AND revision.source_url=requested.source_url
               JOIN app.governed_resources resource
               ON resource.organization_id=dataset.organization_id
                 AND resource.project_id=attached.project_id AND resource.dataset_id=dataset.id

                 AND resource.kind='dataset' AND resource.state='published'
                 AND resource.visibility='public'
               JOIN app.governed_resource_versions metadata
                 ON metadata.organization_id=resource.organization_id
                 AND metadata.resource_id=resource.id

                 AND metadata.id=resource.current_version_id
                 AND length(trim(metadata.attribution))>0
                 AND length(trim(metadata.license))>0
                 AND metadata.provenance->>'externalSourceVersion'=requested.version_number::text
                 AND metadata.provenance->>'externalSourceUrl'=requested.source_url""",
            (Jsonb(referenced), context.organization_id, target[2]),
        )
        expected_references = {(item["dataset_id"], item["version_number"]) for item in referenced}
        configurations = {(item["dataset_id"], item["version_number"]): item for item in referenced}
        if {(str(row[0]), row[1]) for row in rows} != expected_references or any(
            external_map_configuration(configurations[(str(row[0]), row[1])]["source_type"], row[2])
            != configurations[(str(row[0]), row[1])]["configuration"]
            for row in rows
        ):
            raise RenderConflict("artifact_source_not_public")
