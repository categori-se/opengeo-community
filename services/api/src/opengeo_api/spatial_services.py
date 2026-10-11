import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Any, Protocol, TypeVar, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.auth_models import OrganizationRole
from opengeo_api.authorization import (
    Action,
    AuthorizationDenied,
    ProjectRole,
    Roles,
    authorize,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)


class SpatialServiceStoreUnavailable(RuntimeError):
    pass


class SpatialServiceAccessDenied(RuntimeError):
    pass


class SpatialServiceNotFound(RuntimeError):
    def __init__(self, resource: str) -> None:
        self.resource = resource
        super().__init__(resource)


class SpatialServiceConflict(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class SpatialService:
    service_id: UUID
    project_id: UUID
    slug: str
    title: str
    description: str | None
    created_by: UUID
    created_at: datetime
    disabled_by: UUID | None
    disabled_at: datetime | None
    enabled_protocols: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class SpatialServiceCollection:
    binding_id: UUID
    project_id: UUID
    service_id: UUID
    collection_name: str
    dataset_id: UUID
    resource_id: UUID
    default_profile_id: UUID
    sealed_feature_generation: int
    sealed_profile_version_id: UUID
    sealed_profile_version_number: int
    current_feature_generation: int
    current_profile_version_id: UUID
    current_profile_version_number: int
    title: str
    description: str | None
    created_by: UUID
    created_at: datetime
    withdrawn_by: UUID | None
    withdrawn_at: datetime | None
    target_active: bool

    @property
    def stale(self) -> bool:
        return (
            not self.target_active
            or self.current_feature_generation != self.sealed_feature_generation
            or self.current_profile_version_id != self.sealed_profile_version_id
            or self.current_profile_version_number != self.sealed_profile_version_number
        )


@dataclass(frozen=True, slots=True)
class SpatialTileCachePolicy:
    cache_id: UUID
    project_id: UUID
    service_id: UUID
    binding_id: UUID
    version_id: UUID
    version_number: int
    minimum_tile_matrix: int
    maximum_tile_matrix: int
    maximum_entries: int
    current_entries: int
    change_message: str | None
    created_by: UUID
    created_at: datetime
    updated_by: UUID
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class SpatialTileCacheEntry:
    entry_id: UUID
    cache_id: UUID
    cache_version_id: UUID
    cache_version_number: int
    tile_matrix: int
    tile_row: int
    tile_col: int
    render_job_id: UUID
    seeded_by: UUID
    seeded_at: datetime


TILE_SEED_PLAN_BATCH_LIMIT = 64
TILE_SEED_PLAN_PREVIEW_TTL = timedelta(minutes=15)


@dataclass(frozen=True, slots=True, order=True)
class SpatialTileCoordinate:
    tile_matrix: int
    tile_row: int
    tile_col: int


@dataclass(frozen=True, slots=True)
class SpatialTileSeedPlanPreview:
    cache_id: UUID
    cache_version_id: UUID
    cache_version_number: int
    mode: str
    request_bbox: tuple[float, float, float, float] | None
    minimum_tile_matrix: int
    maximum_tile_matrix: int
    requested_count: int
    existing_count: int
    targets: tuple[SpatialTileCoordinate, ...]
    expires_at: datetime
    preview_checksum_sha256: str


@dataclass(frozen=True, slots=True)
class SpatialTileSeedPlanItem:
    position: int
    coordinate: SpatialTileCoordinate
    render_job_id: UUID | None
    state: str
    error_code: str | None
    started_at: datetime | None
    finished_at: datetime | None


@dataclass(frozen=True, slots=True)
class SpatialTileSeedPlan:
    plan_id: UUID
    project_id: UUID
    service_id: UUID
    binding_id: UUID
    cache_id: UUID
    cache_version_id: UUID
    cache_version_number: int
    mode: str
    request_bbox: tuple[float, float, float, float] | None
    minimum_tile_matrix: int
    maximum_tile_matrix: int
    requested_count: int
    existing_count: int
    target_count: int
    preview_checksum_sha256: str
    preview_expires_at: datetime
    state: str
    error_code: str | None
    created_by: UUID
    created_at: datetime
    dispatch_started_at: datetime | None
    started_at: datetime | None
    finished_at: datetime | None
    items: tuple[SpatialTileSeedPlanItem, ...]


TILE_CACHE_RECLAMATION_BATCH_LIMIT = 64
TILE_CACHE_RECLAMATION_PREVIEW_TTL = timedelta(minutes=15)


@dataclass(frozen=True, slots=True)
class RetiredSpatialTileCacheVersion:
    cache_id: UUID
    cache_version_id: UUID
    cache_version_number: int
    minimum_tile_matrix: int
    maximum_tile_matrix: int
    maximum_entries: int
    change_message: str | None
    created_at: datetime
    retired_at: datetime
    entry_count: int
    render_output_count: int
    reclamation_id: UUID | None
    reclamation_state: str | None
    reclamation_target_count: int | None
    reclamation_completed_count: int
    reclamation_failed_count: int


@dataclass(frozen=True, slots=True)
class SpatialTileCacheReclamationPreview:
    cache_id: UUID
    cache_version_id: UUID
    cache_version_number: int
    target_count: int
    remaining_eligible_target_count: int
    target_size_bytes: int
    oldest_render_finished_at: datetime
    newest_render_finished_at: datetime
    expires_at: datetime
    preview_checksum_sha256: str
    physical_action: str = "delete_exact_storage_versions"
    render_history_retained: bool = True
    cache_history_retained: bool = True
    ordinary_reads_create_work: bool = False


@dataclass(frozen=True, slots=True)
class SpatialTileCacheReclamation:
    reclamation_id: UUID
    cache_id: UUID
    cache_version_id: UUID
    cache_version_number: int
    target_count: int
    target_size_bytes: int
    state: str
    error_code: str | None
    attempt_count: int
    completed_target_count: int
    failed_target_count: int
    preview_checksum_sha256: str
    preview_expires_at: datetime
    created_by: UUID
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


@dataclass(frozen=True, slots=True)
class SpatialTileCacheReclamationSubmission:
    reclamation: SpatialTileCacheReclamation
    dispatch_required: bool


@dataclass(frozen=True, slots=True)
class _SpatialTileCacheReclamationTarget:
    render_job_id: UUID
    output_object_id: UUID
    size_bytes: int
    checksum_sha256: str
    finished_at: datetime


class SpatialServiceRepository(Protocol):
    async def create_service(
        self,
        context: TenantContext,
        project_id: UUID,
        slug: str,
        title: str,
        description: str | None,
        request_id: str,
    ) -> SpatialService: ...

    async def list_services(
        self, context: TenantContext, project_id: UUID
    ) -> tuple[SpatialService, ...]: ...

    async def get_active_service(
        self, context: TenantContext, project_id: UUID, slug: str
    ) -> SpatialService: ...

    async def disable_service(
        self, context: TenantContext, project_id: UUID, service_id: UUID, request_id: str
    ) -> SpatialService: ...

    async def create_collection(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        collection_name: str,
        dataset_id: UUID,
        resource_id: UUID,
        default_profile_id: UUID,
        expected_feature_generation: int,
        expected_profile_version: int,
        title: str,
        description: str | None,
        request_id: str,
    ) -> SpatialServiceCollection: ...

    async def list_collections(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        *,
        include_withdrawn: bool,
    ) -> tuple[SpatialServiceCollection, ...]: ...

    async def resolve_collection(
        self,
        context: TenantContext,
        project_id: UUID,
        service_slug: str,
        collection_name: str,
    ) -> SpatialServiceCollection: ...

    async def withdraw_collection(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        request_id: str,
    ) -> SpatialServiceCollection: ...

    async def configure_tile_cache(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        expected_version: int,
        minimum_tile_matrix: int,
        maximum_tile_matrix: int,
        maximum_entries: int,
        change_message: str | None,
        request_id: str,
    ) -> SpatialTileCachePolicy: ...

    async def get_tile_cache(
        self, context: TenantContext, project_id: UUID, binding_id: UUID
    ) -> SpatialTileCachePolicy: ...

    async def list_tile_caches(
        self, context: TenantContext, project_id: UUID, service_id: UUID
    ) -> tuple[SpatialTileCachePolicy, ...]: ...

    async def invalidate_tile_cache(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        expected_version: int,
        change_message: str | None,
        request_id: str,
    ) -> SpatialTileCachePolicy: ...

    async def record_tile_cache_entry(
        self,
        context: TenantContext,
        project_id: UUID,
        binding_id: UUID,
        expected_cache_version: int,
        tile_matrix: int,
        tile_row: int,
        tile_col: int,
        render_job_id: UUID,
        request_id: str,
    ) -> SpatialTileCacheEntry: ...

    async def resolve_tile_cache_entry(
        self,
        context: TenantContext,
        project_id: UUID,
        binding_id: UUID,
        tile_matrix: int,
        tile_row: int,
        tile_col: int,
    ) -> SpatialTileCacheEntry: ...

    async def preview_tile_seed_plan(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        expected_cache_version: int,
        mode: str,
        request_bbox: tuple[float, float, float, float] | None,
        minimum_tile_matrix: int,
        maximum_tile_matrix: int,
        coordinates: tuple[SpatialTileCoordinate, ...],
    ) -> SpatialTileSeedPlanPreview: ...

    async def confirm_tile_seed_plan(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        expected_cache_version: int,
        mode: str,
        request_bbox: tuple[float, float, float, float] | None,
        minimum_tile_matrix: int,
        maximum_tile_matrix: int,
        coordinates: tuple[SpatialTileCoordinate, ...],
        preview_checksum_sha256: str,
        preview_expires_at: datetime,
        request_id: str,
    ) -> SpatialTileSeedPlan: ...

    async def attach_tile_seed_plan_render(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        plan_id: UUID,
        position: int,
        render_job_id: UUID,
    ) -> SpatialTileSeedPlan: ...

    async def begin_tile_seed_plan_dispatch(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        plan_id: UUID,
        request_id: str,
    ) -> SpatialTileSeedPlan: ...

    async def list_tile_seed_plans(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
    ) -> tuple[SpatialTileSeedPlan, ...]: ...

    async def cancel_tile_seed_plan(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        plan_id: UUID,
        request_id: str,
    ) -> SpatialTileSeedPlan: ...

    async def list_retired_tile_cache_versions(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
    ) -> tuple[RetiredSpatialTileCacheVersion, ...]: ...

    async def preview_tile_cache_reclamation(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        cache_version_id: UUID,
    ) -> SpatialTileCacheReclamationPreview: ...

    async def confirm_tile_cache_reclamation(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        cache_version_id: UUID,
        preview_checksum_sha256: str,
        preview_expires_at: datetime,
        request_id: str,
    ) -> SpatialTileCacheReclamationSubmission: ...


ResultT = TypeVar("ResultT")


class PostgresSpatialServiceRepository:
    def __init__(
        self,
        executor: TenantTransactionExecutor,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._executor = executor
        self._now = now or (lambda: datetime.now(UTC))

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT:
        try:
            return await self._executor.run(context, operation)
        except TenantDatabaseConflict as error:
            raise SpatialServiceConflict("spatial_service_store_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise SpatialServiceStoreUnavailable("spatial service store failed") from error

    async def create_service(
        self,
        context: TenantContext,
        project_id: UUID,
        slug: str,
        title: str,
        description: str | None,
        request_id: str,
    ) -> SpatialService:
        async def operation(transaction: TenantTransaction) -> SpatialService:
            roles = await self._project_roles(transaction, context, project_id, lock=True)
            self._require(Action.SPATIAL_SERVICE_MANAGE, roles)
            count = await transaction.fetch_one(
                """
                SELECT count(*)::bigint FROM app.spatial_services
                WHERE organization_id = %s AND project_id = %s AND disabled_at IS NULL
                """,
                (context.organization_id, project_id),
            )
            if count is not None and cast(int, count[0]) >= 16:
                raise SpatialServiceConflict("spatial_service_limit_reached")
            service_id = uuid4()
            metadata_version_id = uuid4()
            row = await transaction.fetch_one(
                """
                INSERT INTO app.spatial_services
                  (id, organization_id, project_id, slug, title, description,
                   current_metadata_version_id, current_metadata_version_number,
                   created_by, updated_by, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, 1, %s, %s, clock_timestamp())
                RETURNING id, project_id, slug, title, description, created_by,
                          created_at, disabled_by, disabled_at
                """,
                (
                    service_id,
                    context.organization_id,
                    project_id,
                    slug,
                    title,
                    description,
                    metadata_version_id,
                    context.user_id,
                    context.user_id,
                ),
            )
            assert row is not None
            await transaction.execute(
                """
                INSERT INTO app.spatial_service_metadata_versions
                  (id, organization_id, project_id, service_id, version_number,
                   title, abstract, created_by)
                VALUES (%s, %s, %s, %s, 1, %s, %s, %s)
                """,
                (
                    metadata_version_id,
                    context.organization_id,
                    project_id,
                    service_id,
                    title,
                    description,
                    context.user_id,
                ),
            )
            await transaction.execute(
                """
                INSERT INTO app.spatial_service_stores
                  (organization_id, project_id, service_id, slug, title,
                   description, kind, created_by)
                VALUES (%s, %s, %s, 'managed', 'Managed project datasets',
                        'Governed datasets already linked to this project.',
                        'managed_project', %s)
                """,
                (context.organization_id, project_id, service_id, context.user_id),
            )
            await self._event(
                transaction,
                context,
                project_id,
                service_id,
                "spatial_service.created",
                request_id,
                {"slug": slug},
            )
            return self._service(row)

        return await self._run(context, operation)

    async def list_retired_tile_cache_versions(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
    ) -> tuple[RetiredSpatialTileCacheVersion, ...]:
        async def operation(
            transaction: TenantTransaction,
        ) -> tuple[RetiredSpatialTileCacheVersion, ...]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            await self._binding_by_id(transaction, context, project_id, service_id, binding_id)
            rows = await transaction.fetch_all(
                """
                SELECT cache.id, version.id, version.version_number,
                       version.minimum_tile_matrix, version.maximum_tile_matrix,
                       version.maximum_entries, version.change_message,
                       version.created_at, retirement.retired_at,
                       (SELECT count(*)::bigint
                        FROM app.spatial_tile_cache_entries entry
                        WHERE entry.organization_id = version.organization_id
                          AND entry.cache_id = version.cache_id
                          AND entry.cache_version_id = version.id),
                       (SELECT count(DISTINCT entry.render_job_id)::bigint
                        FROM app.spatial_tile_cache_entries entry
                        JOIN app.map_render_jobs job
                          ON job.organization_id = entry.organization_id
                         AND job.id = entry.render_job_id
                        WHERE entry.organization_id = version.organization_id
                          AND entry.cache_id = version.cache_id
                          AND entry.cache_version_id = version.id
                          AND job.state = 'completed'
                          AND job.output_object_id IS NOT NULL),
                       reclamation.id, reclamation.state::text,
                       reclamation.target_count,
                       COALESCE(item_counts.completed_count, 0),
                       COALESCE(item_counts.failed_count, 0)
                FROM app.spatial_tile_caches cache
                JOIN app.spatial_tile_cache_versions version
                  ON version.organization_id = cache.organization_id
                 AND version.cache_id = cache.id
                 AND version.version_number < cache.current_version_number
                JOIN LATERAL (
                  SELECT min(successor.created_at) AS retired_at
                  FROM app.spatial_tile_cache_versions successor
                  WHERE successor.organization_id = version.organization_id
                    AND successor.cache_id = version.cache_id
                    AND successor.version_number > version.version_number
                ) retirement ON retirement.retired_at IS NOT NULL
                LEFT JOIN LATERAL (
                  SELECT plan.id, plan.state, plan.target_count
                  FROM app.spatial_tile_cache_reclamations plan
                  WHERE plan.organization_id = cache.organization_id
                    AND plan.cache_id = cache.id
                    AND plan.cache_version_id = version.id
                  ORDER BY plan.created_at DESC, plan.id DESC
                  LIMIT 1
                ) reclamation ON true
                LEFT JOIN LATERAL (
                  SELECT count(*) FILTER (WHERE item.state = 'completed')::bigint
                           AS completed_count,
                         count(*) FILTER (WHERE item.state = 'failed')::bigint
                           AS failed_count
                  FROM app.spatial_tile_cache_reclamation_items item
                  WHERE item.organization_id = cache.organization_id
                    AND item.reclamation_id = reclamation.id
                ) item_counts ON true
                WHERE cache.organization_id = %s AND cache.project_id = %s
                  AND cache.service_id = %s AND cache.binding_id = %s
                ORDER BY version.version_number DESC
                LIMIT 100
                """,
                (context.organization_id, project_id, service_id, binding_id),
            )
            return tuple(self._retired_tile_cache_version(row) for row in rows)

        return await self._run(context, operation)

    async def preview_tile_cache_reclamation(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        cache_version_id: UUID,
    ) -> SpatialTileCacheReclamationPreview:
        async def operation(
            transaction: TenantTransaction,
        ) -> SpatialTileCacheReclamationPreview:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_MANAGE, roles)
            cache = await self._retired_cache_identity(
                transaction,
                context,
                project_id,
                service_id,
                binding_id,
                cache_version_id,
            )
            targets = await self._tile_cache_reclamation_targets(
                transaction,
                context,
                project_id,
                service_id,
                binding_id,
                cache_version_id,
            )
            if not targets:
                raise SpatialServiceConflict("spatial_tile_cache_outputs_not_reclaimable")
            selected = targets[:TILE_CACHE_RECLAMATION_BATCH_LIMIT]
            expires_at = self._now().astimezone(UTC) + TILE_CACHE_RECLAMATION_PREVIEW_TTL
            checksum = self._tile_cache_reclamation_preview_checksum(
                context.organization_id,
                project_id,
                service_id,
                binding_id,
                cache[0],
                cache_version_id,
                cache[1],
                selected,
                expires_at,
            )
            return SpatialTileCacheReclamationPreview(
                cache_id=cache[0],
                cache_version_id=cache_version_id,
                cache_version_number=cache[1],
                target_count=len(selected),
                remaining_eligible_target_count=len(targets) - len(selected),
                target_size_bytes=sum(target.size_bytes for target in selected),
                oldest_render_finished_at=selected[0].finished_at,
                newest_render_finished_at=selected[-1].finished_at,
                expires_at=expires_at,
                preview_checksum_sha256=checksum,
            )

        return await self._run(context, operation)

    async def confirm_tile_cache_reclamation(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        cache_version_id: UUID,
        preview_checksum_sha256: str,
        preview_expires_at: datetime,
        request_id: str,
    ) -> SpatialTileCacheReclamationSubmission:
        async def operation(
            transaction: TenantTransaction,
        ) -> SpatialTileCacheReclamationSubmission:
            roles = await self._project_roles(transaction, context, project_id, lock=True)
            self._require(Action.SPATIAL_SERVICE_MANAGE, roles)
            expires_at = preview_expires_at.astimezone(UTC)
            existing = await transaction.fetch_one(
                f"""
                {self._tile_cache_reclamation_select()}
                WHERE reclamation.organization_id = %s
                  AND reclamation.project_id = %s
                  AND reclamation.service_id = %s
                  AND reclamation.binding_id = %s
                  AND reclamation.cache_version_id = %s
                  AND reclamation.preview_checksum_sha256 = %s
                  AND reclamation.preview_expires_at = %s
                """,
                (
                    context.organization_id,
                    project_id,
                    service_id,
                    binding_id,
                    cache_version_id,
                    preview_checksum_sha256,
                    expires_at,
                ),
            )
            if existing is not None:
                reclamation = self._tile_cache_reclamation(existing)
                return SpatialTileCacheReclamationSubmission(
                    reclamation, reclamation.state == "queued"
                )
            cache = await self._retired_cache_identity(
                transaction,
                context,
                project_id,
                service_id,
                binding_id,
                cache_version_id,
            )
            targets = await self._tile_cache_reclamation_targets(
                transaction,
                context,
                project_id,
                service_id,
                binding_id,
                cache_version_id,
            )
            selected = targets[:TILE_CACHE_RECLAMATION_BATCH_LIMIT]
            now = self._now().astimezone(UTC)
            if (
                not selected
                or expires_at <= now
                or expires_at > now + TILE_CACHE_RECLAMATION_PREVIEW_TTL
                or self._tile_cache_reclamation_preview_checksum(
                    context.organization_id,
                    project_id,
                    service_id,
                    binding_id,
                    cache[0],
                    cache_version_id,
                    cache[1],
                    selected,
                    expires_at,
                )
                != preview_checksum_sha256
            ):
                raise SpatialServiceConflict("spatial_tile_cache_reclamation_changed")
            queued = await transaction.fetch_one(
                """
                SELECT app.queue_spatial_tile_cache_reclamation(
                  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                """,
                (
                    context.organization_id,
                    project_id,
                    service_id,
                    binding_id,
                    cache_version_id,
                    [target.render_job_id for target in selected],
                    preview_checksum_sha256,
                    expires_at,
                    context.user_id,
                    request_id,
                ),
            )
            if queued is None:
                raise SpatialServiceConflict("spatial_tile_cache_reclamation_conflict")
            row = await transaction.fetch_one(
                f"""
                {self._tile_cache_reclamation_select()}
                WHERE reclamation.organization_id = %s AND reclamation.id = %s
                """,
                (context.organization_id, cast(UUID, queued[0])),
            )
            assert row is not None
            return SpatialTileCacheReclamationSubmission(self._tile_cache_reclamation(row), True)

        return await self._run(context, operation)

    @staticmethod
    async def _retired_cache_identity(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        cache_version_id: UUID,
    ) -> tuple[UUID, int]:
        row = await transaction.fetch_one(
            """
            SELECT cache.id, version.version_number
            FROM app.spatial_tile_caches cache
            JOIN app.spatial_tile_cache_versions version
              ON version.organization_id = cache.organization_id
             AND version.cache_id = cache.id
             AND version.id = %s
            WHERE cache.organization_id = %s AND cache.project_id = %s
              AND cache.service_id = %s AND cache.binding_id = %s
              AND version.version_number < cache.current_version_number
              AND version.id <> cache.current_version_id
            """,
            (
                cache_version_id,
                context.organization_id,
                project_id,
                service_id,
                binding_id,
            ),
        )
        if row is None:
            raise SpatialServiceNotFound("spatial_tile_cache_retired_version")
        return cast(UUID, row[0]), cast(int, row[1])

    @staticmethod
    async def _tile_cache_reclamation_targets(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        cache_version_id: UUID,
    ) -> tuple[_SpatialTileCacheReclamationTarget, ...]:
        rows = await transaction.fetch_all(
            """
            SELECT render_job_id, output_object_id, size_bytes,
                   checksum_sha256, finished_at
            FROM app.render_cache_reclamation_candidate_facts(%s, %s, %s, %s, %s)
            LIMIT 10000
            """,
            (
                context.organization_id,
                project_id,
                service_id,
                binding_id,
                cache_version_id,
            ),
        )
        return tuple(
            _SpatialTileCacheReclamationTarget(
                render_job_id=cast(UUID, row[0]),
                output_object_id=cast(UUID, row[1]),
                size_bytes=cast(int, row[2]),
                checksum_sha256=cast(str, row[3]),
                finished_at=cast(datetime, row[4]),
            )
            for row in rows
        )

    @staticmethod
    def _tile_cache_reclamation_preview_checksum(
        organization_id: UUID,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        cache_id: UUID,
        cache_version_id: UUID,
        cache_version_number: int,
        targets: tuple[_SpatialTileCacheReclamationTarget, ...],
        expires_at: datetime,
    ) -> str:
        payload = {
            "schema": "opengeo.render-cache-reclamation.preview.v1",
            "organization_id": str(organization_id),
            "project_id": str(project_id),
            "service_id": str(service_id),
            "binding_id": str(binding_id),
            "cache_id": str(cache_id),
            "cache_version_id": str(cache_version_id),
            "cache_version_number": cache_version_number,
            "expires_at": expires_at.astimezone(UTC).isoformat(),
            "targets": [
                {
                    "render_job_id": str(target.render_job_id),
                    "output_object_id": str(target.output_object_id),
                    "size_bytes": target.size_bytes,
                    "checksum_sha256": target.checksum_sha256,
                    "finished_at": target.finished_at.astimezone(UTC).isoformat(),
                }
                for target in targets
            ],
        }
        return sha256(
            json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
        ).hexdigest()

    async def _binding_by_id(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        *,
        lock: bool = False,
    ) -> SpatialServiceCollection:
        row = await transaction.fetch_one(
            f"""
            {self._collection_select()}
            WHERE binding.organization_id = %s AND binding.project_id = %s
              AND binding.service_id = %s AND binding.id = %s
            {"FOR UPDATE OF binding" if lock else ""}
            """,
            (context.organization_id, project_id, service_id, binding_id),
        )
        if row is None:
            raise SpatialServiceNotFound("spatial_service_collection")
        return self._collection(row)

    @staticmethod
    async def _cache_head(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        binding_id: UUID,
        *,
        lock: bool,
    ) -> tuple[UUID, UUID, int] | None:
        row = await transaction.fetch_one(
            f"""
            SELECT id, current_version_id, current_version_number
            FROM app.spatial_tile_caches
            WHERE organization_id = %s AND project_id = %s AND binding_id = %s
            {"FOR UPDATE" if lock else ""}
            """,
            (context.organization_id, project_id, binding_id),
        )
        if row is None:
            return None
        return cast(UUID, row[0]), cast(UUID, row[1]), cast(int, row[2])

    async def _load_tile_cache(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        binding_id: UUID,
        *,
        lock: bool = False,
    ) -> SpatialTileCachePolicy:
        row = await transaction.fetch_one(
            f"""
            {self._tile_cache_select()}
            WHERE cache.organization_id = %s AND cache.project_id = %s
              AND cache.binding_id = %s
            {"FOR UPDATE OF cache" if lock else ""}
            """,
            (context.organization_id, project_id, binding_id),
        )
        if row is None:
            raise SpatialServiceNotFound("spatial_tile_cache")
        return self._tile_cache(row)

    async def _find_tile_cache_entry(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        binding_id: UUID,
        tile_matrix: int,
        tile_row: int,
        tile_col: int,
    ) -> SpatialTileCacheEntry | None:
        row = await transaction.fetch_one(
            """
            SELECT entry.id, entry.cache_id, entry.cache_version_id,
                   entry.cache_version_number, entry.tile_matrix, entry.tile_row,
                   entry.tile_col, entry.render_job_id, entry.seeded_by, entry.seeded_at
            FROM app.spatial_tile_caches cache
            JOIN app.spatial_tile_cache_entries entry
              ON entry.organization_id = cache.organization_id
             AND entry.cache_id = cache.id
             AND entry.cache_version_id = cache.current_version_id
             AND entry.cache_version_number = cache.current_version_number
            WHERE cache.organization_id = %s AND cache.project_id = %s
              AND cache.binding_id = %s AND entry.tile_matrix = %s
              AND entry.tile_row = %s AND entry.tile_col = %s
            """,
            (
                context.organization_id,
                project_id,
                binding_id,
                tile_matrix,
                tile_row,
                tile_col,
            ),
        )
        return None if row is None else self._tile_cache_entry(row)

    async def configure_tile_cache(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        expected_version: int,
        minimum_tile_matrix: int,
        maximum_tile_matrix: int,
        maximum_entries: int,
        change_message: str | None,
        request_id: str,
    ) -> SpatialTileCachePolicy:
        async def operation(transaction: TenantTransaction) -> SpatialTileCachePolicy:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_MANAGE, roles)
            binding = await self._binding_by_id(
                transaction, context, project_id, service_id, binding_id, lock=True
            )
            if binding.withdrawn_at is not None or binding.stale:
                raise SpatialServiceConflict("spatial_tile_cache_binding_not_fresh")
            current = await self._cache_head(
                transaction, context, project_id, binding_id, lock=True
            )
            if current is None:
                if expected_version != 0:
                    raise SpatialServiceConflict("spatial_tile_cache_version_conflict")
                cache_id = uuid4()
                version_id = uuid4()
                await transaction.execute(
                    """
                    INSERT INTO app.spatial_tile_caches
                      (id, organization_id, project_id, service_id, binding_id,
                       current_version_id, current_version_number, created_by, updated_by)
                    VALUES (%s, %s, %s, %s, %s, %s, 1, %s, %s)
                    """,
                    (
                        cache_id,
                        context.organization_id,
                        project_id,
                        service_id,
                        binding_id,
                        version_id,
                        context.user_id,
                        context.user_id,
                    ),
                )
                version_number = 1
                event_type = "spatial_service.tile_cache.created"
            else:
                cache_id, _, current_number = current
                if expected_version != current_number:
                    raise SpatialServiceConflict("spatial_tile_cache_version_conflict")
                version_number = current_number + 1
                version_id = uuid4()
                event_type = "spatial_service.tile_cache.revised"
            await transaction.execute(
                """
                INSERT INTO app.spatial_tile_cache_versions
                  (id, organization_id, cache_id, version_number,
                   minimum_tile_matrix, maximum_tile_matrix, maximum_entries,
                   change_message, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    version_id,
                    context.organization_id,
                    cache_id,
                    version_number,
                    minimum_tile_matrix,
                    maximum_tile_matrix,
                    maximum_entries,
                    change_message,
                    context.user_id,
                ),
            )
            if current is not None:
                updated = await transaction.execute(
                    """
                    UPDATE app.spatial_tile_caches
                    SET current_version_id = %s, current_version_number = %s,
                        updated_by = %s,
                        updated_at = GREATEST(
                          clock_timestamp(), updated_at + interval '1 microsecond'
                        )
                    WHERE organization_id = %s AND project_id = %s AND id = %s
                      AND current_version_number = %s
                    """,
                    (
                        version_id,
                        version_number,
                        context.user_id,
                        context.organization_id,
                        project_id,
                        cache_id,
                        expected_version,
                    ),
                )
                if updated != 1:
                    raise SpatialServiceConflict("spatial_tile_cache_version_conflict")
            await self._event(
                transaction,
                context,
                project_id,
                service_id,
                event_type,
                request_id,
                {
                    "binding_id": str(binding_id),
                    "cache_id": str(cache_id),
                    "cache_version": version_number,
                    "minimum_tile_matrix": minimum_tile_matrix,
                    "maximum_tile_matrix": maximum_tile_matrix,
                    "maximum_entries": maximum_entries,
                },
            )
            return await self._load_tile_cache(transaction, context, project_id, binding_id)

        return await self._run(context, operation)

    async def get_tile_cache(
        self, context: TenantContext, project_id: UUID, binding_id: UUID
    ) -> SpatialTileCachePolicy:
        async def operation(transaction: TenantTransaction) -> SpatialTileCachePolicy:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            return await self._load_tile_cache(transaction, context, project_id, binding_id)

        return await self._run(context, operation)

    async def list_tile_caches(
        self, context: TenantContext, project_id: UUID, service_id: UUID
    ) -> tuple[SpatialTileCachePolicy, ...]:
        async def operation(
            transaction: TenantTransaction,
        ) -> tuple[SpatialTileCachePolicy, ...]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            await self._service_by_id(transaction, context, project_id, service_id)
            rows = await transaction.fetch_all(
                f"""
                {self._tile_cache_select()}
                WHERE cache.organization_id = %s AND cache.project_id = %s
                  AND cache.service_id = %s
                ORDER BY cache.binding_id
                LIMIT 100
                """,
                (context.organization_id, project_id, service_id),
            )
            return tuple(self._tile_cache(row) for row in rows)

        return await self._run(context, operation)

    async def invalidate_tile_cache(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        expected_version: int,
        change_message: str | None,
        request_id: str,
    ) -> SpatialTileCachePolicy:
        async def operation(transaction: TenantTransaction) -> SpatialTileCachePolicy:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_MANAGE, roles)
            await self._binding_by_id(
                transaction, context, project_id, service_id, binding_id, lock=True
            )
            current = await self._load_tile_cache(
                transaction, context, project_id, binding_id, lock=True
            )
            if current.version_number != expected_version:
                raise SpatialServiceConflict("spatial_tile_cache_version_conflict")
            version_id = uuid4()
            version_number = current.version_number + 1
            await transaction.execute(
                """
                INSERT INTO app.spatial_tile_cache_versions
                  (id, organization_id, cache_id, version_number,
                   minimum_tile_matrix, maximum_tile_matrix, maximum_entries,
                   change_message, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    version_id,
                    context.organization_id,
                    current.cache_id,
                    version_number,
                    current.minimum_tile_matrix,
                    current.maximum_tile_matrix,
                    current.maximum_entries,
                    change_message,
                    context.user_id,
                ),
            )
            updated = await transaction.execute(
                """
                UPDATE app.spatial_tile_caches
                SET current_version_id = %s, current_version_number = %s,
                    updated_by = %s,
                    updated_at = GREATEST(
                      clock_timestamp(), updated_at + interval '1 microsecond'
                    )
                WHERE organization_id = %s AND project_id = %s AND id = %s
                  AND current_version_number = %s
                """,
                (
                    version_id,
                    version_number,
                    context.user_id,
                    context.organization_id,
                    project_id,
                    current.cache_id,
                    expected_version,
                ),
            )
            if updated != 1:
                raise SpatialServiceConflict("spatial_tile_cache_version_conflict")
            await self._event(
                transaction,
                context,
                project_id,
                service_id,
                "spatial_service.tile_cache.invalidated",
                request_id,
                {
                    "binding_id": str(binding_id),
                    "cache_id": str(current.cache_id),
                    "cache_version": version_number,
                },
            )
            return await self._load_tile_cache(transaction, context, project_id, binding_id)

        return await self._run(context, operation)

    async def record_tile_cache_entry(
        self,
        context: TenantContext,
        project_id: UUID,
        binding_id: UUID,
        expected_cache_version: int,
        tile_matrix: int,
        tile_row: int,
        tile_col: int,
        render_job_id: UUID,
        request_id: str,
    ) -> SpatialTileCacheEntry:
        async def operation(transaction: TenantTransaction) -> SpatialTileCacheEntry:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_MANAGE, roles)
            current = await self._load_tile_cache(
                transaction, context, project_id, binding_id, lock=True
            )
            if current.version_number != expected_cache_version:
                raise SpatialServiceConflict("spatial_tile_cache_version_conflict")
            existing = await self._find_tile_cache_entry(
                transaction,
                context,
                project_id,
                binding_id,
                tile_matrix,
                tile_row,
                tile_col,
            )
            if existing is not None:
                if existing.render_job_id != render_job_id:
                    raise SpatialServiceConflict("spatial_tile_cache_entry_conflict")
                return existing
            entry_id = uuid4()
            row = await transaction.fetch_one(
                """
                INSERT INTO app.spatial_tile_cache_entries
                  (id, organization_id, project_id, cache_id, cache_version_id,
                   cache_version_number, tile_matrix, tile_row, tile_col,
                   render_job_id, seeded_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id, cache_id, cache_version_id, cache_version_number,
                          tile_matrix, tile_row, tile_col, render_job_id,
                          seeded_by, seeded_at
                """,
                (
                    entry_id,
                    context.organization_id,
                    project_id,
                    current.cache_id,
                    current.version_id,
                    current.version_number,
                    tile_matrix,
                    tile_row,
                    tile_col,
                    render_job_id,
                    context.user_id,
                ),
            )
            assert row is not None
            await self._event(
                transaction,
                context,
                project_id,
                current.service_id,
                "spatial_service.tile_cache.seeded",
                request_id,
                {
                    "binding_id": str(binding_id),
                    "cache_id": str(current.cache_id),
                    "cache_version": current.version_number,
                    "tile_matrix": tile_matrix,
                    "tile_row": tile_row,
                    "tile_col": tile_col,
                    "render_job_id": str(render_job_id),
                },
            )
            return self._tile_cache_entry(row)

        return await self._run(context, operation)

    async def resolve_tile_cache_entry(
        self,
        context: TenantContext,
        project_id: UUID,
        binding_id: UUID,
        tile_matrix: int,
        tile_row: int,
        tile_col: int,
    ) -> SpatialTileCacheEntry:
        async def operation(transaction: TenantTransaction) -> SpatialTileCacheEntry:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            entry = await self._find_tile_cache_entry(
                transaction,
                context,
                project_id,
                binding_id,
                tile_matrix,
                tile_row,
                tile_col,
            )
            if entry is None:
                raise SpatialServiceNotFound("spatial_tile_cache_entry")
            return entry

        return await self._run(context, operation)

    async def preview_tile_seed_plan(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        expected_cache_version: int,
        mode: str,
        request_bbox: tuple[float, float, float, float] | None,
        minimum_tile_matrix: int,
        maximum_tile_matrix: int,
        coordinates: tuple[SpatialTileCoordinate, ...],
    ) -> SpatialTileSeedPlanPreview:
        async def operation(transaction: TenantTransaction) -> SpatialTileSeedPlanPreview:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_MANAGE, roles)
            preview = await self._tile_seed_plan_preview(
                transaction,
                context,
                project_id,
                service_id,
                binding_id,
                expected_cache_version,
                mode,
                request_bbox,
                minimum_tile_matrix,
                maximum_tile_matrix,
                coordinates,
                self._now().astimezone(UTC) + TILE_SEED_PLAN_PREVIEW_TTL,
            )
            return preview

        return await self._run(context, operation)

    async def confirm_tile_seed_plan(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        expected_cache_version: int,
        mode: str,
        request_bbox: tuple[float, float, float, float] | None,
        minimum_tile_matrix: int,
        maximum_tile_matrix: int,
        coordinates: tuple[SpatialTileCoordinate, ...],
        preview_checksum_sha256: str,
        preview_expires_at: datetime,
        request_id: str,
    ) -> SpatialTileSeedPlan:
        async def operation(transaction: TenantTransaction) -> SpatialTileSeedPlan:
            roles = await self._project_roles(transaction, context, project_id, lock=True)
            self._require(Action.SPATIAL_SERVICE_MANAGE, roles)
            expires_at = preview_expires_at.astimezone(UTC)
            now = self._now().astimezone(UTC)
            if expires_at <= now or expires_at > now + TILE_SEED_PLAN_PREVIEW_TTL:
                raise SpatialServiceConflict("spatial_tile_seed_plan_changed")
            preview = await self._tile_seed_plan_preview(
                transaction,
                context,
                project_id,
                service_id,
                binding_id,
                expected_cache_version,
                mode,
                request_bbox,
                minimum_tile_matrix,
                maximum_tile_matrix,
                coordinates,
                expires_at,
            )
            if not preview.targets or preview.preview_checksum_sha256 != preview_checksum_sha256:
                raise SpatialServiceConflict("spatial_tile_seed_plan_changed")
            row = await transaction.fetch_one(
                """
                SELECT app.queue_spatial_tile_seed_plan(
                  %s, %s, %s, %s, %s, %s, %s, %s, %s,
                  %s, %s, %s, %s, %s, %s, %s, %s
                )
                """,
                (
                    context.organization_id,
                    project_id,
                    service_id,
                    binding_id,
                    expected_cache_version,
                    mode,
                    None if request_bbox is None else list(request_bbox),
                    minimum_tile_matrix,
                    maximum_tile_matrix,
                    [item.tile_matrix for item in preview.targets],
                    [item.tile_row for item in preview.targets],
                    [item.tile_col for item in preview.targets],
                    preview.requested_count,
                    preview.existing_count,
                    preview_checksum_sha256,
                    expires_at,
                    context.user_id,
                ),
            )
            if row is None:
                raise SpatialServiceConflict("spatial_tile_seed_plan_conflict")
            plan_id = cast(UUID, row[0])
            await self._event(
                transaction,
                context,
                project_id,
                service_id,
                "spatial_service.tile_seed_plan.confirmed",
                request_id,
                {
                    "binding_id": str(binding_id),
                    "plan_id": str(plan_id),
                    "cache_version": expected_cache_version,
                    "target_count": len(preview.targets),
                    "mode": mode,
                },
            )
            return await self._load_tile_seed_plan(
                transaction, context, project_id, service_id, binding_id, plan_id
            )

        return await self._run(context, operation)

    async def attach_tile_seed_plan_render(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        plan_id: UUID,
        position: int,
        render_job_id: UUID,
    ) -> SpatialTileSeedPlan:
        async def operation(transaction: TenantTransaction) -> SpatialTileSeedPlan:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_MANAGE, roles)
            await self._load_tile_seed_plan(
                transaction, context, project_id, service_id, binding_id, plan_id
            )
            await transaction.fetch_one(
                "SELECT app.attach_spatial_tile_seed_plan_render(%s,%s,%s,%s,%s)",
                (context.organization_id, plan_id, position, render_job_id, context.user_id),
            )
            return await self._load_tile_seed_plan(
                transaction, context, project_id, service_id, binding_id, plan_id
            )

        return await self._run(context, operation)

    async def begin_tile_seed_plan_dispatch(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        plan_id: UUID,
        request_id: str,
    ) -> SpatialTileSeedPlan:
        async def operation(transaction: TenantTransaction) -> SpatialTileSeedPlan:
            roles = await self._project_roles(transaction, context, project_id, lock=True)
            self._require(Action.SPATIAL_SERVICE_MANAGE, roles)
            await self._load_tile_seed_plan(
                transaction, context, project_id, service_id, binding_id, plan_id
            )
            await transaction.fetch_one(
                "SELECT app.begin_spatial_tile_seed_plan_dispatch(%s,%s,%s)",
                (context.organization_id, plan_id, context.user_id),
            )
            plan = await self._load_tile_seed_plan(
                transaction, context, project_id, service_id, binding_id, plan_id
            )
            await self._event(
                transaction,
                context,
                project_id,
                service_id,
                "spatial_service.tile_seed_plan.dispatch_started",
                request_id,
                {
                    "binding_id": str(binding_id),
                    "plan_id": str(plan_id),
                    "state": plan.state,
                    "target_count": plan.target_count,
                },
            )
            return plan

        return await self._run(context, operation)

    async def list_tile_seed_plans(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
    ) -> tuple[SpatialTileSeedPlan, ...]:
        async def operation(
            transaction: TenantTransaction,
        ) -> tuple[SpatialTileSeedPlan, ...]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            await self._binding_by_id(transaction, context, project_id, service_id, binding_id)
            rows = await transaction.fetch_all(
                """
                SELECT id FROM app.spatial_tile_seed_plans
                WHERE organization_id = %s AND project_id = %s
                  AND service_id = %s AND binding_id = %s
                ORDER BY created_at DESC, id DESC LIMIT 64
                """,
                (context.organization_id, project_id, service_id, binding_id),
            )
            return tuple(
                [
                    await self._load_tile_seed_plan(
                        transaction,
                        context,
                        project_id,
                        service_id,
                        binding_id,
                        cast(UUID, row[0]),
                    )
                    for row in rows
                ]
            )

        return await self._run(context, operation)

    async def cancel_tile_seed_plan(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        plan_id: UUID,
        request_id: str,
    ) -> SpatialTileSeedPlan:
        async def operation(transaction: TenantTransaction) -> SpatialTileSeedPlan:
            roles = await self._project_roles(transaction, context, project_id, lock=True)
            self._require(Action.SPATIAL_SERVICE_MANAGE, roles)
            await self._load_tile_seed_plan(
                transaction, context, project_id, service_id, binding_id, plan_id
            )
            await transaction.fetch_one(
                "SELECT app.cancel_spatial_tile_seed_plan(%s,%s,%s)",
                (context.organization_id, plan_id, context.user_id),
            )
            plan = await self._load_tile_seed_plan(
                transaction, context, project_id, service_id, binding_id, plan_id
            )
            await self._event(
                transaction,
                context,
                project_id,
                service_id,
                "spatial_service.tile_seed_plan.cancelled",
                request_id,
                {"binding_id": str(binding_id), "plan_id": str(plan_id)},
            )
            return plan

        return await self._run(context, operation)

    async def _tile_seed_plan_preview(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        expected_cache_version: int,
        mode: str,
        request_bbox: tuple[float, float, float, float] | None,
        minimum_tile_matrix: int,
        maximum_tile_matrix: int,
        coordinates: tuple[SpatialTileCoordinate, ...],
        expires_at: datetime,
    ) -> SpatialTileSeedPlanPreview:
        await self._binding_by_id(transaction, context, project_id, service_id, binding_id)
        policy = await self._load_tile_cache(transaction, context, project_id, binding_id)
        if policy.version_number != expected_cache_version:
            raise SpatialServiceConflict("spatial_tile_cache_version_conflict")
        if (
            mode not in {"tiles", "bbox"}
            or (mode == "tiles" and request_bbox is not None)
            or (mode == "bbox" and request_bbox is None)
            or not coordinates
            or len(coordinates) > TILE_SEED_PLAN_BATCH_LIMIT
            or coordinates != tuple(sorted(set(coordinates)))
            or minimum_tile_matrix < policy.minimum_tile_matrix
            or maximum_tile_matrix > policy.maximum_tile_matrix
            or maximum_tile_matrix < minimum_tile_matrix
            or any(
                coordinate.tile_matrix < minimum_tile_matrix
                or coordinate.tile_matrix > maximum_tile_matrix
                or coordinate.tile_row < 0
                or coordinate.tile_col < 0
                or coordinate.tile_row >= 1 << coordinate.tile_matrix
                or coordinate.tile_col >= 1 << coordinate.tile_matrix
                for coordinate in coordinates
            )
        ):
            raise SpatialServiceConflict("spatial_tile_seed_plan_invalid")
        rows = await transaction.fetch_all(
            """
            SELECT entry.tile_matrix, entry.tile_row, entry.tile_col
            FROM app.spatial_tile_cache_entries entry
            WHERE entry.organization_id = %s AND entry.cache_id = %s
              AND entry.cache_version_number = %s
              AND (entry.tile_matrix, entry.tile_row, entry.tile_col) IN (
                SELECT * FROM unnest(%s::integer[], %s::integer[], %s::integer[])
              )
            """,
            (
                context.organization_id,
                policy.cache_id,
                policy.version_number,
                [item.tile_matrix for item in coordinates],
                [item.tile_row for item in coordinates],
                [item.tile_col for item in coordinates],
            ),
        )
        existing = {
            SpatialTileCoordinate(cast(int, row[0]), cast(int, row[1]), cast(int, row[2]))
            for row in rows
        }
        targets = tuple(item for item in coordinates if item not in existing)
        checksum = self._tile_seed_plan_preview_checksum(
            context.organization_id,
            project_id,
            service_id,
            binding_id,
            policy.cache_id,
            policy.version_id,
            policy.version_number,
            mode,
            request_bbox,
            minimum_tile_matrix,
            maximum_tile_matrix,
            len(coordinates),
            len(existing),
            targets,
            expires_at,
        )
        return SpatialTileSeedPlanPreview(
            cache_id=policy.cache_id,
            cache_version_id=policy.version_id,
            cache_version_number=policy.version_number,
            mode=mode,
            request_bbox=request_bbox,
            minimum_tile_matrix=minimum_tile_matrix,
            maximum_tile_matrix=maximum_tile_matrix,
            requested_count=len(coordinates),
            existing_count=len(existing),
            targets=targets,
            expires_at=expires_at,
            preview_checksum_sha256=checksum,
        )

    @staticmethod
    def _tile_seed_plan_preview_checksum(
        organization_id: UUID,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        cache_id: UUID,
        cache_version_id: UUID,
        cache_version_number: int,
        mode: str,
        request_bbox: tuple[float, float, float, float] | None,
        minimum_tile_matrix: int,
        maximum_tile_matrix: int,
        requested_count: int,
        existing_count: int,
        targets: tuple[SpatialTileCoordinate, ...],
        expires_at: datetime,
    ) -> str:
        canonical = json.dumps(
            {
                "schema": "opengeo.tile-seed-plan.preview.v1",
                "organization_id": str(organization_id),
                "project_id": str(project_id),
                "service_id": str(service_id),
                "binding_id": str(binding_id),
                "cache_id": str(cache_id),
                "cache_version_id": str(cache_version_id),
                "cache_version_number": cache_version_number,
                "mode": mode,
                "request_bbox": request_bbox,
                "minimum_tile_matrix": minimum_tile_matrix,
                "maximum_tile_matrix": maximum_tile_matrix,
                "requested_count": requested_count,
                "existing_count": existing_count,
                "targets": [[item.tile_matrix, item.tile_row, item.tile_col] for item in targets],
                "expires_at": expires_at.astimezone(UTC).isoformat(),
            },
            separators=(",", ":"),
            sort_keys=True,
        )
        return sha256(canonical.encode()).hexdigest()

    async def _load_tile_seed_plan(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        plan_id: UUID,
    ) -> SpatialTileSeedPlan:
        row = await transaction.fetch_one(
            """
            SELECT id, project_id, service_id, binding_id, cache_id,
                   cache_version_id, cache_version_number, mode, request_bbox,
                   minimum_tile_matrix, maximum_tile_matrix, requested_count,
                   existing_count, target_count, preview_checksum_sha256,
                   preview_expires_at, state, error_code, created_by, created_at,
                   dispatch_started_at, started_at, finished_at
            FROM app.spatial_tile_seed_plans
            WHERE organization_id = %s AND project_id = %s AND service_id = %s
              AND binding_id = %s AND id = %s
            """,
            (context.organization_id, project_id, service_id, binding_id, plan_id),
        )
        if row is None:
            raise SpatialServiceNotFound("spatial_tile_seed_plan")
        item_rows = await transaction.fetch_all(
            """
            SELECT position, tile_matrix, tile_row, tile_col, render_job_id,
                   state, error_code, started_at, finished_at
            FROM app.spatial_tile_seed_plan_items
            WHERE organization_id = %s AND plan_id = %s
            ORDER BY position
            """,
            (context.organization_id, plan_id),
        )
        bbox_values = cast(list[float] | None, row[8])
        return SpatialTileSeedPlan(
            plan_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            service_id=cast(UUID, row[2]),
            binding_id=cast(UUID, row[3]),
            cache_id=cast(UUID, row[4]),
            cache_version_id=cast(UUID, row[5]),
            cache_version_number=cast(int, row[6]),
            mode=cast(str, row[7]),
            request_bbox=None if bbox_values is None else tuple(bbox_values),  # type: ignore[arg-type]
            minimum_tile_matrix=cast(int, row[9]),
            maximum_tile_matrix=cast(int, row[10]),
            requested_count=cast(int, row[11]),
            existing_count=cast(int, row[12]),
            target_count=cast(int, row[13]),
            preview_checksum_sha256=cast(str, row[14]),
            preview_expires_at=cast(datetime, row[15]),
            state=cast(str, row[16]),
            error_code=cast(str | None, row[17]),
            created_by=cast(UUID, row[18]),
            created_at=cast(datetime, row[19]),
            dispatch_started_at=cast(datetime | None, row[20]),
            started_at=cast(datetime | None, row[21]),
            finished_at=cast(datetime | None, row[22]),
            items=tuple(
                SpatialTileSeedPlanItem(
                    position=cast(int, item[0]),
                    coordinate=SpatialTileCoordinate(
                        cast(int, item[1]), cast(int, item[2]), cast(int, item[3])
                    ),
                    render_job_id=cast(UUID | None, item[4]),
                    state=cast(str, item[5]),
                    error_code=cast(str | None, item[6]),
                    started_at=cast(datetime | None, item[7]),
                    finished_at=cast(datetime | None, item[8]),
                )
                for item in item_rows
            ),
        )

    async def list_services(
        self, context: TenantContext, project_id: UUID
    ) -> tuple[SpatialService, ...]:
        async def operation(transaction: TenantTransaction) -> tuple[SpatialService, ...]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            rows = await transaction.fetch_all(
                """
                SELECT service.id, service.project_id, service.slug,
                       metadata.title, metadata.abstract, service.created_by,
                       service.created_at, service.disabled_by, service.disabled_at,
                       metadata.enabled_protocols
                FROM app.spatial_services service
                JOIN app.spatial_service_metadata_versions metadata
                  ON metadata.organization_id = service.organization_id
                 AND metadata.service_id = service.id
                 AND metadata.id = service.current_metadata_version_id
                WHERE service.organization_id = %s AND service.project_id = %s
                ORDER BY lower(service.slug), service.id
                LIMIT 100
                """,
                (context.organization_id, project_id),
            )
            return tuple(self._service(row) for row in rows)

        return await self._run(context, operation)

    async def get_active_service(
        self, context: TenantContext, project_id: UUID, slug: str
    ) -> SpatialService:
        async def operation(transaction: TenantTransaction) -> SpatialService:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            row = await transaction.fetch_one(
                """
                SELECT service.id, service.project_id, service.slug,
                       metadata.title, metadata.abstract, service.created_by,
                       service.created_at, service.disabled_by, service.disabled_at,
                       metadata.enabled_protocols
                FROM app.spatial_services service
                JOIN app.spatial_service_metadata_versions metadata
                  ON metadata.organization_id = service.organization_id
                 AND metadata.service_id = service.id
                 AND metadata.id = service.current_metadata_version_id
                WHERE service.organization_id = %s AND service.project_id = %s
                  AND service.slug = %s AND service.disabled_at IS NULL
                """,
                (context.organization_id, project_id, slug),
            )
            if row is None:
                raise SpatialServiceNotFound("spatial_service")
            return self._service(row)

        return await self._run(context, operation)

    async def disable_service(
        self, context: TenantContext, project_id: UUID, service_id: UUID, request_id: str
    ) -> SpatialService:
        async def operation(transaction: TenantTransaction) -> SpatialService:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_MANAGE, roles)
            current = await self._service_by_id(
                transaction, context, project_id, service_id, lock=True
            )
            if current.disabled_at is not None:
                return current
            row = await transaction.fetch_one(
                """
                UPDATE app.spatial_services
                SET disabled_by = %s, disabled_at = clock_timestamp()
                WHERE organization_id = %s AND project_id = %s AND id = %s
                  AND disabled_at IS NULL
                RETURNING id, project_id, slug, title, description, created_by,
                          created_at, disabled_by, disabled_at
                """,
                (context.user_id, context.organization_id, project_id, service_id),
            )
            if row is None:
                raise SpatialServiceConflict("spatial_service_disable_conflict")
            await self._event(
                transaction,
                context,
                project_id,
                service_id,
                "spatial_service.disabled",
                request_id,
                {},
            )
            return self._service(row)

        return await self._run(context, operation)

    async def create_collection(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        collection_name: str,
        dataset_id: UUID,
        resource_id: UUID,
        default_profile_id: UUID,
        expected_feature_generation: int,
        expected_profile_version: int,
        title: str,
        description: str | None,
        request_id: str,
    ) -> SpatialServiceCollection:
        async def operation(transaction: TenantTransaction) -> SpatialServiceCollection:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_MANAGE, roles)
            service = await self._service_by_id(
                transaction, context, project_id, service_id, lock=True
            )
            if service.disabled_at is not None:
                raise SpatialServiceConflict("spatial_service_disabled")
            count = await transaction.fetch_one(
                """
                SELECT count(*)::bigint FROM app.spatial_service_collections
                WHERE organization_id = %s AND service_id = %s AND withdrawn_at IS NULL
                """,
                (context.organization_id, service_id),
            )
            if count is not None and cast(int, count[0]) >= 32:
                raise SpatialServiceConflict("spatial_service_collection_limit_reached")
            target = await transaction.fetch_one(
                """
                SELECT collection.generation, profile.current_version_id,
                       version.version_number
                FROM app.feature_collections collection
                JOIN app.governed_resources resource
                  ON resource.organization_id = collection.organization_id
                 AND resource.project_id = %s
                 AND resource.id = %s
                 AND resource.dataset_id = collection.dataset_id
                JOIN app.map_render_profiles profile
                  ON profile.organization_id = resource.organization_id
                 AND profile.project_id = resource.project_id
                 AND profile.resource_id = resource.id
                 AND profile.id = %s
                JOIN app.map_render_profile_versions version
                  ON version.organization_id = profile.organization_id
                 AND version.profile_id = profile.id
                 AND version.id = profile.current_version_id
                 AND version.dataset_id = collection.dataset_id
                JOIN app.datasets dataset
                  ON dataset.organization_id = collection.organization_id
                 AND dataset.id = collection.dataset_id
                 AND dataset.current_version_id = version.dataset_version_id
                WHERE collection.organization_id = %s
                  AND collection.dataset_id = %s
                  AND dataset.status = 'active'
                  AND dataset.format IN ('geojson', 'shapefile', 'geopackage', 'geoparquet')
                  AND resource.kind IN ('dataset', 'service')
                  AND resource.state = 'published'
                """,
                (
                    project_id,
                    resource_id,
                    default_profile_id,
                    context.organization_id,
                    dataset_id,
                ),
            )
            if target is None:
                raise SpatialServiceConflict("spatial_service_collection_target_invalid")
            generation = cast(int, target[0])
            profile_version_id = cast(UUID, target[1])
            profile_version = cast(int, target[2])
            if (
                generation != expected_feature_generation
                or profile_version != expected_profile_version
            ):
                raise SpatialServiceConflict("spatial_service_collection_target_changed")
            binding_id = uuid4()
            row = await transaction.fetch_one(
                f"""
                INSERT INTO app.spatial_service_collections
                  (id, organization_id, project_id, service_id, collection_name,
                   dataset_id, resource_id, default_profile_id,
                   sealed_feature_generation, sealed_profile_version_id,
                   sealed_profile_version_number, title, description, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING {self._collection_columns()}
                """,
                (
                    binding_id,
                    context.organization_id,
                    project_id,
                    service_id,
                    collection_name,
                    dataset_id,
                    resource_id,
                    default_profile_id,
                    generation,
                    profile_version_id,
                    profile_version,
                    title,
                    description,
                    context.user_id,
                ),
            )
            assert row is not None
            await self._event(
                transaction,
                context,
                project_id,
                service_id,
                "spatial_service.collection.created",
                request_id,
                {
                    "binding_id": str(binding_id),
                    "collection_name": collection_name,
                    "dataset_id": str(dataset_id),
                    "resource_id": str(resource_id),
                    "feature_generation": generation,
                    "profile_version": profile_version,
                },
            )
            return self._collection(row)

        return await self._run(context, operation)

    async def list_collections(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        *,
        include_withdrawn: bool,
    ) -> tuple[SpatialServiceCollection, ...]:
        async def operation(
            transaction: TenantTransaction,
        ) -> tuple[SpatialServiceCollection, ...]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            await self._service_by_id(transaction, context, project_id, service_id)
            rows = await transaction.fetch_all(
                f"""
                {self._collection_select()}
                WHERE binding.organization_id = %s
                  AND binding.project_id = %s
                  AND binding.service_id = %s
                  {"" if include_withdrawn else "AND binding.withdrawn_at IS NULL"}
                ORDER BY lower(binding.collection_name), binding.id
                LIMIT 100
                """,
                (context.organization_id, project_id, service_id),
            )
            return tuple(self._collection(row) for row in rows)

        return await self._run(context, operation)

    async def resolve_collection(
        self,
        context: TenantContext,
        project_id: UUID,
        service_slug: str,
        collection_name: str,
    ) -> SpatialServiceCollection:
        async def operation(transaction: TenantTransaction) -> SpatialServiceCollection:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            row = await transaction.fetch_one(
                f"""
                {self._collection_select()}
                JOIN app.spatial_services service
                  ON service.organization_id = binding.organization_id
                 AND service.project_id = binding.project_id
                 AND service.id = binding.service_id
                WHERE binding.organization_id = %s
                  AND binding.project_id = %s
                  AND service.slug = %s
                  AND service.disabled_at IS NULL
                  AND binding.collection_name = %s
                  AND binding.withdrawn_at IS NULL
                """,
                (context.organization_id, project_id, service_slug, collection_name),
            )
            if row is None:
                raise SpatialServiceNotFound("spatial_service_collection")
            return self._collection(row)

        return await self._run(context, operation)

    async def withdraw_collection(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        request_id: str,
    ) -> SpatialServiceCollection:
        async def operation(transaction: TenantTransaction) -> SpatialServiceCollection:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_MANAGE, roles)
            current_row = await transaction.fetch_one(
                f"""
                {self._collection_select()}
                WHERE binding.organization_id = %s AND binding.project_id = %s
                  AND binding.service_id = %s AND binding.id = %s
                FOR UPDATE OF binding
                """,
                (context.organization_id, project_id, service_id, binding_id),
            )
            if current_row is None:
                raise SpatialServiceNotFound("spatial_service_collection")
            current = self._collection(current_row)
            if current.withdrawn_at is not None:
                return current
            row = await transaction.fetch_one(
                f"""
                UPDATE app.spatial_service_collections binding
                SET withdrawn_by = %s, withdrawn_at = clock_timestamp()
                WHERE binding.organization_id = %s AND binding.project_id = %s
                  AND binding.service_id = %s AND binding.id = %s
                  AND binding.withdrawn_at IS NULL
                RETURNING {self._collection_columns()}
                """,
                (
                    context.user_id,
                    context.organization_id,
                    project_id,
                    service_id,
                    binding_id,
                ),
            )
            if row is None:
                raise SpatialServiceConflict("spatial_service_collection_withdraw_conflict")
            await self._event(
                transaction,
                context,
                project_id,
                service_id,
                "spatial_service.collection.withdrawn",
                request_id,
                {"binding_id": str(binding_id), "collection_name": current.collection_name},
            )
            return self._collection(row)

        return await self._run(context, operation)

    @staticmethod
    async def _project_roles(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        *,
        lock: bool = False,
    ) -> Roles:
        row = await transaction.fetch_one(
            f"""
            SELECT organization.role::text,
                   app.effective_project_role(project.id, organization.user_id)::text
            FROM app.organization_memberships organization
            JOIN app.projects project
              ON project.organization_id = organization.organization_id
             AND project.id = %s
            WHERE organization.organization_id = %s
              AND organization.user_id = %s
            {"FOR UPDATE OF project" if lock else ""}
            """,
            (project_id, context.organization_id, context.user_id),
        )
        if row is None:
            raise SpatialServiceNotFound("project")
        return Roles(
            organization=cast(OrganizationRole, row[0]),
            project=cast(ProjectRole | None, row[1]),
        )

    @staticmethod
    def _require(action: Action, roles: Roles) -> None:
        try:
            authorize(action, roles)
        except AuthorizationDenied as error:
            raise SpatialServiceAccessDenied("action forbidden") from error

    async def _service_by_id(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        *,
        lock: bool = False,
    ) -> SpatialService:
        row = await transaction.fetch_one(
            f"""
            SELECT service.id, service.project_id, service.slug,
                   metadata.title, metadata.abstract, service.created_by,
                   service.created_at, service.disabled_by, service.disabled_at
            FROM app.spatial_services service
            JOIN app.spatial_service_metadata_versions metadata
              ON metadata.organization_id = service.organization_id
             AND metadata.service_id = service.id
             AND metadata.id = service.current_metadata_version_id
            WHERE service.organization_id = %s AND service.project_id = %s
              AND service.id = %s
            {"FOR UPDATE OF service" if lock else ""}
            """,
            (context.organization_id, project_id, service_id),
        )
        if row is None:
            raise SpatialServiceNotFound("spatial_service")
        return self._service(row)

    @staticmethod
    async def _event(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        event_type: str,
        request_id: str,
        payload: dict[str, Any],
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.activity_events
              (organization_id, actor_user_id, project_id, event_type,
               resource_type, resource_id, request_id, payload)
            VALUES (%s, %s, %s, %s, 'spatial_service', %s, %s, %s)
            """,
            (
                context.organization_id,
                context.user_id,
                project_id,
                event_type,
                service_id,
                request_id,
                Jsonb(payload),
            ),
        )

    @staticmethod
    def _service(row: tuple[Any, ...]) -> SpatialService:
        return SpatialService(
            service_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            slug=cast(str, row[2]),
            title=cast(str, row[3]),
            description=cast(str | None, row[4]),
            created_by=cast(UUID, row[5]),
            created_at=cast(datetime, row[6]),
            disabled_by=cast(UUID | None, row[7]),
            disabled_at=cast(datetime | None, row[8]),
            enabled_protocols=tuple(cast(list[str], row[9])) if len(row) > 9 else (),
        )

    @staticmethod
    def _collection_columns() -> str:
        return """
          id, project_id, service_id, collection_name, dataset_id, resource_id,
          default_profile_id, sealed_feature_generation, sealed_profile_version_id,
          sealed_profile_version_number, sealed_feature_generation,
          sealed_profile_version_id, sealed_profile_version_number,
          title, description, created_by, created_at, withdrawn_by, withdrawn_at, true
        """

    @staticmethod
    def _collection_select() -> str:
        return """
          SELECT binding.id, binding.project_id, binding.service_id,
                 binding.collection_name, binding.dataset_id, binding.resource_id,
                 default_style.render_profile_id, binding.sealed_feature_generation,
                 default_style.sealed_profile_version_id,
                 default_style.sealed_profile_version_number,
                 collection.generation, profile.current_version_id,
                 current_version.version_number, binding.title, binding.description,
                 binding.created_by, binding.created_at, binding.withdrawn_by,
                 binding.withdrawn_at,
                 (dataset.status = 'active'
                  AND dataset.current_version_id = current_version.dataset_version_id
                  AND resource.state = 'published'
                  AND default_catalog_style.current_version_id =
                      default_style.sealed_style_version_id
                  AND current_version.style_id = default_style.style_id
                  AND current_version.style_version_id =
                      default_style.sealed_style_version_id)
          FROM app.spatial_service_collections binding
          JOIN app.feature_collections collection
            ON collection.organization_id = binding.organization_id
           AND collection.dataset_id = binding.dataset_id
          JOIN app.datasets dataset
            ON dataset.organization_id = binding.organization_id
           AND dataset.id = binding.dataset_id
          JOIN app.governed_resources resource
            ON resource.organization_id = binding.organization_id
           AND resource.project_id = binding.project_id
           AND resource.id = binding.resource_id
          JOIN app.spatial_service_collection_styles default_style
            ON default_style.organization_id = binding.organization_id
           AND default_style.project_id = binding.project_id
           AND default_style.service_id = binding.service_id
           AND default_style.collection_id = binding.id
           AND default_style.is_default
           AND default_style.withdrawn_at IS NULL
          JOIN app.governed_resource_styles default_catalog_style
            ON default_catalog_style.organization_id = default_style.organization_id
           AND default_catalog_style.project_id = default_style.project_id
           AND default_catalog_style.resource_id = binding.resource_id
           AND default_catalog_style.id = default_style.style_id
          JOIN app.map_render_profiles profile
            ON profile.organization_id = binding.organization_id
           AND profile.project_id = binding.project_id
           AND profile.resource_id = binding.resource_id
           AND profile.id = default_style.render_profile_id
          JOIN app.map_render_profile_versions current_version
            ON current_version.organization_id = profile.organization_id
           AND current_version.profile_id = profile.id
           AND current_version.id = profile.current_version_id
        """

    @staticmethod
    def _collection(row: tuple[Any, ...]) -> SpatialServiceCollection:
        return SpatialServiceCollection(
            binding_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            service_id=cast(UUID, row[2]),
            collection_name=cast(str, row[3]),
            dataset_id=cast(UUID, row[4]),
            resource_id=cast(UUID, row[5]),
            default_profile_id=cast(UUID, row[6]),
            sealed_feature_generation=cast(int, row[7]),
            sealed_profile_version_id=cast(UUID, row[8]),
            sealed_profile_version_number=cast(int, row[9]),
            current_feature_generation=cast(int, row[10]),
            current_profile_version_id=cast(UUID, row[11]),
            current_profile_version_number=cast(int, row[12]),
            title=cast(str, row[13]),
            description=cast(str | None, row[14]),
            created_by=cast(UUID, row[15]),
            created_at=cast(datetime, row[16]),
            withdrawn_by=cast(UUID | None, row[17]),
            withdrawn_at=cast(datetime | None, row[18]),
            target_active=cast(bool, row[19]),
        )

    @staticmethod
    def _tile_cache_select() -> str:
        return """
          SELECT cache.id, cache.project_id, cache.service_id, cache.binding_id,
                 version.id, version.version_number, version.minimum_tile_matrix,
                 version.maximum_tile_matrix, version.maximum_entries,
                 (SELECT count(*)::bigint
                  FROM app.spatial_tile_cache_entries entry
                  WHERE entry.organization_id = cache.organization_id
                    AND entry.cache_id = cache.id
                    AND entry.cache_version_id = cache.current_version_id
                    AND entry.cache_version_number = cache.current_version_number),
                 version.change_message, cache.created_by, cache.created_at,
                 cache.updated_by, cache.updated_at
          FROM app.spatial_tile_caches cache
          JOIN app.spatial_tile_cache_versions version
            ON version.organization_id = cache.organization_id
           AND version.cache_id = cache.id
           AND version.id = cache.current_version_id
           AND version.version_number = cache.current_version_number
        """

    @staticmethod
    def _tile_cache(row: tuple[Any, ...]) -> SpatialTileCachePolicy:
        return SpatialTileCachePolicy(
            cache_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            service_id=cast(UUID, row[2]),
            binding_id=cast(UUID, row[3]),
            version_id=cast(UUID, row[4]),
            version_number=cast(int, row[5]),
            minimum_tile_matrix=cast(int, row[6]),
            maximum_tile_matrix=cast(int, row[7]),
            maximum_entries=cast(int, row[8]),
            current_entries=cast(int, row[9]),
            change_message=cast(str | None, row[10]),
            created_by=cast(UUID, row[11]),
            created_at=cast(datetime, row[12]),
            updated_by=cast(UUID, row[13]),
            updated_at=cast(datetime, row[14]),
        )

    @staticmethod
    def _tile_cache_entry(row: tuple[Any, ...]) -> SpatialTileCacheEntry:
        return SpatialTileCacheEntry(
            entry_id=cast(UUID, row[0]),
            cache_id=cast(UUID, row[1]),
            cache_version_id=cast(UUID, row[2]),
            cache_version_number=cast(int, row[3]),
            tile_matrix=cast(int, row[4]),
            tile_row=cast(int, row[5]),
            tile_col=cast(int, row[6]),
            render_job_id=cast(UUID, row[7]),
            seeded_by=cast(UUID, row[8]),
            seeded_at=cast(datetime, row[9]),
        )

    @staticmethod
    def _retired_tile_cache_version(
        row: tuple[Any, ...],
    ) -> RetiredSpatialTileCacheVersion:
        return RetiredSpatialTileCacheVersion(
            cache_id=cast(UUID, row[0]),
            cache_version_id=cast(UUID, row[1]),
            cache_version_number=cast(int, row[2]),
            minimum_tile_matrix=cast(int, row[3]),
            maximum_tile_matrix=cast(int, row[4]),
            maximum_entries=cast(int, row[5]),
            change_message=cast(str | None, row[6]),
            created_at=cast(datetime, row[7]),
            retired_at=cast(datetime, row[8]),
            entry_count=cast(int, row[9]),
            render_output_count=cast(int, row[10]),
            reclamation_id=cast(UUID | None, row[11]),
            reclamation_state=cast(str | None, row[12]),
            reclamation_target_count=cast(int | None, row[13]),
            reclamation_completed_count=cast(int, row[14]),
            reclamation_failed_count=cast(int, row[15]),
        )

    @staticmethod
    def _tile_cache_reclamation_select() -> str:
        return """
          SELECT reclamation.id, reclamation.cache_id,
                 reclamation.cache_version_id,
                 reclamation.cache_version_number,
                 reclamation.target_count, reclamation.target_size_bytes,
                 reclamation.state::text, reclamation.error_code,
                 reclamation.attempt_count,
                 (SELECT count(*)::bigint
                  FROM app.spatial_tile_cache_reclamation_items item
                  WHERE item.organization_id = reclamation.organization_id
                    AND item.reclamation_id = reclamation.id
                    AND item.state = 'completed'),
                 (SELECT count(*)::bigint
                  FROM app.spatial_tile_cache_reclamation_items item
                  WHERE item.organization_id = reclamation.organization_id
                    AND item.reclamation_id = reclamation.id
                    AND item.state = 'failed'),
                 reclamation.preview_checksum_sha256,
                 reclamation.preview_expires_at, reclamation.created_by,
                 reclamation.created_at, reclamation.started_at,
                 reclamation.finished_at
          FROM app.spatial_tile_cache_reclamations reclamation
        """

    @staticmethod
    def _tile_cache_reclamation(
        row: tuple[Any, ...],
    ) -> SpatialTileCacheReclamation:
        return SpatialTileCacheReclamation(
            reclamation_id=cast(UUID, row[0]),
            cache_id=cast(UUID, row[1]),
            cache_version_id=cast(UUID, row[2]),
            cache_version_number=cast(int, row[3]),
            target_count=cast(int, row[4]),
            target_size_bytes=cast(int, row[5]),
            state=cast(str, row[6]),
            error_code=cast(str | None, row[7]),
            attempt_count=cast(int, row[8]),
            completed_target_count=cast(int, row[9]),
            failed_target_count=cast(int, row[10]),
            preview_checksum_sha256=cast(str, row[11]),
            preview_expires_at=cast(datetime, row[12]),
            created_by=cast(UUID, row[13]),
            created_at=cast(datetime, row[14]),
            started_at=cast(datetime | None, row[15]),
            finished_at=cast(datetime | None, row[16]),
        )
