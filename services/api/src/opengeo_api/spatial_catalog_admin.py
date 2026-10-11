from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, Protocol, TypeVar, cast
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
from opengeo_api.spatial_services import (
    SpatialServiceAccessDenied,
    SpatialServiceConflict,
    SpatialServiceNotFound,
    SpatialServiceStoreUnavailable,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)

type StoreKind = Literal["managed_project", "external_source", "postgresql_connection"]
type LayerGroupMode = Literal[
    "single", "opaque_container", "named", "container", "earth_observation"
]

CATALOG_LIMITS: dict[str, int] = {
    "storesPerService": 16,
    "layerGroupsPerService": 64,
    "membersPerLayerGroup": 64,
    "stylesPerCollection": 8,
    "keywordsPerService": 32,
    "accessConstraintsPerService": 16,
    "bulkOperations": 64,
    "bulkRequestBytes": 262_144,
}


@dataclass(frozen=True, slots=True)
class SpatialServiceMetadata:
    version_id: UUID
    service_id: UUID
    version_number: int
    title: str
    abstract: str | None
    namespace_uri: str | None
    keywords: tuple[str, ...]
    fees: str | None
    access_constraints: tuple[str, ...]
    contact: dict[str, Any]
    enabled_protocols: tuple[str, ...]
    change_message: str | None
    created_by: UUID
    created_at: datetime


@dataclass(frozen=True, slots=True)
class SpatialServiceStore:
    store_id: UUID
    project_id: UUID
    service_id: UUID
    slug: str
    title: str
    description: str | None
    kind: StoreKind
    dataset_id: UUID | None
    external_connection_id: UUID | None
    sealed_source_revision_number: int | None
    sealed_connection_revision_number: int | None
    configuration: dict[str, Any]
    created_by: UUID
    created_at: datetime
    disabled_by: UUID | None
    disabled_at: datetime | None


@dataclass(frozen=True, slots=True)
class SpatialServiceLayerGroup:
    group_id: UUID
    project_id: UUID
    service_id: UUID
    slug: str
    version_id: UUID
    version_number: int
    title: str
    description: str | None
    mode: LayerGroupMode
    member_collection_ids: tuple[UUID, ...]
    change_message: str | None
    created_by: UUID
    created_at: datetime
    updated_by: UUID
    updated_at: datetime
    disabled_by: UUID | None
    disabled_at: datetime | None


@dataclass(frozen=True, slots=True)
class SpatialServiceCollectionStyle:
    binding_id: UUID
    project_id: UUID
    service_id: UUID
    collection_id: UUID
    style_name: str
    style_id: UUID
    sealed_style_version_id: UUID
    sealed_style_version_number: int
    current_style_version_id: UUID
    current_style_version_number: int
    render_profile_id: UUID | None
    sealed_profile_version_id: UUID | None
    sealed_profile_version_number: int | None
    current_profile_version_id: UUID | None
    current_profile_version_number: int | None
    is_default: bool
    created_by: UUID
    created_at: datetime
    withdrawn_by: UUID | None
    withdrawn_at: datetime | None

    @property
    def stale(self) -> bool:
        return self.withdrawn_at is None and (
            self.sealed_style_version_id != self.current_style_version_id
            or self.sealed_style_version_number != self.current_style_version_number
            or (
                self.render_profile_id is not None
                and (
                    self.sealed_profile_version_id != self.current_profile_version_id
                    or self.sealed_profile_version_number != self.current_profile_version_number
                )
            )
        )

    @property
    def consumable(self) -> bool:
        return (
            self.withdrawn_at is None
            and self.render_profile_id is not None
            and self.sealed_profile_version_id is not None
            and self.sealed_profile_version_number is not None
            and not self.stale
        )


@dataclass(frozen=True, slots=True)
class SpatialCatalogSnapshot:
    metadata: SpatialServiceMetadata
    stores: tuple[SpatialServiceStore, ...]
    layer_groups: tuple[SpatialServiceLayerGroup, ...]
    styles: tuple[SpatialServiceCollectionStyle, ...]


@dataclass(frozen=True, slots=True)
class MetadataDraft:
    expected_version: int
    title: str
    abstract: str | None
    namespace_uri: str | None
    keywords: tuple[str, ...]
    fees: str | None
    access_constraints: tuple[str, ...]
    contact: dict[str, Any]
    enabled_protocols: tuple[str, ...]
    change_message: str | None


@dataclass(frozen=True, slots=True)
class StoreDraft:
    slug: str
    title: str
    description: str | None
    kind: StoreKind
    dataset_id: UUID | None
    external_connection_id: UUID | None
    sealed_source_revision_number: int | None
    sealed_connection_revision_number: int | None
    configuration: dict[str, Any]


@dataclass(frozen=True, slots=True)
class LayerGroupDraft:
    slug: str
    expected_version: int
    title: str
    description: str | None
    mode: LayerGroupMode
    member_collection_ids: tuple[UUID, ...]
    change_message: str | None


@dataclass(frozen=True, slots=True)
class StyleDraft:
    collection_id: UUID
    style_name: str
    style_id: UUID
    expected_style_version: int
    render_profile_id: UUID
    expected_profile_version: int
    is_default: bool


@dataclass(frozen=True, slots=True)
class UpdateMetadataOperation:
    kind: Literal["update_metadata"]
    draft: MetadataDraft


@dataclass(frozen=True, slots=True)
class CreateStoreOperation:
    kind: Literal["create_store"]
    draft: StoreDraft


@dataclass(frozen=True, slots=True)
class DisableStoreOperation:
    kind: Literal["disable_store"]
    store_id: UUID


@dataclass(frozen=True, slots=True)
class PutLayerGroupOperation:
    kind: Literal["put_layer_group"]
    draft: LayerGroupDraft


@dataclass(frozen=True, slots=True)
class DisableLayerGroupOperation:
    kind: Literal["disable_layer_group"]
    group_id: UUID


@dataclass(frozen=True, slots=True)
class AssignStyleOperation:
    kind: Literal["assign_style"]
    draft: StyleDraft


@dataclass(frozen=True, slots=True)
class WithdrawStyleOperation:
    kind: Literal["withdraw_style"]
    binding_id: UUID


type CatalogOperation = (
    UpdateMetadataOperation
    | CreateStoreOperation
    | DisableStoreOperation
    | PutLayerGroupOperation
    | DisableLayerGroupOperation
    | AssignStyleOperation
    | WithdrawStyleOperation
)


@dataclass(frozen=True, slots=True)
class SpatialCatalogBulkResult:
    applied_operations: int
    operation_results: tuple[dict[str, Any], ...]
    snapshot: SpatialCatalogSnapshot


class SpatialCatalogRepository(Protocol):
    async def get_catalog(
        self, context: TenantContext, project_id: UUID, service_id: UUID
    ) -> SpatialCatalogSnapshot: ...

    async def update_metadata(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        draft: MetadataDraft,
        request_id: str,
    ) -> SpatialServiceMetadata: ...

    async def create_store(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        draft: StoreDraft,
        request_id: str,
    ) -> SpatialServiceStore: ...

    async def disable_store(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        store_id: UUID,
        request_id: str,
    ) -> SpatialServiceStore: ...

    async def put_layer_group(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        draft: LayerGroupDraft,
        request_id: str,
    ) -> SpatialServiceLayerGroup: ...

    async def disable_layer_group(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        group_id: UUID,
        request_id: str,
    ) -> SpatialServiceLayerGroup: ...

    async def assign_style(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        draft: StyleDraft,
        request_id: str,
    ) -> SpatialServiceCollectionStyle: ...

    async def withdraw_style(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        request_id: str,
    ) -> SpatialServiceCollectionStyle: ...

    async def apply_bulk(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        operations: tuple[CatalogOperation, ...],
        request_id: str,
    ) -> SpatialCatalogBulkResult: ...


ResultT = TypeVar("ResultT")


class PostgresSpatialCatalogRepository:
    def __init__(self, executor: TenantTransactionExecutor) -> None:
        self._executor = executor

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT:
        try:
            return await self._executor.run(context, operation)
        except TenantDatabaseConflict as error:
            raise SpatialServiceConflict("spatial_catalog_store_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise SpatialServiceStoreUnavailable("spatial catalog store failed") from error

    async def get_catalog(
        self, context: TenantContext, project_id: UUID, service_id: UUID
    ) -> SpatialCatalogSnapshot:
        async def operation(transaction: TenantTransaction) -> SpatialCatalogSnapshot:
            await self._authorize(transaction, context, project_id, Action.SPATIAL_SERVICE_READ)
            await self._service(transaction, context, project_id, service_id)
            return await self._snapshot(transaction, context, project_id, service_id)

        return await self._run(context, operation)

    async def update_metadata(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        draft: MetadataDraft,
        request_id: str,
    ) -> SpatialServiceMetadata:
        async def operation(transaction: TenantTransaction) -> SpatialServiceMetadata:
            await self._authorize(transaction, context, project_id, Action.SPATIAL_SERVICE_MANAGE)
            record = await self._update_metadata(
                transaction, context, project_id, service_id, draft
            )
            await self._event(
                transaction,
                context,
                project_id,
                service_id,
                "spatial_service.metadata.revised",
                request_id,
                {"version": record.version_number},
            )
            return record

        return await self._run(context, operation)

    async def create_store(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        draft: StoreDraft,
        request_id: str,
    ) -> SpatialServiceStore:
        async def operation(transaction: TenantTransaction) -> SpatialServiceStore:
            await self._authorize(transaction, context, project_id, Action.SPATIAL_SERVICE_MANAGE)
            record = await self._create_store(transaction, context, project_id, service_id, draft)
            await self._event(
                transaction,
                context,
                project_id,
                service_id,
                "spatial_service.store.created",
                request_id,
                {"store_id": str(record.store_id), "kind": record.kind},
            )
            return record

        return await self._run(context, operation)

    async def disable_store(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        store_id: UUID,
        request_id: str,
    ) -> SpatialServiceStore:
        async def operation(transaction: TenantTransaction) -> SpatialServiceStore:
            await self._authorize(transaction, context, project_id, Action.SPATIAL_SERVICE_MANAGE)
            record = await self._disable_store(
                transaction, context, project_id, service_id, store_id
            )
            await self._event(
                transaction,
                context,
                project_id,
                service_id,
                "spatial_service.store.disabled",
                request_id,
                {"store_id": str(store_id)},
            )
            return record

        return await self._run(context, operation)

    async def put_layer_group(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        draft: LayerGroupDraft,
        request_id: str,
    ) -> SpatialServiceLayerGroup:
        async def operation(transaction: TenantTransaction) -> SpatialServiceLayerGroup:
            await self._authorize(transaction, context, project_id, Action.SPATIAL_SERVICE_MANAGE)
            record = await self._put_layer_group(
                transaction, context, project_id, service_id, draft
            )
            await self._event(
                transaction,
                context,
                project_id,
                service_id,
                "spatial_service.layer_group.revised",
                request_id,
                {"group_id": str(record.group_id), "version": record.version_number},
            )
            return record

        return await self._run(context, operation)

    async def disable_layer_group(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        group_id: UUID,
        request_id: str,
    ) -> SpatialServiceLayerGroup:
        async def operation(transaction: TenantTransaction) -> SpatialServiceLayerGroup:
            await self._authorize(transaction, context, project_id, Action.SPATIAL_SERVICE_MANAGE)
            record = await self._disable_layer_group(
                transaction, context, project_id, service_id, group_id
            )
            await self._event(
                transaction,
                context,
                project_id,
                service_id,
                "spatial_service.layer_group.disabled",
                request_id,
                {"group_id": str(group_id)},
            )
            return record

        return await self._run(context, operation)

    async def assign_style(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        draft: StyleDraft,
        request_id: str,
    ) -> SpatialServiceCollectionStyle:
        async def operation(transaction: TenantTransaction) -> SpatialServiceCollectionStyle:
            await self._authorize(transaction, context, project_id, Action.SPATIAL_SERVICE_MANAGE)
            record = await self._assign_style(transaction, context, project_id, service_id, draft)
            await self._event(
                transaction,
                context,
                project_id,
                service_id,
                "spatial_service.collection_style.assigned",
                request_id,
                {
                    "binding_id": str(record.binding_id),
                    "collection_id": str(record.collection_id),
                    "style_id": str(record.style_id),
                    "style_version": record.sealed_style_version_number,
                    "render_profile_id": str(record.render_profile_id),
                    "render_profile_version": record.sealed_profile_version_number,
                    "default": record.is_default,
                },
            )
            return record

        return await self._run(context, operation)

    async def withdraw_style(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        request_id: str,
    ) -> SpatialServiceCollectionStyle:
        async def operation(transaction: TenantTransaction) -> SpatialServiceCollectionStyle:
            await self._authorize(transaction, context, project_id, Action.SPATIAL_SERVICE_MANAGE)
            record = await self._withdraw_style(
                transaction, context, project_id, service_id, binding_id
            )
            await self._event(
                transaction,
                context,
                project_id,
                service_id,
                "spatial_service.collection_style.withdrawn",
                request_id,
                {"binding_id": str(binding_id)},
            )
            return record

        return await self._run(context, operation)

    async def apply_bulk(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        operations: tuple[CatalogOperation, ...],
        request_id: str,
    ) -> SpatialCatalogBulkResult:
        if not 1 <= len(operations) <= CATALOG_LIMITS["bulkOperations"]:
            raise SpatialServiceConflict("spatial_catalog_bulk_operation_limit")

        async def operation(transaction: TenantTransaction) -> SpatialCatalogBulkResult:
            await self._authorize(transaction, context, project_id, Action.SPATIAL_SERVICE_MANAGE)
            await self._service(transaction, context, project_id, service_id, lock=True)
            results: list[dict[str, Any]] = []
            for position, item in enumerate(operations):
                if isinstance(item, UpdateMetadataOperation):
                    metadata_record = await self._update_metadata(
                        transaction, context, project_id, service_id, item.draft
                    )
                    results.append(
                        {
                            "position": position,
                            "kind": item.kind,
                            "version": metadata_record.version_number,
                        }
                    )
                elif isinstance(item, CreateStoreOperation):
                    created_store = await self._create_store(
                        transaction, context, project_id, service_id, item.draft
                    )
                    results.append(
                        {
                            "position": position,
                            "kind": item.kind,
                            "id": str(created_store.store_id),
                        }
                    )
                elif isinstance(item, DisableStoreOperation):
                    disabled_store = await self._disable_store(
                        transaction, context, project_id, service_id, item.store_id
                    )
                    results.append(
                        {
                            "position": position,
                            "kind": item.kind,
                            "id": str(disabled_store.store_id),
                        }
                    )
                elif isinstance(item, PutLayerGroupOperation):
                    group_record = await self._put_layer_group(
                        transaction, context, project_id, service_id, item.draft
                    )
                    results.append(
                        {
                            "position": position,
                            "kind": item.kind,
                            "id": str(group_record.group_id),
                            "version": group_record.version_number,
                        }
                    )
                elif isinstance(item, DisableLayerGroupOperation):
                    disabled_group = await self._disable_layer_group(
                        transaction, context, project_id, service_id, item.group_id
                    )
                    results.append(
                        {
                            "position": position,
                            "kind": item.kind,
                            "id": str(disabled_group.group_id),
                        }
                    )
                elif isinstance(item, AssignStyleOperation):
                    assigned_style = await self._assign_style(
                        transaction, context, project_id, service_id, item.draft
                    )
                    results.append(
                        {
                            "position": position,
                            "kind": item.kind,
                            "id": str(assigned_style.binding_id),
                        }
                    )
                elif isinstance(item, WithdrawStyleOperation):
                    withdrawn_style = await self._withdraw_style(
                        transaction, context, project_id, service_id, item.binding_id
                    )
                    results.append(
                        {
                            "position": position,
                            "kind": item.kind,
                            "id": str(withdrawn_style.binding_id),
                        }
                    )
                else:  # pragma: no cover - exhaustiveness guard
                    raise SpatialServiceConflict("spatial_catalog_bulk_operation_unknown")
            await self._event(
                transaction,
                context,
                project_id,
                service_id,
                "spatial_service.catalog.bulk_applied",
                request_id,
                {"operation_count": len(operations)},
            )
            return SpatialCatalogBulkResult(
                applied_operations=len(operations),
                operation_results=tuple(results),
                snapshot=await self._snapshot(transaction, context, project_id, service_id),
            )

        return await self._run(context, operation)

    async def _update_metadata(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        draft: MetadataDraft,
    ) -> SpatialServiceMetadata:
        service = await self._service(transaction, context, project_id, service_id, lock=True)
        if cast(datetime | None, service[2]) is not None:
            raise SpatialServiceConflict("spatial_service_disabled")
        current_version = cast(int, service[1])
        if current_version != draft.expected_version:
            raise SpatialServiceConflict("spatial_service_metadata_version_conflict")
        version_id = uuid4()
        next_version = current_version + 1
        await transaction.execute(
            """
            INSERT INTO app.spatial_service_metadata_versions
              (id, organization_id, project_id, service_id, version_number,
               title, abstract, namespace_uri, keywords, fees,
               access_constraints, contact, enabled_protocols, change_message,
               created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                version_id,
                context.organization_id,
                project_id,
                service_id,
                next_version,
                draft.title,
                draft.abstract,
                draft.namespace_uri,
                list(draft.keywords),
                draft.fees,
                list(draft.access_constraints),
                Jsonb(draft.contact),
                list(draft.enabled_protocols),
                draft.change_message,
                context.user_id,
            ),
        )
        changed = await transaction.execute(
            """
            UPDATE app.spatial_services
            SET current_metadata_version_id = %s,
                current_metadata_version_number = %s,
                updated_by = %s,
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
            WHERE organization_id = %s AND project_id = %s AND id = %s
              AND disabled_at IS NULL AND current_metadata_version_number = %s
            """,
            (
                version_id,
                next_version,
                context.user_id,
                context.organization_id,
                project_id,
                service_id,
                draft.expected_version,
            ),
        )
        if changed != 1:
            raise SpatialServiceConflict("spatial_service_metadata_version_conflict")
        return await self._metadata(transaction, context, project_id, service_id)

    async def _create_store(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        draft: StoreDraft,
    ) -> SpatialServiceStore:
        await self._service(transaction, context, project_id, service_id, lock=True, active=True)
        store_id = uuid4()
        row = await transaction.fetch_one(
            f"""
            INSERT INTO app.spatial_service_stores
              (id, organization_id, project_id, service_id, slug, title,
               description, kind, dataset_id, external_connection_id,
               sealed_source_revision_number, sealed_connection_revision_number,
               configuration, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s,
                    %s::app.spatial_service_store_kind, %s, %s, %s, %s, %s, %s)
            RETURNING {self._store_columns()}
            """,
            (
                store_id,
                context.organization_id,
                project_id,
                service_id,
                draft.slug,
                draft.title,
                draft.description,
                draft.kind,
                draft.dataset_id,
                draft.external_connection_id,
                draft.sealed_source_revision_number,
                draft.sealed_connection_revision_number,
                Jsonb(draft.configuration),
                context.user_id,
            ),
        )
        assert row is not None
        return self._store_record(row)

    async def _disable_store(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        store_id: UUID,
    ) -> SpatialServiceStore:
        current = await self._store(
            transaction, context, project_id, service_id, store_id, lock=True
        )
        if current.disabled_at is not None:
            return current
        active = await transaction.fetch_one(
            """
            SELECT count(*)::bigint FROM app.spatial_service_collections
            WHERE organization_id = %s AND project_id = %s AND service_id = %s
              AND store_id = %s AND withdrawn_at IS NULL
            """,
            (context.organization_id, project_id, service_id, store_id),
        )
        if active is not None and cast(int, active[0]) > 0:
            raise SpatialServiceConflict("spatial_service_store_in_use")
        row = await transaction.fetch_one(
            f"""
            UPDATE app.spatial_service_stores
            SET disabled_by = %s, disabled_at = clock_timestamp()
            WHERE organization_id = %s AND project_id = %s AND service_id = %s
              AND id = %s AND disabled_at IS NULL
            RETURNING {self._store_columns()}
            """,
            (context.user_id, context.organization_id, project_id, service_id, store_id),
        )
        if row is None:
            raise SpatialServiceConflict("spatial_service_store_disable_conflict")
        return self._store_record(row)

    async def _put_layer_group(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        draft: LayerGroupDraft,
    ) -> SpatialServiceLayerGroup:
        await self._service(transaction, context, project_id, service_id, lock=True, active=True)
        existing = await transaction.fetch_one(
            """
            SELECT id, current_version_number, disabled_at
            FROM app.spatial_service_layer_groups
            WHERE organization_id = %s AND project_id = %s AND service_id = %s
              AND lower(slug) = lower(%s)
            FOR UPDATE
            """,
            (context.organization_id, project_id, service_id, draft.slug),
        )
        version_id = uuid4()
        if existing is None:
            if draft.expected_version != 0:
                raise SpatialServiceConflict("spatial_service_layer_group_version_conflict")
            count = await transaction.fetch_one(
                """
                SELECT count(*)::bigint FROM app.spatial_service_layer_groups
                WHERE organization_id = %s AND service_id = %s AND disabled_at IS NULL
                """,
                (context.organization_id, service_id),
            )
            if count is not None and cast(int, count[0]) >= CATALOG_LIMITS["layerGroupsPerService"]:
                raise SpatialServiceConflict("spatial_service_layer_group_limit_reached")
            group_id = uuid4()
            version_number = 1
            await transaction.execute(
                """
                INSERT INTO app.spatial_service_layer_groups
                  (id, organization_id, project_id, service_id, slug,
                   current_version_id, current_version_number,
                   created_by, updated_by)
                VALUES (%s, %s, %s, %s, %s, %s, 1, %s, %s)
                """,
                (
                    group_id,
                    context.organization_id,
                    project_id,
                    service_id,
                    draft.slug,
                    version_id,
                    context.user_id,
                    context.user_id,
                ),
            )
        else:
            group_id = cast(UUID, existing[0])
            current_version = cast(int, existing[1])
            if cast(datetime | None, existing[2]) is not None:
                raise SpatialServiceConflict("spatial_service_layer_group_disabled")
            if current_version != draft.expected_version:
                raise SpatialServiceConflict("spatial_service_layer_group_version_conflict")
            version_number = current_version + 1
        await transaction.execute(
            """
            INSERT INTO app.spatial_service_layer_group_versions
              (id, organization_id, project_id, service_id, group_id,
               version_number, title, description, mode,
               member_collection_ids, change_message, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s,
                    %s::app.spatial_service_layer_group_mode, %s, %s, %s)
            """,
            (
                version_id,
                context.organization_id,
                project_id,
                service_id,
                group_id,
                version_number,
                draft.title,
                draft.description,
                draft.mode,
                list(draft.member_collection_ids),
                draft.change_message,
                context.user_id,
            ),
        )
        if existing is not None:
            changed = await transaction.execute(
                """
                UPDATE app.spatial_service_layer_groups
                SET current_version_id = %s, current_version_number = %s,
                    updated_by = %s,
                    updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
                WHERE organization_id = %s AND project_id = %s AND service_id = %s
                  AND id = %s AND current_version_number = %s AND disabled_at IS NULL
                """,
                (
                    version_id,
                    version_number,
                    context.user_id,
                    context.organization_id,
                    project_id,
                    service_id,
                    group_id,
                    draft.expected_version,
                ),
            )
            if changed != 1:
                raise SpatialServiceConflict("spatial_service_layer_group_version_conflict")
        return await self._group(transaction, context, project_id, service_id, group_id)

    async def _disable_layer_group(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        group_id: UUID,
    ) -> SpatialServiceLayerGroup:
        current = await self._group(
            transaction, context, project_id, service_id, group_id, lock=True
        )
        if current.disabled_at is not None:
            return current
        changed = await transaction.execute(
            """
            UPDATE app.spatial_service_layer_groups
            SET disabled_by = %s, disabled_at = clock_timestamp()
            WHERE organization_id = %s AND project_id = %s AND service_id = %s
              AND id = %s AND disabled_at IS NULL
            """,
            (context.user_id, context.organization_id, project_id, service_id, group_id),
        )
        if changed != 1:
            raise SpatialServiceConflict("spatial_service_layer_group_disable_conflict")
        return await self._group(transaction, context, project_id, service_id, group_id)

    async def _assign_style(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        draft: StyleDraft,
    ) -> SpatialServiceCollectionStyle:
        await self._service(transaction, context, project_id, service_id, lock=True, active=True)
        collection = await transaction.fetch_one(
            """
            SELECT resource_id FROM app.spatial_service_collections
            WHERE organization_id = %s AND project_id = %s AND service_id = %s
              AND id = %s AND withdrawn_at IS NULL
            FOR UPDATE
            """,
            (context.organization_id, project_id, service_id, draft.collection_id),
        )
        if collection is None:
            raise SpatialServiceNotFound("spatial_service_collection")
        style = await transaction.fetch_one(
            """
            SELECT style.current_version_id, style_version.version_number,
                   profile.id, profile.current_version_id,
                   profile_version.version_number
            FROM app.governed_resource_styles style
            JOIN app.governed_resource_style_versions style_version
              ON style_version.organization_id = style.organization_id
             AND style_version.style_id = style.id
             AND style_version.id = style.current_version_id
            JOIN app.map_render_profiles profile
              ON profile.organization_id = style.organization_id
             AND profile.project_id = style.project_id
             AND profile.resource_id = style.resource_id
             AND profile.id = %s
            JOIN app.map_render_profile_versions profile_version
              ON profile_version.organization_id = profile.organization_id
             AND profile_version.profile_id = profile.id
             AND profile_version.id = profile.current_version_id
             AND profile_version.style_id = style.id
             AND profile_version.style_version_id = style_version.id
            WHERE style.organization_id = %s AND style.project_id = %s
              AND style.resource_id = %s AND style.id = %s
            """,
            (
                draft.render_profile_id,
                context.organization_id,
                project_id,
                cast(UUID, collection[0]),
                draft.style_id,
            ),
        )
        if style is None:
            raise SpatialServiceNotFound("resource_style_render_profile")
        current_version = cast(int, style[1])
        if current_version != draft.expected_style_version:
            raise SpatialServiceConflict("spatial_service_collection_style_version_conflict")
        current_profile_version = cast(int, style[4])
        if current_profile_version != draft.expected_profile_version:
            raise SpatialServiceConflict("spatial_service_collection_profile_version_conflict")
        current_default: tuple[Any, ...] | None = None
        if draft.is_default:
            current_default = await transaction.fetch_one(
                f"""
                {self._style_select()}
                WHERE binding.organization_id = %s AND binding.project_id = %s
                  AND binding.service_id = %s AND binding.collection_id = %s
                  AND binding.is_default AND binding.withdrawn_at IS NULL
                FOR UPDATE OF binding
                """,
                (context.organization_id, project_id, service_id, draft.collection_id),
            )
        current_name = await transaction.fetch_one(
            f"""
            {self._style_select()}
            WHERE binding.organization_id = %s AND binding.project_id = %s
              AND binding.service_id = %s AND binding.collection_id = %s
              AND lower(binding.style_name) = lower(%s)
              AND binding.withdrawn_at IS NULL
            FOR UPDATE OF binding
            """,
            (
                context.organization_id,
                project_id,
                service_id,
                draft.collection_id,
                draft.style_name,
            ),
        )
        active_count = await transaction.fetch_one(
            """
            SELECT count(*)::bigint FROM app.spatial_service_collection_styles
            WHERE organization_id = %s AND collection_id = %s AND withdrawn_at IS NULL
            """,
            (context.organization_id, draft.collection_id),
        )
        if (
            active_count is not None
            and cast(int, active_count[0]) >= CATALOG_LIMITS["stylesPerCollection"]
            and current_default is None
            and current_name is None
        ):
            raise SpatialServiceConflict("spatial_service_collection_style_limit_reached")
        superseded_binding_ids = {
            cast(UUID, record[0])
            for record in (current_default, current_name)
            if record is not None
        }
        for superseded_binding_id in superseded_binding_ids:
            await transaction.execute(
                """
                UPDATE app.spatial_service_collection_styles
                SET withdrawn_by = %s, withdrawn_at = clock_timestamp()
                WHERE organization_id = %s AND id = %s AND withdrawn_at IS NULL
                """,
                (context.user_id, context.organization_id, superseded_binding_id),
            )
        binding_id = uuid4()
        row = await transaction.fetch_one(
            f"""
            INSERT INTO app.spatial_service_collection_styles
              (id, organization_id, project_id, service_id, collection_id,
               style_name, style_id, sealed_style_version_id,
               sealed_style_version_number, render_profile_id,
               sealed_profile_version_id, sealed_profile_version_number,
               is_default, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING {self._style_columns()}
            """,
            (
                binding_id,
                context.organization_id,
                project_id,
                service_id,
                draft.collection_id,
                draft.style_name,
                draft.style_id,
                cast(UUID, style[0]),
                current_version,
                cast(UUID, style[2]),
                cast(UUID, style[3]),
                current_profile_version,
                draft.is_default,
                context.user_id,
            ),
        )
        assert row is not None
        if draft.is_default:
            await self._invalidate_default_style_tile_cache(
                transaction, context, project_id, service_id, draft.collection_id
            )
        return self._style_record(row)

    async def _invalidate_default_style_tile_cache(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        collection_id: UUID,
    ) -> None:
        cache = await transaction.fetch_one(
            """
            SELECT cache.id, cache.current_version_number,
                   version.minimum_tile_matrix, version.maximum_tile_matrix,
                   version.maximum_entries
            FROM app.spatial_tile_caches cache
            JOIN app.spatial_tile_cache_versions version
              ON version.organization_id = cache.organization_id
             AND version.cache_id = cache.id
             AND version.id = cache.current_version_id
             AND version.version_number = cache.current_version_number
            WHERE cache.organization_id = %s AND cache.project_id = %s
              AND cache.service_id = %s AND cache.binding_id = %s
            FOR UPDATE OF cache
            """,
            (context.organization_id, project_id, service_id, collection_id),
        )
        if cache is None:
            return
        cache_id = cast(UUID, cache[0])
        current_version = cast(int, cache[1])
        next_version = current_version + 1
        version_id = uuid4()
        await transaction.execute(
            """
            INSERT INTO app.spatial_tile_cache_versions
              (id, organization_id, cache_id, version_number,
               minimum_tile_matrix, maximum_tile_matrix, maximum_entries,
               change_message, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s,
                    'Default catalog render profile changed', %s)
            """,
            (
                version_id,
                context.organization_id,
                cache_id,
                next_version,
                cast(int, cache[2]),
                cast(int, cache[3]),
                cast(int, cache[4]),
                context.user_id,
            ),
        )
        changed = await transaction.execute(
            """
            UPDATE app.spatial_tile_caches
            SET current_version_id = %s, current_version_number = %s,
                updated_by = %s,
                updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
            WHERE organization_id = %s AND project_id = %s AND service_id = %s
              AND id = %s AND current_version_number = %s
            """,
            (
                version_id,
                next_version,
                context.user_id,
                context.organization_id,
                project_id,
                service_id,
                cache_id,
                current_version,
            ),
        )
        if changed != 1:
            raise SpatialServiceConflict("spatial_tile_cache_version_conflict")

    async def _withdraw_style(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
    ) -> SpatialServiceCollectionStyle:
        current = await self._style(
            transaction, context, project_id, service_id, binding_id, lock=True
        )
        if current.withdrawn_at is not None:
            return current
        if current.is_default:
            raise SpatialServiceConflict("spatial_service_default_style_requires_replacement")
        changed = await transaction.execute(
            """
            UPDATE app.spatial_service_collection_styles
            SET withdrawn_by = %s, withdrawn_at = clock_timestamp()
            WHERE organization_id = %s AND project_id = %s AND service_id = %s
              AND id = %s AND withdrawn_at IS NULL
            """,
            (context.user_id, context.organization_id, project_id, service_id, binding_id),
        )
        if changed != 1:
            raise SpatialServiceConflict("spatial_service_collection_style_withdraw_conflict")
        return await self._style(transaction, context, project_id, service_id, binding_id)

    async def _snapshot(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
    ) -> SpatialCatalogSnapshot:
        metadata = await self._metadata(transaction, context, project_id, service_id)
        store_rows = await transaction.fetch_all(
            f"""
            SELECT {self._store_columns()} FROM app.spatial_service_stores
            WHERE organization_id = %s AND project_id = %s AND service_id = %s
            ORDER BY disabled_at NULLS FIRST, lower(slug), id
            LIMIT 100
            """,
            (context.organization_id, project_id, service_id),
        )
        group_rows = await transaction.fetch_all(
            f"""
            {self._group_select()}
            WHERE group_head.organization_id = %s AND group_head.project_id = %s
              AND group_head.service_id = %s
            ORDER BY group_head.disabled_at NULLS FIRST, lower(group_head.slug), group_head.id
            LIMIT 100
            """,
            (context.organization_id, project_id, service_id),
        )
        style_rows = await transaction.fetch_all(
            f"""
            {self._style_select()}
            WHERE binding.organization_id = %s AND binding.project_id = %s
              AND binding.service_id = %s
            ORDER BY binding.withdrawn_at NULLS FIRST, binding.collection_id,
                     binding.is_default DESC, lower(binding.style_name), binding.id
            LIMIT 512
            """,
            (context.organization_id, project_id, service_id),
        )
        return SpatialCatalogSnapshot(
            metadata=metadata,
            stores=tuple(self._store_record(row) for row in store_rows),
            layer_groups=tuple(self._group_record(row) for row in group_rows),
            styles=tuple(self._style_record(row) for row in style_rows),
        )

    async def _metadata(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
    ) -> SpatialServiceMetadata:
        row = await transaction.fetch_one(
            """
            SELECT version.id, version.service_id, version.version_number,
                   version.title, version.abstract, version.namespace_uri,
                   version.keywords, version.fees, version.access_constraints,
                   version.contact, version.enabled_protocols,
                   version.change_message, version.created_by, version.created_at
            FROM app.spatial_services service
            JOIN app.spatial_service_metadata_versions version
              ON version.organization_id = service.organization_id
             AND version.service_id = service.id
             AND version.id = service.current_metadata_version_id
             AND version.version_number = service.current_metadata_version_number
            WHERE service.organization_id = %s AND service.project_id = %s
              AND service.id = %s
            """,
            (context.organization_id, project_id, service_id),
        )
        if row is None:
            raise SpatialServiceNotFound("spatial_service")
        return self._metadata_record(row)

    async def _service(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        *,
        lock: bool = False,
        active: bool = False,
    ) -> tuple[Any, ...]:
        row = await transaction.fetch_one(
            f"""
            SELECT current_metadata_version_id, current_metadata_version_number, disabled_at
            FROM app.spatial_services
            WHERE organization_id = %s AND project_id = %s AND id = %s
              {"AND disabled_at IS NULL" if active else ""}
            {"FOR UPDATE" if lock else ""}
            """,
            (context.organization_id, project_id, service_id),
        )
        if row is None:
            raise SpatialServiceNotFound("spatial_service")
        return row

    async def _store(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        store_id: UUID,
        *,
        lock: bool = False,
    ) -> SpatialServiceStore:
        row = await transaction.fetch_one(
            f"""
            SELECT {self._store_columns()} FROM app.spatial_service_stores
            WHERE organization_id = %s AND project_id = %s AND service_id = %s
              AND id = %s
            {"FOR UPDATE" if lock else ""}
            """,
            (context.organization_id, project_id, service_id, store_id),
        )
        if row is None:
            raise SpatialServiceNotFound("spatial_service_store")
        return self._store_record(row)

    async def _group(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        group_id: UUID,
        *,
        lock: bool = False,
    ) -> SpatialServiceLayerGroup:
        row = await transaction.fetch_one(
            f"""
            {self._group_select()}
            WHERE group_head.organization_id = %s AND group_head.project_id = %s
              AND group_head.service_id = %s AND group_head.id = %s
            {"FOR UPDATE OF group_head" if lock else ""}
            """,
            (context.organization_id, project_id, service_id, group_id),
        )
        if row is None:
            raise SpatialServiceNotFound("spatial_service_layer_group")
        return self._group_record(row)

    async def _style(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        binding_id: UUID,
        *,
        lock: bool = False,
    ) -> SpatialServiceCollectionStyle:
        row = await transaction.fetch_one(
            f"""
            {self._style_select()}
            WHERE binding.organization_id = %s AND binding.project_id = %s
              AND binding.service_id = %s AND binding.id = %s
            {"FOR UPDATE OF binding" if lock else ""}
            """,
            (context.organization_id, project_id, service_id, binding_id),
        )
        if row is None:
            raise SpatialServiceNotFound("spatial_service_collection_style")
        return self._style_record(row)

    async def _authorize(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        action: Action,
    ) -> None:
        row = await transaction.fetch_one(
            """
            SELECT organization.role::text,
                   app.effective_project_role(project.id, organization.user_id)::text
            FROM app.organization_memberships organization
            JOIN app.projects project
              ON project.organization_id = organization.organization_id
             AND project.id = %s
            WHERE organization.organization_id = %s AND organization.user_id = %s
            """,
            (project_id, context.organization_id, context.user_id),
        )
        if row is None:
            raise SpatialServiceNotFound("project")
        try:
            authorize(
                action,
                Roles(
                    organization=cast(OrganizationRole, row[0]),
                    project=cast(ProjectRole | None, row[1]),
                ),
            )
        except AuthorizationDenied as error:
            raise SpatialServiceAccessDenied("action forbidden") from error

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
    def _store_columns() -> str:
        return """
          id, project_id, service_id, slug, title, description, kind::text,
          dataset_id, external_connection_id, sealed_source_revision_number,
          sealed_connection_revision_number, configuration, created_by,
          created_at, disabled_by, disabled_at
        """

    @staticmethod
    def _group_select() -> str:
        return """
          SELECT group_head.id, group_head.project_id, group_head.service_id,
                 group_head.slug, version.id, version.version_number,
                 version.title, version.description, version.mode::text,
                 version.member_collection_ids, version.change_message,
                 group_head.created_by, group_head.created_at,
                 group_head.updated_by, group_head.updated_at,
                 group_head.disabled_by, group_head.disabled_at
          FROM app.spatial_service_layer_groups group_head
          JOIN app.spatial_service_layer_group_versions version
            ON version.organization_id = group_head.organization_id
           AND version.group_id = group_head.id
           AND version.id = group_head.current_version_id
           AND version.version_number = group_head.current_version_number
        """

    @staticmethod
    def _style_columns() -> str:
        return """
          id, project_id, service_id, collection_id, style_name, style_id,
          sealed_style_version_id, sealed_style_version_number,
          sealed_style_version_id, sealed_style_version_number,
          render_profile_id, sealed_profile_version_id,
          sealed_profile_version_number, sealed_profile_version_id,
          sealed_profile_version_number, is_default, created_by, created_at,
          withdrawn_by, withdrawn_at
        """

    @staticmethod
    def _style_select() -> str:
        return """
          SELECT binding.id, binding.project_id, binding.service_id,
                 binding.collection_id, binding.style_name, binding.style_id,
                 binding.sealed_style_version_id,
                 binding.sealed_style_version_number,
                 style.current_version_id, current_version.version_number,
                 binding.render_profile_id, binding.sealed_profile_version_id,
                 binding.sealed_profile_version_number,
                 profile.current_version_id, profile_version.version_number,
                 binding.is_default, binding.created_by, binding.created_at,
                 binding.withdrawn_by, binding.withdrawn_at
          FROM app.spatial_service_collection_styles binding
          JOIN app.governed_resource_styles style
            ON style.organization_id = binding.organization_id
           AND style.id = binding.style_id
          JOIN app.governed_resource_style_versions current_version
            ON current_version.organization_id = style.organization_id
           AND current_version.style_id = style.id
           AND current_version.id = style.current_version_id
          LEFT JOIN app.map_render_profiles profile
            ON profile.organization_id = binding.organization_id
           AND profile.id = binding.render_profile_id
          LEFT JOIN app.map_render_profile_versions profile_version
            ON profile_version.organization_id = profile.organization_id
           AND profile_version.profile_id = profile.id
           AND profile_version.id = profile.current_version_id
        """

    @staticmethod
    def _metadata_record(row: tuple[Any, ...]) -> SpatialServiceMetadata:
        return SpatialServiceMetadata(
            version_id=cast(UUID, row[0]),
            service_id=cast(UUID, row[1]),
            version_number=cast(int, row[2]),
            title=cast(str, row[3]),
            abstract=cast(str | None, row[4]),
            namespace_uri=cast(str | None, row[5]),
            keywords=tuple(cast(list[str], row[6])),
            fees=cast(str | None, row[7]),
            access_constraints=tuple(cast(list[str], row[8])),
            contact=cast(dict[str, Any], row[9]),
            enabled_protocols=tuple(cast(list[str], row[10])),
            change_message=cast(str | None, row[11]),
            created_by=cast(UUID, row[12]),
            created_at=cast(datetime, row[13]),
        )

    @staticmethod
    def _store_record(row: tuple[Any, ...]) -> SpatialServiceStore:
        return SpatialServiceStore(
            store_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            service_id=cast(UUID, row[2]),
            slug=cast(str, row[3]),
            title=cast(str, row[4]),
            description=cast(str | None, row[5]),
            kind=cast(StoreKind, row[6]),
            dataset_id=cast(UUID | None, row[7]),
            external_connection_id=cast(UUID | None, row[8]),
            sealed_source_revision_number=cast(int | None, row[9]),
            sealed_connection_revision_number=cast(int | None, row[10]),
            configuration=cast(dict[str, Any], row[11]),
            created_by=cast(UUID, row[12]),
            created_at=cast(datetime, row[13]),
            disabled_by=cast(UUID | None, row[14]),
            disabled_at=cast(datetime | None, row[15]),
        )

    @staticmethod
    def _group_record(row: tuple[Any, ...]) -> SpatialServiceLayerGroup:
        return SpatialServiceLayerGroup(
            group_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            service_id=cast(UUID, row[2]),
            slug=cast(str, row[3]),
            version_id=cast(UUID, row[4]),
            version_number=cast(int, row[5]),
            title=cast(str, row[6]),
            description=cast(str | None, row[7]),
            mode=cast(LayerGroupMode, row[8]),
            member_collection_ids=tuple(cast(list[UUID], row[9])),
            change_message=cast(str | None, row[10]),
            created_by=cast(UUID, row[11]),
            created_at=cast(datetime, row[12]),
            updated_by=cast(UUID, row[13]),
            updated_at=cast(datetime, row[14]),
            disabled_by=cast(UUID | None, row[15]),
            disabled_at=cast(datetime | None, row[16]),
        )

    @staticmethod
    def _style_record(row: tuple[Any, ...]) -> SpatialServiceCollectionStyle:
        return SpatialServiceCollectionStyle(
            binding_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            service_id=cast(UUID, row[2]),
            collection_id=cast(UUID, row[3]),
            style_name=cast(str, row[4]),
            style_id=cast(UUID, row[5]),
            sealed_style_version_id=cast(UUID, row[6]),
            sealed_style_version_number=cast(int, row[7]),
            current_style_version_id=cast(UUID, row[8]),
            current_style_version_number=cast(int, row[9]),
            render_profile_id=cast(UUID | None, row[10]),
            sealed_profile_version_id=cast(UUID | None, row[11]),
            sealed_profile_version_number=cast(int | None, row[12]),
            current_profile_version_id=cast(UUID | None, row[13]),
            current_profile_version_number=cast(int | None, row[14]),
            is_default=cast(bool, row[15]),
            created_by=cast(UUID, row[16]),
            created_at=cast(datetime, row[17]),
            withdrawn_by=cast(UUID | None, row[18]),
            withdrawn_at=cast(datetime | None, row[19]),
        )
