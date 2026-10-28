import asyncio
from copy import deepcopy
from datetime import UTC, datetime
from uuid import UUID

import pytest
from fastapi import HTTPException

from opengeo_api.auth_models import AuthSession, OrganizationMembership, Principal
from opengeo_api.ingestion import (
    IngestionAccessDenied,
    IngestionNotFound,
    IngestionStoreUnavailable,
)
from opengeo_api.mcp_tools import execute_read_tool, tool_definitions
from opengeo_api.resource_knowledge import empty_knowledge
from opengeo_api.tenant_database import TenantContext
from opengeo_api.workspaces import (
    CompositionSummary,
    MapRecord,
    Page,
    WorkspaceAccessDenied,
    WorkspaceNotFound,
    WorkspaceStoreUnavailable,
)

USER = UUID("20000000-0000-4000-8000-000000000001")
ORG = UUID("10000000-0000-4000-8000-000000000001")
OTHER = UUID("10000000-0000-4000-8000-000000000002")
DATASET = UUID("80000000-0000-4000-8000-000000000001")
CONTAINER = UUID("50000000-0000-4000-8000-000000000001")
COMPOSITION = UUID("60000000-0000-4000-8000-000000000001")
NOW = datetime(2026, 10, 28, tzinfo=UTC)
MEMBERSHIP = OrganizationMembership(ORG, "member")
SESSION = AuthSession(
    Principal(USER, "subject", "user@example.test", "Reader", (MEMBERSHIP,)), MEMBERSHIP
)


class Repositories:
    def __init__(self):
        self.calls = []
        self.error = None
        self.layers = [
            {
                "dataset_id": DATASET,
                "dataset_name": "Retained layer",
                "project_id": CONTAINER,
                "project_name": "Access storage",
                "format": "geojson",
                "classification": "internal",
                "source_type": "upload",
                "updated_at": NOW,
                "map_id": COMPOSITION,
                "map_version": 3,
                "layer_id": "presentation-local-id",
                "title": "Saved Layer",
                "description": None,
                "style_field": None,
                "legend": None,
                "geometry_type": "Polygon",
                "style_key": None,
                "service": None,
            }
        ]
        self.metadata = {
            "dataset_id": DATASET,
            "version": 0,
            "document": empty_knowledge(),
            "created_by": None,
            "created_at": None,
            "can_edit": False,
        }
        self.projects = [
            CompositionSummary(
                COMPOSITION,
                CONTAINER,
                "Access storage",
                "Saved Project",
                None,
                "active",
                3,
                NOW,
                USER,
            )
        ]
        self.project = MapRecord(
            COMPOSITION,
            CONTAINER,
            "Saved Project",
            None,
            "active",
            {
                "layers": [
                    {
                        "layerId": "presentation-local-id",
                        "datasetId": str(DATASET),
                        "sourceVersion": 2,
                        "visible": True,
                    }
                ],
                "metadata": {"rights": None},
            },
            3,
            NOW,
            NOW,
            USER,
        )

    def record(self, *args):
        self.calls.append(args)
        if self.error:
            raise self.error

    async def search_layers(self, context, **filters):
        self.record("search_layers", context, filters)
        return self.layers

    async def get_dataset_knowledge(self, context, dataset_id, version):
        self.record("get_dataset_knowledge", context, dataset_id, version)
        return self.metadata

    async def list_compositions(self, context, page, query, status):
        self.record("list_compositions", context, page, query, status)
        return self.projects

    async def get_composition(self, context, composition_id):
        self.record("get_composition", context, composition_id)
        return self.project


def execute(repositories, name, arguments, session=SESSION):
    return asyncio.run(
        execute_read_tool(
            session,
            name,
            arguments,
            ingestion_repository=repositories,
            workspace_repository=repositories,
        )
    )


def test_definitions_are_detached_strict_read_only_schemas():
    definitions = tool_definitions()
    assert [item["name"] for item in definitions] == [
        "search_catalog_layers",
        "get_layer_metadata",
        "list_projects",
        "get_project",
    ]
    for item in definitions:
        assert item["inputSchema"]["additionalProperties"] is False
        assert item["annotations"] == {
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": False,
        }
        assert not {"organization_id", "account_id", "user_id", "role", "url", "sql"} & set(
            item["inputSchema"]["properties"]
        )
    assert definitions[0]["inputSchema"]["properties"]["offset"]["maximum"] == 100_000
    assert definitions[2]["inputSchema"]["properties"]["offset"]["maximum"] == 10_000
    assert definitions[1]["inputSchema"]["required"] == ["dataset_id"]
    definitions[0]["inputSchema"]["properties"].clear()
    assert tool_definitions()[0]["inputSchema"]["properties"]["query"]["maxLength"] == 200


def test_catalog_uses_one_authorized_repository_page_and_keeps_resource_and_presentation_ids():
    repositories = Repositories()
    result = execute(
        repositories, "search_catalog_layers", {"query": "Saved", "limit": 100, "offset": 100_000}
    )
    assert repositories.calls == [
        (
            "search_layers",
            TenantContext(USER, ORG),
            {"query": "Saved", "limit": 100, "offset": 100_000},
        )
    ]
    assert result["layers"][0]["dataset_id"] == str(DATASET)
    assert result["layers"][0]["layer_id"] == "presentation-local-id"
    assert result["layers"][0]["map_id"] == str(COMPOSITION)
    assert result["layers"][0]["service"] is None
    assert "rights" not in result["layers"][0]
    assert result["returned"] == 1
    assert result["limit"] == 100


def test_metadata_keeps_unknowns_custody_rights_and_provenance_without_promoting_claims():
    repositories = Repositories()
    unknown = execute(repositories, "get_layer_metadata", {"dataset_id": str(DATASET)})
    assert unknown["version"] == 0
    assert unknown["document"] == empty_knowledge()
    document = empty_knowledge()
    document["distributions"] = [
        {"id": "urn:distribution:source", "custody": "referenced"},
        {"id": "urn:distribution:unknown", "custody": None},
    ]
    document["metadata"]["source"] = [
        {
            "subject": "urn:distribution:source",
            "property": "http://purl.org/dc/terms/license",
            "value": None,
            "provenance": "unknown",
        }
    ]
    repositories.metadata.update(version=4, document=document)
    before = deepcopy(repositories.metadata)
    result = execute(repositories, "get_layer_metadata", {"dataset_id": str(DATASET), "version": 4})
    assert repositories.calls[-1] == ("get_dataset_knowledge", TenantContext(USER, ORG), DATASET, 4)
    assert result["document"] == document
    assert result["can_edit"] is False
    assert repositories.metadata == before
    result["document"]["distributions"].clear()
    assert repositories.metadata == before


def test_projects_use_canonical_composition_repositories_and_preserve_access_container_separation():
    repositories = Repositories()
    result = execute(
        repositories,
        "list_projects",
        {"query": " Saved ", "status": "all", "limit": 1, "offset": 10_000},
    )
    assert repositories.calls == [
        ("list_compositions", TenantContext(USER, ORG), Page(1, 10_000), "Saved", None)
    ]
    assert result["projects"][0]["id"] == str(COMPOSITION)
    assert result["projects"][0]["resource_type"] == "project"
    assert result["projects"][0]["access_container_id"] == str(CONTAINER)
    result = execute(repositories, "get_project", {"composition_id": str(COMPOSITION)})
    assert repositories.calls[-1] == ("get_composition", TenantContext(USER, ORG), COMPOSITION)
    assert result["id"] == str(COMPOSITION)
    assert result["access_container_id"] == str(CONTAINER)
    assert "project_id" not in result
    assert result["definition"] == repositories.project.definition
    assert result["definition"]["layers"][0]["datasetId"] == str(DATASET)
    assert len(repositories.calls) == 2


@pytest.mark.parametrize(
    ("name", "arguments"),
    [
        ("search_catalog_layers", {"query": "x" * 201}),
        ("search_catalog_layers", {"limit": True}),
        ("search_catalog_layers", {"limit": 0}),
        ("search_catalog_layers", {"limit": 101}),
        ("search_catalog_layers", {"limit": "2"}),
        ("search_catalog_layers", {"offset": 100_001}),
        ("search_catalog_layers", {"organization_id": str(OTHER)}),
        ("search_catalog_layers", {"account_id": str(OTHER)}),
        ("get_layer_metadata", {}),
        ("get_layer_metadata", {"dataset_id": "not-a-uuid"}),
        ("get_layer_metadata", {"dataset_id": str(DATASET), "version": 0}),
        ("get_layer_metadata", {"dataset_id": str(DATASET), "version": None}),
        ("get_layer_metadata", {"dataset_id": str(DATASET), "version": True}),
        ("get_layer_metadata", {"dataset_id": str(DATASET), "version": 2_147_483_648}),
        ("list_projects", {"status": "deleted"}),
        ("list_projects", {"offset": -1}),
        ("list_projects", {"offset": 10_001}),
        ("get_project", {"project_id": str(CONTAINER)}),
        ("get_project", {"composition_id": str(COMPOSITION), "user_id": str(USER)}),
        ("get_project", {"composition_id": str(COMPOSITION), "url": "https://example.test"}),
        ("run_sql", {"sql": "SELECT 1"}),
        ("create_project", {"name": "Forbidden write"}),
    ],
)
def test_invalid_authority_mutation_and_unbounded_arguments_never_call_repositories(
    name, arguments
):
    repositories = Repositories()
    with pytest.raises(HTTPException) as error:
        execute(repositories, name, arguments)
    assert error.value.status_code == 422
    assert error.value.detail in {"mcp_tool_arguments_invalid", "mcp_tool_not_found"}
    assert repositories.calls == []


@pytest.mark.parametrize(
    ("session", "status"),
    [
        (None, 401),
        (AuthSession(SESSION.principal, None), 409),
        (AuthSession(SESSION.principal, OrganizationMembership(OTHER, "admin")), 403),
    ],
)
def test_missing_or_forged_session_scope_never_calls_repositories(session, status):
    repositories = Repositories()
    with pytest.raises(HTTPException) as error:
        execute(repositories, "search_catalog_layers", {}, session)
    assert error.value.status_code == status
    assert repositories.calls == []


@pytest.mark.parametrize(
    ("name", "arguments", "raised", "status", "detail"),
    [
        (
            "search_catalog_layers",
            {},
            IngestionAccessDenied("private SQL"),
            403,
            "action_forbidden",
        ),
        (
            "get_layer_metadata",
            {"dataset_id": str(DATASET)},
            IngestionNotFound("dataset"),
            404,
            "dataset_not_found",
        ),
        (
            "get_layer_metadata",
            {"dataset_id": str(DATASET)},
            IngestionStoreUnavailable("private host"),
            503,
            "ingestion_store_unavailable",
        ),
        ("list_projects", {}, WorkspaceAccessDenied("private SQL"), 403, "action_forbidden"),
        (
            "get_project",
            {"composition_id": str(COMPOSITION)},
            WorkspaceNotFound("map"),
            404,
            "map_not_found",
        ),
        (
            "get_project",
            {"composition_id": str(COMPOSITION)},
            WorkspaceStoreUnavailable("private host"),
            503,
            "workspace_store_unavailable",
        ),
    ],
)
def test_existing_repository_access_and_availability_errors_are_preserved_and_sanitized(
    name, arguments, raised, status, detail
):
    repositories = Repositories()
    repositories.error = raised
    with pytest.raises(HTTPException) as error:
        execute(repositories, name, arguments)
    assert error.value.status_code == status
    assert error.value.detail == detail
    assert len(repositories.calls) == 1
    assert repositories.calls[0][1] == TenantContext(USER, ORG)


@pytest.mark.parametrize(
    "name", ["search_catalog_layers", "get_layer_metadata", "list_projects", "get_project"]
)
def test_results_are_bounded_by_utf8_bytes_without_truncation_or_followup_queries(name):
    repositories = Repositories()
    arguments = {}
    if name == "search_catalog_layers":
        repositories.layers[0]["legend"] = {"text": "界" * 90_000}
    elif name == "get_layer_metadata":
        repositories.metadata["document"] = {"source": "界" * 17_000}
        arguments = {"dataset_id": str(DATASET)}
    elif name == "list_projects":
        from dataclasses import replace

        repositories.projects[0] = replace(repositories.projects[0], description="界" * 90_000)
    else:
        repositories.project.definition["text"] = "界" * 180_000
        arguments = {"composition_id": str(COMPOSITION)}
    with pytest.raises(HTTPException) as error:
        execute(repositories, name, arguments)
    assert error.value.status_code == 413
    assert error.value.detail == "mcp_result_too_large"
    assert len(repositories.calls) == 1


@pytest.mark.parametrize("name", ["search_catalog_layers", "list_projects"])
def test_repository_cannot_return_more_records_than_requested(name):
    repositories = Repositories()
    if name == "search_catalog_layers":
        repositories.layers *= 2
    else:
        repositories.projects *= 2
    with pytest.raises(HTTPException) as error:
        execute(repositories, name, {"limit": 1})
    assert error.value.status_code == 503
    assert error.value.detail == "mcp_repository_result_invalid"
    assert len(repositories.calls) == 1
