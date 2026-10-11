import asyncio
from dataclasses import replace
from uuid import uuid4

import pytest

from opengeo_api.archive_uploads import ArchiveFile, ArchiveUploadRepository
from opengeo_api.ingestion import (
    IngestionAccessDenied,
    IngestionConflict,
    PostgresIngestionRepository,
)
from opengeo_api.tenant_database import TenantContext
from test_ingestion import ORG_ID, PROJECT_ID, USER_ID, FakeExecutor, FakeStorage, FakeTransaction

CONTEXT = TenantContext(USER_ID, ORG_ID)
DESTINATION = uuid4()
SESSION = uuid4()
FILE = ArchiveFile(0, DESTINATION, "archive/run.py", 12, 1, "a" * 64)


def repo(tx):
    return ArchiveUploadRepository(PostgresIngestionRepository(FakeExecutor([tx]), FakeStorage()))


@pytest.mark.parametrize("path", ["/x", "../x", "a/../x", "a//x", "a\\x", "C:/x", "a\x00x"])
def test_unsafe_paths_rejected(path):
    with pytest.raises(IngestionConflict):
        replace(FILE, path=path).validate()


def test_exact_retry_preserves_immutable_file():
    values = (DESTINATION, FILE.path, 12, 1, FILE.sha256)
    tx = FakeTransaction(
        one=[("guest",), (PROJECT_ID, "editor"), ("planning",), ("bhutan/private/",), values]
    )
    asyncio.run(repo(tx).append_files(CONTEXT, PROJECT_ID, SESSION, [FILE]))
    assert any("ON CONFLICT" in call[1] for call in tx.calls)


def test_conflicting_retry_rejected():
    tx = FakeTransaction(
        one=[
            ("guest",),
            (PROJECT_ID, "editor"),
            ("planning",),
            ("bhutan/private/",),
            (DESTINATION, FILE.path, 99, 1, FILE.sha256),
        ]
    )
    with pytest.raises(IngestionConflict, match="archive_plan_changed"):
        asyncio.run(repo(tx).append_files(CONTEXT, PROJECT_ID, SESSION, [FILE]))


def test_revoked_editor_cannot_resume_or_write():
    tx = FakeTransaction(one=[("guest",), (PROJECT_ID, "viewer")])
    with pytest.raises(IngestionAccessDenied):
        asyncio.run(repo(tx).append_files(CONTEXT, PROJECT_ID, SESSION, [FILE]))
    assert not any(call[0] == "execute" for call in tx.calls)


def test_unapproved_destination_rejected():
    tx = FakeTransaction(one=[("guest",), (PROJECT_ID, "editor"), ("planning",), None])
    with pytest.raises(IngestionConflict, match="archive_destination_unavailable"):
        asyncio.run(repo(tx).append_files(CONTEXT, PROJECT_ID, SESSION, [FILE]))


def test_idempotent_creation_and_wrong_workspace_key():
    tx = FakeTransaction(one=[("guest",), (PROJECT_ID, "editor"), (None,), (SESSION, PROJECT_ID)])
    assert asyncio.run(repo(tx).create(CONTEXT, PROJECT_ID, uuid4())) == SESSION
    tx = FakeTransaction(one=[("guest",), (PROJECT_ID, "editor"), (None,), (SESSION, uuid4())])
    with pytest.raises(IngestionConflict, match="archive_creation_key_conflict"):
        asyncio.run(repo(tx).create(CONTEXT, PROJECT_ID, uuid4()))


def test_resume_page_is_bounded_and_scoped():
    tx = FakeTransaction(one=[("guest",), (PROJECT_ID, "editor"), ("planning",)], all_rows=[[]])
    assert asyncio.run(repo(tx).read_files(CONTEXT, PROJECT_ID, SESSION)) == []
    assert "LIMIT 25" in tx.calls[-1][1]
    assert tx.calls[-1][2] == (ORG_ID, PROJECT_ID, SESSION, -1)


def test_authenticated_http_create_and_resume():
    from test_ingestion_routes import api_client

    create_tx = FakeTransaction(
        one=[("member",), (PROJECT_ID, "editor"), (None,), (SESSION, PROJECT_ID)]
    )
    read_tx = FakeTransaction(
        one=[("member",), (PROJECT_ID, "editor"), ("planning",)],
        all_rows=[[(0, DESTINATION, FILE.path, 12, 1, FILE.sha256)]],
    )
    ingestion = PostgresIngestionRepository(FakeExecutor([create_tx, read_tx]), FakeStorage())
    with api_client(ingestion) as client:
        headers = {"Authorization": "Bearer valid-token", "X-OpenGeo-Organization": str(ORG_ID)}
        base = f"/projects/{PROJECT_ID}/archive-uploads"
        response = client.post(base, headers=headers, json={"creation_key": str(uuid4())})
        assert response.status_code == 201, response.text
        assert response.json()["id"] == str(SESSION)
        response = client.get(f"{base}/{SESSION}/files", headers=headers)
        assert response.status_code == 200, response.text
        assert response.json()["files"][0]["sha256"] == FILE.sha256
        assert response.json()["next_after"] is None
        assert client.get(f"{base}/{SESSION}/files").status_code == 401
        response = client.post(
            base, headers=headers, json={"creation_key": str(uuid4()), "bucket": "unreviewed"}
        )
        assert response.status_code == 422


def test_session_quota_rejects_sixth_intent_without_insert():
    tx = FakeTransaction(one=[("member",), (PROJECT_ID, "editor"), (None,), None, (5,)])
    with pytest.raises(IngestionConflict, match="archive_session_limit"):
        asyncio.run(repo(tx).create(CONTEXT, PROJECT_ID, uuid4()))
    assert not any(call[0] == "execute" for call in tx.calls)


def test_new_intent_under_quota_is_created():
    tx = FakeTransaction(one=[("member",), (PROJECT_ID, "editor"), (None,), None, (4,)])
    result = asyncio.run(repo(tx).create(CONTEXT, PROJECT_ID, uuid4()))
    assert tx.calls[-1][2][2] == result


def test_seal_requires_contiguous_complete_inventory_and_deduplicates_bytes():
    tx = FakeTransaction(
        one=[
            ("member",),
            (PROJECT_ID, "editor"),
            ("planning", None, None, None, None),
            (2, 24, 0, 1, 0),
            (12,),
        ]
    )
    result = asyncio.run(repo(tx).seal(CONTEXT, PROJECT_ID, SESSION, 2, 24))
    assert result == {"file_count": 2, "logical_bytes": 24, "upload_bytes": 12}
    assert "state='paused'" in tx.calls[-1][1]


@pytest.mark.parametrize("summary", [(2, 24, 0, 2, 0), (1, 12, 0, 0, 0), (2, 24, 0, 1, 1)])
def test_seal_rejects_gaps_missing_files_and_disabled_destinations(summary):
    tx = FakeTransaction(
        one=[("member",), (PROJECT_ID, "editor"), ("planning", None, None, None, None), summary]
    )
    with pytest.raises(IngestionConflict, match="archive_plan_incomplete"):
        asyncio.run(repo(tx).seal(CONTEXT, PROJECT_ID, SESSION, 2, 24))
    assert not any(call[0] == "execute" for call in tx.calls)


def test_seal_retry_returns_existing_review_without_transfer():
    tx = FakeTransaction(one=[("member",), (PROJECT_ID, "editor"), ("paused", 2, 24, 12, "sealed")])
    assert asyncio.run(repo(tx).seal(CONTEXT, PROJECT_ID, SESSION, 2, 24))["upload_bytes"] == 12
    assert not any(call[0] == "execute" for call in tx.calls)


def test_surrogate_path_is_validation_error():
    with pytest.raises(IngestionConflict, match="archive_file_invalid"):
        replace(FILE, path="a/\ud800").validate()


def test_finish_requires_coverage_of_every_original_not_only_existing_objects():
    tx = FakeTransaction(one=[("member",), (PROJECT_ID, "editor"), ("uploading", 2), (1, 0), (1,)])
    with pytest.raises(IngestionConflict, match="archive_upload_incomplete"):
        asyncio.run(repo(tx).finish(CONTEXT, PROJECT_ID, SESSION))
    assert not any(call[0] == "execute" for call in tx.calls)


def test_manifest_unavailable_before_complete():
    tx = FakeTransaction(one=[("member",), (PROJECT_ID, "editor"), ("uploading",)])
    with pytest.raises(IngestionConflict, match="archive_upload_incomplete"):
        asyncio.run(repo(tx).manifest_page(CONTEXT, PROJECT_ID, SESSION))


def test_http_transfer_reopens_receipt_with_authorization_and_no_s3():
    from test_ingestion_routes import api_client

    receipt = {"version_id": "verified-fixture"}
    tx = FakeTransaction(
        one=[
            ("member",),
            (PROJECT_ID, "editor"),
            ("uploading", "sealed"),
            (
                0,
                "fixture",
                "private/key",
                "private/",
                "123456789012",
                "complete",
                None,
                12,
                FILE.sha256,
                receipt,
            ),
        ]
    )
    ingestion = PostgresIngestionRepository(FakeExecutor([tx]), FakeStorage())
    with api_client(ingestion) as client:
        path = f"/projects/{PROJECT_ID}/archive-uploads/{SESSION}/objects/0/prepare"
        headers = {"Authorization": "Bearer valid-token", "X-OpenGeo-Organization": str(ORG_ID)}
        response = client.post(path, headers=headers)
        assert response.status_code == 200, response.text
        assert response.json()["receipt"] == receipt
        assert client.post(path).status_code == 401
        assert client.post(path.replace("/0/", "/-1/"), headers=headers).status_code == 422
