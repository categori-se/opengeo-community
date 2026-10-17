import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest
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


@pytest.fixture(scope="module")
def native_artifact():
    import json
    import subprocess
    from pathlib import Path

    script = """
import {compilePortableMapArtifact} from './app/src/lib/portableMapArtifact.js';
const sourceId='dataset_00000000-0000-0000-0000-000000000010_'
 +'version_00000000-0000-0000-0000-000000000011-source';
const result=await compilePortableMapArtifact({title:'Survey <safe>',
 runtimeJs:'globalThis.retainedRuntimeExecuted=true;',runtimeCss:'body{color:red}',
 runtimeLicense:'BSD',candidates:[{id:'points',sourceId,title:'Points',
 visible:true,paintOrder:{points:0},source:{type:'geojson',data:{type:'FeatureCollection',
 features:[{type:'Feature',properties:{name:'Clinic'},geometry:{type:'Point',coordinates:[1,2]}}]}},
 paints:[{id:'points',type:'circle',source:sourceId,paint:{'circle-radius':5}}]}],
 selectedIds:['points'],view:{center:[1,2],zoom:8}});
console.log(JSON.stringify(result));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=Path(__file__).resolve().parents[3],
        check=True,
        capture_output=True,
        text=True,
        timeout=20,
    )
    return json.loads(result.stdout)


def native_request(artifact):
    from hashlib import sha256

    from fastapi import FastAPI

    from opengeo_api.artifact_release_routes import router

    html = artifact["html"].encode()
    storage = SimpleNamespace(
        read_exact_object=AsyncMock(
            return_value=SimpleNamespace(body=html, content_type="text/html")
        )
    )
    app = FastAPI()
    app.include_router(router)
    app.state.render_repository = SimpleNamespace(_artifact_downloads=storage)
    request = Request(
        {
            "type": "http",
            "app": app,
            "router": app.router,
            "scheme": "https",
            "server": ("api.example.test", 443),
            "headers": [],
            "path": "/",
            "root_path": "",
        }
    )
    target = [None] * 16
    target[15] = {
        "layers": [
            {
                "sourceType": "governed-dataset",
                "datasetId": "00000000-0000-0000-0000-000000000010",
                "datasetVersionId": "00000000-0000-0000-0000-000000000011",
                "sourceVersion": 1,
            }
        ]
    }
    target[5] = UUID(int=99)
    target[7:14] = [
        "private-bucket",
        "private-key",
        "version-1",
        "text/html",
        len(html),
        sha256(html).hexdigest(),
        artifact["manifest"],
    ]
    record = {
        "id": str(UUID(int=2)),
        "artifact_id": str(UUID(int=3)),
        "version_number": 7,
        "project_id": str(UUID(int=4)),
        "title": "Survey",
        "license": "CC-BY-4.0",
        "attribution": "Survey team",
        "private_secret": "never-expose",
    }
    return request, record, target, storage


def test_native_module_is_data_only_and_preserves_exact_authority(native_artifact):
    from opengeo_api.project_module import native_payload

    request, record, target, storage = native_request(native_artifact)
    authority = AsyncMock(return_value=(record, target))
    with patch("opengeo_api.artifact_release_routes._public", authority):
        response = asyncio.run(
            public_release_module(UUID(int=1), UUID(int=2), request, mode="native")
        )
    assert authority.await_count == 2 and storage.read_exact_object.await_count == 1
    assert response.headers["access-control-allow-origin"] == "*"
    assert response.headers["cache-control"] == "no-store"
    assert b"retainedRuntimeExecuted" not in response.body
    assert b"export const html" not in response.body and b"srcdoc" not in response.body
    assert b"private-bucket" not in response.body and b"never-expose" not in response.body
    assert b"https://api.example.test/public/" in response.body
    payload = native_payload(native_artifact["html"].encode(), native_artifact["manifest"])
    assert (
        next(iter(payload["style"]["sources"].values()))["data"]["features"][0]["properties"][
            "name"
        ]
        == "Clinic"
    )


@pytest.mark.parametrize("mutation", ["unknown", "glyphs", "url", "source", "script", "duplicate"])
def test_native_payload_rejects_unsupported_or_unbound_input(native_artifact, mutation):
    import copy
    import json
    from hashlib import sha256

    from opengeo_api.json_canonical import canonical_json_bytes
    from opengeo_api.project_module import NativePayloadUnsupported, native_payload

    manifest = copy.deepcopy(native_artifact["manifest"])
    html = native_artifact["html"]
    start = html.index("<script>const publication=") + len("<script>const publication=")
    payload, end = json.JSONDecoder().raw_decode(html[start:])
    if mutation == "unknown":
        payload["onLoad"] = "alert(1)"
    elif mutation == "glyphs":
        payload["style"]["glyphs"] = "https://unbound.example/{fontstack}/{range}.pbf"
    elif mutation == "url":
        next(iter(payload["style"]["sources"].values()))["data"] = "https://unbound.example/private"
    elif mutation == "source":
        next(iter(payload["style"]["sources"].values()))["data"]["features"][0]["properties"][
            "name"
        ] = "Changed"
    if mutation == "script":
        encoded = "(()=>{globalThis.executed=true;return " + json.dumps(payload) + "})()"
    else:
        encoded = json.dumps(payload, separators=(",", ":"))
        if mutation == "duplicate":
            encoded = encoded.replace('{"title":', '{"title":"duplicate","title":', 1)
    html = (html[:start] + encoded + html[start + end :]).encode()
    manifest["output"].update(sizeBytes=len(html), checksumSha256=sha256(html).hexdigest())
    manifest["artifactId"] = "sha256:" + sha256(html).hexdigest()
    manifest["manifestChecksumSha256"] = sha256(
        canonical_json_bytes(
            {key: value for key, value in manifest.items() if key != "manifestChecksumSha256"}
        )
    ).hexdigest()
    with pytest.raises(NativePayloadUnsupported):
        native_payload(html, manifest)


def test_native_unsupported_returns_clear_iframe_fallback_and_cors(native_artifact):
    request, record, target, storage = native_request(native_artifact)
    storage.read_exact_object.return_value = SimpleNamespace(
        body=b"<html>Other</html>", content_type="text/html"
    )
    with (
        patch(
            "opengeo_api.artifact_release_routes._public", AsyncMock(return_value=(record, target))
        ),
        pytest.raises(HTTPException) as rejected,
    ):
        asyncio.run(public_release_module(UUID(int=1), UUID(int=2), request, mode="native"))
    assert rejected.value.status_code == 409
    assert rejected.value.detail["code"] == "artifact_native_unavailable"
    assert rejected.value.detail["iframe_url"].endswith("/map")
    assert rejected.value.headers["Access-Control-Allow-Origin"] == "*"


def test_native_controls_events_and_cleanup_with_offline_host_peer(native_artifact, tmp_path):
    import subprocess

    from opengeo_api.project_module import native_payload, native_project_module

    module = tmp_path / "map.mjs"
    module.write_bytes(
        native_project_module(
            native_payload(native_artifact["html"].encode(), native_artifact["manifest"]),
            {"title": "Survey", "attribution": "Survey", "license": "CC0", "iframe_url": "/map"},
        )
    )
    subprocess.run(["node", "--check", str(module)], check=True, capture_output=True, timeout=10)
    peer = r"""
import assert from 'node:assert/strict';
const {createView}=await import(process.argv[1]);
class Element extends EventTarget {constructor(tag){super();this.tag=tag;
 this.style={};this.children=[];}
 append(...items){this.children.push(...items);}remove(){this.removed=true;}}
const document={createElement:tag=>new Element(tag),createTextNode:text=>({text}),
 defaultView:{CustomEvent}};
class MapPeer {constructor(options){this.options=options;this.events=new Map();
 this.layers=[];
 this.view={...options};this.removes=0;}
 on(type,fn){this.events.set(type,fn);}off(type){this.events.delete(type);}
 emit(type,value){this.events.get(type)?.(value);}getCenter(){return{toArray:()=>this.view.center};}
 getZoom(){return this.view.zoom;}getPitch(){return this.view.pitch;}
 getBearing(){return this.view.bearing;}
 jumpTo(view){Object.assign(this.view,view);this.emit('moveend');}addLayer(value){this.layers.push(value);}
 setLayoutProperty(id,key,value){this.visibility={id,key,value};}setFilter(id,value){this.filter={id,value};}

 queryRenderedFeatures(){return[{id:1,source:'points',properties:{name:'Clinic'},
 geometry:{type:'Point',coordinates:[1,2]}}];}resize(){this.resizes=(this.resizes??0)+1;}
 remove(){this.removes++;}}
const signal=new AbortController();
const view=createView({maplibre:{Map:MapPeer},document,signal:signal.signal});

const events=[];for(const type of ['mapready','camerachange','layerchange','filterchange',
 'selectionchange','dispose'])
 view.addEventListener(type,event=>events.push({type,detail:event.detail}));
assert.equal(globalThis.retainedRuntimeExecuted,undefined);
view.setLayerVisibility('points',false);view.setFilter('points',['==',['get','name'],'Clinic']);
view.map.emit('load');assert.equal(view.map.layers.length,1);
assert.equal(view.map.visibility.value,'none');
view.setCamera({zoom:9});assert.equal(view.getCamera().zoom,9);
view.resize();
view.map.emit('click',{point:{x:1,y:2}});assert.equal(view.getSelection()[0].properties.name,'Clinic');
assert.throws(()=>view.setLayerVisibility('unpublished',true));
assert.throws(()=>view.setCamera({zoom:NaN}));
signal.abort();view.dispose();assert.equal(view.map.removes,1);
assert.equal(view.map.events.size,0);
assert.equal(view.removed,true);assert.throws(()=>view.resize());
for(const type of ['mapready','camerachange','layerchange','filterchange',
 'selectionchange','dispose'])
 assert(events.some(event=>event.type===type),type);
console.log('native-peer-pass');
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", peer, module.as_uri()],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert "native-peer-pass" in result.stdout


def test_public_descriptor_is_small_allowlisted_pinned_metadata_no_storage(native_artifact):
    import json

    from opengeo_api.artifact_release_routes import public_release_descriptor

    request, record, target, storage = native_request(native_artifact)
    authority = AsyncMock(return_value=(record, target))
    with patch("opengeo_api.artifact_release_routes._public", authority):
        response = asyncio.run(public_release_descriptor(UUID(int=1), UUID(int=2), request))
    descriptor = json.loads(response.body)
    assert descriptor["artifactId"] == record["artifact_id"] and descriptor["versionNumber"] == 7
    assert descriptor["selection"]["followsCurrent"] is False
    assert descriptor["output"]["checksumSha256"] == target[12]
    assert (
        descriptor["manifestChecksumSha256"]
        == native_artifact["manifest"]["manifestChecksumSha256"]
    )
    assert descriptor["urls"]["nativeModule"].endswith("/module.mjs?mode=native")
    assert descriptor["scope"] == "reviewed-browser-snapshot"
    assert descriptor["urls"]["htmlDownload"].endswith("/map?download=true")
    assert descriptor["urls"]["staticImage"] is None
    assert response.headers["access-control-allow-origin"] == "*"
    assert response.headers["cache-control"] == "no-store" and len(response.body) < 8192
    assert b"private-bucket" not in response.body and b"private-key" not in response.body
    assert b"never-expose" not in response.body
    assert authority.await_count == 1
    storage.read_exact_object.assert_not_awaited()
    with (
        patch(
            "opengeo_api.artifact_release_routes._public",
            AsyncMock(side_effect=HTTPException(404, "revoked")),
        ),
        pytest.raises(HTTPException) as rejected,
    ):
        asyncio.run(public_release_descriptor(UUID(int=1), UUID(int=2), request))
    assert rejected.value.headers["Access-Control-Allow-Origin"] == "*"


def test_native_accepts_only_recorded_public_raster_payload():
    import json
    import subprocess
    from pathlib import Path

    from opengeo_api.project_module import native_payload

    script = """
import {compilePortableMapArtifact} from './app/src/lib/portableMapArtifact.js';
console.log(JSON.stringify(await compilePortableMapArtifact({title:'Public raster',mode:'live',
 runtimeJs:'/*retained runtime*/',runtimeCss:'body{}',runtimeLicense:'BSD',
 candidates:[{id:'raster',sourceId:'raster-source',title:'Raster',visible:true,
 paintOrder:{raster:0},source:{type:'raster',tileSize:256,
 tiles:['https://tiles.example.test/{z}/{x}/{y}.png']},
 paints:[{id:'raster',type:'raster',source:'raster-source'}]}],selectedIds:['raster']})));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=Path(__file__).resolve().parents[3],
        check=True,
        capture_output=True,
        text=True,
        timeout=20,
    )
    artifact = json.loads(result.stdout)
    payload = native_payload(artifact["html"].encode(), artifact["manifest"])
    assert payload["mode"] == "live"
    assert payload["style"]["sources"]["raster-source"]["tiles"] == [
        "https://tiles.example.test/{z}/{x}/{y}.png"
    ]


def test_public_image_descriptor_does_not_advertise_html_or_native(native_artifact):
    import json

    from opengeo_api.artifact_release_routes import public_release_descriptor

    request, record, target, storage = native_request(native_artifact)
    target[10] = "image/png"
    with patch(
        "opengeo_api.artifact_release_routes._public", AsyncMock(return_value=(record, target))
    ):
        response = asyncio.run(public_release_descriptor(UUID(int=1), UUID(int=2), request))
    descriptor = json.loads(response.body)
    assert descriptor["urls"]["staticImage"].endswith("/image")
    assert descriptor["urls"]["htmlDownload"] is None
    assert descriptor["native"] is None and descriptor["urls"]["nativeModule"] is None
    storage.read_exact_object.assert_not_awaited()
