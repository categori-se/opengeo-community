"""Bounded upload intents for portable snapshots; no implicit compilation or publication."""

from typing import Any
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.authorization import Action
from opengeo_api.portable_artifact_registration import authorize_portable_origin
from opengeo_api.portable_artifacts import validate_portable_manifest
from opengeo_api.rendering import PostgresRenderRepository, RenderConflict
from opengeo_api.s3_uploads import UploadSpec, UploadStorage
from opengeo_api.tenant_database import TenantContext, TenantTransaction


async def request_portable_upload(
    repository: PostgresRenderRepository,
    storage: UploadStorage,
    context: TenantContext,
    project_id: UUID,
    resource_id: UUID,
    manifest_bytes: bytes,
    expected_revision: int,
) -> dict[str, Any]:
    if type(expected_revision) is not int or not 0 <= expected_revision < 2_147_483_647:
        raise RenderConflict("artifact_revision_invalid")
    try:
        manifest = validate_portable_manifest(manifest_bytes)
        origin = manifest["provenance"]["originatingProject"]
        if not isinstance(origin, dict) or not isinstance(origin.get("id"), str):
            raise ValueError("invalid origin")
        map_id = UUID(origin["id"])
        map_version = origin["version"]
        if type(map_version) is not int or not 0 < map_version < 2**63:
            raise ValueError("invalid version")
    except (KeyError, TypeError, ValueError) as error:
        raise RenderConflict("artifact_portable_input_invalid") from error

    async def operation(transaction: TenantTransaction) -> dict[str, Any]:
        repository._require(
            Action.RENDER_CONFIGURE,
            await repository._resource_roles(transaction, context, project_id, resource_id),
        )
        await authorize_portable_origin(
            repository, transaction, context, project_id, resource_id, manifest, map_id, map_version
        )
        await transaction.execute(
            """INSERT INTO app.project_artifacts
               (organization_id, id, resource_id, map_id, representation, created_by)
               VALUES (%s, %s, %s, %s, 'portable-map-html', %s)
               ON CONFLICT (organization_id, resource_id, representation) DO NOTHING""",
            (context.organization_id, uuid4(), resource_id, map_id, context.user_id),
        )
        artifact = await transaction.fetch_one(
            """SELECT id, revision FROM app.project_artifacts
               WHERE organization_id = %s AND resource_id = %s AND map_id = %s
                 AND representation = 'portable-map-html' FOR UPDATE""",
            (context.organization_id, resource_id, map_id),
        )
        if artifact is None or artifact[1] != expected_revision:
            raise RenderConflict("artifact_revision_conflict")
        pending = await transaction.fetch_one(
            """SELECT count(*) FROM app.project_artifact_upload_intents
               WHERE organization_id = %s AND artifact_id = %s AND created_by = %s
                 AND completed_object_id IS NULL AND expires_at > clock_timestamp()""",
            (context.organization_id, artifact[0], context.user_id),
        )
        if pending is None or pending[0] >= 3:
            raise RenderConflict("artifact_pending_upload_limit")
        upload_id = uuid4()
        key = (
            f"organizations/{context.organization_id}/projects/{project_id}/"
            f"artifacts/{artifact[0]}/uploads/{upload_id}/map.html"
        )
        output = manifest["output"]
        form = await storage.create_upload_form(
            UploadSpec(
                key=key,
                content_type="text/html",
                size_bytes=output["sizeBytes"],
                checksum_sha256=output["checksumSha256"],
            )
        )
        await transaction.execute(
            """INSERT INTO app.project_artifact_upload_intents
               (organization_id, artifact_id, id, manifest, expected_revision,
                expected_size_bytes, expected_sha256, bucket, object_key, created_by, expires_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                context.organization_id,
                artifact[0],
                upload_id,
                Jsonb(manifest),
                expected_revision,
                output["sizeBytes"],
                output["checksumSha256"],
                storage.bucket,
                key,
                context.user_id,
                form.expires_at,
            ),
        )
        return {
            "upload_id": str(upload_id),
            "artifact_id": str(artifact[0]),
            "url": form.url,
            "method": form.method,
            "fields": dict(form.fields),
            "expires_at": form.expires_at,
        }

    return await repository._run(context, operation)


async def complete_portable_upload(
    repository: PostgresRenderRepository,
    storage: UploadStorage,
    context: TenantContext,
    project_id: UUID,
    resource_id: UUID,
    upload_id: UUID,
) -> dict[str, Any]:
    """Retain verified bytes atomically with completion; completed retries perform no I/O."""
    import json

    from opengeo_api.portable_artifacts import MAX_HTML_BYTES, validate_portable_bytes
    from opengeo_api.rendering import RenderNotFound
    from opengeo_api.s3_downloads import ExactObjectSpec

    async def load(transaction: TenantTransaction, *, lock: bool = False) -> tuple[Any, ...]:
        repository._require(
            Action.RENDER_CONFIGURE,
            await repository._resource_roles(transaction, context, project_id, resource_id),
        )
        row = await transaction.fetch_one(
            """SELECT intent.artifact_id, intent.manifest, intent.expected_revision,
                      intent.expected_size_bytes, intent.expected_sha256, intent.bucket,
                      intent.object_key, intent.completed_object_id
               FROM app.project_artifact_upload_intents intent
               JOIN app.project_artifacts artifact
                 ON artifact.organization_id = intent.organization_id
                AND artifact.id = intent.artifact_id
               JOIN app.governed_resources resource
                 ON resource.organization_id = artifact.organization_id
                AND resource.id = artifact.resource_id
               WHERE intent.organization_id = %s AND intent.id = %s AND intent.created_by = %s
                 AND resource.project_id = %s AND resource.id = %s
                 AND artifact.representation = 'portable-map-html' AND resource.state <> 'archived'
                 AND (intent.completed_object_id IS NOT NULL
                      OR intent.expires_at > clock_timestamp())"""
            + (" FOR UPDATE OF intent" if lock else ""),
            (context.organization_id, upload_id, context.user_id, project_id, resource_id),
        )
        if row is None:
            raise RenderNotFound("artifact_upload")
        manifest = row[1]
        try:
            validate_portable_manifest(
                json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode()
            )
            origin = manifest["provenance"]["originatingProject"]
            map_id = UUID(origin["id"])
        except (ValueError, KeyError, TypeError, AttributeError) as error:
            raise RenderConflict("artifact_portable_input_invalid") from error
        await authorize_portable_origin(
            repository,
            transaction,
            context,
            project_id,
            resource_id,
            manifest,
            map_id,
            origin["version"],
        )
        return row

    def receipt(row: tuple[Any, ...], output_id: UUID) -> dict[str, Any]:
        return {
            "upload_id": str(upload_id),
            "artifact_id": str(row[0]),
            "output_object_id": str(output_id),
            "expected_revision": row[2],
            "manifest": row[1],
        }

    async def preauthorize(transaction: TenantTransaction) -> tuple[Any, ...]:
        return await load(transaction)

    intent = await repository._run(context, preauthorize)
    if intent[7] is not None:
        return receipt(intent, intent[7])
    if storage.bucket != intent[5]:
        raise RenderConflict("artifact_upload_bucket_unavailable")
    stored = await storage.inspect_object(intent[6])
    if (
        (stored.bucket, stored.key, stored.content_type, stored.size_bytes, stored.checksum_sha256)
        != (intent[5], intent[6], "text/html", intent[3], intent[4])
        or not stored.version_id
        or stored.version_id == "null"
    ):
        raise RenderConflict("artifact_upload_object_mismatch")
    exact = await repository._artifact_downloads.read_exact_object(
        ExactObjectSpec(
            bucket=stored.bucket,
            key=stored.key,
            version_id=stored.version_id,
            content_type="text/html",
            size_bytes=stored.size_bytes,
            checksum_sha256=stored.checksum_sha256,
            maximum_bytes=MAX_HTML_BYTES,
        )
    )
    try:
        validate_portable_bytes(
            exact.body, json.dumps(intent[1], ensure_ascii=False, separators=(",", ":")).encode()
        )
    except ValueError as error:
        raise RenderConflict("artifact_upload_bytes_invalid") from error

    async def retain(transaction: TenantTransaction) -> dict[str, Any]:
        current = await load(transaction, lock=True)
        if current[7] is not None:
            return receipt(current, current[7])
        if current[:7] != intent[:7]:
            raise RenderConflict("artifact_upload_changed")
        output_id = uuid4()
        await transaction.execute(
            """INSERT INTO app.project_artifact_objects
               (organization_id, artifact_id, id, bucket, object_key, s3_version_id,
                etag, content_type, size_bytes, checksum_sha256, created_by)
               VALUES (%s, %s, %s, %s, %s, %s, %s, 'text/html', %s, %s, %s)""",
            (
                context.organization_id,
                intent[0],
                output_id,
                stored.bucket,
                stored.key,
                stored.version_id,
                stored.etag,
                stored.size_bytes,
                stored.checksum_sha256,
                context.user_id,
            ),
        )
        await transaction.execute(
            """UPDATE app.project_artifact_upload_intents
               SET completed_object_id = %s, completed_at = clock_timestamp()
               WHERE organization_id = %s AND id = %s""",
            (output_id, context.organization_id, upload_id),
        )
        return receipt(current, output_id)

    return await repository._run(context, retain)
