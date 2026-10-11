import asyncio

import pytest

from opengeo_api.archive_upload_storage import PART_BYTES
from opengeo_api.archive_upload_transfers import ArchiveTransferRepository
from opengeo_api.archive_uploads import ArchiveUploadRepository
from opengeo_api.ingestion import IngestionConflict, PostgresIngestionRepository
from test_archive_uploads import CONTEXT, SESSION
from test_ingestion import PROJECT_ID, FakeExecutor, FakeStorage, FakeTransaction

SHA = "a" * 64
KEY = "bhutan/private/uploads/test/originals/file"


def row(state="prepared", upload=None, size=PART_BYTES + 3):
    return (
        0,
        "example-geodata",
        KEY,
        "bhutan/private/",
        "111111111111",
        state,
        upload,
        size,
        SHA,
        None,
    )


def tx(value):
    return FakeTransaction(
        one=[("member",), (PROJECT_ID, "editor"), ("uploading", "sealed"), value]
    )


class Executor(FakeExecutor):
    committed = 0

    async def run(self, context, operation):
        result = await super().run(context, operation)
        self.committed += 1
        return result


class Storage:
    def __init__(self, executor, fail=False):
        self.executor = executor
        self.fail = fail
        self.creates = 0
        self.signed = 0

    async def create(self, key, sha256):
        assert self.executor.committed == 1
        assert (key, sha256) == (KEY, SHA)
        self.creates += 1
        if self.fail:
            raise TimeoutError("uncertain response")
        return "s3-upload"

    async def find_uploads(self, key):
        return []

    def sign_part(self, key, upload, size, number, sha256):
        assert self.executor.committed == 1
        self.signed += 1
        return {"method": "PUT", "number": number}


def setup(transactions, fail=False):
    executor = Executor(transactions)
    storage = Storage(executor, fail)
    plans = ArchiveUploadRepository(PostgresIngestionRepository(executor, FakeStorage()))
    return ArchiveTransferRepository(plans, lambda *args: storage), storage


def test_create_intent_commits_before_s3_and_upload_id_saved_after():
    first, second = tx(row()), tx(row("creating"))
    repository, storage = setup([first, second])
    result = asyncio.run(repository.prepare(CONTEXT, PROJECT_ID, SESSION, 0))
    assert result["part_count"] == 2
    assert storage.creates == 1
    assert first.calls[-1][2][0] == "creating"
    assert second.calls[-1][2][0] == "s3-upload"


def test_lost_create_response_stays_unresolved_and_retry_never_creates_again():
    first = tx(row())
    repository, storage = setup([first], fail=True)
    with pytest.raises(TimeoutError):
        asyncio.run(repository.prepare(CONTEXT, PROJECT_ID, SESSION, 0))
    assert storage.creates == 1
    repository, storage = setup([tx(row("creating"))])
    with pytest.raises(IngestionConflict, match="archive_multipart_creation_unresolved"):
        asyncio.run(repository.prepare(CONTEXT, PROJECT_ID, SESSION, 0))
    assert storage.creates == 0


def test_resuming_known_upload_never_allocates_a_second_upload():
    repository, storage = setup([tx(row("uploading", "s3-upload"))])
    assert asyncio.run(repository.prepare(CONTEXT, PROJECT_ID, SESSION, 0))["part_count"] == 2
    assert storage.creates == 0


def test_part_checksum_committed_before_signing_and_changed_retry_denied():
    transaction = tx(row("uploading", "s3-upload"))
    transaction.one.append((3, SHA))
    repository, storage = setup([transaction])
    assert (
        asyncio.run(repository.part_ticket(CONTEXT, PROJECT_ID, SESSION, 0, 2, SHA))["number"] == 2
    )
    assert storage.signed == 1
    transaction = tx(row("uploading", "s3-upload"))
    transaction.one.append((3, "b" * 64))
    repository, storage = setup([transaction])
    with pytest.raises(IngestionConflict, match="archive_part_changed"):
        asyncio.run(repository.part_ticket(CONTEXT, PROJECT_ID, SESSION, 0, 2, SHA))
    assert storage.signed == 0


def test_start_requires_sealed_review_and_does_not_call_storage():
    transaction = FakeTransaction(one=[("member",), (PROJECT_ID, "editor"), ("planning", None)])
    repository, storage = setup([transaction])
    with pytest.raises(IngestionConflict, match="archive_plan_not_sealed"):
        asyncio.run(repository.start(CONTEXT, PROJECT_ID, SESSION))
    assert storage.creates == 0
    transaction = FakeTransaction(
        one=[("member",), (PROJECT_ID, "editor"), ("paused", "sealed"), (0,)]
    )
    repository, storage = setup([transaction])
    asyncio.run(repository.start(CONTEXT, PROJECT_ID, SESSION))
    assert len([call for call in transaction.calls if call[0] == "execute"]) == 2
    assert storage.creates == 0


class CompletionStorage(Storage):
    def __init__(self, executor, existing=False, wrong_part=False, lose_response=False):
        super().__init__(executor)
        self.existing = existing
        self.wrong_part = wrong_part
        self.lose_response = lose_response
        self.completed = 0
        self.inspections = []
        self.listed = 0

    async def inspect(self, key, size, sha, composite, version=None):
        self.inspections.append(version)
        if self.existing or self.completed:
            return {
                "bucket": "example-geodata",
                "key": KEY,
                "version_id": "version",
                "size_bytes": size,
                "sha256": sha,
                "storage_checksum_sha256": composite,
            }
        return None

    async def list_parts(self, key, upload, after):
        self.listed += 1
        return {
            "parts": [
                {"number": 1, "size": PART_BYTES, "sha256": SHA, "etag": "one"},
                {
                    "number": 2,
                    "size": 3,
                    "sha256": "b" * 64 if self.wrong_part else SHA,
                    "etag": "two",
                },
            ],
            "next_after": None,
        }

    async def complete(self, key, upload, size, parts):
        assert self.executor.committed == 2  # Read plan + committed completion intent.
        self.completed += 1
        if self.lose_response:
            raise TimeoutError("completion response lost")
        return {"version_id": "version"}


def completing_setup(*, existing=False, wrong_part=False, lose_response=False):
    first = tx(row("completing" if existing else "uploading", "s3-upload"))
    first.all_rows.append([(1, PART_BYTES, SHA), (2, 3, SHA)])
    if existing:
        transactions = [first, tx(row("completing", "s3-upload"))]
    else:
        transactions = [
            first,
            tx(row("uploading", "s3-upload")),
            tx(row("completing", "s3-upload")),
        ]
    executor = Executor(transactions)
    storage = CompletionStorage(executor, existing, wrong_part, lose_response)
    plans = ArchiveUploadRepository(PostgresIngestionRepository(executor, FakeStorage()))
    return ArchiveTransferRepository(plans, lambda *args: storage), storage, transactions


def test_completion_verifies_s3_parts_then_exact_version_and_persists_receipt():
    repository, storage, transactions = completing_setup()
    receipt = asyncio.run(repository.complete(CONTEXT, PROJECT_ID, SESSION, 0))
    assert receipt["version_id"] == "version"
    assert storage.inspections == [None, "version"]
    assert storage.completed == 1
    assert "state='complete',receipt" in transactions[-1].calls[-1][1]


def test_lost_completion_is_recovered_by_head_without_list_or_complete():
    repository, storage, transactions = completing_setup(lose_response=True)
    with pytest.raises(TimeoutError):
        asyncio.run(repository.complete(CONTEXT, PROJECT_ID, SESSION, 0))
    assert "state='completing'" in transactions[1].calls[-1][1]
    repository, storage, _ = completing_setup(existing=True)
    receipt = asyncio.run(repository.complete(CONTEXT, PROJECT_ID, SESSION, 0))
    assert receipt["version_id"] == "version"
    assert storage.listed == storage.completed == 0


def test_wrong_s3_part_never_completes_or_changes_uploading_state():
    repository, storage, transactions = completing_setup(wrong_part=True)
    with pytest.raises(IngestionConflict, match="archive_uploaded_part_mismatch"):
        asyncio.run(repository.complete(CONTEXT, PROJECT_ID, SESSION, 0))
    assert storage.completed == 0
    assert not any(call[0] == "execute" for call in transactions[0].calls)


def test_missing_single_object_does_not_lock_out_a_retry_upload():
    transaction = tx(row("uploading", size=12))
    repository, storage = setup([transaction])

    async def missing(*args):
        return None

    storage.inspect = missing
    with pytest.raises(IngestionConflict, match="archive_object_not_uploaded"):
        asyncio.run(repository.complete(CONTEXT, PROJECT_ID, SESSION, 0))
    assert not any(call[0] == "execute" for call in transaction.calls)


def test_uncertain_create_adopts_one_exact_upload_without_creating_another():
    repository, storage = setup([tx(row("creating")), tx(row("creating"))])

    async def found(key):
        return ["recovered-upload"]

    storage.find_uploads = found
    result = asyncio.run(repository.prepare(CONTEXT, PROJECT_ID, SESSION, 0))
    assert result["part_count"] == 2
    assert storage.creates == 0


def test_abort_verifies_absence_before_saving_aborted():
    first, last = tx(row("uploading", "s3-upload")), tx(row("aborting", "s3-upload"))
    repository, storage = setup([first, last])
    calls = []

    async def abort(key, upload):
        calls.append(("abort", upload))
        assert storage.executor.committed == 1

    async def absent(key, upload):
        calls.append(("verify", upload))
        return True

    storage.abort, storage.upload_absent = abort, absent
    assert asyncio.run(repository.abort_multipart(CONTEXT, PROJECT_ID, SESSION, 0)) == {
        "state": "aborted"
    }
    assert calls == [("abort", "s3-upload"), ("verify", "s3-upload")]
    assert "state='aborted'" in last.calls[-1][1]


def test_abort_with_parts_remaining_stays_pending():
    transaction = tx(row("uploading", "s3-upload"))
    repository, storage = setup([transaction])

    async def abort(*args):
        pass

    async def present(*args):
        return False

    storage.abort, storage.upload_absent = abort, present
    result = asyncio.run(repository.abort_multipart(CONTEXT, PROJECT_ID, SESSION, 0))
    assert result["state"] == "aborting"
    assert storage.executor.committed == 1


def test_never_allocated_multipart_cancel_is_durable_without_s3():
    transaction = tx(row())
    repository, storage = setup([transaction])
    assert (
        asyncio.run(repository.abort_multipart(CONTEXT, PROJECT_ID, SESSION, 0))["state"]
        == "aborted"
    )
    assert transaction.calls[-1][2][0] == "aborted"
    assert storage.creates == 0
