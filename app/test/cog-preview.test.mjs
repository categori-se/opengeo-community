import assert from "node:assert/strict";
import {it} from "node:test";
import {readFile} from "node:fs/promises";
import {JSDOM} from "jsdom";
import * as geotiff from "geotiff";
import proj4 from "proj4";
import {readCogPreview, sampleCogPreview, releaseCogPreview, cogGridView} from "../src/lib/cogPreview.js";
import {installCogMapLayer} from "../src/lib/cogMapLayer.js";
import {isCredentialFreeShellPath} from "../scripts/studio-pwa-assets.mjs";
const source = {sourceUrl: "https://imagery.example/visual.tif", configuration: {bounds: [9, 40, 10, 41], bands: [1, 2, 3], sizeBytes: 256914673}};

it("native analysis grid uses exact cached cells and immutable provenance without treating display masks as NoData",async()=>{
  const values=Array.from({length:64},(_,index)=>index===5?-9999:index);
  const result=await readFixture(scalarFixture(new Float32Array(values),3),{displayRange:{minimum:0,maximum:63},noDataValue:0});
  const grid=cogGridView(result),usage=JSON.stringify(result.usage);
  assert.deepEqual(grid.coordinate(2,1),[2.5,6.5]);assert.deepEqual(grid.coordinate(2,1,true),[2,7]);
  assert.deepEqual(grid.locate(2.2,6.2),{column:2,row:1});assert.equal(grid.locate(NaN,0),null);
  assert.equal(grid.value(0,0,1),0);assert.equal(grid.value(5,0,1),null);assert.equal(grid.value(2,1,1),10);
  assert.throws(()=>grid.value(0,0,2));assert.throws(()=>grid.coordinate(-1,0));
  result.snapshot.url="https://changed.example/";assert.notEqual(grid.metadata.source.url,result.snapshot.url);
  assert.equal(JSON.stringify(result.usage),usage);assert(Object.isFrozen(grid.metadata.source));
  releaseCogPreview(result);assert.equal(grid.active(),false);assert.throws(()=>grid.value(0,0,1),/released/);
});

it("rejects whole-file or changed-size responses before decoding pixels", async () => {
  for (const status of [200, 403, 404, 206]) {
    let calls = 0;
    const libraryLoader = async () => ({fromCustomClient: async client => client.request({headers: {Range: "bytes=0-65535"}})});
    await assert.rejects(readCogPreview(source, {libraryLoader, fetchImplementation: async (url, options) => {
      calls++; assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
      return new Response(null, {status, headers: {"content-range": "bytes 0-65535/1", etag: '"snapshot"'}});
    }}), /range or snapshot/);
    assert.equal(calls, 1);
  }
});

it("cancelled or credential-bearing COG references never load the reader", async () => {
  let loads = 0; const libraryLoader = async () => {loads++; throw Error("unexpected load");};
  await assert.rejects(readCogPreview({...source, sourceUrl: source.sourceUrl + "?X-Amz-Signature=secret"}, {libraryLoader}));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readCogPreview(source, {signal: controller.signal, libraryLoader}));
  // Cancellation must precede even the dynamic import.
  assert.equal(loads, 0);
});

it("public S3 hidden headers require a known size and exact bounded length; failures stop further dispatch", async () => {
  let inspected = false;
  const libraryLoader = async () => ({fromCustomClient: async client => {
    const response = await client.request({headers: {Range: "bytes=0-65535"}});
    assert.equal(response.getHeader("content-range"), "bytes 0-65535/256914673");
    assert.equal((await response.getData()).byteLength, 65536); inspected = true;
    throw Error("bounded transport inspected");
  }});
  await assert.rejects(readCogPreview(source, {libraryLoader, fetchImplementation: async () =>
    new Response(new Uint8Array(65536), {status: 206, headers: {"content-length": "65536"}})}), /bounded transport inspected/);
  assert(inspected);
  let calls = 0;
  const retryingReader = async () => ({fromCustomClient: async client => {
    for (let i = 0; i < 2; i++) await client.request({headers: {Range: "bytes=0-65535"}}).catch(() => {});
    throw Error("stopped");
  }});
  await assert.rejects(readCogPreview(source, {libraryLoader: retryingReader, fetchImplementation: async () => {
    calls++; return new Response(new Uint8Array(65535), {status: 206, headers: {"content-length": "65536"}});
  }}));
  assert.equal(calls, 1);
  await assert.rejects(readCogPreview({...source, configuration: {...source.configuration, sizeBytes: null}}, {
    libraryLoader, fetchImplementation: async () => new Response(new Uint8Array(65536), {status: 206, headers: {"content-length": "65536"}})
  }), /range or snapshot/);
});

it("optional public readers are absent from installation-time PWA fetches", () => {
  for (const path of ["_node/geotiff@3.1.0-beta.0/dist-module/geotiff.js", "_node/proj4@2.22.0/index.js", "_node/hyparquet@1.31.1/src/index.js", "_node/hyparquet-compressors@1.1.2/index.js"]) assert.equal(isCredentialFreeShellPath(path), false);
  assert.equal(isCredentialFreeShellPath("_import/components/StaticItemSearch.hash.js"), true);
  assert.equal(isCredentialFreeShellPath("_file/assets/cog-reader-3.1.0-beta.0.hash.js"), false);
});

it("renders real floating-point TIFF samples with negative ranges and transparent missing values", async () => {
  const values = [-200, -100, -0.1, 100, 200, -9999, NaN, Infinity];
  const fixture = scalarFixture(new Float32Array(Array.from({length: 64}, (_, index) => values[index % 8])), 3);
  const result = await readFixture(fixture, {displayRange: {minimum: -100, maximum: 100}});
  for (const [column, gray] of [[0, 0], [1, 0], [2, 127], [3, 255], [4, 255]]) {
    assert.deepEqual(pixel(result, column), [gray, gray, gray, 255]);
  }
  for (const column of [5, 6, 7]) assert.deepEqual(pixel(result, column), [0, 0, 0, 0]);
  const masked = await readFixture(fixture, {displayRange: {minimum: -100, maximum: 100}, noDataValue: -0.1});
  assert.deepEqual(pixel(masked, 2), [0, 0, 0, 0]);
  assert.deepEqual(masked.displayRange, {minimum: -100, maximum: 100});
  assert.equal(masked.noDataValue, -0.1);
  await assert.rejects(readFixture(fixture), /Choose a display range/);
});

it("decodes signed integer TIFF pixels and retains the unsigned default display", async () => {
  // Encode the two's-complement bytes as UInt16, declaring their actual signed
  // sample format in the TIFF; the real reader performs signed decoding.
  const values = [-200, -100, 0, 100, 200, -9999, -50, 50];
  const fixture = scalarFixture(new Uint16Array(Array.from({length: 64}, (_, index) => values[index % 8])), 2);
  const result = await readFixture(fixture, {displayRange: {minimum: -100, maximum: 100}});
  assert.deepEqual(pixel(result, 1), [0, 0, 0, 255]);
  assert.deepEqual(pixel(result, 2), [128, 128, 128, 255]);
  assert.deepEqual(pixel(result, 5), [0, 0, 0, 0]);
  assert.deepEqual(pixel(result, 6), [64, 64, 64, 255]);
  assert.deepEqual(pixel(result, 7), [191, 191, 191, 255]);
  const unsigned = await readFixture(scalarFixture(new Uint16Array(64).fill(65535), 1));
  assert.deepEqual(pixel(unsigned, 2), [255, 255, 255, 255]);
  assert.equal(unsigned.displayRange, null);
  const rgb = await readFixture(scalarFixture(new Uint8Array(Array.from({length: 64 * 3}, (_, index) => [12, 128, 255][index % 3])), 1), {bands: [1, 2, 3]});
  assert.deepEqual(pixel(rgb, 2), [12, 128, 255, 255]);
});

it("rejects invalid ranges, multiband scalar choices and nonfinite transparent values before any read", async () => {
  let loads = 0;
  const libraryLoader = async () => {loads++; throw Error("unexpected read");};
  const scalar = {...source, configuration: {...source.configuration, bands: [1]}};
  for (const displayRange of [{minimum: 1, maximum: 1}, {minimum: 2, maximum: 1},
    {minimum: NaN, maximum: 1}, {minimum: -1e308, maximum: 1e308}]) {
    await assert.rejects(readCogPreview(scalar, {displayRange, libraryLoader}), /finite minimum/);
  }
  await assert.rejects(readCogPreview(source, {displayRange: {minimum: 0, maximum: 1}, libraryLoader}), /one-band/);
  await assert.rejects(readCogPreview(scalar, {noDataValue: Infinity, libraryLoader}), /transparent value/);
  assert.equal(loads, 0);
});

it("forwards temporary display options and cancels late map results without changing the source", async () => {
  const original = JSON.stringify(source), events = new Map(), requests = [];
  let additions = 0, ready = 0;
  const map = {on(name, handler) {events.set(name, handler);}, off() {}, getLayer() {}, getSource() {}, addSource() {additions++;}};
  const session = installCogMapLayer(map, {source, sourceId: "raster", layerId: "raster", onReady: () => {ready++;},
    read: (_source, options) => new Promise(resolve => requests.push({options, resolve}))});
  const display = {displayRange: {minimum: -20, maximum: 30}, noDataValue: -9999};
  const pending = session.refresh([1, 2, 3, 4], display);
  assert.deepEqual(requests[0].options.displayRange, display.displayRange);
  assert.equal(requests[0].options.noDataValue, -9999);
  session.cancel(); assert.equal(requests[0].options.signal.aborted, true);
  requests[0].resolve({}); await pending;
  const next = session.refresh(); session.dispose();
  assert.equal(requests[1].options.signal.aborted, true);
  requests[1].resolve({}); await next;
  assert.equal(additions, 0); assert.equal(ready, 0); assert.equal(JSON.stringify(source), original);
});

it("temporary Catalog controls apply deliberately, retain the applied range on refresh and cancel reads", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), globals = new Map();
  const requests = []; let cancellations = 0, disposals = 0;
  const session = {refresh(bounds, options) {
    const request = {bounds, options}; requests.push(request);
    if (requests.length === 1) return Promise.resolve({});
    return new Promise(resolve => {request.resolve = resolve;});
  }, cancel() {cancellations++; requests.at(-1).resolve();}, dispose() {disposals++;}};
  class TestMap {
    constructor() {this.events = new Map(); queueMicrotask(() => this.events.get("load")());}
    on(name, handler) {this.events.set(name, handler);}
    addControl() {} fitBounds() {} getBounds() {return {toArray: () => [[1, 2], [3, 4]]};} getCenter(){return {toArray:()=>[2,3]};} remove() {}
  }
  const replacements = {document: dom.window.document, MutationObserver: dom.window.MutationObserver,
    __cogTestRenderer: {Map: TestMap, NavigationControl: class {}, ScaleControl: class {}},
    __cogTestInstall: () => session};
  for (const [key, value] of Object.entries(replacements)) {globals.set(key, globalThis[key]); globalThis[key] = value;}
  try {
    const path = new URL("../src/components/MapView.js", import.meta.url);
    const code = (await readFile(path, "utf8"))
      .replace('import maplibregl from "../lib/mapRenderer.js";', 'const maplibregl = globalThis.__cogTestRenderer;')
      .replace('import {installCogMapLayer} from "../lib/cogMapLayer.js";', 'const installCogMapLayer = globalThis.__cogTestInstall;')
      .replace(/from "(\.\.?\/[^\"]+)"/g, (_match, specifier) => `from ${JSON.stringify(new URL(specifier, path).href)}`);
    const {MapView} = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
    const scalar = {...source, configuration: {...source.configuration, bands: [1]}}, original = JSON.stringify(scalar);
    const view = MapView({cog: scalar}); document.body.append(view); await tick();
    const form = view.querySelector("form"), inputs = [...form.querySelectorAll("input")];
    const button = name => [...view.querySelectorAll("button")].find(item => item.textContent === name);
    inputs[0].value = "-100"; inputs[1].value = "-200";
    form.dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
    assert.equal(requests.length, 1); assert.match(view.textContent, /finite minimum below/);
    inputs[1].value = "100"; inputs[2].value = "-9999";
    inputs[1].dispatchEvent(new dom.window.Event("input")); assert.equal(requests.length, 1);
    form.dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].bounds, [1, 2, 3, 4]);
    assert.deepEqual(requests[1].options, {displayRange: {minimum: -100, maximum: 100}, noDataValue: -9999});
    requests[1].resolve({}); await tick();
    button("Refresh raster window").click(); assert.equal(requests.length, 3);
    assert.deepEqual(requests[2].options, requests[1].options);
    button("Cancel raster read").click(); await tick();
    assert.equal(cancellations, 1); assert.match(view.textContent, /Raster read cancelled/);
    assert.equal(button("Refresh raster window").disabled, false);
    view.remove(); await tick(); assert.equal(disposals, 1);
    assert.equal(JSON.stringify(scalar), original);
  } finally {
    for (const [key, value] of globals) {if (value === undefined) delete globalThis[key]; else globalThis[key] = value;}
    dom.window.close();
  }
});

function scalarFixture(values, format, metadata = {}) {
  return new Uint8Array(geotiff.writeArrayBuffer(values, {width: 8, height: 8, SampleFormat: Array(values.length / 64).fill(format),
    ModelPixelScale: [1, 1, 0], ModelTiepoint: [0, 0, 0, 0, 8, 0], GeographicTypeGeoKey: 4326, GDAL_NODATA: "-9999", ...metadata}));
}
async function readFixture(bytes, {bands = [1], imageDecorator = image => image, ...options} = {}) {
  let calls = 0;
  const result = await readCogPreview({sourceUrl: source.sourceUrl, configuration: {bounds: [0, 0, 8, 8], bands, sizeBytes: bytes.length}}, {
    ...options, libraryLoader: async () => ({...geotiff, proj4, fromCustomClient: async (...args) => {
      const tiff = await geotiff.fromCustomClient(...args), getImage = tiff.getImage.bind(tiff);
      tiff.getImage = async (...params) => imageDecorator(await getImage(...params)); return tiff;
    }}), fetchImplementation: async (_url, request) => {
      assert.equal(request.credentials, "omit"); assert.equal(request.redirect, "error");
      const [, start, requestedEnd] = /^bytes=(\d+)-(\d+)$/.exec(new Headers(request.headers).get("range"));
      const end = Math.min(Number(requestedEnd), bytes.length - 1); calls++;
      return new Response(bytes.slice(Number(start), end + 1), {status: 206,
        headers: {"content-range": `bytes ${start}-${end}/${bytes.length}`, etag: '"local-fixture"'}});
    }});
  assert(calls <= 16); assert(result.usage.bytes <= 4 * 1024 * 1024); return result;
}
// GeoTIFF's pinned nearest resampler rounds source coordinates; probe inside
// each known sample cell instead of at its half-cell selection boundary.
function pixel(result, column) {return Array.from(result.pixels.slice((256 * 512 + column * 64 + 16) * 4, (256 * 512 + column * 64 + 16) * 4 + 4));}
function tick() {return new Promise(resolve => setTimeout(resolve, 15));}


it("successful transparent refresh clears old pixels and hidden activation retains saved display options", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), keys = ["document", "ImageData", "requestAnimationFrame"], previous = keys.map(key => globalThis[key]);
  globalThis.document = dom.window.document;
  globalThis.ImageData = class {constructor(data) {this.data = data;}};
  globalThis.requestAnimationFrame = callback => {callback();};
  dom.window.HTMLCanvasElement.prototype.getContext = function () {
    this.rgba ??= [0, 0, 0, 0]; const canvas = this;
    return {putImageData(image) {canvas.rgba = [...image.data];}, clearRect() {canvas.rgba = [0, 0, 0, 0];},
      drawImage(next) {if (next.rgba[3]) canvas.rgba = [...next.rgba];}};
  };
  try {
    const display = {displayRange: {minimum: -100, maximum: 100}, noDataValue: null}, requests = [], sources = new Map(), layers = new Map();
    let nextPixels = [20, 20, 20, 255], fail = false;
    const map = {on() {}, off() {}, getSource: id => sources.get(id), getLayer: id => layers.get(id),
      addSource(id, value) {sources.set(id, {...value, setCoordinates() {}, play() {}, pause() {}});}, addLayer(value) {layers.set(value.id, value);},
      setLayoutProperty() {}, triggerRepaint() {}, removeLayer(id) {layers.delete(id);}, removeSource(id) {sources.delete(id);}};
    const session = installCogMapLayer(map, {source, sourceId: "raster", layerId: "raster", visible: false, displayOptions: display,
      read: async (_source, options) => {requests.push(options); if (fail) throw Error("failed read"); return {width: 1, height: 1, pixels: new Uint8ClampedArray(nextPixels), coordinates: [], snapshot: {verified: true}, overviewScale: 1};}});
    assert.equal(requests.length, 0); session.setVisible(true); await tick();
    assert.deepEqual(requests[0].displayRange, display.displayRange); assert.deepEqual(sources.get("raster").canvas.rgba, nextPixels);
    nextPixels = [0, 0, 0, 0]; const applied = {...display, noDataValue: 20}; await session.refresh(undefined, applied);
    assert.deepEqual(sources.get("raster").canvas.rgba, [0, 0, 0, 0]);
    const prior = session.result; fail = true; await assert.rejects(session.refresh(undefined, {...display, noDataValue: 30}), /failed read/);
    assert.equal(session.result, prior); fail = false; await session.refresh(); assert.equal(requests.at(-1).noDataValue, 20);
    session.dispose();
  } finally {keys.forEach((key, index) => {if (previous[index] === undefined) delete globalThis[key]; else globalThis[key] = previous[index];}); dom.window.close();}
});

it("uses the selected band's sample metadata and rejects heterogeneous RGB normalization", async () => {
  const fixture = scalarFixture(new Float32Array(64 * 3).fill(-50), 3);
  const decorate = image => {
    image.getBitsPerSample = sample => sample === 0 ? 8 : 32;
    image.getSampleFormat = sample => sample === 0 ? 1 : 3;
    return image;
  };
  const selected = await readFixture(fixture, {bands: [2], displayRange: {minimum: -100, maximum: 100}, imageDecorator: decorate});
  assert.deepEqual(pixel(selected, 2), [64, 64, 64, 255]);
  await assert.rejects(readFixture(fixture, {bands: [1, 2, 3], imageDecorator: decorate}), /matching unsigned/);
});

it("Identify returns unscaled native samples, masks and missing data without another range read", async () => {
  const values = [-200, -100, -0.1, 100, 200, -9999, NaN, Infinity];
  const result = await readFixture(scalarFixture(new Float32Array(Array.from({length:64},(_,index)=>values[index%8])),3),
    {displayRange:{minimum:-100,maximum:100},noDataValue:-0.1});
  const before = {...result.usage};
  const pick = column => sampleCogPreview(result,column+.25,3.75);
  assert.equal(pick(0).samples[0].value,-200);assert.equal(pick(4).samples[0].value,200);
  assert.equal(pick(2).samples[0].value,Math.fround(-0.1));assert.equal(pick(2).missing,"display-mask");
  assert.equal(pick(5).samples[0].missing,"source-nodata");assert.equal(pick(5).samples[0].value,-9999);
  assert.equal(pick(6).samples[0].nonfinite,"NaN");assert.equal(pick(7).samples[0].nonfinite,"Infinity");
  assert.deepEqual(pick(0).pixel,{column:0,row:4});assert.equal(pick(0).grid.imageIndex,0);
  assert.equal(sampleCogPreview(result,9,3).status,"outside-window");
  assert.equal(sampleCogPreview(result,NaN,3).status,"invalid-location");
  assert.deepEqual(result.usage,before);releaseCogPreview(result);assert.equal(pick(0).status,"unavailable");
  const nan = await readFixture(scalarFixture(new Float32Array(64).fill(NaN),3,{GDAL_NODATA:"nan"}),{displayRange:{minimum:0,maximum:1}});
  assert.equal(sampleCogPreview(nan,1,7).samples[0].missing,"source-nodata");
  const rgb = await readFixture(scalarFixture(new Uint8Array(Array.from({length:192},(_,i)=>[12,128,255][i%3])),1),{bands:[3,1,2]});
  assert.deepEqual(sampleCogPreview(rgb,1.25,6.75).samples.map(({band,value})=>[band,value]),[[3,255],[1,12],[2,128]]);
});

it("cached sampling respects point-centered grids and nonzero raster tie coordinates", async () => {
  const values = new Uint8Array(Array.from({length:64},(_,i)=>i));
  const point = await readFixture(scalarFixture(values,1,{GTRasterTypeGeoKey:2}));
  const sample = sampleCogPreview(point,.8,7.2);
  assert.deepEqual(sample.pixel,{column:1,row:1});assert.equal(sample.samples[0].value,9);assert.equal(sample.grid.interpretation,"point");
  const tie = await readFixture(scalarFixture(values,1,{ModelTiepoint:[2,3,0,0,8,0]}));
  assert.deepEqual(sampleCogPreview(tie,.2,7.8).pixel,{column:2,row:3});assert.equal(sampleCogPreview(tie,.2,7.8).samples[0].value,26);
});

it("sampling identifies the selected real overview grid rather than claiming main-grid resolution", async () => {
  // Two actual TIFF images exercise the existing overview-selection interface;
  // container/transport conformance is covered separately by range-reader checks.
  const encode = (width, scale, value) => geotiff.writeArrayBuffer(new Uint8Array(width*width).fill(value),
    {width,height:width,ModelPixelScale:[scale,scale,0],ModelTiepoint:[0,0,0,0,8,0],GeographicTypeGeoKey:4326});
  const tiffs = await Promise.all([geotiff.fromArrayBuffer(encode(1024,8/1024,10)),geotiff.fromArrayBuffer(encode(512,8/512,200))]);
  let reads = 0;
  const result = await readCogPreview({sourceUrl:source.sourceUrl,configuration:{bounds:[0,0,8,8],bands:[1]}},{
    libraryLoader:async()=>({proj4,fromCustomClient:async()=>({getImageCount:async()=>2,getImage:async index=>tiffs[index].getImage(0),close:async()=>Promise.all(tiffs.map(tiff=>tiff.close()))})}),
    fetchImplementation:()=>{reads++;throw Error("Unexpected sampling I/O");}});
  const sample = sampleCogPreview(result,4,4);
  assert.equal(sample.grid.imageIndex,1);assert.equal(sample.grid.scaleX,2);assert.equal(sample.grid.scaleY,2);
  assert.deepEqual(sample.pixel,{column:256,row:256});assert.equal(sample.samples[0].value,200);assert.equal(reads,0);
  releaseCogPreview(result);
});

it("map cache replacement, cancellation, hiding and disposal preserve only the current retained sample window", async () => {
  const first = await readFixture(scalarFixture(new Uint8Array(64).fill(12),1));
  const second = await readFixture(scalarFixture(new Uint8Array(64).fill(34),1));
  const late = await readFixture(scalarFixture(new Uint8Array(64).fill(56),1));
  const dom = new JSDOM("<!doctype html><body></body>"), names=["document","ImageData","requestAnimationFrame"], previous=names.map(key=>globalThis[key]);
  globalThis.document=dom.window.document;globalThis.ImageData=class {constructor(data){this.data=data;}};globalThis.requestAnimationFrame=fn=>fn();
  dom.window.HTMLCanvasElement.prototype.getContext=()=>({putImageData(){},clearRect(){},drawImage(){}});
  try {
    const sources=new Map(),layers=new Map();const map={on(){},off(){},getSource:id=>sources.get(id),getLayer:id=>layers.get(id),
      addSource(id,value){sources.set(id,{...value,setCoordinates(){},play(){},pause(){}});},addLayer(value){layers.set(value.id,value);},
      setLayoutProperty(){},setPaintProperty(){},triggerRepaint(){},removeLayer:id=>layers.delete(id),removeSource:id=>sources.delete(id)};
    let next=first, finish;
    const session=installCogMapLayer(map,{source,sourceId:'raster',layerId:'raster',read:async()=>next});
    await session.refresh();assert.equal(session.identify(1,7).samples[0].value,12);const firstGrid=session.grid;assert(firstGrid.active());
    session.setVisible(false);assert.equal(session.identify(1,7).status,'unavailable');assert.equal(session.grid,null);assert.equal(firstGrid.active(),false);session.setVisible(true);
    next=second;await session.refresh();assert.equal(sampleCogPreview(first,1,7).status,'unavailable');assert.equal(session.identify(1,7).samples[0].value,34);
    next=new Promise(resolve=>{finish=resolve;});const pending=session.refresh();session.cancel();finish(late);await pending;
    assert.equal(sampleCogPreview(late,1,7).status,'unavailable');assert.equal(session.identify(1,7).samples[0].value,34);
    session.dispose();assert.equal(sampleCogPreview(second,1,7).status,'unavailable');assert.equal(session.identify(1,7).status,'unavailable');
  } finally {names.forEach((key,index)=>{if(previous[index]===undefined)delete globalThis[key];else globalThis[key]=previous[index];});dom.window.close();}
});
