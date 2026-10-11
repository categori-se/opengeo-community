import asyncio
from hashlib import sha256

import pytest

from opengeo_api.rendering import RenderConflict, SealedRenderOutput
from opengeo_api.tenant_database import TenantContext
from test_rendering import (
    JOB_ID,
    ORG_ID,
    OUTPUT_ID,
    PROJECT_ID,
    RESOURCE_ID,
    RESOURCE_VERSION_ID,
    USER_ID,
    Downloads,
    Transaction,
    job_row,
    repository,
)


@pytest.mark.parametrize("failure_at", [None, 1, 2])
def test_public_map_bytes_recheck_all_source_rights_before_and_after_storage(
    monkeypatch, failure_at
):
    body = b"\x89PNG\r\n\x1a\nexact-map"
    checksum = sha256(body).hexdigest()
    target = (
        "storage",
        "renders/map.png",
        "version-1",
        "map.png",
        OUTPUT_ID,
        "image/png",
        len(body),
        checksum,
        RESOURCE_VERSION_ID,
        "map",
    )
    calls = []

    async def source_check(
        transaction, context, project_id, resource_id, version_id, job_id, *, public, repository
    ):
        calls.append((project_id, resource_id, version_id, job_id, public))
        if len(calls) == failure_at:
            raise RenderConflict("saved_map_source_not_public")
        return {"verified": True}

    monkeypatch.setattr("opengeo_api.saved_map_publication.load_saved_map_seal", source_check)
    downloads = Downloads(body)
    transaction = Transaction([target, target])
    operation = repository(transaction, downloads).read_sealed_map_output(
        TenantContext(USER_ID, ORG_ID),
        PROJECT_ID,
        RESOURCE_ID,
        JOB_ID,
        SealedRenderOutput(OUTPUT_ID, "version-1", "image/png", len(body), checksum),
        1024,
    )
    if failure_at is None:
        assert asyncio.run(operation).body == body
    else:
        with pytest.raises(RenderConflict, match="saved_map_source_not_public"):
            asyncio.run(operation)
    assert calls == [(PROJECT_ID, RESOURCE_ID, RESOURCE_VERSION_ID, JOB_ID, True)] * (
        failure_at or 2
    )
    assert len(downloads.exact_specs) == (0 if failure_at == 1 else 1)
    assert transaction.executions == []


def test_map_image_cannot_use_an_unbound_ordinary_render_job():
    target = (
        "storage",
        "renders/map.png",
        "version-1",
        "map.png",
        OUTPUT_ID,
        "image/png",
        10,
        "a" * 64,
        None,
        "map",
    )
    downloads = Downloads()
    transaction = Transaction([target])
    with pytest.raises(RenderConflict, match="saved_map_binding_unavailable"):
        asyncio.run(
            repository(transaction, downloads)._download_target(
                transaction,
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                RESOURCE_ID,
                JOB_ID,
            )
        )
    assert downloads.specs == []


def test_private_map_download_checks_sources_without_assuming_publication(monkeypatch):
    target = (
        "storage",
        "renders/map.png",
        "version-1",
        "map.png",
        OUTPUT_ID,
        "image/png",
        10,
        "a" * 64,
        RESOURCE_VERSION_ID,
        "map",
    )
    calls = []

    async def source_check(
        transaction, context, project_id, resource_id, version_id, job_id, *, public, repository
    ):
        calls.append(public)
        raise RenderConflict("saved_map_sources_unavailable")

    monkeypatch.setattr("opengeo_api.saved_map_publication.load_saved_map_seal", source_check)
    transaction = Transaction([target])
    with pytest.raises(RenderConflict, match="saved_map_sources_unavailable"):
        asyncio.run(
            repository(transaction)._download_target(
                transaction,
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                RESOURCE_ID,
                JOB_ID,
            )
        )
    assert calls == [False]


@pytest.mark.parametrize("read", ["find", "get", "list"])
def test_saved_map_job_metadata_rechecks_composition_access(monkeypatch, read):
    row = (*job_row(), {"map_version": 1})
    transaction = Transaction(
        [("member", "owner", None, True), *([] if read == "list" else [row])],
        [[row]] if read == "list" else [],
    )
    repo = repository(transaction)
    calls = []

    async def check(transaction, context, project_id, job_id, action):
        calls.append((project_id, job_id))
        raise RenderConflict("saved_map_sources_unavailable")

    monkeypatch.setattr(repo, "_require_composition_access", check)
    context = TenantContext(USER_ID, ORG_ID)
    operation = (
        repo.list_resource_renders(context, PROJECT_ID, RESOURCE_ID)
        if read == "list"
        else repo.find_job_by_idempotency(context, PROJECT_ID, RESOURCE_ID, JOB_ID)
        if read == "find"
        else repo.get_job(context, PROJECT_ID, RESOURCE_ID, JOB_ID)
    )
    with pytest.raises(RenderConflict, match="saved_map_sources_unavailable"):
        asyncio.run(operation)
    assert calls == [(PROJECT_ID, JOB_ID)]
