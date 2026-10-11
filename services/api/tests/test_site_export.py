import base64
import json
from dataclasses import replace
from datetime import UTC, datetime
from hashlib import sha256
from io import BytesIO
from uuid import UUID
from zipfile import ZipFile

import pytest

from opengeo_api.site_export import _render_map, build_static_package, render_page_html
from opengeo_api.site_publications import (
    ProjectSite,
    PublishedMapSnapshot,
    PublishedResourceReference,
    PublishedSite,
    PublishedSiteAsset,
    SiteEdition,
    SitePage,
)

ORG_ID = UUID("10000000-0000-4000-8000-000000000261")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000261")
USER_ID = UUID("20000000-0000-4000-8000-000000000261")
SITE_ID = UUID("b0000000-0000-4000-8000-000000000261")
SITE_VERSION_ID = UUID("b1000000-0000-4000-8000-000000000261")
PAGE_ID = UUID("b2000000-0000-4000-8000-000000000261")
PAGE_RESOURCE_ID = UUID("a0000000-0000-4000-8000-000000000261")
PAGE_RESOURCE_VERSION_ID = UUID("a1000000-0000-4000-8000-000000000261")
MAP_RESOURCE_ID = UUID("a0000000-0000-4000-8000-000000000262")
MAP_RESOURCE_VERSION_ID = UUID("a1000000-0000-4000-8000-000000000262")
EDITION_ID = UUID("b4000000-0000-4000-8000-000000000261")
WMS_SERVICE_ID = UUID("c0000000-0000-4000-8000-000000000261")
IMAGE_OBJECT_ID = UUID("82000000-0000-4000-8000-000000000261")
FILE_OBJECT_ID = UUID("83000000-0000-4000-8000-000000000261")
DOCUMENT_OBJECT_ID = UUID("84000000-0000-4000-8000-000000000261")
ASSET_DATASET_ID = UUID("80000000-0000-4000-8000-000000000261")
ASSET_VERSION_ID = UUID("81000000-0000-4000-8000-000000000261")
NOW = datetime(2026, 8, 20, 20, tzinfo=UTC)


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


def published_site() -> PublishedSite:
    page = SitePage(
        page_id=PAGE_ID,
        slug="findings",
        navigation_label="Findings",
        position=0,
        is_home=True,
        resource_id=PAGE_RESOURCE_ID,
        resource_version_id=PAGE_RESOURCE_VERSION_ID,
        resource_version_number=3,
        resource_kind="story",
        resource_title="Findings <script>alert(1)</script>",
        resource_abstract="A field report.",
        resource_language="en",
        resource_license="CC-BY-4.0",
        resource_attribution="Research desk",
        resource_content={
            "blocks": [
                {
                    "id": "intro",
                    "type": "markdown",
                    "markdown": (
                        "# Verified finding\n\n<script>alert('no')</script>\n\n- One\n- Two"
                    ),
                },
                {
                    "id": "map",
                    "type": "map",
                    "resource_id": str(MAP_RESOURCE_ID),
                    "caption": "Survey coverage",
                },
                {
                    "id": "cite",
                    "type": "citation",
                    "title": "Source record",
                    "doi": "10.1234/example",
                },
                {
                    "id": "survey-table",
                    "type": "table",
                    "caption": "Survey results",
                    "columns": ["District", "Households", "Coverage"],
                    "rows": [["East <script>", 120, 0.75], ["West", 80, 0.5]],
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
                    "id": "findings-heading",
                    "type": "heading",
                    "level": 2,
                    "text": "Detailed findings",
                },
                {
                    "id": "critical-context",
                    "type": "callout",
                    "tone": "warning",
                    "title": "Critical context",
                    "markdown": "Confirm <script>unsafe</script> against the [source](https://evidence.example.test/source).",
                },
                {
                    "id": "page-navigation",
                    "type": "navigation",
                    "label": "On this page",
                    "heading_block_ids": ["findings-heading"],
                },
                {
                    "id": "legacy-link",
                    "type": "link",
                    "url": "javascript:alert(1)",
                    "label": "Legacy unsafe link",
                },
            ]
        },
        resource_state="published",
        resource_visibility="public",
    )
    manifest = {
        "schemaVersion": "opengeo.site-edition.1.0.0",
        "organizationId": str(ORG_ID),
        "projectId": str(PROJECT_ID),
        "siteId": str(SITE_ID),
        "siteVersionId": str(SITE_VERSION_ID),
        "siteVersionNumber": 2,
        "editionId": str(EDITION_ID),
        "editionNumber": 1,
        "pages": [{"slug": "findings", "resourceId": str(PAGE_RESOURCE_ID)}],
        "references": [
            {
                "resourceId": str(MAP_RESOURCE_ID),
                "versionId": str(MAP_RESOURCE_VERSION_ID),
                "versionNumber": 4,
            }
        ],
    }
    edition = SiteEdition(
        edition_id=EDITION_ID,
        site_id=SITE_ID,
        site_version_id=SITE_VERSION_ID,
        site_version_number=2,
        edition_number=1,
        manifest=manifest,
        manifest_checksum_sha256=sha256(
            json.dumps(manifest, sort_keys=True).encode("utf-8")
        ).hexdigest(),
        published_by=USER_ID,
        published_at=NOW,
        revoked_by=None,
        revoked_at=None,
    )
    site = ProjectSite(
        site_id=SITE_ID,
        project_id=PROJECT_ID,
        slug="investigation",
        version_id=SITE_VERSION_ID,
        version_number=2,
        state="published",
        title="Investigation",
        description="Reporting with maps and evidence.",
        language="en",
        theme="paper",
        theme_options={},
        change_message="Ready for publication",
        created_by=USER_ID,
        created_at=NOW,
        updated_by=USER_ID,
        updated_at=NOW,
        pages=(page,),
        active_edition=edition,
    )
    reference = PublishedResourceReference(
        resource_id=MAP_RESOURCE_ID,
        version_id=MAP_RESOURCE_VERSION_ID,
        version_number=4,
        kind="map",
        title="Survey map",
        abstract="Locations visited by the reporting team.",
        attribution="Research desk",
        license="CC-BY-4.0",
        wms_service_id=WMS_SERVICE_ID,
        wms_layer_name="research:survey",
    )
    return PublishedSite(site=site, edition=edition, references=(reference,))


def test_saved_map_image_retains_each_source_attribution_without_repeating_passes() -> None:
    publication, _ = dataset_publication_with_snapshot()
    reference = publication.references[0]
    assert reference.snapshot is not None
    source = {"attribution": "<Survey team>", "license": "CC-BY-4.0"}
    reference = replace(
        reference,
        kind="map",
        wms_service_id=None,
        wms_layer_name=None,
        snapshot=replace(
            reference.snapshot,
            saved_map={
                "sources": [
                    source,
                    source,
                    {"attribution": "Conservation team", "license": "CC0-1.0"},
                ],
            },
        ),
    )
    html = _render_map(reference, None, "/public/project", "/exact-map.png")
    assert html.count("&lt;Survey team&gt; (CC-BY-4.0)") == 1
    assert "Conservation team (CC0-1.0)" in html
    assert "<Survey team>" not in html
    assert 'src="/exact-map.png"' in html


def dataset_publication_with_snapshot() -> tuple[PublishedSite, bytes]:
    publication = published_site()
    image = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEUlEQVR42mMQz25/AMIMGAwAk28LdxNeeI4AAAAASUVORK5CYII="
    )
    snapshot = PublishedMapSnapshot(
        render_job_id=UUID("d0000000-0000-4000-8000-000000000261"),
        output_object_id=IMAGE_OBJECT_ID,
        storage_version_id="sealed-png-version",
        content_type="image/png",
        size_bytes=len(image),
        checksum_sha256=sha256(image).hexdigest(),
        width=2,
        height=3,
        bbox=(-71.2, 42.2, -71.0, 42.4),
        crs="CRS:84",
    )
    reference = replace(
        publication.references[0], kind="dataset", title="Survey dataset", snapshot=snapshot
    )
    publication.site.pages[0].resource_content["blocks"] = [
        {"id": "dataset", "type": "dataset", "resource_id": str(reference.resource_id)}
    ]
    return replace(publication, references=(reference,)), image


@pytest.mark.parametrize(
    ("caption", "abstract", "alternative"),
    [
        (
            'Coverage "north" <verified>',
            "Survey extent",
            "Coverage &quot;north&quot; &lt;verified&gt;",
        ),
        (None, "Survey extent", "Survey extent"),
        (None, None, "Published dataset preview for Survey dataset"),
    ],
)
def test_dataset_block_displays_its_exact_sealed_png_in_live_and_portable_html(
    caption: str | None, abstract: str | None, alternative: str
) -> None:
    publication, image = dataset_publication_with_snapshot()
    reference = replace(publication.references[0], abstract=abstract)
    publication = replace(publication, references=(reference,))
    block = publication.site.pages[0].resource_content["blocks"][0]
    if caption is not None:
        block["caption"] = caption
    public_root = f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}"
    image_url = f"{public_root}/site-editions/{EDITION_ID}/maps/{reference.resource_id}.png"
    live = render_page_html(
        publication,
        publication.site.pages[0],
        page_urls={"findings": "/investigation"},
        css_url="/site.css",
        js_url="/site.js",
        public_project_root=public_root,
        snapshot_urls={reference.resource_id: image_url},
    ).decode()
    package = build_static_package(
        publication, public_project_root=public_root, map_images={reference.resource_id: image}
    )
    with ZipFile(BytesIO(package)) as archive:
        image_path = f"assets/maps/{reference.resource_id}.png"
        portable = archive.read("index.html").decode()
        assert archive.read(image_path) == image
        lineage = json.loads(archive.read("lineage/resources.json"))[0]
        assert lineage["resourceVersionId"] == str(reference.version_id)
        assert lineage["resourceVersionNumber"] == reference.version_number
    for document, url in ((live, image_url), (portable, image_path)):
        assert f'<img src="{url}" alt="{alternative}" width="2" height="3">' in document
        assert '<figure class="content-image dataset-preview">' in document
        assert "Dataset preview from this published edition" in document
        assert "<strong>Survey dataset</strong>" in document
        assert "License: CC-BY-4.0" in document
        assert (
            f"Resource {reference.resource_id}, immutable version {reference.version_number}"
            in document
        )
        # This reference also has a WMS service, whose default style must not replace the PNG.
        assert reference.wms_service_id is not None
        assert "data-wms-url=" not in document
        assert "data-map-zoom" not in document


@pytest.mark.parametrize("missing", ["seal", "url", "reference"])
def test_dataset_block_without_its_exact_snapshot_keeps_metadata_only(missing: str) -> None:
    publication, _image = dataset_publication_with_snapshot()
    reference = publication.references[0]
    other = replace(
        reference,
        resource_id=UUID("a0000000-0000-4000-8000-000000000263"),
        version_id=UUID("a1000000-0000-4000-8000-000000000263"),
        title="Another resource",
    )
    if missing == "seal":
        reference = replace(reference, snapshot=None)
    publication = replace(
        publication, references=(other,) if missing == "reference" else (reference, other)
    )
    urls = {other.resource_id: "/another-resource.png"}
    if missing != "url":
        urls[reference.resource_id] = "/unavailable-dataset.png"
    options = {
        "page_urls": {"findings": "/investigation"},
        "css_url": "/site.css",
        "js_url": "/site.js",
        "public_project_root": "/public/project",
    }
    document = render_page_html(
        publication, publication.site.pages[0], snapshot_urls=urls, **options
    ).decode()
    unchanged = render_page_html(publication, publication.site.pages[0], **options).decode()

    assert document == unchanged
    assert '<aside class="resource-card">' in document
    assert "<img" not in document
    assert "Another resource" not in document
    assert "/another-resource.png" not in document
    assert "/unavailable-dataset.png" not in document


@pytest.mark.parametrize("invalid", ["checksum", "seal", "reference"])
def test_dataset_png_package_retains_exact_snapshot_validation(invalid: str) -> None:
    publication, image = dataset_publication_with_snapshot()
    reference = publication.references[0]
    if invalid == "checksum":
        image = image[:-1] + bytes([image[-1] ^ 1])
    elif invalid == "seal":
        publication = replace(publication, references=(replace(reference, snapshot=None),))
    else:
        publication = replace(publication, references=())

    with pytest.raises(
        ValueError, match="checksum mismatch" if invalid == "checksum" else "unsealed"
    ):
        build_static_package(
            publication,
            public_project_root="/public/project",
            map_images={reference.resource_id: image},
        )


def test_renders_safe_mixed_content_and_progressive_wms_map() -> None:
    publication = published_site()
    document = render_page_html(
        publication,
        publication.site.pages[0],
        page_urls={"findings": "/investigation"},
        css_url="/site.css",
        js_url="/site.js",
        public_project_root="https://geo.example.test/public/organizations/o/projects/p",
    ).decode("utf-8")

    assert "<h2>Verified finding</h2>" in document
    assert "&lt;script&gt;alert(&#x27;no&#x27;)&lt;/script&gt;" in document
    assert "<script>alert" not in document
    assert (
        f'data-wms-url="https://geo.example.test/public/organizations/o/projects/p/wms/{WMS_SERVICE_ID}"'
        in document
    )
    assert 'data-layer="research:survey"' in document
    assert "linked WMS capabilities" in document
    assert "<caption>Survey results</caption>" in document
    assert '<th scope="col">District</th>' in document
    assert "East &lt;script&gt;" in document
    assert '<figure class="chart-block">' in document
    assert 'role="img" aria-label="East coverage is 75 percent' in document
    assert (
        '<h2 id="block-findings-heading" class="structural-heading">Detailed findings' in document
    )
    assert '<aside class="callout callout-warning" aria-label="Critical context">' in document
    assert "&lt;script&gt;unsafe&lt;/script&gt;" in document
    assert '<nav class="page-navigation" aria-label="On this page">' in document
    assert 'href="#block-findings-heading">Detailed findings</a>' in document
    assert "<script>" not in document
    assert "Downloaded and printed copies cannot be recalled" in document
    assert "Unsafe external link omitted" in document
    assert "javascript:" not in document


def test_renders_a_deterministic_accessible_line_chart() -> None:
    publication = published_site()
    publication.site.pages[0].resource_content["blocks"][4]["chart_type"] = "line"

    document = render_page_html(
        publication,
        publication.site.pages[0],
        page_urls={"findings": "/investigation"},
        css_url="/site.css",
        js_url="/site.js",
        public_project_root="https://geo.example.test/public/organizations/o/projects/p",
    ).decode("utf-8")

    assert '<figure class="chart-block">' in document
    assert '<polyline points="' in document
    assert 'fill="none" stroke=' in document
    assert 'role="img" aria-label="East coverage is 75 percent' in document


def test_renders_and_embeds_exact_governed_image_and_file_assets() -> None:
    publication = published_site()
    image = b"exact png bytes"
    source = b'{"type":"FeatureCollection","features":[]}'
    publication.site.pages[0].resource_content["blocks"].extend(
        [
            {
                "id": "coverage-image",
                "type": "image",
                "dataset_id": str(ASSET_DATASET_ID),
                "dataset_version_id": str(ASSET_VERSION_ID),
                "object_id": str(IMAGE_OBJECT_ID),
                "alt_text": "Survey coverage raster.",
                "caption": "Coverage <script>",
            },
            {
                "id": "source-file",
                "type": "file",
                "dataset_id": str(ASSET_DATASET_ID),
                "dataset_version_id": str(ASSET_VERSION_ID),
                "object_id": str(FILE_OBJECT_ID),
                "label": "Download exact source",
                "description": "Machine-readable evidence.",
            },
        ]
    )
    assets = (
        PublishedSiteAsset(
            kind="image",
            dataset_id=ASSET_DATASET_ID,
            dataset_version_id=ASSET_VERSION_ID,
            object_id=IMAGE_OBJECT_ID,
            bucket="opengeo-test-geodata",
            object_key="organizations/o/datasets/d/coverage.png",
            storage_version_id="asset-version-1",
            content_type="image/png",
            size_bytes=len(image),
            checksum_sha256=sha256(image).hexdigest(),
            filename="coverage.png",
        ),
        PublishedSiteAsset(
            kind="file",
            dataset_id=ASSET_DATASET_ID,
            dataset_version_id=ASSET_VERSION_ID,
            object_id=FILE_OBJECT_ID,
            bucket="opengeo-test-geodata",
            object_key="organizations/o/datasets/d/source.geojson",
            storage_version_id="asset-version-2",
            content_type="application/geo+json",
            size_bytes=len(source),
            checksum_sha256=sha256(source).hexdigest(),
            filename="source.geojson",
        ),
    )
    publication = replace(publication, assets=assets)
    live = render_page_html(
        publication,
        publication.site.pages[0],
        page_urls={"findings": "/investigation"},
        css_url="/site.css",
        js_url="/site.js",
        public_project_root="https://geo.example.test/public/organizations/o/projects/p",
        asset_urls={
            IMAGE_OBJECT_ID: f"/assets/{IMAGE_OBJECT_ID}",
            FILE_OBJECT_ID: f"/assets/{FILE_OBJECT_ID}",
        },
    ).decode("utf-8")

    assert 'alt="Survey coverage raster."' in live
    assert "Coverage &lt;script&gt;" in live
    assert f'href="/assets/{FILE_OBJECT_ID}"' in live
    package = build_static_package(
        publication,
        public_project_root="https://geo.example.test/public/organizations/o/projects/p",
        site_assets={IMAGE_OBJECT_ID: image, FILE_OBJECT_ID: source},
    )
    with ZipFile(BytesIO(package)) as archive:
        assert archive.read(f"assets/content/{IMAGE_OBJECT_ID}/coverage.png") == image
        assert archive.read(f"assets/content/{FILE_OBJECT_ID}/source.geojson") == source
        lineage = json.loads(archive.read("lineage/assets.json"))
        assert lineage[0]["checksumSha256"] == sha256(image).hexdigest()


def test_renders_and_embeds_an_exact_accessible_odt_semantic_preview() -> None:
    publication = published_site()
    preview = {
        "schemaVersion": "opengeo.document-preview.1.0.0",
        "sourceFormat": "odt",
        "odfVersion": "1.4",
        "title": "Field <report>",
        "language": "en",
        "pages": [
            {
                "number": 1,
                "blocks": [
                    {"type": "heading", "level": 1, "text": "Observed <conditions>"},
                    {"type": "paragraph", "text": "No active content is executed."},
                    {"type": "list", "ordered": True, "items": ["One", "Two"]},
                    {
                        "type": "table",
                        "label": "Counts",
                        "headerRows": 1,
                        "rows": [["District", "Count"], ["East", "12"]],
                    },
                ],
            },
            {"number": 2, "blocks": [{"type": "paragraph", "text": "Conclusion"}]},
        ],
    }
    content = (json.dumps(preview, sort_keys=True, separators=(",", ":")) + "\n").encode()
    publication.site.pages[0].resource_content["blocks"].append(
        {
            "id": "field-report-document",
            "type": "document",
            "dataset_id": str(ASSET_DATASET_ID),
            "dataset_version_id": str(ASSET_VERSION_ID),
            "object_id": str(DOCUMENT_OBJECT_ID),
            "label": "Read the field report",
        }
    )
    asset = PublishedSiteAsset(
        kind="document",
        dataset_id=ASSET_DATASET_ID,
        dataset_version_id=ASSET_VERSION_ID,
        object_id=DOCUMENT_OBJECT_ID,
        bucket="opengeo-test-geodata",
        object_key="organizations/o/datasets/d/document/accessible-preview.json",
        storage_version_id="document-preview-version-1",
        content_type="application/json",
        size_bytes=len(content),
        checksum_sha256=sha256(content).hexdigest(),
        filename="accessible-preview.json",
    )
    publication = replace(publication, assets=(asset,))

    live = render_page_html(
        publication,
        publication.site.pages[0],
        page_urls={"findings": "/investigation"},
        css_url="/site.css",
        js_url="/site.js",
        public_project_root="https://geo.example.test/public/organizations/o/projects/p",
        document_previews={DOCUMENT_OBJECT_ID: preview},
    ).decode()

    assert '<section class="document-preview"' in live
    assert "Field &lt;report&gt;" in live
    assert '<h3 data-source-heading-level="1">Observed &lt;conditions&gt;</h3>' in live
    assert '<thead><tr><th scope="col">District</th>' in live
    assert "original layout, images, tracked changes" in live
    package = build_static_package(
        publication,
        public_project_root="https://geo.example.test/public/organizations/o/projects/p",
        site_assets={DOCUMENT_OBJECT_ID: content},
    )
    with ZipFile(BytesIO(package)) as archive:
        assert (
            archive.read(f"assets/content/{DOCUMENT_OBJECT_ID}/accessible-preview.json") == content
        )
        html = archive.read("index.html").decode()
        assert "Read the field report" in html
        assert "Source document page 2" in html
        assert "No active content is executed." in html

    invalid = b'{"schemaVersion":"attacker"}'
    invalid_publication = replace(
        publication,
        assets=(
            replace(
                asset,
                size_bytes=len(invalid),
                checksum_sha256=sha256(invalid).hexdigest(),
            ),
        ),
    )
    with pytest.raises(ValueError, match="sealed document preview is invalid"):
        build_static_package(
            invalid_publication,
            public_project_root="https://geo.example.test/public/organizations/o/projects/p",
            site_assets={DOCUMENT_OBJECT_ID: invalid},
        )


def test_renders_every_pdf_semantic_page_with_explicit_accessibility_limits() -> None:
    publication = published_site()
    preview = {
        "schemaVersion": "opengeo.document-preview.2.0.0",
        "sourceFormat": "pdf",
        "pdfVersion": "1.7",
        "title": "Investigation <report>",
        "language": "en-US",
        "extraction": {
            "engine": "poppler-pdftotext",
            "mode": "layout",
            "ocrPerformed": False,
            "readingOrder": "heuristic",
            "tagged": True,
            "textAvailable": True,
        },
        "pages": [
            {
                "number": 1,
                "blocks": [{"type": "paragraph", "text": "Escaped <PDF> page text."}],
            },
            {"number": 2, "blocks": []},
        ],
    }
    content = (json.dumps(preview, sort_keys=True, separators=(",", ":")) + "\n").encode()
    publication.site.pages[0].resource_content["blocks"].append(
        {
            "id": "investigation-pdf-document",
            "type": "document",
            "dataset_id": str(ASSET_DATASET_ID),
            "dataset_version_id": str(ASSET_VERSION_ID),
            "object_id": str(DOCUMENT_OBJECT_ID),
            "label": "Read the PDF report",
        }
    )
    asset = PublishedSiteAsset(
        kind="document",
        dataset_id=ASSET_DATASET_ID,
        dataset_version_id=ASSET_VERSION_ID,
        object_id=DOCUMENT_OBJECT_ID,
        bucket="opengeo-test-geodata",
        object_key="organizations/o/datasets/d/document/accessible-preview.json",
        storage_version_id="pdf-semantic-preview-version-1",
        content_type="application/json",
        size_bytes=len(content),
        checksum_sha256=sha256(content).hexdigest(),
        filename="accessible-preview.json",
    )
    publication = replace(publication, assets=(asset,))

    live = render_page_html(
        publication,
        publication.site.pages[0],
        page_urls={"findings": "/investigation"},
        css_url="/site.css",
        js_url="/site.js",
        public_project_root="https://geo.example.test/public/organizations/o/projects/p",
        document_previews={DOCUMENT_OBJECT_ID: preview},
    ).decode()

    assert "all-page semantic text presentation of PDF 1.7" in live
    assert "Escaped &lt;PDF&gt; page text." in live
    assert "Reading order is heuristic" not in live
    assert "reading order is heuristic" in live
    assert "OCR was not performed" in live
    package = build_static_package(
        publication,
        public_project_root="https://geo.example.test/public/organizations/o/projects/p",
        site_assets={DOCUMENT_OBJECT_ID: content},
    )
    with ZipFile(BytesIO(package)) as archive:
        html = archive.read("index.html").decode()
        assert "Source document page 2" in html
        assert "No extractable text was found on this page" in html
        assert (
            archive.read(f"assets/content/{DOCUMENT_OBJECT_ID}/accessible-preview.json") == content
        )


def test_renders_pdf_ocr_text_with_page_provenance_and_accuracy_disclosure() -> None:
    publication = published_site()
    preview = {
        "schemaVersion": "opengeo.document-preview.3.0.0",
        "sourceFormat": "pdf",
        "pdfVersion": "1.7",
        "title": "Scanned field notes",
        "language": "ar",
        "extraction": {
            "engine": "poppler-pdftotext+tesseract",
            "mode": "layout+page-ocr",
            "ocrPerformed": True,
            "ocrEngine": "tesseract",
            "ocrEngineVersion": "5.3.4",
            "ocrModel": "Arabic",
            "ocrPageLimit": 32,
            "ocrPages": [2],
            "ocrPixelLimit": 32_000_000,
            "ocrMaximumDimension": 1600,
            "ocrTotalPixels": 1_280_000,
            "ocrTruncated": False,
            "readingOrder": "heuristic",
            "tagged": False,
            "textAvailable": True,
        },
        "pages": [
            {
                "number": 1,
                "textSource": "embedded",
                "blocks": [{"type": "paragraph", "text": "Embedded cover text."}],
            },
            {"number": 2, "textSource": "ocr", "blocks": []},
        ],
    }
    content = (json.dumps(preview, sort_keys=True, separators=(",", ":")) + "\n").encode()
    publication.site.pages[0].resource_content["blocks"].append(
        {
            "id": "scanned-pdf-document",
            "type": "document",
            "dataset_id": str(ASSET_DATASET_ID),
            "dataset_version_id": str(ASSET_VERSION_ID),
            "object_id": str(DOCUMENT_OBJECT_ID),
            "label": "Read the scanned notes",
        }
    )
    asset = PublishedSiteAsset(
        kind="document",
        dataset_id=ASSET_DATASET_ID,
        dataset_version_id=ASSET_VERSION_ID,
        object_id=DOCUMENT_OBJECT_ID,
        bucket="opengeo-test-geodata",
        object_key="organizations/o/datasets/d/document/accessible-preview.json",
        storage_version_id="pdf-ocr-preview-version-1",
        content_type="application/json",
        size_bytes=len(content),
        checksum_sha256=sha256(content).hexdigest(),
        filename="accessible-preview.json",
    )
    publication = replace(publication, assets=(asset,))

    live = render_page_html(
        publication,
        publication.site.pages[0],
        page_urls={"findings": "/investigation"},
        css_url="/site.css",
        js_url="/site.js",
        public_project_root="https://geo.example.test/public/organizations/o/projects/p",
        document_previews={DOCUMENT_OBJECT_ID: preview},
    ).decode()

    assert "declared-language Tesseract OCR was attempted on 1 page(s)" in live
    assert "OCR may contain errors" in live
    assert "using Arabic" in live
    assert "OCR was attempted on this page but found no text" in live
    package = build_static_package(
        publication,
        public_project_root="https://geo.example.test/public/organizations/o/projects/p",
        site_assets={DOCUMENT_OBJECT_ID: content},
    )
    with ZipFile(BytesIO(package)) as archive:
        html = archive.read("index.html").decode()
        assert "OCR may contain errors" in html
        assert (
            archive.read(f"assets/content/{DOCUMENT_OBJECT_ID}/accessible-preview.json") == content
        )


def test_renders_and_embeds_every_bounded_pdf_visual_page_with_semantic_fallback() -> None:
    publication = published_site()
    image = visual_jpeg()
    preview = {
        "schemaVersion": "opengeo.pdf-visual-presentation.1.0.0",
        "sourceFormat": "pdf",
        "pdfVersion": "1.7",
        "title": "Visual investigation",
        "language": "en-US",
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
            "pageCount": 2,
            "targetMaximumDimension": 1000,
            "totalPixels": 12,
            "totalImageBytes": len(image) * 2,
        },
        "pages": [
            {
                "number": 1,
                "width": 2,
                "height": 3,
                "imageBase64": base64.b64encode(image).decode(),
                "imageSha256": sha256(image).hexdigest(),
                "blocks": [{"type": "paragraph", "text": "Semantic page one."}],
            },
            {
                "number": 2,
                "width": 2,
                "height": 3,
                "imageBase64": base64.b64encode(image).decode(),
                "imageSha256": sha256(image).hexdigest(),
                "blocks": [],
            },
        ],
    }
    content = (json.dumps(preview, sort_keys=True, separators=(",", ":")) + "\n").encode()
    publication.site.pages[0].resource_content["blocks"].append(
        {
            "id": "visual-pdf-document",
            "type": "document",
            "dataset_id": str(ASSET_DATASET_ID),
            "dataset_version_id": str(ASSET_VERSION_ID),
            "object_id": str(DOCUMENT_OBJECT_ID),
            "label": "View the PDF report",
        }
    )
    asset = PublishedSiteAsset(
        kind="document",
        dataset_id=ASSET_DATASET_ID,
        dataset_version_id=ASSET_VERSION_ID,
        object_id=DOCUMENT_OBJECT_ID,
        bucket="opengeo-test-geodata",
        object_key="organizations/o/datasets/d/document/visual-presentation.json",
        storage_version_id="pdf-visual-presentation-version-1",
        content_type="application/json",
        size_bytes=len(content),
        checksum_sha256=sha256(content).hexdigest(),
        filename="visual-presentation.json",
    )
    publication = replace(publication, assets=(asset,))
    live_urls = {
        1: "/edition/assets/document/pages/1.jpg",
        2: "/edition/assets/document/pages/2.jpg",
    }

    live = render_page_html(
        publication,
        publication.site.pages[0],
        page_urls={"findings": "/investigation"},
        css_url="/site.css",
        js_url="/site.js",
        public_project_root="https://geo.example.test/public/organizations/o/projects/p",
        document_previews={DOCUMENT_OBJECT_ID: preview},
        document_visual_urls={DOCUMENT_OBJECT_ID: live_urls},
    ).decode()

    assert "bounded all-page visual and semantic presentation of PDF 1.7" in live
    assert 'src="/edition/assets/document/pages/1.jpg" alt=""' in live
    assert "no text was extractable and OCR was not performed" in live
    assert "Semantic page one." in live
    package = build_static_package(
        publication,
        public_project_root="https://geo.example.test/public/organizations/o/projects/p",
        site_assets={DOCUMENT_OBJECT_ID: content},
    )
    with ZipFile(BytesIO(package)) as archive:
        first_path = f"assets/documents/{DOCUMENT_OBJECT_ID}/page-1.jpg"
        second_path = f"assets/documents/{DOCUMENT_OBJECT_ID}/page-2.jpg"
        assert archive.read(first_path) == image
        assert archive.read(second_path) == image
        html = archive.read("index.html").decode()
        assert f'src="{first_path}" alt=""' in html
        assert f'src="{second_path}" alt="Visual rendering of PDF page 2' in html
        assert f"assets/content/{DOCUMENT_OBJECT_ID}/visual-presentation.json" in archive.namelist()


def test_builds_deterministic_self_describing_static_package() -> None:
    publication = published_site()
    first = build_static_package(
        publication,
        public_project_root="https://geo.example.test/public/organizations/o/projects/p",
    )
    second = build_static_package(
        publication,
        public_project_root="https://geo.example.test/public/organizations/o/projects/p",
    )
    assert first == second

    with ZipFile(BytesIO(first)) as archive:
        names = set(archive.namelist())
        assert {
            "index.html",
            "assets/site.css",
            "assets/site.js",
            "manifest.json",
            "metadata/site.json",
            "metadata/pages.json",
            "lineage/resources.json",
            "citations/index.json",
            "external-data-manifest.json",
            "conversion-report.json",
            "print/layout.json",
            "checksums.sha256",
        } <= names
        manifest = json.loads(archive.read("manifest.json"))
        dependencies = json.loads(archive.read("external-data-manifest.json"))
        citations = json.loads(archive.read("citations/index.json"))
        assert manifest["editionId"] == str(EDITION_ID)
        assert b'data-renderer-version="opengeo-page-renderer-1.1.0"' in archive.read("index.html")
        assert dependencies["dependencies"][0]["standard"] == "OGC WMS 1.3.0"
        assert dependencies["dependencies"][0]["revocable"] is True
        assert citations[0]["doi"] == "10.1234/example"
        assert json.loads(archive.read("print/layout.json")) == {
            "schemaVersion": "opengeo.print-layout.1.1.0",
            "pages": [],
        }
        checksum_lines = archive.read("checksums.sha256").decode("utf-8").splitlines()
        assert len(checksum_lines) == len(names) - 1
        for line in checksum_lines:
            checksum, path = line.split("  ", 1)
            assert checksum == sha256(archive.read(path)).hexdigest()
        assert b"@media print" in archive.read("assets/site.css")
