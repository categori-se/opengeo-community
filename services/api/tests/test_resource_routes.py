from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from uuid import UUID

from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.mapserver_config import convert_mapserver_configuration
from opengeo_api.metadata_adapters import metadata_source_checksum
from opengeo_api.metadata_profiles import MetadataProfile, metadata_definition_checksum
from opengeo_api.resources import (
    GovernedResource,
    MetadataResourceImportResult,
    MetadataSourceDocument,
    PageSource,
    PageSourceUploadTicket,
    PageVersion,
    PageWorkingDraft,
    RecordResource,
    RecordResourcePage,
    ResourceCapabilities,
    ResourceConflict,
    ResourceExternalIdentifier,
    ResourceImportResult,
    ResourcePermission,
    ResourceRelationship,
    ResourceStyle,
    ResourceSummary,
    ResourceWorkflowEvent,
)
from opengeo_api.s3_uploads import UploadForm
from opengeo_api.site_publications import SiteAssetCandidate

USER_ID = UUID("20000000-0000-4000-8000-000000000091")
ORG_ID = UUID("10000000-0000-4000-8000-000000000091")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000091")
RESOURCE_ID = UUID("a0000000-0000-4000-8000-000000000091")
OTHER_RESOURCE_ID = UUID("a0000000-0000-4000-8000-000000000092")
STYLE_ID = UUID("d0000000-0000-4000-8000-000000000091")
MEMBER_ID = UUID("20000000-0000-4000-8000-000000000092")
WORKFLOW_ID = UUID("e0000000-0000-4000-8000-000000000091")
DATASET_ID = UUID("80000000-0000-4000-8000-000000000091")
ASSET_VERSION_ID = UUID("81000000-0000-4000-8000-000000000091")
ASSET_OBJECT_ID = UUID("82000000-0000-4000-8000-000000000091")
RELATIONSHIP_ID = UUID("c0000000-0000-4000-8000-000000000091")
METADATA_SOURCE_ID = UUID("f0000000-0000-4000-8000-000000000091")
RESOURCE_VERSION_ID = UUID("b0000000-0000-4000-8000-000000000091")
PAGE_SOURCE_ID = UUID("b1000000-0000-4000-8000-000000000091")
PAGE_UPLOAD_ID = UUID("b2000000-0000-4000-8000-000000000091")
PAGE_DRAFT_ID = UUID("b3000000-0000-4000-8000-000000000091")
PROFILE_ID = UUID("c0000000-0000-4000-8000-000000000099")
GEONODE_ID = "11111111-1111-4111-8111-111111111111"
GEONODE_STORY_ID = "22222222-2222-4222-8222-222222222222"
NOW = datetime(2026, 8, 20, 14, tzinfo=UTC)
MAPSERVER_MAPFILE = (
    Path(__file__).parents[3]
    / "parity"
    / "fixtures"
    / "mapserver"
    / "deterministic-roads-mapserver.map"
).read_text()


class PassingProbe:
    async def check(self) -> None:
        pass


class FakeVerifier:
    async def verify(self, token: str) -> VerifiedAccessToken:
        assert token == "valid-token"
        return VerifiedAccessToken("subject", "client", "user", (), ())


class FakePrincipalRepository:
    async def resolve(self, subject: str) -> Principal:
        assert subject == "subject"
        return Principal(
            user_id=USER_ID,
            subject=subject,
            email="user@example.test",
            display_name="User",
            memberships=(OrganizationMembership(ORG_ID, "member"),),
        )


def resource(
    *,
    kind="story",
    version=1,
    relationships=False,
    resource_id=RESOURCE_ID,
) -> GovernedResource:
    summary = ResourceSummary(
        resource_id=resource_id,
        project_id=PROJECT_ID,
        kind=kind,
        slug="research-story",
        dataset_id=DATASET_ID if kind == "dataset" else None,
        map_id=None,
        visibility="restricted",
        state="review",
        version_number=version,
        title="Road access story",
        abstract="A governed mixed-content research resource.",
        language="en",
        license="CC-BY-4.0",
        attribution="Research team",
        keywords=("roads", "research"),
        spatial_extent=(84.0, 27.0, 86.0, 29.0),
        temporal_start=NOW,
        temporal_end=None,
        owner_user_id=USER_ID,
        origin_namespace="geonode",
        origin_identifier=GEONODE_ID,
        relationship_count=1 if relationships else 0,
        created_at=NOW,
        updated_at=NOW,
    )
    return GovernedResource(
        summary=summary,
        current_version_id=RESOURCE_VERSION_ID,
        metadata_profile="opengeo.core.v1",
        metadata_extensions={"geonode": {"pk": 17}},
        content={"blocks": [{"id": "intro", "type": "markdown", "markdown": "# Roads"}]},
        provenance={"sourceSystem": "geonode"},
        change_message="Metadata revision" if version > 1 else None,
        version_created_by=USER_ID,
        version_created_at=NOW,
        external_identifiers=(
            ResourceExternalIdentifier(
                namespace="geonode",
                identifier=GEONODE_ID,
                source_url="https://catalog.example.test",
                source_version="5.1.0",
                source_payload_sha256="a" * 64,
                imported_at=NOW,
            ),
        ),
        relationships=(
            ResourceRelationship(
                relationship_id=RELATIONSHIP_ID,
                source_resource_id=RESOURCE_ID,
                target_resource_id=OTHER_RESOURCE_ID,
                relation="references",
                created_by=USER_ID,
                created_at=NOW,
            ),
        )
        if relationships
        else (),
        translations={
            "fr": {
                "title": "Récit sur l'accès routier",
                "abstract": "Une ressource de recherche gouvernée.",
                "attribution": "Équipe de recherche",
                "keywords": ["routes", "recherche"],
            }
        },
    )


def resource_permission(*, role="view") -> ResourcePermission:
    return ResourcePermission(
        user_id=MEMBER_ID,
        email="member@example.test",
        display_name="Member",
        role=role,
        granted_by=USER_ID,
        created_at=NOW,
        updated_at=NOW,
    )


def metadata_source(document: dict, report: dict) -> MetadataSourceDocument:
    return MetadataSourceDocument(
        source_document_id=METADATA_SOURCE_ID,
        resource_id=RESOURCE_ID,
        resource_version_id=RESOURCE_VERSION_ID,
        source_format="stac_1_1",
        source_version="1.1.0",
        source_namespace="example.catalog",
        source_identifier="road-access-2026",
        source_document=document,
        source_sha256=metadata_source_checksum(document),
        conversion_report=report,
        imported_by=USER_ID,
        imported_at=NOW,
    )


def resource_style(
    *,
    version=1,
    format="maplibre",
    title="Roads default",
    definition='{"version":8,"sources":{},"layers":[]}',
    checksum=None,
    archived=False,
) -> ResourceStyle:
    return ResourceStyle(
        style_id=STYLE_ID,
        resource_id=RESOURCE_ID,
        slug="roads-default",
        format=format,
        version_number=version,
        title=title,
        media_type="application/vnd.mapbox.style+json",
        definition=definition,
        checksum_sha256=checksum or sha256(definition.encode()).hexdigest(),
        change_message=None,
        created_by=USER_ID,
        created_at=NOW,
        updated_at=NOW,
        archived=archived,
    )


def page_source(*, version=2, markdown=None) -> PageSource:
    source = markdown or "# Roads"
    return PageSource(
        source_id=PAGE_SOURCE_ID,
        resource_id=RESOURCE_ID,
        resource_version_id=RESOURCE_VERSION_ID,
        resource_version_number=version,
        parent_version_number=version - 1,
        source_block_id="intro",
        bucket="source.opengeo.tools",
        object_key=(
            f"organizations/{ORG_ID}/projects/{PROJECT_ID}/pages/{RESOURCE_ID}/"
            f"versions/{version}/uploads/{PAGE_UPLOAD_ID}/source.md"
        ),
        s3_version_id="immutable-source-version",
        etag="source-etag",
        content_type="text/markdown",
        size_bytes=len(source.encode()),
        checksum_sha256=sha256(source.encode()).hexdigest(),
        dialect="opengeo-markdown",
        dialect_version="1.0.0",
        compiler_version="opengeo-page-renderer-1.1.0",
        change_summary="Clarify road access",
        created_by=USER_ID,
        created_at=NOW,
        source_markdown=source,
    )


def page_working_draft(*, revision=1) -> PageWorkingDraft:
    payload = create_payload()
    return PageWorkingDraft(
        draft_id=PAGE_DRAFT_ID,
        resource_id=RESOURCE_ID,
        owner_user_id=USER_ID,
        base_resource_version=1,
        revision_number=revision,
        visibility="restricted",
        metadata=payload["metadata"],
        content=payload["content"],
        provenance=payload["provenance"],
        source_block_id="intro",
        source_markdown="# Roads\n\nRecovered privately.",
        change_summary="Recover road access edits",
        document_checksum_sha256="f" * 64,
        created_at=NOW,
        updated_at=NOW,
    )


def metadata_definition() -> dict:
    return {
        "schema_version": "1.0.0",
        "required_core": ["title", "abstract", "license"],
        "core_vocabularies": {"license": ["CC-BY-4.0"]},
        "required_languages": [],
        "extension_fields": [],
    }


def metadata_profile(*, version=1) -> MetadataProfile:
    definition = metadata_definition()
    return MetadataProfile(
        profile_id=PROFILE_ID,
        slug="research.core",
        title="Research core",
        description="Curated research metadata",
        version_number=version,
        definition=definition,
        checksum_sha256=metadata_definition_checksum(definition),
        change_message=None,
        created_by=USER_ID,
        version_created_by=USER_ID,
        created_at=NOW,
        updated_at=NOW,
        version_created_at=NOW,
    )


class FakeMetadataProfileRepository:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def list_profiles(self, context):
        self.calls.append(("list", context))
        return [metadata_profile()]

    async def get_profile(self, context, profile_id):
        self.calls.append(("get", context, profile_id))
        return metadata_profile()

    async def create_profile(self, context, draft, request_id):
        self.calls.append(("create", context, draft, request_id))
        return metadata_profile()

    async def update_profile(self, context, profile_id, update, request_id):
        self.calls.append(("update", context, profile_id, update, request_id))
        return metadata_profile(version=update.expected_version + 1)


class FakeResourceRepository:
    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.working_draft = None

    async def list_resources(self, context, project_id, filters):
        self.calls.append(("list", context, project_id, filters))
        return [resource().summary]

    async def list_record_resources(self, context, project_id, filters):
        self.calls.append(("records", context, project_id, filters))
        record = resource()
        return RecordResourcePage(
            resources=(
                RecordResource(
                    summary=record.summary,
                    translations=record.translations,
                    external_identifiers=record.external_identifiers,
                ),
            ),
            number_matched=1,
        )

    async def get_resource(self, context, project_id, resource_id):
        self.calls.append(("get", context, project_id, resource_id))
        if resource_id == OTHER_RESOURCE_ID:
            return resource(kind="map", resource_id=OTHER_RESOURCE_ID)
        return resource(relationships=True)

    async def get_record_version(self, context, project_id, resource_id, version):
        return await self.get_resource(context, project_id, resource_id)

    async def create_resource(self, context, project_id, draft, request_id):
        self.calls.append(("create", context, project_id, draft, request_id))
        return resource()

    async def update_resource(self, context, project_id, resource_id, update, request_id):
        self.calls.append(("update", context, project_id, resource_id, update, request_id))
        return resource(version=update.expected_version + 1)

    async def request_page_source_upload(self, context, project_id, resource_id, draft, request_id):
        self.calls.append(
            ("page-source-upload", context, project_id, resource_id, draft, request_id)
        )
        return PageSourceUploadTicket(
            upload_id=PAGE_UPLOAD_ID,
            resource_id=resource_id,
            expected_resource_version=draft.expected_resource_version,
            source_block_id=draft.source_block_id,
            upload=UploadForm(
                url="https://s3.us-east-1.amazonaws.com/source.opengeo.tools",
                method="POST",
                fields={"key": "exact-source-key"},
                expires_at=NOW,
            ),
        )

    async def create_page_version(
        self, context, project_id, resource_id, upload_id, update, request_id
    ):
        self.calls.append(
            ("page-version", context, project_id, resource_id, upload_id, update, request_id)
        )
        return PageVersion(resource=resource(version=2), source=page_source())

    async def get_page_working_draft(self, context, project_id, resource_id):
        self.calls.append(("page-draft-get", context, project_id, resource_id))
        return self.working_draft

    async def save_page_working_draft(self, context, project_id, resource_id, update):
        self.calls.append(("page-draft-save", context, project_id, resource_id, update))
        self.working_draft = page_working_draft(revision=update.expected_draft_revision + 1)
        return self.working_draft

    async def discard_page_working_draft(
        self,
        context,
        project_id,
        resource_id,
        expected_resource_version,
        expected_draft_revision,
    ):
        self.calls.append(
            (
                "page-draft-discard",
                context,
                project_id,
                resource_id,
                expected_resource_version,
                expected_draft_revision,
            )
        )
        self.working_draft = None
        return True

    async def list_page_versions(self, context, project_id, resource_id):
        self.calls.append(("page-versions", context, project_id, resource_id))
        return [page_source()]

    async def get_page_source(self, context, project_id, resource_id, version_number=None):
        self.calls.append(("page-source", context, project_id, resource_id, version_number))
        return page_source(version=version_number or 2)

    async def add_relationship(
        self, context, project_id, source_resource_id, target_resource_id, relation, request_id
    ):
        self.calls.append(
            (
                "relationship",
                context,
                project_id,
                source_resource_id,
                target_resource_id,
                relation,
                request_id,
            )
        )
        return resource(relationships=True)

    async def import_resources(self, context, project_id, plan, request_id):
        self.calls.append(("import", context, project_id, plan, request_id))
        return ResourceImportResult(resources=(resource(),), report=plan.report, idempotent=False)

    async def import_metadata_resource(self, context, project_id, plan, request_id):
        self.calls.append(("metadata-import", context, project_id, plan, request_id))
        return MetadataResourceImportResult(
            resource=resource(kind="dataset"),
            source=metadata_source(plan.source_document, plan.conversion_report),
            idempotent=False,
        )

    async def get_metadata_source(self, context, project_id, resource_id):
        self.calls.append(("metadata-source", context, project_id, resource_id))
        document = stac_metadata_document()
        return metadata_source(
            document,
            {"schemaVersion": "1.0.0", "status": "mapped", "unmapped": []},
        )

    async def bind_resource(
        self, context, project_id, resource_id, expected_version, dataset_id, map_id, request_id
    ):
        self.calls.append(
            (
                "bind",
                context,
                project_id,
                resource_id,
                expected_version,
                dataset_id,
                map_id,
                request_id,
            )
        )
        return resource(kind="dataset")

    async def transition_resource(
        self,
        context,
        project_id,
        resource_id,
        expected_version,
        target_state,
        visibility,
        reason,
        request_id,
    ):
        self.calls.append(
            (
                "transition",
                context,
                project_id,
                resource_id,
                expected_version,
                target_state,
                visibility,
                reason,
                request_id,
            )
        )
        return resource()

    async def get_capabilities(self, context, project_id, resource_id):
        self.calls.append(("capabilities", context, project_id, resource_id))
        return ResourceCapabilities(
            can_read=True,
            can_update=True,
            can_publish=False,
            can_manage_permissions=True,
        )

    async def list_permissions(self, context, project_id, resource_id):
        self.calls.append(("permissions", context, project_id, resource_id))
        return [resource_permission()]

    async def put_permission(self, context, project_id, resource_id, grant, request_id):
        self.calls.append(("put-permission", context, project_id, resource_id, grant, request_id))
        return resource_permission(role=grant.role)

    async def delete_permission(self, context, project_id, resource_id, user_id, request_id):
        self.calls.append(
            ("delete-permission", context, project_id, resource_id, user_id, request_id)
        )

    async def list_styles(self, context, project_id, resource_id, *, include_archived=False):
        self.calls.append(("styles", context, project_id, resource_id))
        return [resource_style()]

    async def set_style_archived(
        self, context, project_id, resource_id, style_id, expected_version, archived, request_id
    ):
        self.calls.append(
            (
                "style-archive",
                context,
                project_id,
                resource_id,
                style_id,
                expected_version,
                archived,
                request_id,
            )
        )
        return resource_style(version=expected_version, archived=archived)

    async def get_style_version(self, context, project_id, resource_id, style_id, version_number):
        self.calls.append(
            ("style-version", context, project_id, resource_id, style_id, version_number)
        )
        return resource_style(version=version_number)

    async def create_style(self, context, project_id, resource_id, draft, request_id):
        self.calls.append(("create-style", context, project_id, resource_id, draft, request_id))
        return resource_style(
            format=draft.format,
            title=draft.title,
            definition=draft.definition,
            checksum=draft.checksum_sha256,
        )

    async def update_style(self, context, project_id, resource_id, style_id, update, request_id):
        self.calls.append(
            ("update-style", context, project_id, resource_id, style_id, update, request_id)
        )
        return resource_style(
            version=update.expected_version + 1,
            format=update.format,
            title=update.title,
            definition=update.definition,
            checksum=update.checksum_sha256,
        )

    async def list_workflow_events(self, context, project_id, resource_id):
        self.calls.append(("workflow", context, project_id, resource_id))
        return [
            ResourceWorkflowEvent(
                event_id=WORKFLOW_ID,
                source_state="draft",
                target_state="review",
                reason="Ready for review",
                actor_user_id=USER_ID,
                created_at=NOW,
            )
        ]


class ConflictingResourceRepository(FakeResourceRepository):
    async def update_resource(self, *args, **kwargs):
        del args, kwargs
        raise ResourceConflict("resource_version_conflict", current_version=7)


class MapServerExportResourceRepository(FakeResourceRepository):
    async def list_styles(self, context, project_id, resource_id):
        self.calls.append(("styles", context, project_id, resource_id))
        converted = convert_mapserver_configuration(MAPSERVER_MAPFILE)
        return [resource_style(definition=converted.style_definition)]


class FakeSitePublicationRepository:
    def __init__(self, candidates: tuple[SiteAssetCandidate, ...] = ()) -> None:
        self.candidates = candidates
        self.calls: list[tuple] = []

    async def list_asset_candidates(self, context, project_id):
        self.calls.append((context, project_id))
        return self.candidates


def api_client(
    repository: FakeResourceRepository,
    metadata_repository: FakeMetadataProfileRepository | None = None,
    site_repository: FakeSitePublicationRepository | None = None,
) -> TestClient:
    return TestClient(
        create_app(
            settings=Settings(env="test", expose_docs=True),
            readiness_probe=PassingProbe(),
            token_verifier=FakeVerifier(),
            principal_repository=FakePrincipalRepository(),
            resource_repository=repository,
            metadata_profile_repository=metadata_repository,
            site_publication_repository=site_repository or FakeSitePublicationRepository(),
        )
    )


def headers() -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(ORG_ID),
        "X-Request-ID": "request-resource-123",
    }


def metadata_payload() -> dict:
    return {
        "title": "Road access story",
        "abstract": "A governed mixed-content research resource.",
        "language": "en",
        "license": "CC-BY-4.0",
        "attribution": "Research team",
        "keywords": ["roads", "research"],
        "spatial_extent": [84.0, 27.0, 86.0, 29.0],
        "temporal_start": "2026-08-20T14:00:00Z",
        "profile": "opengeo.core.v1",
        "extensions": {"research": {"method": "survey"}},
    }


def stac_metadata_document() -> dict:
    return {
        "type": "Collection",
        "stac_version": "1.1.0",
        "stac_extensions": [],
        "id": "road-access-2026",
        "title": "Road access survey",
        "description": "Verified road access metadata.",
        "license": "CC-BY-4.0",
        "keywords": ["roads", "access"],
        "extent": {
            "spatial": {"bbox": [[84.0, 27.0, 86.0, 29.0]]},
            "temporal": {"interval": [["2026-01-01T00:00:00Z", None]]},
        },
        "links": [],
    }


def create_payload() -> dict:
    return {
        "kind": "story",
        "slug": "research-story",
        "visibility": "restricted",
        "metadata": metadata_payload(),
        "content": {
            "blocks": [
                {"id": "intro", "type": "markdown", "markdown": "# Roads"},
                {
                    "id": "source-map",
                    "type": "map",
                    "resource_id": str(OTHER_RESOURCE_ID),
                    "resource_version_number": 1,
                    "caption": "Access map",
                },
                {
                    "id": "citation",
                    "type": "citation",
                    "title": "Access study",
                    "doi": "10.1234/access-study",
                },
            ]
        },
        "provenance": {"method": "survey"},
    }


def geonode_payload() -> dict:
    return {
        "source_product": "geonode",
        "source_version": "5.1.0",
        "source_commit": "a1db97e81dfc26c16bb4ee1a5d2b408877af66c9",
        "source_url": "https://catalog.example.test",
        "resources": [
            {
                "pk": 17,
                "uuid": GEONODE_ID,
                "resource_type": "dataset",
                "title": "Road network",
                "abstract": "Verified roads",
                "language": "en",
                "keywords": ["roads"],
                "extent": {"coords": [84.0, 27.0, 86.0, 29.0], "srid": "EPSG:4326"},
                "is_published": True,
                "detail_url": "https://catalog.example.test/catalogue/17",
                "custom_field": {"reviewed": True},
            },
            {
                "pk": 18,
                "uuid": GEONODE_STORY_ID,
                "resource_type": "geoapp",
                "subtype": "geostory",
                "title": "Road story",
                "language": "en",
                "data": {"pages": [{"title": "Roads"}]},
            },
        ],
        "relationships": [
            {
                "source_uuid": GEONODE_STORY_ID,
                "target_uuid": GEONODE_ID,
                "relation": "references",
            }
        ],
    }


def test_list_supports_text_spatial_temporal_and_faceted_filters() -> None:
    repository = FakeResourceRepository()
    response = api_client(repository).get(
        f"/projects/{PROJECT_ID}/resources",
        headers=headers(),
        params={
            "query": "roads",
            "kind": "story",
            "visibility": "restricted",
            "state": "review",
            "bbox": "84,27,86,29",
            "temporal_start": "2026-01-01T00:00:00Z",
            "limit": 25,
        },
    )

    assert response.status_code == 200
    assert response.json()[0]["origin_identifier"] == GEONODE_ID
    filters = repository.calls[0][3]
    assert filters.query == "roads"
    assert filters.bbox == (84.0, 27.0, 86.0, 29.0)
    assert filters.temporal_start.year == 2026


def test_current_resource_detail_exposes_exact_metadata_edition() -> None:
    response = api_client(FakeResourceRepository()).get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}", headers=headers()
    )
    assert response.status_code == 200
    assert response.json()["current_version_id"] == str(RESOURCE_VERSION_ID)
    assert response.json()["version_number"] == 1


def test_create_update_and_relationship_use_bounded_typed_contracts() -> None:
    repository = FakeResourceRepository()
    client = api_client(repository)
    created = client.post(
        f"/projects/{PROJECT_ID}/resources", headers=headers(), json=create_payload()
    )
    update = create_payload()
    updated = client.put(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}",
        headers=headers(),
        json={
            "expected_version": 1,
            "visibility": "organization",
            "metadata": update["metadata"],
            "content": update["content"],
            "provenance": update["provenance"],
            "change_message": "Editorial review",
        },
    )
    related = client.post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/relationships",
        headers=headers(),
        json={"target_resource_id": str(OTHER_RESOURCE_ID), "relation": "references"},
    )

    assert created.status_code == 201
    assert updated.status_code == 200
    assert updated.json()["version_number"] == 2
    assert related.status_code == 201
    assert related.json()["relationships"][0]["target_resource_id"] == str(OTHER_RESOURCE_ID)
    assert repository.calls[0][3].content["blocks"][1]["type"] == "map"
    assert repository.calls[1][4].change_message == "Editorial review"


def test_page_source_routes_bind_exact_upload_version_history_and_utf8_source() -> None:
    repository = FakeResourceRepository()
    client = api_client(repository)
    markdown = "# Roads"
    payload = create_payload()
    requested = client.post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/page-source-uploads",
        headers=headers(),
        json={
            "expected_version": 1,
            "source_block_id": "intro",
            "size_bytes": len(markdown.encode()),
            "checksum_sha256": sha256(markdown.encode()).hexdigest(),
        },
    )
    committed = client.post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/page-versions",
        headers=headers(),
        json={
            "upload_id": str(PAGE_UPLOAD_ID),
            "expected_version": 1,
            "visibility": "organization",
            "metadata": payload["metadata"],
            "content": payload["content"],
            "provenance": payload["provenance"],
            "change_message": "Clarify road access",
        },
    )
    history = client.get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/page-versions",
        headers=headers(),
    )
    current = client.get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/page-source",
        headers=headers(),
    )
    historical = client.get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/page-versions/2/source",
        headers=headers(),
    )

    assert requested.status_code == 201
    assert requested.json()["upload_id"] == str(PAGE_UPLOAD_ID)
    assert requested.json()["upload"]["method"] == "POST"
    assert committed.status_code == 201
    assert committed.json()["resource"]["version_number"] == 2
    assert committed.json()["source"]["checksum_sha256"] == sha256(markdown.encode()).hexdigest()
    assert history.status_code == 200
    assert history.json()[0]["compiler_version"] == "opengeo-page-renderer-1.1.0"
    assert current.json()["source_markdown"] == markdown
    assert historical.json()["resource_version_number"] == 2
    page_commit = next(call for call in repository.calls if call[0] == "page-version")
    assert page_commit[5].change_message == "Clarify road access"


def test_page_working_draft_routes_restore_save_and_exact_discard_private_state() -> None:
    repository = FakeResourceRepository()
    client = api_client(repository)
    payload = create_payload()
    path = f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/page-draft"

    empty = client.get(path, headers=headers())
    saved = client.put(
        path,
        headers=headers(),
        json={
            "expected_resource_version": 1,
            "expected_draft_revision": 0,
            "visibility": "restricted",
            "metadata": payload["metadata"],
            "content": payload["content"],
            "provenance": payload["provenance"],
            "source_block_id": "intro",
            "source_markdown": "# Roads\n\nRecovered privately.",
            "change_summary": "Recover road access edits",
        },
    )
    restored = client.get(path, headers=headers())
    discarded = client.delete(
        f"{path}?expected_resource_version=1&expected_draft_revision=1",
        headers=headers(),
    )

    assert empty.status_code == 200
    assert empty.json() is None
    assert saved.status_code == 200
    assert saved.json()["revision_number"] == 1
    assert saved.json()["source_markdown"].endswith("privately.")
    assert saved.json()["change_summary"] == "Recover road access edits"
    assert restored.json()["document_checksum_sha256"] == "f" * 64
    assert discarded.status_code == 204
    save_call = next(call for call in repository.calls if call[0] == "page-draft-save")
    assert save_call[4].expected_draft_revision == 0
    assert save_call[4].source_markdown.endswith("privately.")
    assert repository.calls[-1][0] == "page-draft-discard"


def test_page_preview_uses_pinned_publication_renderer_and_validates_versioned_dependencies() -> (
    None
):
    repository = FakeResourceRepository()
    payload = create_payload()
    payload["content"]["blocks"][0]["markdown"] = "# Roads\n\n<script>alert('no')</script>"
    response = api_client(repository).post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/page-versions/1/preview",
        headers=headers(),
        json={
            "title": "Road access preview",
            "abstract": "Authorized draft preview",
            "content": payload["content"],
        },
    )

    assert response.status_code == 200
    document = response.json()
    assert document["renderer_version"] == "opengeo-page-renderer-1.1.0"
    assert len(document["content_checksum_sha256"]) == 64
    assert set(document["content_checksum_sha256"]) <= set("0123456789abcdef")
    assert 'data-renderer-version="opengeo-page-renderer-1.1.0"' in document["html"]
    assert "&lt;script&gt;alert" in document["html"]
    assert "<script" not in document["html"]
    assert document["dependencies"] == [
        {
            "block_id": "source-map",
            "kind": "map",
            "resource_id": str(OTHER_RESOURCE_ID),
            "resource_version_number": 1,
            "dataset_id": None,
            "dataset_version_id": None,
            "object_id": None,
            "checksum_sha256": None,
        }
    ]

    payload["content"]["blocks"][1]["resource_version_number"] = 2
    stale = api_client(FakeResourceRepository()).post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/page-versions/1/preview",
        headers=headers(),
        json={
            "title": "Road access preview",
            "content": payload["content"],
        },
    )
    assert stale.status_code == 409
    assert stale.json()["detail"] == {
        "code": "page_dependency_version_conflict",
        "current_version": 1,
    }


def test_page_preview_authorizes_exact_media_without_exposing_storage_locations() -> None:
    checksum = "d" * 64
    site_repository = FakeSitePublicationRepository(
        (
            SiteAssetCandidate(
                kind="image",
                dataset_id=DATASET_ID,
                dataset_name="Evidence images",
                dataset_version_id=ASSET_VERSION_ID,
                dataset_version_number=3,
                object_id=ASSET_OBJECT_ID,
                role="source",
                content_type="image/png",
                size_bytes=2_048,
                checksum_sha256=checksum,
                filename="road-access.png",
            ),
        )
    )
    content = {
        "blocks": [
            {
                "id": "access-image",
                "type": "image",
                "dataset_id": str(DATASET_ID),
                "dataset_version_id": str(ASSET_VERSION_ID),
                "object_id": str(ASSET_OBJECT_ID),
                "alt_text": "Road access coverage by district",
                "caption": "Verified coverage image",
            }
        ]
    }
    response = api_client(FakeResourceRepository(), site_repository=site_repository).post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/page-versions/1/preview",
        headers=headers(),
        json={"title": "Media preview", "content": content},
    )

    assert response.status_code == 200
    document = response.json()
    assert document["dependencies"] == [
        {
            "block_id": "access-image",
            "kind": "image",
            "resource_id": None,
            "resource_version_number": None,
            "dataset_id": str(DATASET_ID),
            "dataset_version_id": str(ASSET_VERSION_ID),
            "object_id": str(ASSET_OBJECT_ID),
            "checksum_sha256": checksum,
        }
    ]
    assert "Road access coverage by district" in document["html"]
    assert str(ASSET_OBJECT_ID) in document["html"]
    assert checksum in document["html"]
    assert "s3" not in document["html"].casefold()
    assert "https://" not in document["html"]

    content["blocks"][0]["dataset_version_id"] = str(RESOURCE_VERSION_ID)
    rejected = api_client(FakeResourceRepository(), site_repository=site_repository).post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/page-versions/1/preview",
        headers=headers(),
        json={"title": "Media preview", "content": content},
    )
    assert rejected.status_code == 409
    assert rejected.json()["detail"] == {"code": "page_asset_not_publishable"}


def test_page_version_requires_a_nonempty_change_summary_before_repository_work() -> None:
    repository = FakeResourceRepository()
    payload = create_payload()
    response = api_client(repository).post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/page-versions",
        headers=headers(),
        json={
            "upload_id": str(PAGE_UPLOAD_ID),
            "expected_version": 1,
            "visibility": "restricted",
            "metadata": payload["metadata"],
            "content": payload["content"],
            "provenance": payload["provenance"],
            "change_message": "   ",
        },
    )

    assert response.status_code == 422
    assert repository.calls == []


def test_create_rejects_unbound_local_map_and_unsafe_or_oversized_content() -> None:
    repository = FakeResourceRepository()
    unbound = create_payload()
    unbound["kind"] = "map"
    duplicate_blocks = create_payload()
    duplicate_blocks["content"]["blocks"].append(
        {"id": "intro", "type": "markdown", "markdown": "duplicate"}
    )
    unsafe_link = create_payload()
    unsafe_link["content"]["blocks"].append(
        {
            "id": "unsafe",
            "type": "link",
            "url": "https://127.0.0.1/private",
            "label": "Unsafe",
        }
    )
    unpaired_profile = create_payload()
    unpaired_profile["metadata"]["managed_profile_id"] = str(PROFILE_ID)

    client = api_client(repository)
    assert (
        client.post(
            f"/projects/{PROJECT_ID}/resources", headers=headers(), json=unbound
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"/projects/{PROJECT_ID}/resources", headers=headers(), json=duplicate_blocks
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"/projects/{PROJECT_ID}/resources", headers=headers(), json=unsafe_link
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"/projects/{PROJECT_ID}/resources", headers=headers(), json=unpaired_profile
        ).status_code
        == 422
    )
    assert repository.calls == []


def test_create_accepts_bounded_portable_blocks_and_rejects_invalid_series() -> None:
    payload = create_payload()
    payload["content"]["blocks"].extend(
        [
            {
                "id": "findings-heading",
                "type": "heading",
                "level": 2,
                "text": "Findings",
            },
            {
                "id": "methods-heading",
                "type": "heading",
                "level": 3,
                "text": "Methods",
            },
            {
                "id": "review-note",
                "type": "callout",
                "tone": "important",
                "title": "Review status",
                "markdown": "Confirm the [source](https://evidence.example.test/source).",
            },
            {
                "id": "page-navigation",
                "type": "navigation",
                "label": "On this page",
                "heading_block_ids": ["findings-heading", "methods-heading"],
            },
            {
                "id": "survey-table",
                "type": "table",
                "caption": "Survey results",
                "columns": ["District", "Households", "Coverage"],
                "rows": [["East", 120, 0.75], ["West", 80, 0.5]],
            },
            {
                "id": "coverage-chart",
                "type": "chart",
                "chart_type": "bar",
                "title": "Coverage by district",
                "alt_text": "East coverage is 75 percent and West coverage is 50 percent.",
                "table_block_id": "survey-table",
                "x_column": "District",
                "y_columns": ["Coverage"],
            },
            {
                "id": "coverage-image",
                "type": "image",
                "dataset_id": str(DATASET_ID),
                "dataset_version_id": "81000000-0000-4000-8000-000000000091",
                "object_id": "82000000-0000-4000-8000-000000000091",
                "alt_text": "A classified survey coverage raster.",
                "caption": "Survey coverage",
            },
            {
                "id": "source-download",
                "type": "file",
                "dataset_id": str(DATASET_ID),
                "dataset_version_id": "81000000-0000-4000-8000-000000000091",
                "object_id": "83000000-0000-4000-8000-000000000091",
                "label": "Download source GeoJSON",
                "description": "Exact immutable source used by this report.",
            },
            {
                "id": "field-report-document",
                "type": "document",
                "dataset_id": str(DATASET_ID),
                "dataset_version_id": "81000000-0000-4000-8000-000000000091",
                "object_id": "84000000-0000-4000-8000-000000000091",
                "label": "Read the field report",
            },
        ]
    )
    repository = FakeResourceRepository()
    response = api_client(repository).post(
        f"/projects/{PROJECT_ID}/resources", headers=headers(), json=payload
    )

    assert response.status_code == 201
    saved_blocks = repository.calls[0][3].content["blocks"]
    assert next(block for block in saved_blocks if block["type"] == "chart")["chart_type"] == "bar"
    assert next(block for block in saved_blocks if block["type"] == "navigation")[
        "heading_block_ids"
    ] == ["findings-heading", "methods-heading"]
    assert (
        next(block for block in saved_blocks if block["type"] == "callout")["tone"] == "important"
    )
    assert next(block for block in saved_blocks if block["type"] == "image")["alt_text"].startswith(
        "A classified"
    )
    assert saved_blocks[-2]["type"] == "file"
    assert saved_blocks[-1]["type"] == "document"

    invalid = create_payload()
    invalid["content"]["blocks"].extend(payload["content"]["blocks"][-5:-3])
    invalid["content"]["blocks"][-1]["y_columns"] = ["District"]
    rejected_repository = FakeResourceRepository()
    rejected = api_client(rejected_repository).post(
        f"/projects/{PROJECT_ID}/resources", headers=headers(), json=invalid
    )
    assert rejected.status_code == 422
    assert rejected_repository.calls == []

    invalid_navigation = create_payload()
    invalid_navigation["content"]["blocks"].extend(payload["content"]["blocks"][:4])
    invalid_navigation["content"]["blocks"][-1]["heading_block_ids"] = ["missing-heading"]
    invalid_navigation_repository = FakeResourceRepository()
    invalid_navigation_response = api_client(invalid_navigation_repository).post(
        f"/projects/{PROJECT_ID}/resources", headers=headers(), json=invalid_navigation
    )
    assert invalid_navigation_response.status_code == 422
    assert invalid_navigation_repository.calls == []

    invalid_outline = create_payload()
    invalid_outline["content"]["blocks"].append(
        {"id": "skipped-heading", "type": "heading", "level": 3, "text": "Skipped"}
    )
    invalid_outline_repository = FakeResourceRepository()
    invalid_outline_response = api_client(invalid_outline_repository).post(
        f"/projects/{PROJECT_ID}/resources", headers=headers(), json=invalid_outline
    )
    assert invalid_outline_response.status_code == 422
    assert invalid_outline_repository.calls == []


def test_metadata_profile_routes_and_resource_validation_use_shared_auth() -> None:
    resources = FakeResourceRepository()
    profiles = FakeMetadataProfileRepository()
    client = api_client(resources, profiles)

    listed = client.get("/metadata-profiles", headers=headers())
    created = client.post(
        "/metadata-profiles",
        headers=headers(),
        json={
            "slug": "research.core",
            "title": "Research core",
            "description": "Curated research metadata",
            "definition": metadata_definition(),
        },
    )
    fetched = client.get(f"/metadata-profiles/{PROFILE_ID}", headers=headers())
    updated = client.put(
        f"/metadata-profiles/{PROFILE_ID}",
        headers=headers(),
        json={
            "expected_version": 1,
            "title": "Research core revised",
            "description": "Curated research metadata",
            "definition": metadata_definition(),
            "change_message": "Vocabulary review",
        },
    )
    validated = client.post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/metadata/validate",
        headers=headers(),
        json={"profile_id": str(PROFILE_ID), "expected_profile_version": 1},
    )

    assert listed.status_code == 200
    assert listed.json()[0]["checksum_sha256"] == metadata_definition_checksum(
        metadata_definition()
    )
    assert created.status_code == 201
    assert fetched.status_code == 200
    assert updated.status_code == 200
    assert updated.json()["version_number"] == 2
    assert profiles.calls[1][2].checksum_sha256 == metadata_definition_checksum(
        metadata_definition()
    )
    assert validated.status_code == 200
    assert validated.json()["report"]["status"] == "valid"
    assert resources.calls[-1][0] == "get"
    paths = client.get("/openapi.json").json()["paths"]
    assert "/metadata-profiles" in paths
    assert "/projects/{project_id}/resources/{resource_id}/metadata/export/{target}" in paths


def test_metadata_profile_version_conflicts_and_malformed_definitions_fail_closed() -> None:
    resources = FakeResourceRepository()
    profiles = FakeMetadataProfileRepository()
    client = api_client(resources, profiles)

    conflict = client.post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/metadata/validate",
        headers=headers(),
        json={"profile_id": str(PROFILE_ID), "expected_profile_version": 2},
    )
    malformed = client.post(
        "/metadata-profiles",
        headers=headers(),
        json={
            "slug": "research.core",
            "title": "Research core",
            "definition": {
                **metadata_definition(),
                "extension_fields": [
                    {
                        "namespace": "research",
                        "name": "score",
                        "type": "number",
                        "title": "Score",
                        "vocabulary": ["high"],
                    }
                ],
            },
        },
    )

    assert conflict.status_code == 409
    assert conflict.json()["detail"] == {
        "code": "metadata_profile_version_conflict",
        "current_version": 1,
    }
    assert malformed.status_code == 422
    assert resources.calls == []


def test_dcat_and_stac_export_routes_return_explicit_conversion_reports() -> None:
    client = api_client(FakeResourceRepository(), FakeMetadataProfileRepository())

    dcat = client.get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/metadata/export/dcat_3",
        headers=headers(),
    )
    stac = client.get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/metadata/export/stac_1_1",
        headers=headers(),
    )

    assert dcat.status_code == 200
    assert dcat.json()["target_version"] == "W3C Recommendation 2024-08-22"
    assert dcat.json()["document"]["@type"] == "dcat:Resource"
    assert dcat.json()["report"]["preservedExtensions"] == ["geonode"]
    assert stac.status_code == 200
    assert stac.json()["status"] == "not_applicable"
    assert stac.json()["document"] is None


def test_project_records_routes_negotiate_one_language_and_bind_core_filters() -> None:
    repository = FakeResourceRepository()
    client = api_client(repository, FakeMetadataProfileRepository())

    landing = client.get(f"/projects/{PROJECT_ID}/records", headers=headers())
    api_description = client.get(f"/projects/{PROJECT_ID}/records/api", headers=headers())
    conformance = client.get(f"/projects/{PROJECT_ID}/records/conformance", headers=headers())
    listed = client.get(
        f"/projects/{PROJECT_ID}/records/collections/resources/items",
        headers=headers(),
        params={
            "q": "routes,recherche",
            "type": "story",
            "ids": str(RESOURCE_ID),
            "externalIds": f"geonode:{GEONODE_ID}",
            "bbox": "84,27,86,29",
            "datetime": "2026-01-01/..",
            "language": "fr",
        },
    )
    item = client.get(
        f"/projects/{PROJECT_ID}/records/collections/resources/items/{RESOURCE_ID}",
        headers=headers(),
        params={"language": "fr"},
    )
    missing = client.get(f"/projects/{PROJECT_ID}/records/collections/unknown", headers=headers())

    assert landing.status_code == 200
    landing_links = landing.json()["links"]
    assert any(link["rel"] == "service-desc" for link in landing_links)
    assert all(
        link["href"].startswith(f"http://testserver/projects/{PROJECT_ID}/records")
        for link in landing_links
    )
    assert api_description.status_code == 200
    assert api_description.headers["content-type"].startswith(
        "application/vnd.oai.openapi+json;version=3.0"
    )
    assert api_description.json()["security"] == [{"bearerAuth": []}]
    assert conformance.json()["conformsTo"] == []
    assert listed.status_code == 200
    assert listed.headers["content-type"].startswith("application/geo+json")
    assert listed.json()["features"][0]["properties"]["language"] == {"code": "fr"}
    assert item.headers["content-language"] == "fr"
    assert item.json()["properties"]["title"] == "Récit sur l'accès routier"
    filters = next(call[3] for call in repository.calls if call[0] == "records" and call[3].query)
    assert filters.kinds == ("story",)
    assert filters.ids == (RESOURCE_ID,)
    assert filters.bbox == (84.0, 27.0, 86.0, 29.0)
    assert missing.status_code == 404


def test_stac_import_and_exact_source_read_use_shared_auth_and_canonical_checksum() -> None:
    repository = FakeResourceRepository()
    client = api_client(repository, FakeMetadataProfileRepository())
    document = stac_metadata_document()

    imported = client.post(
        f"/projects/{PROJECT_ID}/resources/imports/metadata/stac_1_1",
        headers=headers(),
        json={
            "source_namespace": "example.catalog",
            "slug": "road-access-stac",
            "visibility": "organization",
            "document": document,
            "source_sha256": metadata_source_checksum(document),
        },
    )
    source = client.get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/metadata/source",
        headers=headers(),
    )

    assert imported.status_code == 201
    assert imported.json()["idempotent"] is False
    assert imported.json()["source"]["document"] == document
    assert imported.json()["source"]["canonical_json_sha256"] == metadata_source_checksum(document)
    plan = repository.calls[0][3]
    assert plan.draft.kind == "dataset"
    assert plan.draft.state == "review"
    assert plan.conversion_report["unmapped"] == ["links", "stac_extensions"]
    assert source.status_code == 200
    assert source.json()["source_identifier"] == "road-access-2026"
    assert repository.calls[-1][0] == "metadata-source"
    paths = client.get("/openapi.json").json()["paths"]
    assert "/projects/{project_id}/resources/imports/metadata/{source_format}" in paths


def test_metadata_import_rejects_bad_checksum_and_credential_bearing_source() -> None:
    repository = FakeResourceRepository()
    client = api_client(repository, FakeMetadataProfileRepository())
    document = stac_metadata_document()
    credentialed = stac_metadata_document()
    credentialed["links"] = [{"href": "https://example.test/private?access_token=not-allowed"}]

    bad_checksum = client.post(
        f"/projects/{PROJECT_ID}/resources/imports/metadata/stac_1_1",
        headers=headers(),
        json={
            "source_namespace": "example.catalog",
            "slug": "road-access-stac",
            "document": document,
            "source_sha256": "0" * 64,
        },
    )
    unsafe = client.post(
        f"/projects/{PROJECT_ID}/resources/imports/metadata/stac_1_1",
        headers=headers(),
        json={
            "source_namespace": "example.catalog",
            "slug": "road-access-stac",
            "document": credentialed,
            "source_sha256": metadata_source_checksum(credentialed),
        },
    )

    assert bad_checksum.status_code == 422
    assert bad_checksum.json()["detail"]["code"] == "metadata_source_invalid"
    assert unsafe.status_code == 422
    assert repository.calls == []


def test_geonode_import_is_pinned_collision_safe_and_exports_preserved_content() -> None:
    repository = FakeResourceRepository()
    client = api_client(repository)
    imported = client.post(
        f"/projects/{PROJECT_ID}/resources/imports/geonode",
        headers=headers(),
        json=geonode_payload(),
    )
    exported = client.get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/export/geonode",
        headers=headers(),
    )

    assert imported.status_code == 201
    assert imported.json()["source_commit"] == "a1db97e81dfc26c16bb4ee1a5d2b408877af66c9"
    assert imported.json()["report"]["summary"]["resources"] == 2
    plan = repository.calls[0][3]
    assert plan.resources[0].draft.visibility == "restricted"
    assert plan.resources[0].draft.metadata.extensions["geonode"]["unmapped"] == {
        "custom_field": {"reviewed": True}
    }
    assert exported.status_code == 200
    assert exported.json()["resource"]["_opengeo"]["content"]["blocks"][0]["type"] == "markdown"


def test_geonode_import_rejects_credentials_wrong_release_and_unresolved_links() -> None:
    repository = FakeResourceRepository()
    credentialed = geonode_payload()
    credentialed["resources"][0]["access_token"] = "private"
    wrong_release = geonode_payload()
    wrong_release["source_version"] = "5.0.0"
    unresolved = geonode_payload()
    unresolved["relationships"][0]["target_uuid"] = "33333333-3333-4333-8333-333333333333"
    client = api_client(repository)

    for payload in (credentialed, wrong_release, unresolved):
        assert (
            client.post(
                f"/projects/{PROJECT_ID}/resources/imports/geonode",
                headers=headers(),
                json=payload,
            ).status_code
            == 422
        )
    assert repository.calls == []


def test_binding_permissions_styles_and_editorial_workflow_are_typed_and_attributed() -> None:
    repository = FakeResourceRepository()
    client = api_client(repository)
    definition = '{"version":8,"sources":{},"layers":[]}'

    bound = client.put(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/binding",
        headers=headers(),
        json={"expected_version": 1, "dataset_id": str(DATASET_ID)},
    )
    transitioned = client.post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/transitions",
        headers=headers(),
        json={
            "expected_version": 1,
            "target_state": "published",
            "visibility": "organization",
            "reason": "Editorial approval",
        },
    )
    capabilities = client.get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/capabilities", headers=headers()
    )
    granted = client.put(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/permissions/{MEMBER_ID}",
        headers=headers(),
        json={"role": "publish"},
    )
    permissions = client.get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/permissions", headers=headers()
    )
    created_style = client.post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/styles",
        headers=headers(),
        json={
            "slug": "roads-default",
            "format": "maplibre",
            "title": "Roads default",
            "definition": definition,
        },
    )
    updated_style = client.put(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/styles/{STYLE_ID}",
        headers=headers(),
        json={
            "expected_version": 1,
            "format": "maplibre",
            "title": "Roads revised",
            "definition": definition,
            "change_message": "Cartographic review",
        },
    )
    styles = client.get(f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/styles", headers=headers())
    workflow = client.get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/workflow", headers=headers()
    )
    revoked = client.delete(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/permissions/{MEMBER_ID}",
        headers=headers(),
    )

    assert bound.status_code == 200
    assert transitioned.status_code == 200
    assert capabilities.json() == {
        "can_read": True,
        "can_update": True,
        "can_publish": False,
        "can_manage_permissions": True,
    }
    assert granted.json()["role"] == "publish"
    assert permissions.json()[0]["email"] == "member@example.test"
    assert created_style.status_code == 201
    assert created_style.json()["checksum_sha256"] == sha256(definition.encode()).hexdigest()
    assert updated_style.json()["version_number"] == 2
    assert styles.json()[0]["format"] == "maplibre"
    assert workflow.json()[0]["target_state"] == "review"
    assert revoked.status_code == 204
    assert repository.calls[0][0] == "bind"
    assert repository.calls[1][0] == "transition"
    assert repository.calls[5][4].checksum_sha256 == sha256(definition.encode()).hexdigest()


def test_governance_contracts_reject_ambiguous_bindings_and_unsafe_styles() -> None:
    repository = FakeResourceRepository()
    client = api_client(repository)
    both_bindings = client.put(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/binding",
        headers=headers(),
        json={
            "expected_version": 1,
            "dataset_id": str(DATASET_ID),
            "map_id": "60000000-0000-4000-8000-000000000091",
        },
    )
    missing_publish_scope = client.post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/transitions",
        headers=headers(),
        json={"expected_version": 1, "target_state": "published"},
    )
    credentialed_json = client.post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/styles",
        headers=headers(),
        json={
            "slug": "unsafe",
            "format": "maplibre",
            "title": "Unsafe",
            "definition": '{"version":8,"access_token":"secret"}',
        },
    )
    data_bearing_mapfile = client.post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/styles",
        headers=headers(),
        json={
            "slug": "unsafe-mapfile",
            "format": "mapserver_mapfile",
            "title": "Unsafe mapfile",
            "definition": (
                'MAP\n  LAYER\n    DATA "/private/roads.shp"\n    CLASS\n'
                "      STYLE\n      END\n    END\n  END\nEND"
            ),
        },
    )
    content_update = create_payload()
    state_bypass = client.put(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}",
        headers=headers(),
        json={
            "expected_version": 1,
            "visibility": "restricted",
            "state": "review",
            "metadata": content_update["metadata"],
            "content": content_update["content"],
            "provenance": content_update["provenance"],
        },
    )

    assert both_bindings.status_code == 422
    assert missing_publish_scope.status_code == 422
    assert credentialed_json.status_code == 422
    assert data_bearing_mapfile.status_code == 422
    assert state_bypass.status_code == 422
    assert repository.calls == []


def test_sld_styles_require_exact_namespace_version_and_bounded_inert_xml() -> None:
    repository = FakeResourceRepository()
    client = api_client(repository)
    valid_1_0 = """<StyledLayerDescriptor xmlns="http://www.opengis.net/sld" version="1.0.0">
      <NamedLayer><Name>roads</Name><UserStyle><Name>line</Name>
      <FeatureTypeStyle><Rule><LineSymbolizer/></Rule></FeatureTypeStyle>
      </UserStyle></NamedLayer></StyledLayerDescriptor>"""
    valid_1_1 = """<StyledLayerDescriptor xmlns="http://www.opengis.net/sld"
      xmlns:se="http://www.opengis.net/se" version="1.1.0">
      <NamedLayer><se:Name>roads</se:Name><UserStyle><se:Name>line</se:Name>
      <se:FeatureTypeStyle><se:Rule><se:LineSymbolizer/></se:Rule></se:FeatureTypeStyle>
      </UserStyle></NamedLayer></StyledLayerDescriptor>"""

    accepted_1_0 = client.post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/styles",
        headers=headers(),
        json={
            "slug": "sld-1-0",
            "format": "sld_1_0",
            "title": "SLD 1.0",
            "definition": valid_1_0,
        },
    )
    accepted_1_1 = client.post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/styles",
        headers=headers(),
        json={
            "slug": "sld-1-1",
            "format": "sld_1_1",
            "title": "SLD 1.1",
            "definition": valid_1_1,
        },
    )
    wrong_namespace = client.post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/styles",
        headers=headers(),
        json={
            "slug": "wrong-namespace",
            "format": "sld_1_0",
            "title": "Wrong namespace",
            "definition": valid_1_0.replace("http://www.opengis.net/sld", "urn:not-sld"),
        },
    )
    wrong_version = client.post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/styles",
        headers=headers(),
        json={
            "slug": "wrong-version",
            "format": "sld_1_1",
            "title": "Wrong version",
            "definition": valid_1_1.replace('version="1.1.0"', 'version="1.0.0"'),
        },
    )
    external_declaration = client.post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/styles",
        headers=headers(),
        json={
            "slug": "external-declaration",
            "format": "sld_1_0",
            "title": "External declaration",
            "definition": '<!DOCTYPE sld SYSTEM "https://example.test/style.dtd">' + valid_1_0,
        },
    )
    too_deep = client.post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/styles",
        headers=headers(),
        json={
            "slug": "too-deep",
            "format": "sld_1_0",
            "title": "Too deep",
            "definition": (
                '<StyledLayerDescriptor xmlns="http://www.opengis.net/sld" version="1.0.0">'
                + "<Layer>" * 33
                + "</Layer>" * 33
                + "</StyledLayerDescriptor>"
            ),
        },
    )

    assert accepted_1_0.status_code == 201
    assert accepted_1_1.status_code == 201
    assert wrong_namespace.status_code == 422
    assert wrong_version.status_code == 422
    assert external_declaration.status_code == 422
    assert too_deep.status_code == 422
    assert [call[0] for call in repository.calls] == ["create-style", "create-style"]


def test_mapserver_configuration_uses_the_governed_style_boundary() -> None:
    repository = FakeResourceRepository()
    imported = api_client(repository).post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/styles/imports/mapserver",
        headers=headers(),
        json={
            "slug": "roads-mapserver",
            "title": "Roads imported from MapServer",
            "mapfile": MAPSERVER_MAPFILE,
            "mapscript": "mapObj.draw()",
        },
    )

    assert imported.status_code == 201
    payload = imported.json()
    assert payload["style"]["format"] == "maplibre"
    assert payload["activation"] == {
        "style_id": str(STYLE_ID),
        "geometry_layer_id": "mapserver-roads",
        "label_layer_id": "mapserver-roads-labels",
        "minimum_scale_denominator": None,
        "maximum_scale_denominator": None,
        "include_legend": True,
    }
    assert payload["report"]["removed_data_bindings"] == [
        "CONNECTION",
        "CONNECTIONTYPE",
        "DATA",
    ]
    assert payload["report"]["mapscript"]["executed"] is False
    assert payload["request_limits"]["requests_per_minute"] == 60
    assert "CONNECTION" not in payload["canonical_mapfile"]
    draft = repository.calls[-1][4]
    assert draft.format == "maplibre"
    assert "mapObj.draw" not in draft.definition
    assert "deterministic-roads.geojson" not in draft.definition

    exported = api_client(MapServerExportResourceRepository()).get(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/styles/{STYLE_ID}/exports/mapserver",
        headers=headers(),
    )
    assert exported.status_code == 200
    assert exported.json()["filename"] == "roads-default.map"
    assert exported.json()["mapfile"] == payload["canonical_mapfile"]
    assert exported.json()["report"]["status"] == "exported_detached_configuration"


def test_mapserver_import_rejects_execution_directives_before_repository_access() -> None:
    repository = FakeResourceRepository()
    response = api_client(repository).post(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/styles/imports/mapserver",
        headers=headers(),
        json={
            "slug": "unsafe",
            "title": "Unsafe",
            "mapfile": (
                'MAP\n  NAME "unsafe"\n  INCLUDE "/private/unreviewed.map"\n'
                '  LAYER\n    NAME "roads"\n    TYPE LINE\n    CLASS\n      STYLE\n'
                "        COLOR 1 2 3\n      END\n    END\n  END\nEND\n"
            ),
        },
    )

    assert response.status_code == 422
    assert response.json() == {
        "detail": {"code": "mapserver_configuration_unsafe", "directive": "INCLUDE"}
    }
    assert repository.calls == []


def test_version_conflict_and_openapi_contract_are_machine_readable() -> None:
    payload = create_payload()
    response = api_client(ConflictingResourceRepository()).put(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}",
        headers=headers(),
        json={
            "expected_version": 1,
            "visibility": "restricted",
            "metadata": payload["metadata"],
            "content": payload["content"],
            "provenance": payload["provenance"],
        },
    )
    assert response.status_code == 409
    assert response.json() == {
        "detail": {"code": "resource_version_conflict", "current_version": 7}
    }

    paths = api_client(FakeResourceRepository()).get("/openapi.json").json()["paths"]
    assert {
        "/projects/{project_id}/resources",
        "/projects/{project_id}/resources/{resource_id}",
        "/projects/{project_id}/resources/{resource_id}/relationships",
        "/projects/{project_id}/resources/imports/geonode",
        "/projects/{project_id}/resources/{resource_id}/export/geonode",
        "/projects/{project_id}/resources/{resource_id}/binding",
        "/projects/{project_id}/resources/{resource_id}/transitions",
        "/projects/{project_id}/resources/{resource_id}/permissions",
        "/projects/{project_id}/resources/{resource_id}/permissions/{user_id}",
        "/projects/{project_id}/resources/{resource_id}/styles",
        "/projects/{project_id}/resources/{resource_id}/styles/{style_id}",
        "/projects/{project_id}/resources/{resource_id}/page-source-uploads",
        "/projects/{project_id}/resources/{resource_id}/page-draft",
        "/projects/{project_id}/resources/{resource_id}/page-versions",
        "/projects/{project_id}/resources/{resource_id}/page-source",
        "/projects/{project_id}/resources/{resource_id}/page-versions/{version_number}/source",
        "/projects/{project_id}/resources/{resource_id}/workflow",
    } <= set(paths)


def test_dataset_metadata_discovery_requires_dataset_access_and_bounds_pages():
    from opengeo_api.ingestion import IngestionAccessDenied

    class DatasetRecords(FakeResourceRepository):
        async def list_dataset_resources(self, context, dataset_id, limit, offset):
            self.calls.append(("dataset_records", context, dataset_id, limit, offset))
            return []

    class DatasetAccess:
        denied = False

        async def get_catalog_dataset(self, context, dataset_id):
            assert context.organization_id == ORG_ID
            assert dataset_id == DATASET_ID
            if self.denied:
                raise IngestionAccessDenied("dataset")
            return object()

    repository = DatasetRecords()
    access = DatasetAccess()
    with api_client(repository) as client:
        client.app.state.ingestion_repository = access
        url = f"/datasets/{DATASET_ID}/resources"
        response = client.get(url + "?limit=2&offset=4", headers=headers())
        assert response.status_code == 200
        assert response.json() == []
        assert response.headers["cache-control"] == "no-store"
        assert repository.calls[-1][2:] == (DATASET_ID, 2, 4)
        count = len(repository.calls)
        assert client.get(url + "?limit=101", headers=headers()).status_code == 422
        access.denied = True
        assert client.get(url, headers=headers()).status_code == 403
        assert len(repository.calls) == count


def test_exact_style_version_route_is_authorized_bounded_and_not_cached() -> None:
    repository = FakeResourceRepository()
    client = api_client(repository)
    path = f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/styles/{STYLE_ID}/versions"
    assert client.get(f"{path}/1").status_code == 401
    assert repository.calls == []
    response = client.get(f"{path}/1", headers=headers())
    assert response.status_code == 200
    assert response.json()["version_number"] == 1
    assert response.headers["cache-control"] == "no-store"
    assert repository.calls[-1][2:] == (PROJECT_ID, RESOURCE_ID, STYLE_ID, 1)
    for value in ("0", "-1", "9007199254740992", "latest"):
        assert client.get(f"{path}/{value}", headers=headers()).status_code == 422
    assert len(repository.calls) == 1


def test_style_archive_and_restore_routes_validate_version_and_retain_definition():
    repository = FakeResourceRepository()
    client = api_client(repository)
    path = f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/styles/{STYLE_ID}"
    for action, archived in [("archive", True), ("restore", False)]:
        assert client.post(f"{path}/{action}", json={"expected_version": 1}).status_code == 401
        assert (
            client.post(
                f"{path}/{action}", headers=headers(), json={"expected_version": 0}
            ).status_code
            == 422
        )
        response = client.post(f"{path}/{action}", headers=headers(), json={"expected_version": 1})
        assert response.status_code == 200
        assert response.json()["archived"] is archived
        assert response.json()["version_number"] == 1
        assert response.json()["definition"] == resource_style().definition
        assert repository.calls[-1][2:7] == (PROJECT_ID, RESOURCE_ID, STYLE_ID, 1, archived)
    assert len(repository.calls) == 2


def test_style_archive_routes_keep_permission_and_conflict_errors_authoritative():
    from opengeo_api.resources import ResourceAccessDenied

    class DeniedStyles(FakeResourceRepository):
        denied = True

        async def set_style_archived(self, *args):
            if self.denied:
                raise ResourceAccessDenied("action forbidden")
            raise ResourceConflict("resource_style_version_conflict", current_version=2)

    repository = DeniedStyles()
    client = api_client(repository)
    path = f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/styles/{STYLE_ID}/archive"
    assert client.post(path, headers=headers(), json={"expected_version": 1}).status_code == 403
    repository.denied = False
    response = client.post(path, headers=headers(), json={"expected_version": 1})
    assert response.status_code == 409
    assert response.json()["detail"]["current_version"] == 2


def test_style_list_passes_explicit_archive_visibility_without_eager_reads():
    class ArchivedStyles(FakeResourceRepository):
        async def list_styles(self, context, project_id, resource_id, *, include_archived=False):
            self.calls.append(("styles", include_archived))
            return [resource_style(archived=True)] if include_archived else []

    repository = ArchivedStyles()
    client = api_client(repository)
    path = f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/styles"
    assert client.get(path, headers=headers()).json() == []
    archived = client.get(path + "?include_archived=true", headers=headers()).json()
    assert archived[0]["archived"] is True
    assert repository.calls == [("styles", False), ("styles", True)]


def test_stac_current_item_routes_require_access_and_known_time():
    from dataclasses import replace

    from opengeo_api.resources import ResourceAccessDenied

    class StacRepository(FakeResourceRepository):
        denied = False
        unknown_time = False

        async def get_resource(self, context, project_id, resource_id):
            if self.denied:
                raise ResourceAccessDenied("denied")
            record = resource(kind="dataset")
            return replace(
                record,
                summary=replace(
                    record.summary,
                    temporal_start=None if self.unknown_time else NOW,
                    temporal_end=NOW,
                ),
            )

    repository = StacRepository()
    client = api_client(repository)
    root = f"/projects/{PROJECT_ID}/stac/collections/{RESOURCE_ID}"
    assert client.get(root).status_code == 401
    response = client.get(root, headers=headers())
    assert response.status_code == 200
    link = next(link for link in response.json()["links"] if link["rel"] == "item")
    item = client.get(link["href"], headers=headers())
    assert item.status_code == 200 and item.json()["stac_version"] == "1.1.0"
    assert item.headers["cache-control"] == "private, no-store"
    assert client.get(f"{root}/items/unknown", headers=headers()).status_code == 404
    repository.unknown_time = True
    assert client.get(link["href"], headers=headers()).status_code == 404
    repository.denied = True
    assert client.get(root, headers=headers()).status_code == 403
    assert client.get(link["href"], headers=headers()).status_code == 403


def test_stac_get_post_search_preserves_filters_in_next_link():
    from dataclasses import replace

    class SearchRepository(FakeResourceRepository):
        async def list_record_resources(self, context, project_id, filters):
            self.filters = filters
            record = resource(kind="dataset")
            summary = replace(record.summary, temporal_start=NOW, temporal_end=NOW)
            return RecordResourcePage(
                resources=(
                    RecordResource(
                        summary=summary,
                        translations={},
                        external_identifiers=(),
                        metadata_extensions=record.metadata_extensions,
                    ),
                ),
                number_matched=2,
            )

    repository = SearchRepository()
    client = api_client(repository)
    root = f"/projects/{PROJECT_ID}/stac/search"
    params = {
        "collections": [str(RESOURCE_ID)],
        "limit": 1,
        "bbox": [-80.0, 20.0, -60.0, 50.0],
        "datetime": NOW.isoformat(),
    }
    response = client.post(root, headers=headers(), json=params)
    assert response.status_code == 200
    assert repository.filters.stac_items is True
    assert repository.filters.ids == (RESOURCE_ID,)
    assert repository.filters.temporal_start == NOW
    next_href = response.json()["links"][0]["href"]
    assert client.get(next_href, headers=headers()).status_code == 200
    assert repository.filters.offset == 1 and repository.filters.limit == 1
    assert repository.filters.bbox == tuple(params["bbox"])
    assert repository.filters.ids == (RESOURCE_ID,)
    for query in ["collections=", "limit=0", "ids=bad", "intersects=x", "limit=1&limit=2"]:
        assert client.get(f"{root}?{query}", headers=headers()).status_code == 400
    assert client.post(root, headers=headers(), json={"unexpected": True}).status_code == 422
    assert client.get(root).status_code == 401


def test_stac_landing_and_collection_discovery_reuse_access_and_paging():
    from dataclasses import replace

    class DiscoveryRepository(FakeResourceRepository):
        async def list_record_resources(self, context, project_id, filters):
            self.filters = filters
            record = resource(kind="dataset")
            return RecordResourcePage(
                resources=(
                    RecordResource(
                        summary=replace(record.summary, temporal_start=None, temporal_end=None),
                        translations={},
                        external_identifiers=(),
                        metadata_extensions=record.metadata_extensions,
                    ),
                ),
                number_matched=2,
            )

    repository = DiscoveryRepository()
    client = api_client(repository)
    root = f"/projects/{PROJECT_ID}/stac"
    assert client.get(root).status_code == 401
    landing = client.get(root, headers=headers()).json()
    assert landing["type"] == "Catalog" and landing["conformsTo"] == []
    assert {link.get("method") for link in landing["links"] if link["rel"] == "search"} == {
        "GET",
        "POST",
    }
    response = client.get(f"{root}/collections?limit=1", headers=headers())
    assert response.status_code == 200 and repository.filters.stac_collections
    assert repository.filters.stac_items is False
    document = response.json()
    assert document["collections"][0]["extent"]["temporal"]["interval"] == [[None, None]]
    assert {link["rel"] for link in document["collections"][0]["links"]} == {
        "self",
        "root",
        "items",
    }
    next_href = next(link["href"] for link in document["links"] if link["rel"] == "next")
    assert client.get(next_href, headers=headers()).status_code == 200
    assert repository.filters.offset == 1


def test_stac_intersects_and_bbox_conflict_and_get_post_paging():
    from dataclasses import replace

    class SpatialRepository(FakeResourceRepository):
        async def list_record_resources(self, context, project_id, filters):
            self.filters = filters
            record = resource(kind="dataset")
            return RecordResourcePage(
                resources=(
                    RecordResource(
                        summary=replace(record.summary, temporal_start=NOW, temporal_end=NOW),
                        translations={},
                        external_identifiers=(),
                    ),
                ),
                number_matched=2,
            )

    repository = SpatialRepository()
    client = api_client(repository)
    root = f"/projects/{PROJECT_ID}/stac/search"
    geometry = {"type": "Point", "coordinates": [-71, 42]}
    response = client.post(root, headers=headers(), json={"intersects": geometry, "limit": 1})
    assert response.status_code == 200 and repository.filters.intersects == geometry
    href = response.json()["links"][0]["href"]
    assert client.get(href, headers=headers()).status_code == 200
    assert repository.filters.intersects == geometry and repository.filters.offset == 1
    assert (
        client.post(
            root, headers=headers(), json={"intersects": geometry, "bbox": [-72, 40, -70, 43]}
        ).status_code
        == 400
    )
    assert client.get(root + "?intersects=invalid", headers=headers()).status_code == 400
