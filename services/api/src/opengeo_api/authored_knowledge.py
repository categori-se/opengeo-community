"""Shared descriptive revisions; content/build versions remain independent."""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb

from opengeo_api.authorization import Action, Roles, is_allowed
from opengeo_api.resource_knowledge import empty_knowledge, validate_knowledge
from opengeo_api.tenant_database import TenantContext, TenantTransaction, TenantTransactionExecutor
from opengeo_api.workspace_collections import (
    CollectionAccessDenied,
    CollectionConflict,
    CollectionNotFound,
    PostgresCollectionRepository,
)

TARGETS = {
    "project": ("maps", "map_id", Action.MAP_READ, Action.MAP_UPDATE),
    "publication": ("project_sites", "site_id", Action.SITE_READ, Action.SITE_MANAGE),
    "collection": ("workspace_collections", "collection_id", None, None),
}


class PostgresAuthoredKnowledgeRepository:
    def __init__(
        self, executor: TenantTransactionExecutor, collections: PostgresCollectionRepository
    ) -> None:
        self.executor = executor
        self.collections = collections

    async def _authority(
        self,
        tx: TenantTransaction,
        context: TenantContext,
        kind: str,
        identity: UUID,
        *,
        lock: bool = False,
    ) -> bool:
        if kind not in TARGETS:
            raise CollectionNotFound()
        if kind == "collection":
            collection = await self.collections._role(tx, context, identity, lock=lock)
            return collection[5] in {"owner", "editor"}
        table, _, read, edit = TARGETS[kind]
        if read is None or edit is None:
            raise CollectionNotFound()
        row = await tx.fetch_one(
            f"""SELECT membership.role::text,
                app.effective_project_role(target.project_id, membership.user_id)::text
                FROM app.{table} target JOIN app.organization_memberships membership
                ON membership.organization_id=target.organization_id AND membership.user_id=%s
                WHERE target.organization_id=%s AND target.id=%s"""
            + (" FOR UPDATE OF target" if lock else ""),
            (context.user_id, context.organization_id, identity),
        )
        if row is None or not is_allowed(read, Roles(row[0], row[1])):
            raise CollectionNotFound()
        return is_allowed(edit, Roles(row[0], row[1]))

    async def read(
        self, context: TenantContext, kind: str, identity: UUID, version: int | None = None
    ) -> dict[str, Any]:
        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            can_edit = await self._authority(tx, context, kind, identity)
            row = await tx.fetch_one(
                """SELECT version_number,document,created_by,created_at
                FROM app.authored_resource_knowledge_revisions
                WHERE organization_id=%s AND kind=%s AND resource_id=%s
                  AND (%s::integer IS NULL OR version_number=%s)
                ORDER BY version_number DESC LIMIT 1""",
                (context.organization_id, kind, identity, version, version),
            )
            if row is None and version is not None:
                raise CollectionNotFound()
            return self._record(kind, identity, row, can_edit)

        return await self.executor.run(context, operation)

    async def save(
        self,
        context: TenantContext,
        kind: str,
        identity: UUID,
        document: dict[str, Any],
        expected_version: int,
    ) -> dict[str, Any]:
        validated = validate_knowledge(document)

        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            if not await self._authority(tx, context, kind, identity, lock=True):
                raise CollectionAccessDenied()
            row = await tx.fetch_one(
                """SELECT version_number FROM app.authored_resource_knowledge_revisions
                WHERE organization_id=%s AND kind=%s AND resource_id=%s
                ORDER BY version_number DESC LIMIT 1""",
                (context.organization_id, kind, identity),
            )
            current = row[0] if row else 0
            if current != expected_version:
                raise CollectionConflict()
            column = TARGETS[kind][1]
            saved = await tx.fetch_one(
                f"""INSERT INTO app.authored_resource_knowledge_revisions
                (organization_id,{column},version_number,document,created_by)
                VALUES (%s,%s,%s,%s,%s)
                RETURNING version_number,document,created_by,created_at""",
                (context.organization_id, identity, current + 1, Jsonb(validated), context.user_id),
            )
            return self._record(kind, identity, saved, True)

        return await self.executor.run(context, operation)

    @staticmethod
    def _record(
        kind: str, identity: UUID, row: tuple[Any, ...] | None, can_edit: bool
    ) -> dict[str, Any]:
        return {
            "kind": kind,
            "resource_id": str(identity),
            "version": row[0] if row else 0,
            "document": (json.loads(row[1]) if isinstance(row[1], str) else row[1])
            if row
            else empty_knowledge(),
            "created_by": str(row[2]) if row else None,
            "created_at": row[3].isoformat() if row else None,
            "can_edit": can_edit,
        }
