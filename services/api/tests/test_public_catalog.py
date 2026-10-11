import asyncio
import base64
import hashlib
import json
from collections import deque
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest

from opengeo_api.public_catalog import (
    PUBLIC_CATALOG_MAXIMUM_FACET_SAMPLE,
    PostgresPublicCatalogRepository,
    PublicCatalogFilters,
    PublicCatalogPreviewConflict,
)
from opengeo_api.s3_downloads import ExactObject

ORGANIZATION_ID = UUID("10000000-0000-4000-8000-000000000068")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000068")
RESOURCE_ID = UUID("90000000-0000-4000-8000-000000000068")
RESOURCE_VERSION_ID = UUID("91000000-0000-4000-8000-000000000068")
DATASET_VERSION_ID = UUID("92000000-0000-4000-8000-000000000068")
OBJECT_ID = UUID("93000000-0000-4000-8000-000000000068")
DATASET_ID = UUID("9a000000-0000-4000-8000-000000000068")
MAP_ID = UUID("94000000-0000-4000-8000-000000000068")
MAP_RESOURCE_VERSION_ID = UUID("95000000-0000-4000-8000-000000000068")
SECOND_DATASET_ID = UUID("96000000-0000-4000-8000-000000000068")
SECOND_DATASET_VERSION_ID = UUID("97000000-0000-4000-8000-000000000068")
SECOND_RESOURCE_VERSION_ID = UUID("98000000-0000-4000-8000-000000000068")
SECOND_OBJECT_ID = UUID("99000000-0000-4000-8000-000000000068")
NOW = datetime(2026, 9, 1, 14, tzinfo=UTC)


def public_row() -> tuple[Any, ...]:
    return (
        RESOURCE_ID,
        ORGANIZATION_ID,
        "public-lab",
        "Public Lab",
        PROJECT_ID,
        "Community atlas",
        "dataset",
        "public-roads",
        3,
        "Public roads",
        "Reviewed road centerlines.",
        "en",
        "CC-BY-4.0",
        "Public Lab",
        ["roads", "transport"],
        [-72.0, 41.0, -70.0, 43.0],
        datetime(2026, 1, 1, tzinfo=UTC),
        None,
        "geonode",
        "public-road-source",
        "5.1.0",
        NOW,
        2,
        4,
        4.5,
        "dataset",
        NOW,
        NOW,
    )


class ScriptedTransaction:
    def __init__(self, *, one=(), all_rows=()) -> None:
        self.one = deque(one)
        self.all_rows = deque(all_rows)
        self.fetch_one_calls: list[tuple[str, tuple[Any, ...]]] = []
        self.fetch_all_calls: list[tuple[str, tuple[Any, ...]]] = []

    async def fetch_one(self, statement, parameters=()):
        self.fetch_one_calls.append((statement, tuple(parameters)))
        return self.one.popleft()

    async def fetch_all(self, statement, parameters=()):
        self.fetch_all_calls.append((statement, tuple(parameters)))
        return self.all_rows.popleft()

    async def execute(self, statement, parameters=()):
        del statement, parameters
        raise AssertionError("the public catalog is read-only")


class ScriptedExecutor:
    def __init__(self, transaction: ScriptedTransaction) -> None:
        self.transaction = transaction
        self.contexts = []

    async def run(self, context, operation):
        self.contexts.append(context)
        return await operation(self.transaction)


def spatial_preview_bytes() -> bytes:
    return json.dumps(
        {
            "type": "FeatureCollection",
            "bbox": [-72.0, 41.0, -70.0, 43.0],
            "features": [
                {
                    "type": "Feature",
                    "id": "road-1",
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [[-72.0, 41.0], [-70.0, 43.0]],
                    },
                    "properties": {"class": "primary"},
                }
            ],
        },
        separators=(",", ":"),
    ).encode()


def spatial_preview_target_row() -> tuple[Any, ...]:
    body = spatial_preview_bytes()
    return (
        RESOURCE_VERSION_ID,
        3,
        DATASET_VERSION_ID,
        OBJECT_ID,
        "opengeo-data",
        "previews/preview/preview.geojson",
        "s3-version-preview",
        "application/geo+json",
        len(body),
        hashlib.sha256(body).hexdigest(),
        4,
    )


def document_preview_row() -> tuple[Any, ...]:
    return (
        7,
        "story",
        "Community road notes",
        "A concise account of the published survey.",
        {
            "blocks": [
                {"id": "context", "type": "heading", "level": 2, "text": "Context"},
                {
                    "id": "summary",
                    "type": "markdown",
                    "markdown": "Road findings with **authored emphasis**.",
                },
                {
                    "id": "map-ref",
                    "type": "map",
                    "resource_id": "94000000-0000-4000-8000-000000000068",
                },
                {
                    "id": "file-ref",
                    "type": "file",
                    "object_id": "95000000-0000-4000-8000-000000000068",
                    "label": "Internal appendix",
                },
            ]
        },
    )


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


def pdf_semantic_presentation() -> dict[str, Any]:
    return {
        "schemaVersion": "opengeo.document-preview.2.0.0",
        "sourceFormat": "pdf",
        "pdfVersion": "1.7",
        "title": "Published field report",
        "language": "en",
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
                "blocks": [{"type": "paragraph", "text": "Reviewed findings."}],
            }
        ],
    }


def pdf_visual_presentation() -> dict[str, Any]:
    image = visual_jpeg()
    presentation = pdf_semantic_presentation()
    presentation["schemaVersion"] = "opengeo.pdf-visual-presentation.1.0.0"
    presentation["rendering"] = {
        "engine": "poppler-pdftoppm",
        "mediaType": "image/jpeg",
        "annotationsHidden": True,
        "colorSpace": "rgb",
        "pageCount": 1,
        "targetMaximumDimension": 1000,
        "totalPixels": 6,
        "totalImageBytes": len(image),
    }
    presentation["pages"][0].update(
        width=2,
        height=3,
        imageBase64=base64.b64encode(image).decode("ascii"),
        imageSha256=hashlib.sha256(image).hexdigest(),
    )
    return presentation


def dataset_document_resource_row(*, version_id: UUID = DATASET_VERSION_ID) -> tuple[Any, ...]:
    return (
        RESOURCE_VERSION_ID,
        3,
        DATASET_ID,
        {
            "datasetId": str(DATASET_ID),
            "datasetVersionId": str(version_id),
            "datasetVersionNumber": 6,
        },
        "pdf",
    )


def dataset_document_target_rows(*, changed: bool = False) -> list[tuple[Any, ...]]:
    semantic = json.dumps(pdf_semantic_presentation(), separators=(",", ":")).encode()
    visual = json.dumps(pdf_visual_presentation(), separators=(",", ":")).encode()
    return [
        (
            6,
            SECOND_OBJECT_ID,
            "opengeo-data",
            "reports/document/visual-presentation.json",
            "visual-version-changed" if changed else "visual-version-1",
            "application/json",
            len(visual),
            hashlib.sha256(visual).hexdigest(),
        ),
        (
            6,
            OBJECT_ID,
            "opengeo-data",
            "reports/document/accessible-preview.json",
            "semantic-version-1",
            "application/json",
            len(semantic),
            hashlib.sha256(semantic).hexdigest(),
        ),
    ]


def public_map_definition(*, external: bool = False) -> dict[str, Any]:
    first_layer = {
        "layerId": "roads",
        "datasetId": str(DATASET_ID),
        "datasetVersionId": str(DATASET_VERSION_ID),
        "title": "Roads",
        "sourceType": "governed-dataset",
        "sourceVersion": 3,
        "visible": True,
        "opacity": 0.8,
        "order": 0,
        "style": {"stroke": "#155e63", "strokeWidth": 2},
        "labels": {"enabled": False, "field": None},
    }
    if external:
        first_layer = {
            "layerId": "external-roads",
            "datasetId": str(DATASET_ID),
            "title": "External roads",
            "sourceType": "xyz-raster",
            "sourceVersion": 1,
            "sourceUrl": "https://tiles.example.test/{z}/{x}/{y}.png",
            "sourceConfiguration": {
                "minZoom": 0,
                "maxZoom": 18,
                "tileSize": 256,
                "scheme": "xyz",
                "attribution": "Example",
            },
            "visible": True,
            "opacity": 1,
            "order": 0,
            "style": {},
            "labels": {"enabled": False, "field": None},
        }
    layers = [first_layer]
    if not external:
        layers.append(
            {
                "layerId": "watersheds",
                "datasetId": str(SECOND_DATASET_ID),
                "datasetVersionId": str(SECOND_DATASET_VERSION_ID),
                "title": "Watersheds",
                "sourceType": "governed-dataset",
                "sourceVersion": 5,
                "visible": False,
                "opacity": 1,
                "order": 1,
                "style": {"fill": "#2563eb"},
                "labels": {"enabled": True, "field": "name"},
            }
        )
    return {
        "schemaVersion": "opengeo.map-definition.1.3.0",
        "mapViews": [],
        "basemaps": [],
        "bookmarks": [],
        "activeLayerId": layers[0]["layerId"],
        "activeProcessingModelId": None,
        "models": [],
        "processingHistory": [],
        "measurements": [],
        "projection": "mercator",
        "colorMode": "dark",
        "layers": layers,
    }


def public_map_resource_row(
    *, version: int = 4, bound_version: int | None = None
) -> tuple[Any, ...]:
    return (
        MAP_RESOURCE_VERSION_ID,
        8,
        MAP_ID,
        {"source": "studio_native_resource", "mapId": str(MAP_ID), "mapVersion": version},
        bound_version,
        MAP_ID if bound_version is not None else None,
    )


def public_map_dataset_rows(*, changed: bool = False) -> list[tuple[Any, ...]]:
    body = spatial_preview_bytes()
    checksum = hashlib.sha256(body).hexdigest()
    return [
        (
            DATASET_ID,
            RESOURCE_VERSION_ID,
            3,
            {"datasetId": str(DATASET_ID), "datasetVersionId": str(DATASET_VERSION_ID)},
            DATASET_VERSION_ID,
            3,
            4,
            OBJECT_ID,
            "opengeo-data",
            "roads/preview/preview.geojson",
            "s3-version-preview-changed" if changed else "s3-version-preview",
            "application/geo+json",
            len(body),
            checksum,
        ),
        (
            SECOND_DATASET_ID,
            SECOND_RESOURCE_VERSION_ID,
            2,
            {
                "datasetId": str(SECOND_DATASET_ID),
                "datasetVersionId": str(SECOND_DATASET_VERSION_ID),
            },
            SECOND_DATASET_VERSION_ID,
            5,
            1,
            SECOND_OBJECT_ID,
            "opengeo-data",
            "watersheds/preview/preview.geojson",
            "s3-version-watersheds",
            "application/geo+json",
            len(body),
            checksum,
        ),
    ]


class FakeStorage:
    def __init__(self) -> None:
        self.specs = []

    async def create_download_url(self, spec):
        del spec
        raise AssertionError("public previews never issue storage URLs")

    async def read_exact_object(self, spec):
        self.specs.append(spec)
        body = spatial_preview_bytes()
        return ExactObject(
            body=body,
            content_type=spec.content_type,
            size_bytes=len(body),
            checksum_sha256=hashlib.sha256(body).hexdigest(),
            version_id=spec.version_id,
        )


class DocumentStorage:
    def __init__(self) -> None:
        self.specs = []

    async def create_download_url(self, spec):
        del spec
        raise AssertionError("public previews never issue storage URLs")

    async def read_exact_object(self, spec):
        self.specs.append(spec)
        body = json.dumps(pdf_visual_presentation(), separators=(",", ":")).encode()
        return ExactObject(
            body=body,
            content_type=spec.content_type,
            size_bytes=len(body),
            checksum_sha256=hashlib.sha256(body).hexdigest(),
            version_id=spec.version_id,
        )


def test_repository_enforces_public_published_scope_and_bounded_facets() -> None:
    facet = ("dataset", PROJECT_ID, "Community atlas", "CC-BY-4.0", ["roads"], "geonode")
    facet_rows = [facet] * (PUBLIC_CATALOG_MAXIMUM_FACET_SAMPLE + 1)
    transaction = ScriptedTransaction(
        one=[(15_000,)],
        all_rows=[[public_row()], facet_rows],
    )
    executor = ScriptedExecutor(transaction)
    repository = PostgresPublicCatalogRepository(executor)
    filters = PublicCatalogFilters(
        query="road",
        kind="dataset",
        project_id=PROJECT_ID,
        keyword="roads",
        license="CC-BY-4.0",
        origin_namespace="geonode",
        bbox=(-73.0, 40.0, -69.0, 44.0),
        temporal_start=datetime(2025, 1, 1, tzinfo=UTC),
        temporal_end=datetime(2027, 1, 1, tzinfo=UTC),
        limit=24,
        offset=48,
    )

    page = asyncio.run(repository.list_public_resources(ORGANIZATION_ID, filters))

    assert executor.contexts[0].organization_id == ORGANIZATION_ID
    assert executor.contexts[0].user_id == UUID(int=0)
    assert page.number_matched == 15_000
    assert page.facet_sample_size == PUBLIC_CATALOG_MAXIMUM_FACET_SAMPLE
    assert page.facets_truncated is True
    assert page.facets["kind"][0].count == PUBLIC_CATALOG_MAXIMUM_FACET_SAMPLE
    assert page.facets["project"][0].value == str(PROJECT_ID)
    assert page.facets["keyword"][0].value == "roads"
    assert len(page.records) == 1
    record = page.records[0]
    assert record.resource_id == RESOURCE_ID
    assert record.preview_kind == "dataset"
    assert record.public_relationship_count == 2
    assert record.rating_count == 4
    assert record.rating_average == 4.5

    statements = [statement for statement, _ in transaction.fetch_one_calls]
    statements.extend(statement for statement, _ in transaction.fetch_all_calls)
    for statement in statements:
        assert "resource.state = 'published'" in statement
        assert "resource.visibility = 'public'" in statement
        assert "resource.organization_id = %s" in statement
    record_statement, record_parameters = transaction.fetch_all_calls[0]
    assert "related.state = 'published'" in record_statement
    assert "related.visibility = 'public'" in record_statement
    assert "governed_resource_rating_summaries" in record_statement
    assert "resource.kind IN ('document', 'story', 'dashboard') THEN 'document'" in record_statement
    assert record_parameters[-2:] == (24, 48)
    facet_statement, facet_parameters = transaction.fetch_all_calls[1]
    assert "ORDER BY resource.id" in facet_statement
    assert facet_parameters[-1] == PUBLIC_CATALOG_MAXIMUM_FACET_SAMPLE + 1


def test_repository_detail_uses_the_same_non_leaking_public_predicate() -> None:
    transaction = ScriptedTransaction(one=[None])
    executor = ScriptedExecutor(transaction)
    repository = PostgresPublicCatalogRepository(executor)

    result = asyncio.run(repository.get_public_resource(ORGANIZATION_ID, PROJECT_ID, RESOURCE_ID))

    assert result is None
    statement, parameters = transaction.fetch_one_calls[0]
    assert "resource.organization_id = %s" in statement
    assert "resource.project_id = %s" in statement
    assert "resource.id = %s" in statement
    assert "resource.state = 'published'" in statement
    assert "resource.visibility = 'public'" in statement
    assert parameters == (ORGANIZATION_ID, PROJECT_ID, RESOURCE_ID)


def test_public_spatial_preview_reads_one_exact_derivative_and_rechecks_public_policy() -> None:
    transaction = ScriptedTransaction(
        all_rows=[[spatial_preview_target_row()], [spatial_preview_target_row()]]
    )
    executor = ScriptedExecutor(transaction)
    storage = FakeStorage()
    repository = PostgresPublicCatalogRepository(executor, storage)

    preview = asyncio.run(
        repository.get_public_spatial_preview(ORGANIZATION_ID, PROJECT_ID, RESOURCE_ID)
    )

    assert preview is not None
    assert preview.resource_id == RESOURCE_ID
    assert preview.resource_version_number == 3
    assert preview.number_returned == 1
    assert preview.number_matched == 4
    assert preview.may_be_truncated is True
    assert preview.geojson["features"][0]["id"] == "road-1"
    assert len(executor.contexts) == 2
    assert all(context.user_id == UUID(int=0) for context in executor.contexts)
    assert storage.specs[0].version_id == "s3-version-preview"
    assert storage.specs[0].maximum_bytes == 4 * 1024 * 1024
    assert len(transaction.fetch_all_calls) == 2
    for statement, parameters in transaction.fetch_all_calls:
        assert "resource.current_version_id" in statement
        assert "dataset.current_version_id" in statement
        assert "resource.state = 'published'" in statement
        assert "resource.visibility = 'public'" in statement
        assert "object.role = 'derived'" in statement
        assert parameters[:3] == (ORGANIZATION_ID, PROJECT_ID, RESOURCE_ID)
        assert "owner_user_id" not in statement
        assert "permission" not in statement


def test_public_document_preview_renders_current_authored_content_without_dependencies() -> None:
    transaction = ScriptedTransaction(one=[document_preview_row()])
    executor = ScriptedExecutor(transaction)
    repository = PostgresPublicCatalogRepository(executor)

    preview = asyncio.run(
        repository.get_public_document_preview(ORGANIZATION_ID, PROJECT_ID, RESOURCE_ID)
    )

    assert preview is not None
    assert preview.resource_version_number == 7
    assert preview.resource_kind == "story"
    assert preview.dependency_references_omitted == 2
    assert "Community road notes" in preview.html
    assert "Road findings" in preview.html
    assert "94000000-0000-4000-8000-000000000068" not in preview.html
    assert "95000000-0000-4000-8000-000000000068" not in preview.html
    assert "script-src 'none'" in preview.html
    statement, parameters = transaction.fetch_one_calls[0]
    assert "version.id = resource.current_version_id" in statement
    assert "resource.state = 'published'" in statement
    assert "resource.visibility = 'public'" in statement
    assert "resource.kind IN ('document', 'story', 'dashboard')" in statement
    assert parameters == (ORGANIZATION_ID, PROJECT_ID, RESOURCE_ID)
    assert executor.contexts[0].user_id == UUID(int=0)


def test_public_document_preview_hides_non_document_or_non_public_identity() -> None:
    transaction = ScriptedTransaction(one=[None])
    repository = PostgresPublicCatalogRepository(ScriptedExecutor(transaction))

    preview = asyncio.run(
        repository.get_public_document_preview(ORGANIZATION_ID, PROJECT_ID, RESOURCE_ID)
    )

    assert preview is None


def test_public_dataset_document_preview_reads_exact_visual_and_rechecks_public_seal() -> None:
    resource = dataset_document_resource_row()
    targets = dataset_document_target_rows()
    transaction = ScriptedTransaction(
        one=[resource, resource],
        all_rows=[targets, targets],
    )
    executor = ScriptedExecutor(transaction)
    storage = DocumentStorage()
    repository = PostgresPublicCatalogRepository(executor, storage)

    preview = asyncio.run(
        repository.get_public_dataset_document_preview(
            ORGANIZATION_ID,
            PROJECT_ID,
            RESOURCE_ID,
        )
    )

    assert preview is not None
    assert preview.resource_id == RESOURCE_ID
    assert preview.resource_version_number == 3
    assert preview.dataset_version_number == 6
    assert preview.source_format == "pdf"
    assert preview.presentation_kind == "visual"
    assert preview.presentation["pages"][0]["blocks"][0]["text"] == "Reviewed findings."
    assert storage.specs[0].version_id == "visual-version-1"
    assert storage.specs[0].maximum_bytes == 4 * 1024 * 1024
    assert len(executor.contexts) == 2
    for statement, parameters in transaction.fetch_one_calls:
        assert "resource.state = 'published'" in statement
        assert "resource.visibility = 'public'" in statement
        assert "dataset.format::text IN ('pdf', 'odt')" in statement
        assert parameters == (ORGANIZATION_ID, PROJECT_ID, RESOURCE_ID)
    for statement, parameters in transaction.fetch_all_calls:
        assert "dataset.classification = 'public'" in statement
        assert "comprehensive_malware_scan" in statement
        assert "pdf_document_publication_facts_valid_v1" in statement
        assert parameters[:5] == (
            PROJECT_ID,
            DATASET_VERSION_ID,
            ORGANIZATION_ID,
            DATASET_ID,
            "pdf",
        )


def test_public_dataset_document_preview_fails_closed_for_unsealed_or_changed_target() -> None:
    unsealed = dataset_document_resource_row(version_id=UUID(int=0))
    transaction = ScriptedTransaction(one=[unsealed], all_rows=[[]])
    repository = PostgresPublicCatalogRepository(ScriptedExecutor(transaction))
    try:
        asyncio.run(
            repository.get_public_dataset_document_preview(
                ORGANIZATION_ID,
                PROJECT_ID,
                RESOURCE_ID,
            )
        )
    except PublicCatalogPreviewConflict as error:
        assert error.code == "public_dataset_document_preview_not_sealed"
    else:
        raise AssertionError("an unsealed dataset document must fail closed")

    resource = dataset_document_resource_row()
    transaction = ScriptedTransaction(
        one=[resource, resource],
        all_rows=[dataset_document_target_rows(), dataset_document_target_rows(changed=True)],
    )
    repository = PostgresPublicCatalogRepository(
        ScriptedExecutor(transaction),
        DocumentStorage(),
    )
    try:
        asyncio.run(
            repository.get_public_dataset_document_preview(
                ORGANIZATION_ID,
                PROJECT_ID,
                RESOURCE_ID,
            )
        )
    except PublicCatalogPreviewConflict as error:
        assert error.code == "public_dataset_document_preview_target_changed"
    else:
        raise AssertionError("a changed dataset document target must fail closed")


def test_public_map_preview_reads_exact_layers_and_rechecks_every_public_seal() -> None:
    resource = public_map_resource_row()
    definition = public_map_definition()
    dataset_rows = public_map_dataset_rows()
    transaction = ScriptedTransaction(
        one=[resource, (definition,), resource, (definition,)],
        all_rows=[dataset_rows, dataset_rows],
    )
    executor = ScriptedExecutor(transaction)
    storage = FakeStorage()
    repository = PostgresPublicCatalogRepository(executor, storage)

    preview = asyncio.run(
        repository.get_public_map_preview(ORGANIZATION_ID, PROJECT_ID, RESOURCE_ID)
    )

    assert preview is not None
    assert preview.resource_id == RESOURCE_ID
    assert preview.resource_version_number == 8
    assert preview.map_version == 4
    assert preview.projection == "mercator"
    assert preview.color_mode == "dark"
    assert [layer.layer_id for layer in preview.layers] == ["roads", "watersheds"]
    assert [layer.visible for layer in preview.layers] == [True, False]
    assert [layer.order for layer in preview.layers] == [0, 1]
    assert preview.layers[0].style == {"stroke": "#155e63", "strokeWidth": 2}
    assert preview.layers[1].labels == {"enabled": True, "field": "name"}
    assert all(layer.number_returned == 1 for layer in preview.layers)
    assert len(storage.specs) == 2
    assert {spec.version_id for spec in storage.specs} == {
        "s3-version-preview",
        "s3-version-watersheds",
    }
    assert all(spec.maximum_bytes == 512 * 1024 for spec in storage.specs)
    assert len(executor.contexts) == 2
    assert all(context.user_id == UUID(int=0) for context in executor.contexts)
    assert len(transaction.fetch_one_calls) == 4
    assert len(transaction.fetch_all_calls) == 2
    resource_statement = transaction.fetch_one_calls[0][0]
    map_statement = transaction.fetch_one_calls[1][0]
    dependency_statement = transaction.fetch_all_calls[0][0]
    assert "resource.state = 'published'" in resource_statement
    assert "resource.visibility = 'public'" in resource_statement
    assert "LEFT JOIN app.map_resource_version_bindings binding" in resource_statement
    assert "binding.organization_id = resource.organization_id" in resource_statement
    assert "binding.project_id = resource.project_id" in resource_statement
    assert "binding.resource_id = resource.id" in resource_statement
    assert "binding.resource_version_id = resource.current_version_id" in resource_statement
    assert "version.version = %s" in map_statement
    assert "map.status = 'active'" in map_statement
    assert "resource.kind = 'dataset'" in dependency_statement
    assert "resource.state = 'published'" in dependency_statement
    assert "resource.visibility = 'public'" in dependency_statement
    assert "object.role = 'derived'" in dependency_statement
    for statement, _ in [*transaction.fetch_one_calls, *transaction.fetch_all_calls]:
        assert "owner_user_id" not in statement
        assert "permission" not in statement


def test_public_map_preview_uses_authoritative_binding_over_older_provenance() -> None:
    resource = public_map_resource_row(version=4, bound_version=6)
    definition = public_map_definition()
    rows = public_map_dataset_rows()
    transaction = ScriptedTransaction(
        one=[resource, (definition,), resource, (definition,)], all_rows=[rows, rows]
    )
    storage = FakeStorage()
    preview = asyncio.run(
        PostgresPublicCatalogRepository(
            ScriptedExecutor(transaction), storage
        ).get_public_map_preview(ORGANIZATION_ID, PROJECT_ID, RESOURCE_ID)
    )
    assert preview is not None and preview.map_version == 6
    assert len(storage.specs) == 2
    for _, parameters in transaction.fetch_one_calls[1::2]:
        assert parameters == (6, ORGANIZATION_ID, PROJECT_ID, MAP_ID)


@pytest.mark.parametrize(
    "provenance",
    [None, {}, "invalid", {"mapId": str(PROJECT_ID), "mapVersion": False}],
)
def test_public_map_preview_binding_does_not_require_authored_provenance(
    provenance: object,
) -> None:
    resource = list(public_map_resource_row(bound_version=6))
    resource[3] = provenance
    definition = public_map_definition()
    rows = public_map_dataset_rows()
    transaction = ScriptedTransaction(
        one=[tuple(resource), (definition,), tuple(resource), (definition,)], all_rows=[rows, rows]
    )
    preview = asyncio.run(
        PostgresPublicCatalogRepository(
            ScriptedExecutor(transaction), FakeStorage()
        ).get_public_map_preview(ORGANIZATION_ID, PROJECT_ID, RESOURCE_ID)
    )
    assert preview is not None and preview.map_version == 6


def test_public_map_preview_retains_explicit_legacy_fallback_without_a_binding() -> None:
    resource = public_map_resource_row(version=2)
    definition = public_map_definition()
    rows = public_map_dataset_rows()
    transaction = ScriptedTransaction(
        one=[resource, (definition,), resource, (definition,)], all_rows=[rows, rows]
    )
    preview = asyncio.run(
        PostgresPublicCatalogRepository(
            ScriptedExecutor(transaction), FakeStorage()
        ).get_public_map_preview(ORGANIZATION_ID, PROJECT_ID, RESOURCE_ID)
    )
    assert preview is not None and preview.map_version == 2
    for _, parameters in transaction.fetch_one_calls[1::2]:
        assert parameters == (2, ORGANIZATION_ID, PROJECT_ID, MAP_ID)


@pytest.mark.parametrize("before, after", [(4, 6), (None, 4), (4, None)])
def test_public_map_preview_rejects_binding_changes_between_object_reads(
    before: int | None, after: int | None
) -> None:
    definition = public_map_definition()
    rows = public_map_dataset_rows()
    transaction = ScriptedTransaction(
        one=[
            public_map_resource_row(bound_version=before),
            (definition,),
            public_map_resource_row(bound_version=after),
            (definition,),
        ],
        all_rows=[rows, rows],
    )
    storage = FakeStorage()
    with pytest.raises(PublicCatalogPreviewConflict) as error:
        asyncio.run(
            PostgresPublicCatalogRepository(
                ScriptedExecutor(transaction), storage
            ).get_public_map_preview(ORGANIZATION_ID, PROJECT_ID, RESOURCE_ID)
        )
    assert error.value.code == "public_map_preview_target_changed"
    assert len(storage.specs) == 2


def test_public_map_preview_rejects_binding_for_a_different_map_without_legacy_fallback() -> None:
    resource = list(public_map_resource_row(bound_version=6))
    resource[5] = PROJECT_ID
    storage = FakeStorage()
    with pytest.raises(PublicCatalogPreviewConflict) as error:
        asyncio.run(
            PostgresPublicCatalogRepository(
                ScriptedExecutor(ScriptedTransaction(one=[tuple(resource)])), storage
            ).get_public_map_preview(ORGANIZATION_ID, PROJECT_ID, RESOURCE_ID)
        )
    assert error.value.code == "public_map_preview_not_sealed"
    assert storage.specs == []


def test_public_map_preview_rejects_unsealed_or_external_compositions() -> None:
    unsealed = (
        MAP_RESOURCE_VERSION_ID,
        8,
        MAP_ID,
        {"source": "studio_native_resource", "mapId": str(MAP_ID)},
        None,
        None,
    )
    repository = PostgresPublicCatalogRepository(
        ScriptedExecutor(ScriptedTransaction(one=[unsealed]))
    )
    try:
        asyncio.run(repository.get_public_map_preview(ORGANIZATION_ID, PROJECT_ID, RESOURCE_ID))
    except PublicCatalogPreviewConflict as error:
        assert error.code == "public_map_preview_not_sealed"
    else:
        raise AssertionError("an unsealed public map must fail closed")

    transaction = ScriptedTransaction(
        one=[public_map_resource_row(), (public_map_definition(external=True),)]
    )
    repository = PostgresPublicCatalogRepository(ScriptedExecutor(transaction))
    try:
        asyncio.run(repository.get_public_map_preview(ORGANIZATION_ID, PROJECT_ID, RESOURCE_ID))
    except PublicCatalogPreviewConflict as error:
        assert error.code == "public_map_preview_dependency_not_public"
    else:
        raise AssertionError("an external map layer must fail closed")
    assert transaction.fetch_all_calls == []


def test_public_map_preview_rejects_private_or_changed_dataset_dependencies() -> None:
    resource = public_map_resource_row()
    definition = public_map_definition()
    private_transaction = ScriptedTransaction(
        one=[resource, (definition,)],
        all_rows=[public_map_dataset_rows()[:1]],
    )
    repository = PostgresPublicCatalogRepository(ScriptedExecutor(private_transaction))
    try:
        asyncio.run(repository.get_public_map_preview(ORGANIZATION_ID, PROJECT_ID, RESOURCE_ID))
    except PublicCatalogPreviewConflict as error:
        assert error.code == "public_map_preview_dependency_not_public"
    else:
        raise AssertionError("a map with an unavailable public layer must fail closed")

    changed_transaction = ScriptedTransaction(
        one=[resource, (definition,), resource, (definition,)],
        all_rows=[public_map_dataset_rows(), public_map_dataset_rows(changed=True)],
    )
    repository = PostgresPublicCatalogRepository(
        ScriptedExecutor(changed_transaction),
        FakeStorage(),
    )
    try:
        asyncio.run(repository.get_public_map_preview(ORGANIZATION_ID, PROJECT_ID, RESOURCE_ID))
    except PublicCatalogPreviewConflict as error:
        assert error.code == "public_map_preview_target_changed"
    else:
        raise AssertionError("a dependency change during object reads must fail closed")


def test_public_map_preview_rejects_unresolved_private_style_reference() -> None:
    document = public_map_definition()
    document["schemaVersion"] = "opengeo.map-definition.1.4.0"
    document["layers"][0]["styleReference"] = {
        "projectId": str(PROJECT_ID),
        "resourceId": str(RESOURCE_ID),
        "styleId": str(MAP_ID),
        "versionNumber": 1,
        "checksumSha256": "a" * 64,
        "format": "maplibre",
    }
    transaction = ScriptedTransaction(one=[public_map_resource_row(), (document,)])
    repository = PostgresPublicCatalogRepository(ScriptedExecutor(transaction))
    with pytest.raises(PublicCatalogPreviewConflict) as error:
        asyncio.run(repository.get_public_map_preview(ORGANIZATION_ID, PROJECT_ID, RESOURCE_ID))
    assert error.value.code == "public_map_preview_style_resolution_required"
    assert transaction.fetch_all_calls == []
