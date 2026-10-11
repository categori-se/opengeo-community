import asyncio
import base64
import json
from collections import deque
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Any
from uuid import UUID

import pytest

from opengeo_api.catalog import (
    CatalogAccessDenied,
    CatalogConflict,
    CatalogNotFound,
    PermissionGrant,
    PostgresCatalogRepository,
)
from opengeo_api.document_previews import document_visual_page
from opengeo_api.s3_downloads import DownloadTicket, ExactObject
from opengeo_api.tenant_database import TenantContext

ORG_ID = UUID("10000000-0000-4000-8000-000000000001")
USER_ID = UUID("20000000-0000-4000-8000-000000000001")
MEMBER_ID = UUID("20000000-0000-4000-8000-000000000002")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000001")
DATASET_ID = UUID("80000000-0000-4000-8000-000000000001")
VERSION_ID = UUID("83000000-0000-4000-8000-000000000001")
OBJECT_ID = UUID("82000000-0000-4000-8000-000000000001")
NOW = datetime(2026, 8, 20, 12, tzinfo=UTC)


class FakeTransaction:
    def __init__(self, *, one=None, all_rows=None, execute_results=None) -> None:
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
    def __init__(self, transactions) -> None:
        self.transactions = deque(transactions)
        self.contexts = []

    async def run(self, context, operation):
        self.contexts.append(context)
        return await operation(self.transactions.popleft())

    async def fetch_one(self, context, statement, parameters=()):
        del context, statement, parameters
        raise AssertionError("direct fetch not expected")


class FakeStorage:
    def __init__(self, exact_body: bytes | None = None) -> None:
        self.specs = []
        self.exact_body = exact_body

    async def create_download_url(self, spec):
        self.specs.append(spec)
        return DownloadTicket(
            "https://geodata-test.s3.us-east-1.amazonaws.com/exact?signed=true",
            "GET",
            NOW + timedelta(minutes=5),
        )

    async def read_exact_object(self, spec):
        self.specs.append(spec)
        assert self.exact_body is not None
        return ExactObject(
            body=self.exact_body,
            content_type=spec.content_type,
            size_bytes=len(self.exact_body),
            checksum_sha256=sha256(self.exact_body).hexdigest(),
            version_id=spec.version_id,
        )


def context() -> TenantContext:
    return TenantContext(USER_ID, ORG_ID)


def access(project_role="viewer", dataset_role=None, owner=False):
    return ("member", project_role, dataset_role, owner)


def target_row():
    return (
        "geodata-test",
        "organizations/o/projects/p/datasets/d/versions/v/derivatives/roads.parquet",
        "s3-version-1",
        "roads.parquet",
    )


def preview_document():
    return {
        "schemaVersion": "opengeo.document-preview.1.0.0",
        "sourceFormat": "odt",
        "odfVersion": "1.4",
        "title": "नेपाल field report",
        "language": "ne",
        "pages": [
            {
                "number": 1,
                "blocks": [
                    {"type": "heading", "level": 1, "text": "Findings"},
                    {"type": "paragraph", "text": "Exact semantic text."},
                    {"type": "list", "ordered": False, "items": ["One", "Two"]},
                    {
                        "type": "table",
                        "label": "Results",
                        "headerRows": 1,
                        "rows": [["Place", "Count"], ["Kathmandu", "7"]],
                    },
                ],
            }
        ],
    }


def preview_bytes() -> bytes:
    return (json.dumps(preview_document(), separators=(",", ":")) + "\n").encode()


def pdf_preview_document() -> dict[str, Any]:
    return {
        "schemaVersion": "opengeo.document-preview.2.0.0",
        "sourceFormat": "pdf",
        "pdfVersion": "1.7",
        "title": "Investigation report",
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
                "blocks": [{"type": "paragraph", "text": "All-page semantic text."}],
            },
            {"number": 2, "blocks": []},
        ],
    }


def pdf_ocr_preview_document() -> dict[str, Any]:
    return {
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
            {
                "number": 2,
                "textSource": "ocr",
                "blocks": [{"type": "paragraph", "text": "نص ممسوح ضوئياً"}],
            },
        ],
    }


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


def pdf_visual_presentation() -> dict[str, Any]:
    image = visual_jpeg()
    document = pdf_preview_document()
    document["schemaVersion"] = "opengeo.pdf-visual-presentation.1.0.0"
    document["rendering"] = {
        "engine": "poppler-pdftoppm",
        "mediaType": "image/jpeg",
        "annotationsHidden": True,
        "colorSpace": "rgb",
        "pageCount": 2,
        "targetMaximumDimension": 1000,
        "totalPixels": 12,
        "totalImageBytes": len(image) * 2,
    }
    for page in document["pages"]:
        page.update(
            width=2,
            height=3,
            imageBase64=base64.b64encode(image).decode("ascii"),
            imageSha256=sha256(image).hexdigest(),
        )
    return document


def pdf_ocr_visual_presentation() -> dict[str, Any]:
    image = visual_jpeg()
    document = pdf_ocr_preview_document()
    document["schemaVersion"] = "opengeo.pdf-visual-presentation.2.0.0"
    document["rendering"] = {
        "engine": "poppler-pdftoppm",
        "mediaType": "image/jpeg",
        "annotationsHidden": True,
        "colorSpace": "rgb",
        "pageCount": 2,
        "targetMaximumDimension": 1000,
        "totalPixels": 12,
        "totalImageBytes": len(image) * 2,
    }
    for page in document["pages"]:
        page.update(
            width=2,
            height=3,
            imageBase64=base64.b64encode(image).decode("ascii"),
            imageSha256=sha256(image).hexdigest(),
        )
    return document


def preview_target_row():
    content = preview_bytes()
    return (
        OBJECT_ID,
        "geodata-test",
        "organizations/o/projects/p/datasets/d/versions/v/document/accessible-preview.json",
        "s3-version-preview",
        "application/json",
        len(content),
        sha256(content).hexdigest(),
    )


def spatial_preview_document():
    return {
        "type": "FeatureCollection",
        "name": "Validated roads preview",
        "bbox": [-71.2, 42.2, -71.0, 42.4],
        "features": [
            {
                "type": "Feature",
                "id": 17,
                "properties": {"name": "Bounded road"},
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[-71.2, 42.2], [-71.0, 42.4]],
                },
            }
        ],
    }


def spatial_preview_bytes() -> bytes:
    return (json.dumps(spatial_preview_document(), separators=(",", ":")) + "\n").encode()


def spatial_preview_target_row():
    content = spatial_preview_bytes()
    return (
        OBJECT_ID,
        "geodata-test",
        "organizations/o/projects/p/datasets/d/versions/v/preview/preview.geojson",
        "s3-version-spatial-preview",
        "application/geo+json",
        len(content),
        sha256(content).hexdigest(),
        4,
    )


def version_row():
    return (
        VERSION_ID,
        1,
        None,
        "active",
        "Initial import",
        4,
        [-1, -2, 3, 4],
        "EPSG:4326",
        "LineString",
        {"fields": []},
        {"valid": True},
        USER_ID,
        NOW,
        True,
        OBJECT_ID,
        "derived",
        "roads.parquet",
        "application/vnd.apache.parquet",
        123,
        "a" * 64,
        NOW,
    )


def test_version_history_returns_safe_logical_versions_and_objects() -> None:
    transaction = FakeTransaction(one=[access()], all_rows=[[version_row()]])
    repository = PostgresCatalogRepository(FakeExecutor([transaction]), FakeStorage())

    versions = asyncio.run(repository.list_versions(context(), PROJECT_ID, DATASET_ID, 50, 0))

    assert versions[0].version_number == 1
    assert versions[0].current is True
    assert versions[0].objects[0].filename == "roads.parquet"
    query = next(call for call in transaction.calls if call[0] == "all")
    assert "dataset_version_objects" in query[1]
    assert "object.bucket" not in query[1]


def test_version_lineage_returns_safe_authorized_origins_and_derivatives() -> None:
    snapshot_job_id = UUID("84000000-0000-4000-8000-000000000001")
    source_dataset_id = UUID("85000000-0000-4000-8000-000000000001")
    derivative_job_id = UUID("86000000-0000-4000-8000-000000000001")
    output_object_id = UUID("87000000-0000-4000-8000-000000000001")
    transaction = FakeTransaction(
        one=[access(), (2,)],
        all_rows=[
            [
                [
                    "external_source_archive",
                    snapshot_job_id,
                    source_dataset_id,
                    "Reviewed MassGIS source",
                    4,
                    OBJECT_ID,
                    NOW,
                ]
            ],
            [
                [
                    derivative_job_id,
                    "gdal-pmtiles-v1",
                    OBJECT_ID,
                    output_object_id,
                    [-73.6, 41.2, -69.8, 42.9],
                    4,
                    14,
                    "massenviroscreen",
                    "b" * 64,
                    NOW,
                ]
            ],
        ],
    )
    repository = PostgresCatalogRepository(FakeExecutor([transaction]), FakeStorage())

    lineage = asyncio.run(
        repository.get_version_lineage(context(), PROJECT_ID, DATASET_ID, VERSION_ID)
    )

    assert lineage.version_number == 2
    assert lineage.origins[0].source_dataset_name == "Reviewed MassGIS source"
    assert lineage.origins[0].source_revision_number == 4
    assert lineage.derivatives[0].output_object_id == output_object_id
    assert lineage.derivatives[0].bounds == (-73.6, 41.2, -69.8, 42.9)
    assert lineage.derivatives_truncated is False
    queries = "\n".join(call[1] for call in transaction.calls)
    assert "dataset_version_external_source_lineage" in queries
    assert "dataset_version_repository_object_lineage" in queries
    assert "upload_intents" in queries
    assert "dataset_version_derivative_lineage" in queries
    for coordinate in ("bucket", "object_key", "s3_version"):
        assert coordinate not in queries


def test_version_lineage_rejects_a_missing_exact_version_before_lineage_reads() -> None:
    transaction = FakeTransaction(one=[access(), None])
    repository = PostgresCatalogRepository(FakeExecutor([transaction]), FakeStorage())

    with pytest.raises(CatalogNotFound):
        asyncio.run(repository.get_version_lineage(context(), PROJECT_ID, DATASET_ID, VERSION_ID))

    assert [call[0] for call in transaction.calls] == ["one", "one"]


def test_viewer_cannot_download_but_explicit_download_grant_can() -> None:
    denied_storage = FakeStorage()
    denied = PostgresCatalogRepository(
        FakeExecutor([FakeTransaction(one=[access("viewer")])]), denied_storage
    )
    with pytest.raises(CatalogAccessDenied):
        asyncio.run(
            denied.request_download(
                context(), PROJECT_ID, DATASET_ID, VERSION_ID, OBJECT_ID, "denied"
            )
        )
    assert denied_storage.specs == []

    prepare = FakeTransaction(one=[access(None, "download"), target_row()])
    attribute = FakeTransaction(one=[access(None, "download"), target_row()])
    storage = FakeStorage()
    repository = PostgresCatalogRepository(FakeExecutor([prepare, attribute]), storage)
    ticket = asyncio.run(
        repository.request_download(
            context(), PROJECT_ID, DATASET_ID, VERSION_ID, OBJECT_ID, "request-download"
        )
    )
    assert ticket.method == "GET"
    assert storage.specs[0].version_id == "s3-version-1"
    event = next(call for call in attribute.calls if "activity_events" in call[1])
    assert event[2][3] == "dataset.download.issued"
    assert "object_key" not in str(event[2][-1])


def test_authorized_document_preview_is_exactly_read_reauthorized_and_strictly_parsed() -> None:
    prepare = FakeTransaction(one=[access("viewer")], all_rows=[[preview_target_row()]])
    reauthorize = FakeTransaction(one=[access("viewer")], all_rows=[[preview_target_row()]])
    storage = FakeStorage(preview_bytes())
    repository = PostgresCatalogRepository(FakeExecutor([prepare, reauthorize]), storage)

    preview = asyncio.run(
        repository.get_document_preview(context(), PROJECT_ID, DATASET_ID, VERSION_ID)
    )

    assert preview == preview_document()
    assert storage.specs[0].maximum_bytes == 512 * 1024
    assert storage.specs[0].version_id == "s3-version-preview"
    assert sum("dataset.format::text IN ('odt', 'pdf')" in call[1] for call in prepare.calls) == 1
    assert len(reauthorize.calls) == 2


def test_authorized_spatial_preview_reads_one_exact_validated_derivative() -> None:
    prepare = FakeTransaction(one=[access("viewer")], all_rows=[[spatial_preview_target_row()]])
    reauthorize = FakeTransaction(one=[access("viewer")], all_rows=[[spatial_preview_target_row()]])
    storage = FakeStorage(spatial_preview_bytes())
    repository = PostgresCatalogRepository(FakeExecutor([prepare, reauthorize]), storage)

    preview = asyncio.run(
        repository.get_spatial_preview(context(), PROJECT_ID, DATASET_ID, VERSION_ID)
    )

    assert preview == {
        "schema_version": "opengeo.spatial-preview.1.0.0",
        "dataset_version_id": str(VERSION_ID),
        "number_returned": 1,
        "number_matched": 4,
        "may_be_truncated": True,
        "geojson": spatial_preview_document(),
    }
    assert storage.specs[0].maximum_bytes == 4 * 1024 * 1024
    assert storage.specs[0].version_id == "s3-version-spatial-preview"
    query = next(call for call in prepare.calls if call[0] == "all")
    assert "version.state = 'active'" in query[1]
    assert "object.role = 'derived'" in query[1]
    assert "preview/preview.geojson" in query[1]
    assert len(reauthorize.calls) == 2


def test_spatial_preview_parser_rejects_unclosed_or_out_of_range_geometry() -> None:
    for document in (
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {},
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[[-71, 42], [-70, 42], [-70, 43], [-71, 43]]],
                    },
                }
            ],
        },
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {},
                    "geometry": {"type": "Point", "coordinates": [181, 42]},
                }
            ],
        },
    ):
        with pytest.raises(CatalogConflict, match="spatial_preview_invalid"):
            PostgresCatalogRepository._parse_spatial_preview(json.dumps(document).encode())


def test_pdf_preview_parser_accepts_all_pages_and_rejects_forged_extraction_facts() -> None:
    document = pdf_preview_document()

    parsed = PostgresCatalogRepository._parse_document_preview(
        (json.dumps(document, separators=(",", ":")) + "\n").encode()
    )

    assert parsed == document
    document["extraction"]["textAvailable"] = False
    with pytest.raises(CatalogConflict, match="document_preview_invalid"):
        PostgresCatalogRepository._parse_document_preview(json.dumps(document).encode())


def test_pdf_ocr_preview_parser_seals_bounded_page_provenance() -> None:
    document = pdf_ocr_preview_document()

    parsed = PostgresCatalogRepository._parse_document_preview(json.dumps(document).encode())

    assert parsed == document
    for changed in (
        {**document["extraction"], "ocrPageLimit": 33},
        {**document["extraction"], "ocrPages": [1]},
        {**document["extraction"], "ocrTruncated": True},
        {**document["extraction"], "ocrModel": "../../attacker"},
    ):
        forged = {**document, "extraction": changed}
        with pytest.raises(CatalogConflict, match="document_preview_invalid"):
            PostgresCatalogRepository._parse_document_preview(json.dumps(forged).encode())


def test_pdf_ocr_visual_presentation_parser_seals_page_source_and_image() -> None:
    document = pdf_ocr_visual_presentation()

    parsed = PostgresCatalogRepository._parse_document_preview(json.dumps(document).encode())

    image, digest = document_visual_page(parsed, 2)
    assert image == visual_jpeg()
    assert digest == sha256(image).hexdigest()
    document["pages"][1]["textSource"] = "none"
    with pytest.raises(CatalogConflict, match="document_preview_invalid"):
        PostgresCatalogRepository._parse_document_preview(json.dumps(document).encode())


def test_pdf_visual_presentation_parser_seals_every_image_and_total() -> None:
    document = pdf_visual_presentation()

    parsed = PostgresCatalogRepository._parse_document_preview(
        (json.dumps(document, separators=(",", ":")) + "\n").encode()
    )

    image, digest = document_visual_page(parsed, 2)
    assert image == visual_jpeg()
    assert digest == sha256(image).hexdigest()
    document["pages"][1]["imageSha256"] = "0" * 64
    with pytest.raises(CatalogConflict, match="document_preview_invalid"):
        PostgresCatalogRepository._parse_document_preview(json.dumps(document).encode())

    document = pdf_visual_presentation()
    document["rendering"]["totalPixels"] = 13
    with pytest.raises(CatalogConflict, match="document_preview_invalid"):
        PostgresCatalogRepository._parse_document_preview(json.dumps(document).encode())


@pytest.mark.parametrize(
    "change",
    [
        lambda value: value.update(schemaVersion="attacker"),
        lambda value: value["pages"].append({"number": 1, "blocks": []}),
        lambda value: value["pages"][0]["blocks"][0].update(level=11),
        lambda value: value["pages"][0]["blocks"][3].update(headerRows=3),
        lambda value: value["pages"][0]["blocks"][3]["rows"][1].append("widened"),
    ],
)
def test_document_preview_parser_rejects_widened_or_inconsistent_documents(change) -> None:
    document = preview_document()
    change(document)
    content = json.dumps(document).encode()

    with pytest.raises(CatalogConflict, match="document_preview_invalid"):
        PostgresCatalogRepository._parse_document_preview(content)


def test_dataset_owner_can_upsert_a_tenant_member_grant_with_activity() -> None:
    transaction = FakeTransaction(
        one=[
            access("editor", None, True),
            (MEMBER_ID, "member@example.test", "Member"),
            ("view", USER_ID, NOW, NOW),
        ]
    )
    repository = PostgresCatalogRepository(FakeExecutor([transaction]), FakeStorage())

    result = asyncio.run(
        repository.put_permission(
            context(),
            PROJECT_ID,
            DATASET_ID,
            PermissionGrant(MEMBER_ID, "view"),
            "request-grant",
        )
    )

    assert result.user_id == MEMBER_ID
    assert result.role == "view"
    statements = [call[1] for call in transaction.calls]
    assert any("ON CONFLICT" in statement for statement in statements)
    assert any("dataset.permission.granted" in str(call[2]) for call in transaction.calls)
