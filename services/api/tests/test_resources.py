import asyncio
from collections import deque
from datetime import UTC, datetime
from hashlib import sha256
from typing import Any
from uuid import UUID

import pytest

from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.metadata_adapters import build_metadata_import_plan, metadata_source_checksum
from opengeo_api.resources import (
    PageSourceUploadDraft,
    PageWorkingDraftUpdate,
    PostgresResourceRepository,
    RecordFilters,
    ResourceAccessDenied,
    ResourceConflict,
    ResourceFilters,
    ResourceMetadata,
    ResourceMetadataInvalid,
    ResourceNotFound,
    ResourceState,
    ResourceStyleDraft,
    ResourceStyleUpdate,
    ResourceUpdate,
    ResourceVisibility,
)
from opengeo_api.s3_uploads import StoredObject, UploadForm
from opengeo_api.tenant_database import TenantContext

USER_ID = UUID("20000000-0000-4000-8000-000000000093")
ORG_ID = UUID("10000000-0000-4000-8000-000000000093")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000093")
RESOURCE_ID = UUID("a0000000-0000-4000-8000-000000000093")
PROFILE_ID = UUID("c0000000-0000-4000-8000-000000000093")
PROFILE_VERSION_ID = UUID("d0000000-0000-4000-8000-000000000093")
NOW = datetime(2026, 8, 20, 12, tzinfo=UTC)
RESOURCE_VERSION_ID = UUID("b0000000-0000-4000-8000-000000000093")
SOURCE_ID = UUID("f0000000-0000-4000-8000-000000000093")
PAGE_UPLOAD_ID = UUID("f1000000-0000-4000-8000-000000000093")
PAGE_SOURCE_ID = UUID("f2000000-0000-4000-8000-000000000093")
PAGE_DRAFT_ID = UUID("f3000000-0000-4000-8000-000000000093")


class FakeTransaction:
    def __init__(self, row: tuple[Any, ...]) -> None:
        self.row = row
        self.one = deque([("member",), (PROJECT_ID, "viewer")])
        self.list_statement = ""
        self.list_parameters: tuple[Any, ...] = ()

    async def fetch_one(self, statement, parameters=()):
        del statement, parameters
        return self.one.popleft()

    async def fetch_all(self, statement, parameters=()):
        self.list_statement = statement
        self.list_parameters = tuple(parameters)
        return [self.row]

    async def execute(self, statement, parameters=()):
        del statement, parameters
        raise AssertionError("list must not write")


class FakeExecutor:
    def __init__(self, transaction: FakeTransaction | None = None) -> None:
        self.transaction = transaction
        self.calls = 0

    async def run(self, context, operation):
        del context
        self.calls += 1
        assert self.transaction is not None
        return await operation(self.transaction)

    async def fetch_one(self, context, statement, parameters=()):
        del context, statement, parameters
        raise AssertionError("direct fetch was not expected")


class ScriptedTransaction:
    def __init__(self, *, one=(), all_rows=()) -> None:
        self.one = deque(one)
        self.all_rows = deque(all_rows)
        self.fetches: list[str] = []
        self.executions: list[tuple[str, tuple[Any, ...]]] = []

    async def fetch_one(self, statement, parameters=()):
        del parameters
        self.fetches.append(statement)
        return self.one.popleft()

    async def fetch_all(self, statement, parameters=()):
        del parameters
        self.fetches.append(statement)
        return self.all_rows.popleft()

    async def execute(self, statement, parameters=()):
        self.executions.append((statement, tuple(parameters)))


class ScriptedExecutor:
    def __init__(self, transaction: ScriptedTransaction) -> None:
        self.transaction = transaction

    async def run(self, context, operation):
        del context
        return await operation(self.transaction)


class ExactSourceStorage:
    def __init__(self, source: bytes = b"# Roads") -> None:
        self.source = source
        self.form_specs = []
        self.inspect_keys = []

    @property
    def bucket(self):
        return "source.opengeo.tools"

    async def create_upload_form(self, spec):
        self.form_specs.append(spec)
        return UploadForm(
            url="https://s3.us-east-1.amazonaws.com/source.opengeo.tools",
            method="POST",
            fields={"key": spec.key},
            expires_at=datetime(2027, 8, 20, 12, 15, tzinfo=UTC),
        )

    async def inspect_object(self, key):
        self.inspect_keys.append(key)
        return StoredObject(
            bucket=self.bucket,
            key=key,
            version_id="immutable-source-version",
            etag="source-etag",
            content_type="text/markdown",
            size_bytes=len(self.source),
            checksum_sha256=sha256(self.source).hexdigest(),
        )


def summary_row() -> tuple[Any, ...]:
    return (
        RESOURCE_ID,
        PROJECT_ID,
        "story",
        "road-access-story",
        None,
        None,
        "organization",
        "review",
        2,
        "Road access story",
        "Research narrative",
        "en",
        "CC-BY-4.0",
        "Research team",
        ["roads", "access"],
        [84.0, 27.0, 86.0, 29.0],
        NOW,
        NOW,
        USER_ID,
        "geonode",
        "33333333-3333-4333-8333-333333333333",
        2,
        NOW,
        NOW,
    )


def managed_metadata(*, version: int = 1, license: str | None = "CC-BY-4.0") -> ResourceMetadata:
    return ResourceMetadata(
        title="Road access story",
        abstract="Research narrative",
        language="en",
        license=license,
        attribution="Research team",
        keywords=("roads",),
        spatial_extent=(84.0, 27.0, 86.0, 29.0),
        temporal_start=NOW,
        temporal_end=None,
        profile="research.core",
        extensions={"local": {"review": "preserved"}},
        managed_profile_id=PROFILE_ID,
        managed_profile_version=version,
    )


def page_draft_update(*, expected_revision: int = 0) -> PageWorkingDraftUpdate:
    return PageWorkingDraftUpdate(
        expected_resource_version=1,
        expected_draft_revision=expected_revision,
        visibility="restricted",
        metadata={
            "title": "Road access story",
            "abstract": "Research narrative",
            "language": "en",
            "license": "CC-BY-4.0",
            "attribution": "Research team",
            "keywords": ["roads"],
            "spatial_extent": None,
            "temporal_start": None,
            "temporal_end": None,
            "profile": "opengeo.core.v1",
            "extensions": {},
            "translations": {},
            "managed_profile_id": None,
            "managed_profile_version": None,
        },
        content={"blocks": [{"id": "intro", "type": "markdown", "markdown": "# Roads"}]},
        provenance={},
        source_block_id="intro",
        source_markdown="# Roads\n\nUnapplied recovery",
        change_summary="Recover road edits",
    )


def managed_definition() -> dict[str, Any]:
    return {
        "schema_version": "1.0.0",
        "required_core": ["title", "license"],
        "core_vocabularies": {"license": ["CC-BY-4.0"]},
        "extension_fields": [],
    }


def stac_document() -> dict[str, Any]:
    return {
        "type": "Collection",
        "stac_version": "1.1.0",
        "id": "road-access-2026",
        "title": "Road access survey",
        "description": "Verified roads metadata.",
        "license": "CC-BY-4.0",
        "keywords": ["roads"],
        "extent": {
            "spatial": {"bbox": [[84.0, 27.0, 86.0, 29.0]]},
            "temporal": {"interval": [["2026-01-01T00:00:00Z", None]]},
        },
        "links": [],
    }


def stac_plan():
    document = stac_document()
    return build_metadata_import_plan(
        "stac_1_1",
        "example.catalog",
        "road-access-import",
        "restricted",
        document,
        metadata_source_checksum(document),
    )


def iso_plan():
    document = (
        '<mdb:MD_Metadata xmlns:mdb="http://standards.iso.org/iso/19115/-3/mdb/2.0" '
        'xmlns:mcc="http://standards.iso.org/iso/19115/-3/mcc/1.0" '
        'xmlns:mri="http://standards.iso.org/iso/19115/-3/mri/1.0" '
        'xmlns:cit="http://standards.iso.org/iso/19115/-3/cit/2.0" '
        'xmlns:lan="http://standards.iso.org/iso/19115/-3/lan/1.0" '
        'xmlns:gco="http://standards.iso.org/iso/19115/-3/gco/1.0">'
        "<mdb:metadataIdentifier><mcc:MD_Identifier><mcc:code>"
        "<gco:CharacterString>road-access-iso</gco:CharacterString>"
        "</mcc:code></mcc:MD_Identifier></mdb:metadataIdentifier>"
        "<mdb:defaultLocale><lan:PT_Locale><lan:language>"
        '<lan:LanguageCode codeListValue="en">en</lan:LanguageCode>'
        "</lan:language></lan:PT_Locale></mdb:defaultLocale>"
        "<mdb:identificationInfo><mri:MD_DataIdentification><mri:citation>"
        "<cit:CI_Citation><cit:title><gco:CharacterString>Road access ISO</gco:CharacterString>"
        "</cit:title></cit:CI_Citation></mri:citation></mri:MD_DataIdentification>"
        "</mdb:identificationInfo></mdb:MD_Metadata>"
    )
    return build_metadata_import_plan(
        "iso_19115_3",
        "example.iso",
        "road-access-iso",
        "restricted",
        document,
        metadata_source_checksum(document),
    )


def detail_row() -> tuple[Any, ...]:
    return (
        *summary_row(),
        "opengeo.core.v1",
        {},
        {},
        {"blocks": []},
        {},
        None,
        USER_ID,
        NOW,
        None,
        None,
        None,
        RESOURCE_VERSION_ID,
    )


def source_row(plan) -> tuple[Any, ...]:
    return (
        SOURCE_ID,
        RESOURCE_ID,
        RESOURCE_VERSION_ID,
        plan.source_format,
        plan.source_version,
        plan.source_namespace,
        plan.source_identifier,
        plan.source_sha256,
        plan.conversion_report,
        USER_ID,
        NOW,
    )


def test_resource_discovery_binds_every_filter_and_excludes_unknown_spatial_extent() -> None:
    transaction = FakeTransaction(summary_row())
    repository = PostgresResourceRepository(FakeExecutor(transaction))
    filters = ResourceFilters(
        query="road access",
        kind="story",
        visibility="organization",
        state="review",
        bbox=(84.0, 27.0, 86.0, 29.0),
        temporal_start=NOW,
        temporal_end=NOW,
        limit=25,
        offset=5,
    )

    records = asyncio.run(
        repository.list_resources(TenantContext(USER_ID, ORG_ID), PROJECT_ID, filters)
    )

    assert records[0].resource_id == RESOURCE_ID
    assert records[0].spatial_extent == filters.bbox
    assert "version.spatial_extent IS NOT NULL" in transaction.list_statement
    assert "websearch_to_tsquery" in transaction.list_statement
    assert transaction.list_parameters[-2:] == (25, 5)
    assert transaction.list_parameters.count("road access") == 3


def test_resource_discovery_declares_types_for_every_nullable_filter() -> None:
    transaction = FakeTransaction(summary_row())
    repository = PostgresResourceRepository(FakeExecutor(transaction))

    records = asyncio.run(
        repository.list_resources(TenantContext(USER_ID, ORG_ID), PROJECT_ID, ResourceFilters())
    )

    assert records[0].resource_id == RESOURCE_ID
    assert "::app.governed_resource_kind IS NULL" in transaction.list_statement
    assert "::app.governed_resource_visibility IS NULL" in transaction.list_statement
    assert "::app.governed_resource_state IS NULL" in transaction.list_statement
    assert "::text IS NULL" in transaction.list_statement
    assert "::double precision IS NULL" in transaction.list_statement
    assert transaction.list_statement.count("::timestamptz IS NULL") == 2
    assert transaction.list_parameters[2:19:2] == (None,) * 9


def test_record_discovery_counts_and_filters_multilingual_exact_identifiers() -> None:
    record_row = (*summary_row(), {"fr": {"title": "Réseau routier"}})
    external_row = (
        RESOURCE_ID,
        "doi",
        "10.1234/roads",
        "https://example.test/roads",
        "1",
        "a" * 64,
        NOW,
    )
    transaction = ScriptedTransaction(
        one=[("member",), (PROJECT_ID, "viewer"), (1,)],
        all_rows=[[record_row], [external_row]],
    )
    repository = PostgresResourceRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]

    page = asyncio.run(
        repository.list_record_resources(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            RecordFilters(
                query='"roads" OR "réseau routier"',
                kinds=("dataset",),
                ids=(RESOURCE_ID,),
                external_ids=("doi:10.1234/roads",),
                bbox=(84.0, 27.0, 86.0, 29.0),
                temporal_start=NOW,
                temporal_end=NOW,
                limit=10,
            ),
        )
    )

    assert page.number_matched == 1
    assert page.resources[0].translations["fr"]["title"] == "Réseau routier"
    assert page.resources[0].external_identifiers[0].namespace == "doi"
    statements = "\n".join(transaction.fetches)
    assert "websearch_to_tsquery" in statements
    assert "source_namespace || ':' || source.source_identifier" in statements
    assert "resource.id = ANY" in statements


def test_resource_relationship_rejects_self_reference_before_database_access() -> None:
    executor = FakeExecutor()
    repository = PostgresResourceRepository(executor)

    with pytest.raises(ResourceConflict, match="resource_relationship_self_reference"):
        asyncio.run(
            repository.add_relationship(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                RESOURCE_ID,
                RESOURCE_ID,
                "references",
                "resource-self",
            )
        )

    assert executor.calls == 0


def test_managed_metadata_write_pins_profile_revision_and_validation_snapshot() -> None:
    transaction = ScriptedTransaction(
        one=[("research.core", PROFILE_VERSION_ID, 1, managed_definition())]
    )

    asyncio.run(
        PostgresResourceRepository._insert_version(
            transaction,  # type: ignore[arg-type]
            TenantContext(USER_ID, ORG_ID),
            RESOURCE_ID,
            UUID("b0000000-0000-4000-8000-000000000093"),
            3,
            managed_metadata(),
            {"blocks": []},
            {"method": "survey"},
            "Curated metadata",
        )
    )

    statement, parameters = transaction.executions[0]
    assert "metadata_profile_version_id" in statement
    assert parameters[-3:-1] == (PROFILE_ID, PROFILE_VERSION_ID)
    assert parameters[-1].obj["status"] == "valid"
    assert parameters[-1].obj["warnings"] == 1


def test_managed_metadata_write_rejects_stale_profile_and_invalid_document() -> None:
    stale = ScriptedTransaction(
        one=[("research.core", PROFILE_VERSION_ID, 2, managed_definition())]
    )
    with pytest.raises(ResourceConflict, match="metadata_profile_version_conflict") as conflict:
        asyncio.run(
            PostgresResourceRepository._insert_version(
                stale,  # type: ignore[arg-type]
                TenantContext(USER_ID, ORG_ID),
                RESOURCE_ID,
                UUID("b0000000-0000-4000-8000-000000000093"),
                3,
                managed_metadata(),
                {"blocks": []},
                {},
                None,
            )
        )
    assert conflict.value.current_version == 2
    assert stale.executions == []

    invalid = ScriptedTransaction(
        one=[("research.core", PROFILE_VERSION_ID, 1, managed_definition())]
    )
    with pytest.raises(ResourceMetadataInvalid) as validation:
        asyncio.run(
            PostgresResourceRepository._insert_version(
                invalid,  # type: ignore[arg-type]
                TenantContext(USER_ID, ORG_ID),
                RESOURCE_ID,
                UUID("b0000000-0000-4000-8000-000000000093"),
                3,
                managed_metadata(license=None),
                {"blocks": []},
                {},
                None,
            )
        )
    assert validation.value.report["status"] == "invalid"
    assert invalid.executions == []


def test_metadata_import_atomically_persists_exact_source_revision_and_audit() -> None:
    plan = stac_plan()
    transaction = ScriptedTransaction(
        one=[
            ("member",),
            (PROJECT_ID, "editor"),
            (None,),
            None,
            detail_row(),
            source_row(plan),
            (canonical_json_bytes(plan.source_document).decode("utf-8"),),
        ],
        all_rows=[[], []],
    )
    repository = PostgresResourceRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]

    result = asyncio.run(
        repository.import_metadata_resource(
            TenantContext(USER_ID, ORG_ID), PROJECT_ID, plan, "metadata-import"
        )
    )

    assert result.idempotent is False
    assert result.resource.current_version_id == RESOURCE_VERSION_ID
    assert result.source.source_document == plan.source_document
    assert result.source.source_sha256 == plan.source_sha256
    statements = "\n".join(statement for statement, _ in transaction.executions)
    assert "governed_resources" in statements
    assert "governed_resource_versions" in statements
    assert "governed_metadata_source_documents" in statements
    assert "activity_events" in statements
    source_parameters = next(
        parameters
        for statement, parameters in transaction.executions
        if "INSERT INTO app.governed_metadata_source_documents" in statement
    )
    assert source_parameters[8] == canonical_json_bytes(plan.source_document).decode("utf-8")
    assert source_parameters[9] == plan.source_sha256
    assert source_parameters[10].obj == plan.conversion_report
    source_reads = [
        statement
        for statement in transaction.fetches
        if "FROM app.governed_metadata_source_documents" in statement
    ]
    assert any("SELECT document" in statement for statement in source_reads)
    assert all(
        not ("document," in statement and "conversion_report" in statement)
        for statement in source_reads
    )


def test_metadata_import_persists_and_reloads_exact_raw_iso_xml() -> None:
    plan = iso_plan()
    assert isinstance(plan.source_document, str)
    transaction = ScriptedTransaction(
        one=[
            ("member",),
            (PROJECT_ID, "editor"),
            (None,),
            None,
            detail_row(),
            source_row(plan),
            (plan.source_document,),
        ],
        all_rows=[[], []],
    )
    result = asyncio.run(
        PostgresResourceRepository(ScriptedExecutor(transaction)).import_metadata_resource(  # type: ignore[arg-type]
            TenantContext(USER_ID, ORG_ID), PROJECT_ID, plan, "metadata-iso-import"
        )
    )
    source_parameters = next(
        parameters
        for statement, parameters in transaction.executions
        if "INSERT INTO app.governed_metadata_source_documents" in statement
    )
    assert source_parameters[8] == plan.source_document
    assert result.source.source_document == plan.source_document


def test_metadata_import_is_identity_safe_and_rechecks_checksum_before_database_access() -> None:
    plan = stac_plan()
    existing = (
        SOURCE_ID,
        RESOURCE_ID,
        RESOURCE_VERSION_ID,
        plan.source_version,
        plan.source_sha256,
        PROJECT_ID,
        plan.draft.slug,
        plan.draft.metadata.profile,
        None,
        None,
    )
    transaction = ScriptedTransaction(
        one=[
            ("member",),
            (PROJECT_ID, "editor"),
            (None,),
            existing,
            detail_row(),
            source_row(plan),
            (canonical_json_bytes(plan.source_document).decode("utf-8"),),
        ],
        all_rows=[[], []],
    )
    result = asyncio.run(
        PostgresResourceRepository(ScriptedExecutor(transaction)).import_metadata_resource(  # type: ignore[arg-type]
            TenantContext(USER_ID, ORG_ID), PROJECT_ID, plan, "metadata-replay"
        )
    )
    assert result.idempotent is True
    assert transaction.executions == []

    changed = list(existing)
    changed[4] = "f" * 64
    collision_transaction = ScriptedTransaction(
        one=[("member",), (PROJECT_ID, "editor"), (None,), tuple(changed)]
    )
    with pytest.raises(ResourceConflict, match="metadata_source_identifier_collision"):
        asyncio.run(
            PostgresResourceRepository(  # type: ignore[arg-type]
                ScriptedExecutor(collision_transaction)
            ).import_metadata_resource(
                TenantContext(USER_ID, ORG_ID), PROJECT_ID, plan, "metadata-collision"
            )
        )
    assert collision_transaction.executions == []

    invalid = stac_plan()
    object.__setattr__(invalid, "source_sha256", "0" * 64)
    executor = FakeExecutor()
    with pytest.raises(ResourceConflict, match="metadata_source_checksum_mismatch"):
        asyncio.run(
            PostgresResourceRepository(executor).import_metadata_resource(
                TenantContext(USER_ID, ORG_ID), PROJECT_ID, invalid, "metadata-checksum"
            )
        )
    assert executor.calls == 0


def test_project_editor_cannot_publish_without_independent_publication_authority() -> None:
    transaction = ScriptedTransaction(one=[("member", "editor", None, False)])
    repository = PostgresResourceRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]

    with pytest.raises(ResourceAccessDenied, match="action forbidden"):
        asyncio.run(
            repository.transition_resource(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                RESOURCE_ID,
                2,
                "published",
                "organization",
                "Approved",
                "publish-denied",
            )
        )

    assert transaction.executions == []


@pytest.mark.parametrize(
    ("roles", "can_update", "can_publish", "can_manage_permissions"),
    [
        (("member", "editor", None, False), True, False, False),
        (("member", None, "publish", False), False, True, False),
        (("member", None, None, True), True, False, True),
    ],
)
def test_effective_resource_capabilities_match_the_authorization_matrix(
    roles: tuple[Any, ...],
    can_update: bool,
    can_publish: bool,
    can_manage_permissions: bool,
) -> None:
    transaction = ScriptedTransaction(one=[roles])
    repository = PostgresResourceRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]

    capabilities = asyncio.run(
        repository.get_capabilities(TenantContext(USER_ID, ORG_ID), PROJECT_ID, RESOURCE_ID)
    )

    assert capabilities.can_read is True
    assert capabilities.can_update is can_update
    assert capabilities.can_publish is can_publish
    assert capabilities.can_manage_permissions is can_manage_permissions
    assert transaction.executions == []


def test_resource_capabilities_do_not_disclose_an_unreadable_resource() -> None:
    transaction = ScriptedTransaction(one=[("member", None, None, False)])
    repository = PostgresResourceRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]

    with pytest.raises(ResourceAccessDenied, match="action forbidden"):
        asyncio.run(
            repository.get_capabilities(TenantContext(USER_ID, ORG_ID), PROJECT_ID, RESOURCE_ID)
        )

    assert transaction.executions == []


def test_style_checksum_is_reverified_inside_the_repository_transaction() -> None:
    transaction = ScriptedTransaction(one=[("member", "editor", None, False)])
    repository = PostgresResourceRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]

    with pytest.raises(ResourceConflict, match="resource_style_checksum_mismatch"):
        asyncio.run(
            repository.create_style(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                RESOURCE_ID,
                ResourceStyleDraft(
                    slug="roads",
                    format="maplibre",
                    title="Roads",
                    media_type="application/vnd.mapbox.style+json",
                    definition='{"version":8}',
                    checksum_sha256="0" * 64,
                ),
                "style-checksum",
            )
        )

    assert transaction.executions == []


def test_style_format_is_immutable_across_revisions() -> None:
    definition = '{"version":8}'
    transaction = ScriptedTransaction(
        one=[("member", "editor", None, False), (1, "sld_1_0", False)]
    )
    repository = PostgresResourceRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]

    with pytest.raises(ResourceConflict, match="resource_style_format_immutable"):
        asyncio.run(
            repository.update_style(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                RESOURCE_ID,
                UUID("d0000000-0000-4000-8000-000000000093"),
                ResourceStyleUpdate(
                    expected_version=1,
                    format="maplibre",
                    title="Roads",
                    media_type="application/vnd.mapbox.style+json",
                    definition=definition,
                    checksum_sha256=sha256(definition.encode()).hexdigest(),
                    change_message=None,
                ),
                "style-format",
            )
        )

    assert transaction.executions == []


@pytest.mark.parametrize(
    ("source_state", "target_state", "visibility", "roles", "expected_version", "error"),
    [
        ("review", "published", "organization", ("member", None, "publish", False), 2, None),
        ("draft", "archived", None, ("member", "owner", None, False), 2, None),
        ("review", "archived", None, ("member", "owner", None, False), 2, None),
        ("published", "archived", None, ("member", "owner", None, False), 2, None),
        ("draft", "archived", None, ("member", "editor", None, False), 2, "action forbidden"),
        (
            "draft", "archived", None, ("member", "owner", None, False), 1,
            "resource_version_conflict",
        ),
    ],
)
def test_explicit_publisher_transition_updates_state_and_appends_both_audits(
    source_state: ResourceState,
    target_state: ResourceState,
    visibility: ResourceVisibility | None,
    roles: tuple[Any, ...],
    expected_version: int,
    error: str | None,
) -> None:
    published = list(summary_row())
    published[6] = visibility or "restricted"
    published[7] = target_state
    detail = (
        *published,
        "opengeo.core.v1",
        {},
        {},
        {"blocks": []},
        {},
        None,
        USER_ID,
        NOW,
        None,
        None,
        None,
        RESOURCE_VERSION_ID,
    )
    transaction = ScriptedTransaction(
        one=[
            roles,
            (source_state, "restricted", 2),
            detail,
        ],
        all_rows=[[], []],
    )
    repository = PostgresResourceRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]

    operation = repository.transition_resource(
        TenantContext(USER_ID, ORG_ID),
        PROJECT_ID,
        RESOURCE_ID,
        expected_version,
        target_state,
        visibility,
        "Approved",
        "publish-approved",
    )
    if error is not None:
        exception = ResourceAccessDenied if error == "action forbidden" else ResourceConflict
        with pytest.raises(exception, match=error):
            asyncio.run(operation)
        assert transaction.executions == []
        return

    record = asyncio.run(operation)

    assert record.summary.state == target_state
    assert record.summary.visibility == (visibility or "restricted")
    assert record.summary.version_number == 2
    statements = "\n".join(statement for statement, _ in transaction.executions)
    assert "governed_resource_workflow_events" in statements
    assert "activity_events" in statements
    assert "INSERT INTO app.governed_resource_versions" not in statements
    assert "app.resource_grants" not in statements
    assert transaction.executions[0][1][:2] == (target_state, visibility or "restricted")


def test_page_source_upload_request_is_authorized_version_bound_and_exactly_signed() -> None:
    source = b"# Roads"
    transaction = ScriptedTransaction(
        one=[
            ("member", "editor", None, False),
            ("story", 1),
            ("member", "editor", None, False),
            (1, "story"),
        ]
    )
    storage = ExactSourceStorage(source)
    repository = PostgresResourceRepository(  # type: ignore[arg-type]
        ScriptedExecutor(transaction), storage
    )

    ticket = asyncio.run(
        repository.request_page_source_upload(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            RESOURCE_ID,
            PageSourceUploadDraft(
                expected_resource_version=1,
                source_block_id="intro",
                size_bytes=len(source),
                checksum_sha256=sha256(source).hexdigest(),
            ),
            "page-upload",
        )
    )

    assert ticket.expected_resource_version == 1
    assert ticket.source_block_id == "intro"
    assert storage.form_specs[0].content_type == "text/markdown"
    assert storage.form_specs[0].key.startswith(
        f"organizations/{ORG_ID}/projects/{PROJECT_ID}/pages/{RESOURCE_ID}/versions/2/"
    )
    statements = "\n".join(statement for statement, _ in transaction.executions)
    assert "page_source_upload_intents" in statements
    assert "page.source.upload.requested" in transaction.executions[-1][1]


def test_page_working_draft_appends_full_private_revision_with_resource_and_draft_cas() -> None:
    update = page_draft_update()
    checksum = PostgresResourceRepository._page_working_draft_checksum(update)
    draft_row = (
        PAGE_DRAFT_ID,
        RESOURCE_ID,
        USER_ID,
        1,
        1,
        "restricted",
        update.metadata,
        update.content,
        update.provenance,
        update.source_block_id,
        update.source_markdown,
        update.change_summary,
        checksum,
        NOW,
        NOW,
    )
    transaction = ScriptedTransaction(
        one=[
            ("member", "editor", None, False),
            ("story", 1),
            (PAGE_DRAFT_ID,),
            (PAGE_DRAFT_ID, 1, 0, None),
            draft_row,
        ]
    )
    repository = PostgresResourceRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]

    saved = asyncio.run(
        repository.save_page_working_draft(
            TenantContext(USER_ID, ORG_ID), PROJECT_ID, RESOURCE_ID, update
        )
    )

    assert saved.revision_number == 1
    assert saved.source_markdown.endswith("Unapplied recovery")
    assert saved.change_summary == "Recover road edits"
    statements = "\n".join(statement for statement, _ in transaction.executions)
    assert "page_working_draft_revisions" in statements
    assert "current_revision_number" in statements


def test_page_working_draft_rejects_stale_revision_and_discards_only_exact_head() -> None:
    update = page_draft_update(expected_revision=1)
    stale = ScriptedTransaction(
        one=[
            ("member", "editor", None, False),
            ("story", 1),
            (PAGE_DRAFT_ID, 1, 2, "a" * 64),
        ]
    )
    repository = PostgresResourceRepository(ScriptedExecutor(stale))  # type: ignore[arg-type]
    with pytest.raises(ResourceConflict) as conflict:
        asyncio.run(
            repository.save_page_working_draft(
                TenantContext(USER_ID, ORG_ID), PROJECT_ID, RESOURCE_ID, update
            )
        )
    assert conflict.value.code == "page_draft_revision_conflict"
    assert conflict.value.current_draft_revision == 2
    assert stale.executions == []

    checksum = PostgresResourceRepository._page_working_draft_checksum(update)
    draft_row = (
        PAGE_DRAFT_ID,
        RESOURCE_ID,
        USER_ID,
        1,
        2,
        "restricted",
        update.metadata,
        update.content,
        update.provenance,
        update.source_block_id,
        update.source_markdown,
        update.change_summary,
        checksum,
        NOW,
        NOW,
    )
    discard = ScriptedTransaction(one=[("member", "editor", None, False), draft_row, (True,)])
    discarded = asyncio.run(
        PostgresResourceRepository(ScriptedExecutor(discard)).discard_page_working_draft(  # type: ignore[arg-type]
            TenantContext(USER_ID, ORG_ID), PROJECT_ID, RESOURCE_ID, 1, 2
        )
    )
    assert discarded is True
    assert "app.discard_page_working_draft" in discard.fetches[-1]


def test_generic_update_rejects_page_resource_without_exact_source_version() -> None:
    transaction = ScriptedTransaction(
        one=[
            ("member", "editor", None, False),
            (1, "draft", "story"),
        ]
    )
    repository = PostgresResourceRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]

    with pytest.raises(ResourceConflict, match="page_source_version_required"):
        asyncio.run(
            repository.update_resource(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                RESOURCE_ID,
                ResourceUpdate(
                    expected_version=1,
                    visibility="restricted",
                    metadata=managed_metadata(),
                    content={
                        "blocks": [{"id": "intro", "type": "markdown", "markdown": "# Roads"}]
                    },
                    provenance={},
                    change_message="Attempt a generic page save",
                ),
                "generic-page-save",
            )
        )

    assert transaction.executions == []


def test_page_version_atomically_binds_verified_source_and_required_change_summary() -> None:
    source = b"# Roads"
    expires = datetime(2027, 8, 20, 12, tzinfo=UTC)
    intent = (
        PAGE_UPLOAD_ID,
        RESOURCE_ID,
        1,
        "intro",
        len(source),
        sha256(source).hexdigest(),
        "source.opengeo.tools",
        f"organizations/{ORG_ID}/projects/{PROJECT_ID}/pages/{RESOURCE_ID}/"
        f"versions/2/uploads/{PAGE_UPLOAD_ID}/source.md",
        "pending",
        expires,
    )
    page_row = (
        PAGE_SOURCE_ID,
        RESOURCE_ID,
        RESOURCE_VERSION_ID,
        2,
        "intro",
        "source.opengeo.tools",
        intent[7],
        "immutable-source-version",
        "source-etag",
        "text/markdown",
        len(source),
        sha256(source).hexdigest(),
        "opengeo-markdown",
        "1.0.0",
        "opengeo-page-renderer-1.1.0",
        "Clarify road access",
        USER_ID,
        NOW,
    )
    transaction = ScriptedTransaction(
        one=[
            ("member", "editor", None, False),
            intent,
            ("member", "editor", None, False),
            intent,
            (True,),
            (1, "draft", "story"),
            (True,),
            detail_row(),
            page_row,
        ],
        all_rows=[[], []],
    )
    storage = ExactSourceStorage(source)
    repository = PostgresResourceRepository(  # type: ignore[arg-type]
        ScriptedExecutor(transaction), storage
    )
    metadata = ResourceMetadata(
        title="Road access story",
        abstract="Research narrative",
        language="en",
        license="CC-BY-4.0",
        attribution="Research team",
        keywords=("roads",),
        spatial_extent=None,
        temporal_start=None,
        temporal_end=None,
        profile="opengeo.core.v1",
        extensions={},
    )

    result = asyncio.run(
        repository.create_page_version(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            RESOURCE_ID,
            PAGE_UPLOAD_ID,
            ResourceUpdate(
                expected_version=1,
                visibility="restricted",
                metadata=metadata,
                content={"blocks": [{"id": "intro", "type": "markdown", "markdown": "# Roads"}]},
                provenance={},
                change_message="Clarify road access",
            ),
            "page-commit",
        )
    )

    assert result.resource.summary.version_number == 2
    assert result.source.checksum_sha256 == sha256(source).hexdigest()
    assert storage.inspect_keys == [intent[7]]
    statements = "\n".join(statement for statement, _ in transaction.executions)
    assert "INSERT INTO app.governed_resource_versions" in statements
    assert "INSERT INTO app.page_source_objects" in statements
    assert "UPDATE app.page_source_upload_intents" in statements
    assert "page.version.created" in transaction.executions[-1][1]


def test_page_version_rejects_source_that_does_not_match_the_validated_markdown_block() -> None:
    source = b"# Roads"
    intent = (
        PAGE_UPLOAD_ID,
        RESOURCE_ID,
        1,
        "intro",
        len(source),
        sha256(source).hexdigest(),
        "source.opengeo.tools",
        "organizations/source.md",
        "pending",
        datetime(2027, 8, 20, 12, tzinfo=UTC),
    )
    transaction = ScriptedTransaction(one=[("member", "editor", None, False), intent])
    repository = PostgresResourceRepository(  # type: ignore[arg-type]
        ScriptedExecutor(transaction), ExactSourceStorage(source)
    )

    with pytest.raises(ResourceConflict, match="page_source_block_mismatch"):
        asyncio.run(
            repository.create_page_version(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                RESOURCE_ID,
                PAGE_UPLOAD_ID,
                ResourceUpdate(
                    expected_version=1,
                    visibility="restricted",
                    metadata=managed_metadata(),
                    content={
                        "blocks": [{"id": "intro", "type": "markdown", "markdown": "# Drift"}]
                    },
                    provenance={},
                    change_message="Try drift",
                ),
                "page-drift",
            )
        )

    assert transaction.executions == []


def test_exact_style_version_never_falls_back_to_current_and_requires_resource_access() -> None:
    style_id = UUID("d0000000-0000-4000-8000-000000000093")
    transaction = ScriptedTransaction(one=[("member", "viewer", None, False), None])
    repository = PostgresResourceRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]
    with pytest.raises(ResourceNotFound, match="resource_style_version_not_found"):
        asyncio.run(
            repository.get_style_version(
                TenantContext(USER_ID, ORG_ID), PROJECT_ID, RESOURCE_ID, style_id, 1
            )
        )
    assert "current_version_id" not in transaction.fetches[-1]
    assert "version.version_number = %s" in transaction.fetches[-1]
    assert "style.resource_id = %s" in transaction.fetches[-1]
    assert "style.project_id = %s" in transaction.fetches[-1]
    assert "style.organization_id = %s" in transaction.fetches[-1]
    assert transaction.executions == []

    denied = ScriptedTransaction(one=[("member", None, None, False)])
    repository = PostgresResourceRepository(ScriptedExecutor(denied))  # type: ignore[arg-type]
    with pytest.raises(ResourceAccessDenied):
        asyncio.run(
            repository.get_style_version(
                TenantContext(USER_ID, ORG_ID), PROJECT_ID, RESOURCE_ID, style_id, 1
            )
        )
    assert len(denied.fetches) == 1


def test_exact_style_version_returns_retained_definition() -> None:
    style_id = UUID("d0000000-0000-4000-8000-000000000093")
    definition = '{"version":8,"sources":{},"layers":[]}\r\n'
    row = (
        style_id,
        RESOURCE_ID,
        "roads",
        "maplibre",
        1,
        "Original roads",
        "application/vnd.mapbox.style+json",
        definition,
        sha256(definition.encode()).hexdigest(),
        None,
        USER_ID,
        NOW,
        NOW,
        True,
    )
    transaction = ScriptedTransaction(one=[("member", "viewer", None, False), row])
    repository = PostgresResourceRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]
    result = asyncio.run(
        repository.get_style_version(
            TenantContext(USER_ID, ORG_ID), PROJECT_ID, RESOURCE_ID, style_id, 1
        )
    )
    assert result.definition == definition
    assert result.version_number == 1
    assert result.style_id == style_id
    assert result.archived is True
    assert "archived_at IS NULL" not in transaction.fetches[-1]
    assert transaction.executions == []


def archived_style_row(archived: bool) -> tuple[Any, ...]:
    definition = '{"version":8}'
    return (
        UUID("d0000000-0000-4000-8000-000000000093"), RESOURCE_ID,
        "roads", "maplibre", 1, "Roads", "application/json", definition,
        sha256(definition.encode()).hexdigest(), None, USER_ID, NOW, NOW, archived,
    )


@pytest.mark.parametrize(("previous", "target"), [(False, True), (True, False), (True, True)])
def test_style_archival_serializes_reversible_head_only_and_audits_changes(previous, target):
    row = archived_style_row(target)
    transaction = ScriptedTransaction(one=[("member", "editor", None, False), (1, previous), row])
    repository = PostgresResourceRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]
    result = asyncio.run(repository.set_style_archived(
        TenantContext(USER_ID, ORG_ID), PROJECT_ID, RESOURCE_ID, row[0],
        1, target, "style-archive",
    ))
    assert result.archived is target
    assert result.version_number == 1
    assert "FOR UPDATE OF style" in transaction.fetches[1]
    assert "style.organization_id = %s" in transaction.fetches[1]
    assert len(transaction.executions) == (0 if previous == target else 2)
    if previous != target:
        statement, parameters = transaction.executions[0]
        assert "UPDATE app.governed_resource_styles" in statement
        assert "current_version_id" not in statement
        assert "DELETE" not in statement
        assert parameters == (
            target, target, USER_ID, USER_ID, ORG_ID, PROJECT_ID, RESOURCE_ID, row[0]
        )
        event = transaction.executions[1][1]
        assert event[3] == ("resource.style.archived" if target else "resource.style.restored")
        assert event[4:7] == ("governed_resource_style", row[0], "style-archive")


def test_style_archive_denies_reader_and_conflicting_revision_without_writes():
    row = archived_style_row(False)
    for responses, exception in [
        ([("member", "viewer", None, False)], ResourceAccessDenied),
        ([("member", "editor", None, False), (2, False)], ResourceConflict),
    ]:
        transaction = ScriptedTransaction(one=responses)
        repository = PostgresResourceRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]
        with pytest.raises(exception):
            asyncio.run(repository.set_style_archived(
                TenantContext(USER_ID, ORG_ID), PROJECT_ID, RESOURCE_ID, row[0],
                1, True, "denied-style-archive",
            ))
        assert transaction.executions == []


def test_archived_style_rejects_definition_edit_until_restored():
    definition = '{"version":8}'
    transaction = ScriptedTransaction(
        one=[("member", "editor", None, False), (1, "maplibre", True)]
    )
    repository = PostgresResourceRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]
    with pytest.raises(ResourceConflict, match="resource_style_archived"):
        asyncio.run(repository.update_style(
            TenantContext(USER_ID, ORG_ID), PROJECT_ID, RESOURCE_ID, archived_style_row(True)[0],
            ResourceStyleUpdate(1, "maplibre", "Roads", "application/json", definition,
                                sha256(definition.encode()).hexdigest(), None),
            "archived-style-edit",
        ))
    assert transaction.executions == []


@pytest.mark.parametrize("include_archived", [False, True])
def test_style_list_filters_archives_without_changing_exact_version_reads(include_archived):
    transaction = ScriptedTransaction(one=[("member", "viewer", None, False)], all_rows=[[]])
    repository = PostgresResourceRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]
    assert asyncio.run(repository.list_styles(
        TenantContext(USER_ID, ORG_ID), PROJECT_ID, RESOURCE_ID, include_archived=include_archived,
    )) == []
    assert "(%s OR style.archived_at IS NULL)" in transaction.fetches[-1]
    assert transaction.executions == []


def test_stac_record_query_filters_before_count_and_preserves_metadata():
    extensions = {"source": {"license": "unknown"}}
    transaction = ScriptedTransaction(
        one=[("member",), (PROJECT_ID, "viewer"), (1,)],
        all_rows=[[(*summary_row(), {}, extensions)], []],
    )
    repository = PostgresResourceRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]
    page = asyncio.run(
        repository.list_record_resources(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            RecordFilters(stac_items=True, stac_ids=(f"{RESOURCE_ID}-v1",)),
        )
    )
    assert page.resources[0].metadata_extensions == extensions
    statements = "\n".join(transaction.fetches)
    assert statements.count("version.temporal_start IS NOT NULL") == 2
    assert statements.count("version.temporal_end IS NOT NULL") == 2
    assert statements.count("version.version_number::text) = ANY") == 2
    assert statements.count("resource.state::text <> 'archived'") == 2
    for cast in ("text[]", "uuid[]", "text", "double precision", "timestamptz"):
        assert f"%s::{cast} IS NULL" in statements


def test_historical_record_uses_requested_revision_and_current_resource_authority():
    extensions = {"source": {"license": "unknown"}}
    transaction = ScriptedTransaction(
        one=[("member", "viewer", None, False), (*summary_row(), {}, extensions)]
    )
    repository = PostgresResourceRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]
    record = asyncio.run(
        repository.get_record_version(TenantContext(USER_ID, ORG_ID), PROJECT_ID, RESOURCE_ID, 1)
    )
    assert record.metadata_extensions == extensions
    statement = transaction.fetches[-1]
    assert "version.version_number = %s" in statement
    assert "version.id = resource.current_version_id" not in statement
    assert "resource.state::text <> 'archived'" in statement


def test_stac_intersects_validates_topology_and_filters_both_queries():
    geometry = {"type": "Point", "coordinates": [-71, 42]}
    transaction = ScriptedTransaction(
        one=[("member",), (PROJECT_ID, "viewer"), (True,), (0,)], all_rows=[[]]
    )
    repository = PostgresResourceRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]
    page = asyncio.run(
        repository.list_record_resources(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            RecordFilters(stac_items=True, intersects=geometry),
        )
    )
    assert page.number_matched == 0
    statements = "\n".join(transaction.fetches)
    assert statements.count("ST_Intersects(") == 2
    assert "ST_IsValid" in statements
    assert "ST_MakePoint" in statements and "ST_MakeLine" in statements
