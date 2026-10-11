"""Explicit revocable releases, separate from Artifact registration/current."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from opengeo_api.tenant_database import TenantTransaction

if TYPE_CHECKING:
    from opengeo_api.rendering import PostgresRenderRepository

from uuid import UUID

from opengeo_api.authorization import Action
from opengeo_api.project_artifacts import _edition_manifest
from opengeo_api.rendering import RenderConflict, RenderNotFound
from opengeo_api.saved_map_publication import load_saved_map_seal
from opengeo_api.tenant_database import TenantContext


async def _target(
    tx: TenantTransaction, context: TenantContext, artifact_id: UUID, version: int
) -> tuple[Any, ...]:
    row = await tx.fetch_one(
        """SELECT a.resource_id,a.map_id,r.project_id,v.render_job_id,
           binding.resource_version_id,job.output_object_id,job.state,
           object.bucket,object.object_key,object.s3_version_id,object.content_type,
           object.size_bytes,object.checksum_sha256
           FROM app.project_artifacts a
           JOIN app.project_artifact_versions v ON v.organization_id=a.organization_id
             AND v.artifact_id=a.id AND v.version_number=%s
           JOIN app.governed_resources r ON r.organization_id=a.organization_id
             AND r.id=a.resource_id
           JOIN app.map_render_job_bindings binding ON binding.organization_id=a.organization_id
             AND binding.render_job_id=v.render_job_id AND binding.resource_id=a.resource_id
           JOIN app.map_render_jobs job ON job.organization_id=a.organization_id
             AND job.id=v.render_job_id
           JOIN app.data_objects object ON object.organization_id=job.organization_id
             AND object.id=job.output_object_id
             AND object.checksum_sha256=v.manifest#>>'{output,checksumSha256}'
             AND object.content_type=v.manifest#>>'{output,mediaType}'
             AND object.size_bytes=(v.manifest#>>'{output,sizeBytes}')::bigint
           WHERE a.organization_id=%s AND a.id=%s AND a.representation='saved-map-image'""",
        (version, context.organization_id, artifact_id),
    )
    if row is None:
        row = await tx.fetch_one(
            """SELECT a.resource_id,a.map_id,r.project_id,NULL,NULL,object.id,'completed',
               object.bucket,object.object_key,object.s3_version_id,object.content_type,
               object.size_bytes,object.checksum_sha256,v.manifest,v.origin_map_version,
               history.definition
               FROM app.project_artifacts a
               JOIN app.project_artifact_versions v ON v.organization_id=a.organization_id
                 AND v.artifact_id=a.id AND v.version_number=%s AND v.origin_map_id=a.map_id
               JOIN app.governed_resources r ON r.organization_id=a.organization_id
                 AND r.id=a.resource_id AND r.map_id=a.map_id AND r.state<>'archived'
               JOIN app.maps map ON map.organization_id=a.organization_id AND map.id=a.map_id
                 AND map.project_id=r.project_id AND map.status='active'
               JOIN app.map_versions history ON history.organization_id=map.organization_id
                 AND history.map_id=map.id AND history.version=v.origin_map_version
               JOIN app.project_artifact_objects object
                 ON object.organization_id=a.organization_id AND object.artifact_id=a.id
                 AND object.id=v.portable_object_id
                 AND object.checksum_sha256=v.manifest#>>'{output,checksumSha256}'
                 AND object.content_type=v.manifest#>>'{output,mediaType}'
                 AND object.size_bytes=(v.manifest#>>'{output,sizeBytes}')::bigint
               WHERE a.organization_id=%s AND a.id=%s AND a.representation='portable-map-html'
                 AND v.manifest_checksum_sha256=v.manifest->>'manifestChecksumSha256'""",
            (version, context.organization_id, artifact_id),
        )
        if row is None:
            raise RenderNotFound("artifact_release_target")
        if row[10] != "text/html" or not 0 < row[11] <= 4 * 1024 * 1024:
            raise RenderConflict("artifact_release_output_unavailable")
        return row
    if row[6] != "completed" or row[10] not in {"image/png", "image/jpeg"}:
        raise RenderConflict("artifact_release_output_unavailable")
    if not 0 < row[11] <= 16 * 1024 * 1024:
        raise RenderConflict("artifact_release_output_size")
    return row


async def _public_seal(
    tx: TenantTransaction, context: TenantContext, target: tuple[Any, ...]
) -> None:
    if target[10] == "text/html":
        from opengeo_api.portable_artifact_publication import public_portable_seal

        await public_portable_seal(tx, context, target)
        return
    await load_saved_map_seal(tx, context, target[2], target[0], target[4], target[3], public=True)


async def create_release(
    repository: PostgresRenderRepository,
    context: TenantContext,
    artifact_id: UUID,
    version: int,
    title: str,
    license: str,
    attribution: str,
    creation_key: UUID | None = None,
) -> dict[str, Any]:
    async def operation(tx: TenantTransaction) -> dict[str, Any]:
        target = await _target(tx, context, artifact_id, version)
        repository._require(
            Action.RESOURCE_PUBLISH,
            await repository._resource_roles(tx, context, target[2], target[0]),
        )
        # Revalidate retained manifest privately as well as current public source eligibility.
        await _edition_manifest(repository, tx, context, target[2], target[0], artifact_id, version)
        await _public_seal(tx, context, target)
        if creation_key is not None:
            await tx.fetch_one(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 127))::text",
                (f"{context.organization_id}/{context.user_id}/{creation_key}",),
            )
            previous = await tx.fetch_one(
                """SELECT id,artifact_id,version_number,title,license,attribution,revoked_at
                FROM app.project_artifact_releases
                WHERE organization_id=%s AND created_by=%s AND creation_key=%s""",
                (context.organization_id, context.user_id, creation_key),
            )
            if previous is not None:
                if previous[1:6] != (artifact_id, version, title, license, attribution):
                    raise RenderConflict("artifact_release_creation_key_conflict")
                if previous[6] is not None:
                    raise RenderConflict("artifact_release_already_revoked")
                return {
                    "id": str(previous[0]),
                    "artifact_id": str(artifact_id),
                    "version_number": version,
                }
        row = await tx.fetch_one(
            """INSERT INTO app.project_artifact_releases
            (organization_id,artifact_id,version_number,title,license,attribution,created_by,creation_key)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
            (
                context.organization_id,
                artifact_id,
                version,
                title,
                license,
                attribution,
                context.user_id,
                creation_key,
            ),
        )
        if row is None:
            raise RenderConflict("artifact_release_insert_failed")
        return {"id": str(row[0]), "artifact_id": str(artifact_id), "version_number": version}

    return await repository._run(context, operation)


async def revoke_release(
    repository: PostgresRenderRepository, context: TenantContext, release_id: UUID
) -> dict[str, Any]:
    async def operation(tx: TenantTransaction) -> dict[str, Any]:
        row = await tx.fetch_one(
            """SELECT a.resource_id,r.project_id,release.revoked_at
            FROM app.project_artifact_releases release
            JOIN app.project_artifacts a ON a.organization_id=release.organization_id
              AND a.id=release.artifact_id
            JOIN app.governed_resources r ON r.organization_id=a.organization_id
              AND r.id=a.resource_id
            WHERE release.organization_id=%s AND release.id=%s FOR UPDATE OF release""",
            (context.organization_id, release_id),
        )
        if row is None:
            raise RenderNotFound("artifact_release")
        repository._require(
            Action.RESOURCE_PUBLISH, await repository._resource_roles(tx, context, row[1], row[0])
        )
        if row[2] is None:
            await tx.execute(
                "UPDATE app.project_artifact_releases SET revoked_at=clock_timestamp(),"
                "revoked_by=%s WHERE organization_id=%s AND id=%s",
                (context.user_id, context.organization_id, release_id),
            )
        return {"id": str(release_id), "revoked": True}

    return await repository._run(context, operation)


async def read_release(
    repository: PostgresRenderRepository,
    organization_id: UUID,
    release_id: UUID,
    *,
    transaction: TenantTransaction | None = None,
) -> tuple[dict[str, Any], tuple[Any, ...]]:
    context = TenantContext(UUID(int=0), organization_id)

    async def operation(tx: TenantTransaction) -> tuple[dict[str, Any], tuple[Any, ...]]:
        row = await tx.fetch_one(
            """SELECT artifact_id,version_number,title,license,attribution
            FROM app.project_artifact_releases WHERE organization_id=%s AND id=%s
            AND revoked_at IS NULL""",
            (organization_id, release_id),
        )
        if row is None:
            raise RenderNotFound("artifact_release")
        target = await _target(tx, context, row[0], row[1])
        await _public_seal(tx, context, target)
        return (
            {
                "id": str(release_id),
                "artifact_id": str(row[0]),
                "version_number": row[1],
                "project_id": str(target[1]),
                "title": row[2],
                "license": row[3],
                "attribution": row[4],
                "media_type": target[10],
                **(
                    {"network_required": bool(target[13].get("networkDependencies"))}
                    if target[10] == "text/html"
                    else {}
                ),
            },
            target,
        )

    if transaction is not None:
        return await operation(transaction)
    return await repository._run(context, operation)


async def list_releases(
    repository: PostgresRenderRepository,
    context: TenantContext,
    artifact_id: UUID,
    limit: int,
    offset: int,
) -> dict[str, Any]:
    from opengeo_api.authorization import is_allowed

    async def operation(tx: TenantTransaction) -> dict[str, Any]:
        target = await tx.fetch_one(
            """SELECT a.resource_id,r.project_id,a.representation FROM app.project_artifacts a
            JOIN app.governed_resources r ON r.organization_id=a.organization_id
              AND r.id=a.resource_id WHERE a.organization_id=%s AND a.id=%s""",
            (context.organization_id, artifact_id),
        )
        if target is None:
            raise RenderNotFound("artifact")
        roles = await repository._resource_roles(tx, context, target[1], target[0])
        repository._require(Action.RENDER_READ, roles)
        rows = await tx.fetch_all(
            """SELECT release.id,release.version_number,release.title,release.license,
               release.attribution,release.created_at,release.revoked_at,
               CASE WHEN edition.manifest->'networkDependencies' IS NOT NULL
                 THEN jsonb_array_length(edition.manifest->'networkDependencies')>0 ELSE false END
            FROM app.project_artifact_releases release
            JOIN app.project_artifact_versions edition
            ON edition.organization_id=release.organization_id

              AND edition.artifact_id=release.artifact_id
              AND edition.version_number=release.version_number
            WHERE release.organization_id=%s AND release.artifact_id=%s
            ORDER BY release.created_at DESC,release.id DESC LIMIT %s OFFSET %s""",
            (context.organization_id, artifact_id, limit + 1, offset),
        )
        return {
            "can_publish": is_allowed(Action.RESOURCE_PUBLISH, roles),
            "has_more": len(rows) > limit,
            "records": [
                {
                    "id": str(row[0]),
                    "version_number": row[1],
                    "representation": target[2],
                    "network_required": bool(row[7]),
                    "title": row[2],
                    "license": row[3],
                    "attribution": row[4],
                    "created_at": row[5].isoformat(),
                    "revoked_at": row[6].isoformat() if row[6] else None,
                }
                for row in rows[:limit]
            ],
        }

    return await repository._run(context, operation)
