"""Register verified retained portable output; upload/finalization owns storage I/O."""

from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb

from opengeo_api.authorization import Action
from opengeo_api.portable_artifacts import validate_portable_bytes, validate_portable_origin
from opengeo_api.rendering import PostgresRenderRepository, RenderConflict, RenderNotFound
from opengeo_api.tenant_database import TenantContext, TenantTransaction
from opengeo_api.workspaces import PostgresWorkspaceRepository, WorkspaceConflict


async def register_portable_edition(
    repository: PostgresRenderRepository,
    context: TenantContext,
    project_id: UUID,
    resource_id: UUID,
    output_object_id: UUID,
    html: bytes,
    manifest_bytes: bytes,
    expected_revision: int,
) -> dict[str, Any]:
    """Caller supplies bytes read from the exact retained storage version, not a URL.

    No object metadata is created from this input. The retained object must already
    belong to the authorized Artifact. Snapshot provenance is never upgraded to a
    server compilation claim. Output access must reauthorize dependencies separately.
    """
    if type(expected_revision) is not int or not 0 <= expected_revision < 2_147_483_647:
        raise RenderConflict("artifact_revision_invalid")
    try:
        manifest = validate_portable_bytes(html, manifest_bytes)
        origin = manifest["provenance"]["originatingProject"]
        if not isinstance(origin, dict) or not isinstance(origin.get("id"), str):
            raise ValueError("artifact_saved_origin_invalid")
        map_id = UUID(origin["id"])
        map_version = origin["version"]
        if type(map_version) is not int or not 0 < map_version < 2**63:
            raise ValueError("artifact_saved_origin_invalid")
    except (ValueError, KeyError, TypeError) as error:
        raise RenderConflict("artifact_portable_input_invalid") from error

    async def operation(transaction: TenantTransaction) -> dict[str, Any]:
        repository._require(
            Action.RENDER_CONFIGURE,
            await repository._resource_roles(transaction, context, project_id, resource_id),
        )
        await authorize_portable_origin(
            repository, transaction, context, project_id, resource_id, manifest, map_id, map_version
        )
        artifact = await transaction.fetch_one(
            """SELECT id, revision, current_version_number FROM app.project_artifacts
               WHERE organization_id = %s AND resource_id = %s AND map_id = %s
                 AND representation = 'portable-map-html' FOR UPDATE""",
            (context.organization_id, resource_id, map_id),
        )
        if artifact is None:
            raise RenderNotFound("artifact")
        retained = await transaction.fetch_one(
            """SELECT content_type, size_bytes, checksum_sha256
               FROM app.project_artifact_objects
               WHERE organization_id = %s AND artifact_id = %s AND id = %s""",
            (context.organization_id, artifact[0], output_object_id),
        )
        output = manifest["output"]
        if retained is None or tuple(retained) != (
            "text/html",
            len(html),
            output["checksumSha256"],
        ):
            raise RenderConflict("artifact_retained_output_mismatch")
        existing = await transaction.fetch_one(
            """SELECT version_number FROM app.project_artifact_versions
               WHERE organization_id = %s AND artifact_id = %s
                 AND manifest_checksum_sha256 = %s AND portable_object_id IS NOT NULL""",
            (context.organization_id, artifact[0], manifest["manifestChecksumSha256"]),
        )
        summary = {
            "id": str(artifact[0]),
            "revision": artifact[1],
            "current_version_number": artifact[2],
        }
        if existing is not None:
            return {**summary, "version_number": existing[0], "reused": True}
        if artifact[1] != expected_revision:
            raise RenderConflict("artifact_revision_conflict")
        number = await transaction.fetch_one(
            """SELECT COALESCE(MAX(version_number), 0) + 1 FROM app.project_artifact_versions
               WHERE organization_id = %s AND artifact_id = %s""",
            (context.organization_id, artifact[0]),
        )
        assert number is not None
        await transaction.execute(
            """INSERT INTO app.project_artifact_versions
               (organization_id, artifact_id, version_number, portable_object_id,
                origin_map_id, origin_map_version, manifest, manifest_checksum_sha256, created_by)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                context.organization_id,
                artifact[0],
                number[0],
                output_object_id,
                map_id,
                map_version,
                Jsonb(manifest),
                manifest["manifestChecksumSha256"],
                context.user_id,
            ),
        )
        await transaction.execute(
            """UPDATE app.project_artifacts SET revision = revision + 1,
               updated_at = clock_timestamp(), updated_by = %s
               WHERE organization_id = %s AND id = %s""",
            (context.user_id, context.organization_id, artifact[0]),
        )
        return {
            **summary,
            "revision": artifact[1] + 1,
            "version_number": number[0],
            "reused": False,
        }

    return await repository._run(context, operation)


async def authorize_portable_origin(
    repository: PostgresRenderRepository,
    transaction: TenantTransaction,
    context: TenantContext,
    project_id: UUID,
    resource_id: UUID,
    manifest: dict[str, Any],
    map_id: UUID,
    map_version: int,
) -> None:
    saved = await transaction.fetch_one(
        """SELECT history.definition FROM app.governed_resources resource
           JOIN app.maps map ON map.organization_id = resource.organization_id
             AND map.project_id = resource.project_id AND map.id = resource.map_id
           JOIN app.map_versions history ON history.organization_id = map.organization_id
             AND history.map_id = map.id AND history.version = %s
           WHERE resource.organization_id = %s AND resource.project_id = %s
             AND resource.id = %s AND resource.kind = 'map' AND resource.state <> 'archived'
             AND map.id = %s AND map.status = 'active'
           FOR SHARE OF resource, map""",
        (map_version, context.organization_id, project_id, resource_id, map_id),
    )
    if saved is None:
        raise RenderNotFound("artifact_saved_origin")
    try:
        validate_portable_origin(
            manifest, map_id=map_id, map_version=map_version, definition=saved[0]
        )
    except ValueError as error:
        raise RenderConflict("artifact_saved_origin_mismatch") from error
    # Reuse the exact saved-composition reference validator in this transaction.
    try:
        await PostgresWorkspaceRepository(repository._executor)._require_map_definition_references(
            transaction, context, project_id, saved[0]
        )
    except WorkspaceConflict as error:
        raise RenderConflict("artifact_source_reference_unavailable") from error


async def register_retained_portable_edition(
    repository: PostgresRenderRepository,
    context: TenantContext,
    project_id: UUID,
    resource_id: UUID,
    output_object_id: UUID,
    manifest_bytes: bytes,
    expected_revision: int,
) -> dict[str, Any]:
    """Read only authorized retained coordinates, then register with fresh authority."""
    from opengeo_api.portable_artifacts import (
        MAX_HTML_BYTES,
        MAX_MANIFEST_BYTES,
        validate_portable_manifest,
    )
    from opengeo_api.s3_downloads import ExactObjectSpec

    if not 0 < len(manifest_bytes) <= MAX_MANIFEST_BYTES:
        raise RenderConflict("artifact_manifest_size_invalid")
    if type(expected_revision) is not int or not 0 <= expected_revision < 2_147_483_647:
        raise RenderConflict("artifact_revision_invalid")

    try:
        requested_manifest = validate_portable_manifest(manifest_bytes)
    except ValueError as error:
        raise RenderConflict("artifact_portable_input_invalid") from error

    async def preauthorize(transaction: TenantTransaction) -> ExactObjectSpec | dict[str, Any]:
        repository._require(
            Action.RENDER_CONFIGURE,
            await repository._resource_roles(transaction, context, project_id, resource_id),
        )
        row = await transaction.fetch_one(
            """SELECT output.bucket, output.object_key, output.s3_version_id,
                      output.content_type, output.size_bytes, output.checksum_sha256,
                      artifact.id, artifact.revision, artifact.current_version_number,
                      edition.version_number
               FROM app.project_artifact_objects output
               JOIN app.project_artifacts artifact
                 ON artifact.organization_id = output.organization_id
                AND artifact.id = output.artifact_id
               JOIN app.governed_resources resource
                 ON resource.organization_id = artifact.organization_id
                AND resource.id = artifact.resource_id
               LEFT JOIN app.project_artifact_versions edition
                 ON edition.organization_id = artifact.organization_id
                AND edition.artifact_id = artifact.id AND edition.portable_object_id = output.id
                AND edition.manifest_checksum_sha256 = %s
               WHERE artifact.organization_id = %s AND artifact.resource_id = %s
                 AND artifact.representation = 'portable-map-html'
                 AND resource.project_id = %s AND resource.state <> 'archived'
                 AND output.id = %s""",
            (
                requested_manifest["manifestChecksumSha256"],
                context.organization_id,
                resource_id,
                project_id,
                output_object_id,
            ),
        )
        if row is None:
            raise RenderNotFound("artifact_retained_output")
        if row[3] != "text/html" or not 0 < row[4] <= MAX_HTML_BYTES:
            raise RenderConflict("artifact_retained_output_mismatch")
        if row[9] is not None:
            from opengeo_api.project_artifacts import _edition_manifest

            retained_manifest = await _edition_manifest(
                repository, transaction, context, project_id, resource_id, row[6], row[9]
            )
            if retained_manifest != requested_manifest:
                raise RenderConflict("artifact_manifest_changed")
            return {
                "id": str(row[6]),
                "revision": row[7],
                "current_version_number": row[8],
                "version_number": row[9],
                "reused": True,
            }
        return ExactObjectSpec(
            bucket=row[0],
            key=row[1],
            version_id=row[2],
            content_type=row[3],
            size_bytes=row[4],
            checksum_sha256=row[5],
            maximum_bytes=MAX_HTML_BYTES,
        )

    spec = await repository._run(context, preauthorize)
    if isinstance(spec, dict):
        return spec
    # Existing storage implementation verifies version, type, size, SHA-256 and
    # response bounds, without redirects or caller-supplied storage coordinates.
    stored = await repository._artifact_downloads.read_exact_object(spec)
    return await register_portable_edition(
        repository,
        context,
        project_id,
        resource_id,
        output_object_id,
        stored.body,
        manifest_bytes,
        expected_revision,
    )
