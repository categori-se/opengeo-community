import asyncio
from collections import deque
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest

from opengeo_api.ingestion import Page
from opengeo_api.source_discoveries import (
    PostgresSourceDiscoveryRepository,
    SourceDiscoveryAccessDenied,
    SourceDiscoveryConflict,
    SourceDiscoveryNotFound,
    SourceDiscoveryRequest,
    source_discovery_checksum,
)
from opengeo_api.source_discovery import SourceDiscoverySpec
from opengeo_api.tenant_database import TenantContext

ORG_ID = UUID("10000000-0000-4000-8000-000000000262")
USER_ID = UUID("20000000-0000-4000-8000-000000000262")
DATASET_ID = UUID("30000000-0000-4000-8000-000000000262")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000262")
JOB_ID = UUID("86000000-0000-4000-8000-000000000262")
IDEMPOTENCY_KEY = UUID("88000000-0000-4000-8000-000000000262")
NOW = datetime(2026, 8, 30, 12, tzinfo=UTC)
SERVICE_URL = "https://example.test/arcgis/rest/services/open/FeatureServer"


class FakeTransaction:
    def __init__(self, rows: list[Any]) -> None:
        self.rows = deque(rows)
        self.calls: list[tuple[str, str, tuple[Any, ...]]] = []

    async def fetch_one(self, statement, parameters=()):
        self.calls.append(("one", statement, tuple(parameters)))
        return self.rows.popleft()

    async def fetch_all(self, statement, parameters=()):
        self.calls.append(("all", statement, tuple(parameters)))
        value = self.rows.popleft()
        assert isinstance(value, list)
        return value

    async def execute(self, statement, parameters=()):
        self.calls.append(("execute", statement, tuple(parameters)))
        return 1


class FakeExecutor:
    def __init__(self, transaction: FakeTransaction) -> None:
        self.transaction = transaction

    async def run(self, context, operation):
        assert context == TenantContext(USER_ID, ORG_ID)
        return await operation(self.transaction)

    async def fetch_one(self, context, statement, parameters=()):
        del context, statement, parameters
        raise AssertionError("direct query not expected")


def request() -> SourceDiscoveryRequest:
    return SourceDiscoveryRequest(
        "arcgis",
        "catalog",
        SERVICE_URL,
        None,
        IDEMPOTENCY_KEY,
    )


def job_row(*, checksum: str | None = None, state: str = "queued") -> tuple[Any, ...]:
    return (
        JOB_ID,
        PROJECT_ID,
        "arcgis",
        "catalog",
        SERVICE_URL,
        None,
        checksum or source_discovery_checksum(request().spec()),
        IDEMPOTENCY_KEY,
        state,
        None,
        None,
        0,
        USER_ID,
        NOW,
        None,
        None,
    )


def context() -> TenantContext:
    return TenantContext(USER_ID, ORG_ID)


def test_create_seals_exact_request_and_dispatches_only_after_insert() -> None:
    transaction = FakeTransaction([("member",), (PROJECT_ID, "editor"), (None,), None])
    repository = PostgresSourceDiscoveryRepository(FakeExecutor(transaction), now=lambda: NOW)

    submission = asyncio.run(
        repository.create(context(), PROJECT_ID, request(), "source-discovery-262")
    )

    assert submission.dispatch_required is True
    assert submission.job.request_checksum_sha256 == source_discovery_checksum(request().spec())
    insert = next(
        call
        for call in transaction.calls
        if call[0] == "execute" and "external_source_discovery_jobs" in call[1]
    )
    assert SERVICE_URL in insert[2]
    assert request().idempotency_key in insert[2]
    assert any("pg_advisory_xact_lock" in call[1] for call in transaction.calls)


def test_idempotent_retry_reuses_queued_job_and_rejects_changed_checksum() -> None:
    accepted = PostgresSourceDiscoveryRepository(
        FakeExecutor(FakeTransaction([("member",), (PROJECT_ID, "editor"), (None,), job_row()]))
    )
    submission = asyncio.run(
        accepted.create(context(), PROJECT_ID, request(), "source-discovery-retry")
    )
    assert submission.job.job_id == JOB_ID
    assert submission.dispatch_required is True

    rejected = PostgresSourceDiscoveryRepository(
        FakeExecutor(
            FakeTransaction(
                [
                    ("member",),
                    (PROJECT_ID, "editor"),
                    (None,),
                    job_row(checksum="f" * 64),
                ]
            )
        )
    )
    with pytest.raises(SourceDiscoveryConflict, match="idempotency"):
        asyncio.run(rejected.create(context(), PROJECT_ID, request(), "source-discovery-conflict"))


def test_viewer_cannot_create_and_read_is_project_scoped() -> None:
    denied = PostgresSourceDiscoveryRepository(
        FakeExecutor(FakeTransaction([("member",), (PROJECT_ID, "viewer")]))
    )
    with pytest.raises(SourceDiscoveryAccessDenied):
        asyncio.run(denied.create(context(), PROJECT_ID, request(), "source-discovery-denied"))

    transaction = FakeTransaction([("member",), (PROJECT_ID, "viewer"), [job_row()]])
    repository = PostgresSourceDiscoveryRepository(FakeExecutor(transaction))
    jobs = asyncio.run(repository.list(context(), PROJECT_ID, Page(25, 0)))
    assert jobs[0].job_id == JOB_ID
    list_call = next(call for call in transaction.calls if call[0] == "all")
    assert list_call[2][:2] == (ORG_ID, PROJECT_ID)


def test_checksum_separates_catalog_and_collection_without_logging_credentials() -> None:
    catalog = SourceDiscoverySpec("wfs", "catalog", "https://maps.example.test/wfs")
    collection = SourceDiscoverySpec(
        "wfs", "collection", "https://maps.example.test/wfs", "public:roads"
    )
    assert source_discovery_checksum(catalog) != source_discovery_checksum(collection)
    assert "maps.example.test" not in repr(catalog)


def test_refresh_candidate_binds_current_source_and_retained_completed_job() -> None:
    document = {"status": "retained", "body_base64": "e30="}
    transaction = FakeTransaction(
        [
            ("member",),
            (PROJECT_ID, "editor"),
            ("wfs", "https://example.org/wfs", "places", document, 3),
        ]
    )
    repository = PostgresSourceDiscoveryRepository(FakeExecutor(transaction))
    candidate = asyncio.run(repository.get_refresh_document(context(), USER_ID, PROJECT_ID, JOB_ID))
    assert candidate["source_revision"] == 3
    assert candidate["document"] == document
    assert candidate["dataset_id"] == str(USER_ID)
    assert candidate["project_id"] == str(PROJECT_ID)
    query = transaction.calls[-1]
    assert query[2] == (USER_ID, ORG_ID, PROJECT_ID, JOB_ID)
    for condition in [
        "job.state = 'completed'",
        "job.discovery_kind = 'collection'",
        "revision.source_url",
        "revision.configuration->>'type_name'",
        "document.document->>'status' IN ('retained', 'retained_object')",
        "ORDER BY version_number DESC",
    ]:
        assert condition in query[1]
    assert all(call[0] != "execute" for call in transaction.calls)


def test_refresh_candidate_rejects_missing_or_mismatched_response() -> None:
    transaction = FakeTransaction([("member",), (PROJECT_ID, "editor"), None])
    repository = PostgresSourceDiscoveryRepository(FakeExecutor(transaction))
    with pytest.raises(SourceDiscoveryConflict, match="metadata_refresh_binding_invalid"):
        asyncio.run(repository.get_refresh_document(context(), USER_ID, PROJECT_ID, JOB_ID))


def test_refresh_candidate_denies_reader_before_reading_document() -> None:
    transaction = FakeTransaction([("member",), (PROJECT_ID, "viewer")])
    repository = PostgresSourceDiscoveryRepository(FakeExecutor(transaction))
    with pytest.raises(SourceDiscoveryAccessDenied):
        asyncio.run(repository.get_refresh_document(context(), USER_ID, PROJECT_ID, JOB_ID))
    assert len(transaction.calls) == 2


def test_knowledge_source_reads_accepted_history_without_current_head_or_job_workspace_access():
    document = {
        "status": "retained_object",
        "byte_length": 32769,
        "sha256": "a" * 64,
        "retrieved_at": "2026-08-30T12:00:00Z",
        "body_base64": None,
        "object": {"version_id": "immutable-version"},
    }
    transaction = FakeTransaction(
        [(JOB_ID, PROJECT_ID, "wfs", "https://example.org/wfs", "places", document)]
    )
    repository = PostgresSourceDiscoveryRepository(FakeExecutor(transaction))
    result = asyncio.run(repository.get_knowledge_source_document(context(), DATASET_ID, JOB_ID))
    assert result == {
        "dataset_id": str(DATASET_ID),
        "project_id": str(PROJECT_ID),
        "discovery_job_id": str(JOB_ID),
        "source_type": "wfs",
        "service_url": "https://example.org/wfs",
        "collection_ref": "places",
        "document": document,
    }
    assert len(transaction.calls) == 1
    kind, statement, parameters = transaction.calls[0]
    assert kind == "one"
    assert parameters == (ORG_ID, JOB_ID, DATASET_ID)
    for condition in (
        "FROM app.dataset_knowledge_revisions knowledge",
        "jsonb_array_elements",
        "knowledge.organization_id = job.organization_id",
        "knowledge.dataset_id = %s",
        "document.project_id = job.project_id",
        "source.entry->'retainedResponse' = jsonb_build_object",
        "'datasetId', knowledge.dataset_id::text",
        "'projectId', job.project_id::text",
        "'discoveryJobId', job.id::text",
        "'sourceRevision', revision.version_number",
        "'byteLength', document.document->'byte_length'",
        "'sha256', document.document->>'sha256'",
        "source.entry->>'id' = 'urn:opengeo:discovery:'",
        "source.entry->>'mediaType' = CASE job.source_type",
        "source.entry->>'sourceUrl' = job.service_url",
        "source.entry->>'retrievedAt' = document.document->>'retrieved_at'",
        "job.result->'source_definition'->>'url' = revision.source_url",
        "job.collection_ref = revision.configuration->>'type_name'",
        "job.state = 'completed'",
        "job.discovery_kind = 'collection'",
    ):
        assert condition in statement
    # A historical accepted descriptor still points at its immutable source
    # revision, even if newer source or knowledge revisions exist now.
    assert "ORDER BY" not in statement
    assert "current_version" not in statement
    assert "app.external_sources" not in statement
    assert "app.project_memberships" not in statement
    assert "app.dataset_source_discoveries" not in statement


@pytest.mark.parametrize(
    "condition",
    [
        "source.entry->'retainedResponse' = jsonb_build_object",
        "source.entry->'retainedResponse'->'sourceRevision'",
        "AND EXISTS (",
        "document.document->>'status' IN ('retained', 'retained_object')",
    ],
    ids=["descriptor-mismatch", "historical-revision-mismatch", "not-accepted", "omitted-bytes"],
)
def test_knowledge_source_missing_exact_accepted_binding_is_unavailable(condition):
    # The fake transaction models an empty result from the binding query. These
    # checks cover its scope and missing-result behavior, not PostgreSQL execution.
    transaction = FakeTransaction([None])
    repository = PostgresSourceDiscoveryRepository(FakeExecutor(transaction))
    with pytest.raises(SourceDiscoveryNotFound, match="accepted knowledge source"):
        asyncio.run(repository.get_knowledge_source_document(context(), DATASET_ID, JOB_ID))
    assert len(transaction.calls) == 1
    assert condition in transaction.calls[0][1]
    assert transaction.calls[0][2] == (ORG_ID, JOB_ID, DATASET_ID)


def test_knowledge_source_lookup_keeps_other_dataset_and_job_parameter_scoped():
    other_dataset, other_job = UUID(int=301), UUID(int=861)
    transaction = FakeTransaction([None])
    repository = PostgresSourceDiscoveryRepository(FakeExecutor(transaction))
    with pytest.raises(SourceDiscoveryNotFound):
        asyncio.run(repository.get_knowledge_source_document(context(), other_dataset, other_job))
    _, statement, parameters = transaction.calls[0]
    assert parameters == (ORG_ID, other_job, other_dataset)
    assert "WHERE job.organization_id = %s AND job.id = %s" in statement
    assert "knowledge.dataset_id = %s" in statement
    assert "revision.dataset_id = knowledge.dataset_id" in statement
    assert all(call[0] != "execute" for call in transaction.calls)
