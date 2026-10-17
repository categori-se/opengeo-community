from dataclasses import replace
from datetime import UTC, datetime
from uuid import UUID

from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.external_sources import (
    ExternalSource,
    ExternalSourceCapabilities,
    ExternalSourceConflict,
    ExternalSourceRevision,
    ExternalSourceStoreUnavailable,
)
from opengeo_api.tenant_database import TenantContext

USER_ID = UUID("20000000-0000-4000-8000-000000000071")
ORG_ID = UUID("10000000-0000-4000-8000-000000000071")
OTHER_ORG_ID = UUID("10000000-0000-4000-8000-000000000072")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000071")
DATASET_ID = UUID("80000000-0000-4000-8000-000000000071")
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
        assert subject == "subject"
        return Principal(
            user_id=USER_ID,
            subject=subject,
            email="user@example.test",
            display_name="User",
            memberships=(OrganizationMembership(ORG_ID, "member"),),
        )


def xyz_source(*, version: int = 1) -> ExternalSource:
    return ExternalSource(
        dataset_id=DATASET_ID,
        project_id=PROJECT_ID,
        name="Public tiles",
        description="Anonymous public basemap",
        classification="public",
        status="active",
        owner_user_id=USER_ID,
        source_type="xyz",
        access_mode="direct_browser",
        credential_mode="none",
        version_number=version,
        source_url="https://tiles.example.test/{z}/{x}/{y}.png",
        configuration={
            "min_zoom": 0,
            "max_zoom": 20,
            "tile_size": 256,
            "scheme": "xyz",
            "attribution": "Example",
        },
        verification_state="syntax_only",
        created_at=NOW,
        updated_at=NOW,
        capabilities=ExternalSourceCapabilities(True, True),
    )


class FakeSourceRepository:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def list_sources(self, context, project_id, page):
        self.calls.append(("list", context, project_id, page))
        return [xyz_source()]

    async def get_source(self, context, project_id, dataset_id):
        self.calls.append(("get", context, project_id, dataset_id))
        return xyz_source()

    async def list_source_revisions(self, context, project_id, dataset_id, page):
        self.calls.append(("revisions", context, project_id, dataset_id, page))
        source = xyz_source()
        return [
            ExternalSourceRevision(
                dataset_id=source.dataset_id,
                version_number=source.version_number,
                source_url=source.source_url,
                configuration=source.configuration,
                verification_state=source.verification_state,
                change_message="Initial source registration",
                created_by=USER_ID,
                created_at=NOW,
            )
        ]

    async def create_source(self, context, project_id, draft, request_id):
        self.calls.append(("create", context, project_id, draft, request_id))
        return xyz_source()

    async def update_source(self, context, project_id, dataset_id, update, request_id):
        self.calls.append(("update", context, project_id, dataset_id, update, request_id))
        return xyz_source(version=2)


class ConflictingSourceRepository(FakeSourceRepository):
    async def update_source(self, *args, **kwargs):
        del args, kwargs
        raise ExternalSourceConflict("external_source_version_conflict", current_version=7)


class FailingSourceRepository(FakeSourceRepository):
    async def list_sources(self, *args, **kwargs):
        del args, kwargs
        raise ExternalSourceStoreUnavailable("password=must-not-leak")


def api_client(repository: FakeSourceRepository) -> TestClient:
    return TestClient(
        create_app(
            settings=Settings(env="test", expose_docs=True),
            readiness_probe=PassingProbe(),
            token_verifier=FakeVerifier(),
            principal_repository=FakePrincipalRepository(),
            external_source_repository=repository,
        )
    )


def headers(organization_id: UUID = ORG_ID) -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(organization_id),
        "X-Request-ID": "request-source-123",
    }


def xyz_payload(**source_changes):
    return {
        "name": " Public tiles ",
        "description": " Anonymous public basemap ",
        "classification": "public",
        "tags": [" Basemap ", "Public"],
        "source": {
            "type": "xyz",
            "url": "https://tiles.example.test/{z}/{x}/{y}.png",
            "min_zoom": 0,
            "max_zoom": 20,
            "tile_size": 256,
            "scheme": "xyz",
            "attribution": "Example",
            **source_changes,
        },
    }


def test_create_xyz_normalizes_governed_metadata_without_fetching_or_credentials() -> None:
    repository = FakeSourceRepository()
    response = api_client(repository).post(
        f"/projects/{PROJECT_ID}/sources", headers=headers(), json=xyz_payload()
    )

    assert response.status_code == 201
    assert response.json()["dataset_id"] == str(DATASET_ID)
    assert response.json()["access_mode"] == "direct_browser"
    assert response.json()["credential_mode"] == "none"
    assert response.json()["verification_state"] == "syntax_only"
    call = repository.calls[0]
    assert call[1] == TenantContext(USER_ID, ORG_ID)
    assert call[3].name == "Public tiles"
    assert call[3].tags == ("basemap", "public")
    assert call[3].configuration["tile_size"] == 256
    assert call[4] == "request-source-123"


def test_regional_xyz_records_license_coverage_and_coordinate_behavior() -> None:
    repository = FakeSourceRepository()
    response = api_client(repository).post(
        f"/projects/{PROJECT_ID}/sources",
        headers=headers(),
        json=xyz_payload(
            presentation_role="regional_basemap",
            license="CC-BY-4.0",
            coverage_bounds=[80, 26, 89, 31],
            coordinate_behavior="wgs84_web_mercator",
        ),
    )

    assert response.status_code == 201
    configuration = repository.calls[0][3].configuration
    assert configuration["presentation_role"] == "regional_basemap"
    assert configuration["license"] == "CC-BY-4.0"
    assert configuration["coverage_bounds"] == [80.0, 26.0, 89.0, 31.0]
    assert configuration["coordinate_behavior"] == "wgs84_web_mercator"


def test_regional_xyz_rejects_partial_or_unordered_governance_metadata() -> None:
    repository = FakeSourceRepository()
    client = api_client(repository)

    partial = client.post(
        f"/projects/{PROJECT_ID}/sources",
        headers=headers(),
        json=xyz_payload(presentation_role="regional_basemap", license="CC-BY-4.0"),
    )
    unordered = client.post(
        f"/projects/{PROJECT_ID}/sources",
        headers=headers(),
        json=xyz_payload(
            presentation_role="regional_basemap",
            license="CC-BY-4.0",
            coverage_bounds=[89, 31, 80, 26],
            coordinate_behavior="wgs84_web_mercator",
        ),
    )

    assert partial.status_code == 422
    assert unordered.status_code == 422
    assert repository.calls == []


def test_wms_contract_produces_explicit_ogc_parameters() -> None:
    repository = FakeSourceRepository()
    payload = {
        "name": "Boundaries",
        "source": {
            "type": "wms",
            "url": "https://maps.example.test/geoserver/wms",
            "version": "1.3.0",
            "layers": ["public:boundaries"],
            "styles": ["outline"],
            "image_format": "image/png",
            "transparent": True,
            "crs": "EPSG:3857",
            "tile_size": 512,
        },
    }
    response = api_client(repository).post(
        f"/projects/{PROJECT_ID}/sources", headers=headers(), json=payload
    )

    assert response.status_code == 201
    draft = repository.calls[0][3]
    assert draft.source_type == "wms"
    assert draft.configuration == {
        "version": "1.3.0",
        "layers": ["public:boundaries"],
        "styles": ["outline"],
        "format": "image/png",
        "transparent": True,
        "crs": "EPSG:3857",
        "tile_size": 512,
        "attribution": None,
    }


def test_pmtiles_contract_requires_an_explicit_render_shape() -> None:
    repository = FakeSourceRepository()
    response = api_client(repository).post(
        f"/projects/{PROJECT_ID}/sources",
        headers=headers(),
        json={
            "name": "Public archive",
            "source": {
                "type": "pmtiles",
                "url": "https://data.example.test/public.pmtiles",
                "tile_type": "vector",
                "source_layer": "public",
                "geometry_type": "Polygon",
                "min_zoom": 2,
                "max_zoom": 16,
                "attribution": "Example",
            },
        },
    )

    assert response.status_code == 201
    draft = repository.calls[0][3]
    assert draft.source_type == "pmtiles"
    assert draft.source_url == "https://data.example.test/public.pmtiles"
    assert draft.configuration == {
        "tile_type": "vector",
        "source_layer": "public",
        "geometry_type": "Polygon",
        "min_zoom": 2,
        "max_zoom": 16,
        "attribution": "Example",
    }


def test_arcgis_and_wfs_contracts_pin_collection_fields_order_and_page_limits() -> None:
    repository = FakeSourceRepository()
    client = api_client(repository)
    arcgis = client.post(
        f"/projects/{PROJECT_ID}/sources",
        headers=headers(),
        json={
            "name": "Reviewed ArcGIS facilities",
            "source": {
                "type": "arcgis",
                "url": "https://services.example.test/ArcGIS/rest/services/facilities/FeatureServer/0/",
                "object_id_field": "OBJECTID",
                "fields": ["OBJECTID", "name", "category"],
                "geometry_type": "Point",
                "page_size": 1500,
                "attribution": "Example agency",
            },
        },
    )
    wfs = client.post(
        f"/projects/{PROJECT_ID}/sources",
        headers=headers(),
        json={
            "name": "Reviewed WFS parcels",
            "source": {
                "type": "wfs",
                "url": "https://maps.example.test/geoserver/wfs",
                "version": "2.0.0",
                "type_name": "public:parcels",
                "geometry_name": "geom",
                "fields": ["parcel_id", "owner_type"],
                "sort_by": "parcel_id",
                "geometry_type": "MultiPolygon",
                "page_size": 750,
                "attribution": "Example planning office",
            },
        },
    )

    assert arcgis.status_code == 201
    assert wfs.status_code == 201
    arcgis_draft = repository.calls[0][3]
    wfs_draft = repository.calls[1][3]
    assert arcgis_draft.source_type == "arcgis"
    assert arcgis_draft.source_url.endswith("/FeatureServer/0")
    assert arcgis_draft.configuration == {
        "object_id_field": "OBJECTID",
        "fields": ["OBJECTID", "name", "category"],
        "geometry_type": "Point",
        "page_size": 1500,
        "attribution": "Example agency",
    }
    assert wfs_draft.source_type == "wfs"
    assert wfs_draft.configuration == {
        "version": "2.0.0",
        "type_name": "public:parcels",
        "geometry_name": "geom",
        "fields": ["parcel_id", "owner_type"],
        "sort_by": "parcel_id",
        "geometry_type": "MultiPolygon",
        "page_size": 750,
        "attribution": "Example planning office",
    }


def test_feature_source_contracts_reject_ambiguous_or_unstable_collection_shapes() -> None:
    repository = FakeSourceRepository()
    client = api_client(repository)
    invalid_sources = [
        {
            "type": "arcgis",
            "url": "https://services.example.test/ArcGIS/rest/services/facilities/FeatureServer",
            "object_id_field": "OBJECTID",
            "fields": ["OBJECTID"],
            "geometry_type": "Point",
        },
        {
            "type": "arcgis",
            "url": "https://services.example.test/ArcGIS/rest/services/facilities/FeatureServer/0?token=secret",
            "object_id_field": "OBJECTID",
            "fields": ["OBJECTID"],
            "geometry_type": "Point",
        },
        {
            "type": "arcgis",
            "url": "https://services.example.test/ArcGIS/rest/services/facilities/FeatureServer/0",
            "object_id_field": "OBJECTID",
            "fields": ["name", "name"],
            "geometry_type": "Point",
        },
        {
            "type": "wfs",
            "url": "https://maps.example.test/geoserver/wfs?SERVICE=WFS",
            "version": "2.0.0",
            "type_name": "public:parcels",
            "geometry_name": "geom",
            "fields": ["parcel_id"],
            "sort_by": "parcel_id",
            "geometry_type": "Polygon",
        },
        {
            "type": "wfs",
            "url": "https://maps.example.test/geoserver/wfs",
            "version": "2.0.0",
            "type_name": "public:parcels",
            "geometry_name": "geom",
            "fields": ["owner_type"],
            "sort_by": "parcel_id",
            "geometry_type": "Polygon",
        },
        {
            "type": "wfs",
            "url": "https://maps.example.test/geoserver/wfs",
            "version": "2.0.0",
            "type_name": "public:parcels",
            "geometry_name": "geom",
            "fields": ["parcel_id", "geom"],
            "sort_by": "parcel_id",
            "geometry_type": "Polygon",
        },
    ]
    for source in invalid_sources:
        response = client.post(
            f"/projects/{PROJECT_ID}/sources",
            headers=headers(),
            json={"name": "Rejected feature source", "source": source},
        )
        assert response.status_code == 422
    assert repository.calls == []


def test_geojson_archive_contract_pins_integrity_provenance_and_rights() -> None:
    repository = FakeSourceRepository()
    payload = {
        "name": "Reviewed MassGIS archive",
        "classification": "public",
        "source": {
            "type": "geojson",
            "url": "https://s3.us-east-1.amazonaws.com/example-geodata/usa/ma/reviewed.geojson.gz",
            "content_encoding": "gzip",
            "object_sha256": "7e280ab1f9ea003ebf699526d281938182214c2c4acce42524da956e58049bb2",
            "decoded_sha256": "72003a49bbd98780cd4ae6767cb4b45b0951d0f921a5c0e80830db3a2d89dc11",
            "size_bytes": 2_944_146,
            "decoded_size_bytes": 12_430_713,
            "feature_count": 5_109,
            "geometry_type": "MultiPolygon",
            "bounds": [-73.6, 41.1, -69.7, 43.0],
            "attribution": "MassGIS",
            "license": "LicenseRef-Public-Domain",
            "authoritative_url": "https://services1.arcgis.com/example/FeatureServer/0",
            "rights_url": "https://www.mass.gov/info-details/massgis-frequently-asked-questions",
        },
    }

    response = api_client(repository).post(
        f"/projects/{PROJECT_ID}/sources", headers=headers(), json=payload
    )

    assert response.status_code == 201
    draft = repository.calls[0][3]
    assert draft.source_type == "geojson"
    assert draft.source_url.endswith("reviewed.geojson.gz")
    assert draft.configuration == {
        key: value for key, value in payload["source"].items() if key not in {"type", "url"}
    }


def test_geojson_archive_rejects_mismatched_encoding_size_and_private_urls() -> None:
    repository = FakeSourceRepository()
    client = api_client(repository)
    base = {
        "name": "Archive",
        "source": {
            "type": "geojson",
            "url": "https://data.example.test/archive.geojson.gz",
            "content_encoding": "gzip",
            "object_sha256": "1" * 64,
            "decoded_sha256": "2" * 64,
            "size_bytes": 100,
            "decoded_size_bytes": 200,
            "feature_count": 1,
            "geometry_type": "Polygon",
            "bounds": [-73, 41, -69, 43],
            "attribution": "Example",
            "license": "Public domain",
            "authoritative_url": "https://source.example.test/layer",
            "rights_url": "https://source.example.test/rights",
        },
    }
    invalid = []
    for changes in (
        {"content_encoding": "identity"},
        {"decoded_size_bytes": 50},
        {"url": "https://data.example.test/archive.json"},
        {"authoritative_url": "https://127.0.0.1/layer"},
        {"bounds": [-69, 43, -73, 41]},
    ):
        candidate = {**base, "source": {**base["source"], **changes}}
        invalid.append(
            client.post(f"/projects/{PROJECT_ID}/sources", headers=headers(), json=candidate)
        )

    assert all(response.status_code == 422 for response in invalid)
    assert repository.calls == []


def test_adversarial_urls_and_protocol_shapes_fail_before_repository() -> None:
    repository = FakeSourceRepository()
    client = api_client(repository)
    invalid_sources = [
        xyz_payload(url="http://tiles.example.test/{z}/{x}/{y}.png"),
        xyz_payload(url="https://localhost/{z}/{x}/{y}.png"),
        xyz_payload(url="https://127.0.0.1/{z}/{x}/{y}.png"),
        xyz_payload(url="https://user:secret@tiles.example.test/{z}/{x}/{y}.png"),
        xyz_payload(url="https://tiles.example.test/{z}/{x}/{quadkey}.png"),
        xyz_payload(min_zoom=21, max_zoom=20),
        {
            "name": "WMS",
            "source": {
                "type": "wms",
                "url": "https://maps.example.test/wms?service=WMS",
                "layers": ["roads"],
            },
        },
        {
            "name": "WMS",
            "source": {
                "type": "wms",
                "url": "https://maps.example.test/wms",
                "layers": ["roads", "roads"],
            },
        },
        {
            "name": "WMS",
            "source": {
                "type": "wms",
                "url": "https://maps.example.test/wms",
                "layers": ["roads"],
                "image_format": "image/jpeg",
                "transparent": True,
            },
        },
        {
            "name": "PMTiles",
            "source": {
                "type": "pmtiles",
                "url": "https://data.example.test/public.pmtiles?token=secret",
                "tile_type": "vector",
                "source_layer": "public",
                "geometry_type": "Polygon",
            },
        },
        {
            "name": "PMTiles",
            "source": {
                "type": "pmtiles",
                "url": "https://data.example.test/public.pmtiles",
                "tile_type": "vector",
            },
        },
        {
            "name": "PMTiles",
            "source": {
                "type": "pmtiles",
                "url": "https://data.example.test/public.pmtiles",
                "tile_type": "raster",
                "source_layer": "public",
            },
        },
    ]
    for payload in invalid_sources:
        response = client.post(f"/projects/{PROJECT_ID}/sources", headers=headers(), json=payload)
        assert response.status_code == 422
    assert repository.calls == []


def test_list_get_update_and_revision_routes_preserve_tenant_and_cas_context() -> None:
    repository = FakeSourceRepository()
    client = api_client(repository)
    assert client.get(f"/projects/{PROJECT_ID}/sources", headers=headers()).status_code == 200
    assert (
        client.get(
            f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/source", headers=headers()
        ).status_code
        == 200
    )
    update = client.patch(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/source",
        headers=headers(),
        json={
            "expected_version": 1,
            "change_message": "Move to v2 tiles",
            "source": xyz_payload(url="https://tiles.example.test/v2/{z}/{x}/{y}.png")["source"],
        },
    )
    history = client.get(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/source/revisions?limit=20",
        headers=headers(),
    )
    assert update.status_code == 200
    assert update.json()["version_number"] == 2
    assert history.status_code == 200
    assert repository.calls[2][4].expected_version == 1
    assert repository.calls[2][4].change_message == "Move to v2 tiles"
    assert repository.calls[2][4].source_type == "xyz"
    assert repository.calls[2][4].source_url == "https://tiles.example.test/v2/{z}/{x}/{y}.png"
    assert repository.calls[2][4].classification is None
    assert repository.calls[2][4].expected_classification is None
    assert repository.calls[2][4].public_eligibility_reviewed is False
    assert repository.calls[3][4].limit == 20


class ClassificationSourceRepository(FakeSourceRepository):
    async def update_source(self, context, project_id, dataset_id, update, request_id):
        self.calls.append(("update", context, project_id, dataset_id, update, request_id))
        return replace(
            xyz_source(version=update.expected_version), classification=update.classification
        )


def test_classification_only_route_forwards_review_and_preserves_source_version() -> None:
    repository = ClassificationSourceRepository()
    response = api_client(repository).patch(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/source",
        headers=headers(),
        json={
            "expected_version": 1,
            "expected_classification": "internal",
            "classification": "public",
            "public_eligibility_reviewed": True,
        },
    )

    assert response.status_code == 200
    result = response.json()
    assert result["classification"] == "public" and result["version_number"] == 1
    assert result["dataset_id"] == str(DATASET_ID) and result["project_id"] == str(PROJECT_ID)
    assert result["source_url"] == xyz_source().source_url
    assert result["configuration"] == xyz_source().configuration
    assert len(repository.calls) == 1
    call = repository.calls[0]
    assert call[1] == TenantContext(USER_ID, ORG_ID)
    assert call[2:4] == (PROJECT_ID, DATASET_ID)
    update = call[4]
    assert update.source_type is None and update.source_url is None
    assert update.configuration is None and update.change_message is None
    assert update.expected_version == 1 and update.expected_classification == "internal"
    assert update.classification == "public" and update.public_eligibility_reviewed is True
    assert call[5] == "request-source-123"


def test_classification_route_requires_one_reviewed_operation_and_classification_cas() -> None:
    repository = ClassificationSourceRepository()
    client = api_client(repository)
    baseline = {
        "expected_version": 1,
        "expected_classification": "internal",
        "classification": "public",
        "public_eligibility_reviewed": True,
    }
    invalid = [
        {"expected_version": 1},
        {**baseline, "source": xyz_payload()["source"]},
        {key: value for key, value in baseline.items() if key != "expected_classification"},
        {key: value for key, value in baseline.items() if key != "public_eligibility_reviewed"},
        {**baseline, "public_eligibility_reviewed": False},
        {**baseline, "public_eligibility_reviewed": "true"},
        {**baseline, "public_eligibility_reviewed": 1},
        {**baseline, "classification": "unknown"},
    ]
    for payload in invalid:
        response = client.patch(
            f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/source",
            headers=headers(),
            json=payload,
        )
        assert response.status_code == 422, payload
    assert repository.calls == []

    withdrawal = client.patch(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/source",
        headers=headers(),
        json={
            "expected_version": 1,
            "expected_classification": "public",
            "classification": "internal",
        },
    )
    assert withdrawal.status_code == 200
    assert withdrawal.json()["classification"] == "internal"
    assert withdrawal.json()["version_number"] == 1


def test_classification_route_rejects_forged_tenant_before_repository_call() -> None:
    repository = ClassificationSourceRepository()
    response = api_client(repository).patch(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/source",
        headers=headers(OTHER_ORG_ID),
        json={
            "expected_version": 1,
            "expected_classification": "public",
            "classification": "internal",
        },
    )
    assert response.status_code == 403
    assert repository.calls == []


def test_forged_tenant_conflicts_and_failures_are_safe_and_machine_readable() -> None:
    repository = FakeSourceRepository()
    forged = api_client(repository).post(
        f"/projects/{PROJECT_ID}/sources", headers=headers(OTHER_ORG_ID), json=xyz_payload()
    )
    conflict = api_client(ConflictingSourceRepository()).patch(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/source",
        headers=headers(),
        json={"expected_version": 1, "source": xyz_payload()["source"]},
    )
    failed = api_client(FailingSourceRepository()).get(
        f"/projects/{PROJECT_ID}/sources", headers=headers()
    )
    assert forged.status_code == 403
    assert repository.calls == []
    assert conflict.status_code == 409
    assert conflict.json() == {
        "detail": {"code": "external_source_version_conflict", "current_version": 7}
    }
    assert failed.status_code == 503
    assert failed.json() == {"detail": "external_source_store_unavailable"}
    assert "password" not in failed.text


def test_openapi_exposes_governed_source_contracts() -> None:
    paths = api_client(FakeSourceRepository()).get("/openapi.json").json()["paths"]
    assert {
        "/projects/{project_id}/sources",
        "/projects/{project_id}/datasets/{dataset_id}/source",
        "/projects/{project_id}/datasets/{dataset_id}/source/revisions",
    } <= set(paths)


def test_cog_reference_preserves_asset_terms_without_fetch_or_ingestion() -> None:
    class COGRepository(FakeSourceRepository):
        async def create_source(self, context, project_id, draft, request_id):
            result = await super().create_source(context, project_id, draft, request_id)
            return replace(
                result,
                source_type=draft.source_type,
                source_url=draft.source_url,
                configuration=draft.configuration,
            )

    repository = COGRepository()
    metadata = {
        "source": {"asset": {"license": "distribution-terms", "rights": None}},
        "curated": {},
        "inferred": {},
    }
    definition = {
        "type": "cog",
        "url": "https://imagery.example/visual.tif",
        "bands": [1, 2, 3],
        "bounds": [1, 40, 16, 51],
        "size_bytes": 256_914_673,
        "license": "distribution-terms",
        "reference_metadata": metadata,
    }
    response = api_client(repository).post(
        f"/projects/{PROJECT_ID}/sources",
        headers=headers(),
        json={"name": "Reusable scene", "source": definition},
    )
    assert response.status_code == 201
    payload = response.json()
    assert payload["source_type"] == "cog"
    assert payload["access_mode"] == "direct_browser"
    assert payload["credential_mode"] == "none"
    assert payload["verification_state"] == "syntax_only"
    assert payload["configuration"]["reference_metadata"] == metadata
    assert payload["configuration"]["size_bytes"] == 256_914_673
    assert len(repository.calls) == 1
    assert repository.calls[0][2] == PROJECT_ID
    assert repository.calls[0][3].classification == "internal"

    for changes in [
        {"url": "https://127.0.0.1/visual.tif"},
        {"url": "https://imagery.example/visual.tif?X-Amz-Signature=secret"},
        {"bands": [0]},
        {"bands": [1, 2]},
        {"bands": [1, 1, 3]},
        {"bounds": [170, 40, -170, 51]},
        {"reference_metadata": {"body": "x" * 262_145}},
    ]:
        denied = api_client(repository).post(
            f"/projects/{PROJECT_ID}/sources",
            headers=headers(),
            json={"name": "Rejected reference", "source": {**definition, **changes}},
        )
        assert denied.status_code == 422
    assert len(repository.calls) == 1
