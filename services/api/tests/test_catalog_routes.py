from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.catalog import (
    CatalogAccessDenied,
    CatalogStoreUnavailable,
    DatasetDerivativeLineage,
    DatasetLineageOrigin,
    DatasetObject,
    DatasetPermission,
    DatasetVersion,
    DatasetVersionLineage,
)
from opengeo_api.config import Settings
from opengeo_api.s3_downloads import DownloadTicket
from opengeo_api.tenant_database import TenantContext

ORG_ID = UUID("10000000-0000-4000-8000-000000000001")
USER_ID = UUID("20000000-0000-4000-8000-000000000001")
MEMBER_ID = UUID("20000000-0000-4000-8000-000000000002")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000001")
DATASET_ID = UUID("80000000-0000-4000-8000-000000000001")
VERSION_ID = UUID("83000000-0000-4000-8000-000000000001")
OBJECT_ID = UUID("82000000-0000-4000-8000-000000000001")
NOW = datetime(2026, 8, 20, 12, tzinfo=UTC)


class PassingProbe:
    async def check(self) -> None:
        pass


class FakeVerifier:
    async def verify(self, token: str) -> VerifiedAccessToken:
        assert token == "valid-token"
        return VerifiedAccessToken("subject", "client", "user", (), ())


class FakePrincipalRepository:
    async def resolve(self, subject: str) -> Principal:
        return Principal(
            user_id=USER_ID,
            subject=subject,
            email="user@example.test",
            display_name="User",
            memberships=(OrganizationMembership(ORG_ID, "member"),),
        )


def version() -> DatasetVersion:
    return DatasetVersion(
        version_id=VERSION_ID,
        version_number=2,
        parent_version_id=None,
        state="active",
        change_message="Validated source",
        feature_count=5,
        extent=[-1, -2, 3, 4],
        crs="EPSG:4326",
        geometry_type="LineString",
        schema_definition={"fields": []},
        quality_results={"valid": True},
        created_by=USER_ID,
        created_at=NOW,
        current=True,
        objects=(
            DatasetObject(
                object_id=OBJECT_ID,
                role="derived",
                filename="roads.parquet",
                content_type="application/vnd.apache.parquet",
                size_bytes=123,
                checksum_sha256="a" * 64,
                created_at=NOW,
            ),
        ),
    )


def permission() -> DatasetPermission:
    return DatasetPermission(
        user_id=MEMBER_ID,
        email="member@example.test",
        display_name="Member",
        role="download",
        granted_by=USER_ID,
        created_at=NOW,
        updated_at=NOW,
    )


def lineage() -> DatasetVersionLineage:
    return DatasetVersionLineage(
        dataset_id=DATASET_ID,
        version_id=VERSION_ID,
        version_number=2,
        origins=(
            DatasetLineageOrigin(
                kind="managed_upload",
                operation_id=UUID("84000000-0000-4000-8000-000000000001"),
                source_dataset_id=None,
                source_dataset_name=None,
                source_revision_number=None,
                input_object_id=OBJECT_ID,
                acquired_at=NOW,
            ),
        ),
        derivatives=(
            DatasetDerivativeLineage(
                kind="pmtiles",
                operation_id=UUID("85000000-0000-4000-8000-000000000001"),
                recipe="gdal-pmtiles-v1",
                source_object_id=OBJECT_ID,
                output_object_id=UUID("86000000-0000-4000-8000-000000000001"),
                bounds=(-73.6, 41.2, -69.8, 42.9),
                minimum_zoom=4,
                maximum_zoom=14,
                source_layer="massenviroscreen",
                request_checksum_sha256="b" * 64,
                created_at=NOW,
            ),
        ),
        derivatives_truncated=False,
    )


class FakeCatalogRepository:
    def __init__(self) -> None:
        self.calls = []

    async def list_versions(self, context, project_id, dataset_id, limit, offset):
        self.calls.append(("versions", context, project_id, dataset_id, limit, offset))
        return [version()]

    async def get_version_lineage(self, context, project_id, dataset_id, version_id):
        self.calls.append(("lineage", context, project_id, dataset_id, version_id))
        return lineage()

    async def list_permissions(self, context, project_id, dataset_id):
        self.calls.append(("permissions", context, project_id, dataset_id))
        return [permission()]

    async def put_permission(self, context, project_id, dataset_id, grant, request_id):
        self.calls.append(("put", context, project_id, dataset_id, grant, request_id))
        return permission()

    async def delete_permission(self, context, project_id, dataset_id, user_id, request_id):
        self.calls.append(("delete", context, project_id, dataset_id, user_id, request_id))

    async def request_download(
        self, context, project_id, dataset_id, version_id, object_id, request_id
    ):
        self.calls.append(
            (
                "download",
                context,
                project_id,
                dataset_id,
                version_id,
                object_id,
                request_id,
            )
        )
        return DownloadTicket(
            "https://geodata-test.s3.us-east-1.amazonaws.com/exact?versionId=one&signed=true",
            "GET",
            NOW + timedelta(minutes=5),
        )

    async def get_document_preview(self, context, project_id, dataset_id, version_id):
        self.calls.append(("document-preview", context, project_id, dataset_id, version_id))
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

    async def get_spatial_preview(self, context, project_id, dataset_id, version_id):
        self.calls.append(("spatial-preview", context, project_id, dataset_id, version_id))
        return {
            "schema_version": "opengeo.spatial-preview.1.0.0",
            "dataset_version_id": str(version_id),
            "number_returned": 1,
            "number_matched": 5,
            "may_be_truncated": True,
            "geojson": {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "id": 1,
                        "properties": {"name": "Bounded road"},
                        "geometry": {
                            "type": "LineString",
                            "coordinates": [[-71.2, 42.2], [-71.0, 42.4]],
                        },
                    }
                ],
            },
        }


class DeniedCatalogRepository(FakeCatalogRepository):
    async def request_download(self, *args, **kwargs):
        del args, kwargs
        raise CatalogAccessDenied("secret role details")


class PdfPreviewCatalogRepository(FakeCatalogRepository):
    async def get_document_preview(self, context, project_id, dataset_id, version_id):
        self.calls.append(("document-preview", context, project_id, dataset_id, version_id))
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
                    "blocks": [{"type": "paragraph", "text": "Exact PDF text."}],
                }
            ],
        }


class PdfOcrPreviewCatalogRepository(FakeCatalogRepository):
    async def get_document_preview(self, context, project_id, dataset_id, version_id):
        self.calls.append(("document-preview", context, project_id, dataset_id, version_id))
        return {
            "schemaVersion": "opengeo.document-preview.3.0.0",
            "sourceFormat": "pdf",
            "pdfVersion": "1.7",
            "title": "Scanned notes",
            "language": "ar",
            "extraction": {
                "engine": "poppler-pdftotext+tesseract",
                "mode": "layout+page-ocr",
                "ocrPerformed": True,
                "ocrEngine": "tesseract",
                "ocrEngineVersion": "5.3.4",
                "ocrModel": "Arabic",
                "ocrPageLimit": 32,
                "ocrPages": [1],
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
                    "textSource": "ocr",
                    "blocks": [{"type": "paragraph", "text": "نص ممسوح ضوئياً"}],
                }
            ],
        }


class FailingCatalogRepository(FakeCatalogRepository):
    async def list_versions(self, *args, **kwargs):
        del args, kwargs
        raise CatalogStoreUnavailable("password=must-not-leak")


def api_client(repository) -> TestClient:
    return TestClient(
        create_app(
            settings=Settings(env="test", expose_docs=True),
            readiness_probe=PassingProbe(),
            token_verifier=FakeVerifier(),
            principal_repository=FakePrincipalRepository(),
            catalog_repository=repository,
        )
    )


def headers() -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(ORG_ID),
        "X-Request-ID": "request-catalog-123",
    }


def test_version_object_and_permission_contracts_never_return_storage_coordinates() -> None:
    repository = FakeCatalogRepository()
    client = api_client(repository)
    versions = client.get(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/versions", headers=headers()
    )
    permissions = client.get(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/permissions", headers=headers()
    )

    assert versions.status_code == 200
    assert versions.json()[0]["version_number"] == 2
    assert versions.json()[0]["objects"][0]["filename"] == "roads.parquet"
    assert permissions.json()[0]["role"] == "download"
    for secret in ("bucket", "object_key", "s3_version", "etag"):
        assert secret not in versions.text


def test_version_lineage_is_private_bounded_and_omits_storage_coordinates() -> None:
    repository = FakeCatalogRepository()
    response = api_client(repository).get(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/versions/{VERSION_ID}/lineage",
        headers=headers(),
    )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.json()["schema_version"] == "opengeo.dataset-version-lineage.1.0.0"
    assert response.json()["origins"][0]["kind"] == "managed_upload"
    assert response.json()["derivatives"][0]["recipe"] == "gdal-pmtiles-v1"
    for coordinate in ("bucket", "object_key", "s3_version", "etag"):
        assert coordinate not in response.text
    assert repository.calls[-1] == (
        "lineage",
        TenantContext(USER_ID, ORG_ID),
        PROJECT_ID,
        DATASET_ID,
        VERSION_ID,
    )


def test_permission_mutations_and_download_use_bound_path_ids_and_request_attribution() -> None:
    repository = FakeCatalogRepository()
    client = api_client(repository)
    updated = client.put(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/permissions/{MEMBER_ID}",
        headers=headers(),
        json={"role": "download"},
    )
    deleted = client.delete(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/permissions/{MEMBER_ID}",
        headers=headers(),
    )
    download = client.post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/versions/{VERSION_ID}/objects/{OBJECT_ID}/download",
        headers=headers(),
    )

    assert updated.status_code == 200
    assert deleted.status_code == 204
    assert download.status_code == 200
    assert download.json()["method"] == "GET"
    assert repository.calls[-1] == (
        "download",
        TenantContext(USER_ID, ORG_ID),
        PROJECT_ID,
        DATASET_ID,
        VERSION_ID,
        OBJECT_ID,
        "request-catalog-123",
    )


def test_exact_odt_semantic_preview_is_private_no_store_and_tenant_bound() -> None:
    repository = FakeCatalogRepository()
    response = api_client(repository).get(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/versions/{VERSION_ID}/document-preview",
        headers=headers(),
    )

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.json()["pages"][0]["blocks"][2]["headerRows"] == 1
    assert repository.calls[-1] == (
        "document-preview",
        TenantContext(USER_ID, ORG_ID),
        PROJECT_ID,
        DATASET_ID,
        VERSION_ID,
    )


def test_exact_pdf_semantic_preview_uses_the_strict_variant_response() -> None:
    response = api_client(PdfPreviewCatalogRepository()).get(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/versions/{VERSION_ID}/document-preview",
        headers=headers(),
    )

    assert response.status_code == 200
    assert response.json()["sourceFormat"] == "pdf"
    assert response.json()["extraction"] == {
        "engine": "poppler-pdftotext",
        "mode": "layout",
        "ocrPerformed": False,
        "readingOrder": "heuristic",
        "tagged": True,
        "textAvailable": True,
    }


def test_exact_spatial_preview_is_private_no_store_and_tenant_bound() -> None:
    repository = FakeCatalogRepository()
    response = api_client(repository).get(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/versions/{VERSION_ID}/spatial-preview",
        headers=headers(),
    )

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.json()["number_returned"] == 1
    assert "bucket" not in response.text
    assert "object_key" not in response.text
    assert repository.calls[-1] == (
        "spatial-preview",
        TenantContext(USER_ID, ORG_ID),
        PROJECT_ID,
        DATASET_ID,
        VERSION_ID,
    )


def test_exact_pdf_ocr_preview_exposes_page_provenance_and_bounds() -> None:
    response = api_client(PdfOcrPreviewCatalogRepository()).get(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/versions/{VERSION_ID}/document-preview",
        headers=headers(),
    )

    assert response.status_code == 200
    assert response.json()["pages"][0]["textSource"] == "ocr"
    assert response.json()["extraction"]["ocrPageLimit"] == 32
    assert response.json()["extraction"]["ocrModel"] == "Arabic"


def test_invalid_grants_denial_and_store_failures_are_closed_and_sanitized() -> None:
    repository = FakeCatalogRepository()
    invalid = api_client(repository).put(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/permissions/{MEMBER_ID}",
        headers=headers(),
        json={"role": "owner", "organization_id": str(ORG_ID)},
    )
    denied = api_client(DeniedCatalogRepository()).post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/versions/{VERSION_ID}/objects/{OBJECT_ID}/download",
        headers=headers(),
    )
    failed = api_client(FailingCatalogRepository()).get(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/versions", headers=headers()
    )

    assert invalid.status_code == 422
    assert repository.calls == []
    assert denied.status_code == 403
    assert denied.json() == {"detail": "action_forbidden"}
    assert failed.status_code == 503
    assert failed.json() == {"detail": "catalog_store_unavailable"}
    assert "password" not in failed.text


def test_openapi_exposes_catalog_governance_and_download_contracts() -> None:
    paths = api_client(FakeCatalogRepository()).get("/openapi.json").json()["paths"]
    assert {
        "/projects/{project_id}/datasets/{dataset_id}/versions",
        "/projects/{project_id}/datasets/{dataset_id}/versions/{version_id}/lineage",
        "/projects/{project_id}/datasets/{dataset_id}/permissions",
        "/projects/{project_id}/datasets/{dataset_id}/permissions/{user_id}",
        "/projects/{project_id}/datasets/{dataset_id}/versions/{version_id}/objects/{object_id}/download",
        "/projects/{project_id}/datasets/{dataset_id}/versions/{version_id}/document-preview",
        "/projects/{project_id}/datasets/{dataset_id}/versions/{version_id}/spatial-preview",
    } <= set(paths)
