"""Durable, private folder upload planning; no S3 operations during review."""

import re
from dataclasses import dataclass
from typing import Any, cast
from uuid import UUID, uuid4

from opengeo_api.authorization import Action
from opengeo_api.ingestion import IngestionConflict, IngestionNotFound, PostgresIngestionRepository
from opengeo_api.tenant_database import TenantContext, TenantTransaction


@dataclass(frozen=True)
class ArchiveFile:
    ordinal: int
    destination_id: UUID
    path: str
    size_bytes: int
    modified_milliseconds: int
    sha256: str

    def validate(self) -> None:
        try:
            path_bytes = len(self.path.encode("utf-8"))
        except (AttributeError, UnicodeEncodeError) as error:
            raise IngestionConflict("archive_file_invalid") from error
        if (
            type(self.ordinal) is not int
            or not 0 <= self.ordinal < 100_000
            or not isinstance(self.destination_id, UUID)
            or not isinstance(self.path, str)
            or not 1 <= path_bytes <= 1024
            or re.search(r"[\\\x00-\x1f\x7f]", self.path)
            or re.match(r"^[A-Za-z]:", self.path)
            or any(part in ("", ".", "..") for part in self.path.split("/"))
            or type(self.size_bytes) is not int
            or not 0 <= self.size_bytes <= 5 * 1024**4
            or type(self.modified_milliseconds) is not int
            or not 0 <= self.modified_milliseconds <= 2**53 - 1
            or not isinstance(self.sha256, str)
            or not re.fullmatch("[a-f0-9]{64}", self.sha256)
        ):
            raise IngestionConflict("archive_file_invalid")


class ArchiveUploadRepository:
    def __init__(self, ingestion: PostgresIngestionRepository) -> None:
        self.ingestion = ingestion

    async def _authorize(
        self, transaction: TenantTransaction, context: TenantContext, project_id: UUID
    ) -> None:
        roles = await self.ingestion._project_roles(transaction, context, project_id)
        self.ingestion._require(Action.DATASET_UPLOAD, roles)

    async def create(self, context: TenantContext, project_id: UUID, creation_key: UUID) -> UUID:
        async def operation(tx: TenantTransaction) -> UUID:
            await self._authorize(tx, context, project_id)
            # Serialize quota admission for this creator across workspaces. Exact
            # retries are resolved before counting active sessions.
            await tx.fetch_one(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                (f"archive-upload:{context.organization_id}:{context.user_id}",),
            )
            existing = await tx.fetch_one(
                """SELECT id,project_id FROM app.archive_upload_sessions
                WHERE organization_id=%s AND created_by=%s AND creation_key=%s""",
                (context.organization_id, context.user_id, creation_key),
            )
            if existing is not None:
                if existing[1] != project_id:
                    raise IngestionConflict("archive_creation_key_conflict")
                return cast(UUID, existing[0])
            active = await tx.fetch_one(
                """SELECT count(*) FROM app.archive_upload_sessions
                WHERE organization_id=%s AND created_by=%s
                AND state IN ('planning','uploading','paused') AND expires_at>clock_timestamp()""",
                (context.organization_id, context.user_id),
            )
            if active is None or active[0] >= 5:
                raise IngestionConflict("archive_session_limit")
            upload_id = uuid4()
            await tx.execute(
                """INSERT INTO app.archive_upload_sessions
                (organization_id,project_id,id,created_by,creation_key)
                VALUES (%s,%s,%s,%s,%s)""",
                (context.organization_id, project_id, upload_id, context.user_id, creation_key),
            )
            return upload_id

        return await self.ingestion._run(context, operation)

    async def append_files(
        self, context: TenantContext, project_id: UUID, session_id: UUID, files: list[ArchiveFile]
    ) -> None:
        if not 1 <= len(files) <= 25:
            raise IngestionConflict("archive_batch_limit")
        for file in files:
            file.validate()
        if len({file.ordinal for file in files}) != len(files) or len(
            {file.path for file in files}
        ) != len(files):
            raise IngestionConflict("archive_duplicate_path")

        async def operation(tx: TenantTransaction) -> None:
            await self._authorize(tx, context, project_id)
            session = await tx.fetch_one(
                """SELECT state FROM app.archive_upload_sessions
                WHERE organization_id=%s AND project_id=%s AND id=%s AND created_by=%s
                AND expires_at>clock_timestamp()
                FOR UPDATE""",
                (context.organization_id, project_id, session_id, context.user_id),
            )
            if session is None:
                raise IngestionNotFound("archive_session")
            if session[0] != "planning":
                raise IngestionConflict("archive_plan_locked")
            for file in files:
                destination = await tx.fetch_one(
                    """SELECT object_prefix FROM app.archive_upload_destinations
                    WHERE organization_id=%s AND project_id=%s AND id=%s AND enabled""",
                    (context.organization_id, project_id, file.destination_id),
                )
                if destination is None:
                    raise IngestionConflict("archive_destination_unavailable")
                key = f"{destination[0]}uploads/{session_id}/originals/{file.path}"
                if len(key.encode("utf-8")) > 1024:
                    raise IngestionConflict("archive_object_key_too_long")
                values = (
                    file.destination_id,
                    file.path,
                    file.size_bytes,
                    file.modified_milliseconds,
                    file.sha256,
                )
                await tx.execute(
                    """INSERT INTO app.archive_upload_files
                    (organization_id,project_id,session_id,ordinal,destination_id,relative_path,
                     size_bytes,modified_milliseconds,sha256) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (organization_id,session_id,ordinal) DO NOTHING""",
                    (context.organization_id, project_id, session_id, file.ordinal, *values),
                )
                existing = await tx.fetch_one(
                    """SELECT destination_id,relative_path,size_bytes,
                    modified_milliseconds,sha256 FROM app.archive_upload_files
                    WHERE organization_id=%s AND session_id=%s AND ordinal=%s""",
                    (context.organization_id, session_id, file.ordinal),
                )
                if existing != values:
                    raise IngestionConflict("archive_plan_changed")

        await self.ingestion._run(context, operation)

    async def read_files(
        self, context: TenantContext, project_id: UUID, session_id: UUID, after: int = -1
    ) -> list[tuple[Any, ...]]:
        if type(after) is not int or not -1 <= after < 100_000:
            raise IngestionConflict("archive_cursor_invalid")

        async def operation(tx: TenantTransaction) -> list[tuple[Any, ...]]:
            await self._authorize(tx, context, project_id)
            session = await tx.fetch_one(
                """SELECT state FROM app.archive_upload_sessions
                WHERE organization_id=%s AND project_id=%s AND id=%s AND created_by=%s""",
                (context.organization_id, project_id, session_id, context.user_id),
            )
            if session is None:
                raise IngestionNotFound("archive_session")
            return await tx.fetch_all(
                """SELECT ordinal,destination_id,relative_path,size_bytes,
                modified_milliseconds,sha256 FROM app.archive_upload_files
                WHERE organization_id=%s AND project_id=%s AND session_id=%s AND ordinal>%s
                ORDER BY ordinal LIMIT 25""",
                (context.organization_id, project_id, session_id, after),
            )

        return await self.ingestion._run(context, operation)

    async def destinations(self, context: TenantContext, project_id: UUID) -> list[tuple[Any, ...]]:
        async def operation(tx: TenantTransaction) -> list[tuple[Any, ...]]:
            await self._authorize(tx, context, project_id)
            return await tx.fetch_all(
                """SELECT id,title,bucket,region,object_prefix
                FROM app.archive_upload_destinations WHERE organization_id=%s
                AND project_id=%s AND enabled ORDER BY title,id LIMIT 100""",
                (context.organization_id, project_id),
            )

        return await self.ingestion._run(context, operation)

    async def seal(
        self,
        context: TenantContext,
        project_id: UUID,
        session_id: UUID,
        expected_files: int,
        expected_bytes: int,
    ) -> dict[str, Any]:
        if (
            type(expected_files) is not int
            or not 1 <= expected_files <= 100_000
            or type(expected_bytes) is not int
            or not 0 <= expected_bytes <= 1024**4
        ):
            raise IngestionConflict("archive_plan_invalid")

        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            await self._authorize(tx, context, project_id)
            row = await tx.fetch_one(
                """SELECT state,file_count,logical_bytes,upload_bytes,sealed_at
                FROM app.archive_upload_sessions WHERE organization_id=%s AND project_id=%s
                AND id=%s AND created_by=%s
                AND expires_at>clock_timestamp() FOR UPDATE""",
                (context.organization_id, project_id, session_id, context.user_id),
            )
            if row is None:
                raise IngestionNotFound("archive_session")
            if row[4] is not None:
                if (row[1], row[2]) != (expected_files, expected_bytes):
                    raise IngestionConflict("archive_plan_changed")
                return {"file_count": row[1], "logical_bytes": row[2], "upload_bytes": row[3]}
            if row[0] != "planning":
                raise IngestionConflict("archive_plan_locked")
            summary = await tx.fetch_one(
                """SELECT count(*),coalesce(sum(size_bytes),0),
                min(ordinal),max(ordinal),count(*) FILTER (WHERE NOT d.enabled)
                FROM app.archive_upload_files f JOIN app.archive_upload_destinations d
                 ON d.organization_id=f.organization_id AND d.id=f.destination_id
                WHERE f.organization_id=%s AND f.project_id=%s AND f.session_id=%s""",
                (context.organization_id, project_id, session_id),
            )
            if summary != (expected_files, expected_bytes, 0, expected_files - 1, 0):
                raise IngestionConflict("archive_plan_incomplete")
            unique = await tx.fetch_one(
                """SELECT coalesce(sum(size_bytes),0) FROM (
                SELECT DISTINCT destination_id,size_bytes,sha256 FROM app.archive_upload_files
                WHERE organization_id=%s AND project_id=%s AND session_id=%s) objects""",
                (context.organization_id, project_id, session_id),
            )
            if unique is None:
                raise IngestionConflict("archive_plan_incomplete")
            upload_bytes = int(unique[0])
            await tx.execute(
                """UPDATE app.archive_upload_sessions
                SET state='paused',sealed_at=clock_timestamp(),file_count=%s,
                    logical_bytes=%s,upload_bytes=%s
                WHERE organization_id=%s AND project_id=%s AND id=%s""",
                (
                    expected_files,
                    expected_bytes,
                    upload_bytes,
                    context.organization_id,
                    project_id,
                    session_id,
                ),
            )
            return {
                "file_count": expected_files,
                "logical_bytes": expected_bytes,
                "upload_bytes": upload_bytes,
            }

        return await self.ingestion._run(context, operation)

    async def status(
        self, context: TenantContext, project_id: UUID, session_id: UUID
    ) -> dict[str, Any]:
        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            await self._authorize(tx, context, project_id)
            row = await tx.fetch_one(
                """SELECT state,expires_at,file_count,logical_bytes,upload_bytes
                FROM app.archive_upload_sessions WHERE organization_id=%s AND project_id=%s
                 AND id=%s AND created_by=%s""",
                (context.organization_id, project_id, session_id, context.user_id),
            )
            if row is None:
                raise IngestionNotFound("archive_session")
            counts = await tx.fetch_one(
                """SELECT count(*),count(*) FILTER (WHERE o.state='complete'),
                coalesce(sum(f.size_bytes) FILTER (WHERE o.state='complete'),0)
                FROM app.archive_upload_objects o JOIN app.archive_upload_files f
                 ON f.organization_id=o.organization_id AND f.session_id=o.session_id
                 AND f.ordinal=o.ordinal WHERE o.organization_id=%s AND o.session_id=%s""",
                (context.organization_id, session_id),
            )
            assert counts is not None  # An aggregate without GROUP BY always returns one row.
            return {
                "id": session_id,
                "state": row[0],
                "expires_at": row[1],
                "file_count": row[2],
                "logical_bytes": row[3],
                "upload_bytes": row[4],
                "object_count": counts[0],
                "verified_objects": counts[1],
                "verified_bytes": int(counts[2]),
            }

        return await self.ingestion._run(context, operation)

    async def finish(self, context: TenantContext, project_id: UUID, session_id: UUID) -> None:
        async def operation(tx: TenantTransaction) -> None:
            await self._authorize(tx, context, project_id)
            row = await tx.fetch_one(
                """SELECT state,file_count FROM app.archive_upload_sessions
                WHERE organization_id=%s AND project_id=%s AND id=%s AND created_by=%s
                FOR UPDATE""",
                (context.organization_id, project_id, session_id, context.user_id),
            )
            if row is None:
                raise IngestionNotFound("archive_session")
            if row[0] == "complete":
                return
            if row[0] != "uploading":
                raise IngestionConflict("archive_session_not_uploading")
            counts = await tx.fetch_one(
                """SELECT count(*),count(*) FILTER (
                WHERE o.state<>'complete' OR o.receipt IS NULL)
                FROM app.archive_upload_objects o WHERE organization_id=%s AND session_id=%s""",
                (context.organization_id, session_id),
            )
            if counts is None or not counts[0] or counts[1]:
                raise IngestionConflict("archive_upload_incomplete")
            # Independently establish coverage of all logical originals, not merely
            # completion of whichever canonical objects happen to be present.
            covered = await tx.fetch_one(
                """SELECT count(*) FROM app.archive_upload_files f
                WHERE f.organization_id=%s AND f.session_id=%s AND EXISTS (
                 SELECT 1 FROM app.archive_upload_objects o JOIN app.archive_upload_files c
                  ON c.organization_id=o.organization_id AND c.session_id=o.session_id
                  AND c.ordinal=o.ordinal WHERE o.organization_id=f.organization_id
                  AND o.session_id=f.session_id AND c.destination_id=f.destination_id
                  AND c.size_bytes=f.size_bytes AND c.sha256=f.sha256 AND o.state='complete')""",
                (context.organization_id, session_id),
            )
            if covered is None or covered[0] != row[1]:
                raise IngestionConflict("archive_upload_incomplete")
            await tx.execute(
                """UPDATE app.archive_upload_sessions SET state='complete'
                WHERE organization_id=%s AND id=%s""",
                (context.organization_id, session_id),
            )

        await self.ingestion._run(context, operation)

    async def manifest_page(
        self, context: TenantContext, project_id: UUID, session_id: UUID, after: int = -1
    ) -> list[tuple[Any, ...]]:
        if type(after) is not int or not -1 <= after < 100_000:
            raise IngestionConflict("archive_cursor_invalid")

        async def operation(tx: TenantTransaction) -> list[tuple[Any, ...]]:
            await self._authorize(tx, context, project_id)
            session = await tx.fetch_one(
                """SELECT state FROM app.archive_upload_sessions
                WHERE organization_id=%s AND project_id=%s AND id=%s AND created_by=%s""",
                (context.organization_id, project_id, session_id, context.user_id),
            )
            if session is None:
                raise IngestionNotFound("archive_session")
            if session[0] != "complete":
                raise IngestionConflict("archive_upload_incomplete")
            return await tx.fetch_all(
                """SELECT f.ordinal,f.relative_path,f.size_bytes,
                f.modified_milliseconds,f.sha256,o.ordinal,o.receipt
                FROM app.archive_upload_files f JOIN app.archive_upload_files c
                 ON c.organization_id=f.organization_id AND c.session_id=f.session_id
                 AND c.destination_id=f.destination_id AND c.size_bytes=f.size_bytes
                 AND c.sha256=f.sha256
                JOIN app.archive_upload_objects o ON o.organization_id=c.organization_id
                 AND o.session_id=c.session_id AND o.ordinal=c.ordinal
                WHERE f.organization_id=%s AND f.project_id=%s AND f.session_id=%s
                 AND f.ordinal>%s ORDER BY f.ordinal LIMIT 25""",
                (context.organization_id, project_id, session_id, after),
            )

        return await self.ingestion._run(context, operation)
