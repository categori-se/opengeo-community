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
from opengeo_api.ingestion import Page, ProcessingJobState
from opengeo_api.metadata_refresh import REFRESH_DOCUMENT_SQL
from opengeo_api.source_discovery import (
    DiscoveryKind,
    DiscoverySourceType,
    SourceDiscoverySpec,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)


class SourceDiscoveryStoreUnavailable(RuntimeError):
    pass


class SourceDiscoveryAccessDenied(RuntimeError):
    pass


class SourceDiscoveryNotFound(RuntimeError):
    pass


class SourceDiscoveryConflict(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class SourceDiscoveryRequest:
    source_type: DiscoverySourceType
    kind: DiscoveryKind
    service_url: str
    collection_ref: str | None
    idempotency_key: UUID

    def spec(self) -> SourceDiscoverySpec:
        return SourceDiscoverySpec(
            self.source_type,
            self.kind,
            self.service_url,
            self.collection_ref,
        )


@dataclass(frozen=True, slots=True)
class SourceDiscoveryJob:
    job_id: UUID
    project_id: UUID
    source_type: DiscoverySourceType
    kind: DiscoveryKind
    service_url: str
    collection_ref: str | None
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
class SourceDiscoverySubmission:
    job: SourceDiscoveryJob
    dispatch_required: bool


class SourceDiscoveryRepository(Protocol):
    async def create(
        self,
        context: TenantContext,
        project_id: UUID,
        request: SourceDiscoveryRequest,
        request_id: str,
    ) -> SourceDiscoverySubmission: ...

    async def list(
        self,
        context: TenantContext,
        project_id: UUID,
        page: Page,
    ) -> tuple[SourceDiscoveryJob, ...]: ...

    async def get_refresh_document(
        self, context: TenantContext, dataset_id: UUID, project_id: UUID, job_id: UUID
    ) -> dict[str, Any]: ...

    async def get_dataset_document(
        self, context: TenantContext, dataset_id: UUID
    ) -> dict[str, Any]: ...

    async def get_knowledge_source_document(
        self, context: TenantContext, dataset_id: UUID, job_id: UUID
    ) -> dict[str, Any]: ...

    async def get(
        self,
        context: TenantContext,
        project_id: UUID,
        job_id: UUID,
    ) -> SourceDiscoveryJob: ...

    async def cancel(
        self,
        context: TenantContext,
        project_id: UUID,
        job_id: UUID,
        request_id: str,
    ) -> SourceDiscoveryJob: ...


ResultT = TypeVar("ResultT")


class PostgresSourceDiscoveryRepository:
    def __init__(
        self,
        executor: TenantTransactionExecutor,
        *,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._executor = executor
        self._now = now or (lambda: datetime.now(UTC))

    async def create(
        self,
        context: TenantContext,
        project_id: UUID,
        request: SourceDiscoveryRequest,
        request_id: str,
    ) -> SourceDiscoverySubmission:
        spec = request.spec()
        checksum = source_discovery_checksum(spec)

        async def operation(transaction: TenantTransaction) -> SourceDiscoverySubmission:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_DATASETS_MANAGE, roles)
            await transaction.fetch_one(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                (
                    "source-discovery:idempotency:"
                    f"{context.organization_id}:{project_id}:{request.idempotency_key}",
                ),
            )
            existing = await transaction.fetch_one(
                f"""
                {self._select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND job.idempotency_key = %s
                """,
                (context.organization_id, project_id, request.idempotency_key),
            )
            if existing is not None:
                job = self._job(existing)
                if job.request_checksum_sha256 != checksum:
                    raise SourceDiscoveryConflict("source_discovery_idempotency_conflict")
                return SourceDiscoverySubmission(job, job.state == "queued")

            job_id = uuid4()
            created_at = self._now().astimezone(UTC)
            await transaction.execute(
                """
                INSERT INTO app.external_source_discovery_jobs
                  (id, organization_id, project_id, source_type,
                   discovery_kind, service_url, collection_ref,
                   request_checksum_sha256, idempotency_key, request_id,
                   created_by, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    job_id,
                    context.organization_id,
                    project_id,
                    spec.source_type,
                    spec.kind,
                    spec.service_url,
                    spec.collection_ref,
                    checksum,
                    request.idempotency_key,
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
                VALUES (%s, %s, %s, 'dataset.source.discovery.requested',
                        'project', %s, %s, %s)
                """,
                (
                    context.organization_id,
                    context.user_id,
                    project_id,
                    project_id,
                    request_id,
                    Jsonb(
                        {
                            "discovery_job_id": str(job_id),
                            "source_type": spec.source_type,
                            "discovery_kind": spec.kind,
                            "collection_ref": spec.collection_ref,
                            "request_checksum_sha256": checksum,
                        }
                    ),
                ),
            )
            return SourceDiscoverySubmission(
                SourceDiscoveryJob(
                    job_id=job_id,
                    project_id=project_id,
                    source_type=spec.source_type,
                    kind=spec.kind,
                    service_url=spec.service_url,
                    collection_ref=spec.collection_ref,
                    request_checksum_sha256=checksum,
                    idempotency_key=request.idempotency_key,
                    state="queued",
                    result=None,
                    error_code=None,
                    attempt_count=0,
                    created_by=context.user_id,
                    created_at=created_at,
                    started_at=None,
                    finished_at=None,
                ),
                True,
            )

        return await self._run(context, operation)

    async def list(
        self,
        context: TenantContext,
        project_id: UUID,
        page: Page,
    ) -> tuple[SourceDiscoveryJob, ...]:
        async def operation(transaction: TenantTransaction) -> tuple[SourceDiscoveryJob, ...]:
            self._require(
                Action.PROJECT_READ,
                await self._project_roles(transaction, context, project_id),
            )
            rows = await transaction.fetch_all(
                f"""
                {self._select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                ORDER BY job.created_at DESC, job.id
                LIMIT %s OFFSET %s
                """,
                (context.organization_id, project_id, page.limit, page.offset),
            )
            return tuple(self._job(row) for row in rows)

        return await self._run(context, operation)

    async def get_refresh_document(
        self, context: TenantContext, dataset_id: UUID, project_id: UUID, job_id: UUID
    ) -> dict[str, Any]:
        # The route checks Layer edit access; independently require access to the job workspace.
        async def operation(transaction: TenantTransaction) -> dict[str, Any]:
            self._require(
                Action.PROJECT_DATASETS_MANAGE,
                await self._project_roles(transaction, context, project_id),
            )
            row = await transaction.fetch_one(
                REFRESH_DOCUMENT_SQL,
                (dataset_id, context.organization_id, project_id, job_id),
            )
            if row is None:
                raise SourceDiscoveryConflict("metadata_refresh_binding_invalid")
            return {
                "dataset_id": str(dataset_id),
                "project_id": str(project_id),
                "discovery_job_id": str(job_id),
                "source_type": row[0],
                "service_url": row[1],
                "collection_ref": row[2],
                "document": row[3],
                "source_revision": row[4],
            }

        return await self._run(context, operation)

    async def get_knowledge_source_document(
        self, context: TenantContext, dataset_id: UUID, job_id: UUID
    ) -> dict[str, Any]:
        # Caller authorizes current Layer read before and after reading bytes.
        # Accepted Layer knowledge deliberately retains this historical response;
        # it does not depend on current access to the discovery job's workspace.
        async def operation(transaction: TenantTransaction) -> dict[str, Any]:
            row = await transaction.fetch_one(
                """
                SELECT job.id, job.project_id, job.source_type, job.service_url,
                       job.collection_ref, document.document
                FROM app.external_source_discovery_jobs job
                JOIN app.source_discovery_documents document
                  ON document.organization_id = job.organization_id
                 AND document.discovery_job_id = job.id
                 AND document.project_id = job.project_id
                WHERE job.organization_id = %s AND job.id = %s
                  AND job.state = 'completed' AND job.discovery_kind = 'collection'
                  AND document.document->>'status' IN ('retained', 'retained_object')
                  AND EXISTS (
                    SELECT 1
                    FROM app.dataset_knowledge_revisions knowledge
                    CROSS JOIN LATERAL jsonb_array_elements(
                      CASE WHEN jsonb_typeof(knowledge.document #> '{metadata,source}') = 'array'
                        THEN knowledge.document #> '{metadata,source}'
                        ELSE '[]'::jsonb END
                    ) source(entry)
                    JOIN app.external_source_revisions revision
                      ON revision.organization_id = knowledge.organization_id
                     AND revision.dataset_id = knowledge.dataset_id
                     AND source.entry->'retainedResponse'->'sourceRevision'
                         = to_jsonb(revision.version_number)
                    WHERE knowledge.organization_id = job.organization_id
                      AND knowledge.dataset_id = %s
                      AND source.entry ?& ARRAY[
                        'id','retainedResponse','mediaType','sourceUrl','retrievedAt']
                      AND source.entry - ARRAY[
                        'id','retainedResponse','mediaType','sourceUrl','retrievedAt'] = '{}'::jsonb
                      AND source.entry->'retainedResponse' = jsonb_build_object(
                        'datasetId', knowledge.dataset_id::text,
                        'projectId', job.project_id::text,
                        'discoveryJobId', job.id::text,
                        'sourceRevision', revision.version_number,
                        'byteLength', document.document->'byte_length',
                        'sha256', document.document->>'sha256')
                      AND source.entry->>'id' = 'urn:opengeo:discovery:'
                        || job.id::text || ':sha256:' || (document.document->>'sha256')
                      AND source.entry->>'mediaType' = CASE job.source_type
                        WHEN 'arcgis' THEN 'application/json'
                        WHEN 'wfs' THEN 'application/xml' END
                      AND source.entry->>'sourceUrl' = job.service_url
                      AND source.entry->>'retrievedAt' = document.document->>'retrieved_at'
                      AND job.result->'source_definition'->>'url' = revision.source_url
                      AND (job.source_type <> 'wfs'
                           OR job.collection_ref = revision.configuration->>'type_name')
                  )
                """,
                (context.organization_id, job_id, dataset_id),
            )
            if row is None:
                raise SourceDiscoveryNotFound("accepted knowledge source document not found")
            return {
                "dataset_id": str(dataset_id),
                "project_id": str(row[1]),
                "discovery_job_id": str(row[0]),
                "source_type": row[2],
                "service_url": row[3],
                "collection_ref": row[4],
                "document": row[5],
            }

        return await self._run(context, operation)

    async def get_dataset_document(
        self, context: TenantContext, dataset_id: UUID
    ) -> dict[str, Any]:
        # Caller must authorize the dataset. Linked public provider metadata is
        # deliberately shared with that dataset during source registration.
        async def operation(transaction: TenantTransaction) -> dict[str, Any]:
            row = await transaction.fetch_one(
                """
                SELECT link.discovery_job_id, link.source_type, link.service_url,
                       link.collection_ref,
                       document.document
                FROM app.dataset_source_discoveries link
                LEFT JOIN app.source_discovery_documents document
                  ON document.organization_id = link.organization_id
                 AND document.discovery_job_id = link.discovery_job_id
                WHERE link.organization_id = %s AND link.dataset_id = %s
                """,
                (context.organization_id, dataset_id),
            )
            if row is None:
                raise SourceDiscoveryNotFound("dataset discovery metadata not found")
            return {
                "dataset_id": str(dataset_id),
                "discovery_job_id": str(row[0]),
                "source_type": row[1],
                "service_url": row[2],
                "collection_ref": row[3],
                "document": row[4],
            }

        return await self._run(context, operation)

    async def get(
        self,
        context: TenantContext,
        project_id: UUID,
        job_id: UUID,
    ) -> SourceDiscoveryJob:
        async def operation(transaction: TenantTransaction) -> SourceDiscoveryJob:
            self._require(
                Action.PROJECT_READ,
                await self._project_roles(transaction, context, project_id),
            )
            return await self._load(transaction, context, project_id, job_id)

        return await self._run(context, operation)

    async def cancel(
        self,
        context: TenantContext,
        project_id: UUID,
        job_id: UUID,
        request_id: str,
    ) -> SourceDiscoveryJob:
        async def operation(transaction: TenantTransaction) -> SourceDiscoveryJob:
            self._require(
                Action.PROJECT_DATASETS_MANAGE,
                await self._project_roles(transaction, context, project_id),
            )
            job = await self._load(transaction, context, project_id, job_id)
            if job.state != "queued":
                raise SourceDiscoveryConflict("source_discovery_not_cancellable")
            result = await transaction.fetch_one(
                """
                SELECT app.cancel_external_source_discovery(%s, %s, %s, %s, %s)
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
                raise SourceDiscoveryConflict("source_discovery_cancel_conflict")
            return await self._load(transaction, context, project_id, job_id)

        return await self._run(context, operation)

    async def _load(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        job_id: UUID,
    ) -> SourceDiscoveryJob:
        row = await transaction.fetch_one(
            f"""
            {self._select()}
            WHERE job.organization_id = %s AND job.project_id = %s AND job.id = %s
            """,
            (context.organization_id, project_id, job_id),
        )
        if row is None:
            raise SourceDiscoveryNotFound("source discovery does not exist")
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
            raise SourceDiscoveryAccessDenied("organization membership required")
        project = await transaction.fetch_one(
            """
            SELECT project.id, app.effective_project_role(project.id, %s)::text
            FROM app.projects project
            WHERE project.organization_id = %s AND project.id = %s
            """,
            (context.user_id, context.organization_id, project_id),
        )
        if project is None:
            raise SourceDiscoveryNotFound("project does not exist")
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
            raise SourceDiscoveryConflict("source_discovery_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise SourceDiscoveryStoreUnavailable("source discovery operation failed") from error

    @staticmethod
    def _require(action: Action, roles: Roles) -> None:
        try:
            authorize(action, roles)
        except AuthorizationDenied as error:
            raise SourceDiscoveryAccessDenied("action forbidden") from error

    @staticmethod
    def _select() -> str:
        return """
            SELECT job.id, job.project_id, job.source_type,
                   job.discovery_kind, job.service_url, job.collection_ref,
                   job.request_checksum_sha256, job.idempotency_key,
                   job.state::text, job.result, job.error_code,
                   job.attempt_count, job.created_by, job.created_at,
                   job.started_at, job.finished_at
            FROM app.external_source_discovery_jobs job
        """

    @staticmethod
    def _job(row: tuple[Any, ...]) -> SourceDiscoveryJob:
        if len(row) != 16:
            raise SourceDiscoveryStoreUnavailable("invalid source discovery row")
        source_type = row[2]
        kind = row[3]
        state = row[8]
        result = row[9]
        if (
            source_type not in {"arcgis", "wfs"}
            or kind not in {"catalog", "collection"}
            or state not in {"queued", "running", "completed", "failed", "cancelled"}
            or (result is not None and not isinstance(result, dict))
        ):
            raise SourceDiscoveryStoreUnavailable("invalid source discovery row")
        return SourceDiscoveryJob(
            job_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            source_type=cast(DiscoverySourceType, source_type),
            kind=cast(DiscoveryKind, kind),
            service_url=cast(str, row[4]),
            collection_ref=cast(str | None, row[5]),
            request_checksum_sha256=cast(str, row[6]),
            idempotency_key=cast(UUID, row[7]),
            state=cast(ProcessingJobState, state),
            result=cast(dict[str, Any] | None, result),
            error_code=cast(str | None, row[10]),
            attempt_count=cast(int, row[11]),
            created_by=cast(UUID, row[12]),
            created_at=cast(datetime, row[13]),
            started_at=cast(datetime | None, row[14]),
            finished_at=cast(datetime | None, row[15]),
        )


def source_discovery_checksum(spec: SourceDiscoverySpec) -> str:
    value = "\x1f".join((spec.source_type, spec.kind, spec.service_url, spec.collection_ref or ""))
    return sha256(value.encode("utf-8")).hexdigest()
