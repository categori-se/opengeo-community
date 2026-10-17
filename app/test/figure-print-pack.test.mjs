import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import {unzipSync, strFromU8} from "fflate";
import {compileFigurePrintPack, rasterPagePdf} from "../src/lib/figurePrintPack.js";
import {canonicalJson} from "../src/lib/artifactCanonicalJson.js";
import {compilePublicationMapHandoff} from "../src/lib/publicationMapHandoff.js";
import {compilePortableMapArtifact, verifyPortableMapArtifact} from "../src/lib/portableMapArtifact.js";
import {readPublicationSourceArchive} from "../src/lib/publicationSourceArchive.js";

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
  assert.equal(context.frames[0].sourceMetadata[0].license, "CC0-1.0");
  assert.doesNotMatch(strFromU8(files["map-context.json"]), /secret-must-not-be-copied/);
  assert.equal(first.manifest.rights.license, null);assert.equal(first.manifest.pdf.representation, "raster-page");
  assert.deepEqual(first.manifest.dependencies.live, []);
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
