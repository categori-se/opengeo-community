import asyncio
from collections import deque
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest

from opengeo_api.ingestion import (
    CatalogFilters,
    IngestionAccessDenied,
    IngestionConflict,
    IngestionNotFound,
    IngestionProcessingHeld,
    Page,
    PostgresIngestionRepository,
    RepositoryObjectDraft,
    UploadDraft,
)
from opengeo_api.s3_uploads import StoredObject, UploadForm
from opengeo_api.tenant_database import TenantContext

USER_ID = UUID("20000000-0000-4000-8000-000000000001")
ORG_ID = UUID("10000000-0000-4000-8000-000000000001")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000001")
DATASET_ID = UUID("80000000-0000-4000-8000-000000000001")
UPLOAD_ID = UUID("81000000-0000-4000-8000-000000000001")
OBJECT_ID = UUID("82000000-0000-4000-8000-000000000001")
VERSION_ID = UUID("83000000-0000-4000-8000-000000000001")
JOB_ID = UUID("84000000-0000-4000-8000-000000000001")
TAG_ID = UUID("85000000-0000-4000-8000-000000000001")
CONNECTION_ID = UUID("86000000-0000-4000-8000-000000000001")
NOW = datetime(2026, 8, 20, 12, tzinfo=UTC)
UNEXPIRED_UPLOAD = datetime(2099, 1, 1, tzinfo=UTC)
SHA256 = "a" * 64
OBJECT_KEY = (
    f"organizations/{ORG_ID}/projects/{PROJECT_ID}/datasets/{DATASET_ID}/"
    f"uploads/{UPLOAD_ID}/original/roads.gpkg"
)
GEOJSON_OBJECT_KEY = OBJECT_KEY.removesuffix("roads.gpkg") + "roads.geojson"


class FakeTransaction:
    def __init__(
        self,
        *,
        one: list[tuple[Any, ...] | None] | None = None,
        all_rows: list[list[tuple[Any, ...]]] | None = None,
        execute_results: list[int] | None = None,
    ) -> None:
        self.one = deque(one or [])
        self.all_rows = deque(all_rows or [])
        self.execute_results = deque(execute_results or [])
        self.calls: list[tuple[str, str, tuple[Any, ...]]] = []

    async def fetch_one(self, statement, parameters=()):
        self.calls.append(("one", statement, tuple(parameters)))
        assert self.one, f"unexpected fetch_one: {statement}"
        return self.one.popleft()

    async def fetch_all(self, statement, parameters=()):
        self.calls.append(("all", statement, tuple(parameters)))
        assert self.all_rows, f"unexpected fetch_all: {statement}"
        return self.all_rows.popleft()

    async def execute(self, statement, parameters=()):
        self.calls.append(("execute", statement, tuple(parameters)))
        return self.execute_results.popleft() if self.execute_results else 1


class FakeExecutor:
    def __init__(self, transactions: list[FakeTransaction]) -> None:
        self.transactions = deque(transactions)
        self.contexts: list[TenantContext] = []

    async def run(self, context, operation):
        self.contexts.append(context)
        assert self.transactions
        return await operation(self.transactions.popleft())

    async def fetch_one(self, context, statement, parameters=()):
        del statement, parameters
        self.contexts.append(context)
        raise AssertionError("direct fetch was not expected")


class FakeStorage:
    def __init__(self, *, stored: StoredObject | None = None) -> None:
        self._stored = stored or stored_object()
        self.form_specs = []
        self.inspected_keys: list[str] = []

    @property
    def bucket(self) -> str:
        return "geodata-test"

    async def create_upload_form(self, spec):
        self.form_specs.append(spec)
        return UploadForm(
            url="https://geodata-test.s3.us-east-1.amazonaws.com/",
            method="POST",
            fields={"key": spec.key, "policy": "signed"},
            expires_at=NOW + timedelta(minutes=15),
        )

    async def inspect_object(self, key):
        self.inspected_keys.append(key)
        return self._stored


def context() -> TenantContext:
    return TenantContext(USER_ID, ORG_ID)


def draft() -> UploadDraft:
    return UploadDraft(
        name="Road network",
        description="Authoritative roads",
        classification="restricted",
        format="geopackage",
        original_filename="roads.gpkg",
        content_type="application/geopackage+sqlite3",
        size_bytes=1234,
        checksum_sha256=SHA256,
        tags=("roads",),
    )


def dataset_row(
    *,
    processing: bool = False,
    permission: str | None = None,
    owner: bool = True,
    project_role: str | None = "editor",
    geojson: bool = False,
    preserved: bool = False,
) -> tuple[Any, ...]:
    return (
        DATASET_ID,
        PROJECT_ID,
        "Road network",
        "Authoritative roads",
        "restricted",
        "upload",
        "geojson" if geojson or preserved else "geopackage",
        "processing" if processing else "draft",
        USER_ID,
        VERSION_ID if processing or preserved else None,
        1 if processing or preserved else None,
        "preserved" if preserved else "queued" if processing else None,
        None,
        None,
        None,
        None,
        {},
        "queued" if processing else None,
        None,
        ["roads"],
        NOW,
        NOW,
        permission,
        owner,
        project_role,
    )


def upload_row(*, completed: bool = False, purpose: str = "ingest") -> tuple[Any, ...]:
    return (
        UPLOAD_ID,
        DATASET_ID,
        PROJECT_ID,
        GEOJSON_OBJECT_KEY if purpose == "pmtiles_original" else OBJECT_KEY,
        "geodata-test",
        "roads.geojson" if purpose == "pmtiles_original" else "roads.gpkg",
        "application/geo+json"
        if purpose == "pmtiles_original"
        else "application/geopackage+sqlite3",
        1234,
        SHA256,
        "completed" if completed else "pending",
        UNEXPIRED_UPLOAD,
        OBJECT_ID if completed else None,
        purpose,
        None,
    )


def stored_object(**changes: Any) -> StoredObject:
    values = {
        "bucket": "geodata-test",
        "key": OBJECT_KEY,
        "version_id": "s3-version-1",
        "etag": "etag-1",
        "content_type": "application/geopackage+sqlite3",
        "size_bytes": 1234,
        "checksum_sha256": SHA256,
        **changes,
    }
    return StoredObject(**values)


def repository_object_draft(**changes: Any) -> RepositoryObjectDraft:
    values = {
        "connection_id": CONNECTION_ID,
        "expected_target_revision": 3,
        "relative_path": "environment/screen.geojson",
        "provider_version_id": "s3-version-0001",
        "name": "MassGIS screen",
        "description": "Exact repository reference",
        "classification": "internal",
        "format": "geojson",
        "size_bytes": 4096,
        "last_modified": NOW,
        "content_type": "application/geo+json",
        "etag": '"etag-0001"',
        "storage_class": "STANDARD",
        "provider_checksum_sha256": "A" * 43 + "=",
        "tags": ("massgis",),
        **changes,
    }
    return RepositoryObjectDraft(**values)


def repository_object_source_row() -> tuple[Any, ...]:
    return (
        DATASET_ID,
        CONNECTION_ID,
        3,
        "s3",
        "example-geodata",
        "us-east-1",
        "usa/ma/",
        "environment/screen.geojson",
        "s3-version-0001",
        4096,
        NOW,
        "application/geo+json",
        '"etag-0001"',
        "STANDARD",
        "A" * 43 + "=",
        USER_ID,
        NOW,
    )


def repository_dataset_row(*, project_role: str = "editor") -> tuple[Any, ...]:
    row = list(dataset_row(project_role=project_role))
    row[2:8] = [
        "MassGIS screen",
        "Exact repository reference",
        "internal",
        "repository",
        "geojson",
        "active",
    ]
    row[19] = ["massgis"]
    return tuple(row)


def project_access(role: str = "editor") -> list[tuple[Any, ...]]:
    return [("member",), (PROJECT_ID, role)]


def test_exact_repository_object_registration_creates_one_governed_source_atomically(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("opengeo_api.ingestion.uuid4", lambda: DATASET_ID)
    transaction = FakeTransaction(
        one=[
            *project_access(),
            ("s3", "example-geodata", "us-east-1", "usa/ma/", 3, "verified"),
            None,
            (TAG_ID,),
            repository_object_source_row(),
            repository_dataset_row(),
        ]
    )
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())

    registration = asyncio.run(
        repository.register_repository_object(
            context(), PROJECT_ID, repository_object_draft(), "repository-register"
        )
    )

    assert registration.created is True
    assert registration.attached is True
    assert registration.dataset.dataset_id == DATASET_ID
    assert registration.dataset.source_type == "repository"
    assert registration.source.provider_version_id == "s3-version-0001"
    connection_read = next(
        call for call in transaction.calls if "FROM app.user_dataset_connections" in call[1]
    )
    assert "owner_user_id = %s" in connection_read[1]
    assert "FOR UPDATE" in connection_read[1]
    statements = [call[1] for call in transaction.calls]
    assert any("INSERT INTO app.datasets" in statement for statement in statements)
    assert any("INSERT INTO app.repository_object_sources" in statement for statement in statements)
    assert any("INSERT INTO app.project_datasets" in statement for statement in statements)
    activity = next(
        call for call in transaction.calls if "INSERT INTO app.activity_events" in call[1]
    )
    assert activity[2][0:6] == (
        ORG_ID,
        USER_ID,
        PROJECT_ID,
        "dataset.repository_object.registered",
        DATASET_ID,
        "repository-register",
    )


def test_exact_repository_object_registration_reuses_and_attaches_existing_source() -> None:
    transaction = FakeTransaction(
        one=[
            *project_access(),
            ("s3", "example-geodata", "us-east-1", "usa/ma/", 3, "verified"),
            repository_object_source_row(),
            repository_dataset_row(),
        ]
    )
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())

    registration = asyncio.run(
        repository.register_repository_object(
            context(), PROJECT_ID, repository_object_draft(), "repository-reuse"
        )
    )

    assert registration.created is False
    assert registration.attached is True
    assert not any("INSERT INTO app.datasets" in call[1] for call in transaction.calls)
    assert not any(
        "INSERT INTO app.repository_object_sources" in call[1] for call in transaction.calls
    )
    activity = next(
        call for call in transaction.calls if "INSERT INTO app.activity_events" in call[1]
    )
    assert activity[2][3] == "project.dataset.attached"


def test_repository_object_registration_rejects_changed_connection_before_source_write() -> None:
    transaction = FakeTransaction(
        one=[
            *project_access(),
            ("s3", "example-geodata", "us-east-1", "usa/ma/", 4, "verified"),
        ]
    )
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())

    with pytest.raises(IngestionConflict, match="connection_target_changed"):
        asyncio.run(
            repository.register_repository_object(
                context(), PROJECT_ID, repository_object_draft(), "repository-stale"
            )
        )

    assert not any(call[0] == "execute" for call in transaction.calls)
    assert not any("FROM app.repository_object_sources" in call[1] for call in transaction.calls)


def test_repository_object_source_read_requires_project_dataset_access() -> None:
    transaction = FakeTransaction(
        one=[
            *project_access("viewer"),
            repository_dataset_row(project_role="viewer"),
            repository_object_source_row(),
        ]
    )
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())

    source = asyncio.run(repository.get_repository_object_source(context(), PROJECT_ID, DATASET_ID))

    assert source.dataset_id == DATASET_ID
    assert source.bucket_name == "example-geodata"
    assert source.relative_path == "environment/screen.geojson"
    source_query = transaction.calls[-1]
    assert "JOIN app.project_datasets" in source_query[1]
    assert source_query[2] == (ORG_ID, DATASET_ID, PROJECT_ID)


def test_upload_is_preauthorized_before_signing_and_rechecked_before_persistence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("opengeo_api.ingestion.uuid4", deque([DATASET_ID, UPLOAD_ID]).popleft)
    preauthorization = FakeTransaction(one=project_access())
    creation = FakeTransaction(one=[*project_access(), (TAG_ID,), dataset_row()])
    executor = FakeExecutor([preauthorization, creation])
    storage = FakeStorage()
    repository = PostgresIngestionRepository(executor, storage)

    ticket = asyncio.run(
        repository.request_upload(context(), PROJECT_ID, draft(), "request-upload")
    )

    assert ticket.upload_id == UPLOAD_ID
    assert ticket.dataset.status == "draft"
    assert executor.contexts == [context(), context()]
    assert storage.form_specs[0].key == OBJECT_KEY
    assert storage.form_specs[0].checksum_sha256 == SHA256
    statements = [call[1] for call in creation.calls]
    assert any("INSERT INTO app.datasets" in statement for statement in statements)
    assert any("INSERT INTO app.upload_intents" in statement for statement in statements)
    dataset_insert = next(
        statement for statement in statements if "INSERT INTO app.datasets" in statement
    )
    # RDS Data API binds strings as text, unlike untyped PostgreSQL literals.
    assert "%s::app.dataset_classification" in dataset_insert
    assert "%s::app.dataset_format" in dataset_insert
    activity = next(call for call in creation.calls if "INSERT INTO app.activity_events" in call[1])
    assert activity[2][0:6] == (
        ORG_ID,
        USER_ID,
        PROJECT_ID,
        "dataset.upload.requested",
        DATASET_ID,
        "request-upload",
    )


def test_viewer_is_denied_before_storage_signing_or_write() -> None:
    transaction = FakeTransaction(one=project_access("viewer"))
    storage = FakeStorage()
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), storage)

    with pytest.raises(IngestionAccessDenied):
        asyncio.run(repository.request_upload(context(), PROJECT_ID, draft(), "denied"))

    assert storage.form_specs == []
    assert all(call[0] == "one" for call in transaction.calls)


def test_completion_verifies_object_then_commits_version_job_and_activity_atomically(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "opengeo_api.ingestion.uuid4",
        deque([OBJECT_ID, VERSION_ID, JOB_ID]).popleft,
    )
    initial = FakeTransaction(one=[*project_access(), upload_row()])
    completion = FakeTransaction(
        one=[
            *project_access(),
            upload_row(),
            (True,),
            (DATASET_ID,),
            (1,),
            dataset_row(processing=True),
        ]
    )
    executor = FakeExecutor([initial, completion])
    storage = FakeStorage()
    repository = PostgresIngestionRepository(executor, storage)

    result = asyncio.run(
        repository.complete_upload(context(), PROJECT_ID, UPLOAD_ID, "request-complete")
    )

    assert result.dataset_version_id == VERSION_ID
    assert result.processing_job_id == JOB_ID
    assert result.dataset.status == "processing"
    assert storage.inspected_keys == [OBJECT_KEY]
    statements = [call[1] for call in completion.calls]
    for fragment in (
        "INSERT INTO app.data_objects",
        "INSERT INTO app.dataset_versions",
        "UPDATE app.upload_intents",
        "INSERT INTO app.processing_jobs",
        "INSERT INTO app.activity_events",
    ):
        assert any(fragment in statement for statement in statements)


def test_mismatched_size_checksum_or_content_type_never_starts_completion_transaction() -> None:
    for change in (
        {"size_bytes": 1235},
        {"checksum_sha256": "b" * 64},
        {"content_type": "application/octet-stream"},
        {"key": f"{OBJECT_KEY}-other"},
    ):
        initial = FakeTransaction(one=[*project_access(), upload_row()])
        executor = FakeExecutor([initial])
        repository = PostgresIngestionRepository(
            executor, FakeStorage(stored=stored_object(**change))
        )

        with pytest.raises(IngestionConflict) as caught:
            asyncio.run(repository.complete_upload(context(), PROJECT_ID, UPLOAD_ID, "mismatch"))

        assert caught.value.code == "upload_verification_failed"
        assert executor.contexts == [context()]


def test_completed_upload_retry_is_idempotent_without_rechecking_s3() -> None:
    initial = FakeTransaction(one=[*project_access(), upload_row(completed=True)])
    newer_head = list(dataset_row(processing=True))
    newer_head[9] = UUID("90000000-0000-4000-8000-000000000099")
    newer_head[10] = 2
    existing = FakeTransaction(
        one=[
            *project_access(),
            tuple(newer_head),
            (VERSION_ID, 1, JOB_ID, "queued"),
        ]
    )
    storage = FakeStorage()
    repository = PostgresIngestionRepository(FakeExecutor([initial, existing]), storage)

    result = asyncio.run(
        repository.complete_upload(
            context(), PROJECT_ID, UPLOAD_ID, "retry", allowed_purposes=frozenset()
        )
    )

    assert result.dataset_version_id == VERSION_ID
    assert result.processing_job_id == JOB_ID
    assert storage.inspected_keys == []
    assert result.dataset.current_version_id == newer_head[9]
    assert existing.calls[-1][2] == (ORG_ID, DATASET_ID, OBJECT_ID)
    assert "version.original_object_id = %s" in existing.calls[-1][1]
    assert all(call[0] != "execute" for call in existing.calls)


def test_pmtiles_original_request_freezes_purpose_and_rejects_staging_before_signing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("opengeo_api.ingestion.uuid4", deque([DATASET_ID, UPLOAD_ID]).popleft)
    original = replace(
        draft(),
        purpose="pmtiles_original",
        format="geojson",
        original_filename="roads.geojson",
        content_type="application/geo+json",
    )
    preauthorization = FakeTransaction(one=project_access())
    creation = FakeTransaction(one=[*project_access(), (TAG_ID,), dataset_row(geojson=True)])
    storage = FakeStorage()
    repository = PostgresIngestionRepository(FakeExecutor([preauthorization, creation]), storage)
    with pytest.raises(IngestionConflict, match="pmtiles_original_upload_unsupported"):
        asyncio.run(
            repository.request_upload(
                context(),
                PROJECT_ID,
                original,
                "staged",
                staged_target=(DATASET_ID, VERSION_ID),
                allowed_purposes=frozenset({"pmtiles_original"}),
            )
        )
    assert storage.form_specs == []

    ticket = asyncio.run(
        repository.request_upload(
            context(),
            PROJECT_ID,
            original,
            "preserve",
            allowed_purposes=frozenset({"pmtiles_original"}),
        )
    )
    assert ticket.purpose == "pmtiles_original"
    assert ticket.dataset.status == "draft"
    intent_insert = next(
        call for call in creation.calls if "INSERT INTO app.upload_intents" in call[1]
    )
    assert intent_insert[2][-2:] == (None, "pmtiles_original")
    assert storage.form_specs[0].key.endswith(f"uploads/{UPLOAD_ID}/original/roads.geojson")
    assert not any("INSERT INTO app.processing_jobs" in call[1] for call in creation.calls)


def test_pmtiles_original_completion_preserves_pins_without_inspection_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("opengeo_api.ingestion.uuid4", deque([OBJECT_ID, VERSION_ID]).popleft)
    intent = upload_row(purpose="pmtiles_original")
    initial = FakeTransaction(one=[*project_access(), intent, dataset_row(geojson=True)])
    completion = FakeTransaction(
        one=[
            *project_access(),
            intent,
            (True,),
            (DATASET_ID,),
            dataset_row(geojson=True),
            (1,),
            dataset_row(preserved=True),
        ]
    )
    storage = FakeStorage(
        stored=stored_object(
            key=GEOJSON_OBJECT_KEY,
            content_type="application/geo+json",
        )
    )
    repository = PostgresIngestionRepository(FakeExecutor([initial, completion]), storage)
    result = asyncio.run(
        repository.complete_upload(
            context(),
            PROJECT_ID,
            UPLOAD_ID,
            "preserve",
            allowed_purposes=frozenset({"pmtiles_original"}),
        )
    )

    assert result.purpose == "pmtiles_original"
    assert result.processing_job_id is None
    assert result.processing_job_state is None
    assert result.dataset.status == "draft"
    assert result.dataset.current_version_id == VERSION_ID
    assert result.dataset.current_version_state == "preserved"
    assert result.dataset.feature_count is None
    assert result.dataset.quality_results == {}
    assert storage.inspected_keys == [GEOJSON_OBJECT_KEY]
    writes = [call for call in completion.calls if call[0] == "execute"]
    original = next(call for call in writes if "INSERT INTO app.data_objects" in call[1])
    assert original[2][3:10] == (
        "geodata-test",
        GEOJSON_OBJECT_KEY,
        "s3-version-1",
        "etag-1",
        "application/geo+json",
        1234,
        SHA256,
    )
    version = next(call for call in writes if "INSERT INTO app.dataset_versions" in call[1])
    assert version[2][4:6] == (OBJECT_ID, "preserved")
    assert version[2][-1] is None
    assert not any("processing_jobs" in call[1] for call in writes)
    assert not any("spatial_metadata" in call[1] or "feature_count" in call[1] for call in writes)
    intent_index = next(
        i for i, call in enumerate(writes) if "UPDATE app.upload_intents" in call[1]
    )
    pointer_index = next(i for i, call in enumerate(writes) if "UPDATE app.datasets" in call[1])
    assert intent_index < pointer_index
    assert "status = 'processing'" not in writes[pointer_index][1]


def test_preserved_completion_readback_survives_disabled_mode_without_object_access() -> None:
    initial = FakeTransaction(
        one=[
            *project_access(),
            upload_row(completed=True, purpose="pmtiles_original"),
        ]
    )
    existing = FakeTransaction(
        one=[
            *project_access(),
            dataset_row(preserved=True),
            (VERSION_ID, 1, None, None),
        ]
    )
    storage = FakeStorage()
    repository = PostgresIngestionRepository(FakeExecutor([initial, existing]), storage)
    result = asyncio.run(
        repository.complete_upload(
            context(),
            PROJECT_ID,
            UPLOAD_ID,
            "readback",
            allowed_purposes=frozenset(),
        )
    )
    assert result.purpose == "pmtiles_original"
    assert result.processing_job_id is None
    assert result.dataset_version_id == VERSION_ID
    assert storage.inspected_keys == []
    assert not any(call[0] == "execute" for call in existing.calls)
    assert "version.state::text = 'preserved'" in existing.calls[-1][1]


@pytest.mark.parametrize("operation", ["renew_upload", "complete_upload"])
def test_pending_ingest_purpose_is_held_before_signing_or_object_access(operation) -> None:
    transaction = FakeTransaction(one=[*project_access(), upload_row()])
    storage = FakeStorage()
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), storage)
    with pytest.raises(IngestionProcessingHeld, match="shared_worker_processing_held"):
        asyncio.run(
            getattr(repository, operation)(
                context(),
                PROJECT_ID,
                UPLOAD_ID,
                "held",
                allowed_purposes=frozenset({"pmtiles_original"}),
            )
        )
    assert storage.form_specs == []
    assert storage.inspected_keys == []
    assert not any(call[0] == "execute" for call in transaction.calls)


def test_preservation_rechecks_draft_current_pointer_after_object_head() -> None:
    intent = upload_row(purpose="pmtiles_original")
    initial = FakeTransaction(one=[*project_access(), intent, dataset_row(geojson=True)])
    completion = FakeTransaction(
        one=[
            *project_access(),
            intent,
            (True,),
            (DATASET_ID,),
            dataset_row(preserved=True),
        ]
    )
    storage = FakeStorage(
        stored=stored_object(
            key=GEOJSON_OBJECT_KEY,
            content_type="application/geo+json",
        )
    )
    repository = PostgresIngestionRepository(FakeExecutor([initial, completion]), storage)
    with pytest.raises(IngestionConflict, match="upload_dataset_changed"):
        asyncio.run(
            repository.complete_upload(
                context(),
                PROJECT_ID,
                UPLOAD_ID,
                "concurrent",
                allowed_purposes=frozenset({"pmtiles_original"}),
            )
        )
    assert storage.inspected_keys == [GEOJSON_OBJECT_KEY]
    assert not any(call[0] == "execute" for call in completion.calls)


def test_catalog_list_requires_project_access_and_returns_logical_version_metadata() -> None:
    transaction = FakeTransaction(
        one=project_access("reviewer"), all_rows=[[dataset_row(processing=True)]]
    )
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())

    records = asyncio.run(repository.list_datasets(context(), PROJECT_ID, Page()))

    assert records[0].current_version_number == 1
    assert records[0].tags == ("roads",)
    query = next(call for call in transaction.calls if call[0] == "all")
    assert "project_dataset.project_id = %s" in query[1]
    assert query[2][0:3] == (ORG_ID, PROJECT_ID, True)
    assert query[2][-2:] == (50, 0)


def test_organization_catalog_includes_dataset_owner_and_uses_one_authorized_link() -> None:
    transaction = FakeTransaction(
        one=[("member",)],
        all_rows=[[dataset_row(processing=True, project_role=None)]],
    )
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())

    records = asyncio.run(
        repository.search_datasets(
            context(),
            Page(limit=25),
            CatalogFilters(query="Road network", tag="roads", source_type="upload"),
        )
    )

    assert len(records) == 1
    assert records[0].capabilities.read is True
    assert records[0].capabilities.edit is True
    assert records[0].capabilities.download is True
    assert records[0].capabilities.manage_permissions is True
    query = next(call for call in transaction.calls if call[0] == "all")
    assert "DISTINCT ON (project_dataset.dataset_id)" in query[1]
    assert "authorized_dataset.owner_user_id = app.current_user_id()" in query[1]
    assert "dataset.search_document @@ websearch_to_tsquery" in query[1]


def test_dataset_owner_attaches_one_dataset_to_another_editable_project_atomically() -> None:
    transaction = FakeTransaction(
        one=[
            ("member",),
            (PROJECT_ID, "editor"),
            (DATASET_ID, True, None, None),
            dataset_row(project_role="editor"),
        ]
    )
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())

    attached = asyncio.run(
        repository.attach_dataset(context(), PROJECT_ID, DATASET_ID, "attach-request")
    )

    assert attached.dataset_id == DATASET_ID
    statements = [call[1] for call in transaction.calls]
    assert any(
        "ON CONFLICT (organization_id, project_id, dataset_id) DO NOTHING" in sql
        for sql in statements
    )
    activity = next(
        call for call in transaction.calls if "INSERT INTO app.activity_events" in call[1]
    )
    assert activity[2][0:6] == (
        ORG_ID,
        USER_ID,
        PROJECT_ID,
        "project.dataset.attached",
        DATASET_ID,
        "attach-request",
    )


def test_repeated_dataset_attachment_is_idempotent_and_does_not_repeat_activity() -> None:
    transaction = FakeTransaction(
        one=[
            ("member",),
            (PROJECT_ID, "owner"),
            (DATASET_ID, True, None, "owner"),
            dataset_row(project_role="owner"),
        ],
        execute_results=[0],
    )
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())

    attached = asyncio.run(
        repository.attach_dataset(context(), PROJECT_ID, DATASET_ID, "attach-repeat")
    )

    assert attached.dataset_id == DATASET_ID
    assert not any("INSERT INTO app.activity_events" in call[1] for call in transaction.calls)


def test_dataset_attachment_requires_target_editing_and_source_sharing_authority() -> None:
    target_denied = FakeTransaction(one=[("member",), (PROJECT_ID, "reviewer")])
    repository = PostgresIngestionRepository(FakeExecutor([target_denied]), FakeStorage())
    with pytest.raises(IngestionAccessDenied):
        asyncio.run(repository.attach_dataset(context(), PROJECT_ID, DATASET_ID, "target-denied"))

    source_denied = FakeTransaction(
        one=[
            ("member",),
            (PROJECT_ID, "editor"),
            (DATASET_ID, False, "view", "editor"),
        ]
    )
    repository = PostgresIngestionRepository(FakeExecutor([source_denied]), FakeStorage())
    with pytest.raises(IngestionAccessDenied):
        asyncio.run(repository.attach_dataset(context(), PROJECT_ID, DATASET_ID, "source-denied"))

    assert all(call[0] == "one" for call in target_denied.calls + source_denied.calls)


def test_dataset_detach_locks_the_link_and_rejects_referenced_maps_before_delete() -> None:
    transaction = FakeTransaction(one=[("member",), (PROJECT_ID, "owner"), (1,), (True,)])
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())

    with pytest.raises(IngestionConflict, match="project_dataset_in_use"):
        asyncio.run(repository.detach_dataset(context(), PROJECT_ID, DATASET_ID, "detach-in-use"))

    assert "FOR UPDATE" in transaction.calls[2][1]
    assert "jsonb_array_elements" in transaction.calls[3][1]
    assert "app.external_source_snapshot_jobs" in transaction.calls[3][1]
    assert "snapshot.source_dataset_id" in transaction.calls[3][1]
    assert "snapshot.destination_dataset_id" in transaction.calls[3][1]
    assert "app.pmtiles_derivative_jobs" in transaction.calls[3][1]
    assert "derivative.state IN ('queued', 'running')" in transaction.calls[3][1]
    assert not any(call[0] == "execute" for call in transaction.calls)


def test_unreferenced_dataset_detach_and_activity_commit_in_one_transaction() -> None:
    transaction = FakeTransaction(one=[("member",), (PROJECT_ID, "editor"), (1,), (False,)])
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())

    asyncio.run(repository.detach_dataset(context(), PROJECT_ID, DATASET_ID, "detach-request"))

    deletion = next(
        call
        for call in transaction.calls
        if call[0] == "execute" and "DELETE FROM app.project_datasets" in call[1]
    )
    assert deletion[2] == (ORG_ID, PROJECT_ID, DATASET_ID)
    activity = next(
        call for call in transaction.calls if "INSERT INTO app.activity_events" in call[1]
    )
    assert activity[2][0:6] == (
        ORG_ID,
        USER_ID,
        PROJECT_ID,
        "project.dataset.detached",
        DATASET_ID,
        "detach-request",
    )


@pytest.mark.parametrize(
    "organization,permission,owner,project_role",
    [
        ("member", None, False, "viewer"),
        ("member", "view", False, None),
        ("member", None, True, None),
        ("admin", None, False, None),
    ],
)
def test_catalog_dataset_resolves_existing_identity(organization, permission, owner, project_role):
    transaction = FakeTransaction(
        one=[
            (organization,),
            dataset_row(permission=permission, owner=owner, project_role=project_role),
        ]
    )
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())
    result = asyncio.run(repository.get_catalog_dataset(context(), DATASET_ID))
    assert result.dataset_id == DATASET_ID
    assert result.capabilities.read
    assert transaction.calls[1][2] == (ORG_ID, DATASET_ID, organization == "admin")


@pytest.mark.parametrize("row", [None, dataset_row(owner=False, project_role=None)])
def test_catalog_dataset_hides_missing_and_unauthorized_records(row):
    transaction = FakeTransaction(one=[("member",), row])
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())
    with pytest.raises(IngestionNotFound):
        asyncio.run(repository.get_catalog_dataset(context(), DATASET_ID))


def test_catalog_dataset_requires_account_membership():
    transaction = FakeTransaction(one=[None])
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())
    with pytest.raises(IngestionAccessDenied):
        asyncio.run(repository.get_catalog_dataset(context(), DATASET_ID))
    assert len(transaction.calls) == 1


def test_metadata_save_is_version_checked_and_bound_to_dataset_not_project():
    from opengeo_api.resource_knowledge import empty_knowledge

    document = empty_knowledge()
    transaction = FakeTransaction(
        one=[
            (DATASET_ID,),
            ("member",),
            dataset_row(),
            None,
            (1, document, USER_ID, NOW),
        ]
    )
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())
    result = asyncio.run(repository.save_dataset_knowledge(context(), DATASET_ID, document, 0))
    assert result["version"] == 1
    assert result["dataset_id"] == DATASET_ID
    assert "FOR UPDATE" in transaction.calls[0][1]
    assert transaction.calls[-1][2][:3] == (ORG_ID, DATASET_ID, 1)
    assert "UPDATE app.datasets" not in transaction.calls[-1][1]


def test_metadata_conflict_retains_previous_revision():
    from opengeo_api.resource_knowledge import empty_knowledge

    transaction = FakeTransaction(one=[(DATASET_ID,), ("member",), dataset_row(), (2,)])
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())
    with pytest.raises(IngestionConflict, match="metadata_version_conflict"):
        asyncio.run(repository.save_dataset_knowledge(context(), DATASET_ID, empty_knowledge(), 1))
    assert all("INSERT" not in call[1] for call in transaction.calls)


def test_metadata_viewer_cannot_write():
    from opengeo_api.resource_knowledge import empty_knowledge

    transaction = FakeTransaction(
        one=[
            (DATASET_ID,),
            ("member",),
            dataset_row(owner=False, project_role="viewer"),
        ]
    )
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())
    with pytest.raises(IngestionAccessDenied):
        asyncio.run(repository.save_dataset_knowledge(context(), DATASET_ID, empty_knowledge(), 0))
    assert all("INSERT" not in call[1] for call in transaction.calls)


def test_metadata_empty_and_historic_reads_do_not_create_records():
    from opengeo_api.resource_knowledge import empty_knowledge

    empty = FakeTransaction(one=[("member",), dataset_row(), None])
    missing = FakeTransaction(one=[("member",), dataset_row(), None])
    repository = PostgresIngestionRepository(FakeExecutor([empty, missing]), FakeStorage())
    result = asyncio.run(repository.get_dataset_knowledge(context(), DATASET_ID))
    assert result["version"] == 0
    assert result["document"] == empty_knowledge()
    with pytest.raises(IngestionNotFound):
        asyncio.run(repository.get_dataset_knowledge(context(), DATASET_ID, 7))
    assert all("INSERT" not in call[1] for call in empty.calls + missing.calls)


def test_refresh_acceptance_rechecks_revisions_under_dataset_lock():
    from opengeo_api.metadata_refresh import MetadataRefresh
    from opengeo_api.resource_knowledge import empty_knowledge
    from test_metadata_refresh import JOB, source

    document = empty_knowledge()
    transaction = FakeTransaction(
        one=[
            (DATASET_ID,),
            ("member",),
            dataset_row(),
            (1, document),
            ("member",),
            (PROJECT_ID, "editor"),
            source(),
            (2, document, USER_ID, NOW),
        ]
    )
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())
    result = asyncio.run(
        repository.save_dataset_knowledge(
            context(),
            DATASET_ID,
            empty_knowledge(),
            1,
            refresh=MetadataRefresh(PROJECT_ID, JOB, 2),
        )
    )
    assert result["version"] == 2
    assert "FOR UPDATE" in transaction.calls[0][1]
    inserted = transaction.calls[-1][2][3].obj
    assert inserted["metadata"]["source"][0]["content"] == ' {"license": null}\n'


def test_refresh_acceptance_rejects_changed_source_before_insert():
    from opengeo_api.metadata_refresh import MetadataRefresh
    from opengeo_api.resource_knowledge import empty_knowledge
    from test_metadata_refresh import JOB, source

    transaction = FakeTransaction(
        one=[
            (DATASET_ID,),
            ("member",),
            dataset_row(),
            (1, empty_knowledge()),
            ("member",),
            (PROJECT_ID, "editor"),
            source(),
        ]
    )
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())
    with pytest.raises(IngestionConflict, match="metadata_refresh_source_conflict"):
        asyncio.run(
            repository.save_dataset_knowledge(
                context(),
                DATASET_ID,
                empty_knowledge(),
                1,
                refresh=MetadataRefresh(PROJECT_ID, JOB, 1),
            )
        )
    assert all("INSERT" not in call[1] for call in transaction.calls)


def test_stored_refresh_acceptance_rechecks_exact_document_under_dataset_lock():
    import copy

    from opengeo_api.metadata_refresh import MetadataRefresh
    from opengeo_api.resource_knowledge import empty_knowledge
    from test_metadata_refresh import JOB, stored_source

    for substituted in [False, True]:
        source = stored_source()
        verified = copy.deepcopy(source[3])
        if substituted:
            verified["object"]["version_id"] = "different-object-version"
        transaction = FakeTransaction(
            one=[
                (DATASET_ID,),
                ("member",),
                dataset_row(),
                (1, empty_knowledge()),
                ("member",),
                (PROJECT_ID, "editor"),
                source,
                (2, empty_knowledge(), USER_ID, NOW),
            ]
        )
        repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())
        action = repository.save_dataset_knowledge(
            context(),
            DATASET_ID,
            empty_knowledge(),
            1,
            refresh=MetadataRefresh(PROJECT_ID, JOB, 2, verified),
        )
        if substituted:
            with pytest.raises(IngestionConflict, match="metadata_refresh_response_invalid"):
                asyncio.run(action)
            assert all("INSERT" not in call[1] for call in transaction.calls)
        else:
            assert asyncio.run(action)["version"] == 2
            inserted = transaction.calls[-1][2][3].obj
            assert inserted["metadata"]["source"][0]["retainedResponse"]["datasetId"] == str(
                DATASET_ID
            )
        assert "FOR UPDATE" in transaction.calls[0][1]


def test_ordinary_metadata_save_cannot_fabricate_stored_response_reference():
    from opengeo_api.metadata_refresh import append_refresh_source
    from opengeo_api.resource_knowledge import empty_knowledge
    from test_metadata_refresh import JOB, stored_source

    source = stored_source()
    candidate = append_refresh_source(
        empty_knowledge(),
        source,
        JOB,
        dataset_id=DATASET_ID,
        project_id=PROJECT_ID,
        verified_document=source[3],
    )
    for previous, allowed in [(empty_knowledge(), False), (candidate, True)]:
        transaction = FakeTransaction(
            one=[
                (DATASET_ID,),
                ("member",),
                dataset_row(),
                (1, previous),
                (2, candidate, USER_ID, NOW),
            ]
        )
        repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())
        action = repository.save_dataset_knowledge(context(), DATASET_ID, candidate, 1)
        if allowed:
            assert asyncio.run(action)["version"] == 2
        else:
            with pytest.raises(IngestionConflict, match="metadata_retained_source_conflict"):
                asyncio.run(action)
            assert all("INSERT" not in call[1] for call in transaction.calls)


def active_upload_row():
    row = list(dataset_row(processing=True))
    row[7] = "active"
    row[11] = "active"
    return tuple(row)


def test_staged_upload_registration_reuses_layer_without_catalog_mutation():
    before = FakeTransaction(one=[*project_access(), active_upload_row()])
    created = FakeTransaction(
        one=[*project_access(), (DATASET_ID,), active_upload_row(), active_upload_row()]
    )
    storage = FakeStorage()
    repository = PostgresIngestionRepository(FakeExecutor([before, created]), storage)
    result = asyncio.run(
        repository.request_upload(
            context(), PROJECT_ID, draft(), "stage", staged_target=(DATASET_ID, VERSION_ID)
        )
    )
    assert result.dataset.dataset_id == DATASET_ID
    assert len(storage.form_specs) == 1
    writes = [call for call in created.calls if call[0] == "execute"]
    assert not any(
        token in call[1]
        for call in writes
        for token in [
            "INSERT INTO app.datasets",
            "dataset_tags",
            "INSERT INTO app.project_datasets",
        ]
    )
    intent = next(call for call in writes if "INSERT INTO app.upload_intents" in call[1])
    assert intent[2][-2:] == (VERSION_ID, "ingest")


def test_staged_upload_rejects_stale_base_before_storage():
    before = FakeTransaction(one=[*project_access(), active_upload_row()])
    storage = FakeStorage()
    repository = PostgresIngestionRepository(FakeExecutor([before]), storage)
    with pytest.raises(IngestionConflict, match="staged_upload_base_changed"):
        asyncio.run(
            repository.request_upload(
                context(), PROJECT_ID, draft(), "stage", staged_target=(DATASET_ID, OBJECT_ID)
            )
        )
    assert storage.form_specs == []


def test_staged_completion_enqueues_candidate_and_preserves_current_pointer(monkeypatch):
    candidate = UUID("90000000-0000-4000-8000-000000000101")
    monkeypatch.setattr(
        "opengeo_api.ingestion.uuid4", deque([OBJECT_ID, candidate, JOB_ID]).popleft
    )
    intent = list(upload_row())
    intent[-1] = VERSION_ID
    initial = FakeTransaction(one=[*project_access(), tuple(intent), active_upload_row()])
    completed = FakeTransaction(
        one=[
            *project_access(),
            tuple(intent),
            (True,),
            (DATASET_ID,),
            active_upload_row(),
            (2,),
            active_upload_row(),
        ]
    )
    repository = PostgresIngestionRepository(FakeExecutor([initial, completed]), FakeStorage())
    result = asyncio.run(
        repository.complete_upload(context(), PROJECT_ID, UPLOAD_ID, "stage-complete")
    )
    assert result.dataset.current_version_id == VERSION_ID
    assert result.dataset_version_id == candidate
    assert result.version_number == 2
    assert all("UPDATE app.datasets" not in call[1] for call in completed.calls)
    version = next(
        call for call in completed.calls if "INSERT INTO app.dataset_versions" in call[1]
    )
    assert version[2][-1] == VERSION_ID
    assert any("INSERT INTO app.processing_jobs" in call[1] for call in completed.calls)


@pytest.mark.parametrize(
    ("decision", "source_kind", "source_revision"),
    [
        ("rejected", "staged_upload", None),
        ("review_required", "remote_service", None),
        ("review_required", "staged_upload", 1),
    ],
)
def test_staged_acceptance_cannot_override_rejection_or_unimplemented_source(
    decision, source_kind, source_revision
):
    transaction = FakeTransaction(
        one=[
            (DATASET_ID,),
            ("member",),
            active_upload_row(),
            (VERSION_ID, OBJECT_ID, decision, {"sourceKind": source_kind}, SHA256, source_revision),
            None,
        ]
    )
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())
    with pytest.raises(IngestionConflict, match="refresh_review_not_acceptable"):
        asyncio.run(
            repository.accept_dataset_refresh_review(
                context(), DATASET_ID, UPLOAD_ID, VERSION_ID, SHA256
            )
        )
    assert not any(call[0] == "execute" for call in transaction.calls)


@pytest.mark.parametrize("latest", [1, 2])
def test_capture_acceptance_rechecks_source_revision_before_promotion(latest):
    from copy import deepcopy

    from opengeo_api.dataset_refresh_review import capture_review_evidence

    upstream = CONNECTION_ID
    base = {
        "versionId": str(VERSION_ID),
        "state": "active",
        "featureCount": 3,
        "schema": {},
        "geometryType": "Point",
        "crs": "EPSG:4326",
        "coordinateDimension": 2,
        "capture": {
            "sourceDatasetId": str(upstream),
            "sourceRevision": 1,
            "scope": {"maximum_features": 10},
        },
    }
    candidate = deepcopy(base)
    candidate.update(versionId=str(OBJECT_ID), parentVersionId=str(VERSION_ID))
    candidate["capture"].update(
        stagedBaseVersionId=str(VERSION_ID),
        counts={
            "scope": {"maximum_features": 10},
            "numberMatched": 3,
            "fetchedCount": 3,
            "limitedByMaximumFeatures": False,
        },
    )
    evidence = capture_review_evidence(str(ORG_ID), str(DATASET_ID), base, candidate)
    rows = [
        (DATASET_ID,),
        ("member",),
        active_upload_row(),
        (VERSION_ID, OBJECT_ID, evidence["decision"], evidence, SHA256, None),
        None,
        (base,),
        (candidate,),
        (upstream,),
        ("member",),
        active_upload_row(),
        (latest,),
    ]
    if latest == 1:
        rows.append((JOB_ID, NOW))
    transaction = FakeTransaction(one=rows)
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), FakeStorage())
    operation = repository.accept_dataset_refresh_review(
        context(), DATASET_ID, UPLOAD_ID, VERSION_ID, SHA256
    )
    if latest == 2:
        with pytest.raises(IngestionConflict, match="refresh_source_revision_changed"):
            asyncio.run(operation)
        assert not any(call[0] == "execute" for call in transaction.calls)
    else:
        result = asyncio.run(operation)
        assert result["current_version_id"] == str(OBJECT_ID)
        assert any(
            "INSERT INTO app.dataset_refresh_acceptances" in call[1] for call in transaction.calls
        )
    assert any("FOR SHARE" in call[1] for call in transaction.calls)


@pytest.mark.parametrize("purpose", ["ingest", "pmtiles_original"])
def test_renew_upload_preserves_identity_and_reauthorizes(purpose):
    expired = list(upload_row(purpose=purpose))
    expired[10] = NOW
    target = dataset_row(geojson=purpose == "pmtiles_original")
    before = FakeTransaction(one=[*project_access(), tuple(expired), target])
    after = FakeTransaction(one=[*project_access(), tuple(expired), target])
    storage = FakeStorage()
    repository = PostgresIngestionRepository(FakeExecutor([before, after]), storage)
    ticket = asyncio.run(
        repository.renew_upload(
            context(),
            PROJECT_ID,
            UPLOAD_ID,
            "renew",
            allowed_purposes=frozenset({purpose}),
        )
    )
    assert ticket.upload_id == UPLOAD_ID
    assert ticket.purpose == purpose
    assert ticket.dataset.dataset_id == DATASET_ID
    assert len(storage.form_specs) == 1
    spec = storage.form_specs[0]
    assert (spec.key, spec.size_bytes, spec.checksum_sha256) == (
        GEOJSON_OBJECT_KEY if purpose == "pmtiles_original" else OBJECT_KEY,
        1234,
        SHA256,
    )
    writes = [call for call in after.calls if call[0] == "execute"]
    assert any("UPDATE app.upload_intents" in call[1] for call in writes)
    assert not any("INSERT INTO app.datasets" in call[1] for call in writes)
    assert any("FOR UPDATE" in call[1] for call in after.calls)


def test_renew_completed_upload_does_not_sign():
    transaction = FakeTransaction(one=[*project_access(), upload_row(completed=True)])
    storage = FakeStorage()
    repository = PostgresIngestionRepository(FakeExecutor([transaction]), storage)
    with pytest.raises(IngestionConflict, match="upload_already_completed"):
        asyncio.run(repository.renew_upload(context(), PROJECT_ID, UPLOAD_ID, "renew"))
    assert storage.form_specs == []


def test_renew_upload_rechecks_access_after_signing():
    before = FakeTransaction(one=[*project_access(), upload_row(), dataset_row()])
    after = FakeTransaction(one=project_access(role="viewer"))
    storage = FakeStorage()
    repository = PostgresIngestionRepository(FakeExecutor([before, after]), storage)
    with pytest.raises(IngestionAccessDenied):
        asyncio.run(repository.renew_upload(context(), PROJECT_ID, UPLOAD_ID, "renew"))
    assert not any(call[0] == "execute" for call in after.calls)
