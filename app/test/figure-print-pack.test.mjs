import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import {unzipSync, strFromU8} from "fflate";
import {compileFigurePrintPack, rasterPagePdf} from "../src/lib/figurePrintPack.js";
import {canonicalJson} from "../src/lib/artifactCanonicalJson.js";
import {compilePublicationMapHandoff} from "../src/lib/publicationMapHandoff.js";
import {compilePortableMapArtifact, verifyPortableMapArtifact} from "../src/lib/portableMapArtifact.js";
import {readPublicationSourceArchive} from "../src/lib/publicationSourceArchive.js";
import {capturePrintDataFrames} from "../src/lib/printDataFrames.js";
import {continuousLegendRows} from "../src/lib/printContinuousLegend.js";
import {printCaptureOutputSignature, printCaptureTarget} from "../src/lib/printLayouts.js";

function fixture() {
  const frame = {id: "main", view: {center: [0, 0], zoom: 4, pitch: 0, bearing: 0}, presentation: []};
  const png = Uint8Array.of(137,80,78,71,13,10,26,10), jpeg = Uint8Array.of(255,216,255,217);
  const layout = {id: "layout", title: "Survey", page: {widthMm: 297, heightMm: 210, size: "A4", orientation: "landscape"}, dpi: 96, frames: [frame]};
  const capture = {dataUrl: `data:image/png;base64,${Buffer.from(png).toString("base64")}`, imageSha256: createHash("sha256").update(png).digest("hex"),
    width: 100, height: 80, cssWidth: 100, cssHeight: 80, view: frame.view, presentation: frame.presentation,
    signature: canonicalJson({view: frame.view, presentation: frame.presentation}), attribution: ["Original credit", "Curated credit"],
    legend: [{label: "Survey", color: "#418fbb"}], sourceMetadata: [{license: "CC0-1.0", sourceAttribution: "Original credit", curatedAttribution: "Curated credit"}],
    extraPrivateConfiguration: "secret-must-not-be-copied"};
  return {layout, layoutId: "layout", captures: new Map([["layout:main", capture]]), svg: "<svg></svg>", html: "<!doctype html>",
    png: new Blob([png], {type: "image/png"}), jpeg: new Blob([jpeg], {type: "image/jpeg"}), width: 1123, height: 794};
}

function dataFrameFixture() {
  const options = fixture(), capture = options.captures.get("layout:main");
  const sourcePin = {layerId: "survey", datasetId: "survey-dataset", datasetVersionId: "survey-v2", sourceVersion: null,
    featureGeneration: 3, checksumSha256: "a".repeat(64)};
  const {featureGeneration, checksumSha256, ...source} = sourcePin;
  const context = {getPrintDataSource: layerId => layerId === source.layerId ? {id: layerId, inputPin: sourcePin,
    geojson: {type: "FeatureCollection", features: [
      {type: "Feature", properties: {site: "North <site>", score: -2.5}, geometry: null},
      {type: "Feature", properties: {site: "South", score: "00123"}, geometry: null},
      {type: "Feature", properties: {site: "Beyond row limit", score: null}, geometry: null}
    ]}} : null};
  options.layout.frames[0].presentation = [source];capture.presentation = [source];
  capture.signature = canonicalJson({view: capture.view, presentation: capture.presentation});
  options.layout.dataFrames = [
    {id: "survey-table", mapFrameId: "main", type: "table", columns: ["site", "score"], source, rowLimit: 2},
    {id: "survey-chart", mapFrameId: "main", type: "chart", chartType: "line", labelField: "site", valueField: "score", source, rowLimit: 2}
  ];
  capture.dataFrames = capturePrintDataFrames(context, {definition: {layers: [source]}}, options.layout.dataFrames, capture.presentation);
  capture.sourceMetadata = [{...source, license: "CC-BY-4.0"}];
  return {options, sourcePin};
}

test("figure package binds output files, captured pixels and separate source rights without copying configuration", async () => {
  const options = fixture(), first = await compileFigurePrintPack(options), second = await compileFigurePrintPack(options);
  assert.deepEqual(new Uint8Array(await first.blob.arrayBuffer()), new Uint8Array(await second.blob.arrayBuffer()));
  const files = unzipSync(new Uint8Array(await first.blob.arrayBuffer()));
  assert.ok(files["page.pdf"] && files["page.png"] && files["page.jpg"] && files["frames/1.png"]);
  for (const file of first.manifest.files) {
    assert.equal(files[file.path].length, file.sizeBytes);
    assert.equal(createHash("sha256").update(files[file.path]).digest("hex"), file.checksumSha256);
  }
  const context = JSON.parse(strFromU8(files["map-context.json"]));
  assert.deepEqual(context.frames[0].attribution, ["Original credit", "Curated credit"]);
  assert.deepEqual(context.frames[0].numericLegends, []);
  assert.deepEqual(context.frames[0].dataFrames, []);
  assert.equal(context.frames[0].sourceMetadata[0].license, "CC0-1.0");
  assert.doesNotMatch(strFromU8(files["map-context.json"]), /secret-must-not-be-copied/);
  assert.equal(first.manifest.rights.license, null);assert.equal(first.manifest.pdf.representation, "raster-page");
  assert.deepEqual(first.manifest.dependencies.live, []);
});

test("figure package preserves source-bound numeric intervals and distinct missing-value semantics within metadata bounds", async () => {
  const options = fixture(), capture = options.captures.get("layout:main");
  capture.numericLegends = [
    {start: 0, count: 4, layerId: "screening", title: "Screening index", field: "score",
      intervals: [
        {minimum: null, maximum: -2.5, color: "#440154"},
        {minimum: -2.5, maximum: .125, color: "#21918c"},
        {minimum: .125, maximum: null, color: "#fde725"}
      ], note: "Screening index · score uses numeric conversion; missing values or failed conversions use -1."},
    {start: 4, count: 3, layerId: "population", title: "Population", field: "residents",
      intervals: [
        {minimum: null, maximum: 1000, color: "#1f78b4"},
        {minimum: 1000, maximum: null, color: "#b2df8a"}
      ], noData: {color: "#9ca3af", label: "No data"}}
  ];
  capture.legend = [
    {label: "Screening index · score < -2.5", color: "#440154"},
    {label: "Screening index · score -2.5 – < 0.125", color: "#21918c"},
    {label: "Screening index · score ≥ 0.125", color: "#fde725"},
    {label: capture.numericLegends[0].note},
    {label: "Population · residents < 1000", color: "#1f78b4"},
    {label: "Population · residents ≥ 1000", color: "#b2df8a"},
    {label: "Population · No data", color: "#9ca3af"}
  ];
  capture.sourceMetadata = [
    {layerId: "screening", datasetId: "survey", datasetVersionId: "survey-v2", sourceVersion: null, license: "CC-BY-4.0"},
    {layerId: "population", datasetId: "census", datasetVersionId: null, sourceVersion: "2026", license: null}
  ];
  const before = structuredClone(capture), pack = await compileFigurePrintPack(options);
  const files = unzipSync(new Uint8Array(await pack.blob.arrayBuffer()));
  const frame = JSON.parse(strFromU8(files["map-context.json"])).frames[0];
  assert.deepEqual(frame.numericLegends, capture.numericLegends);
  assert.deepEqual(frame.legend, capture.legend);
  assert.deepEqual(frame.sourceMetadata, capture.sourceMetadata);
  assert.equal(Object.hasOwn(frame.numericLegends[0], "noData"), false);
  assert.equal(frame.sourceMetadata[1].license, null);
  assert.deepEqual(capture, before);
  assert.equal(pack.manifest.rights.license, null);
  capture.numericLegends[0].note = "x".repeat(1024 * 1024);
  await assert.rejects(compileFigurePrintPack(options), /figure metadata exceeds 1 MiB/);
});

test("figure package preserves exact continuous stops and rejects unreviewed capture metadata", async () => {
  const options = fixture(), capture = options.captures.get("layout:main");
  const scale = {field: "score", stops: [{value: -2.5, color: "#000000"}, {value: .125, color: "#ff0000"}, {value: 100, color: "#ffff00"}], noDataColor: "#9ca3af"};
  const legend = continuousLegendRows(scale, "Survey");capture.legend = legend.rows;
  capture.continuousLegends = [{start: 0, count: legend.rows.length, layerId: "survey", title: "Survey",
    field: scale.field, interpolation: "linear", stops: scale.stops, noData: legend.noData, note: legend.note}];
  const before = structuredClone(capture), pack = await compileFigurePrintPack(options);
  const files = unzipSync(new Uint8Array(await pack.blob.arrayBuffer()));
  const context = JSON.parse(strFromU8(files["map-context.json"]));
  assert.deepEqual(context.frames[0].continuousLegends, capture.continuousLegends);
  assert.deepEqual(capture, before);assert.equal(pack.manifest.rights.license, null);
  assert.doesNotMatch(strFromU8(files["map-context.json"]), /secret-must-not-be-copied/);
  capture.continuousLegends[0].privateConfiguration = "must-not-be-copied";
  await assert.rejects(compileFigurePrintPack(options), /Invalid captured continuous legends/);
});

test("figure package preserves captured table and chart values, exact source pins and scope within the existing metadata limit", async () => {
  const {options, sourcePin} = dataFrameFixture(), capture = options.captures.get("layout:main");
  const before = structuredClone(capture), pack = await compileFigurePrintPack(options);
  const files = unzipSync(new Uint8Array(await pack.blob.arrayBuffer()));
  const contextBytes = files["map-context.json"], frame = JSON.parse(strFromU8(contextBytes)).frames[0];
  assert.deepEqual(frame.dataFrames, capture.dataFrames);
  assert.deepEqual(Object.keys(frame.dataFrames[0]).sort(), ["cellKinds", "checksumSha256", "columns", "frameId", "loadedCount", "matchedCount", "notices", "rawValues", "rowLimited", "rows", "scanLimited", "scannedCount", "scopeText", "signature", "sourcePin", "type"]);
  assert.deepEqual(frame.dataFrames[0].sourcePin, sourcePin);
  assert.equal(frame.dataFrames[0].sourcePin.sourceVersion, null);
  assert.equal(frame.dataFrames[0].rows[1][1], "00123");
  assert.equal(frame.dataFrames[1].rows[0][1], -2.5);
  assert.equal(frame.dataFrames[1].rows[1][1], null);
  assert.equal(frame.dataFrames[1].rawValues[1], "00123");
  assert.equal(frame.dataFrames[0].loadedCount, 3);assert.equal(frame.dataFrames[0].matchedCount, 3);
  assert.equal(frame.dataFrames[0].rowLimited, true);assert.equal(frame.dataFrames[0].scanLimited, false);
  assert.match(frame.dataFrames[0].scopeText, /row limit reached/);
  assert.match(frame.dataFrames[1].notices.join(" "), /nonnumeric chart values/);
  assert.deepEqual(frame.sourceMetadata, capture.sourceMetadata);
  for (const snapshot of frame.dataFrames) {
    const {checksumSha256, ...content} = snapshot;
    assert.equal(checksumSha256, createHash("sha256").update(canonicalJson(content)).digest("hex"));
  }
  assert.deepEqual(capture, before);
  assert.doesNotMatch(strFromU8(contextBytes), /secret-must-not-be-copied/);
  assert.deepEqual(pack.manifest.dependencies.live, []);
  assert.equal(pack.manifest.rights.license, null);
  assert.match(strFromU8(files["README.txt"]), /captured table\/chart values/);
  const manifestEntry = pack.manifest.files.find(file => file.path === "map-context.json");
  assert.equal(manifestEntry.checksumSha256, createHash("sha256").update(contextBytes).digest("hex"));
  capture.sourceMetadata.push({note: "x".repeat(1024 * 1024)});
  await assert.rejects(compileFigurePrintPack(options), /figure metadata exceeds 1 MiB/);
});

test("figure package exports only current data frames for each map and rejects missing or changed selections", async () => {
  const {options} = dataFrameFixture(), capture = options.captures.get("layout:main");
  const originalFrames = structuredClone(options.layout.dataFrames), originalCapture = structuredClone(capture);
  const readFrames = async () => {
    const pack = await compileFigurePrintPack(options), files = unzipSync(new Uint8Array(await pack.blob.arrayBuffer()));
    return JSON.parse(strFromU8(files["map-context.json"])).frames;
  };
  options.layout.frames.push({...structuredClone(options.layout.frames[0]), id: "inset"});
  options.captures.set("layout:inset", structuredClone(capture));
  const maps = await readFrames();
  assert.deepEqual(maps.map(frame => frame.dataFrames.map(item => item.frameId)), [["survey-table", "survey-chart"], []]);
  options.layout.dataFrames = [originalFrames[0]];
  assert.deepEqual((await readFrames())[0].dataFrames, [originalCapture.dataFrames[0]]);
  delete options.layout.dataFrames;
  assert.deepEqual((await readFrames()).map(frame => frame.dataFrames), [[], []]);
  assert.deepEqual(capture, originalCapture, "removing a layout frame does not mutate retained captures");
  options.layout.dataFrames = [{...originalFrames[0], columns: ["score"]}];
  await assert.rejects(compileFigurePrintPack(options), /snapshot is stale or invalid/);
  options.layout.dataFrames = [{...originalFrames[0], source: {...originalFrames[0].source, datasetVersionId: "survey-v3"}}];
  await assert.rejects(compileFigurePrintPack(options), /saved Layer source changed/);
  options.layout.dataFrames = originalFrames;
  capture.dataFrames = [originalCapture.dataFrames[0]];
  await assert.rejects(compileFigurePrintPack(options), /snapshot is stale or invalid/);
});

test("figure package refuses stale, changed or missing captures and invalid PDF dimensions", async () => {
  const options = fixture();
  await assert.rejects(compileFigurePrintPack({...options, captures: new Map()}), /Capture every/);
  options.captures.get("layout:main").imageSha256 = "0".repeat(64);
  await assert.rejects(compileFigurePrintPack(options), /image changed/);
  const stale = fixture();stale.layout.frames[0] = {...stale.layout.frames[0], view: {center: [1,2], zoom: 8}};
  await assert.rejects(compileFigurePrintPack(stale), /Capture every/);
  assert.throws(() => rasterPagePdf(Uint8Array.of(255,216,255,217), {width: 10000, height: 10000, widthMm: 297, heightMm: 210}), /invalid/);
  assert.throws(() => rasterPagePdf(Uint8Array.of(1), {width: 100, height: 100, widthMm: 297, heightMm: 210}), /invalid/);
});

test("targeted map captures reject changed output sizing while moves preserve captured detail and rights", async () => {
  const options = fixture(), frame = options.layout.frames[0], capture = options.captures.get("layout:main");
  Object.assign(frame, {widthMm: 215, heightMm: 153, xMm: 10, yMm: 27});
  assert.deepEqual(printCaptureTarget(frame, 300), {maxWidth: 2539, maxHeight: 1807});
  capture.outputSignature = printCaptureOutputSignature(frame, options.layout.dpi);
  const originalCapture = structuredClone(capture);
  Object.assign(frame, {xMm: 12, yMm: 30});options.layout.caption = "Moved map";options.layout.legend = false;
  const pack = await compileFigurePrintPack(options), files = unzipSync(new Uint8Array(await pack.blob.arrayBuffer()));
  const context = JSON.parse(strFromU8(files["map-context.json"])).frames[0];
  assert.equal(context.width, capture.width);assert.equal(context.height, capture.height);
  assert.deepEqual(context.view, capture.view);assert.deepEqual(context.presentation, capture.presentation);
  assert.deepEqual(context.sourceMetadata, capture.sourceMetadata);assert.deepEqual(capture, originalCapture);
  for (const [target, property, value] of [[options.layout, "dpi", 150], [frame, "widthMm", 216], [frame, "heightMm", 154]]) {
    const previous = target[property];target[property] = value;
    await assert.rejects(compileFigurePrintPack(options), /Capture every map frame with its current settings/);
    target[property] = previous;
  }
  delete capture.outputSignature;options.layout.dpi = 150;
  await compileFigurePrintPack(options); // Legacy viewport pixels do not claim the new target resolution.
  assert.throws(() => printCaptureTarget({...frame, widthMm: 0}, 96), /positive map-frame dimensions/);
  assert.throws(() => printCaptureTarget({...frame, heightMm: Infinity}, 96), /positive map-frame dimensions/);
  assert.throws(() => printCaptureTarget(frame, 600), /supported output DPI/);
  assert.throws(() => printCaptureTarget({widthMm: 1189, heightMm: 841}, 300), /20 megapixel/);
});

test("publishing handoff reopens in the existing source importer as a private unreviewed map draft", async () => {
  const compiled = await compilePortableMapArtifact({title: "Local survey", runtimeJs: "window.viewer=true;", runtimeCss: "body{}", runtimeLicense: "BSD",
    candidates: [{id: "sites", title: "Survey", visible: true, sourceId: "sites", source: {type: "geojson", data: {type: "FeatureCollection", features: []}},
      paints: [{id: "sites", source: "sites", type: "circle"}]}], selectedIds: ["sites"]});
  const handoff = await compilePublicationMapHandoff(compiled), imported = await readPublicationSourceArchive(handoff.blob);
  assert.equal(imported.manifest.metadata.entryPath, "index.html");assert.equal(imported.manifest.metadata.rightsStatus, "unreviewed");
  assert.equal(imported.manifest.metadata.publicationFormat, "map");assert.equal(imported.manifest.baseRevision, null);
  const html = imported.files.find(file => file.relativePath === "index.html"), sidecar = imported.files.find(file => file.relativePath === "index.html.artifact.json");
  assert.equal(await html.blob.text(), compiled.html);
  await verifyPortableMapArtifact(html.blob, JSON.parse(await sidecar.blob.text()));
  assert.equal(JSON.parse(await imported.files.find(file => file.relativePath === "opengeo.publication.json").blob.text()).format, "map");
  await assert.rejects(compilePublicationMapHandoff({...compiled, html: compiled.html + "!"}), /identity|checksum/);
});
