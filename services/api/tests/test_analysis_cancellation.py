import asyncio
from uuid import UUID

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from opengeo_api.auth_models import AuthSession, OrganizationMembership, Principal
from opengeo_api.feature_routes import (
    current_session,
    preview_until_disconnected,
    repository_from_request,
    router,
)
from opengeo_api.features import (
    FeatureAccessDenied,
    FeatureInvalid,
    FeatureStoreUnavailable,
    PostgresFeatureRepository,
)
from opengeo_api.tenant_database import TenantContext
from opengeo_api.vector_analysis import (
    ANALYSIS_QUERY_MARKER,
    AnalysisRequest,
    analysis_application_name,
)

CONTEXT = TenantContext(UUID(int=1), UUID(int=2))
PROJECT = UUID(int=3)
DATASET = UUID(int=4)
PREVIEW = UUID(int=5)


def request(disconnected=False):
    async def receive():
        if disconnected:
            return {"type": "http.disconnect"}
        await asyncio.Event().wait()

    return Request({"type": "http", "method": "POST", "path": "/analysis-preview"}, receive)


def test_completed_preview_and_validation_errors_are_preserved():
    async def run():
        async def success():
            return {"features": []}

        assert await preview_until_disconnected(request(), success()) == {"features": []}

        async def invalid():
            raise FeatureInvalid("invalid fixture")

        with pytest.raises(HTTPException) as error:
            await preview_until_disconnected(request(), invalid())
        assert error.value.status_code == 422

    asyncio.run(run())


def test_disconnected_request_cancels_and_drains_preview():
    async def run():
        finished = asyncio.Event()

        async def preview():
            try:
                await asyncio.Event().wait()
            finally:
                finished.set()

        with pytest.raises(HTTPException) as error:
            await asyncio.wait_for(preview_until_disconnected(request(True), preview()), 1)
        assert error.value.status_code == 499
        assert finished.is_set()

    asyncio.run(run())


def test_parent_cancellation_leaves_no_preview_task():
    async def run():
        started, finished = asyncio.Event(), asyncio.Event()

        async def preview():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                finished.set()

        task = asyncio.create_task(preview_until_disconnected(request(), preview()))
        await asyncio.wait_for(started.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 1)
        assert finished.is_set()

    asyncio.run(run())


def test_preview_marker_binds_every_context_identity_without_truncation():
    values = (CONTEXT.organization_id, CONTEXT.user_id, PROJECT, DATASET, PREVIEW)
    marker = analysis_application_name(*values)
    assert len(marker.encode("ascii")) < 63
    assert marker == analysis_application_name(*values)
    for index in range(len(values)):
        changed = list(values)
        changed[index] = UUID(int=100)
        assert analysis_application_name(*changed) != marker


class CancellationTransaction:
    def __init__(self, *, allowed=True, requested=True):
        self.allowed = allowed
        self.requested = requested
        self.calls = []

    async def fetch_one(self, statement, parameters=()):
        self.calls.append((statement, tuple(parameters)))
        if "organization_memberships" in statement:
            return ("member", "viewer" if self.allowed else None, None, False, "active", "geojson")
        if "pg_cancel_backend" in statement:
            return (self.requested,)
        return (
            {"source_generation": 1, "target_generation": 1, "allowed": True},
            {"count": 0, "points": 0},
            0,
            [],
        )

    async def execute(self, statement, parameters=()):
        self.calls.append((statement, tuple(parameters)))
        return 0


class CancellationExecutor:
    def __init__(self, transaction):
        self.transaction = transaction

    async def run(self, context, operation):
        return await operation(self.transaction)


@pytest.mark.parametrize("requested", [True, False])
def test_explicit_cancel_authorizes_before_targeting_only_marked_active_sql(requested):
    transaction = CancellationTransaction(requested=requested)
    repository = PostgresFeatureRepository(CancellationExecutor(transaction))
    assert (
        asyncio.run(repository.cancel_analysis_preview(CONTEXT, PROJECT, DATASET, PREVIEW))
        is requested
    )
    assert len(transaction.calls) == 2
    sql, parameters = transaction.calls[1]
    assert "usename = current_user" in sql and "datname = current_database()" in sql
    assert "pid <> pg_backend_pid()" in sql and "state = 'active'" in sql
    assert "application_name = %s AND starts_with(query, %s)" in sql
    assert parameters == (
        analysis_application_name(
            CONTEXT.organization_id, CONTEXT.user_id, PROJECT, DATASET, PREVIEW
        ),
        ANALYSIS_QUERY_MARKER,
    )


def test_explicit_cancel_without_read_authority_never_signals_backend():
    transaction = CancellationTransaction(allowed=False)
    repository = PostgresFeatureRepository(CancellationExecutor(transaction))
    with pytest.raises(FeatureAccessDenied):
        asyncio.run(repository.cancel_analysis_preview(CONTEXT, PROJECT, DATASET, PREVIEW))
    assert len(transaction.calls) == 1


@pytest.mark.parametrize("invalid", [None, 1])
def test_invalid_cancel_receipt_does_not_claim_no_active_query(invalid):
    transaction = CancellationTransaction(requested=invalid)
    repository = PostgresFeatureRepository(CancellationExecutor(transaction))
    with pytest.raises(FeatureStoreUnavailable):
        asyncio.run(repository.cancel_analysis_preview(CONTEXT, PROJECT, DATASET, PREVIEW))


def test_optional_preview_id_marks_exact_query_and_legacy_remains_uncancellable():
    for preview_id in (None, PREVIEW):
        transaction = CancellationTransaction()
        repository = PostgresFeatureRepository(CancellationExecutor(transaction))
        result = asyncio.run(
            repository.preview_analysis(
                CONTEXT, PROJECT, DATASET, AnalysisRequest("centroid", 1, preview_id=preview_id)
            )
        )
        markers = [parameters for sql, parameters in transaction.calls if "application_name" in sql]
        assert len(markers) == (1 if preview_id else 0)
        assert transaction.calls[-1][0].startswith(ANALYSIS_QUERY_MARKER)
        assert (
            sum("statement_timeout" in sql and "5000ms" in sql for sql, _ in transaction.calls) == 1
        )
        if preview_id:
            assert result["opengeo:analysis"]["previewId"] == str(PREVIEW)
        else:
            assert "previewId" not in result["opengeo:analysis"]


def test_explicit_cancel_route_uses_session_context_and_truthful_private_result():
    membership = OrganizationMembership(CONTEXT.organization_id, "member")
    session = AuthSession(
        Principal(CONTEXT.user_id, "fixture", "fixture@example.test", "Fixture", (membership,)),
        membership,
    )
    calls = []

    class Repository:
        requested = True

        async def cancel_analysis_preview(self, context, project_id, dataset_id, preview_id):
            calls.append((context, project_id, dataset_id, preview_id))
            return self.requested

    repository = Repository()
    application = FastAPI()
    application.include_router(router)
    application.dependency_overrides[current_session] = lambda: session
    application.dependency_overrides[repository_from_request] = lambda: repository
    path = f"/projects/{PROJECT}/datasets/{DATASET}/analysis-preview/{PREVIEW}/cancel"
    with TestClient(application) as client:
        for requested, state in ((True, "cancellation_requested"), (False, "not_running")):
            repository.requested = requested
            response = client.post(path)
            assert response.status_code == 200
            assert response.json() == {"preview_id": str(PREVIEW), "state": state}
            assert response.headers["cache-control"] == "private, no-store"
        invalid = client.post(path.replace(str(PREVIEW), "not-a-uuid"))
        assert invalid.status_code == 422
    assert calls == [(CONTEXT, PROJECT, DATASET, PREVIEW)] * 2
