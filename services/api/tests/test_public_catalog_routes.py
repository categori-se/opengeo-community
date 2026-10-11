from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.config import Settings
from opengeo_api.public_catalog import (
    PublicCatalogFacet,
    PublicCatalogFilters,
    PublicCatalogPage,
    PublicCatalogRecord,
    PublicCatalogStoreUnavailable,
    PublicDatasetDocumentPreview,
    PublicDocumentPreview,
    PublicMapPreview,
    PublicMapPreviewLayer,
    PublicSpatialPreview,
)

ORGANIZATION_ID = UUID("10000000-0000-4000-8000-000000000068")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000068")
RESOURCE_ID = UUID("90000000-0000-4000-8000-000000000068")
NOW = datetime(2026, 9, 1, 14, tzinfo=UTC)


class PassingProbe:
    async def check(self) -> None:
        pass


def record(
    *,
    kind: Literal["dataset", "map", "document", "story", "dashboard", "service"] = "dataset",
    preview_kind: Literal["map", "dataset", "dataset-document", "document", "metadata"] = "dataset",
) -> PublicCatalogRecord:
    return PublicCatalogRecord(
        resource_id=RESOURCE_ID,
        organization_id=ORGANIZATION_ID,
        organization_slug="public-lab",
        organization_name="Public Lab",
        project_id=PROJECT_ID,
        project_name="Community atlas",
        kind=kind,
        slug="public-roads",
        version_number=3,
        title="Public roads",
        abstract="Reviewed public road centerlines.",
        language="en",
        license="CC-BY-4.0",
        attribution="Public Lab",
        keywords=("roads", "transport"),
        spatial_extent=(-72.0, 41.0, -70.0, 43.0),
        temporal_start=datetime(2026, 1, 1, tzinfo=UTC),
        temporal_end=None,
        origin_namespace="geonode",
        origin_identifier="public-road-source",
        origin_version="5.1.0",
        origin_observed_at=NOW,
        public_relationship_count=2,
        rating_count=4,
        rating_average=4.5,
        preview_kind=preview_kind,
        created_at=NOW,
        updated_at=NOW,
    )


class FakePublicCatalogRepository:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def list_public_resources(
        self,
        organization_id: UUID,
        filters: PublicCatalogFilters,
    ) -> PublicCatalogPage:
        self.calls.append(("list", organization_id, filters))
        return PublicCatalogPage(
            records=(record(),),
            number_matched=1,
            facets={
                "kind": (PublicCatalogFacet("dataset", "Dataset", 1),),
                "project": (PublicCatalogFacet(str(PROJECT_ID), "Community atlas", 1),),
                "license": (PublicCatalogFacet("CC-BY-4.0", "CC-BY-4.0", 1),),
                "keyword": (PublicCatalogFacet("roads", "roads", 1),),
                "origin": (PublicCatalogFacet("geonode", "geonode", 1),),
            },
            facet_sample_size=1,
            facets_truncated=False,
        )

    async def get_public_resource(
        self,
        organization_id: UUID,
        project_id: UUID,
        resource_id: UUID,
    ) -> PublicCatalogRecord | None:
        self.calls.append(("get", organization_id, project_id, resource_id))
        return record() if resource_id == RESOURCE_ID else None

    async def get_public_spatial_preview(
        self,
        organization_id: UUID,
        project_id: UUID,
        resource_id: UUID,
    ) -> PublicSpatialPreview | None:
        self.calls.append(("preview", organization_id, project_id, resource_id))
        if resource_id != RESOURCE_ID:
            return None
        return PublicSpatialPreview(
            resource_id=resource_id,
            resource_version_number=3,
            number_returned=1,
            number_matched=4,
            may_be_truncated=True,
            geojson={
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "id": "road-1",
                        "geometry": {
                            "type": "LineString",
                            "coordinates": [[-72.0, 41.0], [-70.0, 43.0]],
                        },
                        "properties": {},
                    }
                ],
            },
        )

    async def get_public_document_preview(
        self,
        organization_id: UUID,
        project_id: UUID,
        resource_id: UUID,
    ) -> PublicDocumentPreview | None:
        self.calls.append(("document-preview", organization_id, project_id, resource_id))
        if resource_id != RESOURCE_ID:
            return None
        return PublicDocumentPreview(
            resource_id=resource_id,
            resource_version_number=3,
            resource_kind="story",
            renderer_version="opengeo-page-renderer-1.1.0",
            dependency_references_omitted=1,
            html="<!doctype html><html><body><h1>Road notes</h1></body></html>",
        )

    async def get_public_dataset_document_preview(
        self,
        organization_id: UUID,
        project_id: UUID,
        resource_id: UUID,
    ) -> PublicDatasetDocumentPreview | None:
        self.calls.append(("dataset-document-preview", organization_id, project_id, resource_id))
        if resource_id != RESOURCE_ID:
            return None
        return PublicDatasetDocumentPreview(
            resource_id=resource_id,
            resource_version_number=3,
            dataset_version_number=6,
            source_format="odt",
            presentation_kind="semantic",
            presentation={
                "schemaVersion": "opengeo.document-preview.1.0.0",
                "sourceFormat": "odt",
                "odfVersion": "1.3",
                "title": "Field report",
                "language": "en",
                "pages": [
                    {
                        "number": 1,
                        "blocks": [{"type": "paragraph", "text": "Reviewed findings."}],
                    }
                ],
            },
        )

    async def get_public_map_preview(
        self,
        organization_id: UUID,
        project_id: UUID,
        resource_id: UUID,
    ) -> PublicMapPreview | None:
        self.calls.append(("map-preview", organization_id, project_id, resource_id))
        if resource_id != RESOURCE_ID:
            return None
        return PublicMapPreview(
            resource_id=resource_id,
            resource_version_number=3,
            map_version=7,
            projection="mercator",
            color_mode="dark",
            layers=(
                PublicMapPreviewLayer(
                    layer_id="roads",
                    title="Roads",
                    visible=True,
                    opacity=0.8,
                    order=0,
                    style={"stroke": "#155e63", "strokeWidth": 2},
                    labels={"enabled": False, "field": None},
                    number_returned=1,
                    number_matched=4,
                    may_be_truncated=True,
                    geojson={
                        "type": "FeatureCollection",
                        "features": [
                            {
                                "type": "Feature",
                                "id": "road-1",
                                "geometry": {
                                    "type": "LineString",
                                    "coordinates": [[-72.0, 41.0], [-70.0, 43.0]],
                                },
                                "properties": {},
                            }
                        ],
                    },
                ),
            ),
        )


class FailingPublicCatalogRepository(FakePublicCatalogRepository):
    async def list_public_resources(self, *args, **kwargs):
        del args, kwargs
        raise PublicCatalogStoreUnavailable("database password must not escape")


class BoundaryPublicCatalogRepository(FakePublicCatalogRepository):
    async def list_public_resources(
        self,
        organization_id: UUID,
        filters: PublicCatalogFilters,
    ) -> PublicCatalogPage:
        self.calls.append(("list", organization_id, filters))
        return PublicCatalogPage(
            records=(record(),),
            number_matched=20_000,
            facets={name: () for name in ("kind", "project", "license", "keyword", "origin")},
            facet_sample_size=10_000,
            facets_truncated=True,
        )


class MapPublicCatalogRepository(FakePublicCatalogRepository):
    async def get_public_resource(
        self,
        organization_id: UUID,
        project_id: UUID,
        resource_id: UUID,
    ) -> PublicCatalogRecord | None:
        self.calls.append(("get", organization_id, project_id, resource_id))
        return record(kind="map", preview_kind="map") if resource_id == RESOURCE_ID else None


class DatasetDocumentPublicCatalogRepository(FakePublicCatalogRepository):
    async def get_public_resource(
        self,
        organization_id: UUID,
        project_id: UUID,
        resource_id: UUID,
    ) -> PublicCatalogRecord | None:
        self.calls.append(("get", organization_id, project_id, resource_id))
        return (
            record(kind="dataset", preview_kind="dataset-document")
            if resource_id == RESOURCE_ID
            else None
        )


def client(repository) -> TestClient:
    return TestClient(
        create_app(
            settings=Settings(env="test", expose_docs=True),
            readiness_probe=PassingProbe(),
            public_catalog_repository=repository,
        )
    )


def test_anonymous_catalog_returns_only_the_sanitized_public_projection() -> None:
    repository = FakePublicCatalogRepository()
    response = client(repository).get(
        f"/public/organizations/{ORGANIZATION_ID}/resources",
        params={
            "query": "road",
            "kind": "dataset",
            "project_id": str(PROJECT_ID),
            "keyword": "roads",
            "license": "CC-BY-4.0",
            "origin_namespace": "geonode",
            "bbox": "-73,40,-69,44",
            "temporal_start": "2025-01-01T00:00:00Z",
            "limit": 25,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["schema_version"] == "opengeo.public-catalog.1.5.0"
    assert body["number_returned"] == 1
    assert body["number_matched"] == 1
    assert body["facets"]["kind"] == [{"value": "dataset", "label": "Dataset", "count": 1}]
    item = body["records"][0]
    assert item["id"] == str(RESOURCE_ID)
    assert item["community"]["organization_slug"] == "public-lab"
    assert item["preview"] == {
        "kind": "dataset",
        "href": (
            f"/public/organizations/{ORGANIZATION_ID}/projects/{PROJECT_ID}/resources/"
            f"{RESOURCE_ID}/spatial-preview"
        ),
    }
    assert item["freshness"]["source_version"] == "5.1.0"
    assert item["provenance"] == {
        "namespace": "geonode",
        "identifier": "public-road-source",
    }
    assert item["relationships"]["public_count"] == 2
    assert item["ratings"] == {"count": 4, "average": 4.5}
    for secret in (
        "owner_user_id",
        "dataset_id",
        "map_id",
        "content",
        "metadata_extensions",
        "source_url",
        "bucket",
        "object_key",
    ):
        assert secret not in response.text
    assert "authorization" not in {key.lower() for key in response.request.headers}

    _, organization_id, filters = repository.calls[0]
    assert organization_id == ORGANIZATION_ID
    assert filters.project_id == PROJECT_ID
    assert filters.bbox == (-73.0, 40.0, -69.0, 44.0)
    assert filters.temporal_start == datetime(2025, 1, 1, tzinfo=UTC)
    assert filters.limit == 25


def test_public_detail_is_anonymous_and_private_or_unknown_identity_is_indistinguishable() -> None:
    repository = FakePublicCatalogRepository()
    api = client(repository)
    found = api.get(
        f"/public/organizations/{ORGANIZATION_ID}/projects/{PROJECT_ID}/resources/{RESOURCE_ID}"
    )
    hidden = api.get(
        f"/public/organizations/{ORGANIZATION_ID}/projects/"
        f"{PROJECT_ID}/resources/90000000-0000-4000-8000-000000000069"
    )

    assert found.status_code == 200
    assert found.json()["title"] == "Public roads"
    assert hidden.status_code == 404
    assert hidden.json() == {"detail": {"code": "public_resource_not_found"}}


def test_public_map_record_links_to_the_exact_composition_preview() -> None:
    found = client(MapPublicCatalogRepository()).get(
        f"/public/organizations/{ORGANIZATION_ID}/projects/{PROJECT_ID}/resources/{RESOURCE_ID}"
    )

    assert found.status_code == 200
    assert found.json()["preview"] == {
        "kind": "map",
        "href": (
            f"/public/organizations/{ORGANIZATION_ID}/projects/{PROJECT_ID}/resources/"
            f"{RESOURCE_ID}/map-preview"
        ),
    }


def test_public_document_dataset_record_links_to_its_exact_presentation() -> None:
    found = client(DatasetDocumentPublicCatalogRepository()).get(
        f"/public/organizations/{ORGANIZATION_ID}/projects/{PROJECT_ID}/resources/{RESOURCE_ID}"
    )

    assert found.status_code == 200
    assert found.json()["preview"] == {
        "kind": "dataset-document",
        "href": (
            f"/public/organizations/{ORGANIZATION_ID}/projects/{PROJECT_ID}/resources/"
            f"{RESOURCE_ID}/dataset-document-preview"
        ),
    }


def test_public_spatial_preview_is_bounded_and_does_not_expose_storage_identity() -> None:
    repository = FakePublicCatalogRepository()
    response = client(repository).get(
        f"/public/organizations/{ORGANIZATION_ID}/projects/{PROJECT_ID}/resources/"
        f"{RESOURCE_ID}/spatial-preview"
    )

    assert response.status_code == 200
    body = response.json()
    assert body["schema_version"] == "opengeo.public-spatial-preview.1.0.0"
    assert body["resource_id"] == str(RESOURCE_ID)
    assert body["resource_version_number"] == 3
    assert body["number_returned"] == 1
    assert body["number_matched"] == 4
    assert body["may_be_truncated"] is True
    assert body["geojson"]["features"][0]["id"] == "road-1"
    for secret in ("dataset_id", "dataset_version_id", "bucket", "object_key", "s3_version_id"):
        assert secret not in response.text
    assert "authorization" not in {key.lower() for key in response.request.headers}

    hidden = client(repository).get(
        f"/public/organizations/{ORGANIZATION_ID}/projects/{PROJECT_ID}/resources/"
        "90000000-0000-4000-8000-000000000069/spatial-preview"
    )
    assert hidden.status_code == 404
    assert hidden.json() == {"detail": {"code": "public_spatial_preview_not_found"}}


def test_public_document_preview_is_bounded_and_hides_unknown_identity() -> None:
    repository = FakePublicCatalogRepository()
    response = client(repository).get(
        f"/public/organizations/{ORGANIZATION_ID}/projects/{PROJECT_ID}/resources/"
        f"{RESOURCE_ID}/document-preview"
    )

    assert response.status_code == 200
    body = response.json()
    assert body == {
        "schema_version": "opengeo.public-document-preview.1.0.0",
        "resource_id": str(RESOURCE_ID),
        "resource_version_number": 3,
        "resource_kind": "story",
        "renderer_version": "opengeo-page-renderer-1.1.0",
        "dependency_references_omitted": 1,
        "html": "<!doctype html><html><body><h1>Road notes</h1></body></html>",
    }
    assert "authorization" not in {key.lower() for key in response.request.headers}

    hidden = client(repository).get(
        f"/public/organizations/{ORGANIZATION_ID}/projects/{PROJECT_ID}/resources/"
        "90000000-0000-4000-8000-000000000069/document-preview"
    )
    assert hidden.status_code == 404
    assert hidden.json() == {"detail": {"code": "public_document_preview_not_found"}}


def test_public_dataset_document_preview_is_bounded_and_hides_storage_identity() -> None:
    repository = FakePublicCatalogRepository()
    response = client(repository).get(
        f"/public/organizations/{ORGANIZATION_ID}/projects/{PROJECT_ID}/resources/"
        f"{RESOURCE_ID}/dataset-document-preview"
    )

    assert response.status_code == 200
    body = response.json()
    assert body["schema_version"] == "opengeo.public-dataset-document-preview.1.0.0"
    assert body["resource_id"] == str(RESOURCE_ID)
    assert body["resource_version_number"] == 3
    assert body["dataset_version_number"] == 6
    assert body["source_format"] == "odt"
    assert body["presentation_kind"] == "semantic"
    assert body["presentation"]["pages"][0]["blocks"][0]["text"] == "Reviewed findings."
    for secret in (
        "dataset_id",
        "dataset_version_id",
        "object_id",
        "bucket",
        "object_key",
        "s3_version_id",
    ):
        assert secret not in response.text
    assert "authorization" not in {key.lower() for key in response.request.headers}

    hidden = client(repository).get(
        f"/public/organizations/{ORGANIZATION_ID}/projects/{PROJECT_ID}/resources/"
        "90000000-0000-4000-8000-000000000069/dataset-document-preview"
    )
    assert hidden.status_code == 404
    assert hidden.json() == {"detail": {"code": "public_dataset_document_preview_not_found"}}


def test_public_map_preview_is_bounded_and_hides_dependency_identity() -> None:
    repository = FakePublicCatalogRepository()
    response = client(repository).get(
        f"/public/organizations/{ORGANIZATION_ID}/projects/{PROJECT_ID}/resources/"
        f"{RESOURCE_ID}/map-preview"
    )

    assert response.status_code == 200
    body = response.json()
    assert body["schema_version"] == "opengeo.public-map-preview.1.0.0"
    assert body["resource_id"] == str(RESOURCE_ID)
    assert body["resource_version_number"] == 3
    assert body["map_version"] == 7
    assert body["projection"] == "mercator"
    assert body["color_mode"] == "dark"
    assert body["layers"][0]["layer_id"] == "roads"
    assert body["layers"][0]["style"] == {"stroke": "#155e63", "strokeWidth": 2}
    assert body["layers"][0]["geojson"]["features"][0]["id"] == "road-1"
    for secret in (
        "dataset_id",
        "dataset_version_id",
        "resource_version_id",
        "bucket",
        "object_key",
        "s3_version_id",
        "source_url",
        "connection_binding_id",
    ):
        assert secret not in response.text
    assert "authorization" not in {key.lower() for key in response.request.headers}

    hidden = client(repository).get(
        f"/public/organizations/{ORGANIZATION_ID}/projects/{PROJECT_ID}/resources/"
        "90000000-0000-4000-8000-000000000069/map-preview"
    )
    assert hidden.status_code == 404
    assert hidden.json() == {"detail": {"code": "public_map_preview_not_found"}}


def test_public_catalog_rejects_unbounded_or_invalid_filters_before_repository_work() -> None:
    repository = FakePublicCatalogRepository()
    api = client(repository)

    assert (
        api.get(
            f"/public/organizations/{ORGANIZATION_ID}/resources",
            params={"limit": 101},
        ).status_code
        == 422
    )
    assert (
        api.get(
            f"/public/organizations/{ORGANIZATION_ID}/resources",
            params={"offset": 10_001},
        ).status_code
        == 422
    )
    assert api.get(
        f"/public/organizations/{ORGANIZATION_ID}/resources",
        params={"bbox": "170,-10,-170,10"},
    ).json() == {"detail": {"code": "public_catalog_bbox_invalid"}}
    assert api.get(
        f"/public/organizations/{ORGANIZATION_ID}/resources",
        params={
            "temporal_start": "2026-09-02T00:00:00Z",
            "temporal_end": "2026-09-01T00:00:00Z",
        },
    ).json() == {"detail": {"code": "public_catalog_temporal_order_invalid"}}
    assert repository.calls == []


def test_public_catalog_failure_is_generic_and_does_not_expose_store_detail() -> None:
    response = client(FailingPublicCatalogRepository()).get(
        f"/public/organizations/{ORGANIZATION_ID}/resources"
    )

    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "public_catalog_unavailable"}}
    assert "password" not in response.text


def test_public_catalog_stops_pagination_at_the_documented_offset_boundary() -> None:
    response = client(BoundaryPublicCatalogRepository()).get(
        f"/public/organizations/{ORGANIZATION_ID}/resources",
        params={"offset": 10_000, "limit": 24},
    )

    assert response.status_code == 200
    assert response.json()["next_offset"] is None
