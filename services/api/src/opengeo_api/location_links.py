"""Versioned Location references; linked resources retain independent authority."""

from __future__ import annotations

import json
from typing import Any, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.ingestion import (
    IngestionAccessDenied,
    IngestionNotFound,
    PostgresIngestionRepository,
)
from opengeo_api.tenant_database import TenantContext, TenantTransaction, TenantTransactionExecutor
from opengeo_api.workspace_collections import CollectionNotFound, PostgresCollectionRepository
from opengeo_api.workspace_locations import (
    LocationAccessDenied,
    LocationConflict,
    LocationNotFound,
    PostgresLocationRepository,
)

KINDS = ("layer", "project", "publication", "collection")


class PostgresLocationLinksRepository:
    def __init__(
        self,
        executor: TenantTransactionExecutor,
        locations: PostgresLocationRepository,
        collections: PostgresCollectionRepository,
        ingestion: PostgresIngestionRepository,
    ) -> None:
        self.executor = executor
        self.locations = locations
        self.collections = collections
        self.ingestion = ingestion

    async def _target(
        self, tx: TenantTransaction, context: TenantContext, kind: str, identity: UUID
    ) -> str | None:
        if kind == "layer":
            try:
                item = await self.ingestion._load_catalog_dataset(tx, context, identity)
                return item.name
            except (IngestionNotFound, IngestionAccessDenied):
                return None
        if kind == "collection":
            try:
                return cast(str, (await self.collections._role(tx, context, identity))[0])
            except CollectionNotFound:
                return None
        target = await self.collections._target(tx, context, kind, identity)
        return cast(str, target[0]) if target else None

    async def _entries(
        self, tx: TenantTransaction, context: TenantContext, identity: UUID, revision: int
    ) -> list[tuple[Any, ...]]:
        return await tx.fetch_all(
            """SELECT entry_id,dataset_id,map_id,site_id,collection_id,
            relationship,evidence,confidence
            FROM app.workspace_location_link_entries
            WHERE organization_id=%s AND location_id=%s AND revision=%s ORDER BY position""",
            (context.organization_id, identity, revision),
        )

    async def read(
        self, context: TenantContext, identity: UUID, version: int | None = None
    ) -> dict[str, Any]:
        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            await self.locations._identity(tx, context, identity)
            current_row = await tx.fetch_one(
                "SELECT links_revision FROM app.workspace_locations "
                "WHERE organization_id=%s AND id=%s",
                (context.organization_id, identity),
            )
            if current_row is None:
                raise LocationNotFound()
            current = current_row[0]
            revision = current if version is None else version
            if revision and not await tx.fetch_one(
                "SELECT 1 FROM app.workspace_location_link_revisions "
                "WHERE organization_id=%s AND location_id=%s AND revision=%s",
                (context.organization_id, identity, revision),
            ):
                raise LocationNotFound()
            entries = []
            for row in await self._entries(tx, context, identity, revision):
                index = next(i for i in range(4) if row[i + 1] is not None)
                kind, target = KINDS[index], row[index + 1]
                title = await self._target(tx, context, kind, target)
                entry = {"entry_id": str(row[0]), "available": title is not None}
                if title is not None:
                    entry.update(
                        kind=kind,
                        target_id=str(target),
                        title=title,
                        relationship=row[5],
                        evidence=json.loads(row[6]) if isinstance(row[6], str) else row[6],
                        confidence=row[7],
                    )
                entries.append(entry)
            return {"revision": revision, "current_revision": current, "entries": entries}

        return await self.executor.run(context, operation)

    async def replace(
        self,
        context: TenantContext,
        identity: UUID,
        expected_revision: int,
        entries: list[dict[str, Any]],
    ) -> dict[str, Any]:
        if len(entries) > 200:
            raise LocationConflict()

        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            owner = await self.locations._identity(tx, context, identity, lock=True)
            if owner[4] == "reader":
                raise LocationAccessDenied()
            current_row = await tx.fetch_one(
                "SELECT links_revision FROM app.workspace_locations "
                "WHERE organization_id=%s AND id=%s",
                (context.organization_id, identity),
            )
            if current_row is None:
                raise LocationNotFound()
            current = current_row[0]
            if current != expected_revision:
                raise LocationConflict()
            existing = {
                str(row[0]): row for row in await self._entries(tx, context, identity, current)
            }
            normalized = []
            identities = set()
            for entry in entries:
                if "entry_id" in entry:
                    row = existing.get(str(entry["entry_id"]))
                    if row is None:
                        raise LocationConflict()
                    values = list(row)
                    values[6] = json.loads(values[6]) if isinstance(values[6], str) else values[6]
                else:
                    kind, target = entry["kind"], entry["target_id"]
                    if kind not in KINDS or await self._target(tx, context, kind, target) is None:
                        raise LocationConflict()
                    targets = [None] * 4
                    targets[KINDS.index(kind)] = target
                    values = [
                        uuid4(),
                        *targets,
                        entry["relationship"],
                        entry["evidence"],
                        entry["confidence"],
                    ]
                key = (*values[1:5], values[5])
                if key in identities:
                    raise LocationConflict()
                identities.add(key)
                normalized.append(values)
            revision = current + 1
            await tx.execute(
                "INSERT INTO app.workspace_location_link_revisions "
                "(organization_id,location_id,revision,created_by) VALUES (%s,%s,%s,%s)",
                (context.organization_id, identity, revision, context.user_id),
            )
            for position, normalized_row in enumerate(normalized):
                await tx.execute(
                    """INSERT INTO app.workspace_location_link_entries
                    (organization_id,location_id,revision,position,entry_id,dataset_id,map_id,
                     site_id,collection_id,relationship,evidence,confidence)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (
                        context.organization_id,
                        identity,
                        revision,
                        position,
                        *normalized_row[:6],
                        Jsonb(normalized_row[6]),
                        normalized_row[7],
                    ),
                )
            await tx.execute(
                "UPDATE app.workspace_locations SET links_revision=%s "
                "WHERE organization_id=%s AND id=%s",
                (revision, context.organization_id, identity),
            )
            return {"id": str(identity), "revision": revision}

        return await self.executor.run(context, operation)
