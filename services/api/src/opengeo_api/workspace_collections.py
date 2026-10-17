"""Product grouping only: Collection sharing never authorizes member content."""

from __future__ import annotations

import builtins
from typing import Any
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.rendering import PostgresRenderRepository
from opengeo_api.site_publications import SitePublicationRepository
from opengeo_api.tenant_database import TenantContext, TenantTransaction, TenantTransactionExecutor


class CollectionNotFound(Exception):
    pass


class CollectionConflict(Exception):
    pass


class CollectionAccessDenied(Exception):
    pass


class PostgresCollectionRepository:
    def __init__(self, executor: TenantTransactionExecutor) -> None:
        self.executor = executor

    @staticmethod
    async def _membership(
        tx: TenantTransaction, context: TenantContext, *, lock: bool = False
    ) -> str:
        row = await tx.fetch_one(
            "SELECT role::text FROM app.organization_memberships "
            "WHERE organization_id=%s AND user_id=%s" + (" FOR SHARE" if lock else ""),
            (context.organization_id, context.user_id),
        )
        if row is None:
            raise CollectionAccessDenied()
        return str(row[0])

    @staticmethod
    def _owner(row: tuple[Any, ...]) -> dict[str, str]:
        return {"principal_type": row[7], "principal_id": str(row[8])}

    async def _destination_owner(
        self,
        tx: TenantTransaction,
        context: TenantContext,
        owner: dict[str, Any] | None,
        *,
        transfer: bool = False,
    ) -> tuple[str, UUID]:
        organization_role = await self._membership(tx, context, lock=True)
        if owner is None:
            return "user", context.user_id
        if not isinstance(owner, dict) or set(owner) != {"principal_type", "principal_id"}:
            raise CollectionConflict("collection_owner_invalid")
        kind = owner["principal_type"]
        try:
            identity = UUID(str(owner["principal_id"]))
        except (ValueError, TypeError, AttributeError) as error:
            raise CollectionConflict("collection_owner_invalid") from error
        if kind == "user":
            if not transfer and identity != context.user_id and organization_role != "admin":
                raise CollectionAccessDenied()
            target = await tx.fetch_one(
                "SELECT user_id FROM app.organization_memberships "
                "WHERE organization_id=%s AND user_id=%s FOR SHARE",
                (context.organization_id, identity),
            )
        elif kind == "team":
            # Team mutations lock this same row. Keep it pinned through the write.
            target = await tx.fetch_one(
                "SELECT id FROM app.teams WHERE organization_id=%s AND id=%s "
                "AND status='active' FOR SHARE",
                (context.organization_id, identity),
            )
            if target is not None and organization_role != "admin":
                member = await tx.fetch_one(
                    "SELECT role::text FROM app.team_memberships WHERE organization_id=%s "
                    "AND team_id=%s AND user_id=%s FOR SHARE",
                    (context.organization_id, identity, context.user_id),
                )
                if member is None or member[0] not in {"owner", "manager"}:
                    raise CollectionAccessDenied()
        elif kind == "organization":
            if identity != context.organization_id or organization_role != "admin":
                raise CollectionAccessDenied()
            target = await tx.fetch_one(
                "SELECT id FROM app.organizations WHERE id=%s AND status='active' FOR SHARE",
                (identity,),
            )
        else:
            raise CollectionConflict("collection_owner_invalid")
        if target is None:
            raise CollectionConflict("collection_owner_unavailable")
        return str(kind), identity

    @staticmethod
    async def _owner_event(
        tx: TenantTransaction,
        context: TenantContext,
        collection_id: UUID,
        request_id: str,
        previous: dict[str, str] | None,
        owner: dict[str, str],
    ) -> None:
        await tx.execute(
            """INSERT INTO app.activity_events
            (organization_id,actor_user_id,project_id,event_type,resource_type,
             resource_id,request_id,payload)
            VALUES (%s,%s,NULL,%s,'collection',%s,%s,%s)""",
            (
                context.organization_id,
                context.user_id,
                "collection.owner.changed" if previous else "collection.created",
                collection_id,
                request_id,
                Jsonb({"previous_owner": previous, "owner": owner}),
            ),
        )

    async def _role(
        self,
        tx: TenantTransaction,
        context: TenantContext,
        collection_id: UUID,
        *,
        lock: bool = False,
    ) -> tuple[Any, ...]:
        if lock:
            await self._membership(tx, context, lock=True)
            # Lock order follows Collection then Team; Team membership mutations
            # only lock Team/member rows and do not acquire Collection rows.
            current = await tx.fetch_one(
                "SELECT owner_team_id FROM app.workspace_collections "
                "WHERE organization_id=%s AND id=%s FOR UPDATE",
                (context.organization_id, collection_id),
            )
            if current is None:
                raise CollectionNotFound()
            if current[0] is not None:
                await tx.fetch_one(
                    "SELECT id FROM app.teams WHERE organization_id=%s AND id=%s FOR SHARE",
                    (context.organization_id, current[0]),
                )
        row = await tx.fetch_one(
            """SELECT c.title,c.description,c.owner_user_id,c.created_by,c.revision,
               CASE WHEN m.role::text='admin' OR c.owner_user_id=%s
                 OR (team.status='active' AND tm.role::text IN ('owner','manager')) THEN 'owner'
               ELSE coalesce(g.role,CASE WHEN c.visibility IN ('account','public')
                 OR (team.status='active' AND tm.role::text='member') THEN 'reader' END) END,
               c.visibility,
               CASE WHEN c.owner_user_id IS NOT NULL THEN 'user'
                 WHEN c.owner_team_id IS NOT NULL THEN 'team' ELSE 'organization' END,
               coalesce(c.owner_user_id,c.owner_team_id,c.owner_organization_id),
               coalesce(owner.display_name,team.name,organization.name)
               FROM app.workspace_collections c
               JOIN app.organization_memberships m ON
               m.organization_id=c.organization_id AND m.user_id=%s
               LEFT JOIN app.workspace_collection_grants g ON g.organization_id=c.organization_id
                 AND g.collection_id=c.id AND g.user_id=m.user_id
               LEFT JOIN app.users owner ON owner.id=c.owner_user_id
               LEFT JOIN app.teams team ON team.organization_id=c.organization_id
                 AND team.id=c.owner_team_id
               LEFT JOIN app.team_memberships tm ON tm.organization_id=team.organization_id
                 AND tm.team_id=team.id AND tm.user_id=m.user_id
               LEFT JOIN app.organizations organization ON organization.id=c.owner_organization_id
               WHERE c.organization_id=%s AND c.id=%s""",
            (context.user_id, context.user_id, context.organization_id, collection_id),
        )
        if row is None or row[5] is None:
            raise CollectionNotFound()
        return row

    async def list(
        self,
        context: TenantContext,
        limit: int = 50,
        offset: int = 0,
        *,
        query: str = "",
        visibility: str | None = None,
        sort: str = "updated",
    ) -> builtins.list[dict[str, Any]]:
        orders = {
            "updated": "c.updated_at DESC,c.id",
            "title": "lower(c.title),c.id",
            "created": "c.created_at DESC,c.id",
        }
        if sort not in orders or visibility not in {None, "private", "account", "public"}:
            raise CollectionConflict("collection_filter_invalid")

        async def operation(tx: TenantTransaction) -> builtins.list[dict[str, Any]]:
            rows = await tx.fetch_all(
                f"""WITH page AS MATERIALIZED (
                SELECT c.*,m.role::text AS viewer_role,m.user_id AS viewer_id
                FROM app.workspace_collections c
                JOIN app.organization_memberships m
                  ON m.organization_id=c.organization_id AND m.user_id=%s
                LEFT JOIN app.workspace_collection_grants g ON g.organization_id=c.organization_id
                  AND g.collection_id=c.id AND g.user_id=m.user_id
                LEFT JOIN app.teams owning_team ON owning_team.organization_id=c.organization_id
                  AND owning_team.id=c.owner_team_id AND owning_team.status='active'
                LEFT JOIN app.team_memberships tm ON tm.organization_id=owning_team.organization_id
                  AND tm.team_id=owning_team.id AND tm.user_id=m.user_id
                WHERE c.organization_id=%s
                  AND (%s::text IS NULL OR c.visibility=%s)
                  AND (strpos(lower(c.title),lower(%s))>0
                    OR strpos(lower(c.description),lower(%s))>0)
                  AND (m.role::text='admin' OR c.owner_user_id=m.user_id OR g.role IS NOT NULL
                    OR tm.user_id IS NOT NULL OR c.visibility IN ('account','public'))
                ORDER BY {orders[sort]} LIMIT %s OFFSET %s
                )

                SELECT c.id,c.title,c.description,c.revision,c.visibility,
                coalesce(owner.display_name,owning_team.name,organization.name),
                c.updated_at,preview.visible_count,preview.items,
                CASE WHEN c.owner_user_id IS NOT NULL THEN 'user'
                  WHEN c.owner_team_id IS NOT NULL THEN 'team' ELSE 'organization' END,
                coalesce(c.owner_user_id,c.owner_team_id,c.owner_organization_id)
                FROM page c
                LEFT JOIN app.users owner ON owner.id=c.owner_user_id
                LEFT JOIN app.teams owning_team ON owning_team.organization_id=c.organization_id
                  AND owning_team.id=c.owner_team_id
                LEFT JOIN app.organizations organization ON organization.id=c.owner_organization_id
                LEFT JOIN LATERAL (
                  SELECT count(*) AS visible_count,
                    jsonb_path_query_array(jsonb_agg(jsonb_build_object(
                      'kind', CASE WHEN entry.map_id IS NOT NULL
                        THEN 'project' ELSE 'publication' END,
                      'title', coalesce(map.name,version.title)) ORDER BY entry.position),
                      '$[0 to 3]') AS items
                  FROM app.workspace_collection_entries entry
                  LEFT JOIN app.maps map ON map.organization_id=entry.organization_id
                    AND map.id=entry.map_id
                  LEFT JOIN app.project_sites site ON site.organization_id=entry.organization_id
                    AND site.id=entry.site_id
                  LEFT JOIN app.project_site_versions version
                    ON version.organization_id=site.organization_id
                    AND version.id=site.current_version_id
                  WHERE entry.organization_id=c.organization_id AND entry.collection_id=c.id
                    AND (map.id IS NOT NULL OR version.id IS NOT NULL)
                    AND (c.viewer_role='admin' OR
                      app.effective_project_role(coalesce(map.project_id,site.project_id),c.viewer_id)
                      IS NOT NULL)
                ) preview ON true
                ORDER BY {orders[sort]}""",
                (
                    context.user_id,
                    context.organization_id,
                    visibility,
                    visibility,
                    query,
                    query,
                    limit,
                    offset,
                ),
            )
            return [
                {
                    "id": str(row[0]),
                    "title": row[1],
                    "description": row[2],
                    "revision": row[3],
                    "visibility": row[4],
                    "owner_name": row[5],
                    "updated_at": row[6].isoformat(),
                    "visible_member_count": row[7],
                    "member_preview": row[8] or [],
                    "owner": {"principal_type": row[9], "principal_id": str(row[10])},
                }
                for row in rows
            ]

        return await self.executor.run(context, operation)

    async def candidates(
        self, context: TenantContext, kind: str, limit: int = 50, offset: int = 0
    ) -> builtins.list[dict[str, Any]]:
        table = "maps" if kind == "project" else "project_sites"
        title = "target.name" if kind == "project" else "version.title"
        version_join = (
            ""
            if kind == "project"
            else (
                "JOIN app.project_site_versions version ON "
                "version.organization_id=target.organization_id "
                "AND version.id=target.current_version_id"
            )
        )

        async def operation(tx: TenantTransaction) -> builtins.list[dict[str, Any]]:
            rows = await tx.fetch_all(
                f"""SELECT target.id,{title} FROM app.{table} target {version_join}
                JOIN app.organization_memberships m
                  ON m.organization_id=target.organization_id AND m.user_id=%s
                WHERE target.organization_id=%s AND (m.role::text='admin' OR
                  app.effective_project_role(target.project_id,m.user_id) IS NOT NULL)
                ORDER BY target.id LIMIT %s OFFSET %s""",
                (context.user_id, context.organization_id, limit, offset),
            )
            return [{"id": str(row[0]), "title": row[1]} for row in rows]

        return await self.executor.run(context, operation)

    async def owner_candidates(
        self,
        context: TenantContext,
        kind: str,
        limit: int = 50,
        offset: int = 0,
        *,
        collection_id: UUID | None = None,
    ) -> builtins.list[dict[str, str]]:
        if kind not in {"user", "team", "organization"}:
            raise CollectionConflict("collection_owner_invalid")

        async def operation(tx: TenantTransaction) -> builtins.list[dict[str, str]]:
            organization_role = await self._membership(tx, context)
            collection = None
            if collection_id is not None:
                collection = await self._role(tx, context, collection_id)
                if collection[5] != "owner":
                    raise CollectionAccessDenied()
            if kind == "user":
                rows = await tx.fetch_all(
                    """SELECT identity.id,identity.display_name FROM app.organization_memberships m
                    JOIN app.users identity ON identity.id=m.user_id
                    WHERE m.organization_id=%s AND (%s OR m.user_id=%s)
                    ORDER BY lower(identity.display_name),identity.id LIMIT %s OFFSET %s""",
                    (
                        context.organization_id,
                        organization_role == "admin" or collection_id is not None,
                        context.user_id,
                        limit,
                        offset,
                    ),
                )
            elif kind == "team":
                rows = await tx.fetch_all(
                    """SELECT team.id,team.name FROM app.teams team
                    LEFT JOIN app.team_memberships m ON m.organization_id=team.organization_id
                      AND m.team_id=team.id AND m.user_id=%s
                    WHERE team.organization_id=%s AND team.status='active'
                      AND (%s OR m.role::text IN ('owner','manager'))
                    ORDER BY lower(team.name),team.id LIMIT %s OFFSET %s""",
                    (
                        context.user_id,
                        context.organization_id,
                        organization_role == "admin",
                        limit,
                        offset,
                    ),
                )
            else:
                rows = await tx.fetch_all(
                    "SELECT id,name FROM app.organizations WHERE id=%s AND status='active' "
                    "AND %s ORDER BY id LIMIT %s OFFSET %s",
                    (context.organization_id, organization_role == "admin", limit, offset),
                )
            if collection_id is not None:
                current = await self._role(tx, context, collection_id)
                if current != collection:
                    raise CollectionConflict("collection_authority_changed")
            elif await self._membership(tx, context) != organization_role:
                raise CollectionConflict("collection_authority_changed")
            return [
                {"principal_type": kind, "principal_id": str(row[0]), "name": row[1]}
                for row in rows
            ]

        return await self.executor.run(context, operation)

    async def create(
        self,
        context: TenantContext,
        title: str,
        description: str = "",
        *,
        owner: dict[str, Any] | None = None,
        request_id: str = "local-collection-operation",
    ) -> dict[str, Any]:
        self._text(title, description)

        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            kind, owner_id = await self._destination_owner(tx, context, owner)
            identity = uuid4()
            await tx.execute(
                """INSERT INTO app.workspace_collections
                (organization_id,id,title,description,owner_user_id,owner_team_id,
                 owner_organization_id,created_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                (
                    context.organization_id,
                    identity,
                    title.strip(),
                    description,
                    owner_id if kind == "user" else None,
                    owner_id if kind == "team" else None,
                    owner_id if kind == "organization" else None,
                    context.user_id,
                ),
            )
            await self._owner_event(
                tx,
                context,
                identity,
                request_id,
                None,
                {"principal_type": kind, "principal_id": str(owner_id)},
            )
            return {"id": str(identity), "revision": 1}

        return await self.executor.run(context, operation)

    async def set_owner(
        self,
        context: TenantContext,
        collection_id: UUID,
        expected_revision: int,
        owner: dict[str, Any],
        request_id: str = "local-collection-operation",
    ) -> dict[str, Any]:
        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            row = await self._role(tx, context, collection_id, lock=True)
            if row[5] != "owner":
                raise CollectionAccessDenied()
            if row[4] != expected_revision:
                raise CollectionConflict("collection_revision_conflict")
            kind, identity = await self._destination_owner(tx, context, owner, transfer=True)
            current = self._owner(row)
            selected = {"principal_type": kind, "principal_id": str(identity)}
            if selected == current:
                return {"id": str(collection_id), "revision": row[4]}
            await tx.execute(
                """UPDATE app.workspace_collections SET owner_user_id=%s,owner_team_id=%s,
                owner_organization_id=%s,revision=revision+1,updated_at=clock_timestamp()
                WHERE organization_id=%s AND id=%s""",
                (
                    identity if kind == "user" else None,
                    identity if kind == "team" else None,
                    identity if kind == "organization" else None,
                    context.organization_id,
                    collection_id,
                ),
            )
            await self._owner_event(tx, context, collection_id, request_id, current, selected)
            return {"id": str(collection_id), "revision": row[4] + 1}

        return await self.executor.run(context, operation)

    async def _target(
        self, tx: TenantTransaction, context: TenantContext, kind: str, target_id: UUID
    ) -> tuple[Any, ...] | None:
        if kind not in {"project", "publication"}:
            raise CollectionConflict("collection_member_kind_invalid")
        table, title = (
            ("maps", "target.name") if kind == "project" else ("project_sites", "version.title")
        )
        version_join = (
            ""
            if kind == "project"
            else (
                " JOIN app.project_site_versions version ON "
                "version.organization_id=target.organization_id"
                " AND version.id=target.current_version_id"
            )
        )
        # Table/column identifiers come exclusively from the constants above.
        return await tx.fetch_one(
            f"""SELECT {title},target.project_id FROM app.{table} target {version_join}
            JOIN app.organization_memberships m ON
            m.organization_id=target.organization_id AND m.user_id=%s
            WHERE target.organization_id=%s AND target.id=%s
            AND (m.role::text='admin' OR
            app.effective_project_role(target.project_id,m.user_id) IS NOT NULL)""",
            (context.user_id, context.organization_id, target_id),
        )

    async def read(self, context: TenantContext, collection_id: UUID) -> dict[str, Any]:
        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            row = await self._role(tx, context, collection_id)
            entries = await tx.fetch_all(
                """SELECT id,map_id,site_id FROM app.workspace_collection_entries
                WHERE organization_id=%s AND collection_id=%s ORDER BY position""",
                (context.organization_id, collection_id),
            )
            members = []
            for entry_id, map_id, site_id in entries:
                kind, target_id = ("project", map_id) if map_id else ("publication", site_id)
                target = await self._target(tx, context, kind, target_id)
                if target is None and row[5] == "reader":
                    continue
                members.append(
                    {
                        "entry_id": str(entry_id),
                        "available": target is not None,
                        **(
                            {
                                "kind": kind,
                                "target_id": str(target_id),
                                "title": target[0],
                                "workspace_id": str(target[1]),
                            }
                            if target
                            else {}
                        ),
                    }
                )
            # Target resolution contains awaits. Preserve the original projection
            # or fail; a new principal/role must never inherit its cached slots.
            if await self._role(tx, context, collection_id) != row:
                raise CollectionConflict("collection_authority_changed")
            return {
                "id": str(collection_id),
                "title": row[0],
                "description": row[1],
                "owner_user_id": str(row[2]) if row[2] is not None else None,
                "owner": self._owner(row),
                "owner_name": row[9],
                "created_by": str(row[3]),
                "revision": row[4],
                "role": row[5],
                "visibility": row[6],
                "members": members,
            }

        return await self.executor.run(context, operation)

    async def replace(
        self,
        context: TenantContext,
        collection_id: UUID,
        expected_revision: int,
        title: str,
        description: str,
        members: builtins.list[dict[str, Any]],
    ) -> dict[str, Any]:
        self._text(title, description)
        if not isinstance(members, list) or len(members) > 200:
            raise CollectionConflict("collection_member_limit")

        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            row = await self._role(tx, context, collection_id, lock=True)
            if row[5] not in {"owner", "editor"}:
                raise CollectionAccessDenied()
            if row[4] != expected_revision:
                raise CollectionConflict("collection_revision_conflict")
            existing = {
                str(record[0]): record
                for record in await tx.fetch_all(
                    "SELECT id,map_id,site_id FROM app.workspace_collection_entries "
                    "WHERE organization_id=%s AND collection_id=%s",
                    (context.organization_id, collection_id),
                )
            }
            selected, targets = [], set()
            for member in members:
                if set(member) == {"entry_id"}:
                    value = existing.get(str(member["entry_id"]))
                    if value is None:
                        raise CollectionConflict("collection_entry_unavailable")
                    entry_id, map_id, site_id = value
                elif set(member) == {"kind", "target_id"}:
                    kind, target_id = member["kind"], UUID(str(member["target_id"]))
                    if await self._target(tx, context, kind, target_id) is None:
                        raise CollectionConflict("collection_member_unavailable")
                    entry_id = uuid4()
                    map_id, site_id = (target_id, None) if kind == "project" else (None, target_id)
                else:
                    raise CollectionConflict("collection_member_invalid")
                target = (map_id, site_id)
                if target in targets:
                    raise CollectionConflict("collection_member_duplicate")
                targets.add(target)
                selected.append((entry_id, map_id, site_id))
            await tx.execute(
                "DELETE FROM app.workspace_collection_entries WHERE organization_id=%s "
                "AND collection_id=%s",
                (context.organization_id, collection_id),
            )
            for position, (entry_id, map_id, site_id) in enumerate(selected):
                await tx.execute(
                    """INSERT INTO app.workspace_collection_entries
                    (organization_id,collection_id,id,position,map_id,site_id)
                    VALUES (%s,%s,%s,%s,%s,%s)""",
                    (context.organization_id, collection_id, entry_id, position, map_id, site_id),
                )
            await tx.execute(
                """UPDATE app.workspace_collections SET title=%s,description=%s,
                revision=revision+1,updated_at=clock_timestamp() WHERE
                organization_id=%s AND id=%s""",
                (title.strip(), description, context.organization_id, collection_id),
            )
            return {"id": str(collection_id), "revision": row[4] + 1}

        return await self.executor.run(context, operation)

    async def read_public(
        self,
        organization_id: UUID,
        collection_id: UUID,
        *,
        render_repository: PostgresRenderRepository | None = None,
        site_repository: SitePublicationRepository | None = None,
    ) -> dict[str, Any]:
        from opengeo_api.tenant_database import TenantContext

        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            # Resolve ordered candidates, then revalidate Project releases without reading bytes.
            rows = await tx.fetch_all(
                """SELECT c.title,c.description,p.title,p.description,p.listed_slug,p.release_id,
                       p.project_id,p.edition_id
                FROM app.workspace_collections c
                LEFT JOIN LATERAL (
                  SELECT published.title,published.description,published.listed_slug,
                         e.position,release.id AS release_id,
                         published.project_id,published.edition_id
                  FROM app.workspace_collection_entries e
                  LEFT JOIN LATERAL (
                    SELECT v.title,v.description,edition.listed_slug,
                           edition.project_id,edition.id AS edition_id
                    FROM app.project_site_editions edition
                    JOIN app.project_site_versions v
                      ON v.organization_id=edition.organization_id
                      AND v.site_id=edition.site_id AND v.id=edition.site_version_id
                    WHERE edition.organization_id=e.organization_id
                      AND edition.site_id=e.site_id AND edition.publication_reach='listed'
                      AND edition.listed_slug IS NOT NULL AND edition.revoked_at IS NULL
                    ORDER BY edition.published_at DESC,edition.id DESC LIMIT 1
                  ) published ON true
                  LEFT JOIN LATERAL (
                    SELECT candidate.id FROM app.project_artifact_releases candidate
                    JOIN app.project_artifacts artifact
                      ON artifact.organization_id=candidate.organization_id
                      AND artifact.id=candidate.artifact_id
                    WHERE artifact.organization_id=e.organization_id AND artifact.map_id=e.map_id
                    ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1
                  ) release ON true
                  WHERE e.organization_id=c.organization_id AND e.collection_id=c.id
                ) p ON true
                WHERE c.organization_id=%s AND c.id=%s AND c.visibility='public'
                ORDER BY p.position""",
                (organization_id, collection_id),
            )
            if not rows:
                raise CollectionNotFound()
            from urllib.parse import quote

            members = []
            preview_count = 0
            for row in rows:
                if row[4] is not None:
                    member = {
                        "kind": "publication",
                        "title": row[2],
                        "description": row[3],
                        "href": f"/public/organizations/{organization_id}/publications/"
                        + quote(row[4], safe=""),
                    }
                    if site_repository is not None and preview_count < 4:
                        from opengeo_api.publication_previews import publication_preview
                        from opengeo_api.site_publications import SiteConflict, SiteNotFound

                        try:
                            publication = await site_repository.get_public_site(
                                TenantContext(user_id=UUID(int=0), organization_id=organization_id),
                                row[6],
                                edition_id=row[7],
                            )
                        except (SiteConflict, SiteNotFound):
                            continue
                        preview = publication_preview(publication, organization_id)
                        if preview:
                            member.update(
                                preview_href=preview["preview_path"],
                                license=preview["license"],
                                attribution=preview["attribution"],
                            )
                            preview_count += 1
                    members.append(member)
                elif row[5] is not None and render_repository is not None:
                    from opengeo_api.artifact_releases import read_release
                    from opengeo_api.rendering import RenderConflict, RenderNotFound

                    try:
                        release, target = await read_release(
                            render_repository, organization_id, row[5], transaction=tx
                        )
                    except (RenderConflict, RenderNotFound):
                        continue
                    members.append(
                        {
                            "kind": "project",
                            "title": release["title"],
                            "description": release["attribution"],
                            "license": release["license"],
                            "href": f"/public/organizations/{organization_id}"
                            f"/artifact-releases/{row[5]}/view",
                            **(
                                {
                                    "preview_href": f"/public/organizations/{organization_id}"
                                    f"/artifact-releases/{row[5]}/preview"
                                }
                                if target[10] in {"image/png", "image/jpeg"}
                                and target[11] <= 1024 * 1024
                                and preview_count < 4
                                else {}
                            ),
                        }
                    )
                    if target[10] in {"image/png", "image/jpeg"} and target[11] <= 1024 * 1024:
                        preview_count += 1
            return {
                "id": str(collection_id),
                "title": rows[0][0],
                "description": rows[0][1],
                "visibility": "public",
                "members": members,
            }

        return await self.executor.run(
            TenantContext(user_id=UUID(int=0), organization_id=organization_id), operation
        )

    async def image_previews(
        self,
        context: TenantContext,
        collection_id: UUID,
        render_repository: PostgresRenderRepository,
        site_repository: SitePublicationRepository | None = None,
    ) -> builtins.list[dict[str, Any]]:
        from opengeo_api.artifact_releases import read_release
        from opengeo_api.rendering import RenderConflict, RenderNotFound

        async def operation(tx: TenantTransaction) -> builtins.list[dict[str, Any]]:
            await self._role(tx, context, collection_id)
            rows = await tx.fetch_all(
                """SELECT entry.id,release.id,site.project_id,edition.id
                FROM app.workspace_collection_entries entry
                LEFT JOIN app.maps map ON map.organization_id=entry.organization_id
                  AND map.id=entry.map_id
                LEFT JOIN app.project_sites site ON site.organization_id=entry.organization_id
                  AND site.id=entry.site_id
                JOIN app.organization_memberships member
                  ON member.organization_id=entry.organization_id
                  AND member.user_id=%s
                LEFT JOIN LATERAL (
                  SELECT candidate.id FROM app.project_artifact_releases candidate
                  JOIN app.project_artifacts artifact
                    ON artifact.organization_id=candidate.organization_id
                    AND artifact.id=candidate.artifact_id AND artifact.map_id=entry.map_id
                  WHERE candidate.organization_id=entry.organization_id
                  ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1
                ) release ON true
                LEFT JOIN LATERAL (
                  SELECT candidate.id FROM app.project_site_editions candidate
                  WHERE candidate.organization_id=entry.organization_id
                    AND candidate.site_id=entry.site_id
                    AND candidate.publication_reach='listed' AND candidate.revoked_at IS NULL
                  ORDER BY candidate.published_at DESC,candidate.id DESC LIMIT 1
                ) edition ON true
                WHERE entry.organization_id=%s AND entry.collection_id=%s
                  AND (member.role::text='admin' OR
                    app.effective_project_role(
                      coalesce(map.project_id,site.project_id),member.user_id) IS NOT NULL)
                  AND (release.id IS NOT NULL OR edition.id IS NOT NULL)
                ORDER BY entry.position LIMIT 4""",
                (context.user_id, context.organization_id, collection_id),
            )
            results = []
            for entry_id, release_id, project_id, edition_id in rows:
                if edition_id is not None and site_repository is not None:
                    from opengeo_api.publication_previews import publication_preview
                    from opengeo_api.site_publications import SiteConflict, SiteNotFound
                    from opengeo_api.tenant_database import TenantContext

                    try:
                        publication = await site_repository.get_public_site(
                            TenantContext(
                                user_id=UUID(int=0), organization_id=context.organization_id
                            ),
                            project_id,
                            edition_id=edition_id,
                        )
                    except (SiteConflict, SiteNotFound):
                        continue
                    preview = publication_preview(publication, context.organization_id)
                    if preview:
                        results.append({"entry_id": str(entry_id), **preview})
                    continue
                if release_id is None:
                    continue
                try:
                    record, target = await read_release(
                        render_repository, context.organization_id, release_id, transaction=tx
                    )
                except (RenderNotFound, RenderConflict):
                    continue
                if target[10] in {"image/png", "image/jpeg"} and target[11] <= 1024 * 1024:
                    results.append(
                        {
                            "entry_id": str(entry_id),
                            "title": record["title"],
                            "license": record["license"],
                            "attribution": record["attribution"],
                            "preview_path": (
                                f"/public/organizations/{context.organization_id}"
                                f"/artifact-releases/{release_id}/preview"
                            ),
                        }
                    )
            return results

        return await self.executor.run(context, operation)

    async def set_visibility(
        self,
        context: TenantContext,
        collection_id: UUID,
        expected_revision: int,
        visibility: str | None,
    ) -> dict[str, Any]:
        if visibility not in {"private", "account", "public"}:
            raise CollectionConflict("collection_visibility_invalid")

        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            row = await self._role(tx, context, collection_id, lock=True)
            if row[5] != "owner":
                raise CollectionAccessDenied()
            if row[4] != expected_revision:
                raise CollectionConflict("collection_revision_conflict")
            await tx.execute(
                "UPDATE app.workspace_collections SET visibility=%s,revision=revision+1,"
                "updated_at=clock_timestamp() WHERE organization_id=%s AND id=%s",
                (visibility, context.organization_id, collection_id),
            )
            return {"id": str(collection_id), "revision": row[4] + 1}

        return await self.executor.run(context, operation)

    async def grants(
        self, context: TenantContext, collection_id: UUID, limit: int = 50, offset: int = 0
    ) -> dict[str, Any]:
        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            row = await self._role(tx, context, collection_id)
            if row[5] != "owner":
                raise CollectionAccessDenied()
            grants = await tx.fetch_all(
                """SELECT g.user_id,u.display_name,u.email,g.role
                FROM app.workspace_collection_grants g
                JOIN app.users u ON u.id=g.user_id
                WHERE g.organization_id=%s AND g.collection_id=%s
                ORDER BY g.user_id LIMIT %s OFFSET %s""",
                (context.organization_id, collection_id, limit, offset),
            )
            if await self._role(tx, context, collection_id) != row:
                raise CollectionConflict("collection_authority_changed")
            return {
                "revision": row[4],
                "grants": [
                    {
                        "user_id": str(item[0]),
                        "display_name": item[1],
                        "email": item[2],
                        "role": item[3],
                    }
                    for item in grants
                ],
            }

        return await self.executor.run(context, operation)

    async def grant(
        self,
        context: TenantContext,
        collection_id: UUID,
        expected_revision: int,
        user_id: UUID,
        role: str | None,
    ) -> dict[str, Any]:
        if role not in {None, "reader", "editor"}:
            raise CollectionConflict("collection_role_invalid")

        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            row = await self._role(tx, context, collection_id, lock=True)
            if row[5] != "owner":
                raise CollectionAccessDenied()
            if row[4] != expected_revision:
                raise CollectionConflict("collection_revision_conflict")
            if user_id == row[2]:
                raise CollectionConflict("collection_owner_grant_invalid")
            if not await tx.fetch_one(
                "SELECT 1 FROM app.organization_memberships WHERE organization_id=%s "
                "AND user_id=%s",
                (context.organization_id, user_id),
            ):
                raise CollectionConflict("collection_grantee_unavailable")
            await tx.execute(
                "DELETE FROM app.workspace_collection_grants WHERE organization_id=%s "
                "AND collection_id=%s AND user_id=%s",
                (context.organization_id, collection_id, user_id),
            )
            if role is not None:
                await tx.execute(
                    "INSERT INTO app.workspace_collection_grants "
                    "(organization_id,collection_id,user_id,role) VALUES (%s,%s,%s,%s)",
                    (context.organization_id, collection_id, user_id, role),
                )
            await tx.execute(
                "UPDATE app.workspace_collections SET "
                "revision=revision+1,updated_at=clock_timestamp() WHERE "
                "organization_id=%s AND id=%s",
                (context.organization_id, collection_id),
            )
            return {"id": str(collection_id), "revision": row[4] + 1}

        return await self.executor.run(context, operation)

    @staticmethod
    def _text(title: str, description: str) -> None:
        if (
            not isinstance(title, str)
            or not 1 <= len(title.strip()) <= 200
            or not isinstance(description, str)
            or len(description) > 10000
        ):
            raise CollectionConflict("collection_text_invalid")
