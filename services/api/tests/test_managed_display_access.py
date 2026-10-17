import asyncio
from types import SimpleNamespace
from uuid import UUID

import pytest

from opengeo_api.authorization import Action
from opengeo_api.catalog import CatalogAccessDenied, CatalogConflict, CatalogNotFound
from opengeo_api.managed_display_access import ManagedDisplayRepository
from test_layer_archive_access import tiled_descriptor

ORG, PROJECT, DATASET, VERSION, DISPLAY = [UUID(int=n) for n in range(1, 6)]
CONTEXT = SimpleNamespace(organization_id=ORG)


class Catalog:
    def __init__(self):
        self.active = True
        self.allowed = True
        self.queries = []
        self.actions = []
        self.rows = [[DISPLAY, "Display", None, tiled_descriptor()]]

    async def _run(self, context, operation):
        return await operation(self)

    async def _access(self, tx, context, project, dataset):
        assert (context, project, dataset) == (CONTEXT, PROJECT, DATASET)
        if not self.allowed:
            raise CatalogAccessDenied()
        return "authorized"

    def _require(self, action, roles):
        assert roles == "authorized"
        self.actions.append(action)

    async def fetch_one(self, sql, args):
        assert "state='active'" in sql
        assert "app.pmtiles_preserved_original_eligible(" in sql
        assert args == (ORG, DATASET, VERSION, PROJECT)
        return [VERSION] if self.active else None

    async def fetch_all(self, sql, args):
        self.queries.append((sql, args))
        assert "source_version IS NULL AND enabled" in sql
        assert args[:4] == (ORG, PROJECT, DATASET, VERSION)
        return self.rows


def run(operation):
    return asyncio.run(operation)


def test_listing_is_version_bound_without_signing_or_storage():
    catalog = Catalog()
    store = ManagedDisplayRepository(catalog, lambda *args: pytest.fail("storage used"))
    result = run(store.list(CONTEXT, PROJECT, DATASET, VERSION))
    assert result["dataset_version_id"] == VERSION
    assert "source_version" not in result and "objects" not in result["archives"][0]
    assert catalog.actions == [Action.DATASET_VERSION_READ]


@pytest.mark.parametrize("failure", ["denied", "inactive", "absent", "geojson", "too_many"])
def test_fail_closed_before_ticket_issue(failure):
    catalog = Catalog()
    if failure == "denied":
        catalog.allowed = False
    elif failure == "inactive":
        catalog.active = False
    elif failure == "absent":
        catalog.rows = []
    elif failure == "too_many":
        catalog.rows *= 21
    else:
        from test_layer_archive_access import descriptor

        catalog.rows[0][3] = descriptor()
    store = ManagedDisplayRepository(catalog, lambda *args: pytest.fail("storage used"))
    with pytest.raises((CatalogAccessDenied, CatalogNotFound, CatalogConflict)):
        run(store.read_tickets(CONTEXT, PROJECT, DATASET, VERSION, DISPLAY))


@pytest.mark.parametrize("revoked", [False, True])
def test_tickets_require_download_permission_and_reauthorization(revoked):
    catalog = Catalog()
    calls = []

    class Storage:
        def __init__(self, bucket, prefix, owner):
            assert (bucket, prefix, owner) == ("fixture-bucket", "private/", "123456789012")

        def sign_download(self, key, version):
            calls.append((key, version))
            if revoked:
                catalog.allowed = False
            return {"url": "fixture-only"}

    operation = ManagedDisplayRepository(catalog, Storage).read_tickets(
        CONTEXT, PROJECT, DATASET, VERSION, DISPLAY
    )
    if revoked:
        with pytest.raises(CatalogAccessDenied):
            run(operation)
    else:
        result = run(operation)
        assert result["dataset_version_id"] == VERSION
        assert "source_url" not in result
        assert catalog.actions.count(Action.DATASET_DOWNLOAD) == 2
    assert calls == [("private/copy.geojson", "exact-version")]


def test_http_paths_cost_gate_and_private_cache_contract():
    from opengeo_api.managed_display_access import repository
    from test_catalog_routes import (
        ORG_ID,
        USER_ID,
        FakeCatalogRepository,
        api_client,
        headers,
    )

    calls = []

    class Store:
        async def list(self, context, project, dataset, version):
            assert (context.organization_id, context.user_id) == (ORG_ID, USER_ID)
            calls.append((project, dataset, version))
            return {"dataset_id": dataset, "dataset_version_id": version, "archives": []}

        async def read_tickets(self, context, project, dataset, version, display):
            await self.list(context, project, dataset, version)
            assert display == DISPLAY
            return {"objects": []}

    client = api_client(FakeCatalogRepository())
    client.app.dependency_overrides[repository] = Store
    path = f"/projects/{PROJECT}/datasets/{DATASET}/versions/{VERSION}/displays"
    response = client.get(path, headers=headers())
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    for consent in [False, "true", 1, None]:
        response = client.post(
            f"{path}/{DISPLAY}/read",
            headers=headers(),
            json={"acknowledge_storage_cost": consent},
        )
        assert response.status_code == 422
    assert len(calls) == 1
    response = client.post(
        f"{path}/{DISPLAY}/read",
        headers=headers(),
        json={"acknowledge_storage_cost": True},
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert calls == [(PROJECT, DATASET, VERSION)] * 2
    assert client.get(path).status_code == 401


JOB = UUID(int=6)
REVIEW_SHA = "c" * 64


def review_payload(**changes):
    return {
        "expected_review_sha256": REVIEW_SHA,
        "title": "Reviewed tiled display",
        "rights_basis": "Current source license permits this display",
        "attribution": "Fixture source attribution",
        "acknowledge_conversion_limits": True,
        **changes,
    }


def completed_validation():
    return {
        "schema_version": "opengeo.pmtiles-display-validation.1",
        "recipe": "gdal-pmtiles-v1",
        "bounds": [-1, -1, 1, 1],
        "min_zoom": 0,
        "max_zoom": 8,
        "tile_layers": tiled_descriptor()["tile_layers"],
        "output_layer": {"reported_fragment_count": 10},
        "count_semantics": "gdal-reported-tile-fragments-not-source-records",
        "losses": {
            "geometry": "quantized-clipped-simplified-display-not-analysis",
            "attributes": "not-independently-verified-null-values-may-be-omitted",
            "feature_ids": "not-guaranteed-to-retain-source-fids",
            "source_record_count": None,
            "preservation_verified": False,
            "unexpected_storage_fact": "private/loss-must-not-leak",
        },
        "block_sha256": ["a" * 64],
        "block_index_artifact": {"key": "private/index-must-not-leak", "version_id": "secret"},
        "expected_owner": "123456789012",
    }


class ReviewCatalog(Catalog):
    def __init__(self):
        super().__init__()
        self.validation = completed_validation()
        self.review_present = True
        self.manage = True
        self.admitted = False
        self.admission_conflict = False
        self.admission_calls = []

    def _require(self, action, roles):
        super()._require(action, roles)
        if action == Action.PROJECT_DATASETS_MANAGE and not self.manage:
            raise CatalogAccessDenied()

    async def fetch_one(self, sql, args):
        self.queries.append((sql, args))
        if "FROM app.pmtiles_derivative_jobs job" in sql:
            assert args == (ORG, PROJECT, DATASET, VERSION, JOB)
            assert "job.state='completed'" in sql
            assert "version.original_object_id=job.source_object_id" in sql
            assert "lineage.output_object_id=job.output_object_id" in sql
            assert "dataset.source_type='upload'" in sql
            assert "version.state='active'" in sql
            assert "original.s3_version_id=validation.validation->>'source_s3_version_id'" in sql
            if not self.review_present:
                return None
            return [
                REVIEW_SHA,
                self.validation,
                UUID(int=7),
                UUID(int=8),
                None,
                "d" * 64,
                128,
                "a" * 64,
                JOB if self.admitted else None,
            ]
        if "SELECT app.admit_pmtiles_derivative_display(" in sql:
            self.admission_calls.append(args)
            assert args == (
                ORG,
                PROJECT,
                DATASET,
                VERSION,
                JOB,
                REVIEW_SHA,
                "Reviewed tiled display",
                "Current source license permits this display",
                "Fixture source attribution",
                True,
            )
            if self.admission_conflict:
                raise CatalogConflict("catalog_conflict")
            self.admitted = True
            return [JOB]
        assert "FROM app.layer_archive_distributions" in sql
        assert args == (ORG, PROJECT, DATASET, VERSION, JOB, JOB)
        assert "pmtiles_job_id=%s" in sql and "source_version IS NULL AND enabled" in sql
        return [JOB, "Reviewed tiled display", None, tiled_descriptor()]


def test_completed_job_review_is_metadata_only_and_exposes_explicit_losses_not_storage():
    import json

    catalog = ReviewCatalog()
    store = ManagedDisplayRepository(catalog, lambda *args: pytest.fail("storage used"))
    result = run(store.review_pmtiles(CONTEXT, PROJECT, DATASET, VERSION, JOB))
    assert result["review_sha256"] == REVIEW_SHA and result["eligible"] is True
    assert result["source_object_id"] == UUID(int=7) and result["output_object_id"] == UUID(int=8)
    assert result["count_semantics"] == "gdal-reported-tile-fragments-not-source-records"
    assert result["reported_fragment_count"] == 10
    assert result["conversion_limits"]["source_record_count"] is None
    assert result["conversion_limits"]["preservation_verified"] is False
    assert result["display_id"] is None and catalog.admission_calls == []
    serialized = json.dumps(result, default=str)
    for secret in [
        "private/",
        '"version_id":',
        "expected_owner",
        "block_sha256",
        "ticket",
        "bucket",
    ]:
        assert secret not in serialized
    assert catalog.actions == [Action.PROJECT_DATASETS_MANAGE]


@pytest.mark.parametrize("operation", ["review", "admit"])
@pytest.mark.parametrize("failure", ["no_access", "no_management", "no_current_exact_review"])
def test_completed_review_requires_current_management_and_exact_completed_identity(
    operation, failure
):
    from opengeo_api.managed_display_access import ReviewPmtilesDisplayRequest

    catalog = ReviewCatalog()
    if failure == "no_access":
        catalog.allowed = False
    elif failure == "no_management":
        catalog.manage = False
    else:
        catalog.review_present = False
    store = ManagedDisplayRepository(catalog, lambda *args: pytest.fail("storage used"))
    call = (
        store.review_pmtiles(CONTEXT, PROJECT, DATASET, VERSION, JOB)
        if operation == "review"
        else store.admit_pmtiles(
            CONTEXT,
            PROJECT,
            DATASET,
            VERSION,
            JOB,
            ReviewPmtilesDisplayRequest.model_validate(review_payload()),
        )
    )
    with pytest.raises((CatalogAccessDenied, CatalogNotFound)):
        run(call)
    assert catalog.admission_calls == []


def test_incompatible_completed_output_retains_review_but_cannot_be_admitted():
    from opengeo_api.managed_display_access import ReviewPmtilesDisplayRequest

    catalog = ReviewCatalog()
    catalog.validation["tile_layers"] = []
    catalog.validation["output_layer"]["reported_fragment_count"] = 20_000_000
    store = ManagedDisplayRepository(catalog, lambda *args: pytest.fail("storage used"))
    result = run(store.review_pmtiles(CONTEXT, PROJECT, DATASET, VERSION, JOB))
    assert result["eligible"] is False and result["reported_fragment_count"] == 20_000_000
    with pytest.raises(CatalogConflict):
        run(
            store.admit_pmtiles(
                CONTEXT,
                PROJECT,
                DATASET,
                VERSION,
                JOB,
                ReviewPmtilesDisplayRequest.model_validate(review_payload()),
            )
        )
    assert catalog.admission_calls == []


def test_review_digest_cas_and_database_admission_conflict_stop_without_storage():
    from opengeo_api.managed_display_access import ReviewPmtilesDisplayRequest

    catalog = ReviewCatalog()
    store = ManagedDisplayRepository(catalog, lambda *args: pytest.fail("storage used"))
    with pytest.raises(CatalogConflict):
        run(
            store.admit_pmtiles(
                CONTEXT,
                PROJECT,
                DATASET,
                VERSION,
                JOB,
                ReviewPmtilesDisplayRequest.model_validate(
                    review_payload(expected_review_sha256="e" * 64)
                ),
            )
        )
    assert catalog.admission_calls == []
    catalog.admission_conflict = True
    with pytest.raises(CatalogConflict):
        run(
            store.admit_pmtiles(
                CONTEXT,
                PROJECT,
                DATASET,
                VERSION,
                JOB,
                ReviewPmtilesDisplayRequest.model_validate(review_payload()),
            )
        )
    assert len(catalog.admission_calls) == 1


def test_admission_only_calls_narrow_sql_and_returns_metadata_with_idempotent_identity():
    from opengeo_api.managed_display_access import ReviewPmtilesDisplayRequest

    catalog = ReviewCatalog()
    store = ManagedDisplayRepository(catalog, lambda *args: pytest.fail("storage used"))
    payload = ReviewPmtilesDisplayRequest.model_validate(review_payload())
    first = run(store.admit_pmtiles(CONTEXT, PROJECT, DATASET, VERSION, JOB, payload))
    second = run(store.admit_pmtiles(CONTEXT, PROJECT, DATASET, VERSION, JOB, payload))
    assert first == second and first["display_id"] == JOB
    assert "objects" not in first["display"]
    assert catalog.actions == [Action.PROJECT_DATASETS_MANAGE] * 2
    assert len(catalog.admission_calls) == 2
    catalog.manage = False
    with pytest.raises(CatalogAccessDenied):
        run(store.admit_pmtiles(CONTEXT, PROJECT, DATASET, VERSION, JOB, payload))
    assert len(catalog.admission_calls) == 2


def test_http_completed_review_validates_only_deliberate_review_input_and_no_store():
    from opengeo_api.managed_display_access import repository
    from test_catalog_routes import (
        ORG_ID,
        USER_ID,
        FakeCatalogRepository,
        api_client,
        headers,
    )

    calls = []

    class Store:
        async def review_pmtiles(self, context, project, dataset, version, job):
            assert (context.organization_id, context.user_id) == (ORG_ID, USER_ID)
            assert (project, dataset, version, job) == (PROJECT, DATASET, VERSION, JOB)
            calls.append("get")
            return {"review_sha256": REVIEW_SHA, "eligible": True}

        async def admit_pmtiles(self, context, project, dataset, version, job, payload):
            await self.review_pmtiles(context, project, dataset, version, job)
            assert payload.expected_review_sha256 == REVIEW_SHA
            calls.append("post")
            return {"display_id": JOB}

    client = api_client(FakeCatalogRepository())
    client.app.dependency_overrides[repository] = Store
    path = (
        f"/projects/{PROJECT}/datasets/{DATASET}/versions/{VERSION}"
        f"/pmtiles-derivatives/{JOB}/display-review"
    )
    response = client.get(path, headers=headers())
    assert response.status_code == 200 and response.headers["cache-control"] == "private, no-store"
    for changes in [
        {"acknowledge_conversion_limits": value} for value in [False, "true", 1, None]
    ] + [
        {"bucket": "injected"},
        {"key": "private/injected"},
        {"ticket": "injected"},
        {"descriptor": {}},
        {"block_sha256": ["a" * 64]},
        {"expected_review_sha256": "not-a-digest"},
        {"title": " "},
        {"title": "bad\ntitle"},
        {"title": " untrimmed"},
        {"rights_basis": ""},
        {"attribution": " "},
    ]:
        assert (
            client.post(path, headers=headers(), json=review_payload(**changes)).status_code == 422
        )
    assert calls == ["get"]
    response = client.post(path, headers=headers(), json=review_payload())
    assert response.status_code == 200 and response.headers["cache-control"] == "private, no-store"
    assert response.json() == {"display_id": str(JOB)} and calls == ["get", "get", "post"]
    assert client.get(path).status_code == 401
    assert client.post(path, json=review_payload()).status_code == 401
