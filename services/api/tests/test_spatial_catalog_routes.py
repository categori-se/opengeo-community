import asyncio
import json
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast
from uuid import UUID

from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.spatial_catalog_admin import (
    CATALOG_LIMITS,
    LayerGroupDraft,
    MetadataDraft,
    PostgresSpatialCatalogRepository,
    SpatialCatalogBulkResult,
    SpatialCatalogSnapshot,
    SpatialServiceCollectionStyle,
    SpatialServiceLayerGroup,
    SpatialServiceMetadata,
    SpatialServiceStore,
    StoreDraft,
    StyleDraft,
)
from opengeo_api.tenant_database import TenantContext

USER_ID = UUID("20000000-0000-4000-8000-000000000168")
ORG_ID = UUID("10000000-0000-4000-8000-000000000168")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000168")
SERVICE_ID = UUID("60000000-0000-4000-8000-000000000168")
STORE_ID = UUID("61000000-0000-4000-8000-000000000168")
COLLECTION_ID = UUID("70000000-0000-4000-8000-000000000168")
STYLE_ID = UUID("a2000000-0000-4000-8000-000000000168")
STYLE_VERSION_ID = UUID("a3000000-0000-4000-8000-000000000168")
PROFILE_ID = UUID("a4000000-0000-4000-8000-000000000168")
PROFILE_VERSION_ID = UUID("a5000000-0000-4000-8000-000000000168")
METADATA_VERSION_ID = UUID("a8000000-0000-4000-8000-000000000168")
GROUP_ID = UUID("a9000000-0000-4000-8000-000000000168")
GROUP_VERSION_ID = UUID("aa000000-0000-4000-8000-000000000168")
STYLE_BINDING_ID = UUID("ab000000-0000-4000-8000-000000000168")
SAME_NAME_BINDING_ID = UUID("ab100000-0000-4000-8000-000000000168")
NOW = datetime(2026, 9, 1, 14, tzinfo=UTC)
CACHE_ID = UUID("ac000000-0000-4000-8000-000000000168")


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
            email="catalog@example.test",
            display_name="Catalog Admin",
            memberships=(OrganizationMembership(ORG_ID, "admin"),),
        )


class MemorySpatialCatalogRepository:
    def __init__(self) -> None:
        self.metadata = SpatialServiceMetadata(
            METADATA_VERSION_ID,
            SERVICE_ID,
            1,
            "Research atlas",
            "Project service metadata",
            "https://example.test/ns/research",
            ("roads",),
            None,
            ("none",),
            {"name": "Catalog Admin"},
            ("wms_1_3", "wfs_2_0"),
            None,
            USER_ID,
            NOW,
        )
        self.store = SpatialServiceStore(
            STORE_ID,
            PROJECT_ID,
            SERVICE_ID,
            "managed",
            "Managed project datasets",
            None,
            "managed_project",
            None,
            None,
            None,
            None,
            {},
            USER_ID,
            NOW,
            None,
            None,
        )
        self.group = SpatialServiceLayerGroup(
            GROUP_ID,
            PROJECT_ID,
            SERVICE_ID,
            "transport",
            GROUP_VERSION_ID,
            1,
            "Transport",
            None,
            "named",
            (COLLECTION_ID,),
            None,
            USER_ID,
            NOW,
            USER_ID,
            NOW,
            None,
            None,
        )
        self.style = SpatialServiceCollectionStyle(
            STYLE_BINDING_ID,
            PROJECT_ID,
            SERVICE_ID,
            COLLECTION_ID,
            "roads-default",
            STYLE_ID,
            STYLE_VERSION_ID,
            1,
            STYLE_VERSION_ID,
            1,
            PROFILE_ID,
            PROFILE_VERSION_ID,
            1,
            PROFILE_VERSION_ID,
            1,
            True,
            USER_ID,
            NOW,
            None,
            None,
        )
        self.calls: list[tuple] = []

    def snapshot(self) -> SpatialCatalogSnapshot:
        return SpatialCatalogSnapshot(self.metadata, (self.store,), (self.group,), (self.style,))

    async def get_catalog(self, context, project_id, service_id):
        self.calls.append(("get_catalog", context, project_id, service_id))
        return self.snapshot()

    async def update_metadata(self, context, project_id, service_id, draft, request_id):
        assert isinstance(draft, MetadataDraft)
        self.calls.append(("update_metadata", context, project_id, service_id, draft, request_id))
        self.metadata = replace(
            self.metadata,
            version_number=draft.expected_version + 1,
            title=draft.title,
            abstract=draft.abstract,
            namespace_uri=draft.namespace_uri,
            keywords=draft.keywords,
            fees=draft.fees,
            access_constraints=draft.access_constraints,
            contact=draft.contact,
            enabled_protocols=draft.enabled_protocols,
            change_message=draft.change_message,
        )
        return self.metadata

    async def create_store(self, context, project_id, service_id, draft, request_id):
        assert isinstance(draft, StoreDraft)
        self.calls.append(("create_store", context, project_id, service_id, draft, request_id))
        self.store = replace(
            self.store,
            slug=draft.slug,
            title=draft.title,
            kind=draft.kind,
            dataset_id=draft.dataset_id,
            external_connection_id=draft.external_connection_id,
            sealed_source_revision_number=draft.sealed_source_revision_number,
            sealed_connection_revision_number=draft.sealed_connection_revision_number,
            configuration=draft.configuration,
        )
        return self.store

    async def disable_store(self, context, project_id, service_id, store_id, request_id):
        self.calls.append(("disable_store", context, project_id, service_id, store_id, request_id))
        self.store = replace(self.store, disabled_by=USER_ID, disabled_at=NOW)
        return self.store

    async def put_layer_group(self, context, project_id, service_id, draft, request_id):
        assert isinstance(draft, LayerGroupDraft)
        self.calls.append(("put_layer_group", context, project_id, service_id, draft, request_id))
        self.group = replace(
            self.group,
            slug=draft.slug,
            version_number=max(1, draft.expected_version + 1),
            title=draft.title,
            description=draft.description,
            mode=draft.mode,
            member_collection_ids=draft.member_collection_ids,
            change_message=draft.change_message,
        )
        return self.group

    async def disable_layer_group(self, context, project_id, service_id, group_id, request_id):
        self.calls.append(
            ("disable_layer_group", context, project_id, service_id, group_id, request_id)
        )
        self.group = replace(self.group, disabled_by=USER_ID, disabled_at=NOW)
        return self.group

    async def assign_style(self, context, project_id, service_id, draft, request_id):
        assert isinstance(draft, StyleDraft)
        self.calls.append(("assign_style", context, project_id, service_id, draft, request_id))
        self.style = replace(
            self.style,
            collection_id=draft.collection_id,
            style_name=draft.style_name,
            style_id=draft.style_id,
            sealed_style_version_number=draft.expected_style_version,
            current_style_version_number=draft.expected_style_version,
            render_profile_id=draft.render_profile_id,
            sealed_profile_version_number=draft.expected_profile_version,
            current_profile_version_number=draft.expected_profile_version,
            is_default=draft.is_default,
        )
        return self.style

    async def withdraw_style(self, context, project_id, service_id, binding_id, request_id):
        self.calls.append(
            ("withdraw_style", context, project_id, service_id, binding_id, request_id)
        )
        self.style = replace(self.style, withdrawn_by=USER_ID, withdrawn_at=NOW)
        return self.style

    async def apply_bulk(self, context, project_id, service_id, operations, request_id):
        self.calls.append(("apply_bulk", context, project_id, service_id, operations, request_id))
        return SpatialCatalogBulkResult(
            len(operations),
            tuple(
                {"position": position, "kind": operation.kind}
                for position, operation in enumerate(operations)
            ),
            self.snapshot(),
        )


class CacheInvalidationTransaction:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, tuple]] = []

    async def fetch_one(self, statement, parameters=()):
        self.calls.append(("fetch_one", statement, tuple(parameters)))
        return (CACHE_ID, 4, 2, 12, 500)

    async def execute(self, statement, parameters=()):
        self.calls.append(("execute", statement, tuple(parameters)))
        return 1


class UnusedExecutor:
    async def run(self, context, operation):
        raise AssertionError("executor is not used by the focused cache invalidation test")


class StyleAssignmentTransaction:
    def __init__(self) -> None:
        self.rows = [
            (UUID("a0000000-0000-4000-8000-000000000168"),),
            (STYLE_VERSION_ID, 1, PROFILE_ID, PROFILE_VERSION_ID, 1),
            (STYLE_BINDING_ID,),
            (SAME_NAME_BINDING_ID,),
            (8,),
            ("inserted",),
        ]
        self.executions: list[tuple[str, tuple]] = []

    async def fetch_one(self, statement, parameters=()):
        del statement, parameters
        assert self.rows
        return self.rows.pop(0)

    async def execute(self, statement, parameters=()):
        self.executions.append((statement, tuple(parameters)))
        return 1


class FocusedStyleAssignmentRepository(PostgresSpatialCatalogRepository):
    def __init__(self) -> None:
        super().__init__(cast(Any, UnusedExecutor()))
        self.invalidated = False

    async def _service(self, *args, **kwargs):
        del args, kwargs
        return ()

    @staticmethod
    def _style_record(row):
        return row

    async def _invalidate_default_style_tile_cache(self, *args, **kwargs):
        del args, kwargs
        self.invalidated = True


def client(repository: MemorySpatialCatalogRepository) -> TestClient:
    return TestClient(
        create_app(
            settings=Settings(env="test", expose_docs=True),
            readiness_probe=PassingProbe(),
            token_verifier=FakeVerifier(),
            principal_repository=FakePrincipalRepository(),
            spatial_catalog_repository=repository,
        )
    )


def headers() -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(ORG_ID),
        "X-Request-ID": "spatial-catalog-request-123",
    }


def base() -> str:
    return f"/projects/{PROJECT_ID}/spatial-services/{SERVICE_ID}/catalog"


def metadata_payload() -> dict:
    return {
        "expected_version": 1,
        "title": "Updated research atlas",
        "abstract": "Updated service metadata",
        "namespace_uri": "https://example.test/ns/updated",
        "keywords": ["roads", "transport"],
        "fees": "none",
        "access_constraints": ["attribution required"],
        "contact": {"name": "Catalog Admin", "email": "catalog@example.test"},
        "enabled_protocols": ["wms_1_3", "wfs_2_0"],
        "change_message": "Review metadata",
    }


def test_catalog_snapshot_is_one_bounded_read_with_explicit_order_semantics() -> None:
    repository = MemorySpatialCatalogRepository()
    response = client(repository).get(base(), headers=headers())
    assert response.status_code == 200
    payload = response.json()
    assert payload["metadata"]["version_number"] == 1
    assert payload["stores"][0]["kind"] == "managed_project"
    assert payload["layer_groups"][0]["member_collection_ids"] == [str(COLLECTION_ID)]
    assert payload["styles"][0]["stale"] is False
    assert payload["limits"] == CATALOG_LIMITS
    assert payload["semantics"]["layerOrder"] == "the first layer-group member draws on top"
    assert repository.calls[0][0] == "get_catalog"


def test_metadata_store_group_and_style_writes_are_strictly_validated() -> None:
    repository = MemorySpatialCatalogRepository()
    api = client(repository)
    metadata = api.put(f"{base()}/metadata", headers=headers(), json=metadata_payload())
    assert metadata.status_code == 200
    assert metadata.json()["version_number"] == 2
    assert metadata.json()["keywords"] == ["roads", "transport"]

    invalid_store = api.post(
        f"{base()}/stores",
        headers=headers(),
        json={
            "slug": "invalid",
            "title": "Invalid",
            "kind": "external_source",
            "configuration": {},
        },
    )
    assert invalid_store.status_code == 422
    store = api.post(
        f"{base()}/stores",
        headers=headers(),
        json={
            "slug": "managed-archive",
            "title": "Managed archive",
            "kind": "managed_project",
            "configuration": {},
        },
    )
    assert store.status_code == 201
    assert store.json()["slug"] == "managed-archive"

    group = api.put(
        f"{base()}/layer-groups/transport",
        headers=headers(),
        json={
            "expected_version": 1,
            "title": "Transport",
            "mode": "named",
            "member_collection_ids": [str(COLLECTION_ID)],
            "change_message": "Keep roads on top",
        },
    )
    assert group.status_code == 200
    assert group.json()["version_number"] == 2

    duplicate = api.put(
        f"{base()}/layer-groups/duplicate",
        headers=headers(),
        json={
            "expected_version": 0,
            "title": "Duplicate",
            "mode": "named",
            "member_collection_ids": [str(COLLECTION_ID), str(COLLECTION_ID)],
        },
    )
    assert duplicate.status_code == 422

    style = api.post(
        f"{base()}/collections/{COLLECTION_ID}/styles",
        headers=headers(),
        json={
            "style_name": "roads-night",
            "style_id": str(STYLE_ID),
            "expected_style_version": 1,
            "render_profile_id": str(PROFILE_ID),
            "expected_profile_version": 1,
            "is_default": True,
        },
    )
    assert style.status_code == 201
    assert style.json()["is_default"] is True
    assert style.json()["consumable"] is True


def test_bulk_route_is_atomic_contract_and_rejects_oversize_operation_sets() -> None:
    repository = MemorySpatialCatalogRepository()
    api = client(repository)
    response = api.post(
        f"{base()}/bulk",
        headers=headers(),
        json={
            "operations": [
                {"operation": "update_metadata", "metadata": metadata_payload()},
                {
                    "operation": "put_layer_group",
                    "slug": "transport",
                    "layer_group": {
                        "expected_version": 1,
                        "title": "Transport",
                        "mode": "named",
                        "member_collection_ids": [str(COLLECTION_ID)],
                    },
                },
            ]
        },
    )
    assert response.status_code == 200
    assert response.json()["applied_operations"] == 2
    call = next(item for item in repository.calls if item[0] == "apply_bulk")
    assert [operation.kind for operation in call[4]] == ["update_metadata", "put_layer_group"]

    operation = {
        "operation": "disable_store",
        "store_id": str(STORE_ID),
    }
    rejected = api.post(
        f"{base()}/bulk",
        headers=headers(),
        json={"operations": [operation] * 65},
    )
    assert rejected.status_code == 422
    assert len([item for item in repository.calls if item[0] == "apply_bulk"]) == 1


def test_resolved_geoserver_plan_crosses_the_strict_atomic_api_boundary() -> None:
    report_path = (
        Path(__file__).resolve().parents[3]
        / "parity"
        / "reports"
        / "geoserver-005-catalog-migration.json"
    )
    report = json.loads(report_path.read_text(encoding="utf8"))
    operations = report["importPlan"]["resolvedBulkOperations"]
    repository = MemorySpatialCatalogRepository()
    response = client(repository).post(
        f"{base()}/bulk", headers=headers(), json={"operations": operations}
    )
    assert response.status_code == 200
    assert response.json()["applied_operations"] == 5
    call = next(item for item in repository.calls if item[0] == "apply_bulk")
    assert [operation.kind for operation in call[4]] == [
        "update_metadata",
        "create_store",
        "put_layer_group",
        "assign_style",
        "assign_style",
    ]
    style_operations = [operation for operation in call[4] if operation.kind == "assign_style"]
    assert [operation.draft.render_profile_id for operation in style_operations] == [
        PROFILE_ID,
        UUID("a4100000-0000-4000-8000-000000000168"),
    ]


def test_catalog_routes_require_current_authentication_before_repository_work() -> None:
    repository = MemorySpatialCatalogRepository()
    response = client(repository).get(base())
    assert response.status_code == 401
    assert repository.calls == []


def test_default_style_change_advances_an_immutable_tile_cache_generation() -> None:
    transaction = CacheInvalidationTransaction()
    repository = PostgresSpatialCatalogRepository(cast(Any, UnusedExecutor()))
    asyncio.run(
        repository._invalidate_default_style_tile_cache(
            cast(Any, transaction),
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            SERVICE_ID,
            COLLECTION_ID,
        )
    )
    assert len(transaction.calls) == 3
    lookup, insert, update = transaction.calls
    assert lookup[0] == "fetch_one"
    assert "FOR UPDATE OF cache" in lookup[1]
    assert lookup[2] == (ORG_ID, PROJECT_ID, SERVICE_ID, COLLECTION_ID)
    assert insert[0] == "execute"
    assert "INSERT INTO app.spatial_tile_cache_versions" in insert[1]
    assert insert[2][0] == update[2][0]
    assert insert[2][1:] == (ORG_ID, CACHE_ID, 5, 2, 12, 500, USER_ID)
    assert "current_version_number = %s" in update[1]
    assert update[2][1:] == (5, USER_ID, ORG_ID, PROJECT_ID, SERVICE_ID, CACHE_ID, 4)


def test_default_style_replacement_is_allowed_at_cap_and_withdraws_name_collision() -> None:
    transaction = StyleAssignmentTransaction()
    repository = FocusedStyleAssignmentRepository()
    result = asyncio.run(
        repository._assign_style(
            cast(Any, transaction),
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            SERVICE_ID,
            StyleDraft(
                COLLECTION_ID,
                "roads-night",
                STYLE_ID,
                1,
                PROFILE_ID,
                1,
                True,
            ),
        )
    )
    assert result == ("inserted",)
    withdrawn = [
        parameters[2]
        for statement, parameters in transaction.executions
        if "SET withdrawn_by" in statement
    ]
    assert set(withdrawn) == {STYLE_BINDING_ID, SAME_NAME_BINDING_ID}
    assert repository.invalidated is True
