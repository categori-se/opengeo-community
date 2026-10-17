import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import pytest

from opengeo_api.authorization import Roles
from opengeo_api.observable_sources import (
    OBSERVABLE_SOURCE_MANIFEST_SCHEMA,
    ObservableSourceAccessDenied,
    ObservableSourceConflict,
    PostgresObservableSourceRepository,
)
from opengeo_api.publication_artifact_references import artifact_backup_inputs, validate_references
from opengeo_api.tenant_database import TenantContext

ORG, USER, PROJECT, SOURCE, ARTIFACT = (UUID(int=n) for n in range(1, 6))
REFERENCE = {
    "path": "maps/survey.html",
    "artifact_id": str(ARTIFACT),
    "mode": "current",
    "version": None,
}


@pytest.mark.parametrize(
    "change",
    [
        {"mode": "latest"},
        {"version": 1},
        {"mode": "pinned"},
        {"mode": "pinned", "version": True},
        {"artifact_id": "https://signed.invalid"},
        {"path": "../map.html"},
        {"url": "https://signed.invalid"},
    ],
)
def test_reference_rejects_ambiguous_or_url_based_input(change):
    with pytest.raises((ObservableSourceConflict, ValueError)):
        validate_references([{**REFERENCE, **change}])


def test_reference_paths_are_bounded_and_case_insensitively_distinct():
    with pytest.raises(ObservableSourceConflict, match="collision"):
        validate_references([REFERENCE, {**REFERENCE, "path": "maps/SURVEY.html"}])
    with pytest.raises(ObservableSourceConflict, match="limit"):
        validate_references([REFERENCE] * 33)
    assert validate_references([REFERENCE]) == [REFERENCE]


def test_reference_revisions_reopen_conflict_and_remove_without_source_access(monkeypatch):
    from opengeo_api import publication_artifact_references as module

    rows, resolutions = [], []

    class Transaction:
        async def fetch_one(self, sql, params):
            if "FOR UPDATE" in sql:
                return (SOURCE,)
            return rows[-1] if rows else None

        async def execute(self, sql, params):
            assert "INSERT INTO app.publication_artifact_reference_sets" in sql
            rows.append((params[2], params[3].obj))

    class Executor:
        async def run(self, context, operation):
            return await operation(Transaction())

    async def resolve(transaction, context, executor, references):
        resolutions.append(references)
        return []

    monkeypatch.setattr(module, "resolve_references", resolve)
    repo = PostgresObservableSourceRepository(Executor())
    repo._project_roles = AsyncMock(return_value=Roles(organization="admin", project="owner"))
    repo._load_project = AsyncMock(return_value=SimpleNamespace())
    context = TenantContext(USER, ORG)

    def run(*args):
        return asyncio.run(repo.artifact_references(context, PROJECT, SOURCE, *args))

    assert run() == {"revision": 0, "references": []}
    assert run([REFERENCE], 0) == {"revision": 1, "references": [REFERENCE]}
    assert run() == {"revision": 1, "references": [REFERENCE]}
    assert run([REFERENCE], 1)["revision"] == 1
    with pytest.raises(ObservableSourceConflict, match="revision_conflict"):
        run([], 0)
    assert run([], 1) == {"revision": 2, "references": []}
    assert len(rows) == 2 and resolutions == [[REFERENCE], [REFERENCE], []]


def test_build_refuses_unstaged_references_before_reusing_an_old_job():
    transaction = SimpleNamespace(fetch_one=AsyncMock(return_value=(1, [REFERENCE])))

    class Executor:
        async def run(self, context, operation):
            return await operation(transaction)

    repo = PostgresObservableSourceRepository(Executor())
    repo._project_roles = AsyncMock(return_value=Roles(organization="admin", project="owner"))
    repo._load_project = AsyncMock(return_value=SimpleNamespace())
    repo._load_revision = AsyncMock(
        return_value=SimpleNamespace(manifest={"schemaVersion": OBSERVABLE_SOURCE_MANIFEST_SCHEMA})
    )
    with pytest.raises(ObservableSourceConflict, match="staging_unavailable"):
        asyncio.run(
            repo.create_build_job(
                TenantContext(USER, ORG),
                PROJECT,
                SOURCE,
                UUID(int=10),
                "preview",
                "test",
                UUID(int=11),
            )
        )
    assert transaction.fetch_one.await_count == 1
    assert "app.publication_artifact_reference_sets" in transaction.fetch_one.await_args.args[0]


def test_reference_routes_keep_intent_distinct_from_builds_and_disable_caching():
    from test_observable_source_routes import (
        PROJECT_ID,
        SOURCE_PROJECT_ID,
        MemoryObservableSourceRepository,
        client,
        headers,
    )

    class Repository(MemoryObservableSourceRepository):
        async def artifact_references(
            self, context, project, source, references=None, expected_revision=None
        ):
            self.calls.append((project, source, references, expected_revision))
            return {"revision": 1, "references": references or []}

    repository = Repository()
    api = client(repository)
    path = f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/artifact-references"
    response = api.request(
        "PUT",
        path,
        headers=headers(),
        json_body={"expected_revision": 0, "references": [REFERENCE]},
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["references"] == [REFERENCE]
    assert repository.calls == [(PROJECT_ID, SOURCE_PROJECT_ID, [REFERENCE], 0)]
    response = api.get(path, headers=headers())
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert (
        api.request(
            "PUT", path, headers=headers(), json_body={"expected_revision": -1, "references": []}
        ).status_code
        == 422
    )
    assert len(repository.calls) == 2


def test_artifact_backup_resolves_exact_editions_and_maps_addresses_once_without_writes(
    monkeypatch,
):
    from opengeo_api import publication_artifact_references as module

    download_project, resource, output_id = (UUID(int=n) for n in (20, 21, 22))
    references = [
        REFERENCE,
        {**REFERENCE, "path": "maps/prior.html", "mode": "pinned", "version": 3},
    ]
    mapping_queries, editions, manifests = [], [], []

    class Transaction:
        async def fetch_one(self, sql, params):
            assert params[0] == ORG
            if "publication_artifact_reference_sets" in sql:
                return (4, references)
            assert "FOR SHARE OF artifact" in sql and params[1] == ARTIFACT
            return (resource, download_project, 7)

        async def fetch_all(self, sql, params):
            assert "unnest(%s::uuid[], %s::integer[])" in sql and "LIMIT 32" in sql
            assert params == (ORG, [ARTIFACT, ARTIFACT], [3, 7])
            mapping_queries.append(sql)
            return [
                (ARTIFACT, download_project, resource, version, output_id) for version in (3, 7)
            ]

        async def execute(self, *args):
            pytest.fail("A backup metadata read must not write")

    transaction = Transaction()

    class Executor:
        async def run(self, context, operation):
            assert context == TenantContext(USER, ORG)
            return await operation(transaction)

    async def edition(renderer, tx, context, project_id, resource_id, artifact_id, version):
        assert tx is transaction
        assert (project_id, resource_id, artifact_id) == (download_project, resource, ARTIFACT)
        editions.append(version)
        manifest = {
            "manifestChecksumSha256": str(version) * 64,
            "output": {
                "objectId": None,
                "mediaType": "text/html",
                "sizeBytes": 100,
                "checksumSha256": "a" * 64,
            },
        }
        manifests.append(manifest)
        return manifest

    renderer_roles = AsyncMock(return_value=Roles(organization="member", project="viewer"))
    monkeypatch.setattr(module.PostgresRenderRepository, "_resource_roles", renderer_roles)
    monkeypatch.setattr(module, "_edition_manifest", edition)
    repo = PostgresObservableSourceRepository(Executor())
    repo._project_roles = AsyncMock(return_value=Roles(organization="member", project="viewer"))
    repo._load_project = AsyncMock(return_value=SimpleNamespace())
    result = asyncio.run(artifact_backup_inputs(repo, TenantContext(USER, ORG), PROJECT, SOURCE, 4))
    assert result["schema_version"] == "opengeo.publication-artifact-backup-inputs.1.0.0"
    assert result["project_id"] == str(PROJECT) and result["source_project_id"] == str(SOURCE)
    assert result["reference_revision"] == 4
    assert sorted(editions) == [3, 7] and len(mapping_queries) == 1
    assert {pin["mode"] for pin in result["pins"]} == {"current", "pinned"}
    assert {pin["resolved_version"] for pin in result["pins"]} == {3, 7}
    assert all(
        pin["project_id"] == str(download_project) and pin["resource_id"] == str(resource)
        for pin in result["pins"]
    )
    assert all(pin["output"]["checksumSha256"] == "a" * 64 for pin in result["pins"])
    assert all(pin["output"]["objectId"] == str(output_id) for pin in result["pins"])
    assert renderer_roles.await_count == 2
    assert all(
        call.args == (transaction, TenantContext(USER, ORG), download_project, resource)
        for call in renderer_roles.await_args_list
    )
    # The real retained browser snapshot has a null embedded object ID. Backup
    # fills it from the authorized stored edition without rewriting that manifest
    # or changing compiler inputs that still pin the original bytes and checksum.
    legacy_pins = asyncio.run(
        module.resolve_references(transaction, TenantContext(USER, ORG), repo._executor, references)
    )
    assert all(pin["output"]["objectId"] is None for pin in legacy_pins)
    assert all(manifest["output"]["objectId"] is None for manifest in manifests)
    assert {pin["path"]: pin["manifest_checksum_sha256"] for pin in legacy_pins} == {
        pin["path"]: pin["manifest_checksum_sha256"] for pin in result["pins"]
    }
    assert len(mapping_queries) == 1


def test_artifact_backup_refuses_changed_references_before_resolving_or_mapping(monkeypatch):
    from opengeo_api import publication_artifact_references as module

    transaction = SimpleNamespace(
        fetch_one=AsyncMock(return_value=(4, [REFERENCE])),
        fetch_all=AsyncMock(),
        execute=AsyncMock(),
    )

    class Executor:
        async def run(self, context, operation):
            return await operation(transaction)

    resolve = AsyncMock()
    monkeypatch.setattr(module, "resolve_references", resolve)
    repo = PostgresObservableSourceRepository(Executor())
    repo._project_roles = AsyncMock(return_value=Roles(organization="member", project="viewer"))
    repo._load_project = AsyncMock(return_value=SimpleNamespace())
    with pytest.raises(ObservableSourceConflict, match="revision_conflict"):
        asyncio.run(artifact_backup_inputs(repo, TenantContext(USER, ORG), PROJECT, SOURCE, 3))
    resolve.assert_not_awaited()
    transaction.fetch_all.assert_not_awaited()
    transaction.execute.assert_not_awaited()


@pytest.mark.parametrize("denied", ["site", "artifact"])
def test_artifact_backup_never_discloses_addresses_without_current_read_authority(
    monkeypatch, denied
):
    from opengeo_api import publication_artifact_references as module

    resource, download_project = UUID(int=21), UUID(int=20)
    transaction = SimpleNamespace(
        fetch_one=AsyncMock(side_effect=[(4, [REFERENCE]), (resource, download_project, 7)]),
        fetch_all=AsyncMock(),
        execute=AsyncMock(),
    )

    class Executor:
        async def run(self, context, operation):
            return await operation(transaction)

    repo = PostgresObservableSourceRepository(Executor())
    repo._project_roles = AsyncMock(
        return_value=Roles(organization="member", project=None if denied == "site" else "viewer")
    )
    repo._load_project = AsyncMock(return_value=SimpleNamespace())
    monkeypatch.setattr(
        module.PostgresRenderRepository,
        "_resource_roles",
        AsyncMock(return_value=Roles(organization="member", project=None)),
    )
    manifest = AsyncMock()
    monkeypatch.setattr(module, "_edition_manifest", manifest)
    expected = ObservableSourceAccessDenied if denied == "site" else ObservableSourceConflict
    with pytest.raises(expected):
        asyncio.run(artifact_backup_inputs(repo, TenantContext(USER, ORG), PROJECT, SOURCE, 4))
    manifest.assert_not_awaited()
    transaction.fetch_all.assert_not_awaited()
    transaction.execute.assert_not_awaited()


def test_artifact_backup_route_is_read_only_bounded_and_uncached(monkeypatch):
    from opengeo_api import observable_source_routes as routes
    from test_observable_source_routes import (
        PROJECT_ID,
        SOURCE_PROJECT_ID,
        MemoryObservableSourceRepository,
        client,
        headers,
    )

    repository = MemoryObservableSourceRepository()
    helper = AsyncMock(return_value={"reference_revision": 4, "pins": []})
    monkeypatch.setattr(routes, "artifact_backup_inputs", helper)
    api = client(repository)
    path = f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}/artifact-backup-inputs"
    response = api.get(path + "?expected_reference_revision=4", headers=headers())
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert helper.await_args.args[0] is repository
    assert helper.await_args.args[2:] == (PROJECT_ID, SOURCE_PROJECT_ID, 4)
    assert api.get(path + "?expected_reference_revision=-1", headers=headers()).status_code == 422
    assert (
        api.get(path + "?expected_reference_revision=2147483648", headers=headers()).status_code
        == 422
    )
    assert api.request("POST", path, headers=headers(), json_body={}).status_code == 405
    assert helper.await_count == 1
