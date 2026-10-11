"""Register and inspect immutable Project output without rebuilding it.

Manifest reads fetch no bytes. Registration preserves a completed render edition;
selecting the stable Artifact's current version is a separate optimistic write.
Neither action grants distribution rights or publishes output.
"""

import json
from hashlib import sha256
from typing import Any
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.authorization import Action
from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.rendering import PostgresRenderRepository, RenderConflict, RenderNotFound
from opengeo_api.s3_downloads import DownloadSpec, DownloadTicket
from opengeo_api.saved_map_publication import load_saved_map_seal
from opengeo_api.tenant_database import TenantContext, TenantTransaction


async def read_project_artifact(
    repository: PostgresRenderRepository,
    context: TenantContext,
    access_container_id: UUID,
    resource_id: UUID,
    job_id: UUID,
) -> dict[str, Any]:
    async def operation(transaction: TenantTransaction) -> dict[str, Any]:
        return await _manifest(
            repository, transaction, context, access_container_id, resource_id, job_id
        )

    return await repository._run(context, operation)


async def _manifest(
    repository: PostgresRenderRepository,
    transaction: TenantTransaction,
    context: TenantContext,
    access_container_id: UUID,
    resource_id: UUID,
    job_id: UUID,
) -> dict[str, Any]:
    repository._require(
        Action.RENDER_READ,
        await repository._resource_roles(transaction, context, access_container_id, resource_id),
    )
    job = await repository._load_job(transaction, context, access_container_id, resource_id, job_id)
    snapshot = job.saved_map_snapshot
    if snapshot is None:
        raise RenderConflict("artifact_saved_project_required")
    if (
        job.state != "completed"
        or job.output_object_id is None
        or job.output_checksum_sha256 is None
        or job.output_content_type is None
        or job.output_size_bytes is None
    ):
        raise RenderConflict("artifact_output_unavailable")
    seal = await load_saved_map_seal(
        transaction,
        context,
        access_container_id,
        resource_id,
        UUID(snapshot["resource_version_id"]),
        job_id,
        public=False,
        repository=repository,
    )
    manifest = {
        "schemaVersion": "opengeo.project-artifact.1.0.0",
        "artifactId": str(job_id),
        "representation": "saved-map-image",
        "accessContainerId": str(access_container_id),
        "project": {
            "id": seal["mapId"],
            "version": seal["mapVersion"],
            "definitionChecksumSha256": seal["definitionChecksumSha256"],
        },
        "build": {
            "requestChecksumSha256": job.request_checksum_sha256,
            "recipeChecksumSha256": seal["recipeChecksumSha256"],
            "resourceId": str(resource_id),
            "resourceVersionId": seal["resourceVersionId"],
            "width": job.width,
            "height": job.height,
            "bbox": list(job.bbox),
            "crs": job.crs,
            "runtimeReference": seal.get("runtimeReference"),
        },
        "output": {
            "objectId": str(job.output_object_id),
            "mediaType": job.output_content_type,
            "sizeBytes": job.output_size_bytes,
            "checksumSha256": job.output_checksum_sha256,
        },
        "dependencies": [
            {
                "mode": "pinned",
                "kind": "render-source",
                **{
                    key: value
                    for key, value in source.items()
                    if key not in {"license", "attribution"}
                },
                "recordedRights": {
                    "scope": "source-resource-version",
                    "license": source.get("license"),
                    "attribution": source.get("attribution"),
                    "distributionRights": None,
                },
            }
            for source in seal["sources"]
        ],
        **(
            {
                "styleDependencies": [
                    {
                        "mode": "pinned",
                        **dependency,
                        "recordedRights": {"license": None, "redistributionAllowed": None},
                    }
                    for dependency in seal["styleDependencies"]
                ]
            }
            if seal.get("styleDependencies")
            else {}
        ),
        "networkDependencies": [],
        "rights": {"license": None, "redistributionAllowed": None},
    }
    return {
        **manifest,
        "manifestChecksumSha256": sha256(canonical_json_bytes(manifest)).hexdigest(),
    }


async def register_artifact_edition(
    repository: PostgresRenderRepository,
    context: TenantContext,
    project_id: UUID,
    resource_id: UUID,
    job_id: UUID,
    expected_revision: int,
) -> dict[str, Any]:
    async def operation(transaction: TenantTransaction) -> dict[str, Any]:
        repository._require(
            Action.RENDER_CONFIGURE,
            await repository._resource_roles(transaction, context, project_id, resource_id),
        )
        manifest = await _manifest(
            repository, transaction, context, project_id, resource_id, job_id
        )
        if len(json.dumps(manifest, ensure_ascii=False).encode("utf-8")) > 49_152:
            raise RenderConflict("artifact_manifest_too_large")
        # Unique resource/representation identity serializes concurrent first registration.
        await transaction.execute(
            """INSERT INTO app.project_artifacts
               (organization_id, id, resource_id, map_id, representation, created_by)
               VALUES (%s, %s, %s, %s, 'saved-map-image', %s)
               ON CONFLICT (organization_id, resource_id, representation) DO NOTHING""",
            (
                context.organization_id,
                uuid4(),
                resource_id,
                UUID(manifest["project"]["id"]),
                context.user_id,
            ),
        )
        artifact = await _artifact(transaction, context, resource_id, lock=True)
        existing = await transaction.fetch_one(
            """SELECT version_number, manifest_checksum_sha256
               FROM app.project_artifact_versions
               WHERE organization_id = %s AND artifact_id = %s AND render_job_id = %s""",
            (context.organization_id, artifact[0], job_id),
        )
        if existing is not None:
            if existing[1] != manifest["manifestChecksumSha256"]:
                raise RenderConflict("artifact_manifest_changed")
            return _summary(artifact, version_number=existing[0], reused=True)
        if artifact[1] != expected_revision:
            raise RenderConflict("artifact_revision_conflict")
        row = await transaction.fetch_one(
            """SELECT COALESCE(MAX(version_number), 0) + 1 FROM app.project_artifact_versions
               WHERE organization_id = %s AND artifact_id = %s""",
            (context.organization_id, artifact[0]),
        )
        assert row is not None
        version = row[0]
        await transaction.execute(
            """INSERT INTO app.project_artifact_versions
               (organization_id, artifact_id, version_number, render_job_id, manifest,
                manifest_checksum_sha256, created_by)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (
                context.organization_id,
                artifact[0],
                version,
                job_id,
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
        return _summary(
            (artifact[0], artifact[1] + 1, artifact[2]), version_number=version, reused=False
        )

    return await repository._run(context, operation)


async def read_artifact_edition(
    repository: PostgresRenderRepository,
    context: TenantContext,
    project_id: UUID,
    resource_id: UUID,
    version_number: int | None,
    metadata_only: bool = False,
    representation: str = "saved-map-image",
) -> dict[str, Any]:
    async def operation(transaction: TenantTransaction) -> dict[str, Any]:
        repository._require(
            Action.RENDER_READ,
            await repository._resource_roles(transaction, context, project_id, resource_id),
        )
        artifact = await _artifact(transaction, context, resource_id, representation=representation)
        if metadata_only:
            editions = await transaction.fetch_all(
                """SELECT version_number, render_job_id, portable_object_id
                   FROM app.project_artifact_versions
                   WHERE organization_id = %s AND artifact_id = %s
                   ORDER BY version_number DESC LIMIT 100""",
                (context.organization_id, artifact[0]),
            )
            return _summary(
                artifact,
                version_number=None,
                manifest=None,
                editions=[
                    {
                        "version_number": row[0],
                        **(
                            {"render_job_id": str(row[1])}
                            if row[1] is not None
                            else {"output_object_id": str(row[2])}
                        ),
                    }
                    for row in editions
                ],
            )
        selected = version_number if version_number is not None else artifact[2]
        if selected is None:
            return _summary(artifact, version_number=None, manifest=None)
        manifest = await _edition_manifest(
            repository, transaction, context, project_id, resource_id, artifact[0], selected
        )
        return _summary(artifact, version_number=selected, manifest=manifest)

    return await repository._run(context, operation)


async def select_artifact_current(
    repository: PostgresRenderRepository,
    context: TenantContext,
    project_id: UUID,
    resource_id: UUID,
    version_number: int,
    expected_revision: int,
    representation: str = "saved-map-image",
) -> dict[str, Any]:
    async def operation(transaction: TenantTransaction) -> dict[str, Any]:
        repository._require(
            Action.RENDER_CONFIGURE,
            await repository._resource_roles(transaction, context, project_id, resource_id),
        )
        artifact = await _artifact(
            transaction, context, resource_id, lock=True, representation=representation
        )
        if artifact[1] != expected_revision:
            raise RenderConflict("artifact_revision_conflict")
        manifest = await _edition_manifest(
            repository, transaction, context, project_id, resource_id, artifact[0], version_number
        )
        if artifact[2] != version_number:
            await transaction.execute(
                """UPDATE app.project_artifacts SET current_version_number = %s,
                   revision = revision + 1, updated_at = clock_timestamp(), updated_by = %s
                   WHERE organization_id = %s AND id = %s""",
                (version_number, context.user_id, context.organization_id, artifact[0]),
            )
            artifact = (artifact[0], artifact[1] + 1, version_number)
        return _summary(artifact, version_number=version_number, manifest=manifest)

    return await repository._run(context, operation)


async def _artifact(
    transaction: TenantTransaction,
    context: TenantContext,
    resource_id: UUID,
    *,
    lock: bool = False,
    representation: str = "saved-map-image",
) -> tuple[Any, ...]:
    if representation not in {"saved-map-image", "portable-map-html"}:
        raise RenderConflict("artifact_representation_unsupported")
    row = await transaction.fetch_one(
        """SELECT id, revision, current_version_number FROM app.project_artifacts
           WHERE organization_id = %s AND resource_id = %s
             AND representation = %s"""
        + (" FOR UPDATE" if lock else ""),
        (context.organization_id, resource_id, representation),
    )
    if row is None:
        raise RenderNotFound("artifact")
    return row


def _summary(artifact: tuple[Any, ...], **extra: Any) -> dict[str, Any]:
    return {
        "id": str(artifact[0]),
        "revision": artifact[1],
        "current_version_number": artifact[2],
        **extra,
    }


async def _edition_manifest(
    repository: PostgresRenderRepository,
    transaction: TenantTransaction,
    context: TenantContext,
    project_id: UUID,
    resource_id: UUID,
    artifact_id: UUID,
    version_number: int,
) -> dict[str, Any]:
    row = await transaction.fetch_one(
        """SELECT render_job_id, manifest, manifest_checksum_sha256, portable_object_id,
                  origin_map_id, origin_map_version
           FROM app.project_artifact_versions
           WHERE organization_id = %s AND artifact_id = %s AND version_number = %s""",
        (context.organization_id, artifact_id, version_number),
    )
    if row is None:
        raise RenderNotFound("artifact_version")
    if row[0] is None:
        from opengeo_api.portable_artifact_registration import authorize_portable_origin

        manifest: dict[str, Any] = row[1]
        contents = {
            key: value for key, value in manifest.items() if key != "manifestChecksumSha256"
        }
        checksum = sha256(canonical_json_bytes(contents)).hexdigest()
        if checksum != row[2] or manifest.get("manifestChecksumSha256") != checksum:
            raise RenderConflict("artifact_manifest_changed")
        await authorize_portable_origin(
            repository, transaction, context, project_id, resource_id, manifest, row[4], row[5]
        )
        retained = await transaction.fetch_one(
            """SELECT content_type, size_bytes, checksum_sha256 FROM app.project_artifact_objects
               WHERE organization_id = %s AND artifact_id = %s AND id = %s""",
            (context.organization_id, artifact_id, row[3]),
        )
        output = manifest["output"]
        if retained is None or tuple(retained) != (
            output["mediaType"],
            output["sizeBytes"],
            output["checksumSha256"],
        ):
            raise RenderConflict("artifact_retained_output_mismatch")
        return manifest
    manifest = await _manifest(repository, transaction, context, project_id, resource_id, row[0])
    if manifest != row[1] or manifest["manifestChecksumSha256"] != row[2]:
        raise RenderConflict("artifact_manifest_changed")
    return manifest


async def request_portable_download(
    repository: PostgresRenderRepository,
    context: TenantContext,
    project_id: UUID,
    resource_id: UUID,
    version_number: int | None,
) -> DownloadTicket:
    async def prepare(transaction: TenantTransaction) -> DownloadSpec:
        repository._require(
            Action.RENDER_READ,
            await repository._resource_roles(transaction, context, project_id, resource_id),
        )
        artifact = await _artifact(
            transaction, context, resource_id, representation="portable-map-html"
        )
        selected = version_number if version_number is not None else artifact[2]
        if selected is None:
            raise RenderConflict("artifact_current_unset")
        await _edition_manifest(
            repository, transaction, context, project_id, resource_id, artifact[0], selected
        )
        row = await transaction.fetch_one(
            """SELECT output.bucket, output.object_key, output.s3_version_id
               FROM app.project_artifact_versions edition
               JOIN app.project_artifact_objects output
                 ON output.organization_id = edition.organization_id
                AND output.artifact_id = edition.artifact_id
                AND output.id = edition.portable_object_id
               WHERE edition.organization_id = %s AND edition.artifact_id = %s
                 AND edition.version_number = %s""",
            (context.organization_id, artifact[0], selected),
        )
        if row is None:
            raise RenderConflict("artifact_output_unavailable")
        return DownloadSpec(
            row[0], row[1], row[2], filename=f"project-artifact-{artifact[0]}-v{selected}.html"
        )

    target = await repository._run(context, prepare)
    return await repository._artifact_downloads.create_download_url(target)
