from datetime import UTC, datetime
from uuid import UUID

from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.project_imports import (
    ProjectImport,
    ProjectImportConflict,
    ProjectImportItem,
)

USER_ID = UUID("20000000-0000-4000-8000-000000000081")
ORG_ID = UUID("10000000-0000-4000-8000-000000000081")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000081")
MAP_ID = UUID("60000000-0000-4000-8000-000000000081")
IMPORT_ID = UUID("90000000-0000-4000-8000-000000000081")
IDEMPOTENCY_KEY = UUID("91000000-0000-4000-8000-000000000081")
DATASET_ID = UUID("80000000-0000-4000-8000-000000000081")
NOW = datetime(2026, 8, 20, 14, tzinfo=UTC)


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


def imported(*, bound: bool = False, completed: bool = False) -> ProjectImport:
    return ProjectImport(
        import_id=IMPORT_ID,
        project_id=PROJECT_ID,
        map_id=MAP_ID,
        idempotency_key=IDEMPOTENCY_KEY,
        source_product="geolibre",
        source_version="2.6.0",
        source_sha256="a" * 64,
        plan_digest="b" * 64,
        expected_map_version=3,
        state="completed" if completed else "open",
        items=(
            ProjectImportItem(
                import_ref="geolibre:embedded",
                kind="embedded_dataset",
                expected_source_type="upload",
                expected_format="geojson",
                candidate={"filename": "embedded.geojson", "checksumSha256": "c" * 64},
                state="bound" if bound or completed else "pending",
                dataset_id=DATASET_ID if bound or completed else None,
                bound_at=NOW if bound or completed else None,
            ),
        ),
        created_by=USER_ID,
        created_at=NOW,
        updated_at=NOW,
        completed_at=NOW if completed else None,
        final_map_version=4 if completed else None,
    )


class FakeImportRepository:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def create_import(self, context, project_id, draft, request_id):
        self.calls.append(("create", context, project_id, draft, request_id))
        return imported()

    async def get_import(self, context, project_id, import_id):
        self.calls.append(("get", context, project_id, import_id))
        return imported()

    async def bind_dataset(
        self, context, project_id, import_id, import_ref, dataset_id, request_id
    ):
        self.calls.append(
            ("bind", context, project_id, import_id, import_ref, dataset_id, request_id)
        )
        return imported(bound=True)

    async def finalize_import(self, context, project_id, import_id, request_id):
        self.calls.append(("finalize", context, project_id, import_id, request_id))
        return imported(completed=True)


class ConflictingImportRepository(FakeImportRepository):
    async def finalize_import(self, *args, **kwargs):
        del args, kwargs
        raise ProjectImportConflict("map_version_conflict", current_version=7)


def api_client(repository: FakeImportRepository) -> TestClient:
    return TestClient(
        create_app(
            settings=Settings(env="test", expose_docs=True),
            readiness_probe=PassingProbe(),
            token_verifier=FakeVerifier(),
            principal_repository=FakePrincipalRepository(),
            project_import_repository=repository,
        )
    )


def headers() -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(ORG_ID),
        "X-Request-ID": "request-import-123",
    }


def import_payload() -> dict:
    return {
        "idempotency_key": str(IDEMPOTENCY_KEY),
        "map_id": str(MAP_ID),
        "expected_map_version": 3,
        "source_product": "geolibre",
        "source_version": "2.6.0",
        "source_sha256": "A" * 64,
        "plan_digest": "B" * 64,
        "map_definition": {
            "schemaVersion": "opengeo.map-definition.1.3.0",
            "mapViews": [],
            "basemaps": [],
            "bookmarks": [],
            "activeLayerId": "archive",
            "activeProcessingModelId": None,
            "models": [],
            "processingHistory": [],
            "measurements": [],
            "projection": "mercator",
            "colorMode": "dark",
            "layers": [
                {
                    "layerId": "archive",
                    "datasetId": "import:archive",
                    "importRef": "geolibre:archive",
                    "title": "Public archive",
                    "sourceType": "pmtiles-vector",
                    "sourceUrl": "https://data.example.test/public.pmtiles",
                    "sourceConfiguration": {
                        "tileType": "vector",
                        "sourceLayer": "public",
                        "geometryType": "Polygon",
                        "minZoom": 0,
                        "maxZoom": 14,
                        "attribution": None,
                    },
                    "visible": True,
                    "opacity": 1,
                    "order": 0,
                    "style": {},
                    "labels": {"enabled": False, "field": None},
                },
                {
                    "layerId": "embedded",
                    "datasetId": "import:embedded",
                    "objectId": "pending-import:embedded",
                    "importRef": "geolibre:embedded",
                    "title": "Embedded",
                    "sourceType": "geojson-object",
                    "visible": True,
                    "opacity": 1,
                    "order": 1,
                    "style": {},
                    "labels": {"enabled": False, "field": None},
                },
            ],
        },
        "conversion_report": {"schemaVersion": "1.0.0", "summary": {"status": "lossless"}},
        "external_sources": [
            {
                "import_ref": "geolibre:archive",
                "name": "Public archive",
                "tags": ["geolibre", "pmtiles"],
                "source": {
                    "type": "pmtiles",
                    "url": "https://data.example.test/public.pmtiles",
                    "tile_type": "vector",
                    "source_layer": "public",
                    "geometry_type": "Polygon",
                    "min_zoom": 0,
                    "max_zoom": 14,
                },
            }
        ],
        "embedded_datasets": [
            {
                "import_ref": "geolibre:embedded",
                "name": "Embedded",
                "format": "geojson",
                "filename": "embedded.geojson",
                "content_type": "application/geo+json",
                "size_bytes": 128,
                "checksum_sha256": "C" * 64,
                "tags": ["geolibre"],
            }
        ],
    }


def test_create_validates_exact_plan_and_normalizes_candidates() -> None:
    repository = FakeImportRepository()
    response = api_client(repository).post(
        f"/projects/{PROJECT_ID}/imports", headers=headers(), json=import_payload()
    )

    assert response.status_code == 201
    assert response.json()["unresolved_import_refs"] == ["geolibre:embedded"]
    draft = repository.calls[0][3]
    assert draft.source_sha256 == "a" * 64
    assert draft.external_sources[0].configuration["tile_type"] == "vector"
    assert draft.external_sources[0].source_url.endswith("public.pmtiles")
    assert draft.embedded_datasets[0].checksum_sha256 == "c" * 64


def test_create_accepts_reviewed_renderer_reference_without_widening_versions() -> None:
    repository = FakeImportRepository()
    payload = import_payload()
    payload["source_version"] = "3.0.0"
    payload["map_definition"]["extensions"] = {"opengeoRenderer": {"id": "cesium"}}
    client = api_client(repository)
    response = client.post(f"/projects/{PROJECT_ID}/imports", headers=headers(), json=payload)
    assert response.status_code == 201
    draft = repository.calls[0][3]
    assert draft.source_version == "3.0.0"
    assert draft.map_definition["extensions"]["opengeoRenderer"] == {"id": "cesium"}

    repository.calls.clear()
    payload["source_version"] = "9.0.0"
    assert (
        client.post(f"/projects/{PROJECT_ID}/imports", headers=headers(), json=payload).status_code
        == 422
    )
    assert repository.calls == []


def test_create_rejects_unmatched_or_unsafe_candidates_before_repository() -> None:
    repository = FakeImportRepository()
    unmatched = import_payload()
    unmatched["map_definition"]["layers"][0]["importRef"] = "geolibre:not-in-plan"
    unsafe = import_payload()
    unsafe["external_sources"][0]["source"]["url"] = "https://127.0.0.1/public.pmtiles"

    assert (
        api_client(repository)
        .post(f"/projects/{PROJECT_ID}/imports", headers=headers(), json=unmatched)
        .status_code
        == 422
    )
    assert (
        api_client(repository)
        .post(f"/projects/{PROJECT_ID}/imports", headers=headers(), json=unsafe)
        .status_code
        == 422
    )
    assert repository.calls == []


def test_get_bind_and_finalize_expose_recovery_and_atomic_completion() -> None:
    repository = FakeImportRepository()
    client = api_client(repository)
    fetched = client.get(f"/projects/{PROJECT_ID}/imports/{IMPORT_ID}", headers=headers())
    bound = client.put(
        f"/projects/{PROJECT_ID}/imports/{IMPORT_ID}/items/geolibre:embedded/dataset",
        headers=headers(),
        json={"dataset_id": str(DATASET_ID)},
    )
    finalized = client.post(
        f"/projects/{PROJECT_ID}/imports/{IMPORT_ID}/finalize", headers=headers()
    )

    assert fetched.json()["ready"] is False
    assert bound.json()["ready"] is True
    assert finalized.json()["state"] == "completed"
    assert finalized.json()["final_map_version"] == 4
    assert repository.calls[1][4] == "geolibre:embedded"


def test_map_conflict_is_machine_readable_and_operation_remains_recoverable() -> None:
    response = api_client(ConflictingImportRepository()).post(
        f"/projects/{PROJECT_ID}/imports/{IMPORT_ID}/finalize", headers=headers()
    )
    assert response.status_code == 409
    assert response.json() == {"detail": {"code": "map_version_conflict", "current_version": 7}}


def test_openapi_exposes_project_import_recovery_contract() -> None:
    paths = api_client(FakeImportRepository()).get("/openapi.json").json()["paths"]
    assert {
        "/projects/{project_id}/imports",
        "/projects/{project_id}/imports/{import_id}",
        "/projects/{project_id}/imports/{import_id}/items/{import_ref}/dataset",
        "/projects/{project_id}/imports/{import_id}/finalize",
    } <= set(paths)
