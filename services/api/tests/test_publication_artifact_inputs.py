import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import pytest

from opengeo_api.authorization import Roles
from opengeo_api.observable_sources import OBSERVABLE_BUILD_LIMITS, ObservableSourceConflict
from opengeo_api.publication_artifact_inputs import (
    prepare_artifact_inputs,
    read_artifact_inputs,
    validate_input_paths,
)
from opengeo_api.tenant_database import TenantContext

ORG, USER, PROJECT, SOURCE, REVISION, ARTIFACT, OUTPUT, INPUT = (UUID(int=n) for n in range(1, 9))
PIN = {
    "path": "src/maps/survey.html",
    "artifact_id": str(ARTIFACT),
    "mode": "current",
    "version": None,
    "resolved_version": 3,
    "manifest_checksum_sha256": "a" * 64,
    "output": {
        "objectId": None,
        "mediaType": "text/html",
        "sizeBytes": 100,
        "checksumSha256": "b" * 64,
    },
}


def revision(*paths, entry="src/index.md"):
    return SimpleNamespace(
        files=tuple(SimpleNamespace(relative_path=p, size_bytes=12) for p in paths),
        manifest={},
        entry_path=entry,
        manifest_checksum_sha256="c" * 64,
    )


@pytest.mark.parametrize(
    "paths",
    [
        ("SRC/maps/survey.html",),
        ("src/maps/survey.html", "src/maps/survey.html-other", "src/maps/survey.html/child.md"),
        ("src/maps",),
    ],
)
def test_artifact_cannot_overwrite_or_shadow_source(paths):
    with pytest.raises(ObservableSourceConflict, match="collision"):
        validate_input_paths(revision(*paths), [PIN], OBSERVABLE_BUILD_LIMITS)


def test_input_limits_and_compiler_source_roots():
    validate_input_paths(revision("src/index.md"), [PIN], OBSERVABLE_BUILD_LIMITS)
    with pytest.raises(ObservableSourceConflict, match="file_limit"):
        validate_input_paths(
            revision("src/index.md"), [PIN], {**OBSERVABLE_BUILD_LIMITS, "maxInputFiles": 1}
        )
    with pytest.raises(ObservableSourceConflict, match="size_limit"):
        validate_input_paths(
            revision("src/index.md"), [PIN], {**OBSERVABLE_BUILD_LIMITS, "maxInputBytes": 100}
        )
    outside = {**PIN, "path": "maps/survey.html"}
    validate_input_paths(revision("src/index.md"), [outside], OBSERVABLE_BUILD_LIMITS)
    with pytest.raises(ObservableSourceConflict, match="outside_source_root"):
        validate_input_paths(
            revision("src/index.md", "package.json"), [outside], OBSERVABLE_BUILD_LIMITS
        )
    with pytest.raises(ObservableSourceConflict, match="outside_source_root"):
        validate_input_paths(
            revision("report/index.html", entry="report/index.html"), [PIN], OBSERVABLE_BUILD_LIMITS
        )


def test_admitted_archive_budget_is_separate_from_source_and_artifact_budget():
    saved = revision("src/index.md")
    saved.manifest = {"dataAttachments": [{"path": "src/data/original.tif", "sizeBytes": 64912721}]}
    validate_input_paths(saved, [PIN], OBSERVABLE_BUILD_LIMITS)
    oversized = {
        **PIN,
        "output": {**PIN["output"], "sizeBytes": OBSERVABLE_BUILD_LIMITS["maxInputBytes"]},
    }
    with pytest.raises(ObservableSourceConflict, match="size_limit"):
        validate_input_paths(saved, [oversized], OBSERVABLE_BUILD_LIMITS)


def test_preparation_reuses_exact_pins_and_read_never_resolves_current_again(monkeypatch):
    from opengeo_api import publication_artifact_inputs as module

    inserted = []
    refs = {
        "revision": 2,
        "references": [{key: PIN[key] for key in ("path", "artifact_id", "mode", "version")}],
    }
    resolver = AsyncMock(return_value=[PIN])
    monkeypatch.setattr(module, "latest_references", AsyncMock(return_value=refs))
    monkeypatch.setattr(module, "resolve_references", resolver)

    class Transaction:
        async def fetch_one(self, sql, params):
            if "portable_object_id" in sql:
                # Aurora Data API binds ordinary strings as text. The retained
                # identity must keep its UUID type across that transport boundary.
                from opengeo_api.rds_data import compile_data_api_statement

                _, encoded = compile_data_api_statement(sql, params)
                assert encoded[1]["typeHint"] == "UUID"
                return (OUTPUT,)
            if "INSERT INTO" in sql:
                if inserted:
                    assert params[5].obj == inserted[0]
                    return None
                inserted.append(params[5].obj)
                return (INPUT, "d" * 64)
            if "SELECT id," in sql:
                return (INPUT, "d" * 64)
            return (inserted[0], "d" * 64)

    async def run(context, operation):
        return await operation(Transaction())

    repository = SimpleNamespace(
        _run=run,
        _executor=None,
        _require=lambda *args: None,
        _project_roles=AsyncMock(return_value=Roles(organization="admin")),
        _load_project=AsyncMock(
            return_value=SimpleNamespace(resource_limits=OBSERVABLE_BUILD_LIMITS)
        ),
        _load_revision=AsyncMock(return_value=revision("src/index.md")),
    )
    context = TenantContext(USER, ORG)
    first = asyncio.run(prepare_artifact_inputs(repository, context, PROJECT, SOURCE, REVISION, 2))
    second = asyncio.run(prepare_artifact_inputs(repository, context, PROJECT, SOURCE, REVISION, 2))
    assert not first["reused"] and second["reused"] and first["id"] == second["id"]
    assert first["manifest"]["artifacts"][0]["version"] == 3
    assert first["manifest"]["artifacts"][0]["outputObjectId"] == str(OUTPUT)
    read = asyncio.run(read_artifact_inputs(repository, context, PROJECT, SOURCE, INPUT))
    assert read["manifest"] == first["manifest"]
    assert resolver.await_args.args[-1] == [
        {"path": PIN["path"], "artifact_id": str(ARTIFACT), "mode": "pinned", "version": 3}
    ]
    resolver.side_effect = ObservableSourceConflict("publication_artifact_unavailable")
    with pytest.raises(ObservableSourceConflict, match="unavailable"):
        asyncio.run(read_artifact_inputs(repository, context, PROJECT, SOURCE, INPUT))


def test_input_routes_bind_exact_source_revision_and_disable_caching():
    from test_observable_source_routes import (
        PROJECT_ID,
        REVISION_ID,
        SOURCE_PROJECT_ID,
        MemoryObservableSourceRepository,
        client,
        headers,
    )

    class Repository(MemoryObservableSourceRepository):
        async def prepare_artifact_inputs(self, context, project, source, revision, expected):
            self.calls.append(("prepare", project, source, revision, expected))
            return {"id": str(INPUT), "reused": False}

        async def read_artifact_inputs(self, context, project, source, input_id):
            self.calls.append(("read", project, source, input_id))
            return {"id": str(input_id)}

    repository = Repository()
    api = client(repository)
    prefix = f"/projects/{PROJECT_ID}/source-projects/{SOURCE_PROJECT_ID}"
    response = api.post(
        f"{prefix}/revisions/{REVISION_ID}/artifact-inputs",
        headers=headers(),
        json={"expected_reference_revision": 2},
    )
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    response = api.get(f"{prefix}/artifact-inputs/{INPUT}", headers=headers())
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert repository.calls == [
        ("prepare", PROJECT_ID, SOURCE_PROJECT_ID, REVISION_ID, 2),
        ("read", PROJECT_ID, SOURCE_PROJECT_ID, INPUT),
    ]
    assert (
        api.post(
            f"{prefix}/revisions/{REVISION_ID}/artifact-inputs",
            headers=headers(),
            json={"expected_reference_revision": 0},
        ).status_code
        == 422
    )
