import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {PINNED_MAP_FONT} from "../src/lib/mapFonts.js";
import {createMapboxSession} from "../src/lib/mapboxSession.js";
import {createMapboxAdapter, mapboxCompatibility, MAPBOX_VERSION} from "../src/lib/mapboxAdapter.js";
import {createMapboxLoader} from "../src/lib/mapboxLoader.js";
import {MAPBOX_RUNTIME} from "../src/lib/mapboxRuntime.js";
import {prepareMapboxRuntime} from "../scripts/prepare-mapbox-runtime.mjs";
import {isCredentialFreeShellPath} from "../scripts/studio-pwa-assets.mjs";
import {addMapLayer} from "../src/components/WorkbenchView.js";

const publicToken = "pk.local-fixture.not-a-real-token";
function session() { const s = createMapboxSession(); s.configure(publicToken); return s; }
function sdk() {
  return {version:MAPBOX_VERSION, accessToken:"unchanged",
    Map:class { constructor(options) { this.options = options; } remove() {} },
    Popup:class {}, LngLatBounds:class {}};
}

test("token stays in the credential session and per-map options; rejection never echoes it", () => {
  const s = session(), engine = sdk(), adapter = createMapboxAdapter(engine, s);
  for (const value of ["sk.do-not-repeat.secret", "pk.bad\n.token", "", "pk.only-two"]) {
    assert.throws(() => s.configure(value), error => !error.message.includes("do-not-repeat") && /public Mapbox token/.test(error.message));
  }
  const options = {style:{version:8, sources:{}, layers:[]}};
  const map = adapter.createMap(options);
  assert.equal(map.options.accessToken, publicToken);
  assert.equal(engine.accessToken, "unchanged");
  assert.equal(JSON.stringify({s, adapter, options}).includes(publicToken), false);
  assert.equal(Object.hasOwn(options, "accessToken"), false);
  s.clear();
  assert.throws(() => adapter.createMap(options), /public_token_required/);
  adapter.disposeMap(map);
});

test("compatibility preserves hidden unsupported definitions and reports known blockers without URLs", () => {
  const layers = [{layerId:"hidden",title:"Archive",visible:false,sourceType:"pmtiles-vector",labels:{enabled:true},opacityMode:"composite"}];
  const snapshot = structuredClone(layers);
  const report = mapboxCompatibility({layers, state:{mapAuthoring:{},terrainEnabled:true},
    style:{sky:{},sources:{private:{url:"reviewed-archive://private-url"}}}});
  assert.equal(report.ready, false);
  for (const code of ["archive-protocol", "pinned-fonts", "composite-opacity", "active-edit", "terrain-scene", "style-protocol"]) {
    assert.ok(report.issues.some(issue => issue.code === code), code);
  }
  assert.deepEqual(layers, snapshot);
  assert.equal(JSON.stringify(report).includes("private-url"), false);
  assert.equal(mapboxCompatibility({layers:[{layerId:"point",sourceType:"geojson-object"}]}).ready, true);
});

test("Mapbox admits verified pinned labels while retaining unknown-font blockers", () => {
  const layers = [{layerId:"labels",labels:{enabled:true,fontRef:PINNED_MAP_FONT}}];
  const style = {glyphs:"opengeo-font://registered/{fontstack}/{range}.pbf"};
  const state = {mapFontSession:{supportsRenderer:id=>id==="mapbox",ownsGlyphTemplate:value=>value===style.glyphs}};
  assert.equal(mapboxCompatibility({layers,style,state}).ready,true);
  assert.equal(mapboxCompatibility({layers,style}).ready,false);
  assert.equal(mapboxCompatibility({layers:[{labels:{enabled:true}}],state}).ready,false);
  assert.equal(mapboxCompatibility({style:{glyphs:"opengeo-font://unknown/font"},state}).ready,false);
});

test("adding an unsupported Layer keeps its definition and exposes a renderer issue", () => {
  const map = createMapboxAdapter(sdk(),session()).createMap({});
  const state = {map,layerHandles:new Map()};
  const layer = {layerId:"archive",sourceType:"pmtiles-vector",sourceUrl:"https://example.test/a.pmtiles",visible:true};
  const before=structuredClone(layer);
  addMapLayer(state,layer,null,[]);
  assert.deepEqual(layer,before);
  assert.match(state.rendererLayerIssues.get(layer.layerId),/MapLibre/);
  assert.equal(state.layerHandles.size,0);
});

test("SDK loading is explicit, deduplicated, same-origin and integrity checked", async () => {
  const dom = new JSDOM("<!doctype html><head></head>", {url:"https://studio.test/"});
  try {
    const {document} = dom.window, loader = createMapboxLoader({document, window:dom.window});
    assert.equal(document.head.children.length, 0);
    await assert.rejects(loader.load(createMapboxSession()), /public_token_required/);
    assert.equal(document.head.children.length, 0);
    const a = loader.load(session()), b = loader.load(session());
    assert.equal(document.head.children.length, 2);
    dom.window.mapboxgl = sdk();
    for (const element of document.head.children) {
      assert.ok(element.integrity.startsWith("sha384-"));
      assert.equal(new URL(element.src || element.href).origin, "https://studio.test");
      assert.equal((element.src || element.href).includes(publicToken), false);
      element.dispatchEvent(new dom.window.Event("load"));
    }
    assert.equal((await a).version, MAPBOX_VERSION);
    assert.equal((await b).version, MAPBOX_VERSION);
    assert.equal(document.head.children.length, 2);
  } finally { dom.window.close(); }
});

test("failed load cleans assets; deliberate retry rechecks credentials after loading", async () => {
  const dom = new JSDOM("<!doctype html><head></head>");
  try {
    const {document} = dom.window, loader = createMapboxLoader({document, window:dom.window});
    const failed = loader.load(session());
    const rejection = assert.rejects(failed, /runtime_load_failed/);
    document.querySelector("script").dispatchEvent(new dom.window.Event("error"));
    await rejection;
    assert.equal(document.head.children.length, 0);
    const s = session(), retry = loader.load(s);
    s.clear();
    const cleared = assert.rejects(retry, /public_token_required/);
    dom.window.mapboxgl = sdk();
    for (const element of document.head.children) element.dispatchEvent(new dom.window.Event("load"));
    await cleared;
  } finally { dom.window.close(); }
});

test("release assets retain exact SDK, CSS and license bytes without compiling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opengeo-mapbox-assets-"));
  try {
    await prepareMapboxRuntime(dir);
    for (const asset of MAPBOX_RUNTIME.assets) {
      assert.equal(isCredentialFreeShellPath(`${MAPBOX_RUNTIME.basePath.slice(1)}${asset.name}`), false,
        "Unused optional SDK must not be fetched by PWA installation");
      const bytes = await readFile(join(dir, MAPBOX_RUNTIME.basePath, asset.name));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
      assert.equal(`sha384-${createHash("sha384").update(bytes).digest("base64")}`, asset.integrity);
    }
  } finally { await rm(dir, {recursive:true,force:true}); }
});
