import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import {normalizePanoramaCatalog, normalizePanoramaState, panoramaForProject, panoramaFromImageFile, panoramaForExport, verifyPanoramaScene} from "../src/lib/panorama.js";
import {cmrFootprintContains, parseAcquisitionAvailability, fetchAcquisitionAvailability} from "../src/lib/historicalAcquisitions.js";
import {landscapeSunPosition, createSolarLightingSession} from "../src/lib/solarLighting.js";

const image = await readFile(new URL("./fixtures/panorama-equirect.png", import.meta.url));
const rights = {attribution: "OpenGeo synthetic fixture", license: "CC0-1.0", privacyReviewed: true, exportAllowed: false};
const scene = await panoramaFromImageFile(new File([image], "panorama.png", {type: "image/png"}), {id: "p1", title: "Private panorama", position: [-71, 42], rights});
const sourceId = "nasa-gibs-hls-l30-nbar";
const scope = {sourceId, position: [-71, 42], startDate: "2024-07-01", endDate: "2024-07-10"};
const granule = {id: "G123-LPCLOUD", time_start: "2024-07-03T10:00:00Z", time_end: "2024-07-03T10:01:00Z",
  polygons: [["41 -72 41 -70 43 -70 43 -72 41 -72"]]};

test("panorama custody verifies exact source bytes and makes export a separate reviewed decision", async () => {
  assert.deepEqual(await verifyPanoramaScene(scene), scene);
  assert.equal(scene.asset.width, 128);assert.equal(scene.asset.height, 64);
  const catalog = normalizePanoramaCatalog({schemaVersion: "opengeo.panorama.1.0.0", scenes: [scene]});
  assert.throws(() => panoramaForExport(catalog), /panorama_export_review_required/);
  assert.throws(() => normalizePanoramaCatalog({...catalog, scenes: [{...scene, rights: {...rights, privacyReviewed: false}}]}), /privacy_review/);
  await assert.rejects(verifyPanoramaScene({...scene, asset: {...scene.asset, sha256: "0".repeat(64)}}), /checksum/);
  assert.equal(panoramaForExport({...catalog, scenes: [{...scene, rights: {...rights, exportAllowed: true}}]}).scenes.length, 1);
});

test("panorama source rejects remote/SVG inputs and oversized decoded images before pixel allocation", async () => {
  assert.throws(() => normalizePanoramaCatalog({schemaVersion: "opengeo.panorama.1.0.0", scenes: [{...scene, asset: {...scene.asset, dataUrl: "https://private.invalid/pano"}}]}), /asset_invalid/);
  const malicious = new File(["<svg onload='bad()'/>"], "pano.svg", {type: "image/svg+xml"});
  await assert.rejects(panoramaFromImageFile(malicious), /asset_limit/);
  const oversized = new Uint8Array(image);new DataView(oversized.buffer).setUint32(16, 65536);
  await assert.rejects(panoramaFromImageFile(new File([oversized], "bomb.png", {type: "image/png"}), {id: "bomb", title: "Bomb", position: [0, 0], rights}), /projection_invalid/);
});

test("panorama movement keeps stable local identities, refuses missing coverage and preserves invalid saved source", () => {
  const next = {...scene, id: "p2", position: [-70.9, 42], links: [{sceneId: "p1", heading: 180}]};
  const catalog = {schemaVersion: "opengeo.panorama.1.0.0", scenes: [{...scene, links: [{sceneId: "p2", heading: 90}]}, next]};
  assert.deepEqual(normalizePanoramaState({sceneId: "p2", heading: 450}, catalog), {sceneId: "p2", heading: 90, pitch: 0, fov: 75});
  assert.throws(() => normalizePanoramaState({sceneId: "missing"}, catalog), /coverage_unavailable/);
  assert.throws(() => normalizePanoramaCatalog({...catalog, scenes: [scene, scene]}), /identity_collision/);
  const invalid = {extensions: {panoramas: {schemaVersion: "unknown", untouched: "source"}}};
  assert.ok(panoramaForProject(invalid).error);assert.equal(invalid.extensions.panoramas.untouched, "source");
});

test("acquisition dates require actual metadata footprints, preserve exact UTC time and disclose bounded incompleteness", () => {
  const result = parseAcquisitionAvailability({feed: {entry: [granule, {...granule, id: "G124-LPCLOUD", polygons: undefined, boxes: ["41 -72 43 -70"]}]}}, {...scope, hits: 300});
  assert.deepEqual(result.dates, ["2024-07-03"]);assert.equal(result.granules[0].acquiredAt, "2024-07-03T10:00:00.000Z");
  assert.equal(result.unknownFootprints, 1);assert.equal(result.complete, false);
  assert.deepEqual(parseAcquisitionAvailability({feed: {entry: [{...granule, polygons: [["10 10 10 20 20 20 20 10 10 10"]]}]}}, scope).dates, []);
  assert.equal(cmrFootprintContains([["-1 179 -1 -179 1 -179 1 179 -1 179"]], [180, 0]), true);
  assert.equal(cmrFootprintContains([["-1 179 -1 -179 1 -179 1 179 -1 179"]], [0, 0]), false);
});

test("acquisition requests are deliberate, fixed-origin, credential-free, bounded and cancellable", async () => {
  let calls = 0;
  const result = await fetchAcquisitionAvailability(sourceId, {...scope, fetchImpl: async (url, options) => {
    calls++;const parsed = new URL(url);assert.equal(parsed.origin, "https://cmr.earthdata.nasa.gov");assert.equal(parsed.searchParams.get("point"), "-71,42");
    assert.equal(parsed.searchParams.get("short_name"), "HLSL30");assert.equal(options.credentials, "omit");assert.equal(options.redirect, "error");assert.equal(options.headers.Authorization, undefined);
    return new Response(JSON.stringify({feed: {entry: [granule]}}), {headers: {"content-type": "application/json", "CMR-Hits": "1"}});
  }});
  assert.equal(calls, 1);assert.equal(result.complete, true);assert.match(result.responseSha256, /^[a-f0-9]{64}$/);
  await assert.rejects(fetchAcquisitionAvailability(sourceId, {...scope, position: [NaN, 0], fetchImpl: () => {throw Error("must not request");}}), /scope_invalid/);
  await assert.rejects(fetchAcquisitionAvailability(sourceId, {...scope, fetchImpl: async () => new Response("x", {headers: {"content-type": "application/json", "content-length": "2097153"}})}), /response_limit/);
});

test("solar angles meet the independent published NREL example within declared geometric tolerance", () => {
  // NREL/TP-560-34302 Table A.5: 2003-10-17 12:30:30 MST, 39.742476,-105.1786.
  // Its reference includes refraction, intentionally absent from this geometric model.
  const sun = landscapeSunPosition("2003-10-17T19:30:30Z", -105.1786, 39.742476);
  assert.ok(Math.abs(sun.azimuth - 194.34024) < 0.1);assert.ok(Math.abs(sun.elevation - (90 - 50.11162)) < 0.1);
  assert.throws(() => landscapeSunPosition("1600-01-01T00:00:00Z", 0, 0), /scope_invalid/);
  assert.ok(landscapeSunPosition("2024-03-20T00:00:00Z", 0, 0).elevation < -80);
});

test("landscape light changes native DEM and extrusion illumination and restores prior style on stop", () => {
  let light = {anchor: "viewport", intensity: 0.5}, layer;
  const original = structuredClone(light), map = {getCenter: () => ({lng: -105.1786, lat: 39.742476}), getSource: () => ({}), getLight: () => light,
    setLight: value => {light = value;}, getLayer: () => layer, getStyle: () => ({layers: [{id: "data", type: "fill-extrusion"}]}),
    addLayer: value => {layer = value;}, removeLayer: () => {layer = undefined;}, setPaintProperty: (id, key, value) => {layer.paint[key] = value;}, triggerRepaint() {}};
  const session = createSolarLightingSession(() => map);
  session.apply("2003-10-17T19:30:30Z");assert.equal(light.anchor, "map");assert.equal(layer.type, "hillshade");assert.equal(layer.source, "opengeo-mapterhorn-terrain");
  assert.equal(layer.paint["hillshade-method"], "basic", "Legacy standard hillshade ignores solar altitude");
  const altitude = layer.paint["hillshade-illumination-altitude"];
  assert.ok(Math.abs(altitude - (90 - 50.11162)) < 0.1);
  const afternoon = light.position;session.apply("2003-10-17T22:30:30Z");assert.notDeepEqual(light.position, afternoon);
  assert.notEqual(layer.paint["hillshade-illumination-altitude"], altitude);
  session.stop();assert.equal(layer, undefined);assert.deepEqual(light, original);
});
