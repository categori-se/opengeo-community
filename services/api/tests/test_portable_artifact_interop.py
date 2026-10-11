"""Cross-language bytes for the actual browser compiler, without storage/providers."""

import asyncio
import copy
import json
import subprocess
from hashlib import sha256
from pathlib import Path
from uuid import UUID

import pytest

from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.portable_artifacts import validate_portable_bytes, validate_portable_origin


@pytest.fixture(scope="module")
def browser_artifact():
    root = Path(__file__).resolve().parents[3]
    script = """
import {compilePortableMapArtifact} from './app/src/lib/portableMapArtifact.js';
const definition={layers:[], metadata:{'10':1e-7,'2':1e21,'😀':-0,'é':0.0000002}};
const result=await compilePortableMapArtifact({title:'Survey 地図',runtimeJs:'/*test*/',
 runtimeCss:'body{}',runtimeLicense:'BSD',
 candidates:[{id:'points', sourceId:'points', paintOrder:{points:0}, title:'Points',
 visible:true, source:{type:'geojson',data:{type:'FeatureCollection',features:[]}},
 paints:[{id:'points',type:'circle',source:'points'}]}],
 selectedIds:['points'],view:{center:[1e-7,-1e-7],zoom:3},
 savedProjectOrigin:{id:'11111111-1111-4111-8111-111111111111',version:1,definition}});
console.log(JSON.stringify({result,definition}));
"""
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
        timeout=20,
    )
    return json.loads(completed.stdout)


def test_browser_manifest_hashes_match_server_canonical_bytes(browser_artifact):
    payload = copy.deepcopy(browser_artifact)
    manifest = payload["result"]["manifest"]
    raw = json.dumps(manifest, ensure_ascii=False).encode()
    html = payload["result"]["html"].encode()
    assert validate_portable_bytes(html, raw) == manifest
    origin_args = dict(
        map_id=UUID("11111111-1111-4111-8111-111111111111"),
        map_version=1,
        definition=payload["definition"],
    )
    validate_portable_origin(manifest, **origin_args)
    with pytest.raises(ValueError, match="origin_mismatch"):
        validate_portable_origin(manifest, **{**origin_args, "map_version": 2})
    with pytest.raises(ValueError, match="checksum_mismatch"):
        validate_portable_bytes(html.replace(b"Survey", b"survey"), raw)
    with pytest.raises(ValueError, match="checksum_mismatch"):
        validate_portable_bytes(
            html, raw.replace(b"reviewed-browser-snapshot", b"invented-browser-snapshot")
        )
    with pytest.raises(ValueError, match="duplicate_key"):
        validate_portable_bytes(html, b'{"x":1,"x":2}')
    with pytest.raises(ValueError, match="nonfinite"):
        validate_portable_bytes(html, b'{"x":NaN}')
    with pytest.raises(ValueError, match="size_invalid"):
        validate_portable_bytes(html, b" " * 49153)
    recorded = manifest.pop("manifestChecksumSha256")
    assert recorded == sha256(canonical_json_bytes(manifest)).hexdigest()
    assert (
        manifest["output"]["checksumSha256"]
        == sha256(payload["result"]["html"].encode()).hexdigest()
    )
    assert (
        manifest["provenance"]["originatingProject"]["definitionChecksumSha256"]
        == sha256(canonical_json_bytes(payload["definition"])).hexdigest()
    )


@pytest.fixture(
    scope="module",
    params=[("xyz", None), ("imageserver", None), ("imageserver", [2])],
    ids=["xyz", "imageserver", "imageserver-record"],
)
def browser_raster_artifact(request):
    root = Path(__file__).resolve().parents[3]
    script = r"""
import {compilePortableMapArtifact} from './app/src/lib/portableMapArtifact.js';
import {imageServerTileUrl} from './app/src/lib/imageServer.js';
const kind=process.argv[1];
const rasterIds=JSON.parse(process.argv[2]);
const configuration=kind==='xyz'
 ? {minZoom:0,maxZoom:15,tileSize:256,scheme:'xyz',attribution:'NOAA'}
 : {serviceKind:'imageserver',tileSize:256,imageFormat:'png32',interpolation:'RSP_NearestNeighbor',
    bandIds:[],minZoom:0,maxZoom:15,attribution:'NOAA',...(rasterIds ? {rasterIds} : {})};
const sourceUrl=kind==='xyz'
 ? 'https://coast.noaa.gov/arcgis/rest/services/dc_slr/slr_2ft/MapServer/tile/{z}/{y}/{x}'
 : 'https://gis.nnvl.noaa.gov/arcgis/rest/services/HINDZ/Morning_Heat_Index_in_Cities/ImageServer';
const tileUrl=kind==='xyz' ? sourceUrl : imageServerTileUrl(sourceUrl,configuration);
const layer={layerId:'coastal',datasetId:'22222222-2222-4222-8222-222222222222',sourceVersion:1,
 sourceType:`${kind}-raster`,sourceUrl,sourceConfiguration:configuration,tileUrl};
const definition={layers:[layer]};
const result=await compilePortableMapArtifact({title:'NOAA',mode:'live',runtimeJs:'/* test */',
 runtimeCss:'body{}',runtimeLicense:'BSD',candidates:[{id:'coastal',sourceId:'coastal-source',
 title:'NOAA',visible:true,source:{type:'raster',tiles:[tileUrl],tileSize:256},
 paints:[{id:'coastal-raster',source:'coastal-source',type:'raster'}],paintOrder:{'coastal-raster':0}}],
 selectedIds:['coastal'],savedProjectOrigin:{id:'11111111-1111-4111-8111-111111111111',version:1,definition}});
console.log(JSON.stringify({result,definition,kind}));
"""
    return json.loads(
        subprocess.run(
            [
                "node",
                "--input-type=module",
                "-e",
                script,
                request.param[0],
                json.dumps(request.param[1]),
            ],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
            timeout=20,
        ).stdout
    )


def test_live_publication_requires_exact_public_external_revision(browser_raster_artifact):
    from opengeo_api.portable_artifact_publication import (
        public_portable_origins,
        public_portable_seal,
    )
    from opengeo_api.rendering import RenderConflict
    from test_saved_map_jobs import CONTEXT

    payload = browser_raster_artifact
    layer = payload["definition"]["layers"][0]
    manifest = payload["result"]["manifest"]
    raw_config = {"min_zoom": 0, "max_zoom": 15, "tile_size": 256, "attribution": "NOAA"}
    raw_config.update(
        {"scheme": "xyz"}
        if payload["kind"] == "xyz"
        else {
            "service_kind": "imageserver",
            "image_format": "png32",
            "interpolation": "RSP_NearestNeighbor",
            "band_ids": [],
        }
    )
    if layer["sourceConfiguration"].get("rasterIds"):
        raw_config["raster_ids"] = layer["sourceConfiguration"]["rasterIds"]
    target = [None] * 16
    target[1], target[2] = UUID("11111111-1111-4111-8111-111111111111"), UUID(int=2)
    target[13:] = [manifest, 1, payload["definition"]]

    class Transaction:
        def __init__(self, rows):
            self.rows, self.calls = rows, []

        async def fetch_all(self, sql, params):
            self.calls.append((sql, params))
            # External revisions have numeric identity, independently of hosted
            # dataset versions. Current published authority is never inferred
            # from the author's manifest or the provider's anonymous endpoint.
            assert "app.dataset_versions" not in sql
            for required in (
                "dataset.classification='public'",
                "source.credential_mode='none'",
                "resource.state='published'",
                "resource.visibility='public'",
                "externalSourceVersion",
                "externalSourceUrl",
            ):
                assert required in sql
            return self.rows

    def check(rows, changed=None):
        tx = Transaction(rows)
        asyncio.run(public_portable_seal(tx, CONTEXT, tuple(changed or target)))
        return tx

    tx = check([(UUID(layer["datasetId"]), 1, raw_config)])
    assert len(tx.calls) == 1
    assert tx.calls[0][1][0].obj[0]["version_number"] == 1
    assert tx.calls[0][1][0].obj[0]["configuration"] == layer["sourceConfiguration"]
    assert public_portable_origins(manifest, payload["definition"]) == [
        "https://coast.noaa.gov" if payload["kind"] == "xyz" else "https://gis.nnvl.noaa.gov"
    ]
    invalid_rows = [
        [],
        [(UUID(layer["datasetId"]), 2, raw_config)],
        [(UUID(layer["datasetId"]), 1, {**raw_config, "max_zoom": 14})],
    ]
    if payload["kind"] == "imageserver":
        invalid_rows.append([(UUID(layer["datasetId"]), 1, {**raw_config, "raster_ids": [3]})])
    for rows in invalid_rows:
        with pytest.raises(RenderConflict, match="artifact_source_not_public"):
            check(rows)
    for mutate in (
        lambda m: m["dependencies"][0].update(accessUrls=["https://another.example/tiles"]),
        lambda m: m.update(networkDependencies=[]),
        lambda m: m["dependencies"][0].update(id="unrelated-source"),
        lambda m: m["dependencies"].append(copy.deepcopy(m["dependencies"][0])),
    ):
        changed = copy.deepcopy(manifest)
        mutate(changed)
        with pytest.raises(RenderConflict, match="artifact_public_sources_unsupported"):
            public_portable_origins(changed, payload["definition"])
    if payload["kind"] == "imageserver":
        changed_definition = copy.deepcopy(payload["definition"])
        changed_definition["layers"][0]["sourceConfiguration"]["rasterIds"] = [3]
        with pytest.raises(RenderConflict, match="artifact_public_sources_unsupported"):
            public_portable_origins(manifest, changed_definition)


@pytest.mark.parametrize(
    "url",
    [
        "https://localhost/tile/{z}/{x}/{y}",
        "https://127.0.0.1/tile/{z}/{x}/{y}",
        "https://source.opengeo.tools/tile/{z}/{x}/{y}",
        "https://example.internal/tile/{z}/{x}/{y}",
        "https://provider.example/api/tile/{z}/{x}/{y}",
        "https://user:password@provider.example/tile/{z}/{x}/{y}",
    ],
)
def test_public_raster_rejects_credentials_and_private_destinations(url):
    from opengeo_api.portable_artifact_publication import public_portable_origins
    from opengeo_api.rendering import RenderConflict

    layer = {
        "layerId": "source",
        "datasetId": str(UUID(int=2)),
        "sourceVersion": 1,
        "sourceType": "xyz-raster",
        "sourceUrl": url,
        "tileUrl": url,
        "sourceConfiguration": {},
    }
    manifest = {
        "dependencies": [
            {"id": "source-source", "mode": "live", "mediaType": None, "accessUrls": [url]}
        ]
    }
    with pytest.raises(RenderConflict, match="artifact_public_sources_unsupported"):
        public_portable_origins(manifest, {"layers": [layer]})


@pytest.mark.parametrize("saved_legacy", [False, True])
@pytest.mark.parametrize("artifact_legacy", [False, True])
def test_imageserver_exact_legacy_url_compatibility(saved_legacy, artifact_legacy):
    from opengeo_api.portable_artifact_publication import (
        _tile_url,
        public_portable_origins,
    )
    from opengeo_api.rendering import RenderConflict

    layer = {
        "layerId": "heat",
        "datasetId": str(UUID(int=2)),
        "sourceVersion": 1,
        "sourceType": "imageserver-raster",
        "sourceUrl": "https://gis.nnvl.noaa.gov/arcgis/rest/services/HINDZ/"
        "Morning_Heat_Index_in_Cities/ImageServer",
        "sourceConfiguration": {
            "serviceKind": "imageserver",
            "tileSize": 256,
            "imageFormat": "png32",
            "interpolation": "RSP_NearestNeighbor",
            "bandIds": [2, 1, 0],
            "rasterIds": [2],
        },
    }
    canonical = _tile_url(layer)
    legacy = canonical.replace("%7B", "{").replace("%7D", "}")
    assert canonical != legacy
    assert "bbox={bbox-epsg-3857}" in canonical
    assert "mosaicRule=%7B" in canonical
    layer["tileUrl"] = legacy if saved_legacy else canonical
    artifact_url = legacy if artifact_legacy else canonical
    manifest = {
        "dependencies": [
            {
                "id": "heat-source",
                "mode": "live",
                "mediaType": None,
                "accessUrls": [artifact_url],
            }
        ],
        "networkDependencies": [{"id": "heat-source", "accessUrls": [artifact_url]}],
        "build": {"selectedSourceIds": ["heat-source"]},
    }
    original = copy.deepcopy((manifest, layer))
    assert public_portable_origins(manifest, {"layers": [layer]}) == ["https://gis.nnvl.noaa.gov"]
    assert (manifest, layer) == original
    # Compatibility applies only to brace encoding in this exact generated URL.
    # No arbitrary URL equivalence, extra parameters or altered source selection.
    for changed_url in (
        artifact_url + "&f=image",
        artifact_url + "&unknown=value",
        artifact_url + "&token=secret",
        artifact_url.replace("bandIds=2%2C1%2C0", "bandIds=0%2C1%2C2"),
        artifact_url.replace("%5B2%5D", "%5B3%5D"),
        artifact_url.replace("gis.nnvl.noaa.gov", "another.example"),
        artifact_url.replace("size=256%2C256", "size=256,256"),
    ):
        for change_saved in [False, True]:
            changed_manifest, changed_layer = copy.deepcopy((manifest, layer))
            if change_saved:
                changed_layer["tileUrl"] = changed_url
            else:
                changed_manifest["dependencies"][0]["accessUrls"] = [changed_url]
                changed_manifest["networkDependencies"][0]["accessUrls"] = [changed_url]
            with pytest.raises(RenderConflict, match="artifact_public_sources_unsupported"):
                public_portable_origins(changed_manifest, {"layers": [changed_layer]})
    mismatch = copy.deepcopy(manifest)
    mismatch["networkDependencies"][0]["accessUrls"] = [canonical if artifact_legacy else legacy]
    with pytest.raises(RenderConflict, match="artifact_public_sources_unsupported"):
        public_portable_origins(mismatch, {"layers": [layer]})


def test_portable_registration_revalidates_before_reuse_and_does_not_change_current(
    browser_artifact, monkeypatch
):
    from opengeo_api.portable_artifact_registration import register_portable_edition
    from opengeo_api.rendering import RenderAccessDenied, RenderConflict
    from opengeo_api.workspaces import PostgresWorkspaceRepository, WorkspaceConflict
    from test_rendering import PROJECT_ID, RESOURCE_ID, Transaction, repository
    from test_saved_map_jobs import CONTEXT, ROLES

    payload = browser_artifact
    manifest = payload["result"]["manifest"]
    html = payload["result"]["html"].encode()
    raw = json.dumps(manifest).encode()
    artifact_id, object_id = UUID(int=100), UUID(int=101)
    retained = ("text/html", len(html), manifest["output"]["checksumSha256"])
    checked = []

    async def references(self, transaction, context, project, definition):
        checked.append(definition)
        assert definition == payload["definition"]

    monkeypatch.setattr(
        PostgresWorkspaceRepository, "_require_map_definition_references", references
    )

    def run(transaction, revision=0):
        return asyncio.run(
            register_portable_edition(
                repository(transaction),
                CONTEXT,
                PROJECT_ID,
                RESOURCE_ID,
                object_id,
                html,
                raw,
                revision,
            )
        )

    transaction = Transaction(
        [ROLES, (payload["definition"],), (artifact_id, 0, None), retained, None, (1,)]
    )
    result = run(transaction)
    assert result == {
        "id": str(artifact_id),
        "revision": 1,
        "current_version_number": None,
        "version_number": 1,
        "reused": False,
    }
    assert len(transaction.executions) == 2
    assert "current_version_number" not in transaction.executions[-1][0]
    retry = Transaction([ROLES, (payload["definition"],), (artifact_id, 4, 2), retained, (1,)])
    assert run(retry)["reused"] is True
    assert not retry.executions
    assert len(checked) == 2
    conflict = Transaction([ROLES, (payload["definition"],), (artifact_id, 4, 2), retained, None])
    with pytest.raises(RenderConflict, match="revision_conflict"):
        run(conflict)
    assert not conflict.executions
    denied = Transaction([("member", None, None, False)])
    with pytest.raises(RenderAccessDenied):
        run(denied)
    assert not denied.executions

    async def revoked(*args):
        raise WorkspaceConflict("map_dataset_not_linked")

    monkeypatch.setattr(PostgresWorkspaceRepository, "_require_map_definition_references", revoked)
    revoked_tx = Transaction([ROLES, (payload["definition"],)])
    with pytest.raises(RenderConflict, match="source_reference_unavailable"):
        run(revoked_tx)
    assert not revoked_tx.executions


def test_portable_reads_current_selection_and_metadata_recovery(browser_artifact, monkeypatch):
    from opengeo_api.rendering import RenderConflict
    from opengeo_api.workspaces import PostgresWorkspaceRepository, WorkspaceConflict
    from test_rendering import PROJECT_ID, RESOURCE_ID, Transaction, repository
    from test_saved_map_jobs import CONTEXT, ROLES

    payload = browser_artifact
    manifest = payload["result"]["manifest"]
    artifact_id, object_id = UUID(int=100), UUID(int=101)
    edition = (
        None,
        manifest,
        manifest["manifestChecksumSha256"],
        object_id,
        UUID(manifest["provenance"]["originatingProject"]["id"]),
        1,
    )
    output = manifest["output"]
    retained = ("text/html", output["sizeBytes"], output["checksumSha256"])

    async def references(*args):
        pass

    monkeypatch.setattr(
        PostgresWorkspaceRepository, "_require_map_definition_references", references
    )

    def tx(current=None):
        return Transaction(
            [ROLES, (artifact_id, 2, current), edition, (payload["definition"],), retained]
        )

    read = tx(1)
    result = asyncio.run(
        repository(read).read_artifact_edition(
            CONTEXT, PROJECT_ID, RESOURCE_ID, None, representation="portable-map-html"
        )
    )
    assert result["manifest"] == manifest
    assert not read.executions
    select = tx()
    result = asyncio.run(
        repository(select).select_artifact_current(
            CONTEXT, PROJECT_ID, RESOURCE_ID, 1, 2, representation="portable-map-html"
        )
    )
    assert result["current_version_number"] == 1
    assert result["revision"] == 3
    assert len(select.executions) == 1

    async def revoked(*args):
        raise WorkspaceConflict("map_dataset_not_linked")

    monkeypatch.setattr(PostgresWorkspaceRepository, "_require_map_definition_references", revoked)
    with pytest.raises(RenderConflict, match="source_reference_unavailable"):
        asyncio.run(
            repository(tx(1)).read_artifact_edition(
                CONTEXT, PROJECT_ID, RESOURCE_ID, 1, representation="portable-map-html"
            )
        )
    metadata = Transaction([ROLES, (artifact_id, 3, 1)], [[(1, None, object_id)]])
    result = asyncio.run(
        repository(metadata).read_artifact_edition(
            CONTEXT, PROJECT_ID, RESOURCE_ID, None, True, representation="portable-map-html"
        )
    )
    assert result["manifest"] is None
    assert result["editions"] == [{"version_number": 1, "output_object_id": str(object_id)}]
    assert not metadata.executions


def test_portable_route_selection_and_cache_boundary():
    from test_render_routes import PROJECT_ID, RESOURCE_ID, FakeRepository, client, headers

    class PortableRepository(FakeRepository):
        async def read_artifact_edition(
            self,
            context,
            project_id,
            resource_id,
            version_number,
            metadata_only=False,
            representation="saved-map-image",
        ):
            assert representation == "portable-map-html"
            assert (project_id, resource_id) == (PROJECT_ID, RESOURCE_ID)
            return {"version_number": version_number, "manifest": None}

        async def select_artifact_current(
            self,
            context,
            project_id,
            resource_id,
            version_number,
            expected_revision,
            representation="saved-map-image",
        ):
            assert representation == "portable-map-html"
            return {"current_version_number": version_number, "revision": expected_revision + 1}

    api = client(PortableRepository())
    path = f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/artifact"
    result = api.get(path + "?representation=portable-map-html&version_number=2", headers=headers())
    assert result.status_code == 200
    assert result.headers["cache-control"] == "no-store"
    assert result.json()["version_number"] == 2
    result = api.put(
        path + "/current?representation=portable-map-html",
        headers=headers(),
        json={"version_number": 2, "expected_revision": 3},
    )
    assert result.status_code == 200
    assert result.headers["cache-control"] == "no-store"
    assert result.json()["revision"] == 4
    assert api.get(path + "?representation=unknown", headers=headers()).status_code == 422


def test_retained_finalization_authorizes_before_storage_and_rechecks_after(
    browser_artifact, monkeypatch
):
    from opengeo_api.rendering import RenderAccessDenied
    from opengeo_api.s3_downloads import ExactObject
    from opengeo_api.workspaces import PostgresWorkspaceRepository
    from test_rendering import PROJECT_ID, RESOURCE_ID, Transaction, repository
    from test_saved_map_jobs import CONTEXT, ROLES

    manifest = browser_artifact["result"]["manifest"]
    html = browser_artifact["result"]["html"].encode()
    checksum = manifest["output"]["checksumSha256"]
    artifact_id, object_id = UUID(int=100), UUID(int=101)
    storage_row = (
        "retained.invalid",
        "artifact/map.html",
        "exact-v1",
        "text/html",
        len(html),
        checksum,
        artifact_id,
        0,
        None,
        None,
    )

    class Storage:
        def __init__(self):
            self.calls = []

        async def read_exact_object(self, spec):
            self.calls.append(spec)
            return ExactObject(html, "text/html", len(html), checksum, "exact-v1")

    async def references(*args):
        pass

    monkeypatch.setattr(
        PostgresWorkspaceRepository, "_require_map_definition_references", references
    )
    storage = Storage()
    tx = Transaction(
        [
            ROLES,
            storage_row,
            ROLES,
            (browser_artifact["definition"],),
            (artifact_id, 0, None),
            ("text/html", len(html), checksum),
            None,
            (1,),
        ]
    )
    result = asyncio.run(
        repository(tx, storage).register_retained_portable_edition(
            CONTEXT, PROJECT_ID, RESOURCE_ID, object_id, json.dumps(manifest).encode(), 0
        )
    )
    assert result["version_number"] == 1
    assert len(storage.calls) == 1
    assert storage.calls[0].version_id == "exact-v1"
    assert storage.calls[0].maximum_bytes == 4194304
    denied_roles = ("member", None, None, False)
    denied = Transaction([denied_roles])
    before = len(storage.calls)
    with pytest.raises(RenderAccessDenied):
        asyncio.run(
            repository(denied, storage).register_retained_portable_edition(
                CONTEXT, PROJECT_ID, RESOURCE_ID, object_id, json.dumps(manifest).encode(), 0
            )
        )
    assert len(storage.calls) == before
    revoked = Transaction([ROLES, storage_row, denied_roles])
    with pytest.raises(RenderAccessDenied):
        asyncio.run(
            repository(revoked, storage).register_retained_portable_edition(
                CONTEXT, PROJECT_ID, RESOURCE_ID, object_id, json.dumps(manifest).encode(), 0
            )
        )
    assert not revoked.executions


def test_retained_finalization_route_passes_ids_only_and_bounds_manifest_bytes():
    from test_render_routes import PROJECT_ID, RESOURCE_ID, FakeRepository, client, headers

    class RetainedRepository(FakeRepository):
        async def register_retained_portable_edition(
            self, context, project_id, resource_id, output_id, manifest_bytes, revision
        ):
            assert (project_id, resource_id, output_id) == (PROJECT_ID, RESOURCE_ID, RESOURCE_ID)
            assert manifest_bytes == b"{}"
            assert revision == 0
            return {"version_number": 1, "reused": False}

    api = client(RetainedRepository())
    path = f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/artifact/portable-editions"
    body = {"output_object_id": str(RESOURCE_ID), "manifest_json": "{}", "expected_revision": 0}
    response = api.post(path, headers=headers(), json=body)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert (
        api.post(path, headers=headers(), json={**body, "bucket": "client-bucket"}).status_code
        == 422
    )
    assert (
        api.post(path, headers=headers(), json={**body, "manifest_json": "é" * 30000}).status_code
        == 422
    )


def test_portable_upload_ticket_binds_expected_bytes_and_caps_pending(
    browser_artifact, monkeypatch
):
    from datetime import UTC, datetime, timedelta

    from opengeo_api.portable_artifact_uploads import request_portable_upload
    from opengeo_api.rendering import RenderAccessDenied, RenderConflict
    from opengeo_api.s3_uploads import UploadForm
    from opengeo_api.workspaces import PostgresWorkspaceRepository
    from test_rendering import PROJECT_ID, RESOURCE_ID, Transaction, repository
    from test_saved_map_jobs import CONTEXT, ROLES

    class Storage:
        bucket = "local.invalid"

        def __init__(self):
            self.calls = []

        async def create_upload_form(self, spec):
            self.calls.append(spec)
            return UploadForm(
                "https://local.invalid",
                "POST",
                {"key": spec.key},
                datetime.now(UTC) + timedelta(minutes=10),
            )

    async def references(*args):
        pass

    monkeypatch.setattr(
        PostgresWorkspaceRepository, "_require_map_definition_references", references
    )
    storage = Storage()
    raw = json.dumps(browser_artifact["result"]["manifest"]).encode()
    artifact = UUID(int=100)

    def run(tx):
        return asyncio.run(
            request_portable_upload(
                repository(tx), storage, CONTEXT, PROJECT_ID, RESOURCE_ID, raw, 0
            )
        )

    tx = Transaction([ROLES, (browser_artifact["definition"],), (artifact, 0), (0,)])
    result = run(tx)
    assert result["artifact_id"] == str(artifact)
    assert len(storage.calls) == 1
    spec = storage.calls[0]
    assert spec.content_type == "text/html"
    assert spec.size_bytes == len(browser_artifact["result"]["html"].encode())
    assert (
        spec.checksum_sha256 == browser_artifact["result"]["manifest"]["output"]["checksumSha256"]
    )
    assert f"/artifacts/{artifact}/uploads/" in spec.key
    assert len(tx.executions) == 2
    capped = Transaction([ROLES, (browser_artifact["definition"],), (artifact, 0), (3,)])
    with pytest.raises(RenderConflict, match="pending_upload_limit"):
        run(capped)
    assert len(storage.calls) == 1
    denied = Transaction([("member", None, None, False)])
    with pytest.raises(RenderAccessDenied):
        run(denied)
    assert not denied.executions
    assert len(storage.calls) == 1


def test_upload_completion_verifies_once_and_completed_retry_avoids_storage(
    browser_artifact, monkeypatch
):
    from opengeo_api.portable_artifact_uploads import complete_portable_upload
    from opengeo_api.rendering import RenderAccessDenied, RenderConflict, RenderNotFound
    from opengeo_api.s3_downloads import ExactObject
    from opengeo_api.s3_uploads import StoredObject
    from opengeo_api.workspaces import PostgresWorkspaceRepository
    from test_rendering import PROJECT_ID, RESOURCE_ID, Transaction, repository
    from test_saved_map_jobs import CONTEXT, ROLES

    manifest = browser_artifact["result"]["manifest"]
    html = browser_artifact["result"]["html"].encode()
    checksum = manifest["output"]["checksumSha256"]
    artifact_id, upload_id = UUID(int=100), UUID(int=101)
    intent = (
        artifact_id,
        manifest,
        0,
        len(html),
        checksum,
        "local.invalid",
        "upload/map.html",
        None,
    )
    definition = (browser_artifact["definition"],)

    class Storage:
        bucket = "local.invalid"

        def __init__(self):
            self.heads = 0
            self.reads = 0

        async def inspect_object(self, key):
            self.heads += 1
            assert key == intent[6]
            return StoredObject(
                self.bucket, key, "immutable-v1", "etag", "text/html", len(html), checksum
            )

        async def read_exact_object(self, spec):
            self.reads += 1
            assert spec.version_id == "immutable-v1"
            return ExactObject(html, "text/html", len(html), checksum, "immutable-v1")

    async def references(*args):
        pass

    monkeypatch.setattr(
        PostgresWorkspaceRepository, "_require_map_definition_references", references
    )
    storage = Storage()

    def run(tx):
        return asyncio.run(
            complete_portable_upload(
                repository(tx, storage), storage, CONTEXT, PROJECT_ID, RESOURCE_ID, upload_id
            )
        )

    tx = Transaction([ROLES, intent, definition, ROLES, intent, definition])
    result = run(tx)
    assert len(tx.executions) == 2
    assert storage.heads == storage.reads == 1
    assert result["manifest"] == manifest
    completed = (*intent[:7], UUID(result["output_object_id"]))
    retry = Transaction([ROLES, completed, definition])
    assert run(retry) == result
    assert not retry.executions
    assert storage.heads == storage.reads == 1
    expired = Transaction([ROLES, None])
    with pytest.raises(RenderNotFound):
        run(expired)
    assert storage.heads == 1
    revoked = Transaction([ROLES, intent, definition, ("member", None, None, False)])
    with pytest.raises(RenderAccessDenied):
        run(revoked)
    assert not revoked.executions
    original_read = storage.read_exact_object

    async def tampered(spec):
        exact = await original_read(spec)
        return ExactObject(
            exact.body.replace(b"Survey", b"survey"),
            exact.content_type,
            exact.size_bytes,
            exact.checksum_sha256,
            exact.version_id,
        )

    storage.read_exact_object = tampered
    invalid = Transaction([ROLES, intent, definition])
    with pytest.raises(RenderConflict, match="bytes_invalid"):
        run(invalid)
    assert not invalid.executions


def test_upload_lifecycle_routes_are_authenticated_and_no_store():
    from test_render_routes import PROJECT_ID, RESOURCE_ID, FakeRepository, client, headers

    calls = []

    class UploadRepository(FakeRepository):
        async def request_portable_upload(self, context, project, resource, raw, revision):
            assert raw == b"{}" and revision == 0
            calls.append("request")
            return {"upload_id": str(RESOURCE_ID)}

        async def complete_portable_upload(self, context, project, resource, upload):
            assert upload == RESOURCE_ID
            calls.append("complete")
            return {"output_object_id": str(RESOURCE_ID)}

        async def cleanup_portable_upload(self, context, project, resource, upload):
            calls.append("cleanup")
            return {"state": "observed", "terminal": False}

        async def list_portable_cleanup_attempts(self, context, project, resource, upload):
            calls.append("history")
            return [{"state": "started"}]

    api = client(UploadRepository())
    base = f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/artifact/uploads"
    response = api.post(
        base, headers=headers(), json={"manifest_json": "{}", "expected_revision": 0}
    )
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    for suffix in ["complete", "cleanup"]:
        response = api.post(f"{base}/{RESOURCE_ID}/{suffix}", headers=headers())
        assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    response = api.get(f"{base}/{RESOURCE_ID}/cleanup", headers=headers())
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert calls == ["request", "complete", "cleanup", "history"]
    assert api.post(base, json={"manifest_json": "{}", "expected_revision": 0}).status_code == 401
    assert len(calls) == 4


def test_portable_storage_is_default_off_and_requires_application_bucket():
    from pydantic import ValidationError

    from opengeo_api.config import Settings

    assert Settings(env="test").portable_artifacts_enabled is False
    with pytest.raises(ValidationError, match="Portable Artifacts require"):
        Settings(env="test", portable_artifacts_enabled=True)


def test_portable_download_pins_current_and_rechecks_upstream_access(browser_artifact, monkeypatch):
    from opengeo_api.rendering import RenderConflict
    from opengeo_api.workspaces import PostgresWorkspaceRepository, WorkspaceConflict
    from test_rendering import PROJECT_ID, RESOURCE_ID, Downloads, Transaction, repository
    from test_saved_map_jobs import CONTEXT, ROLES

    manifest = browser_artifact["result"]["manifest"]
    artifact_id, object_id = UUID(int=100), UUID(int=101)
    edition = (
        None,
        manifest,
        manifest["manifestChecksumSha256"],
        object_id,
        UUID(manifest["provenance"]["originatingProject"]["id"]),
        1,
    )
    output = manifest["output"]

    async def references(*args):
        pass

    monkeypatch.setattr(
        PostgresWorkspaceRepository, "_require_map_definition_references", references
    )

    def transaction(current=1):
        return Transaction(
            [
                ROLES,
                (artifact_id, 2, current),
                edition,
                (browser_artifact["definition"],),
                ("text/html", output["sizeBytes"], output["checksumSha256"]),
                ("retained-bucket", "retained/map.html", "immutable-version"),
            ]
        )

    storage = Downloads()
    for selected in (None, 1):
        tx = transaction()
        asyncio.run(
            repository(tx, storage).request_portable_download(
                CONTEXT, PROJECT_ID, RESOURCE_ID, selected
            )
        )
        assert not tx.one and not tx.executions
    assert len(storage.specs) == 2
    assert storage.specs[0] == storage.specs[1]
    assert storage.specs[0].version_id == "immutable-version"
    assert storage.specs[0].filename == f"project-artifact-{artifact_id}-v1.html"
    assert not storage.exact_specs
    with pytest.raises(RenderConflict, match="artifact_current_unset"):
        asyncio.run(
            repository(transaction(None), storage).request_portable_download(
                CONTEXT, PROJECT_ID, RESOURCE_ID, None
            )
        )

    async def revoked(*args):
        raise WorkspaceConflict("map_dataset_not_linked")

    monkeypatch.setattr(PostgresWorkspaceRepository, "_require_map_definition_references", revoked)
    with pytest.raises(RenderConflict, match="source_reference_unavailable"):
        asyncio.run(
            repository(transaction(), storage).request_portable_download(
                CONTEXT, PROJECT_ID, RESOURCE_ID, 1
            )
        )
    assert len(storage.specs) == 2


def test_portable_download_route_is_explicit_bounded_and_uncached():
    from datetime import UTC, datetime

    from opengeo_api.s3_downloads import DownloadTicket
    from test_render_routes import PROJECT_ID, RESOURCE_ID, FakeRepository, client, headers

    calls = []

    class PortableRepository(FakeRepository):
        async def request_portable_download(self, context, project_id, resource_id, version):
            calls.append((project_id, resource_id, version))
            return DownloadTicket("https://example.test/output", "GET", datetime.now(UTC))

    api = client(PortableRepository())
    path = f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}/artifact/portable-download"
    response = api.post(path + "?version_number=3", headers=headers())
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert calls == [(PROJECT_ID, RESOURCE_ID, 3)]
    assert api.post(path + "?version_number=0", headers=headers()).status_code == 422
    assert len(calls) == 1
