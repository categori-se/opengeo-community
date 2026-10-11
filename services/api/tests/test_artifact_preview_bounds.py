import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import UUID

from fastapi import HTTPException, Request

from opengeo_api.artifact_release_routes import (
    public_release_map,
    public_release_module,
    public_release_preview,
)
from opengeo_api.collection_routes import public_collection_view


def test_oversized_preview_is_rejected_before_storage():
    storage = SimpleNamespace(read_exact_object=AsyncMock())
    request = Request(
        {"type": "http", "app": SimpleNamespace(state=SimpleNamespace(download_storage=storage))}
    )
    target = [None] * 13
    target[11] = 1024 * 1024 + 1
    with patch("opengeo_api.artifact_release_routes._public", AsyncMock(return_value=({}, target))):
        try:
            asyncio.run(public_release_preview(UUID(int=1), UUID(int=2), request))
        except HTTPException as error:
            assert error.status_code == 404
            assert error.headers["Cache-Control"] == "no-store"
        else:
            raise AssertionError("oversized image accepted")
    storage.read_exact_object.assert_not_awaited()


def test_release_history_returns_canonical_api_url_for_proxy_clients():
    import json

    from fastapi import FastAPI

    from opengeo_api.artifact_release_routes import artifact_release_history, router

    app = FastAPI()
    app.include_router(router)
    app.state.render_repository = SimpleNamespace()
    request = Request(
        {
            "type": "http",
            "app": app,
            "router": app.router,
            "scheme": "https",
            "server": ("api.example.test", 443),
            "headers": [],
            "path": "/artifacts/unused/releases",
            "root_path": "",
        }
    )
    org, release = UUID(int=1), UUID(int=2)
    with (
        patch(
            "opengeo_api.artifact_release_routes.tenant_context",
            return_value=SimpleNamespace(organization_id=org),
        ),
        patch(
            "opengeo_api.artifact_release_routes.list_releases",
            AsyncMock(return_value={"records": [{"id": str(release)}]}),
        ),
    ):
        response = asyncio.run(
            artifact_release_history(UUID(int=3), request, SimpleNamespace(), 20, 0)
        )
    record = json.loads(response.body)["records"][0]
    assert (
        record["public_view_url"]
        == f"https://api.example.test/public/organizations/{org}/artifact-releases/{release}/view"
    )


def test_portable_release_reads_application_storage_and_rechecks_authority():
    exact = SimpleNamespace(body=b"<!doctype html>", content_type="text/html")
    portable = SimpleNamespace(read_exact_object=AsyncMock(return_value=exact))
    images = SimpleNamespace(read_exact_object=AsyncMock())
    request = Request(
        {
            "type": "http",
            "app": SimpleNamespace(
                state=SimpleNamespace(
                    download_storage=images,
                    render_repository=SimpleNamespace(_artifact_downloads=portable),
                )
            ),
        }
    )
    target = [None] * 13
    target[7:13] = ["source.example", "artifacts/map.html", "version-1", "text/html", 15, "a" * 64]
    authority = AsyncMock(return_value=({}, target))
    with patch("opengeo_api.artifact_release_routes._public", authority):
        response = asyncio.run(public_release_map(UUID(int=1), UUID(int=2), request))
    assert response.body == exact.body
    assert authority.await_count == 2
    assert "sandbox allow-scripts;" in response.headers["content-security-policy"]
    assert "connect-src blob:;" in response.headers["content-security-policy"]
    assert "allow-same-origin" not in response.headers["content-security-policy"]
    images.read_exact_object.assert_not_awaited()
    spec = portable.read_exact_object.call_args.args[0]
    assert spec.bucket == "source.example" and spec.maximum_bytes == 4 * 1024 * 1024

    authority = AsyncMock(side_effect=[({}, target), HTTPException(404, "revoked")])
    with patch("opengeo_api.artifact_release_routes._public", authority):
        try:
            asyncio.run(public_release_map(UUID(int=1), UUID(int=2), request))
        except HTTPException as error:
            assert error.status_code == 404
        else:
            raise AssertionError("output returned after revocation")


def test_importable_release_reuses_exact_html_and_revocation_boundary():
    from hashlib import sha256

    from opengeo_api.project_module import project_module

    html = b"<!doctype html><title>Map</title><script>window.mapOpened=true;</script>"
    storage = SimpleNamespace(
        read_exact_object=AsyncMock(
            return_value=SimpleNamespace(body=html, content_type="text/html")
        )
    )
    request = Request(
        {
            "type": "http",
            "app": SimpleNamespace(
                state=SimpleNamespace(
                    render_repository=SimpleNamespace(_artifact_downloads=storage)
                )
            ),
        }
    )
    target = [None] * 13
    target[7:13] = [
        "private-bucket",
        "private-key",
        "version-1",
        "text/html",
        len(html),
        sha256(html).hexdigest(),
    ]
    record = {
        "id": str(UUID(int=2)),
        "artifact_id": str(UUID(int=3)),
        "version_number": 1,
        "project_id": str(UUID(int=4)),
        "title": "Map",
        "license": "CC0-1.0",
        "attribution": "Synthetic survey",
        "private_key": "must-not-be-in-module",
    }
    authority = AsyncMock(return_value=(record, target))
    with patch("opengeo_api.artifact_release_routes._public", authority):
        response = asyncio.run(public_release_module(UUID(int=1), UUID(int=2), request, True))
    assert authority.await_count == 2
    assert response.headers["content-type"].startswith("text/javascript")
    assert response.headers["access-control-allow-origin"] == "*"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-disposition"].endswith('"opengeo-project.mjs"')
    assert b"private-bucket" not in response.body and b"must-not-be-in-module" not in response.body
    metadata = {key: record[key] for key in record if key != "private_key"}
    metadata.update(html_sha256=target[12], scope="reviewed-browser-snapshot")
    assert response.body == project_module(html, metadata)
    assert storage.read_exact_object.call_args.args[0].version_id == "version-1"

    for outcomes, expected_reads in [
        ([HTTPException(404, "unavailable")], 0),
        ([(record, target), HTTPException(404, "revoked")], 1),
    ]:
        storage.read_exact_object.reset_mock()
        with patch("opengeo_api.artifact_release_routes._public", AsyncMock(side_effect=outcomes)):
            try:
                asyncio.run(public_release_module(UUID(int=1), UUID(int=2), request))
            except HTTPException as error:
                assert error.status_code == 404
                assert error.headers["Access-Control-Allow-Origin"] == "*"
                assert error.headers["Cache-Control"] == "no-store"
            else:
                raise AssertionError("unavailable module returned")
        assert storage.read_exact_object.await_count == expected_reads


def test_live_map_and_module_allow_only_the_bound_provider_and_label_network_requirement():
    from opengeo_api.artifact_release_routes import public_release_view

    url = "https://coast.noaa.gov/arcgis/rest/services/dc_slr/slr_2ft/MapServer/tile/{z}/{y}/{x}"
    dependency = {"id": "coastal-source", "mode": "live", "mediaType": None, "accessUrls": [url]}
    manifest = {
        "dependencies": [dependency],
        "build": {"selectedSourceIds": ["coastal-source"]},
        "networkDependencies": [{"id": "coastal-source", "accessUrls": [url]}],
    }
    definition = {
        "layers": [
            {
                "layerId": "coastal",
                "sourceType": "xyz-raster",
                "sourceVersion": 1,
                "datasetId": str(UUID(int=3)),
                "sourceUrl": url,
                "tileUrl": url,
                "sourceConfiguration": {"tileSize": 256, "scheme": "xyz"},
            }
        ]
    }
    html = b"<!doctype html><title>NOAA</title>"
    storage = SimpleNamespace(
        read_exact_object=AsyncMock(
            return_value=SimpleNamespace(body=html, content_type="text/html")
        )
    )
    request = Request(
        {
            "type": "http",
            "app": SimpleNamespace(
                state=SimpleNamespace(
                    render_repository=SimpleNamespace(_artifact_downloads=storage)
                )
            ),
        }
    )
    target = (
        None,
        UUID(int=1),
        UUID(int=2),
        None,
        None,
        UUID(int=4),
        "completed",
        "private-backup",
        "private-key",
        "version-1",
        "text/html",
        len(html),
        "a" * 64,
        manifest,
        1,
        definition,
    )
    record = {
        "id": str(UUID(int=2)),
        "artifact_id": str(UUID(int=4)),
        "version_number": 1,
        "project_id": str(UUID(int=1)),
        "title": "NOAA",
        "license": "CC-BY-4.0",
        "attribution": "NOAA",
        "network_required": True,
        "media_type": "text/html",
    }
    authority = AsyncMock(return_value=(record, target))
    with patch("opengeo_api.artifact_release_routes._public", authority):
        response = asyncio.run(public_release_map(UUID(int=1), UUID(int=2), request))
        assert (
            "connect-src blob: https://coast.noaa.gov;"
            in response.headers["content-security-policy"]
        )
        assert "allow-same-origin" not in response.headers["content-security-policy"]
        module = asyncio.run(public_release_module(UUID(int=1), UUID(int=2), request))
        assert b"connect-src blob: https://coast.noaa.gov;" in module.body
        assert b'"network_required":true' in module.body
        assert b"private-backup" not in module.body and b"private-key" not in module.body
        view = asyncio.run(public_release_view(UUID(int=1), UUID(int=2), request))
        assert b"Download live HTML" in view.body and b"Download offline HTML" not in view.body
        assert "internet required" in view.body.decode()
    assert authority.await_count == 5
    assert storage.read_exact_object.await_count == 2


def test_module_rejects_image_and_oversized_output_before_storage():
    storage = SimpleNamespace(read_exact_object=AsyncMock())
    request = Request(
        {
            "type": "http",
            "app": SimpleNamespace(
                state=SimpleNamespace(
                    render_repository=SimpleNamespace(_artifact_downloads=storage)
                )
            ),
        }
    )
    for media_type, size in [("image/png", 100), ("text/html", 4 * 1024 * 1024 + 1)]:
        target = [None] * 13
        target[10:12] = [media_type, size]
        with patch(
            "opengeo_api.artifact_release_routes._public", AsyncMock(return_value=({}, target))
        ):
            try:
                asyncio.run(public_release_module(UUID(int=1), UUID(int=2), request))
            except HTTPException as error:
                assert error.status_code == 404
            else:
                raise AssertionError("unsupported module accepted")
    storage.read_exact_object.assert_not_awaited()


def test_public_collection_limits_lazy_previews_and_escapes_output_terms():
    org, identity = UUID(int=1), UUID(int=2)
    prefix = f"/public/organizations/{org}/artifact-releases/"
    record = {
        "title": "Collection",
        "description": "",
        "members": [
            {
                "title": "<script>",
                "description": "Attribution",
                "license": "CC0-1.0",
                "href": prefix + str(UUID(int=i + 3)) + "/view",
                "preview_href": prefix + str(UUID(int=i + 3)) + "/preview",
            }
            for i in range(6)
        ],
    }
    repo = SimpleNamespace(read_public=AsyncMock(return_value=record))
    request = Request(
        {
            "type": "http",
            "app": SimpleNamespace(
                state=SimpleNamespace(
                    collection_repository=repo,
                    render_repository=None,
                    site_publication_repository=None,
                )
            ),
        }
    )
    response = asyncio.run(public_collection_view(org, identity, request))
    body = response.body.decode()
    assert body.count('<img loading="lazy"') == 4
    assert body.count("<a href=") == 6
    assert "<script>" not in body and "&lt;script&gt;" in body
    assert "CC0-1.0" in body
