"""Persist mutation intent before contacting S3; never repeat uncertain creates."""

from __future__ import annotations

import asyncio
import base64
import hashlib
from collections.abc import Callable
from typing import Any, cast
from uuid import UUID

from psycopg.types.json import Jsonb

from opengeo_api.archive_upload_storage import (
    PART_BYTES,
    ArchiveS3Storage,
    checksum,
    part_length,
    part_size,
)
from opengeo_api.archive_uploads import ArchiveUploadRepository
from opengeo_api.ingestion import IngestionConflict, IngestionNotFound
from opengeo_api.tenant_database import TenantContext, TenantTransaction


class ArchiveTransferRepository:
    def __init__(
        self,
        plans: ArchiveUploadRepository,
        storage_factory: Callable[[str, str, str], ArchiveS3Storage] = ArchiveS3Storage,
    ) -> None:
        self.plans = plans
        self.storage_factory = storage_factory

    async def _session(
        self,
        tx: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        session_id: UUID,
        *,
        cleanup: bool = False,
    ) -> tuple[Any, ...]:
        await self.plans._authorize(tx, context, project_id)
        session = await tx.fetch_one(
            """SELECT state,sealed_at FROM app.archive_upload_sessions
            WHERE organization_id=%s AND project_id=%s AND id=%s AND created_by=%s
            AND (%s OR expires_at>clock_timestamp()) FOR UPDATE""",
            (context.organization_id, project_id, session_id, context.user_id, cleanup),
        )
        if session is None:
            raise IngestionNotFound("archive_session")
        return session

    async def start(self, context: TenantContext, project_id: UUID, session_id: UUID) -> None:
        async def operation(tx: TenantTransaction) -> None:
            session = await self._session(tx, context, project_id, session_id)
            if session[0] == "uploading":
                return
            if session[0] != "paused" or session[1] is None:
                raise IngestionConflict("archive_plan_not_sealed")
            invalid = await tx.fetch_one(
                """SELECT count(*) FROM app.archive_upload_files f
                JOIN app.archive_upload_destinations d ON d.organization_id=f.organization_id
                 AND d.id=f.destination_id WHERE f.organization_id=%s AND f.session_id=%s
                 AND (NOT d.enabled OR d.region<>'us-east-1')""",
                (context.organization_id, session_id),
            )
            if invalid is None or invalid[0]:
                raise IngestionConflict("archive_destination_unavailable")
            # Snapshot destination facts once. Every duplicate resolves to the first
            # ordinal in its destination; all original paths remain in the file plan.
            await tx.execute(
                """INSERT INTO app.archive_upload_objects
                (organization_id,project_id,session_id,ordinal,bucket,object_key,
                 object_prefix,region,expected_bucket_owner)
                SELECT f.organization_id,f.project_id,f.session_id,f.ordinal,d.bucket,
                  d.object_prefix || 'uploads/' || f.session_id::text
                   || '/originals/' || f.relative_path,
                  d.object_prefix,d.region,d.expected_bucket_owner
                FROM app.archive_upload_files f JOIN app.archive_upload_destinations d
                 ON d.organization_id=f.organization_id AND d.id=f.destination_id
                WHERE f.organization_id=%s AND f.session_id=%s AND f.ordinal=(
                 SELECT min(alias.ordinal) FROM app.archive_upload_files alias
                 WHERE alias.organization_id=f.organization_id AND alias.session_id=f.session_id
                  AND alias.destination_id=f.destination_id AND alias.size_bytes=f.size_bytes
                  AND alias.sha256=f.sha256)
                ON CONFLICT (organization_id,session_id,ordinal) DO NOTHING""",
                (context.organization_id, session_id),
            )
            await tx.execute(
                """UPDATE app.archive_upload_sessions SET state='uploading'
                WHERE organization_id=%s AND id=%s""",
                (context.organization_id, session_id),
            )

        await self.plans.ingestion._run(context, operation)

    async def _object(
        self,
        tx: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        session_id: UUID,
        ordinal: int,
        *,
        cleanup: bool = False,
    ) -> tuple[Any, ...]:
        session = await self._session(tx, context, project_id, session_id, cleanup=cleanup)
        allowed = {"uploading", "paused", "cancelled", "complete"} if cleanup else {"uploading"}
        if session[0] not in allowed:
            raise IngestionConflict("archive_session_not_uploading")
        row = await tx.fetch_one(
            """SELECT o.ordinal,o.bucket,o.object_key,o.object_prefix,
            o.expected_bucket_owner,o.state,o.upload_id,f.size_bytes,f.sha256,o.receipt
            FROM app.archive_upload_files selected JOIN app.archive_upload_files f
             ON f.organization_id=selected.organization_id AND f.session_id=selected.session_id
             AND f.destination_id=selected.destination_id AND f.size_bytes=selected.size_bytes
             AND f.sha256=selected.sha256
            JOIN app.archive_upload_objects o ON o.organization_id=f.organization_id
             AND o.session_id=f.session_id AND o.ordinal=f.ordinal
            JOIN app.archive_upload_destinations d ON d.organization_id=f.organization_id
             AND d.id=f.destination_id
            WHERE selected.organization_id=%s AND selected.project_id=%s
             AND selected.session_id=%s AND selected.ordinal=%s
             AND (d.enabled OR %s) FOR UPDATE OF o""",
            (context.organization_id, project_id, session_id, ordinal, cleanup),
        )
        if row is None:
            raise IngestionNotFound("archive_object")
        return row

    def _storage(self, row: tuple[Any, ...]) -> ArchiveS3Storage:
        return self.storage_factory(row[1], row[3], row[4])

    async def prepare(
        self, context: TenantContext, project_id: UUID, session_id: UUID, ordinal: int
    ) -> dict[str, Any]:
        async def claim(tx: TenantTransaction) -> tuple[tuple[Any, ...], bool]:
            row = await self._object(tx, context, project_id, session_id, ordinal)
            if row[5] == "complete":
                return row, False
            if row[5] == "completing":
                return row, False
            if row[5] == "creating":
                return row, False
            if row[5] not in {"prepared", "uploading"}:
                raise IngestionConflict("archive_object_busy")
            creating = row[5] == "prepared" and row[7] > PART_BYTES
            state = "creating" if creating else "uploading"
            if row[5] == "prepared":
                await tx.execute(
                    """UPDATE app.archive_upload_objects SET state=%s
                    WHERE organization_id=%s AND session_id=%s AND ordinal=%s""",
                    (state, context.organization_id, session_id, row[0]),
                )
            return row, creating

        row, creating = await self.plans.ingestion._run(context, claim)
        if row[5] == "complete":
            return {"ordinal": row[0], "state": "complete", "receipt": row[9]}
        if row[5] == "completing":
            return {"ordinal": row[0], "state": "completing"}
        storage = self._storage(row)
        if row[5] == "creating":
            uploads = await storage.find_uploads(row[2])
            if len(uploads) != 1:
                # An empty listing is not permission to repeat an uncertain create.
                raise IngestionConflict("archive_multipart_creation_unresolved")
            await self._save_upload_id(context, project_id, session_id, ordinal, uploads[0])
        if creating:
            # The claim transaction has committed before this non-idempotent call.
            # An uncertain result leaves 'creating', never another create request.
            upload_id = await storage.create(row[2], row[8])

            await self._save_upload_id(context, project_id, session_id, ordinal, upload_id)
        if row[7] <= PART_BYTES:
            # Conditional single PUT is safe to retry only after HEAD reconciliation.
            existing = await storage.inspect(row[2], row[7], row[8], checksum(row[8]))
            if existing:
                await self._save_receipt(context, project_id, session_id, ordinal, existing)
                return {"ordinal": row[0], "state": "complete", "receipt": existing}
            ticket = await asyncio.to_thread(storage.sign_single, row[2], row[7], row[8])
            return {"ordinal": row[0], "state": "uploading", "single": ticket}
        return {
            "ordinal": row[0],
            "state": "uploading",
            "part_bytes": part_size(row[7]),
            "part_count": (row[7] + part_size(row[7]) - 1) // part_size(row[7]),
        }

    async def part_ticket(
        self,
        context: TenantContext,
        project_id: UUID,
        session_id: UUID,
        ordinal: int,
        number: int,
        sha256: str,
    ) -> dict[str, Any]:
        checksum(sha256)

        async def operation(tx: TenantTransaction) -> tuple[Any, ...]:
            row = await self._object(tx, context, project_id, session_id, ordinal)
            if row[5] != "uploading" or not row[6]:
                raise IngestionConflict("archive_multipart_not_ready")
            size = part_length(row[7], number)
            await tx.execute(
                """INSERT INTO app.archive_upload_parts
                (organization_id,session_id,ordinal,part_number,size_bytes,sha256)
                VALUES (%s,%s,%s,%s,%s,%s)
                ON CONFLICT (organization_id,session_id,ordinal,part_number) DO NOTHING""",
                (context.organization_id, session_id, row[0], number, size, sha256),
            )
            saved = await tx.fetch_one(
                """SELECT size_bytes,sha256 FROM app.archive_upload_parts
                WHERE organization_id=%s AND session_id=%s AND ordinal=%s AND part_number=%s""",
                (context.organization_id, session_id, row[0], number),
            )
            if saved != (size, sha256):
                raise IngestionConflict("archive_part_changed")
            return row

        row = await self.plans.ingestion._run(context, operation)
        return await asyncio.to_thread(
            self._storage(row).sign_part, row[2], row[6], row[7], number, sha256
        )

    async def _save_receipt(
        self,
        context: TenantContext,
        project_id: UUID,
        session_id: UUID,
        ordinal: int,
        receipt: dict[str, Any],
    ) -> None:
        async def operation(tx: TenantTransaction) -> None:
            row = await self._object(tx, context, project_id, session_id, ordinal)
            if row[5] == "complete":
                if row[9] != receipt:
                    raise IngestionConflict("archive_receipt_changed")
                return
            if row[5] not in {"uploading", "completing"}:
                raise IngestionConflict("archive_object_changed")
            await tx.execute(
                """UPDATE app.archive_upload_objects SET state='complete',receipt=%s
                WHERE organization_id=%s AND session_id=%s AND ordinal=%s""",
                (Jsonb(receipt), context.organization_id, session_id, row[0]),
            )

        await self.plans.ingestion._run(context, operation)

    async def complete(
        self, context: TenantContext, project_id: UUID, session_id: UUID, ordinal: int
    ) -> dict[str, Any]:
        async def claim(tx: TenantTransaction) -> tuple[tuple[Any, ...], list[tuple[Any, ...]]]:
            row = await self._object(tx, context, project_id, session_id, ordinal)
            if row[5] == "complete":
                return row, []
            if row[5] not in {"uploading", "completing"}:
                raise IngestionConflict("archive_object_busy")
            parts = []
            if row[7] > PART_BYTES:
                if not row[6]:
                    raise IngestionConflict("archive_multipart_not_ready")
                count = (row[7] + part_size(row[7]) - 1) // part_size(row[7])
                # Bound each Data API result, including for a large part inventory.
                for after in range(0, count, 250):
                    page = await tx.fetch_all(
                        """SELECT part_number,size_bytes,sha256
                        FROM app.archive_upload_parts WHERE organization_id=%s AND session_id=%s
                         AND ordinal=%s AND part_number>%s ORDER BY part_number LIMIT 250""",
                        (context.organization_id, session_id, row[0], after),
                    )
                    parts.extend(page)
                if len(parts) != count:
                    raise IngestionConflict("archive_parts_incomplete")
                for number, saved in enumerate(parts, 1):
                    if saved[:2] != (number, part_length(row[7], number)):
                        raise IngestionConflict("archive_parts_incomplete")
            return row, parts

        # Bounded work; a timeout leaves committed state available for reconciliation.
        async with asyncio.timeout(90):
            row, plans = await self.plans.ingestion._run(context, claim)
            if row[5] == "complete":
                return cast(dict[str, Any], row[9])
            storage = self._storage(row)
            storage_checksum = checksum(row[8])
            if plans:
                digest = hashlib.sha256(b"".join(bytes.fromhex(part[2]) for part in plans)).digest()
                storage_checksum = base64.b64encode(digest).decode() + f"-{len(plans)}"
            # Check first: a prior completion may have succeeded before its response
            # or receipt was lost, in which case S3 no longer has a multipart upload.
            receipt = await storage.inspect(row[2], row[7], row[8], storage_checksum)
            if receipt is None and plans:
                expected = {p[0]: (p[1], p[2]) for p in plans}
                received: list[dict[str, Any]] = []
                after = 0
                for _ in range(100):
                    page = await storage.list_parts(row[2], row[6], after)
                    for part in page["parts"]:
                        if (
                            expected.get(part["number"]) != (part["size"], part["sha256"])
                            or part["number"] != len(received) + 1
                        ):
                            raise IngestionConflict("archive_uploaded_part_mismatch")
                        received.append(part)
                    next_after = page["next_after"]
                    if next_after is None:
                        break
                    if next_after <= after:
                        raise IngestionConflict("archive_parts_incomplete")
                    after = next_after
                if len(received) != len(plans) or page["next_after"] is not None:
                    raise IngestionConflict("archive_parts_incomplete")

                async def mark_completing(tx: TenantTransaction) -> None:
                    current = await self._object(tx, context, project_id, session_id, ordinal)
                    if current[5] not in {"uploading", "completing"}:
                        raise IngestionConflict("archive_object_changed")
                    await tx.execute(
                        """UPDATE app.archive_upload_objects SET state='completing'
                        WHERE organization_id=%s AND session_id=%s AND ordinal=%s""",
                        (context.organization_id, session_id, row[0]),
                    )

                await self.plans.ingestion._run(context, mark_completing)
                result = await storage.complete(row[2], row[6], row[7], received)
                receipt = await storage.inspect(
                    row[2], row[7], row[8], storage_checksum, result["version_id"]
                )
            if receipt is None:
                raise IngestionConflict("archive_object_not_uploaded")
            await self._save_receipt(context, project_id, session_id, ordinal, receipt)
            return receipt

    async def _save_upload_id(
        self,
        context: TenantContext,
        project_id: UUID,
        session_id: UUID,
        ordinal: int,
        upload_id: str,
    ) -> None:
        async def operation(tx: TenantTransaction) -> None:
            current = await self._object(tx, context, project_id, session_id, ordinal)
            if current[5] == "uploading" and current[6] == upload_id:
                return
            if current[5] != "creating" or current[6] is not None:
                raise IngestionConflict("archive_object_changed")
            await tx.execute(
                """UPDATE app.archive_upload_objects SET state='uploading',upload_id=%s
                WHERE organization_id=%s AND session_id=%s AND ordinal=%s""",
                (upload_id, context.organization_id, session_id, current[0]),
            )

        await self.plans.ingestion._run(context, operation)

    async def abort_multipart(
        self, context: TenantContext, project_id: UUID, session_id: UUID, ordinal: int
    ) -> dict[str, Any]:
        # Caller must first abort its active browser PUTs. This never deletes an
        # object version, and cleanup still requires the creator's edit authority.
        async def claim(tx: TenantTransaction) -> tuple[Any, ...]:
            row = await self._object(tx, context, project_id, session_id, ordinal, cleanup=True)
            if row[5] == "complete":
                return row
            if row[7] <= PART_BYTES:
                raise IngestionConflict("archive_single_upload_not_multipart")
            if row[5] == "completing":
                # Resolve the completion outcome before deciding whether to abort.
                raise IngestionConflict("archive_completion_unresolved")
            if row[5] not in {"prepared", "creating", "uploading", "aborting", "aborted"}:
                raise IngestionConflict("archive_object_busy")
            if row[5] not in {"aborting", "aborted"}:
                await tx.execute(
                    """UPDATE app.archive_upload_objects SET state=%s
                    WHERE organization_id=%s AND session_id=%s AND ordinal=%s""",
                    (
                        "aborted" if row[5] == "prepared" else "aborting",
                        context.organization_id,
                        session_id,
                        row[0],
                    ),
                )
            return row

        row = await self.plans.ingestion._run(context, claim)
        if row[5] == "complete":
            return {"state": "complete", "receipt": row[9], "preserved": True}
        if row[5] in {"prepared", "aborted"}:
            return {"state": "aborted"}
        storage = self._storage(row)
        upload_id = row[6]
        if upload_id is None and row[5] != "prepared":
            uploads = await storage.find_uploads(row[2])
            if len(uploads) != 1:
                # The create could still be in flight; never claim absent resources.
                return {"state": "aborting", "reason": "archive_creation_unresolved"}
            upload_id = uploads[0]

            async def save_id(tx: TenantTransaction) -> None:
                current = await self._object(
                    tx, context, project_id, session_id, ordinal, cleanup=True
                )
                if current[5] != "aborting":
                    raise IngestionConflict("archive_object_changed")
                await tx.execute(
                    """UPDATE app.archive_upload_objects SET upload_id=%s
                    WHERE organization_id=%s AND session_id=%s AND ordinal=%s""",
                    (upload_id, context.organization_id, session_id, row[0]),
                )

            await self.plans.ingestion._run(context, save_id)
        if upload_id:
            await storage.abort(row[2], upload_id)
            if not await storage.upload_absent(row[2], upload_id):
                return {"state": "aborting", "reason": "archive_parts_cleanup_pending"}

        async def finish(tx: TenantTransaction) -> None:
            current = await self._object(tx, context, project_id, session_id, ordinal, cleanup=True)
            if current[5] not in {"aborting", "aborted"}:
                raise IngestionConflict("archive_object_changed")
            await tx.execute(
                """UPDATE app.archive_upload_objects SET state='aborted'
                WHERE organization_id=%s AND session_id=%s AND ordinal=%s""",
                (context.organization_id, session_id, row[0]),
            )

        await self.plans.ingestion._run(context, finish)
        return {"state": "aborted"}

    async def uploaded_parts(
        self,
        context: TenantContext,
        project_id: UUID,
        session_id: UUID,
        ordinal: int,
        after: int = 0,
    ) -> dict[str, Any]:
        if type(after) is not int or not 0 <= after <= 10_000:
            raise IngestionConflict("archive_cursor_invalid")

        async def operation(tx: TenantTransaction) -> tuple[Any, ...]:
            row = await self._object(tx, context, project_id, session_id, ordinal)
            if row[5] != "uploading" or not row[6]:
                raise IngestionConflict("archive_multipart_not_ready")
            return row

        row = await self.plans.ingestion._run(context, operation)
        return await self._storage(row).list_parts(row[2], row[6], after)
