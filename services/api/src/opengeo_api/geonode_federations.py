from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
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
from opengeo_api.geonode_federation import GeoNodeFederationConfiguration
from opengeo_api.ingestion import Page, ProcessingJobState
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)


class GeoNodeFederationStoreUnavailable(RuntimeError):
    pass


class GeoNodeFederationAccessDenied(RuntimeError):
    pass


class GeoNodeFederationNotFound(RuntimeError):
    pass


class GeoNodeFederationConflict(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class GeoNodeFederationSource:
    source_id: UUID
    project_id: UUID
    configuration: GeoNodeFederationConfiguration
    configuration_checksum_sha256: str
    status: str
    created_by: UUID
    created_at: datetime
    disabled_at: datetime | None


@dataclass(frozen=True, slots=True)
class GeoNodeFederationSourceSubmission:
    source: GeoNodeFederationSource
    created: bool


@dataclass(frozen=True, slots=True)
class GeoNodeHarvestJob:
    job_id: UUID
    source_id: UUID
    project_id: UUID
    source_configuration_checksum_sha256: str
    request_checksum_sha256: str
    idempotency_key: UUID
    state: ProcessingJobState
    result: dict[str, Any] | None
    error_code: str | None
    attempt_count: int
    created_by: UUID
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


@dataclass(frozen=True, slots=True)
class GeoNodeHarvestSubmission:
    job: GeoNodeHarvestJob
    dispatch_required: bool


@dataclass(frozen=True, slots=True)
class GeoNodeFederatedIdentity:
    source_id: UUID
    remote_identifier: str
    resource_type: str
    title: str
    status: str
    current_version_number: int
    current_payload_sha256: str
    remote_modified_at: datetime | None
    first_seen_at: datetime
    last_refreshed_at: datetime
    fresh_until: datetime
    withdrawn_at: datetime | None


@dataclass(frozen=True, slots=True)
class GeoNodeFederatedIdentityVersion:
    source_id: UUID
    remote_identifier: str
    version_number: int
    harvest_job_id: UUID
    action: str
    resource_type: str
    title: str
    payload_sha256: str
    payload: dict[str, Any] | None
    remote_modified_at: datetime | None
    observed_at: datetime


class GeoNodeFederationRepository(Protocol):
    async def create_source(
        self,
        context: TenantContext,
        project_id: UUID,
        configuration: GeoNodeFederationConfiguration,
    ) -> GeoNodeFederationSourceSubmission: ...

    async def list_sources(
        self,
        context: TenantContext,
        project_id: UUID,
        page: Page,
    ) -> tuple[GeoNodeFederationSource, ...]: ...

    async def get_source(
        self,
        context: TenantContext,
        project_id: UUID,
        source_id: UUID,
    ) -> GeoNodeFederationSource: ...

    async def disable_source(
        self,
        context: TenantContext,
        project_id: UUID,
        source_id: UUID,
        request_id: str,
    ) -> GeoNodeFederationSource: ...

    async def create_harvest(
        self,
        context: TenantContext,
        project_id: UUID,
        source_id: UUID,
        idempotency_key: UUID,
        request_id: str,
    ) -> GeoNodeHarvestSubmission: ...

    async def list_harvests(
        self,
        context: TenantContext,
        project_id: UUID,
        source_id: UUID,
        page: Page,
    ) -> tuple[GeoNodeHarvestJob, ...]: ...

    async def get_harvest(
        self,
        context: TenantContext,
        project_id: UUID,
        source_id: UUID,
        job_id: UUID,
    ) -> GeoNodeHarvestJob: ...

    async def cancel_harvest(
        self,
        context: TenantContext,
        project_id: UUID,
        source_id: UUID,
        job_id: UUID,
        request_id: str,
    ) -> GeoNodeHarvestJob: ...

    async def list_resources(
        self,
        context: TenantContext,
        project_id: UUID,
        source_id: UUID,
        page: Page,
    ) -> tuple[GeoNodeFederatedIdentity, ...]: ...

    async def list_resource_versions(
        self,
        context: TenantContext,
        project_id: UUID,
        source_id: UUID,
        remote_identifier: str,
        page: Page,
    ) -> tuple[GeoNodeFederatedIdentityVersion, ...]: ...


ResultT = TypeVar("ResultT")


class PostgresGeoNodeFederationRepository:
    def __init__(
        self,
        executor: TenantTransactionExecutor,
        *,
        now: Callable[[], datetime] | None = None,
        uuid_factory: Callable[[], UUID] = uuid4,
    ) -> None:
        self._executor = executor
        self._now = now or (lambda: datetime.now(UTC))
        self._uuid_factory = uuid_factory

    async def create_source(
        self,
        context: TenantContext,
        project_id: UUID,
        configuration: GeoNodeFederationConfiguration,
    ) -> GeoNodeFederationSourceSubmission:
        async def operation(
            transaction: TenantTransaction,
        ) -> GeoNodeFederationSourceSubmission:
            self._require(
                Action.PROJECT_DATASETS_MANAGE,
                await self._project_roles(transaction, context, project_id),
            )
            await transaction.fetch_one(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                (
                    "geonode-federation:source:"
                    f"{context.organization_id}:{project_id}:"
                    f"{configuration.source_fingerprint}",
                ),
            )
            existing = await transaction.fetch_one(
                f"""
                {self._source_select()}
                WHERE source.organization_id = %s AND source.project_id = %s
                  AND source.source_fingerprint_sha256 = %s
                """,
                (context.organization_id, project_id, configuration.source_fingerprint),
            )
            if existing is not None:
                source = self._source(existing)
                if source.configuration_checksum_sha256 != (
                    configuration.configuration_checksum_sha256
                ):
                    raise GeoNodeFederationConflict("geonode_federation_configuration_conflict")
                return GeoNodeFederationSourceSubmission(source, False)

            source_id = self._uuid_factory()
            created_at = self._now().astimezone(UTC)
            await transaction.execute(
                """
                INSERT INTO app.geonode_federation_sources
                  (id, organization_id, project_id, display_name, remote_url,
                   source_fingerprint_sha256, source_version, scheduling_enabled,
                   refresh_interval_minutes, maximum_resources, credential_mode,
                   configuration_checksum_sha256, created_by, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    source_id,
                    context.organization_id,
                    project_id,
                    configuration.name,
                    configuration.remote_url,
                    configuration.source_fingerprint,
                    configuration.source_version,
                    configuration.scheduling_enabled,
                    configuration.refresh_interval_minutes,
                    configuration.maximum_resources,
                    configuration.credential_mode,
                    configuration.configuration_checksum_sha256,
                    context.user_id,
                    created_at,
                ),
            )
            return GeoNodeFederationSourceSubmission(
                GeoNodeFederationSource(
                    source_id,
                    project_id,
                    configuration,
                    configuration.configuration_checksum_sha256,
                    "active",
                    context.user_id,
                    created_at,
                    None,
                ),
                True,
            )

        return await self._run(context, operation)

    async def list_sources(
        self,
        context: TenantContext,
        project_id: UUID,
        page: Page,
    ) -> tuple[GeoNodeFederationSource, ...]:
        async def operation(
            transaction: TenantTransaction,
        ) -> tuple[GeoNodeFederationSource, ...]:
            self._require(
                Action.PROJECT_READ,
                await self._project_roles(transaction, context, project_id),
            )
            rows = await transaction.fetch_all(
                f"""
                {self._source_select()}
                WHERE source.organization_id = %s AND source.project_id = %s
                ORDER BY source.created_at DESC, source.id
                LIMIT %s OFFSET %s
                """,
                (context.organization_id, project_id, page.limit, page.offset),
            )
            return tuple(self._source(row) for row in rows)

        return await self._run(context, operation)

    async def get_source(
        self,
        context: TenantContext,
        project_id: UUID,
        source_id: UUID,
    ) -> GeoNodeFederationSource:
        async def operation(transaction: TenantTransaction) -> GeoNodeFederationSource:
            self._require(
                Action.PROJECT_READ,
                await self._project_roles(transaction, context, project_id),
            )
            return await self._load_source(transaction, context, project_id, source_id)

        return await self._run(context, operation)

    async def disable_source(
        self,
        context: TenantContext,
        project_id: UUID,
        source_id: UUID,
        request_id: str,
    ) -> GeoNodeFederationSource:
        async def operation(transaction: TenantTransaction) -> GeoNodeFederationSource:
            self._require(
                Action.PROJECT_DATASETS_MANAGE,
                await self._project_roles(transaction, context, project_id),
            )
            await self._load_source(transaction, context, project_id, source_id)
            result = await transaction.fetch_one(
                """
                SELECT app.disable_geonode_federation_source(%s, %s, %s, %s, %s)
                """,
                (
                    context.organization_id,
                    project_id,
                    source_id,
                    context.user_id,
                    request_id,
                ),
            )
            if result is None or result[0] is not True:
                raise GeoNodeFederationConflict("geonode_federation_disable_conflict")
            return await self._load_source(transaction, context, project_id, source_id)

        return await self._run(context, operation)

    async def create_harvest(
        self,
        context: TenantContext,
        project_id: UUID,
        source_id: UUID,
        idempotency_key: UUID,
        request_id: str,
    ) -> GeoNodeHarvestSubmission:
        async def operation(transaction: TenantTransaction) -> GeoNodeHarvestSubmission:
            self._require(
                Action.PROJECT_DATASETS_MANAGE,
                await self._project_roles(transaction, context, project_id),
            )
            source = await self._load_source(transaction, context, project_id, source_id)
            if source.status != "active":
                raise GeoNodeFederationConflict("geonode_federation_source_disabled")
            checksum = geonode_harvest_request_checksum(
                source_id, source.configuration_checksum_sha256
            )
            await transaction.fetch_one(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                (
                    "geonode-federation:harvest:"
                    f"{context.organization_id}:{project_id}:{idempotency_key}",
                ),
            )
            existing = await transaction.fetch_one(
                f"""
                {self._job_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND job.idempotency_key = %s
                """,
                (context.organization_id, project_id, idempotency_key),
            )
            if existing is not None:
                job = self._job(existing)
                if (
                    job.source_id != source_id
                    or job.request_checksum_sha256 != checksum
                    or job.source_configuration_checksum_sha256
                    != source.configuration_checksum_sha256
                ):
                    raise GeoNodeFederationConflict("geonode_harvest_idempotency_conflict")
                return GeoNodeHarvestSubmission(job, job.state == "queued")

            job_id = self._uuid_factory()
            created_at = self._now().astimezone(UTC)
            await transaction.execute(
                """
                INSERT INTO app.geonode_harvest_jobs
                  (id, organization_id, project_id, source_id,
                   source_configuration_checksum_sha256,
                   request_checksum_sha256, idempotency_key, request_id,
                   created_by, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    job_id,
                    context.organization_id,
                    project_id,
                    source_id,
                    source.configuration_checksum_sha256,
                    checksum,
                    idempotency_key,
                    request_id,
                    context.user_id,
                    created_at,
                ),
            )
            await transaction.execute(
                """
                INSERT INTO app.activity_events
                  (organization_id, actor_user_id, project_id, event_type,
                   resource_type, resource_id, request_id, payload)
                VALUES (%s, %s, %s, 'federation.geonode.harvest.requested',
                        'geonode_harvest', %s, %s, %s)
                """,
                (
                    context.organization_id,
                    context.user_id,
                    project_id,
                    job_id,
                    request_id,
                    Jsonb(
                        {
                            "source_id": str(source_id),
                            "harvest_job_id": str(job_id),
                            "request_checksum_sha256": checksum,
                        }
                    ),
                ),
            )
            return GeoNodeHarvestSubmission(
                GeoNodeHarvestJob(
                    job_id,
                    source_id,
                    project_id,
                    source.configuration_checksum_sha256,
                    checksum,
                    idempotency_key,
                    "queued",
                    None,
                    None,
                    0,
                    context.user_id,
                    created_at,
                    None,
                    None,
                ),
                True,
            )

        return await self._run(context, operation)

    async def list_harvests(
        self,
        context: TenantContext,
        project_id: UUID,
        source_id: UUID,
        page: Page,
    ) -> tuple[GeoNodeHarvestJob, ...]:
        async def operation(transaction: TenantTransaction) -> tuple[GeoNodeHarvestJob, ...]:
            self._require(
                Action.PROJECT_READ,
                await self._project_roles(transaction, context, project_id),
            )
            await self._load_source(transaction, context, project_id, source_id)
            rows = await transaction.fetch_all(
                f"""
                {self._job_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND job.source_id = %s
                ORDER BY job.created_at DESC, job.id
                LIMIT %s OFFSET %s
                """,
                (context.organization_id, project_id, source_id, page.limit, page.offset),
            )
            return tuple(self._job(row) for row in rows)

        return await self._run(context, operation)

    async def get_harvest(
        self,
        context: TenantContext,
        project_id: UUID,
        source_id: UUID,
        job_id: UUID,
    ) -> GeoNodeHarvestJob:
        async def operation(transaction: TenantTransaction) -> GeoNodeHarvestJob:
            self._require(
                Action.PROJECT_READ,
                await self._project_roles(transaction, context, project_id),
            )
            return await self._load_job(transaction, context, project_id, source_id, job_id)

        return await self._run(context, operation)

    async def cancel_harvest(
        self,
        context: TenantContext,
        project_id: UUID,
        source_id: UUID,
        job_id: UUID,
        request_id: str,
    ) -> GeoNodeHarvestJob:
        async def operation(transaction: TenantTransaction) -> GeoNodeHarvestJob:
            self._require(
                Action.PROJECT_DATASETS_MANAGE,
                await self._project_roles(transaction, context, project_id),
            )
            job = await self._load_job(transaction, context, project_id, source_id, job_id)
            if job.state not in {"queued", "running"}:
                raise GeoNodeFederationConflict("geonode_harvest_not_cancellable")
            result = await transaction.fetch_one(
                """
                SELECT app.cancel_geonode_harvest(%s, %s, %s, %s, %s)
                """,
                (
                    context.organization_id,
                    project_id,
                    job_id,
                    context.user_id,
                    request_id,
                ),
            )
            if result is None or result[0] is not True:
                raise GeoNodeFederationConflict("geonode_harvest_cancel_conflict")
            return await self._load_job(transaction, context, project_id, source_id, job_id)

        return await self._run(context, operation)

    async def list_resources(
        self,
        context: TenantContext,
        project_id: UUID,
        source_id: UUID,
        page: Page,
    ) -> tuple[GeoNodeFederatedIdentity, ...]:
        async def operation(
            transaction: TenantTransaction,
        ) -> tuple[GeoNodeFederatedIdentity, ...]:
            self._require(
                Action.PROJECT_READ,
                await self._project_roles(transaction, context, project_id),
            )
            await self._load_source(transaction, context, project_id, source_id)
            rows = await transaction.fetch_all(
                """
                SELECT identity.source_id, identity.remote_identifier,
                       identity.resource_type, identity.title, identity.status,
                       identity.current_version_number,
                       identity.current_payload_sha256,
                       identity.remote_modified_at, identity.first_seen_at,
                       identity.last_refreshed_at,
                       identity.last_refreshed_at
                         + make_interval(mins => source.refresh_interval_minutes),
                       identity.withdrawn_at
                FROM app.geonode_federated_identities identity
                JOIN app.geonode_federation_sources source
                  ON source.organization_id = identity.organization_id
                 AND source.id = identity.source_id
                WHERE identity.organization_id = %s AND identity.project_id = %s
                  AND identity.source_id = %s
                ORDER BY identity.title, identity.remote_identifier
                LIMIT %s OFFSET %s
                """,
                (context.organization_id, project_id, source_id, page.limit, page.offset),
            )
            return tuple(self._identity(row) for row in rows)

        return await self._run(context, operation)

    async def list_resource_versions(
        self,
        context: TenantContext,
        project_id: UUID,
        source_id: UUID,
        remote_identifier: str,
        page: Page,
    ) -> tuple[GeoNodeFederatedIdentityVersion, ...]:
        async def operation(
            transaction: TenantTransaction,
        ) -> tuple[GeoNodeFederatedIdentityVersion, ...]:
            self._require(
                Action.PROJECT_READ,
                await self._project_roles(transaction, context, project_id),
            )
            await self._load_source(transaction, context, project_id, source_id)
            rows = await transaction.fetch_all(
                """
                SELECT version.source_id, version.remote_identifier,
                       version.version_number, version.harvest_job_id,
                       version.action, version.resource_type, version.title,
                       version.payload_sha256, version.payload,
                       version.remote_modified_at, version.observed_at
                FROM app.geonode_federated_identity_versions version
                JOIN app.geonode_federated_identities identity
                  ON identity.organization_id = version.organization_id
                 AND identity.source_id = version.source_id
                 AND identity.remote_identifier = version.remote_identifier
                WHERE version.organization_id = %s AND identity.project_id = %s
                  AND version.source_id = %s AND version.remote_identifier = %s
                ORDER BY version.version_number DESC
                LIMIT %s OFFSET %s
                """,
                (
                    context.organization_id,
                    project_id,
                    source_id,
                    remote_identifier,
                    page.limit,
                    page.offset,
                ),
            )
            return tuple(self._version(row) for row in rows)

        return await self._run(context, operation)

    async def _load_source(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        source_id: UUID,
    ) -> GeoNodeFederationSource:
        row = await transaction.fetch_one(
            f"""
            {self._source_select()}
            WHERE source.organization_id = %s AND source.project_id = %s
              AND source.id = %s
            """,
            (context.organization_id, project_id, source_id),
        )
        if row is None:
            raise GeoNodeFederationNotFound("GeoNode federation source does not exist")
        return self._source(row)

    async def _load_job(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        source_id: UUID,
        job_id: UUID,
    ) -> GeoNodeHarvestJob:
        row = await transaction.fetch_one(
            f"""
            {self._job_select()}
            WHERE job.organization_id = %s AND job.project_id = %s
              AND job.source_id = %s AND job.id = %s
            """,
            (context.organization_id, project_id, source_id, job_id),
        )
        if row is None:
            raise GeoNodeFederationNotFound("GeoNode harvest does not exist")
        return self._job(row)

    async def _project_roles(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
    ) -> Roles:
        organization = await transaction.fetch_one(
            """
            SELECT role::text FROM app.organization_memberships
            WHERE organization_id = %s AND user_id = %s
            """,
            (context.organization_id, context.user_id),
        )
        if organization is None:
            raise GeoNodeFederationAccessDenied("organization membership required")
        project = await transaction.fetch_one(
            """
            SELECT project.id, app.effective_project_role(project.id, %s)::text
            FROM app.projects project
            WHERE project.organization_id = %s AND project.id = %s
            """,
            (context.user_id, context.organization_id, project_id),
        )
        if project is None:
            raise GeoNodeFederationNotFound("project does not exist")
        return Roles(
            organization=cast(OrganizationRole, organization[0]),
            project=cast(ProjectRole | None, project[1]),
        )

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT:
        try:
            return await self._executor.run(context, operation)
        except TenantDatabaseConflict as error:
            raise GeoNodeFederationConflict("geonode_federation_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise GeoNodeFederationStoreUnavailable(
                "GeoNode federation operation failed"
            ) from error

    @staticmethod
    def _require(action: Action, roles: Roles) -> None:
        try:
            authorize(action, roles)
        except AuthorizationDenied as error:
            raise GeoNodeFederationAccessDenied("action forbidden") from error

    @staticmethod
    def _source_select() -> str:
        return """
            SELECT source.id, source.project_id, source.display_name,
                   source.remote_url, source.source_version,
                   source.scheduling_enabled, source.refresh_interval_minutes,
                   source.maximum_resources, source.credential_mode,
                   source.configuration_checksum_sha256, source.status,
                   source.created_by, source.created_at, source.disabled_at
            FROM app.geonode_federation_sources source
        """

    @staticmethod
    def _job_select() -> str:
        return """
            SELECT job.id, job.source_id, job.project_id,
                   job.source_configuration_checksum_sha256,
                   job.request_checksum_sha256, job.idempotency_key,
                   job.state::text, job.result, job.error_code,
                   job.attempt_count, job.created_by, job.created_at,
                   job.started_at, job.finished_at
            FROM app.geonode_harvest_jobs job
        """

    @staticmethod
    def _source(row: tuple[Any, ...]) -> GeoNodeFederationSource:
        if len(row) != 14:
            raise GeoNodeFederationStoreUnavailable("invalid GeoNode federation row")
        try:
            configuration = GeoNodeFederationConfiguration(
                name=cast(str, row[2]),
                remote_url=cast(str, row[3]),
                source_version=cast(Any, row[4]),
                scheduling_enabled=cast(bool, row[5]),
                refresh_interval_minutes=cast(int, row[6]),
                maximum_resources=cast(int, row[7]),
                credential_mode=cast(Any, row[8]),
            )
        except (TypeError, ValueError, RuntimeError) as error:
            raise GeoNodeFederationStoreUnavailable("invalid GeoNode federation row") from error
        if row[10] not in {"active", "disabled"}:
            raise GeoNodeFederationStoreUnavailable("invalid GeoNode federation row")
        return GeoNodeFederationSource(
            cast(UUID, row[0]),
            cast(UUID, row[1]),
            configuration,
            cast(str, row[9]),
            cast(str, row[10]),
            cast(UUID, row[11]),
            cast(datetime, row[12]),
            cast(datetime | None, row[13]),
        )

    @staticmethod
    def _job(row: tuple[Any, ...]) -> GeoNodeHarvestJob:
        if len(row) != 14 or row[6] not in {
            "queued",
            "running",
            "completed",
            "failed",
            "cancelled",
        }:
            raise GeoNodeFederationStoreUnavailable("invalid GeoNode harvest row")
        result = row[7]
        if result is not None and not isinstance(result, dict):
            raise GeoNodeFederationStoreUnavailable("invalid GeoNode harvest row")
        return GeoNodeHarvestJob(
            cast(UUID, row[0]),
            cast(UUID, row[1]),
            cast(UUID, row[2]),
            cast(str, row[3]),
            cast(str, row[4]),
            cast(UUID, row[5]),
            cast(ProcessingJobState, row[6]),
            cast(dict[str, Any] | None, result),
            cast(str | None, row[8]),
            cast(int, row[9]),
            cast(UUID, row[10]),
            cast(datetime, row[11]),
            cast(datetime | None, row[12]),
            cast(datetime | None, row[13]),
        )

    @staticmethod
    def _identity(row: tuple[Any, ...]) -> GeoNodeFederatedIdentity:
        if (
            len(row) != 12
            or row[2]
            not in {
                "dataset",
                "document",
                "map",
                "geoapp",
                "service",
            }
            or row[4] not in {"current", "withdrawn"}
        ):
            raise GeoNodeFederationStoreUnavailable("invalid federated identity row")
        return GeoNodeFederatedIdentity(
            cast(UUID, row[0]),
            cast(str, row[1]),
            cast(str, row[2]),
            cast(str, row[3]),
            cast(str, row[4]),
            cast(int, row[5]),
            cast(str, row[6]),
            cast(datetime | None, row[7]),
            cast(datetime, row[8]),
            cast(datetime, row[9]),
            cast(datetime, row[10]),
            cast(datetime | None, row[11]),
        )

    @staticmethod
    def _version(row: tuple[Any, ...]) -> GeoNodeFederatedIdentityVersion:
        if len(row) != 11 or row[4] not in {"added", "updated", "withdrawn"}:
            raise GeoNodeFederationStoreUnavailable("invalid federated version row")
        payload = row[8]
        if payload is not None and not isinstance(payload, dict):
            raise GeoNodeFederationStoreUnavailable("invalid federated version row")
        return GeoNodeFederatedIdentityVersion(
            cast(UUID, row[0]),
            cast(str, row[1]),
            cast(int, row[2]),
            cast(UUID, row[3]),
            cast(str, row[4]),
            cast(str, row[5]),
            cast(str, row[6]),
            cast(str, row[7]),
            cast(dict[str, Any] | None, payload),
            cast(datetime | None, row[9]),
            cast(datetime, row[10]),
        )


def geonode_harvest_request_checksum(source_id: UUID, configuration_checksum_sha256: str) -> str:
    return sha256(f"{source_id}\x1f{configuration_checksum_sha256}".encode()).hexdigest()
