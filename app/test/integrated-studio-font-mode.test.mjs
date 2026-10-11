import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {test} from "node:test";
import {build} from "esbuild";
import {resolve, join} from "node:path";
import {FONT_ROUTE, FONT_LABELS, FONT_LABEL_SIZE, FONT_COMPOSITION_PROBES, integratedStudioFontMode,
  loadIntegratedStudioFontAssets, integratedStudioFontTransport} from "../scripts/integrated-studio-font-mode.mjs";

test("integrated font mode requires one explicit flag and leaves the default off", () => {
  assert.equal(integratedStudioFontMode([]), false);
  assert.equal(integratedStudioFontMode(["--pinned-map-fonts"]), true);
  for (const args of [["true"], ["--pinned-map-fonts", "--pinned-map-fonts"], ["--other"]]) {
    assert.throws(() => integratedStudioFontMode(args));
  }
});

test("integrated font transport serves only the exact reviewed local glyph bytes", () => {
  const source = loadIntegratedStudioFontAssets(fileURLToPath(new URL("../../", import.meta.url)));
  assert.equal(source.files.size, 16);
  assert.equal(source.evidence.length, 18);
  assert.equal(source.maplibre.version, "5.24.0");
  for (const path of [`${FONT_ROUTE}../../LICENSE.txt`, `${FONT_ROUTE}0-255.pbf?token=x`, `${FONT_ROUTE}LICENSE.txt`, `${FONT_ROUTE}900000-900255.pbf`]) {
    assert.equal(source.files.has(path), false);
  }
  for (const [path, asset] of source.files) {
    const file = source.evidence.find(entry => entry.path.endsWith(`/${path.slice(FONT_ROUTE.length)}`));
    assert.equal(createHash("sha256").update(asset.bytes).digest("hex"), file.sha256);
  }
});

test("integrated font attachment construction is lazy, bounded and authority-free", async () => {
  const calls = [];
  const factory = new Function("fetch", `${integratedStudioFontTransport(["0-255"])}; return mapFontAttachments;`);
  const attachments = factory(async (...args) => { calls.push(args); return {ok:true,arrayBuffer:async()=>new ArrayBuffer(1)}; });
  assert.equal(calls.length, 0);
  await attachments.manifest();
  await attachments.range("0-255");
  assert.deepEqual(calls, [[`${FONT_ROUTE}manifest.json`, {credentials:"omit"}], [`${FONT_ROUTE}0-255.pbf`, {credentials:"omit"}]]);
  assert.throws(() => attachments.range("../secret"), /Unregistered/);
  assert.equal(calls.length, 2);
});

test("label fixtures preserve case, Unicode and multiline while blend probes retain genuine source interiors", () => {
  assert.equal(FONT_LABELS[0], "MiXeD Café Ω");
  assert.equal(FONT_LABELS[1], "Москва\nΔέλτα");
  assert.equal(FONT_LABEL_SIZE, 24);
  assert.ok(6 <= FONT_LABEL_SIZE / 4, "The fixture's halo fits the selected text size");
  const watershed = ([x,y]) => ((x > -72.5 && x < -72.4) || (x > -72.2 && x < -72.1)) && y > 42 && y < 42.1;
  const conservation = ([x,y]) => x > -72.48 && x < -72.13 && y > 42.04 && y < 42.08;
  assert.deepEqual(FONT_COMPOSITION_PROBES.map(p=>[watershed(p),conservation(p)]), [[true,false],[false,true],[true,true]]);
});

test("the opt-in transport bundles with the actual Studio component and recorded MapLibre engine", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const assets = loadIntegratedStudioFontAssets(root);
  const result = await build({absWorkingDir:root,
    stdin:{contents:`import {ProjectWorkspacePage} from './src/components/ProjectWorkspacePage.js';
      ${integratedStudioFontTransport(assets.ranges)}
      export const mount = options => ProjectWorkspacePage({...options,mapFontAttachments});`,
      resolveDir:join(root,"app"),sourcefile:"integrated-font-test.js"},
    bundle:true,write:false,metafile:true,format:"esm",platform:"browser",logLevel:"silent"});
  assert.ok(Object.keys(result.metafile.inputs).some(path => resolve(root,path) === join(root,assets.maplibre.sourcePath)));
  assert.match(result.outputFiles[0].text, /Use Open Sans v1 for this map/);
  assert.match(result.outputFiles[0].text, /\/__local-map-fonts\/manifest\.json/);
});
