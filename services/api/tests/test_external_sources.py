import asyncio
from collections import deque
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest

from opengeo_api.external_sources import (
    ExternalSourceAccessDenied,
    ExternalSourceConflict,
    ExternalSourceDraft,
    ExternalSourceNotFound,
    ExternalSourceUpdate,
    PostgresExternalSourceRepository,
)
from opengeo_api.ingestion import Page
from opengeo_api.tenant_database import TenantContext

USER_ID = UUID("20000000-0000-4000-8000-000000000081")
ORG_ID = UUID("10000000-0000-4000-8000-000000000081")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000081")
DATASET_ID = UUID("80000000-0000-4000-8000-000000000081")
RESOURCE_ID = UUID("a0000000-0000-4000-8000-000000000081")
OTHER_USER_ID = UUID("20000000-0000-4000-8000-000000000082")
TAG_ID = UUID("85000000-0000-4000-8000-000000000081")
NOW = datetime(2026, 8, 20, 12, tzinfo=UTC)
URL = "https://tiles.example.test/{z}/{x}/{y}.png"


class FakeTransaction:
    def __init__(
        self,
        *,
        one: list[tuple[Any, ...] | None] | None = None,
        all_rows: list[list[tuple[Any, ...]]] | None = None,
    ) -> None:
        self.one = deque(one or [])
        self.all_rows = deque(all_rows or [])
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
        return 1


class FakeExecutor:
    def __init__(self, transactions: list[FakeTransaction]) -> None:
        self.transactions = deque(transactions)
        self.contexts: list[TenantContext] = []

    async def run(self, context, operation):
        self.contexts.append(context)
        assert self.transactions
        return await operation(self.transactions.popleft())

    async def fetch_one(self, context, statement, parameters=()):
        del context, statement, parameters
        raise AssertionError("direct fetch was not expected")


def context() -> TenantContext:
    return TenantContext(USER_ID, ORG_ID)


def project_access(role: str | None = "editor") -> list[tuple[Any, ...]]:
    return [("member",), (PROJECT_ID, role)]


def source_row(
    *,
    version: int = 1,
    url: str = URL,
    project_role: str | None = "editor",
    permission: str | None = None,
    owner: bool = True,
    classification: str = "public",
    status: str = "active",
    access_mode: str = "direct_browser",
    credential_mode: str = "none",
) -> tuple[Any, ...]:
    return (
        DATASET_ID,
        PROJECT_ID,
        "Public tiles",
        "Anonymous public basemap",
        classification,
        status,
        USER_ID if owner else OTHER_USER_ID,
        "xyz",
        access_mode,
        credential_mode,
        version,
        url,
        {
            "min_zoom": 0,
            "max_zoom": 20,
            "tile_size": 256,
            "scheme": "xyz",
            "attribution": "Example",
        },
        "syntax_only",
        NOW,
        NOW,
        permission,
        owner,
        project_role,
    )


@pytest.mark.parametrize(
    ("case", "expected"),
    [
        ("exact", None),
        ("source_denied", ExternalSourceNotFound),
        ("metadata_denied", ExternalSourceAccessDenied),
        ("wrong_edition", ExternalSourceNotFound),
        ("inactive", ExternalSourceConflict),
        ("duplicate_distribution", ExternalSourceConflict),
        ("wrong_url", ExternalSourceConflict),
        ("missing_checksum", ExternalSourceConflict),
        ("oversize", ExternalSourceConflict),
    ],
)
def test_resolve_referenced_file_exact_saved_authority_without_copy(case, expected):
    url = "https://s3.amazonaws.com/data.exchange/exp/LANDCOVER_19901.tif"
    edition = UUID("a0000000-0000-4000-8000-000000000083")
    identifier = "urn:distribution:bhutan-original-1990"
    distribution = {
        "identifier": identifier, "downloadUrl": url, "mediaType": "image/tiff",
        "byteSize": 64_912_721, "checksumSha256": "b" * 64,
    }
    if case == "wrong_url":
        distribution["downloadUrl"] = "https://backup.example.test/different.tif"
    if case == "missing_checksum":
        distribution.pop("checksumSha256")
    if case == "oversize":
        distribution["byteSize"] = 67_108_865
    distributions = [distribution] * (2 if case == "duplicate_distribution" else 1)
    row = list(source_row(project_role=None, permission="view", owner=False, url=url))
    row[7] = "cog"
    if case == "source_denied":
        row[16] = None
    if case == "inactive":
        row[5] = "archived"
    metadata_authority = ("member", None, None if case == "metadata_denied" else "view", False)
    edition_row = (
        edition, 4, {"opengeo": {"schemaVersion": "1.3.0", "distributions": distributions}},
        url,
    )
    one = [*project_access(None), tuple(row)]
    if case not in {"source_denied", "inactive"}:
        one.append(metadata_authority)
    if case not in {"source_denied", "inactive", "metadata_denied"}:
        one.append(None if case == "wrong_edition" else edition_row)
    transaction = FakeTransaction(one=one)
    executor = FakeExecutor([transaction])
    repo = PostgresExternalSourceRepository(executor)
    operation = repo.resolve_referenced_file(
        context(), PROJECT_ID, dataset_id=DATASET_ID, source_version=1,
        resource_id=RESOURCE_ID, resource_version_id=edition,
        distribution_id=identifier, relative_path="data/LANDCOVER_19901.tif",
    )
    if expected:
        with pytest.raises(expected):
            asyncio.run(operation)
    else:
        result = asyncio.run(operation)
        assert result == {
            "kind": "referenced-public-file", "custody": "referenced",
            "path": "data/LANDCOVER_19901.tif", "datasetId": str(DATASET_ID),
            "sourceVersion": 1, "resourceId": str(RESOURCE_ID),
            "resourceVersionId": str(edition), "resourceVersionNumber": 4,
            "distributionId": identifier, "url": url, "contentType": "image/tiff",
            "sizeBytes": 64_912_721, "checksumSha256": "b" * 64,
        }
        statement = transaction.calls[-1][1]
        assert "revision.dataset_id = resource.dataset_id" in statement
        assert "metadata.provenance->>'externalSourceVersion'" in statement
        assert "metadata.provenance->>'externalSourceUrl' = revision.source_url" in statement
        assert transaction.calls[-1][2] == (
            edition, 1, ORG_ID, PROJECT_ID, RESOURCE_ID, DATASET_ID, "1",
        )
    assert executor.contexts == [context()]
    assert all(call[0] == "one" for call in transaction.calls), "No writes, copies or reads"


def draft() -> ExternalSourceDraft:
    return ExternalSourceDraft(
        name="Public tiles",
        description="Anonymous public basemap",
        classification="public",
        source_type="xyz",
        source_url=URL,
        configuration={
            "min_zoom": 0,
            "max_zoom": 20,
            "tile_size": 256,
            "scheme": "xyz",
            "attribution": "Example",
        },
        tags=("basemap",),
    )


def update(*, expected_version: int = 1) -> ExternalSourceUpdate:
    return ExternalSourceUpdate(
        expected_version=expected_version,
        source_type="xyz",
        source_url="https://tiles.example.test/v2/{z}/{x}/{y}.png",
        configuration=draft().configuration,
        change_message="Move to v2 tiles",
    )


def test_create_is_authorized_and_persists_catalog_identity_revision_and_safe_activity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("opengeo_api.external_sources.uuid4", lambda: DATASET_ID)
    transaction = FakeTransaction(one=[*project_access(), (TAG_ID,), source_row()])
    repository = PostgresExternalSourceRepository(FakeExecutor([transaction]))

    result = asyncio.run(repository.create_source(context(), PROJECT_ID, draft(), "request-source"))

    assert result.dataset_id == DATASET_ID
    assert result.version_number == 1
    statements = [call[1] for call in transaction.calls]
    assert any("INSERT INTO app.datasets" in statement for statement in statements)
    dataset_insert = next(
        statement for statement in statements if "INSERT INTO app.datasets" in statement
    )
    # Data API string parameters are typed text, unlike psycopg's unknown
    # string parameters. Enum assignment needs explicit casts on both paths.
    for enum in ("dataset_classification", "dataset_source_type", "dataset_format"):
        assert f"%s::app.{enum}" in dataset_insert
    source_insert = next(
        statement for statement in statements if "INSERT INTO app.external_sources" in statement
    )
    assert "%s::app.dataset_source_type" in source_insert
    assert any("INSERT INTO app.external_sources" in statement for statement in statements)
    assert any("INSERT INTO app.external_source_revisions" in statement for statement in statements)
    activity = next(
        call for call in transaction.calls if "INSERT INTO app.activity_events" in call[1]
    )
    assert activity[2][0:6] == (
        ORG_ID,
        USER_ID,
        PROJECT_ID,
        "dataset.source.created",
        DATASET_ID,
        "request-source",
    )
    assert URL not in repr(activity[2])


def test_viewer_is_denied_before_any_source_write() -> None:
    transaction = FakeTransaction(one=project_access("viewer"))
    repository = PostgresExternalSourceRepository(FakeExecutor([transaction]))

    with pytest.raises(ExternalSourceAccessDenied):
        asyncio.run(repository.create_source(context(), PROJECT_ID, draft(), "denied"))

    assert all(call[0] == "one" for call in transaction.calls)


def test_update_locks_dataset_checks_cas_and_appends_revision_atomically() -> None:
    transaction = FakeTransaction(
        one=[
            *project_access(),
            (DATASET_ID,),
            source_row(),
            (1,),
            source_row(version=2, url="https://tiles.example.test/v2/{z}/{x}/{y}.png"),
        ]
    )
    repository = PostgresExternalSourceRepository(FakeExecutor([transaction]))

    result = asyncio.run(
        repository.update_source(context(), PROJECT_ID, DATASET_ID, update(), "request-update")
    )

    assert result.version_number == 2
    lock = next(call for call in transaction.calls if "FOR UPDATE" in call[1])
    assert lock[2] == (ORG_ID, DATASET_ID)
    revision = next(
        call
        for call in transaction.calls
        if call[0] == "execute" and "INSERT INTO app.external_source_revisions" in call[1]
    )
    assert revision[2][2] == 2
    activity = next(
        call for call in transaction.calls if "INSERT INTO app.activity_events" in call[1]
    )
    assert activity[2][3] == "dataset.source.updated"
    assert update().source_url not in repr(activity[2])


def test_stale_update_fails_with_current_version_before_write() -> None:
    transaction = FakeTransaction(
        one=[*project_access(), (DATASET_ID,), source_row(version=3), (3,)]
    )
    repository = PostgresExternalSourceRepository(FakeExecutor([transaction]))

    with pytest.raises(ExternalSourceConflict) as error:
        asyncio.run(
            repository.update_source(
                context(), PROJECT_ID, DATASET_ID, update(expected_version=2), "stale"
            )
        )

    assert error.value.code == "external_source_version_conflict"
    assert error.value.current_version == 3
    assert not any(
        call[0] == "execute" and "external_source_revisions" in call[1]
        for call in transaction.calls
    )


def test_dataset_owner_can_update_without_project_editor_role() -> None:
    transaction = FakeTransaction(
        one=[
            *project_access(None),
            (DATASET_ID,),
            source_row(project_role=None, owner=True),
            (1,),
            source_row(version=2, project_role=None, owner=True),
        ]
    )
    repository = PostgresExternalSourceRepository(FakeExecutor([transaction]))

    result = asyncio.run(
        repository.update_source(context(), PROJECT_ID, DATASET_ID, update(), "owner-update")
    )
    assert result.capabilities.edit is True


def classification_update(
    *,
    expected_version: int = 1,
    expected_classification: str = "internal",
    classification: str = "public",
    reviewed: bool = True,
) -> ExternalSourceUpdate:
    return ExternalSourceUpdate(
        expected_version=expected_version,
        expected_classification=expected_classification,
        classification=classification,
        public_eligibility_reviewed=reviewed,
    )


def test_classification_only_update_preserves_source_revision_url_and_configuration() -> None:
    before = source_row(classification="internal", project_role="owner")
    transaction = FakeTransaction(
        one=[
            *project_access("owner"),
            (DATASET_ID, "internal"),
            before,
            (1,),
            source_row(classification="public", project_role="owner"),
        ],
        all_rows=[[(RESOURCE_ID, None)]],
    )
    repository = PostgresExternalSourceRepository(FakeExecutor([transaction]))

    result = asyncio.run(
        repository.update_source(
            context(), PROJECT_ID, DATASET_ID, classification_update(), "classification-review"
        )
    )

    assert result.classification == "public"
    assert result.dataset_id == DATASET_ID and result.owner_user_id == USER_ID
    assert result.version_number == before[10] == 1
    assert result.source_url == before[11] == URL
    assert result.configuration == before[12]
    lock_index = next(i for i, call in enumerate(transaction.calls) if "FOR UPDATE" in call[1])
    source_index = next(
        i for i, call in enumerate(transaction.calls) if "FROM app.external_sources" in call[1]
    )
    assert lock_index < source_index
    statements = [call[1] for call in transaction.calls if call[0] == "execute"]
    assert not any("external_source_revisions" in statement for statement in statements)
    assert not any("app.external_sources" in statement for statement in statements)
    changed = next(call for call in transaction.calls if "UPDATE app.datasets" in call[1])
    assert "%s::app.dataset_classification" in changed[1]
    assert "owner_user_id" not in changed[1]
    audit = next(call for call in transaction.calls if "INSERT INTO app.activity_events" in call[1])
    assert audit[2][3] == "dataset.source.classification.changed"
    assert audit[2][6].obj == {
        "previous_classification": "internal", "classification": "public", "version_number": 1
    }
    assert URL not in repr(audit[2])
    eligibility = next(
        call for call in transaction.calls if "app.governed_resources" in call[1]
    )
    assert "externalSourceVersion" in eligibility[1] and "externalSourceUrl" in eligibility[1]
    assert "published" in eligibility[1] and "public" in eligibility[1]
    assert "metadata.license" in eligibility[1] and "metadata.attribution" in eligibility[1]
    assert eligibility[2] == (USER_ID, ORG_ID, PROJECT_ID, DATASET_ID, "1", URL)
    assert "app.governed_resource_permissions" in eligibility[1]


@pytest.mark.parametrize(
    ("project_role", "permission"), [("editor", None), (None, "edit"), ("viewer", None)]
)
def test_classification_change_denies_ordinary_source_editors_before_writes(
    project_role: str | None, permission: str | None
) -> None:
    transaction = FakeTransaction(
        one=[
            *project_access(project_role),
            (DATASET_ID, "internal"),
            source_row(
                classification="internal", project_role=project_role, permission=permission,
                owner=False,
            ),
            (1,),
        ]
    )
    repository = PostgresExternalSourceRepository(FakeExecutor([transaction]))

    with pytest.raises(ExternalSourceAccessDenied):
        asyncio.run(
            repository.update_source(context(), PROJECT_ID, DATASET_ID, classification_update(),
                                     "classification-denied")
        )
    assert not any(call[0] == "execute" for call in transaction.calls)


@pytest.mark.parametrize(
    ("locked_classification", "version", "code"),
    [
        ("public", 1, "external_source_classification_conflict"),
        ("internal", 2, "external_source_version_conflict"),
    ],
)
def test_classification_change_checks_locked_classification_and_source_version(
    locked_classification: str, version: int, code: str
) -> None:
    transaction = FakeTransaction(
        one=[
            *project_access("owner"),
            (DATASET_ID, locked_classification),
            source_row(classification="internal", project_role="owner"),
            (version,),
        ]
    )
    repository = PostgresExternalSourceRepository(FakeExecutor([transaction]))

    with pytest.raises(ExternalSourceConflict) as error:
        asyncio.run(
            repository.update_source(context(), PROJECT_ID, DATASET_ID, classification_update(),
                                     "classification-stale")
        )
    assert error.value.code == code
    assert not any(call[0] == "execute" for call in transaction.calls)


@pytest.mark.parametrize("reviewed", [False, True])
def test_public_classification_requires_review_and_exact_published_source_metadata(
    reviewed: bool,
) -> None:
    transaction = FakeTransaction(
        one=[
            *project_access("owner"),
            (DATASET_ID, "internal"),
            source_row(classification="internal", project_role="owner"),
            (1,),
        ],
        all_rows=[[]],
    )
    repository = PostgresExternalSourceRepository(FakeExecutor([transaction]))

    with pytest.raises(ExternalSourceConflict):
        asyncio.run(
            repository.update_source(
                context(), PROJECT_ID, DATASET_ID, classification_update(reviewed=reviewed),
                "classification-ineligible",
            )
        )
    assert not any(call[0] == "execute" for call in transaction.calls)


def test_dataset_manager_needs_publisher_authority_for_public_classification() -> None:
    transaction = FakeTransaction(
        one=[
            *project_access(None),
            (DATASET_ID, "internal"),
            source_row(classification="internal", project_role=None, permission="manage",
                       owner=False),
            (1,),
        ],
        all_rows=[[(RESOURCE_ID, "edit")]],
    )
    repository = PostgresExternalSourceRepository(FakeExecutor([transaction]))

    with pytest.raises(ExternalSourceAccessDenied):
        asyncio.run(
            repository.update_source(context(), PROJECT_ID, DATASET_ID, classification_update(),
                                     "publisher-denied")
        )
    assert not any(call[0] == "execute" for call in transaction.calls)


def test_dataset_manager_with_catalog_publish_grant_can_classify_source_public() -> None:
    transaction = FakeTransaction(
        one=[
            *project_access(None),
            (DATASET_ID, "internal"),
            source_row(classification="internal", project_role=None, permission="manage",
                       owner=False),
            (1,),
            source_row(classification="public", project_role=None, permission="manage",
                       owner=False),
        ],
        all_rows=[[(RESOURCE_ID, "publish")]],
    )
    repository = PostgresExternalSourceRepository(FakeExecutor([transaction]))

    result = asyncio.run(
        repository.update_source(context(), PROJECT_ID, DATASET_ID, classification_update(),
                                 "publisher-classification")
    )
    assert result.classification == "public" and result.version_number == 1
    assert result.owner_user_id == OTHER_USER_ID
    assert not any("INSERT INTO app.external_source_revisions" in call[1]
                   for call in transaction.calls)


@pytest.mark.parametrize(
    ("status", "access_mode", "credential_mode"),
    [("archived", "direct_browser", "none"),
     ("active", "server_proxy", "none"),
     ("active", "direct_browser", "stored")],
)
def test_public_classification_refuses_inactive_or_credentialed_source(
    status: str, access_mode: str, credential_mode: str,
) -> None:
    transaction = FakeTransaction(
        one=[
            *project_access("owner"),
            (DATASET_ID, "internal"),
            source_row(classification="internal", project_role="owner", status=status,
                       access_mode=access_mode, credential_mode=credential_mode),
            (1,),
        ],
        all_rows=[[(RESOURCE_ID, None)]],
    )
    repository = PostgresExternalSourceRepository(FakeExecutor([transaction]))

    with pytest.raises(ExternalSourceConflict) as error:
        asyncio.run(
            repository.update_source(context(), PROJECT_ID, DATASET_ID, classification_update(),
                                     "source-ineligible")
        )
    assert error.value.code == "external_source_public_ineligible"
    assert not any(call[0] in {"all", "execute"} for call in transaction.calls)


def test_unchanged_classification_has_no_revision_or_activity_write() -> None:
    transaction = FakeTransaction(
        one=[
            *project_access(None),
            (DATASET_ID, "internal"),
            source_row(classification="internal", project_role=None),
            (1,),
            source_row(classification="internal", project_role=None),
        ]
    )
    repository = PostgresExternalSourceRepository(FakeExecutor([transaction]))

    result = asyncio.run(
        repository.update_source(
            context(), PROJECT_ID, DATASET_ID,
            classification_update(classification="internal", reviewed=False), "unchanged",
        )
    )
    assert result.classification == "internal" and result.version_number == 1
    assert result.source_url == URL and result.configuration == draft().configuration
    assert not any(call[0] == "execute" for call in transaction.calls)


def test_list_filters_out_records_without_read_capability() -> None:
    transaction = FakeTransaction(
        one=project_access(None),
        all_rows=[
            [
                source_row(project_role=None, owner=False, permission="view"),
                source_row(project_role=None, owner=False, permission=None),
            ]
        ],
    )
    repository = PostgresExternalSourceRepository(FakeExecutor([transaction]))

    records = asyncio.run(repository.list_sources(context(), PROJECT_ID, page=Page(50, 0)))
    assert len(records) == 1
    assert records[0].capabilities.read is True


def test_discovery_binding_rejects_mismatch_before_writes_and_links_valid_registration(monkeypatch):
    from dataclasses import replace

    monkeypatch.setattr("opengeo_api.external_sources.uuid4", lambda: DATASET_ID)
    job_id = UUID("86000000-0000-4000-8000-000000000081")
    discovered = replace(
        draft(),
        source_type="arcgis",
        source_url="https://example.test/FeatureServer/0",
        discovery_job_id=job_id,
    )
    denied = FakeTransaction(one=[*project_access(), None])
    repository = PostgresExternalSourceRepository(FakeExecutor([denied]))
    with pytest.raises(ExternalSourceConflict):
        asyncio.run(repository.create_source(context(), PROJECT_ID, discovered, "mismatch"))
    assert all(call[0] == "one" for call in denied.calls)
    transaction = FakeTransaction(
        one=[
            *project_access(),
            (job_id, "https://example.test/FeatureServer", "0"),
            (TAG_ID,),
            source_row(),
        ]
    )
    repository = PostgresExternalSourceRepository(FakeExecutor([transaction]))
    asyncio.run(repository.create_source(context(), PROJECT_ID, discovered, "linked"))
    query = next(call for call in transaction.calls if "SELECT id, service_url" in call[1])
    assert query[2][:3] == (ORG_ID, PROJECT_ID, job_id)
    assert "source_definition" in query[1] and "discovery_kind = 'collection'" in query[1]
    link = next(
        call
        for call in transaction.calls
        if "INSERT INTO app.dataset_source_discoveries" in call[1]
    )
    assert link[2] == (
        ORG_ID,
        DATASET_ID,
        job_id,
        "arcgis",
        "https://example.test/FeatureServer",
        "0",
        USER_ID,
    )
