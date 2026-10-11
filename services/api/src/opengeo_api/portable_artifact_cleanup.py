"""Deliberate, bounded cleanup of one expired portable upload.

The storage adapter must enumerate only the exact key, including delete markers,
and delete named immutable versions. No bucket scan, current-key delete or automatic
polling is authorized by this interface. Production storage wiring remains explicit.
"""

from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID, uuid4

from opengeo_api.authorization import Action
from opengeo_api.rendering import PostgresRenderRepository, RenderConflict, RenderNotFound
from opengeo_api.tenant_database import TenantContext, TenantTransaction


@dataclass(frozen=True, slots=True)
class UploadObjectVersion:
    key: str
    version_id: str


@dataclass(frozen=True, slots=True)
class UploadVersionPage:
    versions: tuple[UploadObjectVersion, ...]
    has_more: bool


class PortableCleanupStorage(Protocol):
    async def list_exact_versions(self, bucket: str, key: str, limit: int) -> UploadVersionPage: ...
    async def delete_exact_version(self, bucket: str, key: str, version_id: str) -> None: ...


async def cleanup_expired_portable_upload(
    repository: PostgresRenderRepository,
    storage: PortableCleanupStorage,
    context: TenantContext,
    project_id: UUID,
    resource_id: UUID,
    upload_id: UUID,
) -> dict[str, Any]:
    """Return an observation receipt, not proof that a late upload cannot arrive."""

    attempt_id = uuid4()

    async def authorize(transaction: TenantTransaction) -> tuple[Any, ...]:
        repository._require(
            Action.RENDER_CONFIGURE,
            await repository._resource_roles(transaction, context, project_id, resource_id),
        )
        row = await transaction.fetch_one(
            """SELECT intent.bucket, intent.object_key
               FROM app.project_artifact_upload_intents intent
               JOIN app.project_artifacts artifact
                 ON artifact.organization_id = intent.organization_id
                AND artifact.id = intent.artifact_id
               JOIN app.governed_resources resource
                 ON resource.organization_id = artifact.organization_id
                AND resource.id = artifact.resource_id
               WHERE intent.organization_id = %s AND intent.id = %s AND intent.created_by = %s
                 AND resource.project_id = %s AND resource.id = %s
                 AND artifact.representation = 'portable-map-html'
                 AND intent.completed_object_id IS NULL
                 AND intent.expires_at < clock_timestamp() - interval '1 day'
               FOR UPDATE OF intent""",
            (context.organization_id, upload_id, context.user_id, project_id, resource_id),
        )
        if row is None:
            raise RenderNotFound("artifact_cleanup_candidate")
        retained = await transaction.fetch_one(
            """SELECT 1 FROM app.project_artifact_objects
               WHERE organization_id = %s AND bucket = %s AND object_key = %s LIMIT 1""",
            (context.organization_id, row[0], row[1]),
        )
        if retained is not None:
            raise RenderConflict("artifact_cleanup_retained_output")
        return row

    async def start(transaction: TenantTransaction) -> None:
        await authorize(transaction)
        await transaction.execute(
            """INSERT INTO app.project_artifact_cleanup_attempts
               (organization_id,id,upload_id,created_by) VALUES (%s,%s,%s,%s)""",
            (context.organization_id, attempt_id, upload_id, context.user_id),
        )

    await repository._run(context, start)

    async def operation(transaction: TenantTransaction) -> dict[str, Any]:
        row = await authorize(transaction)

        async def finish(
            deleted: int, more: bool | None, empty: bool | None, error: str | None = None
        ) -> dict[str, Any]:
            state = "failed" if error else "observed"
            await transaction.execute(
                """UPDATE app.project_artifact_cleanup_attempts
                   SET state=%s,deleted_versions=%s,more_versions=%s,observed_empty=%s,
                       error_code=%s,finished_at=clock_timestamp()
                   WHERE organization_id=%s AND id=%s AND state='started'""",
                (state, deleted, more, empty, error, context.organization_id, attempt_id),
            )
            return {
                "attempt_id": str(attempt_id),
                "upload_id": str(upload_id),
                "state": state,
                "deleted_versions": deleted,
                "more_versions": more,
                "observed_empty": empty,
                "error_code": error,
                "terminal": False,
            }

        try:
            page = await storage.list_exact_versions(row[0], row[1], 16)
        except Exception:
            return await finish(0, None, None, "storage_inventory_unavailable")
        if (
            len(page.versions) > 16
            or type(page.has_more) is not bool
            or any(
                item.key != row[1]
                or not isinstance(item.version_id, str)
                or not 0 < len(item.version_id) <= 1024
                or item.version_id == "null"
                for item in page.versions
            )
            or len({item.version_id for item in page.versions}) != len(page.versions)
        ):
            raise RenderConflict("artifact_cleanup_inventory_invalid")
        # Expired pending intents cannot complete; the lock also serializes cleanup.
        # Versions already removed by an earlier interrupted attempt are absent on retry.
        deleted = 0
        for version in page.versions:
            try:
                await storage.delete_exact_version(row[0], row[1], version.version_id)
            except Exception:
                return await finish(deleted, page.has_more, False, "storage_delete_unconfirmed")
            deleted += 1
        return await finish(deleted, page.has_more, not page.versions)

    return await repository._run(context, operation)


async def list_cleanup_attempts(
    repository: PostgresRenderRepository,
    context: TenantContext,
    project_id: UUID,
    resource_id: UUID,
    upload_id: UUID,
) -> list[dict[str, Any]]:
    async def operation(transaction: TenantTransaction) -> list[dict[str, Any]]:
        repository._require(
            Action.RENDER_CONFIGURE,
            await repository._resource_roles(transaction, context, project_id, resource_id),
        )
        owner = await transaction.fetch_one(
            """SELECT 1 FROM app.project_artifact_upload_intents intent
               JOIN app.project_artifacts artifact
                 ON artifact.organization_id=intent.organization_id
                 AND artifact.id=intent.artifact_id
               JOIN app.governed_resources resource
                 ON resource.organization_id=artifact.organization_id
                 AND resource.id=artifact.resource_id
               WHERE intent.organization_id=%s AND intent.id=%s AND intent.created_by=%s
                 AND resource.project_id=%s AND resource.id=%s""",
            (context.organization_id, upload_id, context.user_id, project_id, resource_id),
        )
        if owner is None:
            raise RenderNotFound("artifact_upload")
        rows = await transaction.fetch_all(
            """SELECT id,state,deleted_versions,more_versions,observed_empty,error_code,
                      created_at,finished_at
               FROM app.project_artifact_cleanup_attempts
               WHERE organization_id=%s AND upload_id=%s
               ORDER BY created_at DESC,id DESC LIMIT 50""",
            (context.organization_id, upload_id),
        )
        return [
            dict(
                zip(
                    (
                        "attempt_id",
                        "state",
                        "deleted_versions",
                        "more_versions",
                        "observed_empty",
                        "error_code",
                        "created_at",
                        "finished_at",
                    ),
                    (str(row[0]), *row[1:]),
                    strict=True,
                )
            )
            for row in rows
        ]

    return await repository._run(context, operation)
