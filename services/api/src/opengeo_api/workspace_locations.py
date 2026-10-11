"""Independent, versioned geographic identity; no provider ingestion or build side effects."""

from __future__ import annotations

import builtins
import json
from copy import deepcopy
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.features import normalize_geometry
from opengeo_api.resource_knowledge import validate_knowledge
from opengeo_api.tenant_database import TenantContext, TenantTransaction, TenantTransactionExecutor


class LocationNotFound(Exception):
    pass


class LocationAccessDenied(Exception):
    pass


class LocationConflict(Exception):
    pass


def validate_location(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "title",
        "canonical_uri",
        "aliases",
        "identifiers",
        "geometry",
        "knowledge",
    }:
        raise ValueError("Invalid Location fields")

    def text(item: object, maximum: int) -> None:
        if not isinstance(item, str) or not item.strip() or len(item) > maximum or "\0" in item:
            raise ValueError("Invalid Location text")

    text(value["title"], 200)
    uri = value["canonical_uri"]
    if uri is not None:
        text(uri, 2048)
        parsed = urlsplit(uri)
        if parsed.scheme not in {"https", "http", "urn"} or parsed.username or parsed.password:
            raise ValueError("Invalid canonical URI")
        if parsed.scheme in {"https", "http"} and not parsed.hostname:
            raise ValueError("Canonical URI requires a host")
    for key in ("aliases", "identifiers"):
        if not isinstance(value[key], list) or len(value[key]) > 64:
            raise ValueError("Invalid Location names/identifiers")
    for alias in value["aliases"]:
        text(alias, 200)
    for identifier in value["identifiers"]:
        if not isinstance(identifier, dict) or set(identifier) != {"scheme", "value"}:
            raise ValueError("Invalid Location identifier")
        text(identifier["scheme"], 2048)
        text(identifier["value"], 2048)
    if value["geometry"] is not None:
        if not isinstance(value["geometry"], dict) or not isinstance(
            value["geometry"].get("type"), str
        ):
            raise ValueError("Invalid Location geometry")
        normalize_geometry(value["geometry"])
    validate_knowledge(value["knowledge"])
    if len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode()) > 350000:
        raise ValueError("Location document exceeds limit")
    return deepcopy(value)


class PostgresLocationRepository:
    def __init__(self, executor: TenantTransactionExecutor) -> None:
        self.executor = executor

    async def _identity(
        self, tx: TenantTransaction, context: TenantContext, identity: UUID, lock: bool = False
    ) -> tuple[Any, ...]:
        row = await tx.fetch_one(
            """SELECT l.revision,l.owner_user_id,l.created_by,l.access_revision,
            CASE WHEN l.owner_user_id=m.user_id OR m.role::text='admin'
                 THEN 'owner' ELSE g.role END
            FROM app.workspace_locations l JOIN app.organization_memberships m
            ON m.organization_id=l.organization_id AND m.user_id=%s
            LEFT JOIN app.workspace_location_grants g ON g.organization_id=l.organization_id
              AND g.location_id=l.id AND g.user_id=m.user_id
            WHERE l.organization_id=%s AND l.id=%s
            AND (l.owner_user_id=m.user_id OR m.role::text='admin' OR g.role IS NOT NULL)"""
            + (" FOR UPDATE OF l" if lock else ""),
            (context.user_id, context.organization_id, identity),
        )
        if row is None:
            raise LocationNotFound()
        return row

    async def list(
        self, context: TenantContext, limit: int = 50, offset: int = 0
    ) -> builtins.list[dict[str, Any]]:
        async def operation(tx: TenantTransaction) -> builtins.list[dict[str, Any]]:
            rows = await tx.fetch_all(
                """SELECT l.id,l.revision,r.document->>'title'
                FROM app.workspace_locations l
                JOIN app.workspace_location_revisions r ON r.organization_id=l.organization_id
                  AND r.location_id=l.id AND r.revision=l.revision
                JOIN app.organization_memberships m
                  ON m.organization_id=l.organization_id AND m.user_id=%s
                LEFT JOIN app.workspace_location_grants g ON g.organization_id=l.organization_id
                  AND g.location_id=l.id AND g.user_id=m.user_id
                WHERE l.organization_id=%s
                  AND (l.owner_user_id=m.user_id OR m.role::text='admin' OR g.role IS NOT NULL)
                ORDER BY l.id LIMIT %s OFFSET %s""",
                (context.user_id, context.organization_id, limit, offset),
            )
            return [{"id": str(row[0]), "revision": row[1], "title": row[2]} for row in rows]

        return await self.executor.run(context, operation)

    async def read(
        self, context: TenantContext, identity: UUID, version: int | None = None
    ) -> dict[str, Any]:
        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            row = await self._identity(tx, context, identity)
            revision = row[0] if version is None else version
            record = await tx.fetch_one(
                """SELECT document FROM app.workspace_location_revisions
                WHERE organization_id=%s AND location_id=%s AND revision=%s""",
                (context.organization_id, identity, revision),
            )
            if record is None:
                raise LocationNotFound()
            document = json.loads(record[0]) if isinstance(record[0], str) else record[0]
            return {
                "id": str(identity),
                "revision": revision,
                "current_revision": row[0],
                "owner_user_id": str(row[1]),
                "created_by": str(row[2]),
                "access_revision": row[3],
                "role": row[4],
                "document": document,
            }

        return await self.executor.run(context, operation)

    async def save(
        self,
        context: TenantContext,
        document: dict[str, Any],
        identity: UUID | None = None,
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        document = validate_location(document)

        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            target = identity or uuid4()
            if identity is None:
                member = await tx.fetch_one(
                    "SELECT 1 FROM app.organization_memberships "
                    "WHERE organization_id=%s AND user_id=%s",
                    (context.organization_id, context.user_id),
                )
                if member is None:
                    raise LocationNotFound()
                revision = 1
                await tx.execute(
                    """INSERT INTO app.workspace_locations
                    (organization_id,id,owner_user_id,created_by)
                    VALUES (%s,%s,%s,%s)""",
                    (context.organization_id, target, context.user_id, context.user_id),
                )
            else:
                row = await self._identity(tx, context, identity, lock=True)
                if row[4] == "reader":
                    raise LocationAccessDenied()
                if row[0] != expected_revision:
                    raise LocationConflict()
                revision = row[0] + 1
                await tx.execute(
                    """UPDATE app.workspace_locations SET revision=%s,updated_at=clock_timestamp()
                    WHERE organization_id=%s AND id=%s""",
                    (revision, context.organization_id, target),
                )
            await tx.execute(
                """INSERT INTO app.workspace_location_revisions
                (organization_id,location_id,revision,document,created_by)
                VALUES (%s,%s,%s,%s,%s)""",
                (context.organization_id, target, revision, Jsonb(document), context.user_id),
            )
            return {"id": str(target), "revision": revision}

        return await self.executor.run(context, operation)

    async def grants(
        self, context: TenantContext, identity: UUID, limit: int = 50, offset: int = 0
    ) -> dict[str, Any]:
        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            row = await self._identity(tx, context, identity)
            if row[4] != "owner":
                raise LocationAccessDenied()
            rows = await tx.fetch_all(
                """SELECT g.user_id,u.display_name,u.email,g.role
                FROM app.workspace_location_grants g JOIN app.users u ON u.id=g.user_id
                WHERE g.organization_id=%s AND g.location_id=%s
                ORDER BY g.user_id LIMIT %s OFFSET %s""",
                (context.organization_id, identity, limit, offset),
            )
            return {
                "revision": row[3],
                "grants": [
                    {
                        "user_id": str(item[0]),
                        "display_name": item[1],
                        "email": item[2],
                        "role": item[3],
                    }
                    for item in rows
                ],
            }

        return await self.executor.run(context, operation)

    async def grant(
        self,
        context: TenantContext,
        identity: UUID,
        user_id: UUID,
        expected_revision: int,
        role: str | None,
    ) -> dict[str, Any]:
        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            row = await self._identity(tx, context, identity, lock=True)
            if row[4] != "owner":
                raise LocationAccessDenied()
            if row[3] != expected_revision or row[1] == user_id:
                raise LocationConflict()
            if role not in {None, "reader", "editor"}:
                raise ValueError("Invalid Location role")
            member = await tx.fetch_one(
                "SELECT 1 FROM app.organization_memberships "
                "WHERE organization_id=%s AND user_id=%s",
                (context.organization_id, user_id),
            )
            if member is None:
                raise LocationConflict()
            await tx.execute(
                "DELETE FROM app.workspace_location_grants "
                "WHERE organization_id=%s AND location_id=%s AND user_id=%s",
                (context.organization_id, identity, user_id),
            )
            if role is not None:
                await tx.execute(
                    """INSERT INTO app.workspace_location_grants
                    (organization_id,location_id,user_id,role) VALUES (%s,%s,%s,%s)""",
                    (context.organization_id, identity, user_id, role),
                )
            await tx.execute(
                "UPDATE app.workspace_locations SET access_revision=access_revision+1 "
                "WHERE organization_id=%s AND id=%s",
                (context.organization_id, identity),
            )
            return {"id": str(identity), "revision": row[3] + 1}

        return await self.executor.run(context, operation)

    async def parent(
        self, context: TenantContext, identity: UUID, version: int | None = None
    ) -> dict[str, Any]:
        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            await self._identity(tx, context, identity)
            current = await tx.fetch_one(
                "SELECT hierarchy_revision FROM app.workspace_locations "
                "WHERE organization_id=%s AND id=%s",
                (context.organization_id, identity),
            )
            if current is None:
                raise LocationNotFound()
            revision = current[0] if version is None else version
            if revision == 0:
                return {
                    "revision": 0,
                    "current_revision": current[0],
                    "parent_available": True,
                    "parent": None,
                    "evidence": [],
                    "confidence": None,
                }
            row = await tx.fetch_one(
                """SELECT parent_id,evidence,confidence FROM app.workspace_location_parent_revisions
                WHERE organization_id=%s AND location_id=%s AND revision=%s""",
                (context.organization_id, identity, revision),
            )
            if row is None:
                raise LocationNotFound()
            parent = None
            if row[0] is not None:
                try:
                    target = await self._identity(tx, context, row[0])
                except LocationNotFound:
                    return {
                        "revision": revision,
                        "current_revision": current[0],
                        "parent_available": False,
                    }
                title = await tx.fetch_one(
                    """SELECT document->>'title' FROM app.workspace_location_revisions
                    WHERE organization_id=%s AND location_id=%s AND revision=%s""",
                    (context.organization_id, row[0], target[0]),
                )
                if title is None:
                    raise LocationNotFound()
                parent = {"id": str(row[0]), "title": title[0]}
            evidence = json.loads(row[1]) if isinstance(row[1], str) else row[1]
            return {
                "revision": revision,
                "current_revision": current[0],
                "parent_available": True,
                "parent": parent,
                "evidence": evidence,
                "confidence": row[2],
            }

        return await self.executor.run(context, operation)

    async def set_parent(
        self,
        context: TenantContext,
        identity: UUID,
        expected_revision: int,
        parent_id: UUID | None,
        evidence: builtins.list[str],
        confidence: float | None,
    ) -> dict[str, Any]:
        import math

        if not isinstance(evidence, list) or len(evidence) > 16:
            raise ValueError("Invalid hierarchy evidence")
        for uri in evidence:
            if not isinstance(uri, str) or not 1 <= len(uri) <= 2048:
                raise ValueError("Invalid evidence URI")
            parsed = urlsplit(uri)
            if parsed.scheme not in {"http", "https", "urn"} or parsed.username or parsed.password:
                raise ValueError("Invalid evidence URI")
        if confidence is not None and (
            isinstance(confidence, bool)
            or not isinstance(confidence, (int, float))
            or not math.isfinite(confidence)
            or not 0 <= confidence <= 1
        ):
            raise ValueError("Invalid hierarchy confidence")

        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            # Serialize graph edits per account before taking any identity row lock.
            await tx.fetch_one(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s::text,118))",
                (str(context.organization_id),),
            )
            child = await self._identity(tx, context, identity, lock=True)
            if child[4] == "reader":
                raise LocationAccessDenied()
            row = await tx.fetch_one(
                "SELECT hierarchy_revision FROM app.workspace_locations "
                "WHERE organization_id=%s AND id=%s",
                (context.organization_id, identity),
            )
            if row is None:
                raise LocationNotFound()
            if row[0] != expected_revision:
                raise LocationConflict()
            if parent_id is not None:
                await self._identity(tx, context, parent_id)
                ancestry = await tx.fetch_one(
                    """WITH RECURSIVE ancestry AS (
                    SELECT id,parent_id,1 AS depth FROM app.workspace_locations
                    WHERE organization_id=%s AND id=%s
                    UNION ALL
                    SELECT l.id,l.parent_id,a.depth+1 FROM app.workspace_locations l
                    JOIN ancestry a ON l.id=a.parent_id
                    WHERE l.organization_id=%s AND a.depth<128)
                    SELECT COALESCE(bool_or(id=%s),false),COALESCE(max(depth),0) FROM ancestry""",
                    (context.organization_id, parent_id, context.organization_id, identity),
                )
                if ancestry is None or ancestry[0] or ancestry[1] >= 128:
                    raise LocationConflict()
            revision = row[0] + 1
            await tx.execute(
                """INSERT INTO app.workspace_location_parent_revisions
                (organization_id,location_id,revision,parent_id,evidence,confidence,created_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                (
                    context.organization_id,
                    identity,
                    revision,
                    parent_id,
                    Jsonb(evidence),
                    confidence,
                    context.user_id,
                ),
            )
            await tx.execute(
                "UPDATE app.workspace_locations SET hierarchy_revision=%s,parent_id=%s "
                "WHERE organization_id=%s AND id=%s",
                (revision, parent_id, context.organization_id, identity),
            )
            return {"id": str(identity), "revision": revision}

        return await self.executor.run(context, operation)
