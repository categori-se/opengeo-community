import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import pytest
from pydantic import ValidationError

from opengeo_api.authorization import Roles
from opengeo_api.observable_source_routes import ObservableRevisionFileRequest
from opengeo_api.observable_sources import (
    ObservableRevisionAttachment,
    ObservableRevisionReferencedFile,
    ObservableRevisionUpload,
    ObservableSourceAccessDenied,
    ObservableSourceConflict,
    ObservableSourceNotFound,
    ObservableSourceRevisionDraft,
    PostgresObservableSourceRepository,
)
from opengeo_api.s3_uploads import StoredObject
from opengeo_api.tenant_database import TenantContext

ORG, USER, PROJECT, SOURCE, PARENT, OBJECT, UPLOAD = (UUID(int=value) for value in range(1, 8))


def test_reference_distribution_request_requires_independent_exact_acknowledgment():
    from opengeo_api.observable_source_routes import CreateDistributionApprovalRequest

    assert CreateDistributionApprovalRequest(approval_id=UPLOAD).referenced_rights == []
    rights = {
        "reference_id": OBJECT,
        "relative_path": "data/a.tif",
        "license": "CC-BY-4.0",
        "attribution": "  Exact distribution  ",
        "acknowledgment": "publish-exact-referenced-file",
    }
    parsed = CreateDistributionApprovalRequest(approval_id=UPLOAD, referenced_rights=[rights])
    assert parsed.referenced_rights[0].attribution == "Exact distribution"
    with pytest.raises(ValidationError):
        CreateDistributionApprovalRequest(
            approval_id=UPLOAD,
            referenced_rights=[{**rights, "acknowledgment": "publish-exact-archive-file"}],
        )


def test_reference_distribution_review_batches_publish_facts_and_keeps_terms_per_distribution():
    from opengeo_api.observable_distribution_approvals import _review_inputs

    pin = {
        "referenceId": str(OBJECT),
        "path": "data/a.tif",
        "resourceId": str(OBJECT),
        "resourceVersionId": str(PARENT),
        "distributionId": "original-tiff",
    }
    pins = [
        pin,
        {
            **pin,
            "referenceId": str(UPLOAD),
            "path": "data/b.tif",
            "distributionId": "unknown-terms",
        },
    ]
    extensions = {
        "opengeo": {
            "distributions": [
                {
                    "identifier": "original-tiff",
                    "license": "CC-BY-4.0",
                    "attribution": "Exact distribution",
                },
                {"identifier": "unknown-terms"},
            ]
        }
    }
    transaction = SimpleNamespace(
        fetch_one=AsyncMock(),
        fetch_all=AsyncMock(
            return_value=[(OBJECT, PROJECT, UPLOAD, "Current title", PARENT, extensions, True)]
        ),
    )
    repository = PostgresObservableSourceRepository(SimpleNamespace())
    repository._project_roles = AsyncMock(return_value=Roles(organization="admin"))
    repository._load_project = AsyncMock(
        return_value=SimpleNamespace(compiler_image_digest="sha256:" + "a" * 64)
    )
    repository._load_revision = AsyncMock(
        return_value=SimpleNamespace(
            manifest={
                "schemaVersion": "opengeo.observable-source-revision.3.0.0",
                "referencedFiles": pins,
            },
            manifest_checksum_sha256="b" * 64,
        )
    )
    result = asyncio.run(
        _review_inputs(
            repository, transaction, TenantContext(USER, ORG), PROJECT, SOURCE, PARENT, None
        )
    )
    transaction.fetch_one.assert_awaited_once()
    transaction.fetch_all.assert_awaited_once()
    assert (
        "observable_distribution_resource_can_publish(resource.id)"
        in transaction.fetch_all.call_args.args[0]
    )
    selected, unknown = result["referenced_files"]
    assert selected["resourceVersionId"] == str(PARENT)
    assert selected["current_resource_version_id"] == str(UPLOAD)
    assert selected["license"] == "CC-BY-4.0" and selected["attribution"] == "Exact distribution"
    assert unknown["license"] is None and unknown["attribution"] is None and unknown["can_publish"]


@pytest.mark.parametrize("case", ["reference", "legacy", "missing-rights", "publish-denied"])
def test_exact_reference_distribution_decision_preserves_legacy_shape(case, monkeypatch):
    from opengeo_api import observable_distribution_approvals as module

    reference_pin = {
        "referenceId": str(OBJECT),
        "path": "data/a.tif",
        "resourceId": str(OBJECT),
        "resourceVersionId": str(PARENT),
        "distributionId": "original-tiff",
    }
    archive_pin = {
        "path": "data/a.tif",
        "attachmentId": str(OBJECT),
        "datasetId": str(OBJECT),
        "datasetVersionId": str(PARENT),
        "dataObjectId": str(UPLOAD),
        "s3VersionId": "v1",
        "checksumSha256": "a" * 64,
        "sizeBytes": 12,
        "contentType": "image/tiff",
    }
    reference = {
        **reference_pin,
        "title": "Exact TIFF",
        "current_resource_version_id": str(UPLOAD),
        "license": None,
        "attribution": None,
        "can_publish": case != "publish-denied",
    }
    review = {
        "archive_files": [
            {
                **archive_pin,
                "resource_id": str(OBJECT),
                "resource_version_id": str(UPLOAD),
                "can_publish": True,
            }
        ]
        if case == "legacy"
        else [],
        "artifacts": [],
        "artifact_inputs": None,
        "source_manifest_checksum_sha256": "b" * 64,
        "compiler_image_digest": "sha256:" + "a" * 64,
    }
    if case != "legacy":
        review["referenced_files"] = [reference]
    monkeypatch.setattr(module, "_review_inputs", AsyncMock(return_value=review))
    transaction = SimpleNamespace(fetch_one=AsyncMock(return_value=(UPLOAD, "c" * 64)))

    async def run(context, operation):
        return await operation(transaction)

    repository = PostgresObservableSourceRepository(SimpleNamespace(run=run))
    rights = {"license": "CC-BY-4.0", "attribution": "Owner-chosen exact terms"}
    archive_rights = (
        [
            {
                **rights,
                "attachment_id": OBJECT,
                "relative_path": "data/a.tif",
                "acknowledgment": "publish-exact-archive-file",
            }
        ]
        if case == "legacy"
        else []
    )
    options = (
        {}
        if case == "legacy"
        else {
            "referenced_rights": []
            if case == "missing-rights"
            else [
                {
                    **rights,
                    "reference_id": OBJECT,
                    "relative_path": "data/a.tif",
                    "acknowledgment": "publish-exact-referenced-file",
                }
            ]
        }
    )
    operation = module.create_distribution_approval(
        repository,
        TenantContext(USER, ORG),
        PROJECT,
        SOURCE,
        PARENT,
        None,
        "archive-96m",
        archive_rights,
        [],
        UPLOAD,
        **options,
    )
    if case in {"missing-rights", "publish-denied"}:
        code = (
            "observable_distribution_exact_reference_rights_required"
            if case == "missing-rights"
            else "observable_distribution_reference_publication_authority_required"
        )
        with pytest.raises(ObservableSourceConflict, match=code):
            asyncio.run(operation)
        transaction.fetch_one.assert_not_awaited()
        return
    result = asyncio.run(operation)
    manifest = result["manifest"]
    if case == "legacy":
        assert manifest["schemaVersion"] == module.APPROVAL_SCHEMA
        assert "referenceRights" not in manifest and "referencedFiles" not in manifest
    else:
        assert manifest["schemaVersion"] == module.REFERENCED_APPROVAL_SCHEMA
        assert manifest["referencedFiles"] == [reference_pin]
        assert manifest["referenceRights"] == [
            {
                "referenceId": str(OBJECT),
                "path": "data/a.tif",
                "resourceId": str(OBJECT),
                "resourceVersionId": str(UPLOAD),
                "distributionId": "original-tiff",
                **rights,
                "acknowledgment": "publish-exact-referenced-file",
            }
        ]


@pytest.mark.parametrize("reference", [{}, {"upload_id": UPLOAD, "source_object_id": OBJECT}])
def test_revision_reference_requires_one_kind(reference):
    with pytest.raises(ValidationError):
        ObservableRevisionFileRequest(relative_path="src/index.md", **reference)


@pytest.mark.parametrize(
    "mode",
    [
        "mixed",
        "retained-only",
        "missing",
        "wrong-path",
        "null-version",
        "oversize",
        "stale",
    ],
)
def test_reuse_resolves_locked_parent_without_reading_retained_s3_objects(mode):
    writes = []
    source = StoredObject(
        "source.opengeo.tools", "new/index.md", "v2", "etag", "text/markdown", 12, "a" * 64
    )
    retained = ObservableRevisionUpload(None, "src/other.md", OBJECT)
    files = (
        (retained,)
        if mode == "retained-only"
        else (
            ObservableRevisionUpload(UPLOAD, "src/index.md"),
            retained,
        )
    )
    uploads = (
        []
        if mode == "retained-only"
        else [
            (
                UPLOAD,
                "src/index.md",
                "text/markdown",
                12,
                "a" * 64,
                source.bucket,
                source.key,
                datetime.now(UTC) + timedelta(minutes=15),
            )
        ]
    )

    class Transaction:
        async def fetch_one(self, sql, params):
            assert "FOR UPDATE" in sql
            assert params == (ORG, PROJECT, SOURCE)
            return (PARENT, 2 if mode == "stale" else 1)

        async def fetch_all(self, sql, params):
            if "observable_source_revision_files file" in sql:
                assert params == (ORG, PROJECT, SOURCE, PARENT, [OBJECT])
                for scope in ("organization_id", "project_id", "source_project_id"):
                    assert f"object.{scope} = file.{scope}" in sql
                    assert f"file.{scope} = %s" in sql
                assert "file.source_revision_id = %s" in sql
                if mode == "missing":
                    return []
                return [
                    (
                        "src/wrong.md" if mode == "wrong-path" else retained.relative_path,
                        OBJECT,
                        "source.opengeo.tools",
                        "retained/other.md",
                        "null" if mode == "null-version" else "v1",
                        "old-etag",
                        "text/markdown",
                        16_777_216 if mode == "oversize" else 20,
                        "b" * 64,
                    )
                ]
            assert "observable_source_file_upload_intents" in sql
            assert params == (ORG, PROJECT, SOURCE, [] if not uploads else [UPLOAD], USER)
            return uploads

        async def execute(self, sql, params):
            writes.append((sql, params))

    async def run(context, operation):
        return await operation(Transaction())

    storage = SimpleNamespace(inspect_object=AsyncMock(return_value=source))
    repository = PostgresObservableSourceRepository(
        executor=SimpleNamespace(run=run), storage=storage
    )
    repository._project_roles = AsyncMock(return_value=Roles(organization="admin"))
    repository._load_project = AsyncMock(return_value=SimpleNamespace(current_revision_number=1))
    repository._load_revision = AsyncMock(return_value="saved")
    repository._record_event = AsyncMock()
    draft = ObservableSourceRevisionDraft(
        expected_revision=1,
        title="Edited source",
        rights_status="unreviewed",
        entry_path=files[0].relative_path,
        lockfile_path=None,
        change_summary="Edit",
        files=files,
    )
    operation = repository.create_revision(
        TenantContext(organization_id=ORG, user_id=USER), PROJECT, SOURCE, draft, "test"
    )
    if mode not in {"mixed", "retained-only"}:
        with pytest.raises(ObservableSourceConflict):
            asyncio.run(operation)
        assert not any("INSERT INTO app.observable_source_revisions" in sql for sql, _ in writes)
    else:
        assert asyncio.run(operation) == "saved"
        manifest = next(
            params[10].obj
            for sql, params in writes
            if "INSERT INTO app.observable_source_revisions" in sql
        )
        assert [file["path"] for file in manifest["files"]] == [
            file.relative_path for file in files
        ]
        assert manifest["files"][-1]["objectId"] == str(OBJECT)
        assert manifest["files"][-1]["s3VersionId"] == "v1"
        objects = [
            params for sql, params in writes if "INSERT INTO app.observable_source_objects" in sql
        ]
        assert len(objects) == len(uploads)
        links = [
            params
            for sql, params in writes
            if "INSERT INTO app.observable_source_revision_files" in sql
        ]
        assert links[-1][5] == OBJECT
        assert len(links) == len(files)
    if uploads:
        storage.inspect_object.assert_awaited_once_with("new/index.md")
    else:
        storage.inspect_object.assert_not_awaited()


def test_repository_rejects_duplicate_references_before_any_io():
    draft = ObservableSourceRevisionDraft(
        1,
        "Source",
        "unreviewed",
        "src/a.md",
        None,
        "Edit",
        (
            ObservableRevisionUpload(None, "src/a.md", OBJECT),
            ObservableRevisionUpload(None, "src/b.md", OBJECT),
        ),
    )
    with pytest.raises(ObservableSourceConflict, match="observable_source_file_reference_invalid"):
        PostgresObservableSourceRepository._validate_revision_draft(draft)


def public_reference_row(*, available=True, size=64_912_721, media="image/tiff"):
    return (
        UPLOAD,
        SOURCE,
        PROJECT,
        1,
        PARENT,
        OBJECT,
        4,
        "urn:distribution:original",
        "https://data.example.com/original.tif",
        media,
        size,
        "c" * 64,
        USER,
        datetime(2026, 10, 9, tzinfo=UTC),
        available,
    )


@pytest.mark.parametrize("mode", ["new", "existing", "denied", "missing", "unavailable"])
def test_public_reference_registry_derives_locked_facts_and_reuses_exact_selection(mode):
    queries = []

    async def fetch_one(sql, params):
        queries.append((sql, params))
        if "INSERT INTO app.observable_public_file_references" in sql:
            assert params == (
                ORG,
                PROJECT,
                SOURCE,
                PROJECT,
                1,
                PARENT,
                OBJECT,
                "urn:distribution:original",
                USER,
            )
            assert "ON CONFLICT" in sql and "DO NOTHING" in sql
            columns = sql.split("VALUES")[0]
            assert all(
                field not in columns for field in ("source_url", "size_bytes", "checksum_sha256")
            )
            return (UPLOAD,) if mode == "new" else None
        assert "app.observable_public_file_reference_available" in sql
        assert params == (
            ORG,
            PROJECT,
            SOURCE,
            PROJECT,
            1,
            PARENT,
            OBJECT,
            "urn:distribution:original",
        )
        return None if mode == "missing" else public_reference_row(available=mode != "unavailable")

    async def run(context, operation):
        assert context == TenantContext(USER, ORG)
        return await operation(SimpleNamespace(fetch_one=fetch_one))

    repository = PostgresObservableSourceRepository(executor=SimpleNamespace(run=run))
    repository._project_roles = AsyncMock(
        return_value=Roles(organization="member" if mode == "denied" else "admin")
    )
    repository._load_project = AsyncMock()
    repository._record_event = AsyncMock()
    operation = repository.register_public_file_reference(
        TenantContext(USER, ORG),
        PROJECT,
        SOURCE,
        PROJECT,
        1,
        PARENT,
        OBJECT,
        "urn:distribution:original",
        "reference-test",
    )
    if mode == "denied":
        with pytest.raises(ObservableSourceAccessDenied):
            asyncio.run(operation)
        assert not queries
    elif mode in {"missing", "unavailable"}:
        with pytest.raises(
            ObservableSourceConflict, match="observable_public_file_reference_unavailable"
        ):
            asyncio.run(operation)
    else:
        reference = asyncio.run(operation)
        assert reference.id == UPLOAD and reference.available
        assert reference.url == "https://data.example.com/original.tif"
        assert reference.size_bytes == 64_912_721
    assert repository._record_event.await_count == int(mode == "new")


def test_public_reference_list_retains_unavailable_history_under_source_read_authority():
    async def fetch_all(sql, params):
        assert params == (ORG, PROJECT, SOURCE)
        assert "app.observable_public_file_reference_available" in sql
        assert "LIMIT 128" in sql
        return [public_reference_row(available=False)]

    async def run(context, operation):
        return await operation(SimpleNamespace(fetch_all=fetch_all))

    repository = PostgresObservableSourceRepository(executor=SimpleNamespace(run=run))
    repository._project_roles = AsyncMock(
        return_value=Roles(organization="member", project="viewer")
    )
    repository._load_project = AsyncMock()
    records = asyncio.run(
        repository.list_public_file_references(TenantContext(USER, ORG), PROJECT, SOURCE)
    )
    assert records[0].id == UPLOAD and records[0].available is False
    repository._load_project.assert_awaited_once()


@pytest.mark.parametrize(
    "mode",
    [
        "public",
        "mixed",
        "unavailable",
        "missing",
        "wrong-media",
        "aggregate-oversize",
        "repeated-oversize",
    ],
)
def test_revision_seals_public_reference_without_source_body_or_archive_reads(mode):
    writes = []
    reference = public_reference_row(
        available=mode != "unavailable",
        media="text/javascript" if mode == "wrong-media" else "image/tiff",
    )
    archive = (
        PARENT,
        SOURCE,
        PROJECT,
        OBJECT,
        UPLOAD,
        "archive-v1",
        "d" * 64,
        3_000_000 if mode == "aggregate-oversize" else 12,
        "application/geo+json",
        USER,
        datetime(2026, 10, 9, tzinfo=UTC),
        True,
    )

    class Transaction:
        async def fetch_one(self, sql, params):
            assert "FOR UPDATE" in sql and params == (ORG, PROJECT, SOURCE)
            return (PARENT, 1)

        async def fetch_all(self, sql, params):
            if "observable_public_file_references reference" in sql:
                assert params[:3] == (ORG, PROJECT, SOURCE)
                return [] if mode == "missing" else [reference]
            if "observable_data_attachments attachment" in sql:
                return [archive]
            if "observable_source_revision_files file" in sql:
                return [
                    (
                        "src/index.md",
                        OBJECT,
                        "source.opengeo.tools",
                        "private/index.md",
                        "version-1",
                        "etag",
                        "text/markdown",
                        12,
                        "a" * 64,
                    )
                ]
            assert "observable_source_file_upload_intents" in sql
            return []

        async def execute(self, sql, params):
            writes.append((sql, params))

    async def run(context, operation):
        return await operation(Transaction())

    storage = SimpleNamespace(inspect_object=AsyncMock())
    repository = PostgresObservableSourceRepository(
        executor=SimpleNamespace(run=run), storage=storage
    )
    repository._project_roles = AsyncMock(return_value=Roles(organization="admin"))
    repository._load_project = AsyncMock(return_value=SimpleNamespace(current_revision_number=1))
    repository._load_revision = AsyncMock(return_value="saved")
    repository._record_event = AsyncMock()
    bindings = (ObservableRevisionReferencedFile(UPLOAD, "src/data/a.tif"),)
    if mode == "repeated-oversize":
        bindings += (ObservableRevisionReferencedFile(UPLOAD, "src/data/b.tif"),)
    draft = ObservableSourceRevisionDraft(
        1,
        "Original source",
        "unreviewed",
        "src/index.md",
        None,
        "Bind exact public data",
        (ObservableRevisionUpload(None, "src/index.md", OBJECT),),
        data_attachments=(ObservableRevisionAttachment(PARENT, "src/data/water.geojson"),)
        if mode in {"mixed", "aggregate-oversize"}
        else (),
        referenced_files=bindings,
    )
    operation = repository.create_revision(
        TenantContext(USER, ORG), PROJECT, SOURCE, draft, "save-reference"
    )
    if mode not in {"public", "mixed"}:
        with pytest.raises(ObservableSourceConflict):
            asyncio.run(operation)
        assert not any("INSERT INTO app.observable_source_revisions" in sql for sql, _ in writes)
    else:
        assert asyncio.run(operation) == "saved"
        manifest = next(
            params[10].obj
            for sql, params in writes
            if "INSERT INTO app.observable_source_revisions" in sql
        )
        assert manifest["schemaVersion"] == "opengeo.observable-source-revision.3.0.0"
        assert manifest["referencedFiles"] == [
            {
                "referenceId": str(UPLOAD),
                "path": "src/data/a.tif",
                "kind": "referenced-public-file",
                "custody": "referenced",
                "datasetId": str(PROJECT),
                "sourceVersion": 1,
                "resourceId": str(PARENT),
                "resourceVersionId": str(OBJECT),
                "resourceVersionNumber": 4,
                "distributionId": "urn:distribution:original",
                "url": "https://data.example.com/original.tif",
                "contentType": "image/tiff",
                "sizeBytes": 64_912_721,
                "checksumSha256": "c" * 64,
            }
        ]
        assert len(manifest["dataAttachments"]) == int(mode == "mixed")
    storage.inspect_object.assert_not_awaited()


@pytest.mark.parametrize("before_revision", [None, 4])
def test_revisions_page_uses_two_scoped_queries_without_per_revision_reads(before_revision):
    ids = [UUID(int=30), UUID(int=31)]
    rows = [
        (
            revision_id,
            SOURCE,
            number,
            None,
            "Saved",
            "unreviewed",
            "src/index.md",
            None,
            {},
            "a" * 64,
            "Saved draft",
            USER,
            datetime(2026, 10, 7, tzinfo=UTC),
            2,
        )
        for revision_id, number in zip(ids, [3, 2], strict=True)
    ]
    files = [
        (
            revision_id,
            "src/index.md",
            OBJECT,
            "source.opengeo.tools",
            "private/index.md",
            "version-1",
            "etag",
            "text/markdown",
            12,
            "a" * 64,
        )
        for revision_id in ids
    ]
    transaction = SimpleNamespace(
        fetch_all=AsyncMock(side_effect=[[(revision_id, 100) for revision_id in ids], rows, files])
    )

    async def run(context, operation):
        assert context.organization_id == ORG
        return await operation(transaction)

    repository = PostgresObservableSourceRepository(executor=SimpleNamespace(run=run))
    repository._project_roles = AsyncMock(return_value=Roles(organization="admin"))
    repository._load_project = AsyncMock(return_value=SimpleNamespace())
    repository._load_revision = AsyncMock(side_effect=AssertionError("N+1 loading prohibited"))
    records = asyncio.run(
        repository.list_revisions_page(
            TenantContext(organization_id=ORG, user_id=USER), PROJECT, SOURCE, 2, before_revision
        )
    )
    assert [record.revision_number for record in records] == [3, 2]
    assert all(record.files[0].source_object_id == OBJECT for record in records)
    assert transaction.fetch_all.await_count == 3
    preflight_sql, preflight_params = transaction.fetch_all.call_args_list[0].args
    header_sql, header_params = transaction.fetch_all.call_args_list[1].args
    file_sql, file_params = transaction.fetch_all.call_args_list[2].args
    assert "ORDER BY revision_number DESC LIMIT %s" in preflight_sql
    assert "octet_length" in preflight_sql and "estimated_bytes" in preflight_sql
    assert preflight_params == (
        ORG,
        PROJECT,
        SOURCE,
        *((before_revision,) if before_revision else ()),
        2,
        ORG,
        PROJECT,
        SOURCE,
    )
    assert ("revision_number < %s" in preflight_sql) == (before_revision is not None)
    assert header_params == (ORG, PROJECT, SOURCE, *ids)
    assert "file.source_revision_id IN (%s, %s)" in file_sql
    assert file_params == (ORG, PROJECT, SOURCE, *ids, 257)
    for sql in [preflight_sql, header_sql, file_sql]:
        assert "organization_id = %s" in sql and "project_id = %s" in sql
        assert "source_project_id = %s" in sql
    repository._load_revision.assert_not_awaited()


@pytest.mark.parametrize("mode", ["denied", "foreign-source", "empty", "metadata-limit"])
def test_revisions_page_stops_before_loading_files_when_authority_or_metadata_fails(mode):
    oversized = (
        PARENT,
        SOURCE,
        1,
        None,
        "Saved",
        "unreviewed",
        "src/index.md",
        None,
        {},
        "a" * 64,
        "Saved",
        USER,
        datetime(2026, 10, 7, tzinfo=UTC),
        2_097_153,
    )
    transaction = SimpleNamespace(
        fetch_all=AsyncMock(
            return_value=[(PARENT, oversized[13])] if mode == "metadata-limit" else []
        )
    )

    async def run(context, operation):
        return await operation(transaction)

    repository = PostgresObservableSourceRepository(executor=SimpleNamespace(run=run))
    repository._project_roles = AsyncMock(
        return_value=Roles(organization="member" if mode == "denied" else "admin")
    )
    repository._load_project = AsyncMock(
        side_effect=ObservableSourceNotFound("source_project") if mode == "foreign-source" else None
    )
    call = repository.list_revisions_page(
        TenantContext(organization_id=ORG, user_id=USER), PROJECT, SOURCE
    )
    if mode == "empty":
        assert asyncio.run(call) == ()
    else:
        with pytest.raises(
            {
                "denied": ObservableSourceAccessDenied,
                "foreign-source": ObservableSourceNotFound,
                "metadata-limit": ObservableSourceConflict,
            }[mode]
        ):
            asyncio.run(call)
    assert transaction.fetch_all.await_count == (1 if mode in ["empty", "metadata-limit"] else 0)


@pytest.mark.parametrize("limit,cursor", [(0, None), (26, None), (True, None), (1, 0)])
def test_revisions_page_rejects_repository_bounds_before_transaction(limit, cursor):
    executor = SimpleNamespace(run=AsyncMock())
    repository = PostgresObservableSourceRepository(executor=executor)
    with pytest.raises(ValueError):
        asyncio.run(
            repository.list_revisions_page(
                TenantContext(organization_id=ORG, user_id=USER), PROJECT, SOURCE, limit, cursor
            )
        )
    executor.run.assert_not_awaited()
