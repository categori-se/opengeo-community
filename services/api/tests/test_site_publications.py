import asyncio
from collections import deque
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID

import pytest

from opengeo_api.site_publications import (
    PostgresSitePublicationRepository,
    PublishedResourceReference,
    SiteAccessDenied,
    SiteAssetCandidate,
    SiteAssetDraft,
    SiteConflict,
    SiteDraft,
    SiteMapSnapshotDraft,
    SiteNotFound,
    SitePage,
    SitePageDraft,
)
from opengeo_api.tenant_database import TenantContext

USER_ID = UUID("20000000-0000-4000-8000-000000000281")
ORG_ID = UUID("10000000-0000-4000-8000-000000000281")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000281")
SITE_ID = UUID("b0000000-0000-4000-8000-000000000281")
SITE_VERSION_ID = UUID("b1000000-0000-4000-8000-000000000281")
PAGE_ID = UUID("b2000000-0000-4000-8000-000000000281")
RESOURCE_ID = UUID("a0000000-0000-4000-8000-000000000281")
RESOURCE_VERSION_ID = UUID("a1000000-0000-4000-8000-000000000281")
PAGE_SOURCE_ID = UUID("a2000000-0000-4000-8000-000000000281")
EDITION_ID = UUID("b4000000-0000-4000-8000-000000000281")
NOW = datetime(2026, 8, 20, 22, tzinfo=UTC)
RENDER_JOB_ID = UUID("a6000000-0000-4000-8000-000000000281")
OUTPUT_OBJECT_ID = UUID("86000000-0000-4000-8000-000000000281")
ASSET_DATASET_ID = UUID("80000000-0000-4000-8000-000000000282")
ASSET_VERSION_ID = UUID("81000000-0000-4000-8000-000000000282")
ASSET_OBJECT_ID = UUID("82000000-0000-4000-8000-000000000282")
DOCUMENT_OBJECT_ID = UUID("82000000-0000-4000-8000-000000000283")


class ScriptedTransaction:
    def __init__(self, *, one=(), all_rows=()) -> None:
        self.one = deque(one)
        self.all_rows = deque(all_rows)
        self.fetches: list[tuple[str, tuple[Any, ...]]] = []
        self.executions: list[tuple[str, tuple[Any, ...]]] = []

    async def fetch_one(self, statement, parameters=()):
        self.fetches.append((statement, tuple(parameters)))
        return self.one.popleft()

    async def fetch_all(self, statement, parameters=()):
        self.fetches.append((statement, tuple(parameters)))
        return self.all_rows.popleft()

    async def execute(self, statement, parameters=()):
        self.executions.append((statement, tuple(parameters)))


class ScriptedExecutor:
    def __init__(self, transaction: ScriptedTransaction) -> None:
        self.transaction = transaction

    async def run(self, context, operation):
        assert context == TenantContext(USER_ID, ORG_ID)
        return await operation(self.transaction)


def draft() -> SiteDraft:
    return SiteDraft(
        title="Investigation",
        description="A durable field report.",
        language="en",
        theme="paper",
        theme_options={"accentColor": "#176b87"},
        pages=(
            SitePageDraft(
                slug="home",
                navigation_label="Home",
                resource_id=RESOURCE_ID,
                resource_version=3,
                is_home=True,
            ),
        ),
    )


def site_row(
    state: str,
    *,
    reach: str = "listed",
    listed_slug: str | None = "investigation",
    primary: bool = False,
    destination_revision: int = 1,
) -> tuple[Any, ...]:
    return (
        SITE_ID,
        PROJECT_ID,
        "investigation",
        SITE_VERSION_ID,
        1,
        state,
        "Investigation",
        "A durable field report.",
        "en",
        "paper",
        {"accentColor": "#176b87"},
        None,
        USER_ID,
        NOW,
        USER_ID,
        NOW,
        {"schemaVersion": "opengeo.print-layout.1.0.0", "pages": []},
        destination_revision,
        reach,
        listed_slug,
        primary,
        USER_ID,
        NOW,
    )


def positioned_site_row(state: str) -> tuple[Any, ...]:
    value = list(site_row(state))
    value[16] = {
        "schemaVersion": "opengeo.print-layout.1.0.0",
        "pages": [
            {
                "sitePageSlug": "home",
                "elements": [
                    {
                        "id": "map_1",
                        "type": "map_frame",
                        "x": 20,
                        "y": 100,
                        "width": 700,
                        "height": 700,
                        "resourceId": str(RESOURCE_ID),
                    }
                ],
            }
        ],
    }
    return tuple(value)


def page_row() -> tuple[Any, ...]:
    return (
        PAGE_ID,
        "home",
        "Home",
        0,
        True,
        RESOURCE_ID,
        RESOURCE_VERSION_ID,
        3,
        "story",
        "Field findings",
        "Verified observations.",
        "en",
        "CC-BY-4.0",
        "Research desk",
        {"blocks": [{"id": "intro", "type": "markdown", "markdown": "# Findings"}]},
        "published",
        "public",
        PAGE_SOURCE_ID,
        "intro",
        "source-v3",
        "source-etag",
        "text/markdown",
        10,
        "d" * 64,
        "opengeo-markdown",
        "1.0.0",
        "opengeo-page-renderer-1.0.0",
    )


def map_page_row() -> tuple[Any, ...]:
    value = list(page_row())
    value[8] = "map"
    value[17:] = [None] * 10
    return tuple(value)


def asset_page_row() -> tuple[Any, ...]:
    value = list(page_row())
    value[14] = {
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
    }
    return tuple(value)


def document_page_row() -> tuple[Any, ...]:
    value = list(page_row())
    value[14] = {
        "blocks": [
            {
                "id": "field-report-document",
                "type": "document",
                "dataset_id": str(ASSET_DATASET_ID),
                "dataset_version_id": str(ASSET_VERSION_ID),
                "object_id": str(DOCUMENT_OBJECT_ID),
                "label": "Field report",
            }
        ]
    }
    return tuple(value)


def reference_row() -> tuple[Any, ...]:
    return (
        RESOURCE_ID,
        RESOURCE_VERSION_ID,
        3,
        "map",
        "Field map",
        "Verified observations.",
        "Research desk",
        "CC-BY-4.0",
        "published",
        "public",
        None,
        None,
    )


def large_page_row(index: int) -> tuple[Any, ...]:
    return (
        UUID(int=10_000 + index),
        f"p{index:02d}-" + "x" * 156,
        "N" * 120,
        index,
        index == 0,
        UUID(int=20_000 + index),
        UUID(int=30_000 + index),
        1,
        "story",
        "Page",
        None,
        "en",
        "CC-BY-4.0",
        "OpenGeo test fixture",
        {
            "blocks": [
                {"type": "dataset", "resource_id": str(UUID(int=40_000 + index * 2))},
                {
                    "type": "dataset",
                    "resource_id": str(UUID(int=40_000 + index * 2 + 1)),
                },
            ]
        },
        "published",
        "public",
    )


def edition_row() -> tuple[Any, ...]:
    return (
        EDITION_ID,
        SITE_ID,
        SITE_VERSION_ID,
        1,
        1,
        {
            "schemaVersion": "opengeo.site-edition.1.0.0",
            "editionId": str(EDITION_ID),
            "references": [],
        },
        "a" * 64,
        USER_ID,
        NOW,
        None,
        None,
    )


def asset_edition_row(*, checksum: str = "c" * 64) -> tuple[Any, ...]:
    value = list(edition_row())
    value[5] = {
        "schemaVersion": "opengeo.site-edition.1.2.0",
        "editionId": str(EDITION_ID),
        "references": [],
        "assets": [
            {
                "kind": "image",
                "datasetId": str(ASSET_DATASET_ID),
                "datasetVersionId": str(ASSET_VERSION_ID),
                "objectId": str(ASSET_OBJECT_ID),
                "storageVersionId": "s3-asset-version-1",
                "contentType": "image/png",
                "sizeBytes": 2_048,
                "checksumSha256": checksum,
                "filename": "coverage.png",
            }
        ],
    }
    return tuple(value)


def large_reference_row(index: int) -> tuple[Any, ...]:
    return (
        UUID(int=40_000 + index),
        UUID(int=50_000 + index),
        1,
        "dataset",
        "Referenced dataset",
        None,
        "OpenGeo test fixture",
        "CC-BY-4.0",
        "published",
        "public",
        None,
        None,
    )


def repository(transaction: ScriptedTransaction) -> PostgresSitePublicationRepository:
    return PostgresSitePublicationRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]


def test_lists_only_prevalidated_current_public_project_asset_candidates() -> None:
    asset_row = (
        ASSET_OBJECT_ID,
        ASSET_DATASET_ID,
        ASSET_VERSION_ID,
        "private-bucket",
        "organizations/o/projects/p/datasets/d/thumbnail/coverage.png",
        "s3-asset-version-1",
        "image/png",
        2_048,
        "c" * 64,
        "thumbnail",
        "public",
        "active",
        "active",
        "Coverage raster",
        4,
    )
    transaction = ScriptedTransaction(
        one=[("admin",), (PROJECT_ID, "owner")],
        all_rows=[[asset_row]],
    )

    candidates = asyncio.run(
        repository(transaction).list_asset_candidates(TenantContext(USER_ID, ORG_ID), PROJECT_ID)
    )

    assert candidates == (
        SiteAssetCandidate(
            kind="image",
            dataset_id=ASSET_DATASET_ID,
            dataset_name="Coverage raster",
            dataset_version_id=ASSET_VERSION_ID,
            dataset_version_number=4,
            object_id=ASSET_OBJECT_ID,
            role="thumbnail",
            content_type="image/png",
            size_bytes=2_048,
            checksum_sha256="c" * 64,
            filename="coverage.png",
        ),
    )
    statement, parameters = transaction.fetches[-1]
    assert "dataset.current_version_id" in statement
    assert "dataset.classification = 'public'" in statement
    assert "LIMIT 100" in statement
    assert parameters[0:3] == (ORG_ID, PROJECT_ID, 4 * 1024 * 1024)


def test_lists_a_scanned_pdf_visual_derivative_as_a_document_candidate() -> None:
    scan = {
        "safety_scan": {
            "status": "passed",
            "engine": "ClamAV",
            "engine_version": "1.4.3",
            "signature_version": 27_900,
            "comprehensive_malware_scan": True,
        }
    }
    schema = {
        "document": {
            "kind": "pdf",
            "source_format": "pdf",
            "accessible_preview_schema": "opengeo.document-preview.2.0.0",
            "text_extraction": "poppler_pdftotext",
            "reading_order": "heuristic",
            "ocr_performed": False,
            "tagged": False,
            "text_available": True,
            "text_block_count": 2,
            "text_characters": 128,
            "page_count": 2,
            "visual_presentation_schema": "opengeo.pdf-visual-presentation.1.0.0",
            "visual_renderer": "poppler_pdftoppm",
            "visual_media_type": "image/jpeg",
            "visual_annotations_hidden": True,
            "visual_page_count": 2,
            "visual_target_max_dimension": 1000,
            "visual_total_pixels": 1_200_000,
            "visual_total_image_bytes": 700_000,
        }
    }
    row = (
        DOCUMENT_OBJECT_ID,
        ASSET_DATASET_ID,
        ASSET_VERSION_ID,
        "private-bucket",
        "organizations/o/datasets/d/document/visual-presentation.json",
        "s3-pdf-visual-presentation-1",
        "application/json",
        1_000_000,
        "f" * 64,
        "derived",
        "public",
        "active",
        "active",
        "Investigation PDF",
        2,
        scan,
        "pdf",
        "document",
        schema,
    )
    transaction = ScriptedTransaction(
        one=[("admin",), (PROJECT_ID, "owner")],
        all_rows=[[row]],
    )

    candidates = asyncio.run(
        repository(transaction).list_asset_candidates(TenantContext(USER_ID, ORG_ID), PROJECT_ID)
    )

    assert len(candidates) == 1
    assert candidates[0].kind == "document"
    assert candidates[0].filename == "visual-presentation.json"


def test_pdf_attachment_requires_completed_clamav_evidence_before_publication() -> None:
    row = (
        ASSET_OBJECT_ID,
        ASSET_DATASET_ID,
        ASSET_VERSION_ID,
        "private-bucket",
        "organizations/o/projects/p/datasets/d/original/research-report.pdf",
        "s3-document-version-1",
        "application/pdf",
        2_048,
        "d" * 64,
        "original",
    )
    scan = {
        "safety_scan": {
            "status": "passed",
            "engine": "ClamAV",
            "engine_version": "1.4.3",
            "signature_version": 27_900,
            "comprehensive_malware_scan": True,
        }
    }

    asset = PostgresSitePublicationRepository._asset_from_row("file", row, scan)

    assert asset.content_type == "application/pdf"
    assert asset.filename == "research-report.pdf"
    with pytest.raises(SiteConflict, match="site_document_scan_not_verified"):
        PostgresSitePublicationRepository._asset_from_row("file", row, {})


def test_odt_document_asset_requires_derived_preview_schema_and_clamav_evidence() -> None:
    row = (
        DOCUMENT_OBJECT_ID,
        ASSET_DATASET_ID,
        ASSET_VERSION_ID,
        "private-bucket",
        "organizations/o/datasets/d/document/accessible-preview.json",
        "s3-document-preview-1",
        "application/json",
        4_096,
        "e" * 64,
        "derived",
    )
    scan = {
        "safety_scan": {
            "status": "passed",
            "engine": "ClamAV",
            "engine_version": "1.4.3",
            "signature_version": 27_900,
            "comprehensive_malware_scan": True,
        }
    }
    schema = {
        "document": {
            "kind": "odf_text",
            "source_format": "odt",
            "accessible_preview_schema": "opengeo.document-preview.1.0.0",
        }
    }

    asset = PostgresSitePublicationRepository._asset_from_row(
        "document",
        row,
        scan,
        dataset_format="odt",
        geometry_type="document",
        schema_definition=schema,
    )

    assert asset.kind == "document"
    assert asset.filename == "accessible-preview.json"
    with pytest.raises(SiteConflict, match="site_document_preview_invalid"):
        PostgresSitePublicationRepository._asset_from_row(
            "document",
            row,
            scan,
            dataset_format="odt",
            geometry_type="document",
            schema_definition={},
        )
    with pytest.raises(SiteConflict, match="site_document_scan_not_verified"):
        PostgresSitePublicationRepository._asset_from_row(
            "document",
            row,
            {},
            dataset_format="odt",
            geometry_type="document",
            schema_definition=schema,
        )


def test_pdf_document_asset_requires_exact_bounded_text_extraction_facts() -> None:
    row = (
        DOCUMENT_OBJECT_ID,
        ASSET_DATASET_ID,
        ASSET_VERSION_ID,
        "private-bucket",
        "organizations/o/datasets/d/document/accessible-preview.json",
        "s3-pdf-semantic-preview-1",
        "application/json",
        8_192,
        "f" * 64,
        "derived",
    )
    scan = {
        "safety_scan": {
            "status": "passed",
            "engine": "ClamAV",
            "engine_version": "1.4.3",
            "signature_version": 27_900,
            "comprehensive_malware_scan": True,
        }
    }
    schema = {
        "document": {
            "kind": "pdf",
            "source_format": "pdf",
            "accessible_preview_schema": "opengeo.document-preview.2.0.0",
            "text_extraction": "poppler_pdftotext",
            "reading_order": "heuristic",
            "ocr_performed": False,
            "tagged": True,
            "text_available": True,
            "text_block_count": 4,
            "text_characters": 1_024,
        }
    }

    asset = PostgresSitePublicationRepository._asset_from_row(
        "document",
        row,
        scan,
        dataset_format="pdf",
        geometry_type="document",
        schema_definition=schema,
    )

    assert asset.kind == "document"
    assert asset.storage_version_id == "s3-pdf-semantic-preview-1"
    for changed in (
        {**schema["document"], "ocr_performed": True},
        {**schema["document"], "text_available": False},
        {**schema["document"], "text_characters": 200_001},
    ):
        with pytest.raises(SiteConflict, match="site_document_preview_invalid"):
            PostgresSitePublicationRepository._asset_from_row(
                "document",
                row,
                scan,
                dataset_format="pdf",
                geometry_type="document",
                schema_definition={"document": changed},
            )


@pytest.mark.parametrize("method", ["pypdf_tagged_actualtext", "pypdf_tagged_mcid_text"])
def test_tagged_pdf_facts_require_exact_semantic_method_and_keep_legacy_guards(method) -> None:
    facts = {
        "kind": "pdf",
        "source_format": "pdf",
        "accessible_preview_schema": "opengeo.document-preview.2.0.0",
        "text_extraction": method,
        "reading_order": "source-tags",
        "ocr_performed": False,
        "tagged": True,
        "text_available": True,
        "text_block_count": 2,
        "text_characters": 42,
    }
    valid = PostgresSitePublicationRepository._document_facts_valid
    key = "x/document/accessible-preview.json"
    assert valid("pdf", "document", {"document": facts}, key)
    for change in (
        {"text_extraction": "poppler_pdftotext"},
        {"text_extraction": "pypdf_unknown_reader"},
        {"text_extraction": None},
        {"text_extraction": []},
        {"reading_order": "heuristic"},
        {"ocr_performed": True},
        {"tagged": False},
        {"text_available": False},
        {"text_block_count": 0},
        {"text_block_count": "2"},
        {"accessible_preview_schema": "opengeo.document-preview.3.0.0"},
    ):
        assert not valid("pdf", "document", {"document": {**facts, **change}}, key)
    assert not valid("odt", "document", {"document": facts}, key)
    assert not valid("pdf", "Point", {"document": facts}, key)
    assert not valid("pdf", "document", {"document": facts}, "x/source.pdf")


def test_pdf_ocr_document_asset_requires_exact_bounded_provenance() -> None:
    row = (
        DOCUMENT_OBJECT_ID,
        ASSET_DATASET_ID,
        ASSET_VERSION_ID,
        "private-bucket",
        "organizations/o/datasets/d/document/accessible-preview.json",
        "s3-pdf-ocr-preview-1",
        "application/json",
        8_192,
        "f" * 64,
        "derived",
    )
    scan = {
        "safety_scan": {
            "status": "passed",
            "engine": "ClamAV",
            "engine_version": "1.4.3",
            "signature_version": 27_900,
            "comprehensive_malware_scan": True,
        }
    }
    facts = {
        "kind": "pdf",
        "source_format": "pdf",
        "accessible_preview_schema": "opengeo.document-preview.3.0.0",
        "text_extraction": "poppler_pdftotext_tesseract",
        "reading_order": "heuristic",
        "ocr_performed": True,
        "ocr_engine": "tesseract",
        "ocr_engine_version": "5.3.4",
        "ocr_model": "Arabic",
        "ocr_page_limit": 32,
        "ocr_page_count": 2,
        "ocr_pages": [2, 4],
        "ocr_pixel_limit": 32_000_000,
        "ocr_maximum_dimension": 1600,
        "ocr_total_pixels": 2_560_000,
        "ocr_truncated": False,
        "tagged": False,
        "text_available": True,
        "text_block_count": 3,
        "text_characters": 420,
        "page_count": 4,
        "visual_presentation_schema": "opengeo.pdf-visual-presentation.2.0.0",
        "visual_renderer": "poppler_pdftoppm",
        "visual_media_type": "image/jpeg",
        "visual_annotations_hidden": True,
        "visual_page_count": 4,
        "visual_target_max_dimension": 1000,
        "visual_total_pixels": 2_400_000,
        "visual_total_image_bytes": 900_000,
    }

    asset = PostgresSitePublicationRepository._asset_from_row(
        "document",
        row,
        scan,
        dataset_format="pdf",
        geometry_type="document",
        schema_definition={"document": facts},
    )

    assert asset.storage_version_id == "s3-pdf-ocr-preview-1"
    assert PostgresSitePublicationRepository._document_facts_valid(
        "pdf",
        "document",
        {"document": facts},
        "organizations/o/datasets/d/document/visual-presentation.json",
    )
    assert not PostgresSitePublicationRepository._document_facts_valid(
        "pdf",
        "document",
        {
            "document": {
                **facts,
                "visual_presentation_schema": "opengeo.pdf-visual-presentation.1.0.0",
            }
        },
        "organizations/o/datasets/d/document/visual-presentation.json",
    )
    for changed in (
        {**facts, "ocr_page_limit": 33},
        {**facts, "ocr_page_count": 1},
        {**facts, "ocr_pages": [4, 2]},
        {**facts, "ocr_model": "attacker/model"},
        {**facts, "ocr_truncated": True},
    ):
        with pytest.raises(SiteConflict, match="site_document_preview_invalid"):
            PostgresSitePublicationRepository._asset_from_row(
                "document",
                row,
                scan,
                dataset_format="pdf",
                geometry_type="document",
                schema_definition={"document": changed},
            )


def test_pdf_visual_document_asset_requires_exact_raster_facts() -> None:
    row = (
        DOCUMENT_OBJECT_ID,
        ASSET_DATASET_ID,
        ASSET_VERSION_ID,
        "private-bucket",
        "organizations/o/datasets/d/document/visual-presentation.json",
        "s3-pdf-visual-presentation-1",
        "application/json",
        1_000_000,
        "f" * 64,
        "derived",
    )
    scan = {
        "safety_scan": {
            "status": "passed",
            "engine": "ClamAV",
            "engine_version": "1.4.3",
            "signature_version": 27_900,
            "comprehensive_malware_scan": True,
        }
    }
    facts = {
        "kind": "pdf",
        "source_format": "pdf",
        "accessible_preview_schema": "opengeo.document-preview.2.0.0",
        "text_extraction": "poppler_pdftotext",
        "reading_order": "heuristic",
        "ocr_performed": False,
        "tagged": True,
        "text_available": True,
        "text_block_count": 4,
        "text_characters": 1_024,
        "page_count": 2,
        "visual_presentation_schema": "opengeo.pdf-visual-presentation.1.0.0",
        "visual_renderer": "poppler_pdftoppm",
        "visual_media_type": "image/jpeg",
        "visual_annotations_hidden": True,
        "visual_page_count": 2,
        "visual_target_max_dimension": 1000,
        "visual_total_pixels": 1_200_000,
        "visual_total_image_bytes": 700_000,
    }

    asset = PostgresSitePublicationRepository._asset_from_row(
        "document",
        row,
        scan,
        dataset_format="pdf",
        geometry_type="document",
        schema_definition={"document": facts},
    )

    assert asset.filename == "visual-presentation.json"
    for changed in (
        {**facts, "visual_annotations_hidden": False},
        {**facts, "visual_page_count": 1},
        {**facts, "visual_total_pixels": 20_000_001},
        {**facts, "visual_total_image_bytes": 2_400_001},
    ):
        with pytest.raises(SiteConflict, match="site_document_preview_invalid"):
            PostgresSitePublicationRepository._asset_from_row(
                "document",
                row,
                scan,
                dataset_format="pdf",
                geometry_type="document",
                schema_definition={"document": changed},
            )


def test_create_site_inserts_stable_head_exact_page_revision_and_audit() -> None:
    transaction = ScriptedTransaction(
        one=[
            ("member",),
            (PROJECT_ID, "editor"),
            None,
            (RESOURCE_VERSION_ID,),
            (SITE_VERSION_ID,),
            None,
            site_row("draft"),
        ],
        all_rows=[[page_row()]],
    )
    record = asyncio.run(
        repository(transaction).create_site(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            "investigation",
            draft(),
            "site-create",
        )
    )

    assert record.state == "draft"
    assert record.pages[0].resource_version_number == 3
    statements = "\n".join(statement for statement, _ in transaction.executions)
    assert "INSERT INTO app.project_sites" in statements
    assert "INSERT INTO app.project_site_versions" in statements
    assert "INSERT INTO app.project_site_pages" in statements
    assert "INSERT INTO app.activity_events" in statements
    page_parameters = next(
        parameters
        for statement, parameters in transaction.executions
        if "INSERT INTO app.project_site_pages" in statement
    )
    assert page_parameters[10:13] == (RESOURCE_ID, RESOURCE_VERSION_ID, 3)


def test_owner_configures_one_versioned_listed_primary_destination_and_audits() -> None:
    transaction = ScriptedTransaction(
        one=[
            ("admin",),
            (PROJECT_ID, "owner"),
            (1, "unpublished", "investigation", False),
            (SITE_VERSION_ID,),
            None,
            site_row(
                "draft",
                reach="listed",
                listed_slug="atlas",
                primary=True,
                destination_revision=2,
            ),
        ],
        all_rows=[[page_row()]],
    )

    record = asyncio.run(
        repository(transaction).configure_site_publication_destination(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            SITE_ID,
            1,
            "listed",
            "atlas",
            True,
            "site-destination",
        )
    )

    assert record.publication_destination is not None
    assert record.publication_destination.revision == 2
    assert record.publication_destination.reach == "listed"
    assert record.publication_destination.listed_slug == "atlas"
    assert record.publication_destination.is_primary is True
    statements = "\n".join(statement for statement, _ in transaction.executions)
    assert "UPDATE app.project_site_publication_destinations" in statements
    assert "INSERT INTO app.project_site_publication_destination_events" in statements
    assert "site.publication.destination.configured" in next(
        parameters[3]
        for statement, parameters in transaction.executions
        if "INSERT INTO app.activity_events" in statement
    )


def test_publication_destination_rejects_stale_revision_before_mutation() -> None:
    transaction = ScriptedTransaction(
        one=[("admin",), (PROJECT_ID, "owner"), (3, "listed", "atlas", True)]
    )
    with pytest.raises(SiteConflict, match="site_publication_destination_conflict"):
        asyncio.run(
            repository(transaction).configure_site_publication_destination(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                SITE_ID,
                2,
                "unlisted",
                "atlas",
                False,
                "site-destination-stale",
            )
        )
    assert transaction.executions == []


def test_public_directory_lists_only_active_listed_editions_and_selects_latest_primary() -> None:
    directory_row = (
        PROJECT_ID,
        "Investigation project",
        SITE_ID,
        EDITION_ID,
        "investigation",
        "Investigation",
        "A durable field report.",
        "en",
        "paper",
        1,
        NOW,
        True,
    )
    transaction = ScriptedTransaction(one=[(1,)], all_rows=[[directory_row]])

    page = asyncio.run(
        repository(transaction).list_public_sites(
            TenantContext(USER_ID, ORG_ID), limit=24, offset=0
        )
    )

    assert page.number_matched == 1
    assert len(page.records) == 1
    assert page.records[0].listed_slug == "investigation"
    assert page.records[0].project_name == "Investigation project"
    assert page.records[0].is_primary is True
    count_statement, count_parameters = transaction.fetches[0]
    list_statement, list_parameters = transaction.fetches[1]
    assert "publication_reach = 'listed'" in count_statement
    assert "revoked_at IS NULL" in count_statement
    assert count_parameters == (ORG_ID,)
    assert "ORDER BY candidate.published_at DESC, candidate.id DESC" in list_statement
    assert "edition.id = (SELECT id FROM active_primary)" in list_statement
    assert list_parameters == (ORG_ID, ORG_ID, 24, 0)


def test_public_primary_destination_resolves_latest_active_sealed_edition() -> None:
    listed_edition = (*edition_row(), "listed", "investigation", None, True)
    transaction = ScriptedTransaction(
        one=[(PROJECT_ID, *listed_edition), site_row("published", primary=True)],
        all_rows=[[page_row()]],
    )

    publication = asyncio.run(
        repository(transaction).get_public_site_by_destination(
            TenantContext(USER_ID, ORG_ID), primary=True
        )
    )

    assert publication.site.project_id == PROJECT_ID
    assert publication.edition.edition_id == EDITION_ID
    assert publication.edition.is_primary is True
    statement, parameters = transaction.fetches[0]
    assert "edition.is_primary" in statement
    assert "ORDER BY edition.published_at DESC, edition.id DESC" in statement
    assert parameters == (ORG_ID,)


def test_project_editor_cannot_publish_site_without_reviewer_authority() -> None:
    transaction = ScriptedTransaction(one=[("member",), (PROJECT_ID, "editor")])
    with pytest.raises(SiteAccessDenied, match="action forbidden"):
        asyncio.run(
            repository(transaction).publish_site(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                SITE_ID,
                1,
                "Approved",
                (),
                "site-publish-denied",
            )
        )
    assert transaction.executions == []


@pytest.mark.parametrize(
    ("license_value", "attribution"),
    [
        (None, "Research desk"),
        ("All rights reserved", "Research desk"),
        ("CC-BY-4.0", None),
        ("CC-BY-4.0", "   "),
    ],
)
def test_publication_fails_closed_without_permissive_rights_and_attribution(
    license_value: str | None, attribution: str | None
) -> None:
    unsafe_page = list(page_row())
    unsafe_page[12] = license_value
    unsafe_page[13] = attribution
    transaction = ScriptedTransaction(
        one=[
            ("member",),
            (PROJECT_ID, "reviewer"),
            (SITE_VERSION_ID, 1, "review"),
            site_row("review"),
        ],
        all_rows=[[tuple(unsafe_page)]],
    )

    with pytest.raises(SiteConflict, match="site_page_public_rights_incomplete"):
        asyncio.run(
            repository(transaction).publish_site(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                SITE_ID,
                1,
                "Unsafe public rights",
                (),
                "site-publish-rights-denied",
            )
        )

    assert transaction.executions == []


def test_publication_fails_closed_when_referenced_map_rights_are_incomplete() -> None:
    unsafe_reference = list(reference_row())
    unsafe_reference[7] = "Proprietary"
    transaction = ScriptedTransaction(
        one=[
            ("member",),
            (PROJECT_ID, "reviewer"),
            (SITE_VERSION_ID, 1, "review"),
            site_row("review"),
        ],
        all_rows=[[map_page_row()], [tuple(unsafe_reference)]],
    )

    with pytest.raises(SiteConflict, match="site_reference_public_rights_incomplete"):
        asyncio.run(
            repository(transaction).publish_site(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                SITE_ID,
                1,
                "Unsafe referenced map rights",
                (),
                "site-publish-reference-rights-denied",
            )
        )

    assert transaction.executions == []


def test_publication_rejects_drift_from_an_authored_resource_version_pin() -> None:
    authored_page = SitePage(
        page_id=PAGE_ID,
        slug="home",
        navigation_label="Home",
        position=0,
        is_home=True,
        resource_id=UUID(int=999),
        resource_version_id=RESOURCE_VERSION_ID,
        resource_version_number=1,
        resource_kind="story",
        resource_title="Pinned map story",
        resource_abstract=None,
        resource_language="en",
        resource_license="CC-BY-4.0",
        resource_attribution="Research desk",
        resource_content={
            "blocks": [
                {
                    "id": "field-map",
                    "type": "map",
                    "resource_id": str(RESOURCE_ID),
                    "resource_version_number": 2,
                }
            ]
        },
        resource_state="published",
        resource_visibility="public",
    )
    current_reference = PublishedResourceReference(
        resource_id=RESOURCE_ID,
        version_id=RESOURCE_VERSION_ID,
        version_number=3,
        kind="map",
        title="Field map",
        abstract=None,
        attribution="Research desk",
        license="CC-BY-4.0",
        wms_service_id=None,
        wms_layer_name=None,
    )

    with pytest.raises(SiteConflict, match="site_reference_version_drift"):
        PostgresSitePublicationRepository._require_public_release(
            (authored_page,), (current_reference,)
        )

    authored_page.resource_content["blocks"][0]["resource_version_number"] = 3
    PostgresSitePublicationRepository._require_public_release(
        (authored_page,), (current_reference,)
    )


def test_reviewer_publication_seals_manifest_replaces_active_alias_and_audits() -> None:
    transaction = ScriptedTransaction(
        one=[
            ("member",),
            (PROJECT_ID, "reviewer"),
            (SITE_VERSION_ID, 1, "review"),
            site_row("review"),
            (1,),
            (SITE_VERSION_ID,),
            edition_row(),
            site_row("published"),
        ],
        all_rows=[[page_row()], [page_row()]],
    )
    record = asyncio.run(
        repository(transaction).publish_site(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            SITE_ID,
            1,
            "Approved for release",
            (),
            "site-publish",
        )
    )

    assert record.state == "published"
    statements = "\n".join(statement for statement, _ in transaction.executions)
    fetches = "\n".join(statement for statement, _ in transaction.fetches)
    assert "LEFT JOIN app.page_source_objects" in fetches
    assert "UPDATE app.project_site_editions" in statements
    assert "INSERT INTO app.project_site_editions" in statements
    assert "INSERT INTO app.project_site_workflow_events" in statements
    assert "site.edition.published" in next(
        parameters[3]
        for statement, parameters in transaction.executions
        if "INSERT INTO app.activity_events" in statement
    )
    edition_parameters = next(
        parameters
        for statement, parameters in transaction.executions
        if "INSERT INTO app.project_site_editions" in statement
    )
    manifest = edition_parameters[7].obj
    assert manifest["schemaVersion"] == "opengeo.site-edition.1.4.0"
    assert manifest["rendererVersion"] == "opengeo-page-renderer-1.1.0"
    assert manifest["siteVersionId"] == str(SITE_VERSION_ID)
    assert manifest["pages"][0]["resourceVersionId"] == str(RESOURCE_VERSION_ID)
    assert manifest["pages"][0]["pageSource"] == {
        "sourceId": str(PAGE_SOURCE_ID),
        "sourceBlockId": "intro",
        "s3VersionId": "source-v3",
        "etag": "source-etag",
        "contentType": "text/markdown",
        "sizeBytes": 10,
        "checksumSha256": "d" * 64,
        "dialect": "opengeo-markdown",
        "dialectVersion": "1.0.0",
        "compilerVersion": "opengeo-page-renderer-1.0.0",
    }
    assert manifest["themeOptions"] == {"accentColor": "#176b87"}
    assert manifest["printLayout"] == {
        "schemaVersion": "opengeo.print-layout.1.0.0",
        "pages": [],
    }
    assert manifest["references"] == []
    assert manifest["assets"] == []
    assert manifest["revocation"]["downloadedOrPrintedCopiesCannotBeRecalled"] is True


@pytest.mark.parametrize("reference_kind", ["dataset", "map"])
def test_publication_seals_exact_completed_png_snapshot_into_manifest(
    monkeypatch, reference_kind
) -> None:
    verified_map_seal = {
        "schemaVersion": "opengeo.saved-map-publication.1.0.0",
        "mapId": str(RESOURCE_ID),
        "mapVersion": 3,
        "resourceVersionId": str(RESOURCE_VERSION_ID),
        "recipeChecksumSha256": "d" * 64,
        "definitionChecksumSha256": "e" * 64,
        "sources": [{"position": 1, "layerId": "areas", "checksumSha256": "f" * 64}],
    }
    seal_calls = []

    async def verified_seal(*args, **kwargs):
        seal_calls.append((args, kwargs))
        return verified_map_seal

    monkeypatch.setattr("opengeo_api.saved_map_publication.load_saved_map_seal", verified_seal)
    selected_reference = list(reference_row())
    selected_reference[3] = reference_kind
    selected_site = positioned_site_row("review") if reference_kind == "map" else site_row("review")
    snapshot_row = (
        RENDER_JOB_ID,
        RESOURCE_ID,
        RESOURCE_VERSION_ID,
        OUTPUT_OBJECT_ID,
        "s3-version-7",
        "image/png",
        1_024,
        "b" * 64,
        960,
        540,
        [-71.2, 42.2, -71.0, 42.4],
        "EPSG:3857",
        {
            "geometry": {
                "type": "fill",
                "color": "#176B87",
                "opacity": 0.8,
                "classification": {
                    "rules": [{"label": "Verified", "color": "#2E7D32"}],
                    "fallback_color": "#D8E8ED",
                },
            },
            "legend": {"enabled": True, "title": "Survey status"},
        },
        "c" * 64,
    )
    transaction = ScriptedTransaction(
        one=[
            ("member",),
            (PROJECT_ID, "reviewer"),
            (SITE_VERSION_ID, 1, "review"),
            selected_site,
            (1,),
            (SITE_VERSION_ID,),
            edition_row(),
            site_row("published"),
        ],
        all_rows=[
            [map_page_row()],
            [tuple(selected_reference)],
            [snapshot_row],
            [map_page_row()],
        ],
    )

    asyncio.run(
        repository(transaction).publish_site(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            SITE_ID,
            1,
            "Approved with print snapshot",
            (SiteMapSnapshotDraft(RESOURCE_ID, RENDER_JOB_ID),),
            "site-publish-snapshot",
        )
    )

    edition_parameters = next(
        parameters
        for statement, parameters in transaction.executions
        if "INSERT INTO app.project_site_editions" in statement
    )
    sealed = edition_parameters[7].obj["references"][0]["snapshot"]
    expected = {
        "renderJobId": str(RENDER_JOB_ID),
        "outputObjectId": str(OUTPUT_OBJECT_ID),
        "storageVersionId": "s3-version-7",
        "contentType": "image/png",
        "sizeBytes": 1_024,
        "checksumSha256": "b" * 64,
        "width": 960,
        "height": 540,
        "bbox": [-71.2, 42.2, -71.0, 42.4],
        "crs": "EPSG:3857",
        "savedMap": None,
        "legend": {
            "title": "Survey status",
            "profileChecksumSha256": "c" * 64,
            "items": [
                {"label": "Verified", "symbol": "fill", "color": "#2e7d32", "opacity": 0.8},
                {"label": "Other", "symbol": "fill", "color": "#d8e8ed", "opacity": 0.8},
            ],
        },
    }
    if reference_kind == "map":
        expected["savedMap"] = verified_map_seal
        expected["legend"] = None
        assert seal_calls == [
            (
                (
                    transaction,
                    TenantContext(USER_ID, ORG_ID),
                    PROJECT_ID,
                    RESOURCE_ID,
                    RESOURCE_VERSION_ID,
                    RENDER_JOB_ID,
                ),
                {"public": True},
            )
        ]
    else:
        assert seal_calls == []
    assert sealed == expected
    assert edition_parameters[7].obj["printLayout"] == selected_site[16]


def test_positioned_map_frame_cannot_publish_without_an_exact_snapshot() -> None:
    transaction = ScriptedTransaction(
        one=[
            ("member",),
            (PROJECT_ID, "reviewer"),
            (SITE_VERSION_ID, 1, "review"),
            positioned_site_row("review"),
        ],
        all_rows=[[map_page_row()], [reference_row()]],
    )

    with pytest.raises(SiteConflict, match="site_print_layout_snapshot_not_sealed"):
        asyncio.run(
            repository(transaction).publish_site(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                SITE_ID,
                1,
                "Missing positioned snapshot",
                (),
                "site-publish-positioned-missing",
            )
        )
    assert not any(
        "INSERT INTO app.project_site_editions" in statement
        for statement, _ in transaction.executions
    )


def test_publication_seals_one_public_exact_dataset_asset_into_manifest() -> None:
    asset_row = (
        ASSET_OBJECT_ID,
        ASSET_DATASET_ID,
        ASSET_VERSION_ID,
        "opengeo-test-geodata",
        f"organizations/{ORG_ID}/datasets/{ASSET_DATASET_ID}/coverage.png",
        "s3-asset-version-1",
        "image/png",
        2_048,
        "c" * 64,
        "thumbnail",
        "public",
        "active",
        "active",
    )
    transaction = ScriptedTransaction(
        one=[
            ("member",),
            (PROJECT_ID, "reviewer"),
            (SITE_VERSION_ID, 1, "review"),
            site_row("review"),
            (1,),
            (SITE_VERSION_ID,),
            edition_row(),
            site_row("published"),
        ],
        all_rows=[[asset_page_row()], [asset_row], [asset_page_row()]],
    )

    asyncio.run(
        repository(transaction).publish_site(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            SITE_ID,
            1,
            "Approved with governed image",
            (),
            "site-publish-asset",
        )
    )

    edition_parameters = next(
        parameters
        for statement, parameters in transaction.executions
        if "INSERT INTO app.project_site_editions" in statement
    )
    assert edition_parameters[7].obj["assets"] == [
        {
            "kind": "image",
            "datasetId": str(ASSET_DATASET_ID),
            "datasetVersionId": str(ASSET_VERSION_ID),
            "objectId": str(ASSET_OBJECT_ID),
            "storageVersionId": "s3-asset-version-1",
            "contentType": "image/png",
            "sizeBytes": 2_048,
            "checksumSha256": "c" * 64,
            "filename": "coverage.png",
        }
    ]


def test_publication_seals_one_post_scan_odt_semantic_preview() -> None:
    scan = {
        "safety_scan": {
            "status": "passed",
            "engine": "ClamAV",
            "engine_version": "1.4.3",
            "signature_version": 27_900,
            "comprehensive_malware_scan": True,
        }
    }
    schema = {
        "document": {
            "kind": "odf_text",
            "source_format": "odt",
            "accessible_preview_schema": "opengeo.document-preview.1.0.0",
        }
    }
    asset_row = (
        DOCUMENT_OBJECT_ID,
        ASSET_DATASET_ID,
        ASSET_VERSION_ID,
        "opengeo-test-geodata",
        f"organizations/{ORG_ID}/datasets/{ASSET_DATASET_ID}/document/accessible-preview.json",
        "s3-document-preview-1",
        "application/json",
        4_096,
        "e" * 64,
        "derived",
        "public",
        "active",
        "active",
        scan,
        "odt",
        "document",
        schema,
    )
    transaction = ScriptedTransaction(
        one=[
            ("member",),
            (PROJECT_ID, "reviewer"),
            (SITE_VERSION_ID, 1, "review"),
            site_row("review"),
            (1,),
            (SITE_VERSION_ID,),
            edition_row(),
            site_row("published"),
        ],
        all_rows=[[document_page_row()], [asset_row], [document_page_row()]],
    )

    asyncio.run(
        repository(transaction).publish_site(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            SITE_ID,
            1,
            "Approved ODT semantic presentation",
            (),
            "site-publish-document",
        )
    )

    edition_parameters = next(
        parameters
        for statement, parameters in transaction.executions
        if "INSERT INTO app.project_site_editions" in statement
    )
    assert edition_parameters[7].obj["assets"] == [
        {
            "kind": "document",
            "datasetId": str(ASSET_DATASET_ID),
            "datasetVersionId": str(ASSET_VERSION_ID),
            "objectId": str(DOCUMENT_OBJECT_ID),
            "storageVersionId": "s3-document-preview-1",
            "contentType": "application/json",
            "sizeBytes": 4_096,
            "checksumSha256": "e" * 64,
            "filename": "accessible-preview.json",
        }
    ]


def test_publication_rejects_an_unprocessed_original_png_asset() -> None:
    asset_row = (
        ASSET_OBJECT_ID,
        ASSET_DATASET_ID,
        ASSET_VERSION_ID,
        "opengeo-test-geodata",
        f"organizations/{ORG_ID}/datasets/{ASSET_DATASET_ID}/coverage.png",
        "s3-asset-version-1",
        "image/png",
        2_048,
        "c" * 64,
        "original",
        "public",
        "active",
        "active",
    )
    transaction = ScriptedTransaction(
        one=[
            ("member",),
            (PROJECT_ID, "reviewer"),
            (SITE_VERSION_ID, 1, "review"),
            site_row("review"),
        ],
        all_rows=[[asset_page_row()], [asset_row]],
    )

    with pytest.raises(SiteConflict, match="site_asset_invalid"):
        asyncio.run(
            repository(transaction).publish_site(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                SITE_ID,
                1,
                "Unsafe original image",
                (),
                "site-publish-invalid-asset",
            )
        )

    assert transaction.executions == []


def test_public_read_revalidates_an_exact_asset_manifest_and_rejects_checksum_drift() -> None:
    asset_row = (
        ASSET_OBJECT_ID,
        ASSET_DATASET_ID,
        ASSET_VERSION_ID,
        "opengeo-test-geodata",
        f"organizations/{ORG_ID}/datasets/{ASSET_DATASET_ID}/coverage.png",
        "s3-asset-version-1",
        "image/png",
        2_048,
        "c" * 64,
        "thumbnail",
        "public",
        "active",
        "active",
    )
    valid_transaction = ScriptedTransaction(
        one=[asset_edition_row(), site_row("published")],
        all_rows=[[asset_page_row()], [asset_row]],
    )
    publication = asyncio.run(
        repository(valid_transaction).get_public_site(
            TenantContext(USER_ID, ORG_ID), PROJECT_ID, edition_id=EDITION_ID
        )
    )
    assert publication.assets[0].object_id == ASSET_OBJECT_ID

    drifted_transaction = ScriptedTransaction(
        one=[asset_edition_row(checksum="d" * 64), site_row("published")],
        all_rows=[[asset_page_row()], [asset_row]],
    )
    with pytest.raises(SiteNotFound, match="site_edition"):
        asyncio.run(
            repository(drifted_transaction).get_public_site(
                TenantContext(USER_ID, ORG_ID), PROJECT_ID, edition_id=EDITION_ID
            )
        )


def test_site_draft_rejects_multiple_home_pages_before_database_access() -> None:
    invalid = replace_page_home(draft())
    transaction = ScriptedTransaction()
    with pytest.raises(SiteConflict, match="site_home_page_invalid"):
        asyncio.run(
            repository(transaction).create_site(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                "invalid",
                invalid,
                "site-invalid",
            )
        )
    assert transaction.fetches == []


def test_publication_rejects_oversized_manifest_before_revoking_active_edition(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("opengeo_api.site_publications.MAX_SITE_MANIFEST_BYTES", 1)
    transaction = ScriptedTransaction(
        one=[
            ("member",),
            (PROJECT_ID, "reviewer"),
            (SITE_VERSION_ID, 1, "review"),
            site_row("review"),
            (1,),
        ],
        all_rows=[
            [large_page_row(index) for index in range(64)],
            [large_reference_row(index) for index in range(128)],
        ],
    )

    with pytest.raises(SiteConflict, match="site_manifest_too_large"):
        asyncio.run(
            repository(transaction).publish_site(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                SITE_ID,
                1,
                "Approved",
                (),
                "site-publish-too-large",
            )
        )

    statements = "\n".join(statement for statement, _ in transaction.executions)
    assert "UPDATE app.project_site_editions" not in statements


def replace_page_home(value: SiteDraft) -> SiteDraft:
    page = value.pages[0]
    return SiteDraft(
        title=value.title,
        description=value.description,
        language=value.language,
        theme=value.theme,
        theme_options=value.theme_options,
        pages=(
            SitePageDraft(
                slug=page.slug,
                navigation_label=page.navigation_label,
                resource_id=page.resource_id,
                resource_version=page.resource_version,
                is_home=False,
            ),
        ),
    )


def test_publication_resolution_hides_a_same_tenant_unreadable_container() -> None:
    transaction = ScriptedTransaction(one=[(PROJECT_ID,), ("member",), (PROJECT_ID, None)])
    with pytest.raises(SiteNotFound) as caught:
        asyncio.run(
            repository(transaction).get_publication(TenantContext(USER_ID, ORG_ID), SITE_ID)
        )
    assert caught.value.resource == "publication"
    assert len(transaction.fetches) == 3
    assert transaction.fetches[0][1] == (ORG_ID, SITE_ID)
    assert transaction.executions == []


PRINT_DOCUMENT_OBJECT_ID = UUID("82000000-0000-4000-8000-000000000284")


def pdf_print_asset_rows(kind: str = "file") -> tuple[tuple[Any, ...], tuple[Any, ...]]:
    scan = {
        "safety_scan": {
            "status": "passed",
            "engine": "ClamAV",
            "engine_version": "1.4.3",
            "signature_version": 27900,
            "comprehensive_malware_scan": True,
        }
    }
    document = {
        "kind": "pdf",
        "source_format": "pdf",
        "page_count": 1,
        "tagged": False,
        "text_available": True,
        "text_block_count": 1,
        "text_characters": 10,
        "accessible_preview_schema": "opengeo.document-preview.2.0.0",
        "text_extraction": "poppler_pdftotext",
        "reading_order": "heuristic",
        "ocr_performed": False,
        "print_vector_available": True,
        "print_vector_schema": "opengeo.pdf-print-vector.1.0.0",
        "print_vector_facts": {
            "schema": "opengeo.pdf-print-vector.1.0.0",
            "page_count": 1,
            "renderer": "pypdf-safe-clone",
            "source_tags": "absent",
            "annotations_removed": 0,
            "pages": [
                {
                    "crop_box": [0, 0, 612, 792],
                    "media_box": [0, 0, 612, 792],
                    "rotation": 0,
                    "width_points": 612,
                    "height_points": 792,
                }
            ],
        },
    }
    prefix = f"organizations/{ORG_ID}/datasets/{ASSET_DATASET_ID}"
    source = (
        DOCUMENT_OBJECT_ID,
        ASSET_DATASET_ID,
        ASSET_VERSION_ID,
        "opengeo-test-geodata",
        prefix + ("/source.pdf" if kind == "file" else "/document/accessible-preview.json"),
        "source-exact-1",
        "application/pdf" if kind == "file" else "application/json",
        2048,
        "c" * 64,
        "original" if kind == "file" else "derived",
        "public",
        "active",
        "active",
        scan,
        "pdf",
        "document",
        {"document": document},
    )
    companion = (
        PRINT_DOCUMENT_OBJECT_ID,
        ASSET_DATASET_ID,
        ASSET_VERSION_ID,
        "opengeo-test-geodata",
        prefix + "/document/print-vector.pdf",
        "prepared-exact-1",
        "application/pdf",
        1024,
        "e" * 64,
        "derived",
        "public",
        "active",
        "active",
        scan,
        "pdf",
        "document",
        {"document": document},
    )
    return source, companion


def odt_print_asset_rows() -> tuple[tuple[Any, ...], tuple[Any, ...]]:
    source, companion = pdf_print_asset_rows("document")
    pdf_document = source[16]["document"]
    document = {
        "kind": "odf_text",
        "source_format": "odt",
        "page_count": 7,
        "accessible_preview_schema": "opengeo.document-preview.1.0.0",
        "print_vector_available": True,
        "print_vector_schema": pdf_document["print_vector_schema"],
        "print_vector_facts": pdf_document["print_vector_facts"],
        "print_conversion": {
            "renderer": "libreoffice-writer-pdf",
            "version": "LibreOffice 7.4.7.2 40(Build:2)",
            "export_filter": "writer_pdf_Export",
            "network": "seccomp-denied",
            "fonts": "system-fonts-substitution-possible",
        },
    }
    rows = []
    for row in (source, companion):
        updated = list(row)
        updated[14] = "odt"
        updated[16] = {"document": document}
        rows.append(tuple(updated))
    return rows[0], rows[1]


@pytest.mark.parametrize(
    ("source_format", "kind"), [("pdf", "file"), ("pdf", "document"), ("odt", "document")]
)
def test_document_asset_binds_prepared_pages_and_reads_only_exact_manifest(
    source_format: str,
    kind: Literal["file", "document"],
) -> None:
    source, companion = (
        odt_print_asset_rows() if source_format == "odt" else pdf_print_asset_rows(kind)
    )
    transaction = ScriptedTransaction(all_rows=[[source, companion]])
    assets = asyncio.run(
        PostgresSitePublicationRepository._seal_site_assets(
            transaction,
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            (SiteAssetDraft(kind, ASSET_DATASET_ID, ASSET_VERSION_ID, DOCUMENT_OBJECT_ID),),
        )
    )
    assert len(assets) == 1
    bound = assets[0]
    assert bound.object_id == DOCUMENT_OBJECT_ID
    assert bound.print_document is not None
    assert bound.print_document.object_id == PRINT_DOCUMENT_OBJECT_ID
    assert bound.print_document.storage_version_id == "prepared-exact-1"
    if source_format == "odt":
        assert source[16]["document"]["page_count"] == 7
        assert source[16]["document"]["print_vector_facts"]["page_count"] == 1
    site_transaction = ScriptedTransaction(
        one=[site_row("review")], all_rows=[[document_page_row()]]
    )
    site = asyncio.run(
        repository(site_transaction)._load_site_version(
            site_transaction,
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            SITE_ID,
            SITE_VERSION_ID,
        )
    )
    assert site.publication_destination is not None
    manifest = PostgresSitePublicationRepository._manifest(
        TenantContext(USER_ID, ORG_ID),
        site,
        EDITION_ID,
        1,
        NOW,
        (),
        assets,
        site.publication_destination,
        None,
    )
    raw = manifest["assets"][0]
    assert raw["objectId"] == str(DOCUMENT_OBJECT_ID)
    assert raw["printDocument"]["objectId"] == str(PRINT_DOCUMENT_OBJECT_ID)
    read = ScriptedTransaction(all_rows=[[source, companion]])
    loaded = asyncio.run(
        PostgresSitePublicationRepository._load_manifest_assets(
            read,
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            {"assets": [raw]},
        )
    )
    assert loaded == assets
    assert set(read.fetches[0][1][2]) == {DOCUMENT_OBJECT_ID, PRINT_DOCUMENT_OBJECT_ID}
    assert "print-vector.pdf" not in read.fetches[0][0]
    legacy = ScriptedTransaction(all_rows=[[source]])
    raw.pop("printDocument")
    old = asyncio.run(
        PostgresSitePublicationRepository._load_manifest_assets(
            legacy,
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            {"assets": [raw]},
        )
    )
    assert old[0].print_document is None
    assert legacy.fetches[0][1][2] == [DOCUMENT_OBJECT_ID]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("renderer", "unverified-converter"),
        ("version", ""),
        ("version", " "),
        ("version", "LibreOffice\n7.4.7"),
        ("version", "L" * 121),
        ("version", 747),
        ("export_filter", "other-filter"),
        ("network", "allowed"),
        ("fonts", "all-fonts-exact"),
        (None, None),
        (None, []),
    ],
)
def test_odt_prepared_binding_requires_bounded_conversion_provenance(
    field: str | None, value: object
) -> None:
    source, companion = odt_print_asset_rows()
    document = source[16]["document"]
    if field is None:
        document["print_conversion"] = value
    else:
        document["print_conversion"][field] = value
    transaction = ScriptedTransaction(all_rows=[[source, companion]])
    with pytest.raises(SiteConflict, match="site_print_document_invalid"):
        asyncio.run(
            PostgresSitePublicationRepository._seal_site_assets(
                transaction,
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                (
                    SiteAssetDraft(
                        "document", ASSET_DATASET_ID, ASSET_VERSION_ID, DOCUMENT_OBJECT_ID
                    ),
                ),
            )
        )


@pytest.mark.parametrize("kind", ["file", "document"])
def test_odt_original_file_cannot_supply_a_public_print_binding(
    kind: Literal["file", "document"],
) -> None:
    source, companion = odt_print_asset_rows()
    original = list(source)
    original[4] = original[4].replace("/document/accessible-preview.json", "/source.odt")
    original[6] = "application/vnd.oasis.opendocument.text"
    original[9] = "original"
    transaction = ScriptedTransaction(all_rows=[[tuple(original), companion]])
    with pytest.raises(SiteConflict, match="site_asset_invalid"):
        asyncio.run(
            PostgresSitePublicationRepository._seal_site_assets(
                transaction,
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                (SiteAssetDraft(kind, ASSET_DATASET_ID, ASSET_VERSION_ID, DOCUMENT_OBJECT_ID),),
            )
        )


@pytest.mark.parametrize("field", ["kind", "source_format"])
def test_pdf_prepared_binding_rejects_odt_metadata_on_a_pdf_file(field: str) -> None:
    source, companion = pdf_print_asset_rows()
    source[16]["document"][field] = "odf_text" if field == "kind" else "odt"
    transaction = ScriptedTransaction(all_rows=[[source, companion]])
    with pytest.raises(SiteConflict, match="site_print_document_invalid"):
        asyncio.run(
            PostgresSitePublicationRepository._seal_site_assets(
                transaction,
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                (SiteAssetDraft("file", ASSET_DATASET_ID, ASSET_VERSION_ID, DOCUMENT_OBJECT_ID),),
            )
        )


def test_pdf_prepared_binding_still_requires_matching_source_pagination() -> None:
    source, companion = pdf_print_asset_rows()
    source[16]["document"]["page_count"] = 7
    transaction = ScriptedTransaction(all_rows=[[source, companion]])
    with pytest.raises(SiteConflict, match="site_print_document_invalid"):
        asyncio.run(
            PostgresSitePublicationRepository._seal_site_assets(
                transaction,
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                (SiteAssetDraft("file", ASSET_DATASET_ID, ASSET_VERSION_ID, DOCUMENT_OBJECT_ID),),
            )
        )


@pytest.mark.parametrize("source_format", ["pdf", "odt"])
@pytest.mark.parametrize(
    "changed", ["foreign_dataset", "foreign_version", "unscanned", "wrong_role"]
)
def test_document_prepared_binding_rejects_invalid_or_foreign_sibling(
    source_format: str, changed: str
) -> None:
    source, companion = odt_print_asset_rows() if source_format == "odt" else pdf_print_asset_rows()
    kind: Literal["file", "document"] = "document" if source_format == "odt" else "file"
    invalid = list(companion)
    if changed == "foreign_dataset":
        invalid[1] = UUID(int=99)
    elif changed == "foreign_version":
        invalid[2] = UUID(int=99)
    elif changed == "unscanned":
        invalid[13] = {}
    else:
        invalid[9] = "original"
    transaction = ScriptedTransaction(all_rows=[[source, tuple(invalid)]])
    with pytest.raises(SiteConflict):
        asyncio.run(
            PostgresSitePublicationRepository._seal_site_assets(
                transaction,
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                (SiteAssetDraft(kind, ASSET_DATASET_ID, ASSET_VERSION_ID, DOCUMENT_OBJECT_ID),),
            )
        )


@pytest.mark.parametrize("source_format", ["pdf", "odt"])
@pytest.mark.parametrize("changed", ["checksum", "version", "recursive", "foreign_version"])
def test_document_prepared_manifest_rejects_drift_and_recursive_or_foreign_binding(
    source_format: str, changed: str
) -> None:
    source, companion = odt_print_asset_rows() if source_format == "odt" else pdf_print_asset_rows()
    kind: Literal["file", "document"] = "document" if source_format == "odt" else "file"
    asset = PostgresSitePublicationRepository._asset_from_row(
        kind,
        source,
        source[13],
        dataset_format=source[14],
        geometry_type=source[15],
        schema_definition=source[16],
    )
    prepared = PostgresSitePublicationRepository._asset_from_row("file", companion, companion[13])
    raw = PostgresSitePublicationRepository._asset_manifest(asset)
    nested = PostgresSitePublicationRepository._asset_manifest(prepared)
    raw["printDocument"] = nested
    if changed == "checksum":
        nested["checksumSha256"] = "f" * 64
    elif changed == "version":
        nested["storageVersionId"] = "another-version"
    elif changed == "recursive":
        nested["printDocument"] = dict(nested)
    else:
        companion = tuple(
            UUID(int=99) if index == 2 else value for index, value in enumerate(companion)
        )
        nested["datasetVersionId"] = str(UUID(int=99))
    transaction = ScriptedTransaction(all_rows=[[source, companion]])
    with pytest.raises(SiteNotFound):
        asyncio.run(
            PostgresSitePublicationRepository._load_manifest_assets(
                transaction,
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                {"assets": [raw]},
            )
        )


def test_odt_prepared_manifest_revalidates_conversion_provenance() -> None:
    source, companion = odt_print_asset_rows()
    asset = PostgresSitePublicationRepository._asset_from_row(
        "document",
        source,
        source[13],
        dataset_format=source[14],
        geometry_type=source[15],
        schema_definition=source[16],
    )
    prepared = PostgresSitePublicationRepository._asset_from_row("file", companion, companion[13])
    raw = PostgresSitePublicationRepository._asset_manifest(asset)
    raw["printDocument"] = PostgresSitePublicationRepository._asset_manifest(prepared)
    source[16]["document"]["print_conversion"]["network"] = "allowed"
    transaction = ScriptedTransaction(all_rows=[[source, companion]])
    with pytest.raises(SiteNotFound):
        asyncio.run(
            PostgresSitePublicationRepository._load_manifest_assets(
                transaction,
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                {"assets": [raw]},
            )
        )
