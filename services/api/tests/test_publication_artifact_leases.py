import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import pytest

from opengeo_api.authorization import Roles
from opengeo_api.observable_sources import (
    ObservableSourceConflict,
    PostgresObservableSourceRepository,
)
from opengeo_api.publication_artifact_leases import resolve_artifact_lease
from opengeo_api.tenant_database import TenantContext

ORG, USER, JOB, TOKEN, PROJECT, SOURCE, INPUT = (UUID(int=n) for n in range(1, 8))


@pytest.mark.parametrize(
    "enabled,lease", [(False, None), (True, None), (True, (PROJECT, SOURCE, INPUT))]
)
def test_lease_authentication_precedes_every_source_check(enabled, lease, monkeypatch):
    from opengeo_api import publication_artifact_leases as module

    snapshot = {
        "manifest": {
            "artifacts": [
                {
                    "path": "map.html",
                    "artifactId": str(INPUT),
                    "outputObjectId": str(JOB),
                    "output": {"sizeBytes": 4, "checksumSha256": "a" * 64},
                }
            ]
        }
    }
    checked = AsyncMock(return_value=snapshot)
    monkeypatch.setattr(module, "read_inputs_in_transaction", checked)
    transaction = SimpleNamespace(
        fetch_one=AsyncMock(
            side_effect=[lease, ("bucket", "key", "version", "etag", "text/html", 4, "a" * 64)]
        )
    )

    async def run(context, operation):
        return await operation(transaction)

    repo = PostgresObservableSourceRepository(SimpleNamespace(run=run), artifact_builds=enabled)
    repo._project_roles = AsyncMock(return_value=Roles(organization="admin"))
    repo._load_build_job = AsyncMock(
        return_value=SimpleNamespace(request={}, source_revision_id=SOURCE)
    )
    monkeypatch.setattr(module, "reauthorize_artifact_request", AsyncMock())
    operation = resolve_artifact_lease(repo, TenantContext(USER, ORG), JOB, TOKEN)
    if not enabled or not lease:
        with pytest.raises(ObservableSourceConflict):
            asyncio.run(operation)
        checked.assert_not_awaited()
        repo._project_roles.assert_not_awaited()
        assert transaction.fetch_one.await_count == int(enabled)
    else:
        files = asyncio.run(operation)
        assert files[0]["path"] == "map.html" and files[0]["s3VersionId"] == "version"
        assert checked.await_args.args[2] == TenantContext(USER, ORG)
        from opengeo_api.rds_data import compile_data_api_statement

        sql, params = transaction.fetch_one.await_args.args
        _, encoded = compile_data_api_statement(sql, params)
        assert [parameter.get("typeHint") for parameter in encoded] == ["UUID"] * 3
    if enabled:
        assert transaction.fetch_one.await_args_list[0].args[1] == (ORG, USER, JOB, TOKEN)


def test_lease_route_uses_token_authority_without_requiring_an_end_user_session():
    from test_observable_source_routes import MemoryObservableSourceRepository, client

    class Repository(MemoryObservableSourceRepository):
        async def resolve_artifact_lease(self, context, job, token):
            assert context == TenantContext(USER, ORG) and job == JOB and token == TOKEN
            raise ObservableSourceConflict("publication_artifact_lease_unavailable")

    response = client(Repository()).post(
        f"/observable-build-leases/{JOB}/artifact-inputs",
        json={"organization_id": str(ORG), "user_id": str(USER), "coordinator_token": str(TOKEN)},
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "publication_artifact_lease_unavailable"


@pytest.mark.parametrize(
    "case,expected",
    [
        ("source", None),
        ("empty-artifact", "observable_localized_artifact_unsupported"),
        ("data", "observable_distribution_approval_required"),
        ("referenced", "observable_referenced_file_publication_unavailable"),
        ("empty-artifact-data", "observable_localized_artifact_unsupported"),
        ("html-artifact", "observable_localized_artifact_unsupported"),
        ("legacy-empty", "observable_distribution_approval_required"),
        ("approval-mismatch", "observable_distribution_approval_input_mismatch"),
        ("approval-valid", None),
    ],
)
def test_native_localization_reauthorization_does_not_skip_captured_input_authority(
    case, expected, monkeypatch
):
    from opengeo_api import observable_distribution_approvals
    from opengeo_api import publication_artifact_leases as module

    artifacts = "artifact" in case
    request = {
        "schemaVersion": "opengeo.observable-build-request.3.0.0"
        if case == "legacy-empty"
        else "opengeo.observable-build-request.4.0.0",
        "purpose": "release_candidate",
        "outputProfile": "default-32m",
        "compilerImageDigest": "sha256:" + "c" * 64,
    }
    if artifacts:
        request["artifactInputsChecksumSha256"] = "a" * 64
    if case in {"approval-mismatch", "approval-valid"}:
        request.update(
            distributionApprovalId=str(INPUT),
            distributionApprovalChecksumSha256=("c" if case == "approval-valid" else "b") * 64,
        )
    approval_read = AsyncMock(return_value={"manifest_checksum_sha256": "c" * 64})
    monkeypatch.setattr(
        observable_distribution_approvals, "read_distribution_approval", approval_read
    )
    input_read = AsyncMock(
        return_value={"manifest": {"artifacts": [{}] if case == "html-artifact" else []}}
    )
    monkeypatch.setattr(module, "read_inputs_in_transaction", input_read)
    transaction = SimpleNamespace(fetch_one=AsyncMock(return_value=(INPUT,)))
    repo = PostgresObservableSourceRepository(SimpleNamespace())
    repo._load_revision = AsyncMock(
        return_value=SimpleNamespace(
            manifest={
                "dataAttachments": [{}] if case in {"data", "empty-artifact-data"} else [],
                "referencedFiles": [{}] if case == "referenced" else [],
            }
        )
    )
    operation = module.reauthorize_artifact_request(
        repo, transaction, TenantContext(USER, ORG), PROJECT, SOURCE, JOB, request
    )
    if expected:
        with pytest.raises(ObservableSourceConflict, match=expected):
            asyncio.run(operation)
    else:
        asyncio.run(operation)
    assert approval_read.await_count == int(case in {"approval-mismatch", "approval-valid"})
    input_read.assert_not_awaited()
    transaction.fetch_one.assert_not_awaited()
