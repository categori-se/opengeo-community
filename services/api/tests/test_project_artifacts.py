import asyncio
from hashlib import sha256

import pytest

from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.rendering import RenderAccessDenied, RenderConflict
from test_rendering import JOB_ID, PROJECT_ID, RESOURCE_ID, RESOURCE_VERSION_ID, job_row, repository
from test_saved_map_jobs import CONTEXT, ROLES
from test_saved_map_publication import Transaction, sealed_rows


def artifact_transaction(state="completed", source_roles=ROLES):
    binding, rows = sealed_rows()
    snapshot = {"resource_version_id": str(RESOURCE_VERSION_ID)}
    return Transaction([ROLES, (*job_row(state), snapshot), binding, source_roles, ROLES], [rows])


def read(transaction):
    return asyncio.run(
        repository(transaction).get_project_artifact(CONTEXT, PROJECT_ID, RESOURCE_ID, JOB_ID)
    )


def test_exact_artifact_manifest_is_stable_read_only_and_does_not_inherit_rights():
    transaction = artifact_transaction()
    result = read(transaction)
    assert result == read(artifact_transaction())
    digest = result.pop("manifestChecksumSha256")
    assert digest == sha256(canonical_json_bytes(result)).hexdigest()
    assert result["project"]["version"] == 3
    assert result["artifactId"] == str(JOB_ID)
    assert result["output"]["checksumSha256"] == "e" * 64
    assert len(result["dependencies"]) == 4  # ordered repeated drawing passes survive
    assert result["dependencies"][0]["recordedRights"] == {
        "scope": "source-resource-version",
        "license": "CC-BY-4.0",
        "attribution": "Survey team",
        "distributionRights": None,
    }
    assert result["rights"] == {"license": None, "redistributionAllowed": None}
    assert not transaction.executions
    assert not transaction.one and not transaction.all_rows
    assert "bucket" not in str(result) and "s3_version" not in str(result)


@pytest.mark.parametrize("state", ["queued", "running", "failed", "cancelled"])
def test_unfinished_outputs_have_no_artifact_manifest(state):
    transaction = artifact_transaction(state)
    with pytest.raises(RenderConflict, match="artifact_output_unavailable"):
        read(transaction)
    assert not transaction.executions


def test_source_revocation_blocks_manifest_even_when_output_is_completed():
    transaction = artifact_transaction(source_roles=("member", None, None, False))
    with pytest.raises(RenderAccessDenied):
        read(transaction)
    assert not transaction.executions


def test_manifest_route_uses_current_session_and_disables_http_caching():
    from test_render_routes import (
        JOB_ID as ROUTE_JOB,
    )
    from test_render_routes import (
        ORG_ID,
        FakeRepository,
        client,
        headers,
    )
    from test_render_routes import (
        PROJECT_ID as ROUTE_PROJECT,
    )
    from test_render_routes import (
        RESOURCE_ID as ROUTE_RESOURCE,
    )

    class ArtifactRepository(FakeRepository):
        async def get_project_artifact(self, context, project_id, resource_id, job_id):
            assert context.organization_id == ORG_ID
            assert (project_id, resource_id, job_id) == (ROUTE_PROJECT, ROUTE_RESOURCE, ROUTE_JOB)
            return {"artifactId": str(job_id)}

    response = client(ArtifactRepository()).get(
        f"/projects/{ROUTE_PROJECT}/resources/{ROUTE_RESOURCE}/renders/{ROUTE_JOB}/artifact-manifest",
        headers=headers(),
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"artifactId": str(ROUTE_JOB)}


def test_artifact_preserves_authorized_exact_style_dependencies():
    from test_saved_map_publication import style_bound_rows

    binding, rows, style, reference = style_bound_rows()
    snapshot = {"resource_version_id": str(RESOURCE_VERSION_ID)}
    transaction = Transaction(
        [ROLES, (*job_row("completed"), snapshot), binding, ROLES, style, ROLES, ROLES],
        [rows],
    )
    manifest = read(transaction)
    dependency = manifest["styleDependencies"][0]
    assert dependency["reference"] == reference
    assert dependency["mode"] == "pinned"
    assert dependency["recordedRights"] == {"license": None, "redistributionAllowed": None}
    assert manifest["build"]["recipeChecksumSha256"] == binding[3]
    assert not transaction.executions and not transaction.one


def registration_transaction(*, revision=0, existing=None):
    binding, rows = sealed_rows()
    snapshot = {"resource_version_id": str(RESOURCE_VERSION_ID)}
    return Transaction(
        [
            ROLES,
            ROLES,
            (*job_row("completed"), snapshot),
            binding,
            ROLES,
            ROLES,
            (RESOURCE_VERSION_ID, revision, None),
            existing,
            (1,),
        ],
        [rows],
    )


def test_register_edition_preserves_current_and_reuses_exact_job_without_new_version():
    transaction = registration_transaction()
    result = asyncio.run(
        repository(transaction).register_artifact_edition(
            CONTEXT, PROJECT_ID, RESOURCE_ID, JOB_ID, 0
        )
    )
    assert result == {
        "id": str(RESOURCE_VERSION_ID),
        "revision": 1,
        "current_version_number": None,
        "version_number": 1,
        "reused": False,
    }
    assert len(transaction.executions) == 3
    manifest = transaction.executions[1][1][4].obj
    retry = registration_transaction(revision=3, existing=(1, manifest["manifestChecksumSha256"]))
    reused = asyncio.run(
        repository(retry).register_artifact_edition(CONTEXT, PROJECT_ID, RESOURCE_ID, JOB_ID, 0)
    )
    assert reused["reused"] and reused["revision"] == 3
    assert len(retry.executions) == 1  # conflict-safe identity insert only; no edition/head write


def test_stale_registration_and_pointer_updates_do_not_overwrite_newer_state():
    transaction = registration_transaction(revision=2)
    with pytest.raises(RenderConflict, match="artifact_revision_conflict"):
        asyncio.run(
            repository(transaction).register_artifact_edition(
                CONTEXT, PROJECT_ID, RESOURCE_ID, JOB_ID, 0
            )
        )
    assert len(transaction.executions) == 1  # transaction runner rolls this back
    transaction = Transaction([ROLES, (RESOURCE_VERSION_ID, 2, 1)])
    with pytest.raises(RenderConflict, match="artifact_revision_conflict"):
        asyncio.run(
            repository(transaction).select_artifact_current(CONTEXT, PROJECT_ID, RESOURCE_ID, 2, 1)
        )
    assert not transaction.executions


def test_current_selection_and_pinned_reads_revalidate_existing_output():
    manifest = read(artifact_transaction())

    def txn():
        binding, rows = sealed_rows()
        snapshot = {"resource_version_id": str(RESOURCE_VERSION_ID)}
        return Transaction(
            [
                ROLES,
                (RESOURCE_VERSION_ID, 1, None),
                (JOB_ID, manifest, manifest["manifestChecksumSha256"]),
                ROLES,
                (*job_row("completed"), snapshot),
                binding,
                ROLES,
                ROLES,
            ],
            [rows],
        )

    transaction = txn()
    result = asyncio.run(
        repository(transaction).select_artifact_current(CONTEXT, PROJECT_ID, RESOURCE_ID, 1, 1)
    )
    assert result["revision"] == 2 and result["current_version_number"] == 1
    assert len(transaction.executions) == 1
    pinned = txn()
    result = asyncio.run(
        repository(pinned).read_artifact_edition(CONTEXT, PROJECT_ID, RESOURCE_ID, 1)
    )
    assert result["manifest"] == manifest and result["current_version_number"] is None
    assert not pinned.executions


def test_metadata_inspection_can_recover_pointer_without_granting_output_access():
    transaction = Transaction([ROLES, (RESOURCE_VERSION_ID, 4, 2)], [[(2, JOB_ID)]])
    result = asyncio.run(
        repository(transaction).read_artifact_edition(
            CONTEXT, PROJECT_ID, RESOURCE_ID, None, metadata_only=True
        )
    )
    assert result["revision"] == 4 and result["current_version_number"] == 2
    assert result["manifest"] is None and result["version_number"] is None
    assert result["editions"] == [{"version_number": 2, "render_job_id": str(JOB_ID)}]
    assert not transaction.executions and not transaction.one


def test_edition_routes_require_explicit_revision_and_forward_selected_version():
    from test_render_routes import JOB_ID as route_job
    from test_render_routes import PROJECT_ID as route_project
    from test_render_routes import RESOURCE_ID as route_resource
    from test_render_routes import FakeRepository, client, headers

    calls = []

    class Editions(FakeRepository):
        async def register_artifact_edition(self, context, project, resource, job, expected):
            calls.append(("register", project, resource, job, expected))
            return {"revision": 1, "current_version_number": None}

        async def read_artifact_edition(
            self, context, project, resource, number, metadata_only=False
        ):
            calls.append(("read", number, metadata_only))
            return {"revision": 1, "current_version_number": None}

        async def select_artifact_current(self, context, project, resource, number, expected):
            calls.append(("select", number, expected))
            return {"revision": 2, "current_version_number": number}

    app = client(Editions())
    base = f"/projects/{route_project}/resources/{route_resource}"
    response = app.post(
        f"{base}/renders/{route_job}/artifact-edition",
        headers=headers(),
        json={"expected_revision": 0},
    )
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert response.json()["current_version_number"] is None
    response = app.get(f"{base}/artifact?metadata_only=true", headers=headers())
    assert response.status_code == 200
    response = app.put(
        f"{base}/artifact/current",
        headers=headers(),
        json={"expected_revision": 1, "version_number": 1},
    )
    assert response.status_code == 200
    assert calls == [
        ("register", route_project, route_resource, route_job, 0),
        ("read", None, True),
        ("select", 1, 1),
    ]
    response = app.put(f"{base}/artifact/current", headers=headers(), json={"version_number": 1})
    assert response.status_code == 422 and len(calls) == 3
