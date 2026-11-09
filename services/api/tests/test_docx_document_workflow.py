"""DOCX uses the existing private preview and immutable Publication asset paths."""

import asyncio
import json
from copy import deepcopy
from hashlib import sha256
from uuid import UUID

import pytest

import test_catalog as catalog
import test_catalog_routes as catalog_routes
import test_public_catalog as public
import test_site_publications as publication
from opengeo_api.catalog import CatalogConflict, PostgresCatalogRepository
from opengeo_api.catalog_routes import DocxDocumentPreviewResponse
from opengeo_api.document_previews import DocumentPreviewInvalid, parse_document_preview
from opengeo_api.public_catalog import PostgresPublicCatalogRepository
from opengeo_api.site_publications import (
    PostgresSitePublicationRepository,
    SiteAssetDraft,
    SiteConflict,
    SiteNotFound,
)
from opengeo_api.tenant_database import TenantContext


def docx_preview():
    document = catalog.preview_document()
    document.update(schemaVersion="opengeo.document-preview.4.0.0", sourceFormat="docx")
    document.pop("odfVersion")
    document["pages"][0]["blocks"][1]["text"] = "Literal <b>नेपाल</b> & (field evidence)."
    return document


def docx_print_asset_rows():
    rows = []
    for original in publication.odt_print_asset_rows():
        row = list(original)
        row[14] = "docx"
        document = deepcopy(row[16]["document"])
        document.update(
            kind="ooxml_text",
            source_format="docx",
            accessible_preview_schema="opengeo.document-preview.4.0.0",
        )
        row[16] = {"document": document}
        rows.append(tuple(row))
    return rows[0], rows[1]


def test_docx_preview_has_its_own_closed_schema_and_preserves_semantic_blocks():
    document = docx_preview()
    body = json.dumps(document, ensure_ascii=False).encode()
    assert parse_document_preview(body) == document
    response = DocxDocumentPreviewResponse.model_validate(document)
    assert response.model_dump(by_alias=True) == document
    assert set(document) == {"schemaVersion", "sourceFormat", "title", "language", "pages"}
    for changes in [
        {"sourceFormat": "odt"},
        {"sourceFormat": "pdf"},
        {"schemaVersion": "opengeo.document-preview.1.0.0"},
        {"odfVersion": "1.4"},
        {"extraction": {"engine": "libreoffice"}},
        {"pdfVersion": "1.7"},
    ]:
        with pytest.raises(DocumentPreviewInvalid, match="document_preview_invalid"):
            parse_document_preview(json.dumps({**document, **changes}).encode())
    oversized = deepcopy(document)
    oversized["pages"][0]["blocks"][1]["text"] = "x" * 8_001
    with pytest.raises(DocumentPreviewInvalid):
        parse_document_preview(json.dumps(oversized).encode())


def test_docx_private_preview_reads_one_exact_object_and_rechecks_access_and_version():
    document = docx_preview()
    body = json.dumps(document).encode()
    target = list(catalog.preview_target_row())
    target[5:] = [len(body), sha256(body).hexdigest()]
    prepare = catalog.FakeTransaction(one=[catalog.access("viewer")], all_rows=[[tuple(target)]])
    reauthorize = catalog.FakeTransaction(
        one=[catalog.access("viewer")],
        all_rows=[[tuple(target)]],
    )
    storage = catalog.FakeStorage(body)
    repository = PostgresCatalogRepository(catalog.FakeExecutor([prepare, reauthorize]), storage)
    assert (
        asyncio.run(
            repository.get_document_preview(
                catalog.context(),
                catalog.PROJECT_ID,
                catalog.DATASET_ID,
                catalog.VERSION_ID,
            )
        )
        == document
    )
    assert len(storage.specs) == 1
    assert storage.specs[0].version_id == "s3-version-preview"
    assert storage.specs[0].checksum_sha256 == sha256(body).hexdigest()
    assert storage.specs[0].maximum_bytes == 512 * 1024
    query = next(call for call in prepare.calls if call[0] == "all")
    assert "dataset.format::text = 'docx'" in query[1]
    assert "'{document,kind}' = 'ooxml_text'" in query[1]
    assert "opengeo.document-preview.4.0.0" in query[2]
    assert len(reauthorize.calls) == 2
    changed = list(target)
    changed[3] = "different-storage-version"
    repository = PostgresCatalogRepository(
        catalog.FakeExecutor(
            [
                catalog.FakeTransaction(one=[catalog.access("viewer")], all_rows=[[tuple(target)]]),
                catalog.FakeTransaction(
                    one=[catalog.access("viewer")], all_rows=[[tuple(changed)]]
                ),
            ]
        ),
        catalog.FakeStorage(body),
    )
    with pytest.raises(CatalogConflict, match="document_preview_target_changed"):
        asyncio.run(
            repository.get_document_preview(
                catalog.context(),
                catalog.PROJECT_ID,
                catalog.DATASET_ID,
                catalog.VERSION_ID,
            )
        )


def test_docx_catalog_route_keeps_private_no_store_and_account_boundary():
    class Repository(catalog_routes.FakeCatalogRepository):
        async def get_document_preview(self, *args):
            await super().get_document_preview(*args)
            return docx_preview()

    repository = Repository()
    client = catalog_routes.api_client(repository)
    path = (
        f"/projects/{catalog.PROJECT_ID}/datasets/{catalog.DATASET_ID}"
        f"/versions/{catalog.VERSION_ID}/document-preview"
    )
    response = client.get(path, headers=catalog_routes.headers())
    assert response.status_code == 200
    assert response.json() == docx_preview()
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert repository.calls[-1][1] == catalog.context()
    calls = len(repository.calls)
    assert client.get(path).status_code == 401
    foreign = {**catalog_routes.headers(), "X-OpenGeo-Organization": str(UUID(int=99))}
    assert client.get(path, headers=foreign).status_code == 403
    assert len(repository.calls) == calls


def test_docx_public_preview_requires_the_same_current_public_seal_and_semantic_identity():
    document = docx_preview()
    body = json.dumps(document).encode()
    resource = (*public.dataset_document_resource_row()[:4], "docx")
    target = list(public.dataset_document_target_rows()[1])
    target[6:] = [len(body), sha256(body).hexdigest()]
    transaction = public.ScriptedTransaction(
        one=[resource, resource],
        all_rows=[[tuple(target)], [tuple(target)]],
    )
    storage = catalog.FakeStorage(body)
    executor = public.ScriptedExecutor(transaction)
    repository = PostgresPublicCatalogRepository(executor, storage)
    preview = asyncio.run(
        repository.get_public_dataset_document_preview(
            public.ORGANIZATION_ID,
            public.PROJECT_ID,
            public.RESOURCE_ID,
        )
    )
    assert preview is not None
    assert preview.source_format == "docx" and preview.presentation_kind == "semantic"
    assert preview.presentation == document
    assert len(storage.specs) == 1 and storage.specs[0].version_id == "semantic-version-1"
    assert len(executor.contexts) == 2
    for query, parameters in transaction.fetch_all_calls:
        assert "dataset.classification = 'public'" in query
        assert "comprehensive_malware_scan" in query and "'ooxml_text'" in query
        assert parameters[-1] == "opengeo.document-preview.4.0.0"


def test_docx_publication_seals_prepared_pages_and_reopens_exact_docx_source_identity():
    source, companion = docx_print_asset_rows()
    tenant = TenantContext(publication.USER_ID, publication.ORG_ID)
    transaction = publication.ScriptedTransaction(all_rows=[[source, companion]])
    assets = asyncio.run(
        PostgresSitePublicationRepository._seal_site_assets(
            transaction,
            tenant,
            publication.PROJECT_ID,
            (
                SiteAssetDraft(
                    "document",
                    publication.ASSET_DATASET_ID,
                    publication.ASSET_VERSION_ID,
                    publication.DOCUMENT_OBJECT_ID,
                ),
            ),
        )
    )
    assert len(assets) == 1 and assets[0].kind == "document"
    assert assets[0].object_id == publication.DOCUMENT_OBJECT_ID
    assert assets[0].print_document is not None
    assert assets[0].print_document.object_id == publication.PRINT_DOCUMENT_OBJECT_ID
    assert source[14] == "docx" and source[16]["document"]["source_format"] == "docx"
    assert source[16]["document"]["page_count"] == 7
    assert source[16]["document"]["print_vector_facts"]["page_count"] == 1
    raw = PostgresSitePublicationRepository._asset_manifest(assets[0])
    raw["printDocument"] = PostgresSitePublicationRepository._asset_manifest(
        assets[0].print_document
    )
    read = publication.ScriptedTransaction(all_rows=[[source, companion]])
    loaded = asyncio.run(
        PostgresSitePublicationRepository._load_manifest_assets(
            read,
            tenant,
            publication.PROJECT_ID,
            {"assets": [raw]},
        )
    )
    assert loaded == assets
    assert set(read.fetches[0][1][2]) == {
        publication.DOCUMENT_OBJECT_ID,
        publication.PRINT_DOCUMENT_OBJECT_ID,
    }


@pytest.mark.parametrize("changed", ["odt_kind", "pdf_schema", "network", "foreign_version"])
def test_docx_prepared_binding_refuses_mislabelled_provenance_and_foreign_pages(changed):
    source, companion = docx_print_asset_rows()
    document = source[16]["document"]
    if changed == "odt_kind":
        document["kind"] = "odf_text"
    elif changed == "pdf_schema":
        document["accessible_preview_schema"] = "opengeo.document-preview.2.0.0"
    elif changed == "network":
        document["print_conversion"]["network"] = "allowed"
    else:
        companion = tuple(
            UUID(int=99) if index == 2 else value for index, value in enumerate(companion)
        )
    transaction = publication.ScriptedTransaction(all_rows=[[source, companion]])
    with pytest.raises(SiteConflict):
        asyncio.run(
            PostgresSitePublicationRepository._seal_site_assets(
                transaction,
                TenantContext(publication.USER_ID, publication.ORG_ID),
                publication.PROJECT_ID,
                (
                    SiteAssetDraft(
                        "document",
                        publication.ASSET_DATASET_ID,
                        publication.ASSET_VERSION_ID,
                        publication.DOCUMENT_OBJECT_ID,
                    ),
                ),
            )
        )


def test_docx_sealed_manifest_rechecks_writer_conversion_before_readback():
    source, companion = docx_print_asset_rows()
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
    transaction = publication.ScriptedTransaction(all_rows=[[source, companion]])
    with pytest.raises(SiteNotFound):
        asyncio.run(
            PostgresSitePublicationRepository._load_manifest_assets(
                transaction,
                TenantContext(publication.USER_ID, publication.ORG_ID),
                publication.PROJECT_ID,
                {"assets": [raw]},
            )
        )
