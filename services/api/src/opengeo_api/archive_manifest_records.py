"""Preserve reconstruction pages without mixing storage destination boundaries."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb

from opengeo_api.archive_upload_storage import ArchiveS3Storage
from opengeo_api.archive_uploads import ArchiveUploadRepository
from opengeo_api.ingestion import IngestionConflict, IngestionNotFound
from opengeo_api.tenant_database import TenantContext, TenantTransaction


class ArchiveManifestRepository:
    def __init__(
        self,
        plans: ArchiveUploadRepository,
        storage_factory: Callable[[str, str, str], ArchiveS3Storage] = ArchiveS3Storage,
    ) -> None:
        self.plans = plans
        self.storage_factory = storage_factory

    async def _authorize(
        self, tx: TenantTransaction, context: TenantContext, project: UUID, session: UUID
    ) -> None:
        await self.plans._authorize(tx, context, project)
        row = await tx.fetch_one(
            """SELECT state FROM app.archive_upload_sessions
            WHERE organization_id=%s AND project_id=%s AND id=%s AND created_by=%s""",
            (context.organization_id, project, session, context.user_id),
        )
        if row is None:
            raise IngestionNotFound("archive_session")
        if row[0] != "complete":
            raise IngestionConflict("archive_upload_incomplete")

    async def restore_ticket(
        self, context: TenantContext, project: UUID, session: UUID, ordinal: int
    ) -> dict[str, Any]:
        if type(ordinal) is not int or not 0 <= ordinal < 100_000:
            raise IngestionConflict("archive_ordinal_invalid")

        async def read(tx: TenantTransaction) -> tuple[Any, ...]:
            await self._authorize(tx, context, project, session)
            row = await tx.fetch_one(
                """SELECT f.relative_path,f.size_bytes,f.sha256,o.receipt,
                 o.bucket,o.object_prefix,o.expected_bucket_owner
                FROM app.archive_upload_files f JOIN app.archive_upload_files c
                 ON c.organization_id=f.organization_id AND c.session_id=f.session_id
                 AND c.destination_id=f.destination_id AND c.size_bytes=f.size_bytes
                 AND c.sha256=f.sha256
                JOIN app.archive_upload_objects o ON o.organization_id=c.organization_id
                 AND o.session_id=c.session_id AND o.ordinal=c.ordinal
                JOIN app.archive_upload_destinations d ON d.organization_id=f.organization_id
                 AND d.id=f.destination_id
                WHERE f.organization_id=%s AND f.session_id=%s AND f.ordinal=%s
                 AND o.state='complete' AND o.receipt IS NOT NULL AND d.enabled""",
                (context.organization_id, session, ordinal),
            )
            if row is None:
                raise IngestionNotFound("archive_object")
            return row

        row = await self.plans.ingestion._run(context, read)
        storage = self.storage_factory(row[4], row[5], row[6])
        ticket = storage.sign_download(row[3]["key"], row[3]["version_id"])
        return {
            "path": row[0],
            "size_bytes": row[1],
            "sha256": row[2],
            "object": row[3],
            "ticket": ticket,
        }

    async def preserve_index(
        self, context: TenantContext, project: UUID, session: UUID, destination: UUID
    ) -> dict[str, Any]:
        async def prepare(
            tx: TenantTransaction,
        ) -> tuple[tuple[Any, ...], str, bytes, dict[str, Any] | None]:
            await self._authorize(tx, context, project, session)
            enabled = await tx.fetch_one(
                """SELECT enabled FROM app.archive_upload_destinations
                WHERE organization_id=%s AND project_id=%s AND id=%s""",
                (context.organization_id, project, destination),
            )
            if not enabled or not enabled[0]:
                raise IngestionConflict("archive_destination_unavailable")
            coverage = await tx.fetch_all(
                """SELECT (ordinal/25)*25,count(*),sum(size_bytes)
                FROM app.archive_upload_files WHERE organization_id=%s AND session_id=%s
                 AND destination_id=%s GROUP BY (ordinal/25)*25 ORDER BY (ordinal/25)*25""",
                (context.organization_id, session, destination),
            )
            pages = await tx.fetch_all(
                """SELECT first_ordinal,bucket,object_prefix,expected_bucket_owner,receipt
                FROM app.archive_manifest_records WHERE organization_id=%s AND session_id=%s
                 AND destination_id=%s AND first_ordinal>=0 ORDER BY first_ordinal""",
                (context.organization_id, session, destination),
            )
            if (
                not coverage
                or len(coverage) > 4000
                or [page[0] for page in pages] != [part[0] for part in coverage]
                or any(page[4] is None for page in pages)
            ):
                raise IngestionConflict("archive_manifest_incomplete")
            first = pages[0]
            if any(page[1:4] != first[1:4] for page in pages):
                raise IngestionConflict("archive_manifest_conflict")
            key = f"{first[2]}uploads/{session}/manifests/{destination}/index.json"
            body = json.dumps(
                {
                    "schema": "opengeo-browser-archive-index/v1",
                    "uploadId": str(session),
                    "destinationId": str(destination),
                    "fileCount": sum(part[1] for part in coverage),
                    "logicalBytes": sum(int(part[2]) for part in coverage),
                    "pages": [
                        {
                            "firstOrdinal": page[0],
                            "fileCount": part[1],
                            "logicalBytes": int(part[2]),
                            "object": page[4],
                        }
                        for page, part in zip(pages, coverage, strict=True)
                    ],
                },
                sort_keys=True,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode()
            if len(body) > 32 * 1024 * 1024 or len(key.encode()) > 1024:
                raise IngestionConflict("archive_manifest_size_invalid")
            await tx.execute(
                """INSERT INTO app.archive_manifest_records
                (organization_id,project_id,session_id,destination_id,first_ordinal,
                 bucket,object_key,object_prefix,expected_bucket_owner,body)
                VALUES (%s,%s,%s,%s,-1,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                (
                    context.organization_id,
                    project,
                    session,
                    destination,
                    first[1],
                    key,
                    first[2],
                    first[3],
                    body,
                ),
            )
            saved = await tx.fetch_one(
                """SELECT body,receipt FROM app.archive_manifest_records
                WHERE organization_id=%s AND session_id=%s AND destination_id=%s
                 AND first_ordinal=-1""",
                (context.organization_id, session, destination),
            )
            if saved is None or bytes(saved[0]) != body:
                raise IngestionConflict("archive_manifest_conflict")
            return first, key, body, saved[1]

        async with asyncio.timeout(90):
            first, key, body, receipt = await self.plans.ingestion._run(context, prepare)
            if receipt is None:
                storage = self.storage_factory(first[1], first[2], first[3])
                receipt = await storage.preserve_index(key, body)

                async def record(tx: TenantTransaction) -> None:
                    await self._authorize(tx, context, project, session)
                    await tx.execute(
                        """UPDATE app.archive_manifest_records SET receipt=%s
                        WHERE organization_id=%s AND session_id=%s AND destination_id=%s
                         AND first_ordinal=-1 AND receipt IS NULL""",
                        (Jsonb(receipt), context.organization_id, session, destination),
                    )

                await self.plans.ingestion._run(context, record)
            return {"destination_id": destination, "object": receipt}

    async def preserve_page(
        self, context: TenantContext, project: UUID, session: UUID, after: int = -1
    ) -> dict[str, Any]:
        # Fixed page boundaries make retries deterministic, including a lost response.
        if type(after) is not int or not -1 <= after < 100_000 or (after + 1) % 25:
            raise IngestionConflict("archive_cursor_invalid")

        async def prepare(
            tx: TenantTransaction,
        ) -> tuple[list[tuple[UUID, tuple[Any, ...]]], int | None]:
            await self._authorize(tx, context, project, session)
            rows = await tx.fetch_all(
                """SELECT f.ordinal,f.relative_path,f.size_bytes,f.modified_milliseconds,
                f.sha256,o.ordinal,o.receipt,f.destination_id,o.bucket,o.object_prefix,
                o.expected_bucket_owner,d.enabled
                FROM app.archive_upload_files f JOIN app.archive_upload_files c
                 ON c.organization_id=f.organization_id AND c.session_id=f.session_id
                 AND c.destination_id=f.destination_id AND c.size_bytes=f.size_bytes
                 AND c.sha256=f.sha256
                JOIN app.archive_upload_objects o ON o.organization_id=c.organization_id
                 AND o.session_id=c.session_id AND o.ordinal=c.ordinal
                JOIN app.archive_upload_destinations d ON d.organization_id=f.organization_id
                 AND d.id=f.destination_id
                WHERE f.organization_id=%s AND f.project_id=%s AND f.session_id=%s
                 AND f.ordinal>%s ORDER BY f.ordinal LIMIT 25""",
                (context.organization_id, project, session, after),
            )
            groups: dict[UUID, list[tuple[Any, ...]]] = {}
            for row in rows:
                if not row[11]:
                    raise IngestionConflict("archive_destination_unavailable")
                groups.setdefault(row[7], []).append(row)
            intents = []
            for destination, files in groups.items():
                first = files[0]
                key = (
                    f"{first[9]}uploads/{session}/manifests/{destination}/part-{after + 1:06d}.json"
                )
                body = json.dumps(
                    {
                        "schema": "opengeo-browser-archive-page/v1",
                        "uploadId": str(session),
                        "destinationId": str(destination),
                        "firstOrdinal": after + 1,
                        "files": [
                            dict(
                                zip(
                                    (
                                        "ordinal",
                                        "path",
                                        "size_bytes",
                                        "modified_milliseconds",
                                        "sha256",
                                        "object_ordinal",
                                        "object",
                                    ),
                                    file[:7],
                                    strict=True,
                                )
                            )
                            for file in files
                        ],
                        "filesystemLimits": [
                            "Browser selection omits Unix modes, symbolic links "
                            "and empty directories."
                        ],
                    },
                    sort_keys=True,
                    ensure_ascii=True,
                    separators=(",", ":"),
                ).encode()
                if len(body) > 256 * 1024 or len(key.encode()) > 1024:
                    raise IngestionConflict("archive_manifest_size_invalid")
                await tx.execute(
                    """INSERT INTO app.archive_manifest_records
                    (organization_id,project_id,session_id,destination_id,first_ordinal,
                     bucket,object_key,object_prefix,expected_bucket_owner,body)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                    (
                        context.organization_id,
                        project,
                        session,
                        destination,
                        after + 1,
                        first[8],
                        key,
                        first[9],
                        first[10],
                        body,
                    ),
                )
                saved = await tx.fetch_one(
                    """SELECT bucket,object_key,object_prefix,expected_bucket_owner,body,receipt
                    FROM app.archive_manifest_records WHERE organization_id=%s
                     AND session_id=%s AND destination_id=%s AND first_ordinal=%s""",
                    (context.organization_id, session, destination, after + 1),
                )
                if saved is None or bytes(saved[4]) != body or saved[1] != key:
                    raise IngestionConflict("archive_manifest_conflict")
                intents.append((destination, saved))
            return intents, rows[-1][0] if len(rows) == 25 else None

        async with asyncio.timeout(90):
            intents, next_after = await self.plans.ingestion._run(context, prepare)
            receipts = []
            for destination, row in intents:
                receipt = row[5]
                if receipt is None:
                    storage = self.storage_factory(row[0], row[2], row[3])
                    receipt = await storage.preserve_manifest(row[1], bytes(row[4]))

                    async def record(
                        tx: TenantTransaction,
                        receipt: dict[str, Any] = receipt,
                        destination: UUID = destination,
                    ) -> None:
                        await self._authorize(tx, context, project, session)
                        await tx.execute(
                            """UPDATE app.archive_manifest_records SET receipt=%s
                            WHERE organization_id=%s AND session_id=%s
                             AND destination_id=%s AND first_ordinal=%s AND receipt IS NULL""",
                            (
                                Jsonb(receipt),
                                context.organization_id,
                                session,
                                destination,
                                after + 1,
                            ),
                        )

                    await self.plans.ingestion._run(context, record)
                receipts.append(
                    {"destination_id": destination, "first_ordinal": after + 1, "object": receipt}
                )
            return {"records": receipts, "next_after": next_after}
