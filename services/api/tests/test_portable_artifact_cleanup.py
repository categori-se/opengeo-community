import asyncio
from uuid import UUID

import pytest

from opengeo_api.portable_artifact_cleanup import (
    UploadObjectVersion,
    UploadVersionPage,
    cleanup_expired_portable_upload,
)
from opengeo_api.rendering import RenderAccessDenied, RenderConflict, RenderNotFound
from test_rendering import PROJECT_ID, RESOURCE_ID, Transaction, repository
from test_saved_map_jobs import CONTEXT, ROLES


class Storage:
    def __init__(self, page):
        self.page = page
        self.lists = []
        self.deletes = []

    async def list_exact_versions(self, bucket, key, limit):
        self.lists.append((bucket, key, limit))
        return self.page

    async def delete_exact_version(self, bucket, key, version):
        self.deletes.append((bucket, key, version))


def run(tx, storage):
    return asyncio.run(
        cleanup_expired_portable_upload(
            repository(tx), storage, CONTEXT, PROJECT_ID, RESOURCE_ID, UUID(int=123)
        )
    )


def test_expired_cleanup_is_bounded_to_explicit_versions_and_never_claims_terminal():
    storage = Storage(UploadVersionPage((UploadObjectVersion("upload/map.html", "v1"),), False))
    tx = Transaction([ROLES, ("local.invalid", "upload/map.html"), None] * 2)
    result = run(tx, storage)
    assert storage.lists == [("local.invalid", "upload/map.html", 16)]
    assert storage.deletes == [("local.invalid", "upload/map.html", "v1")]
    assert result["deleted_versions"] == 1
    assert result["terminal"] is False
    assert result["observed_empty"] is False
    assert len(tx.executions) == 2
    storage.page = UploadVersionPage((), False)
    result = run(Transaction([ROLES, ("local.invalid", "upload/map.html"), None] * 2), storage)
    assert result["observed_empty"] is True
    assert result["terminal"] is False
    assert len(storage.deletes) == 1


@pytest.mark.parametrize(
    "rows,error",
    [
        ([("member", None, None, False)], RenderAccessDenied),
        ([ROLES, None], RenderNotFound),
        ([ROLES, ("local.invalid", "upload/map.html"), (1,)], RenderConflict),
    ],
)
def test_denied_missing_or_retained_candidates_never_touch_storage(rows, error):
    storage = Storage(UploadVersionPage((), False))
    with pytest.raises(error):
        run(Transaction(rows), storage)
    assert not storage.lists and not storage.deletes


@pytest.mark.parametrize(
    "versions",
    [
        (UploadObjectVersion("other/key", "v1"),),
        (UploadObjectVersion("upload/map.html", "null"),),
        (UploadObjectVersion("upload/map.html", "v1"),) * 2,
        tuple(UploadObjectVersion("upload/map.html", str(i)) for i in range(17)),
    ],
)
def test_untrusted_inventory_cannot_expand_cleanup(versions):
    storage = Storage(UploadVersionPage(versions, False))
    with pytest.raises(RenderConflict, match="inventory_invalid"):
        run(Transaction([ROLES, ("local.invalid", "upload/map.html"), None] * 2), storage)
    assert not storage.deletes


def test_partial_delete_failure_retains_confirmed_count_and_failure_receipt():
    storage = Storage(
        UploadVersionPage(
            (
                UploadObjectVersion("upload/map.html", "v1"),
                UploadObjectVersion("upload/map.html", "v2"),
            ),
            False,
        )
    )
    original = storage.delete_exact_version

    async def fail_second(bucket, key, version):
        if version == "v2":
            raise RuntimeError("do not expose transport details")
        await original(bucket, key, version)

    storage.delete_exact_version = fail_second
    tx = Transaction([ROLES, ("local.invalid", "upload/map.html"), None] * 2)
    result = run(tx, storage)
    assert result["state"] == "failed"
    assert result["deleted_versions"] == 1
    assert result["error_code"] == "storage_delete_unconfirmed"
    assert result["terminal"] is False
    assert "INSERT INTO app.project_artifact_cleanup_attempts" in tx.executions[0][0]
    assert "UPDATE app.project_artifact_cleanup_attempts" in tx.executions[1][0]
