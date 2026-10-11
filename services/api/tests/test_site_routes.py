import base64
from dataclasses import replace
from datetime import UTC, datetime
from hashlib import sha256
from io import BytesIO
from json import dumps, loads
from uuid import UUID
from zipfile import ZipFile

from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.rendering import RenderedMapOutput, SealedRenderOutput
from opengeo_api.s3_downloads import ExactObject, ExactObjectSpec
from opengeo_api.site_publications import (
    ProjectSite,
    PublicSiteDirectoryPage,
    PublicSiteDirectoryRecord,
    PublishedLegendItem,
    PublishedMapLegend,
    PublishedMapSnapshot,
    PublishedResourceReference,
    PublishedSite,
    PublishedSiteAsset,
    SiteAssetCandidate,
    SiteConflict,
    SiteEdition,
    SiteNotFound,
    SitePage,
    SitePublicationDestination,
)
from opengeo_api.tenant_database import TenantContext
from test_site_print import assert_pdf_maps_text, png

USER_ID = UUID("20000000-0000-4000-8000-000000000271")
ORG_ID = UUID("10000000-0000-4000-8000-000000000271")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000271")
SITE_ID = UUID("b0000000-0000-4000-8000-000000000271")
SITE_VERSION_ID = UUID("b1000000-0000-4000-8000-000000000271")
PAGE_ID = UUID("b2000000-0000-4000-8000-000000000271")
RESOURCE_ID = UUID("a0000000-0000-4000-8000-000000000271")
RESOURCE_VERSION_ID = UUID("a1000000-0000-4000-8000-000000000271")
EDITION_ID = UUID("b4000000-0000-4000-8000-000000000271")
NOW = datetime(2026, 8, 20, 21, tzinfo=UTC)
MAP_RESOURCE_ID = UUID("a0000000-0000-4000-8000-000000000272")
MAP_VERSION_ID = UUID("a1000000-0000-4000-8000-000000000272")
RENDER_JOB_ID = UUID("a6000000-0000-4000-8000-000000000272")
OUTPUT_OBJECT_ID = UUID("86000000-0000-4000-8000-000000000272")
ASSET_DATASET_ID = UUID("80000000-0000-4000-8000-000000000273")
ASSET_VERSION_ID = UUID("81000000-0000-4000-8000-000000000273")
ASSET_OBJECT_ID = UUID("82000000-0000-4000-8000-000000000273")
DOCUMENT_OBJECT_ID = UUID("84000000-0000-4000-8000-000000000273")


def visual_jpeg(width: int = 2, height: int = 3) -> bytes:
    frame = b"\x08" + height.to_bytes(2, "big") + width.to_bytes(2, "big") + b"\x01\x01\x11\x00"
    scan = b"\x01\x01\x00\x00\x3f\x00"
    return (
        b"\xff\xd8"
        + b"\xff\xc0"
        + (len(frame) + 2).to_bytes(2, "big")
        + frame
        + b"\xff\xda"
        + (len(scan) + 2).to_bytes(2, "big")
        + scan
        + b"\x00\xff\xd9"
    )


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
            email="publisher@example.test",
            display_name="Publisher",
            memberships=(OrganizationMembership(ORG_ID, "admin"),),
        )


def page() -> SitePage:
    return SitePage(
        page_id=PAGE_ID,
        slug="home",
        navigation_label="Home",
        position=0,
        is_home=True,
        resource_id=RESOURCE_ID,
        resource_version_id=RESOURCE_VERSION_ID,
        resource_version_number=1,
        resource_kind="story",
        resource_title="Field notes",
        resource_abstract="Verified observations.",
        resource_language="en",
        resource_license="CC-BY-4.0",
        resource_attribution="Reporting team",
        resource_content={
            "blocks": [{"id": "intro", "type": "markdown", "markdown": "# Evidence\n\nNotes."}]
        },
        resource_state="published",
        resource_visibility="public",
    )


def edition() -> SiteEdition:
    manifest = {
        "schemaVersion": "opengeo.site-edition.1.0.0",
        "editionId": str(EDITION_ID),
        "references": [],
    }
    return SiteEdition(
        edition_id=EDITION_ID,
        site_id=SITE_ID,
        site_version_id=SITE_VERSION_ID,
        site_version_number=1,
        edition_number=1,
        manifest=manifest,
        manifest_checksum_sha256=sha256(str(manifest).encode()).hexdigest(),
        published_by=USER_ID,
        published_at=NOW,
        revoked_by=None,
        revoked_at=None,
        publication_reach="listed",
        listed_slug="field-report",
        unlisted_token=None,
        is_primary=False,
    )


def site(*, state="draft", active_edition=None) -> ProjectSite:
    return ProjectSite(
        site_id=SITE_ID,
        project_id=PROJECT_ID,
        slug="field-report",
        version_id=SITE_VERSION_ID,
        version_number=1,
        state=state,
        title="Field report",
        description="A mixed-content public report.",
        language="en",
        theme="paper",
        theme_options={},
        change_message=None,
        created_by=USER_ID,
        created_at=NOW,
        updated_by=USER_ID,
        updated_at=NOW,
        pages=(page(),),
        active_edition=active_edition,
        publication_destination=SitePublicationDestination(
            revision=1,
            reach="unpublished",
            listed_slug="field-report",
            is_primary=False,
            configured_by=USER_ID,
            configured_at=NOW,
        ),
    )


class MemorySiteRepository:
    def __init__(self) -> None:
        self.record: ProjectSite | None = None
        self.release: PublishedSite | None = None
        self.calls: list[tuple] = []

    async def list_sites(self, context, project_id):
        self.calls.append(("list_sites", context, project_id))
        return () if self.record is None else (self.record,)

    async def list_asset_candidates(self, context, project_id):
        self.calls.append(("list_asset_candidates", context, project_id))
        return (
            SiteAssetCandidate(
                kind="image",
                dataset_id=ASSET_DATASET_ID,
                dataset_name="Coverage raster",
                dataset_version_id=ASSET_VERSION_ID,
                dataset_version_number=2,
                object_id=ASSET_OBJECT_ID,
                role="thumbnail",
                content_type="image/png",
                size_bytes=1_024,
                checksum_sha256="c" * 64,
                filename="coverage.png",
            ),
        )

    async def get_site(self, context, project_id, site_id):
        self.calls.append(("get_site", context, project_id, site_id))
        if self.record is None or site_id != SITE_ID:
            raise SiteNotFound("site")
        return self.record

    async def create_site(self, context, project_id, slug, draft, request_id):
        self.calls.append(("create_site", context, project_id, slug, draft, request_id))
        if self.record is not None:
            raise SiteConflict("site_conflict")
        assert draft.pages[0].resource_id == RESOURCE_ID
        self.record = site()
        return self.record

    async def update_site(self, *args, **kwargs):
        del args, kwargs
        if self.record is None:
            raise SiteNotFound("site")
        self.record = replace(self.record, state="draft", version_number=2)
        return self.record

    async def configure_site_publication_destination(
        self,
        context,
        project_id,
        site_id,
        expected_revision,
        reach,
        listed_slug,
        is_primary,
        request_id,
    ):
        self.calls.append(
            (
                "configure_destination",
                context,
                project_id,
                site_id,
                expected_revision,
                reach,
                listed_slug,
                is_primary,
                request_id,
            )
        )
        if self.record is None:
            raise SiteNotFound("site")
        destination = self.record.publication_destination
        assert destination is not None
        if expected_revision != destination.revision:
            raise SiteConflict("site_publication_destination_conflict")
        self.record = replace(
            self.record,
            publication_destination=replace(
                destination,
                revision=destination.revision + 1,
                reach=reach,
                listed_slug=listed_slug,
                is_primary=is_primary,
            ),
        )
        return self.record

    async def submit_site_for_review(
        self, context, project_id, site_id, expected_version, reason, request_id
    ):
        self.calls.append(("review", context, expected_version, reason, request_id))
        if self.record is None:
            raise SiteNotFound("site")
        self.record = replace(self.record, state="review")
        return self.record

    async def publish_site(
        self,
        context,
        project_id,
        site_id,
        expected_version,
        reason,
        map_snapshots,
        request_id,
    ):
        self.calls.append(("publish", context, expected_version, reason, map_snapshots, request_id))
        if self.record is None or self.record.state != "review":
            raise SiteConflict("site_not_in_review")
        destination = self.record.publication_destination
        assert destination is not None
        release = replace(
            edition(),
            publication_reach=destination.reach,
            listed_slug=destination.listed_slug if destination.reach == "listed" else None,
            unlisted_token="1" * 32 if destination.reach == "unlisted" else None,
            is_primary=destination.is_primary,
        )
        self.record = replace(self.record, state="published", active_edition=release)
        self.release = PublishedSite(site=self.record, edition=release, references=())
        return self.record

    async def list_editions(self, context, project_id, site_id):
        self.calls.append(("list_editions", context, project_id, site_id))
        return () if self.release is None else (self.release.edition,)

    async def revoke_edition(self, context, project_id, site_id, edition_id, request_id):
        self.calls.append(("revoke", context, edition_id, request_id))
        if self.release is None:
            raise SiteNotFound("site_edition")
        revoked = replace(self.release.edition, revoked_by=USER_ID, revoked_at=NOW)
        self.release = None
        assert self.record is not None
        self.record = replace(self.record, active_edition=None)
        return revoked

    async def get_public_site(
        self, context, project_id, *, site_slug=None, edition_id=None, unlisted_token=None
    ):
        self.calls.append(("public", context, project_id, site_slug, edition_id, unlisted_token))
        if self.release is None:
            raise SiteNotFound("site_edition")
        if site_slug not in {None, "field-report"} or edition_id not in {None, EDITION_ID}:
            raise SiteNotFound("site_edition")
        if site_slug is not None and self.release.edition.publication_reach != "listed":
            raise SiteNotFound("site_edition")
        if unlisted_token is not None and (
            self.release.edition.publication_reach != "unlisted"
            or unlisted_token != self.release.edition.unlisted_token
        ):
            raise SiteNotFound("site_edition")
        return self.release

    async def list_public_sites(self, context, *, limit=24, offset=0):
        self.calls.append(("public_directory", context, limit, offset))
        records = ()
        if self.release is not None and self.release.edition.publication_reach == "listed":
            records = (
                PublicSiteDirectoryRecord(
                    project_id=PROJECT_ID,
                    project_name="Field research",
                    site_id=SITE_ID,
                    edition_id=EDITION_ID,
                    listed_slug="field-report",
                    title="Field report",
                    description="A mixed-content public report.",
                    language="en",
                    theme="paper",
                    page_count=1,
                    published_at=NOW,
                    is_primary=self.release.edition.is_primary,
                ),
            )
        return PublicSiteDirectoryPage(
            records=records[offset : offset + limit],
            number_matched=len(records),
        )

    async def get_public_site_by_destination(self, context, *, listed_slug=None, primary=False):
        self.calls.append(("public_destination", context, listed_slug, primary))
        if self.release is None or self.release.edition.publication_reach != "listed":
            raise SiteNotFound("site_edition")
        if listed_slug is not None and listed_slug != self.release.edition.listed_slug:
            raise SiteNotFound("site_edition")
        if primary and not self.release.edition.is_primary:
            raise SiteNotFound("site_edition")
        return self.release


class MemoryRenderRepository:
    def __init__(self, body: bytes) -> None:
        self.body = body
        self.calls: list[tuple] = []

    async def read_sealed_map_output(
        self, context, project_id, resource_id, job_id, seal, maximum_bytes
    ):
        self.calls.append((context, project_id, resource_id, job_id, seal, maximum_bytes))
        assert isinstance(seal, SealedRenderOutput)
        assert seal.output_object_id == OUTPUT_OBJECT_ID
        assert sha256(self.body).hexdigest() == seal.checksum_sha256
        return RenderedMapOutput(
            body=self.body,
            filename="field-map.png",
            content_type="image/png",
            size_bytes=len(self.body),
            checksum_sha256=sha256(self.body).hexdigest(),
            version_id="s3-version-2",
        )


class RevokingRenderRepository(MemoryRenderRepository):
    def __init__(self, body: bytes, repository: MemorySiteRepository) -> None:
        super().__init__(body)
        self.repository = repository

    async def read_sealed_map_output(self, *args, **kwargs):
        output = await super().read_sealed_map_output(*args, **kwargs)
        self.repository.release = None
        return output


class MemoryDownloadStorage:
    def __init__(self, body: bytes, version_id: str = "asset-version-1") -> None:
        self.body = body
        self.version_id = version_id
        self.calls: list[ExactObjectSpec] = []

    async def read_exact_object(self, spec: ExactObjectSpec) -> ExactObject:
        self.calls.append(spec)
        assert spec.version_id == self.version_id
        assert spec.checksum_sha256 == sha256(self.body).hexdigest()
        return ExactObject(
            body=self.body,
            content_type=spec.content_type,
            size_bytes=len(self.body),
            checksum_sha256=spec.checksum_sha256,
            version_id=spec.version_id,
        )

    async def create_download_url(self, spec):
        raise AssertionError(f"unexpected signed download {spec}")


def api_client(
    repository: MemorySiteRepository,
    render_repository: MemoryRenderRepository | None = None,
    download_storage: MemoryDownloadStorage | None = None,
) -> TestClient:
    return TestClient(
        create_app(
            settings=Settings(env="test", expose_docs=True),
            readiness_probe=PassingProbe(),
            token_verifier=FakeVerifier(),
            principal_repository=FakePrincipalRepository(),
            site_publication_repository=repository,
            render_repository=render_repository,
            download_storage=download_storage,
        )
    )


def headers() -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(ORG_ID),
        "X-Request-ID": "site-request-123",
    }


def create_payload() -> dict:
    return {
        "slug": "field-report",
        "title": "Field report",
        "description": "A mixed-content public report.",
        "language": "en",
        "theme": "paper",
        "theme_options": {"accentColor": "#176b87"},
        "pages": [
            {
                "slug": "home",
                "navigation_label": "Home",
                "resource_id": str(RESOURCE_ID),
                "resource_version": 1,
                "is_home": True,
            }
        ],
    }


def test_shared_auth_lists_publishable_asset_candidates_without_storage_location() -> None:
    repository = MemorySiteRepository()
    client = api_client(repository)

    assert client.get(f"/projects/{PROJECT_ID}/site-assets").status_code == 401
    response = client.get(f"/projects/{PROJECT_ID}/site-assets", headers=headers())

    assert response.status_code == 200
    assert response.json() == [
        {
            "kind": "image",
            "dataset_id": str(ASSET_DATASET_ID),
            "dataset_name": "Coverage raster",
            "dataset_version_id": str(ASSET_VERSION_ID),
            "dataset_version_number": 2,
            "object_id": str(ASSET_OBJECT_ID),
            "role": "thumbnail",
            "content_type": "image/png",
            "size_bytes": 1_024,
            "checksum_sha256": "c" * 64,
            "filename": "coverage.png",
        }
    ]
    assert "bucket" not in response.text
    assert "object_key" not in response.text
    assert repository.calls[-1][1].organization_id == ORG_ID


def test_shared_auth_editorial_publication_and_revocation_flow() -> None:
    repository = MemorySiteRepository()
    client = api_client(repository)

    assert client.post(f"/projects/{PROJECT_ID}/sites", json=create_payload()).status_code == 401
    created = client.post(f"/projects/{PROJECT_ID}/sites", headers=headers(), json=create_payload())
    assert created.status_code == 201
    assert created.json()["state"] == "draft"
    assert repository.calls[0][1].organization_id == ORG_ID
    assert repository.calls[0][1].user_id == USER_ID

    configured = client.put(
        f"/projects/{PROJECT_ID}/sites/{SITE_ID}/publication-destination",
        headers=headers(),
        json={
            "expected_revision": 1,
            "reach": "listed",
            "listed_slug": "field-report",
            "is_primary": True,
        },
    )
    assert configured.status_code == 200
    assert configured.json()["publication_destination"] == {
        "revision": 2,
        "reach": "listed",
        "listed_slug": "field-report",
        "is_primary": True,
        "configured_by": str(USER_ID),
        "configured_at": NOW.isoformat(),
    }

    reviewed = client.post(
        f"/projects/{PROJECT_ID}/sites/{SITE_ID}/review",
        headers=headers(),
        json={"expected_version": 1, "reason": "Editorial review complete"},
    )
    assert reviewed.status_code == 200
    assert reviewed.json()["state"] == "review"
    published = client.post(
        f"/projects/{PROJECT_ID}/sites/{SITE_ID}/publish",
        headers=headers(),
        json={"expected_version": 1, "reason": "Release approved"},
    )
    assert published.status_code == 200
    assert published.json()["active_edition"]["id"] == str(EDITION_ID)
    assert published.json()["active_edition"]["is_primary"] is True

    public = client.get(f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/sites/field-report")
    assert public.status_code == 200
    assert "Field notes" in public.text
    assert "Evidence" in public.text
    assert "Cache-Control" in public.headers
    assert "frame-ancestors 'none'" in public.headers["Content-Security-Policy"]
    assert repository.calls[-1][1].user_id == UUID(int=0)

    directory = client.get(f"/public/organizations/{ORG_ID}/publications")
    assert directory.status_code == 200
    assert directory.json() == {
        "schema_version": "opengeo.public-site-directory.1.0.0",
        "number_returned": 1,
        "number_matched": 1,
        "limit": 24,
        "offset": 0,
        "next_offset": None,
        "records": [
            {
                "project_id": str(PROJECT_ID),
                "project_name": "Field research",
                "site_id": str(SITE_ID),
                "edition_id": str(EDITION_ID),
                "listed_slug": "field-report",
                "title": "Field report",
                "description": "A mixed-content public report.",
                "language": "en",
                "theme": "paper",
                "page_count": 1,
                "published_at": NOW.isoformat(),
                "is_primary": True,
                "href": f"/public/organizations/{ORG_ID}/publications/field-report",
                "primary_href": f"/public/organizations/{ORG_ID}/publication",
            }
        ],
    }
    listed = client.get(f"/public/organizations/{ORG_ID}/publications/field-report")
    primary = client.get(f"/public/organizations/{ORG_ID}/publication")
    assert listed.status_code == 200
    assert primary.status_code == 200
    assert "Field notes" in listed.text
    assert "Field notes" in primary.text
    assert f"/public/organizations/{ORG_ID}/publications/field-report" in listed.text
    assert f"/public/organizations/{ORG_ID}/publication" in primary.text

    package = client.get(
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/sites/field-report/export.zip"
    )
    assert package.status_code == 200
    assert package.headers["Digest"].startswith("sha-256=")
    assert package.headers["X-OpenGeo-Checksum-SHA256"] == sha256(package.content).hexdigest()
    with ZipFile(BytesIO(package.content)) as archive:
        assert "index.html" in archive.namelist()
        assert "checksums.sha256" in archive.namelist()

    exact = client.get(
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/site-editions/{EDITION_ID}/export.zip"
    )
    assert exact.status_code == 200
    revoked = client.post(
        f"/projects/{PROJECT_ID}/sites/{SITE_ID}/editions/{EDITION_ID}/revoke",
        headers=headers(),
    )
    assert revoked.status_code == 200
    assert revoked.json()["revoked_by"] == str(USER_ID)
    assert (
        client.get(
            f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/sites/field-report"
        ).status_code
        == 404
    )
    assert (
        client.get(f"/public/organizations/{ORG_ID}/publications/field-report").status_code == 404
    )
    assert client.get(f"/public/organizations/{ORG_ID}/publication").status_code == 404


def test_site_request_rejects_ambiguous_home_and_unknown_theme_options() -> None:
    client = api_client(MemorySiteRepository())
    payload = create_payload()
    payload["pages"][0]["is_home"] = False
    assert (
        client.post(f"/projects/{PROJECT_ID}/sites", headers=headers(), json=payload).status_code
        == 422
    )
    payload = create_payload()
    payload["theme_options"] = {"remoteScript": "https://bad.example/script.js"}
    response = client.post(f"/projects/{PROJECT_ID}/sites", headers=headers(), json=payload)
    assert response.status_code == 422
    assert "unknown theme option" in response.text
    payload = create_payload()
    payload["theme_options"] = {
        "accentColor": "#176b87",
        "footerText": "Research desk",
        "printPageSize": "a3",
        "printOrientation": "portrait",
        "printLayout": "map-sheet",
        "printLegend": "true",
        "printNorthArrow": "false",
        "printScaleBar": "true",
    }
    assert (
        client.post(f"/projects/{PROJECT_ID}/sites", headers=headers(), json=payload).status_code
        == 201
    )
    payload = create_payload()
    payload["theme_options"] = {"printOrientation": "diagonal"}
    assert (
        client.post(f"/projects/{PROJECT_ID}/sites", headers=headers(), json=payload).status_code
        == 422
    )
    payload = create_payload()
    payload["print_layout"] = {
        "schemaVersion": "opengeo.print-layout.1.0.0",
        "pages": [
            {
                "sitePageSlug": "home",
                "elements": [
                    {
                        "id": "map_1",
                        "type": "map_frame",
                        "x": 20,
                        "y": 20,
                        "width": 700,
                        "height": 800,
                        "resourceId": str(RESOURCE_ID),
                    }
                ],
            }
        ],
    }
    payload["slug"] = "field-report-positioned"
    layout_client = api_client(MemorySiteRepository())
    assert (
        layout_client.post(
            f"/projects/{PROJECT_ID}/sites", headers=headers(), json=payload
        ).status_code
        == 201
    )
    payload["print_layout"]["pages"][0]["sitePageSlug"] = "missing"
    response = layout_client.post(f"/projects/{PROJECT_ID}/sites", headers=headers(), json=payload)
    assert response.status_code == 422
    assert "site_print_layout_page_not_found" in response.text


def test_unlisted_site_uses_only_the_server_generated_opaque_route() -> None:
    repository = MemorySiteRepository()
    client = api_client(repository)
    assert (
        client.post(
            f"/projects/{PROJECT_ID}/sites", headers=headers(), json=create_payload()
        ).status_code
        == 201
    )
    configured = client.put(
        f"/projects/{PROJECT_ID}/sites/{SITE_ID}/publication-destination",
        headers=headers(),
        json={
            "expected_revision": 1,
            "reach": "unlisted",
            "listed_slug": "field-report",
            "is_primary": False,
        },
    )
    assert configured.status_code == 200
    assert (
        client.post(
            f"/projects/{PROJECT_ID}/sites/{SITE_ID}/review",
            headers=headers(),
            json={"expected_version": 1},
        ).status_code
        == 200
    )
    published = client.post(
        f"/projects/{PROJECT_ID}/sites/{SITE_ID}/publish",
        headers=headers(),
        json={"expected_version": 1},
    )
    assert published.status_code == 200
    assert published.json()["active_edition"]["publication_reach"] == "unlisted"
    assert published.json()["active_edition"]["unlisted_token"] == "1" * 32
    assert (
        client.get(
            f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/sites/field-report"
        ).status_code
        == 404
    )
    unlisted = client.get(
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/unlisted/{'1' * 32}"
    )
    assert unlisted.status_code == 200
    assert "Field notes" in unlisted.text
    assert unlisted.headers["x-robots-tag"] == "noindex, nofollow, noarchive"
    assert unlisted.headers["referrer-policy"] == "no-referrer"


def test_openapi_advertises_admin_and_anonymous_site_boundaries() -> None:
    document = api_client(MemorySiteRepository()).get("/openapi.json").json()
    assert "/projects/{project_id}/sites" in document["paths"]
    assert "/projects/{project_id}/site-assets" in document["paths"]
    assert "/projects/{project_id}/sites/{site_id}/publish" in document["paths"]
    assert "/projects/{project_id}/sites/{site_id}/publication-destination" in document["paths"]
    assert "/public/organizations/{organization_id}/publications" in document["paths"]
    assert "/public/organizations/{organization_id}/publication" in document["paths"]
    assert "/public/organizations/{organization_id}/publications/{site_slug}" in document["paths"]
    assert (
        "/public/organizations/{organization_id}/projects/{project_id}/sites/{site_slug}"
        in document["paths"]
    )
    assert (
        "/public/organizations/{organization_id}/projects/{project_id}/unlisted/"
        "{unlisted_token}" in document["paths"]
    )
    assert (
        "/public/organizations/{organization_id}/projects/{project_id}/site-editions/"
        "{edition_id}/export.zip" in document["paths"]
    )
    assert (
        "/public/organizations/{organization_id}/projects/{project_id}/site-editions/"
        "{edition_id}/maps/{resource_id}.png" in document["paths"]
    )
    assert (
        "/public/organizations/{organization_id}/projects/{project_id}/site-editions/"
        "{edition_id}/assets/{object_id}" in document["paths"]
    )
    assert (
        "/public/organizations/{organization_id}/projects/{project_id}/site-editions/"
        "{edition_id}/assets/{object_id}/pages/{page_number}.jpg" in document["paths"]
    )
    assert (
        "/public/organizations/{organization_id}/projects/{project_id}/sites/"
        "{site_slug}/print.pdf" in document["paths"]
    )
    assert (
        "/public/organizations/{organization_id}/projects/{project_id}/sites/"
        "{site_slug}/print/pages/{page_slug}.png" in document["paths"]
    )
    assert (
        "/public/organizations/{organization_id}/projects/{project_id}/site-editions/"
        "{edition_id}/print/pages/{page_slug}.png" in document["paths"]
    )
    assert (
        "/public/organizations/{organization_id}/projects/{project_id}/sites/"
        "{site_slug}/print/{resource_id}.svg" in document["paths"]
    )
    assert (
        "/public/organizations/{organization_id}/projects/{project_id}/site-editions/"
        "{edition_id}/print/{resource_id}.svg" in document["paths"]
    )


def test_public_site_serves_sealed_png_pdf_and_portable_zip_on_demand() -> None:
    body = png()
    asset_body = png(20, 32)
    snapshot = PublishedMapSnapshot(
        render_job_id=RENDER_JOB_ID,
        output_object_id=OUTPUT_OBJECT_ID,
        storage_version_id="s3-version-2",
        content_type="image/png",
        size_bytes=len(body),
        checksum_sha256=sha256(body).hexdigest(),
        width=32,
        height=20,
        bbox=(-71.2, 42.2, -71.0, 42.4),
        crs="EPSG:3857",
        legend=PublishedMapLegend(
            title="Survey status",
            profile_checksum_sha256="c" * 64,
            items=(PublishedLegendItem("Verified", "fill", "#176b87", 0.8),),
        ),
    )
    reference = PublishedResourceReference(
        resource_id=MAP_RESOURCE_ID,
        version_id=MAP_VERSION_ID,
        version_number=2,
        kind="map",
        title="Field map",
        abstract="Verified survey extent.",
        attribution="Reporting team",
        license="CC-BY-4.0",
        wms_service_id=None,
        wms_layer_name=None,
        snapshot=snapshot,
    )
    release = edition()
    published_page = replace(
        page(),
        resource_content={
            "blocks": [
                {"id": "map", "type": "map", "resource_id": str(MAP_RESOURCE_ID)},
                {
                    "id": "field-photo",
                    "type": "image",
                    "object_id": str(ASSET_OBJECT_ID),
                    "alt_text": "Field team recording a verified location.",
                },
                {
                    "id": "survey-table",
                    "type": "table",
                    "caption": "Survey results",
                    "columns": ["District", "Coverage"],
                    "rows": [["East", 0.75], ["West", 0.5]],
                },
                {
                    "id": "coverage-chart",
                    "type": "chart",
                    "chart_type": "bar",
                    "title": "Coverage by district",
                    "alt_text": "East coverage exceeds West coverage.",
                    "table_block_id": "survey-table",
                    "x_column": "District",
                    "y_columns": ["Coverage"],
                },
            ]
        },
    )
    asset = PublishedSiteAsset(
        kind="image",
        dataset_id=ASSET_DATASET_ID,
        dataset_version_id=ASSET_VERSION_ID,
        object_id=ASSET_OBJECT_ID,
        bucket="opengeo-test-geodata",
        object_key="organizations/o/site-assets/coverage.png",
        storage_version_id="asset-version-1",
        content_type="image/png",
        size_bytes=len(asset_body),
        checksum_sha256=sha256(asset_body).hexdigest(),
        filename="coverage.png",
    )
    published_site = replace(
        site(state="published", active_edition=release),
        pages=(published_page,),
        theme_options={
            "printPageSize": "a3",
            "printOrientation": "portrait",
            "printLayout": "map-sheet",
            "printLegend": "true",
            "printNorthArrow": "true",
            "printScaleBar": "true",
        },
        print_layout={
            "schemaVersion": "opengeo.print-layout.1.1.0",
            "pages": [
                {
                    "sitePageSlug": "home",
                    "elements": [
                        {
                            "id": "title",
                            "type": "text",
                            "x": 40,
                            "y": 30,
                            "width": 920,
                            "height": 80,
                            "rotation": 0,
                            "clip": True,
                            "text": "Field evidence",
                            "style": "title",
                        },
                        {
                            "id": "map_1",
                            "type": "map_frame",
                            "x": 40,
                            "y": 140,
                            "width": 600,
                            "height": 430,
                            "rotation": -8,
                            "clip": True,
                            "resourceId": str(MAP_RESOURCE_ID),
                            "fit": "cover",
                        },
                        {
                            "id": "legend",
                            "type": "legend_frame",
                            "x": 680,
                            "y": 140,
                            "width": 280,
                            "height": 190,
                            "rotation": 0,
                            "clip": True,
                            "mapFrameId": "map_1",
                        },
                        {
                            "id": "sources",
                            "type": "source_panel",
                            "x": 680,
                            "y": 350,
                            "width": 280,
                            "height": 220,
                            "rotation": 0,
                            "clip": True,
                            "mapFrameId": "map_1",
                        },
                        {
                            "id": "photo",
                            "type": "image_frame",
                            "x": 40,
                            "y": 610,
                            "width": 280,
                            "height": 320,
                            "rotation": 9,
                            "clip": False,
                            "blockId": "field-photo",
                            "fit": "contain",
                        },
                        {
                            "id": "results",
                            "type": "table_frame",
                            "x": 350,
                            "y": 610,
                            "width": 290,
                            "height": 320,
                            "rotation": 0,
                            "clip": True,
                            "blockId": "survey-table",
                        },
                        {
                            "id": "coverage",
                            "type": "chart_frame",
                            "x": 670,
                            "y": 610,
                            "width": 290,
                            "height": 320,
                            "rotation": 0,
                            "clip": True,
                            "blockId": "coverage-chart",
                        },
                    ],
                }
            ],
        },
    )
    repository = MemorySiteRepository()
    repository.record = published_site
    repository.release = PublishedSite(published_site, release, (reference,), (asset,))
    renders = MemoryRenderRepository(body)
    storage = MemoryDownloadStorage(asset_body)
    client = api_client(repository, renders, storage)

    page_response = client.get(
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/sites/field-report"
    )
    assert page_response.status_code == 200
    assert f"/site-editions/{EDITION_ID}/maps/{MAP_RESOURCE_ID}.png" in page_response.text

    image_response = client.get(
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/site-editions/"
        f"{EDITION_ID}/maps/{MAP_RESOURCE_ID}.png"
    )
    assert image_response.status_code == 200
    assert image_response.content == body
    assert image_response.headers["X-OpenGeo-Checksum-SHA256"] == sha256(body).hexdigest()

    first_pdf = client.get(
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/sites/field-report/print.pdf"
    )
    second_pdf = client.get(
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/sites/field-report/print.pdf"
    )
    assert first_pdf.status_code == 200
    assert first_pdf.content == second_pdf.content
    assert first_pdf.content.startswith(b"%PDF-1.4")
    assert b"/MediaBox [0 0 842 1191]" in first_pdf.content
    assert_pdf_maps_text(first_pdf.content, "Sources Survey status")
    assert b"/Asset1" in first_pdf.content
    assert_pdf_maps_text(first_pdf.content, "Survey results Coverage by district")
    assert first_pdf.headers["X-OpenGeo-Output-Mode"] == "request-driven"

    current_page_png = client.get(
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/sites/field-report/"
        "print/pages/home.png"
    )
    exact_page_png = client.get(
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/site-editions/"
        f"{EDITION_ID}/print/pages/home.png"
    )
    assert current_page_png.status_code == 200
    assert current_page_png.content == exact_page_png.content
    assert current_page_png.content.startswith(b"\x89PNG\r\n\x1a\n")
    assert current_page_png.headers["X-OpenGeo-Print-DPI"] == "96"
    assert current_page_png.headers["X-OpenGeo-Output-Mode"] == "request-driven"
    assert sha256(body).hexdigest() in current_page_png.headers["X-OpenGeo-Source-Checksums-SHA256"]
    assert (
        sha256(asset_body).hexdigest()
        in current_page_png.headers["X-OpenGeo-Source-Checksums-SHA256"]
    )

    current_sheet = client.get(
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/sites/field-report/print/"
        f"{MAP_RESOURCE_ID}.svg"
    )
    exact_sheet = client.get(
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/site-editions/"
        f"{EDITION_ID}/print/{MAP_RESOURCE_ID}.svg"
    )
    assert current_sheet.status_code == 200
    assert current_sheet.content == exact_sheet.content
    assert current_sheet.headers["X-OpenGeo-Output-Mode"] == "request-driven"
    assert current_sheet.headers["X-OpenGeo-Source-Checksum-SHA256"] == sha256(body).hexdigest()
    assert "sandbox" in current_sheet.headers["Content-Security-Policy"]
    assert b'href="data:image/png;base64,' in current_sheet.content
    assert b">Survey status</text>" in current_sheet.content
    assert b">Verified</text>" in current_sheet.content

    package = client.get(
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/sites/field-report/export.zip"
    )
    assert package.status_code == 200
    with ZipFile(BytesIO(package.content)) as archive:
        assert archive.read(f"assets/maps/{MAP_RESOURCE_ID}.png") == body
        assert archive.read(f"print/maps/{MAP_RESOURCE_ID}.svg") == current_sheet.content
        assert loads(archive.read("print/layout.json")) == published_site.print_layout
    assert len(renders.calls) == 8
    assert len(storage.calls) == 5


def test_public_map_output_fails_if_the_edition_is_revoked_during_storage_read() -> None:
    body = png()
    snapshot = PublishedMapSnapshot(
        render_job_id=RENDER_JOB_ID,
        output_object_id=OUTPUT_OBJECT_ID,
        storage_version_id="s3-version-2",
        content_type="image/png",
        size_bytes=len(body),
        checksum_sha256=sha256(body).hexdigest(),
        width=32,
        height=20,
        bbox=(-71.2, 42.2, -71.0, 42.4),
        crs="EPSG:3857",
    )
    reference = PublishedResourceReference(
        resource_id=MAP_RESOURCE_ID,
        version_id=MAP_VERSION_ID,
        version_number=2,
        kind="map",
        title="Field map",
        abstract=None,
        attribution="Reporting team",
        license="CC-BY-4.0",
        wms_service_id=None,
        wms_layer_name=None,
        snapshot=snapshot,
    )
    release = edition()
    published_site = site(state="published", active_edition=release)
    repository = MemorySiteRepository()
    repository.record = published_site
    repository.release = PublishedSite(published_site, release, (reference,))
    client = api_client(repository, RevokingRenderRepository(body, repository))

    response = client.get(
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/site-editions/"
        f"{EDITION_ID}/maps/{MAP_RESOURCE_ID}.png"
    )

    assert response.status_code == 404
    assert response.json() == {"detail": "site_edition_not_found"}


def test_public_site_serves_and_packages_one_exact_governed_asset() -> None:
    body = b"\x89PNG\r\n\x1a\nsite-asset"
    asset = PublishedSiteAsset(
        kind="image",
        dataset_id=ASSET_DATASET_ID,
        dataset_version_id=ASSET_VERSION_ID,
        object_id=ASSET_OBJECT_ID,
        bucket="opengeo-test-geodata",
        object_key=f"organizations/{ORG_ID}/datasets/{ASSET_DATASET_ID}/coverage.png",
        storage_version_id="asset-version-1",
        content_type="image/png",
        size_bytes=len(body),
        checksum_sha256=sha256(body).hexdigest(),
        filename="coverage.png",
    )
    release = edition()
    published_page = replace(
        page(),
        resource_content={
            "blocks": [
                {
                    "id": "coverage-image",
                    "type": "image",
                    "dataset_id": str(ASSET_DATASET_ID),
                    "dataset_version_id": str(ASSET_VERSION_ID),
                    "object_id": str(ASSET_OBJECT_ID),
                    "alt_text": "Survey coverage raster.",
                }
            ]
        },
    )
    published_site = replace(
        site(state="published", active_edition=release), pages=(published_page,)
    )
    repository = MemorySiteRepository()
    repository.record = published_site
    repository.release = PublishedSite(published_site, release, (), (asset,))
    storage = MemoryDownloadStorage(body)
    client = api_client(repository, download_storage=storage)

    page_response = client.get(
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/sites/field-report"
    )
    assert page_response.status_code == 200
    assert f"/site-editions/{EDITION_ID}/assets/{ASSET_OBJECT_ID}" in page_response.text
    asset_response = client.get(
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/site-editions/"
        f"{EDITION_ID}/assets/{ASSET_OBJECT_ID}"
    )
    assert asset_response.status_code == 200
    assert asset_response.content == body
    assert asset_response.headers["Content-Disposition"] == 'inline; filename="coverage.png"'

    package = client.get(
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/sites/field-report/export.zip"
    )
    assert package.status_code == 200
    with ZipFile(BytesIO(package.content)) as archive:
        assert archive.read(f"assets/content/{ASSET_OBJECT_ID}/coverage.png") == body
        assert "lineage/assets.json" in archive.namelist()
    assert len(storage.calls) == 2

    repository.release = None
    assert (
        client.get(
            f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/site-editions/"
            f"{EDITION_ID}/assets/{ASSET_OBJECT_ID}"
        ).status_code
        == 404
    )


def test_public_site_reads_and_packages_one_exact_odt_semantic_document() -> None:
    body = (
        b'{"schemaVersion":"opengeo.document-preview.1.0.0",'
        b'"sourceFormat":"odt","odfVersion":"1.4","title":"Field report",'
        b'"language":"en","pages":[{"number":1,"blocks":['
        b'{"type":"heading","level":1,"text":"Verified finding"},'
        b'{"type":"paragraph","text":"Semantic document content."}]}]}'
    )
    asset = PublishedSiteAsset(
        kind="document",
        dataset_id=ASSET_DATASET_ID,
        dataset_version_id=ASSET_VERSION_ID,
        object_id=DOCUMENT_OBJECT_ID,
        bucket="opengeo-test-geodata",
        object_key=(
            f"organizations/{ORG_ID}/datasets/{ASSET_DATASET_ID}/document/accessible-preview.json"
        ),
        storage_version_id="asset-version-1",
        content_type="application/json",
        size_bytes=len(body),
        checksum_sha256=sha256(body).hexdigest(),
        filename="accessible-preview.json",
    )
    release = edition()
    published_page = replace(
        page(),
        resource_content={
            "blocks": [
                {
                    "id": "field-report-document",
                    "type": "document",
                    "dataset_id": str(ASSET_DATASET_ID),
                    "dataset_version_id": str(ASSET_VERSION_ID),
                    "object_id": str(DOCUMENT_OBJECT_ID),
                    "label": "Read the field report",
                }
            ]
        },
    )
    published_site = replace(
        site(state="published", active_edition=release), pages=(published_page,)
    )
    repository = MemorySiteRepository()
    repository.record = published_site
    repository.release = PublishedSite(published_site, release, (), (asset,))
    storage = MemoryDownloadStorage(body)
    client = api_client(repository, download_storage=storage)

    page_response = client.get(
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/sites/field-report"
    )
    assert page_response.status_code == 200
    assert '<section class="document-preview"' in page_response.text
    assert '<h3 data-source-heading-level="1">Verified finding</h3>' in page_response.text
    assert "Semantic document content." in page_response.text

    package = client.get(
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/sites/field-report/export.zip"
    )
    assert package.status_code == 200
    with ZipFile(BytesIO(package.content)) as archive:
        assert archive.read(f"assets/content/{DOCUMENT_OBJECT_ID}/accessible-preview.json") == body
        assert b"Read the field report" in archive.read("index.html")
    assert len(storage.calls) == 2


def test_public_site_serves_revocable_pdf_visual_pages_and_packages_exact_images() -> None:
    image = visual_jpeg()
    presentation = {
        "schemaVersion": "opengeo.pdf-visual-presentation.1.0.0",
        "sourceFormat": "pdf",
        "pdfVersion": "1.7",
        "title": "Visual report",
        "language": "en",
        "extraction": {
            "engine": "poppler-pdftotext",
            "mode": "layout",
            "ocrPerformed": False,
            "readingOrder": "heuristic",
            "tagged": False,
            "textAvailable": True,
        },
        "rendering": {
            "engine": "poppler-pdftoppm",
            "mediaType": "image/jpeg",
            "annotationsHidden": True,
            "colorSpace": "rgb",
            "pageCount": 1,
            "targetMaximumDimension": 1000,
            "totalPixels": 6,
            "totalImageBytes": len(image),
        },
        "pages": [
            {
                "number": 1,
                "width": 2,
                "height": 3,
                "imageBase64": base64.b64encode(image).decode(),
                "imageSha256": sha256(image).hexdigest(),
                "blocks": [{"type": "paragraph", "text": "Exact semantic fallback."}],
            }
        ],
    }
    body = (dumps(presentation, sort_keys=True, separators=(",", ":")) + "\n").encode()
    asset = PublishedSiteAsset(
        kind="document",
        dataset_id=ASSET_DATASET_ID,
        dataset_version_id=ASSET_VERSION_ID,
        object_id=DOCUMENT_OBJECT_ID,
        bucket="opengeo-test-geodata",
        object_key=(
            f"organizations/{ORG_ID}/datasets/{ASSET_DATASET_ID}/document/visual-presentation.json"
        ),
        storage_version_id="visual-presentation-version-1",
        content_type="application/json",
        size_bytes=len(body),
        checksum_sha256=sha256(body).hexdigest(),
        filename="visual-presentation.json",
    )
    release = edition()
    published_page = replace(
        page(),
        resource_content={
            "blocks": [
                {
                    "id": "visual-document",
                    "type": "document",
                    "dataset_id": str(ASSET_DATASET_ID),
                    "dataset_version_id": str(ASSET_VERSION_ID),
                    "object_id": str(DOCUMENT_OBJECT_ID),
                    "label": "View the visual report",
                }
            ]
        },
    )
    published_site = replace(
        site(state="published", active_edition=release), pages=(published_page,)
    )
    repository = MemorySiteRepository()
    repository.record = published_site
    repository.release = PublishedSite(published_site, release, (), (asset,))
    storage = MemoryDownloadStorage(body, "visual-presentation-version-1")
    client = api_client(repository, download_storage=storage)

    page_response = client.get(
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/sites/field-report"
    )
    visual_path = (
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/site-editions/{EDITION_ID}"
        f"/assets/{DOCUMENT_OBJECT_ID}/pages/1.jpg"
    )
    assert page_response.status_code == 200
    assert visual_path in page_response.text
    assert "Exact semantic fallback." in page_response.text
    image_response = client.get(visual_path)
    assert image_response.status_code == 200
    assert image_response.content == image
    assert image_response.headers["Content-Type"] == "image/jpeg"
    assert image_response.headers["X-OpenGeo-Checksum-SHA256"] == sha256(image).hexdigest()

    package = client.get(
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/sites/field-report/export.zip"
    )
    assert package.status_code == 200
    with ZipFile(BytesIO(package.content)) as archive:
        assert archive.read(f"assets/documents/{DOCUMENT_OBJECT_ID}/page-1.jpg") == image
        assert b"bounded all-page visual and semantic" in archive.read("index.html")

    repository.release = None
    assert client.get(visual_path).status_code == 404


def test_public_site_fails_closed_on_a_corrupt_sealed_document_preview() -> None:
    body = b'{"schemaVersion":"attacker"}'
    asset = PublishedSiteAsset(
        kind="document",
        dataset_id=ASSET_DATASET_ID,
        dataset_version_id=ASSET_VERSION_ID,
        object_id=DOCUMENT_OBJECT_ID,
        bucket="opengeo-test-geodata",
        object_key="organizations/o/datasets/d/document/accessible-preview.json",
        storage_version_id="asset-version-1",
        content_type="application/json",
        size_bytes=len(body),
        checksum_sha256=sha256(body).hexdigest(),
        filename="accessible-preview.json",
    )
    release = edition()
    published_page = replace(
        page(),
        resource_content={
            "blocks": [
                {
                    "id": "document",
                    "type": "document",
                    "dataset_id": str(ASSET_DATASET_ID),
                    "dataset_version_id": str(ASSET_VERSION_ID),
                    "object_id": str(DOCUMENT_OBJECT_ID),
                    "label": "Corrupt document",
                }
            ]
        },
    )
    published_site = replace(
        site(state="published", active_edition=release), pages=(published_page,)
    )
    repository = MemorySiteRepository()
    repository.record = published_site
    repository.release = PublishedSite(published_site, release, (), (asset,))
    client = api_client(repository, download_storage=MemoryDownloadStorage(body))

    response = client.get(
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/sites/field-report"
    )

    assert response.status_code == 404
    assert response.json() == {"detail": "site_document_not_found"}


def test_publication_identity_keeps_site_and_access_context_explicit() -> None:
    class PublicationRepository(MemorySiteRepository):
        async def get_publication(self, context, publication_id):
            assert context == TenantContext(USER_ID, ORG_ID)
            assert publication_id == SITE_ID
            return site()

    response = api_client(PublicationRepository()).get(
        f"/publications/{SITE_ID}", headers=headers()
    )
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    record = response.json()
    assert record["id"] == record["site"]["id"] == str(SITE_ID)
    assert record["resource_type"] == "publication"
    assert record["access_container_id"] == record["site"]["project_id"] == str(PROJECT_ID)
