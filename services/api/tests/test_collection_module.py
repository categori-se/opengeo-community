"""Public gallery delivery owns metadata only; integrated DOM acceptance is separate."""

import json
import subprocess
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from opengeo_api.collection_module import collection_module, public_collection_projection
from opengeo_api.collection_routes import router
from opengeo_api.tenant_database import TenantDatabaseUnavailable
from opengeo_api.workspace_collections import CollectionAccessDenied, CollectionNotFound

ACCOUNT, COLLECTION, RELEASE = UUID(int=1), UUID(int=2), UUID(int=3)
PATH = f"/api/public/organizations/{ACCOUNT}/collections/{COLLECTION}"


def record():
    return {
        "id": str(COLLECTION),
        "title": "<Collection>",
        "description": "Mixed public work",
        "visibility": "public",
        "private_count": 7,
        "owner_id": "hidden",
        "members": [
            {
                "kind": "publication",
                "title": "Published first",
                "description": "Reading",
                "href": f"/public/organizations/{ACCOUNT}/publications/reading",
                "ticket": "private",
            },
            {
                "kind": "project",
                "title": "Map <script>",
                "description": "Map attribution",
                "href": f"/public/organizations/{ACCOUNT}/artifact-releases/{RELEASE}/view",
                "license": "CC0-1.0",
                "source_coordinates": [1, 2],
                "bucket": "private",
            },
        ],
    }


def client(value=None, error=None):
    repository = SimpleNamespace(
        read_public=AsyncMock(return_value=value or record(), side_effect=error)
    )
    app = FastAPI()
    app.state.collection_repository = repository
    app.state.render_repository = object()
    app.state.site_publication_repository = object()
    app.include_router(router, prefix="/api")
    return TestClient(app), repository, app


def assert_public_headers(response):
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["access-control-allow-origin"] == "*"
    assert response.headers["access-control-allow-methods"] == "GET"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "access-control-allow-credentials" not in response.headers
    assert "set-cookie" not in response.headers


def test_public_json_has_credential_free_cors_and_only_existing_ordered_projection():
    peer, repository, app = client()
    response = peer.get(PATH, headers={"Origin": "https://article.example"})
    assert response.status_code == 200
    assert_public_headers(response)
    value = response.json()
    assert [member["kind"] for member in value["members"]] == ["publication", "project"]
    assert value["id"] == str(COLLECTION)
    assert set(value) == {"id", "title", "description", "visibility", "members"}
    assert not any(
        secret in response.text
        for secret in ["private_count", "owner_id", "ticket", "source_coordinates", "bucket"]
    )
    repository.read_public.assert_awaited_once_with(
        ACCOUNT,
        COLLECTION,
        render_repository=app.state.render_repository,
        site_repository=app.state.site_publication_repository,
    )


def test_module_authorizes_once_and_embeds_safe_initial_public_snapshot(tmp_path):
    peer, repository, _ = client()
    response = peer.get(PATH + "/module.mjs", headers={"Origin": "https://article.example"})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/javascript")
    assert_public_headers(response)
    repository.read_public.assert_awaited_once()
    source = response.text
    assert (
        "export function createGallery" in source
        and "export const createView = createGallery" in source
    )
    assert 'export const selectionEvent = "opengeo:collection-select"' in source
    assert "\\u003cCollection\\u003e" in source and "<script>" not in source
    assert "private_count" not in source and "source_coordinates" not in source
    assert 'createElement("iframe")' not in source and 'createElement("img")' not in source
    assert "innerHTML" not in source and 'credentials: "omit"' in source
    assert "show(projection(initial, base))" in source
    module = tmp_path / "collection.mjs"
    module.write_bytes(response.content)
    subprocess.run(["node", "--check", str(module)], check=True, capture_output=True, timeout=10)


@pytest.mark.parametrize("suffix", ["", "/module.mjs"])
@pytest.mark.parametrize(
    "error,status",
    [
        (CollectionNotFound(), 404),
        (CollectionAccessDenied(), 404),
        (TenantDatabaseUnavailable(), 503),
    ],
)
def test_revocation_and_store_errors_keep_public_headers_without_member_leak(suffix, error, status):
    peer, repository, _ = client(error=error)
    response = peer.get(PATH + suffix, headers={"Origin": "https://article.example"})
    assert response.status_code == status
    assert_public_headers(response)
    assert "Published first" not in response.text and "Map attribution" not in response.text
    repository.read_public.assert_awaited_once()


@pytest.mark.parametrize("suffix", ["", "/view"])
def test_legacy_json_and_view_keep_all_members_above_native_gallery_limit(suffix):
    value = record()
    value["members"] = (value["members"] * 101)[:201]
    peer, repository, _ = client(value=value)
    response = peer.get(PATH + suffix)
    assert response.status_code == 200
    if suffix:
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.text.count("<li>") == 201
    else:
        assert_public_headers(response)
        assert len(response.json()["members"]) == 201
        assert "ticket" not in response.json()["members"][0]
    repository.read_public.assert_awaited_once()


def test_native_module_limits_members_before_module_delivery():
    value = record()
    value["members"] = value["members"] * 101
    peer, repository, _ = client(value=value)
    response = peer.get(PATH + "/module.mjs")
    assert response.status_code == 413
    assert_public_headers(response)
    assert response.json() == {"detail": "collection_projection_too_large"}
    repository.read_public.assert_awaited_once()


def test_projection_bounds_encoded_bytes_and_does_not_mutate_repository_record():
    value = record()
    public = public_collection_projection(value)
    assert "private_count" in value and "ticket" in value["members"][0]
    assert public["members"][0]["title"] == "Published first"
    value["description"] = "x" * (1024 * 1024)
    with pytest.raises(ValueError, match="collection_projection_too_large"):
        public_collection_projection(value)
    legacy = public_collection_projection(value, enforce_limits=False)
    assert legacy["description"] == value["description"]
    assert "ticket" not in legacy["members"][0]


def test_generated_initial_projection_cannot_include_private_fields():
    source = collection_module(record()).decode()
    embedded = source.split("const initial = ", 1)[1].split(";\n", 1)[0]
    value = json.loads(embedded)
    assert set(value["members"][1]) == {"kind", "title", "description", "href", "license"}
    assert value["members"][1]["title"] == "Map <script>"


def test_escaped_module_bytes_are_bounded_and_keep_public_error_headers():
    value = record()
    member = {**value["members"][1], "description": "<" * 4800}
    value["members"] = [member] * 200
    assert public_collection_projection(value)
    peer, repository, _ = client(value=value)
    response = peer.get(PATH + "/module.mjs")
    assert response.status_code == 413
    assert_public_headers(response)
    repository.read_public.assert_awaited_once()
