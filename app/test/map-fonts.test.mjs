import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import Pbf from "pbf";
import {PINNED_MAP_FONT, PINNED_MAP_FONT_STACK, createMapFontSession, isRegisteredMapFont,
  mapFontSha256, registerMapFontProtocol, validateMapFontRef} from "../src/lib/mapFonts.js";

const root = new URL("../src/assets/render-fonts/opengeo-open-sans-v1/1/", import.meta.url);
const attachments = {
  manifest: () => readFile(new URL("manifest.json", root)),
  range: range => readFile(new URL(`${range}.pbf`, root))
};
const layer = {labels: {enabled: true, field: "name", prefix: "[", suffix: "]", fontRef: {...PINNED_MAP_FONT}}};
const data = name => ({type: "FeatureCollection", features: [{type: "Feature", properties: {name}}]});
const blankMap = () => ({glyphs: null, writes: [], getGlyphs() { return this.glyphs; },
  setGlyphs(value) { this.writes.push(value); this.glyphs = value; }});

test("the registered full font manifest seals every glyph, license and exact source identity", async () => {
  const bytes = await attachments.manifest();
  assert.equal(await mapFontSha256(bytes), PINNED_MAP_FONT.manifestChecksumSha256);
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.id, PINNED_MAP_FONT.id);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.fontStack, PINNED_MAP_FONT_STACK);
  assert.equal(manifest.codepoints.length, 883);
  assert.equal(manifest.ranges.length, 15);
  assert.equal(await mapFontSha256(await readFile(new URL("LICENSE.txt", root))), manifest.licenseSha256);
  const actual = [];
  for (const entry of manifest.ranges) {
    const bytes = await attachments.range(entry.range);
    assert.equal(bytes.length, entry.sizeBytes);
    assert.equal(await mapFontSha256(bytes), entry.checksumSha256);
    const stack = new Pbf(bytes).readFields((tag, result, reader) => {
      if (tag === 1) reader.readMessage((tag, result, reader) => {
        if (tag === 1) result.fontStack = reader.readString();
        if (tag === 2) result.range = reader.readString();
        if (tag === 3) reader.readMessage((tag, result, reader) => {
          if (tag === 1) result.ids.push(reader.readVarint());
        }, result);
      }, result);
    }, {ids: []});
    assert.equal(stack.fontStack, PINNED_MAP_FONT_STACK);
    assert.equal(stack.range, entry.range);
    actual.push(...stack.ids);
  }
  assert.deepEqual(actual, manifest.codepoints);
  assert.equal(new Set(actual).size, actual.length);
  for (const id of [0x4e00, 0x627, 0x1f600]) assert.ok(!actual.includes(id));
});

test("font refs preserve structurally valid unknown identities but reject aliases or malformed refs", () => {
  const unknown = {id: "imported-font-v4", version: 4, manifestChecksumSha256: "a".repeat(64)};
  assert.equal(validateMapFontRef(unknown), unknown);
  assert.equal(isRegisteredMapFont(unknown), false);
  for (const value of [null, {...PINNED_MAP_FONT, path: "../font"}, {...PINNED_MAP_FONT, version: 0},
    {...PINNED_MAP_FONT, version: 2_147_483_648}, {...PINNED_MAP_FONT, id: "Imported.Font"}, {...PINNED_MAP_FONT, id: "a".repeat(65)},
    {...PINNED_MAP_FONT, manifestChecksumSha256: "A".repeat(64)}, {...PINNED_MAP_FONT, id: "../font"}]) {
    assert.throws(() => validateMapFontRef(value), /map_font_ref_invalid/);
  }
});

test("font inspection creates no reads; prepared coverage preserves Unicode, case and newline without fallback", async () => {
  let reads = 0;
  const fonts = createMapFontSession({manifest: () => { reads++; return attachments.manifest(); },
    range: range => { reads++; return attachments.range(range); }});
  assert.equal(fonts.phase, "unloaded");
  assert.equal(fonts.canRender(layer, data("Café Ω\nМосква")), false);
  assert.equal(reads, 0);
  await fonts.prepare();
  assert.equal(reads, 16);
  assert.equal(fonts.coverageError(layer, data("MiXeD Café Ω\nМосква")), null);
  assert.match(fonts.coverageError(layer, data("東京")), /coverage_missing:U\+6771/);
  assert.match(fonts.coverageError(layer, data("😀")), /coverage_missing:U\+1F600/);
  for (const value of ["A\rB", "A\tB"]) assert.match(fonts.coverageError(layer, data(value)), /coverage_missing/);
  assert.match(fonts.coverageError({...layer, labels: {...layer.labels, suffix: "界"}}, data("A")), /coverage_missing/);
  await fonts.prepare();
  assert.equal(reads, 16, "Repeated readiness reuses fully verified bytes");
});

test("pinned glyph routing preserves provider URLs and auth; mixed legacy blank styles remain unchanged", async () => {
  const fonts = createMapFontSession(attachments);
  await fonts.prepare();
  const map = blankMap();
  const legacy = {labels: {enabled: true, field: "name"}};
  map.glyphs = undefined;
  fonts.configure(map, [legacy]);
  fonts.configure(map, []);
  assert.deepEqual(map.writes, [], "Untouched maps never receive setGlyphs, even when absence is undefined");
  map.glyphs = null;
  fonts.configure(map, [layer, legacy]);
  assert.deepEqual(map.writes, []);
  assert.equal(fonts.canRender(layer, data("A")), false);
  fonts.configure(map, [layer]);
  assert.match(map.glyphs, /^opengeo-font:\/\//);
  assert.equal(fonts.canRender(layer, data("A")), true);
  fonts.configure(map, [layer, {...legacy, visible: false}]);
  assert.equal(fonts.canRender(layer, data("A")), true, "Hidden legacy labels do not change visible pinned occurrences");
  assert.equal(fonts.usesPinnedGlyphRoot, true);
  fonts.configure(map, [layer, legacy]);
  assert.equal(map.glyphs, null, "Revealing legacy labels restores their original unspecified glyph root");
  assert.equal(fonts.usesPinnedGlyphRoot, false);
  assert.equal(fonts.canRender(layer, data("A")), false);
  const delegated = [];
  const delegate = (url, type) => { delegated.push({url, type}); return {url, headers: {Authorization: "provider-only"}}; };
  map.glyphs = "https://provider.example/{fontstack}/{range}.pbf?key=provider-only";
  map.writes = [];
  fonts.configure(map, [layer, legacy]);
  const providerUrl = "https://provider.example/Provider Sans/0-255.pbf?key=provider-only";
  assert.deepEqual(fonts.transformRequest(providerUrl, "Glyphs", delegate), {url: providerUrl, headers: {Authorization: "provider-only"}});
  const pinnedUrl = map.glyphs.replace("{fontstack}", PINNED_MAP_FONT_STACK).replace("{range}", "0-255");
  assert.deepEqual(fonts.transformRequest(pinnedUrl, "Glyphs", delegate), {
    url: `opengeo-font://${PINNED_MAP_FONT.manifestChecksumSha256}/0-255.pbf`, credentials: "omit"
  });
  assert.equal(delegated.length, 1);
  assert.deepEqual(map.writes, [], "No provider glyph template is changed");
});

test("corrupt or missing pinned bytes fail before the font becomes renderable", async () => {
  for (const source of [
    {...attachments, manifest: async () => new Uint8Array([0])},
    {...attachments, range: async () => new Uint8Array([0])},
    {...attachments, range: async () => { throw new Error("missing"); }}
  ]) {
    const fonts = createMapFontSession(source);
    await assert.rejects(fonts.prepare());
    assert.equal(fonts.phase, "failed");
    fonts.configure(blankMap(), [layer]);
    assert.equal(fonts.canRender(layer, data("A")), false);
  }
});

test("the bounded glyph protocol serves detached-safe verified buffers and registers only once", async () => {
  const fonts = createMapFontSession(attachments);
  await fonts.prepare();
  let handler, registrations = 0;
  const engine = {addProtocol(name, callback) { assert.equal(name, "opengeo-font"); registrations++; handler = callback; }};
  registerMapFontProtocol(engine);
  registerMapFontProtocol(engine);
  assert.equal(registrations, 1);
  const url = `opengeo-font://${PINNED_MAP_FONT.manifestChecksumSha256}/0-255.pbf`;
  const first = await handler({url}), second = await handler({url});
  assert.notEqual(first.data, second.data);
  assert.deepEqual(new Uint8Array(first.data), new Uint8Array(second.data));
  await assert.rejects(handler({url: `${url}?secret=bad`}), /map_font_glyph_unavailable/);
});


test("Mapbox uses only verified same-origin asset URLs without leaking provider credentials", async () => {
  const previous = globalThis.location;
  globalThis.location = new URL("https://studio.test/workspaces");
  try {
    const fonts = createMapFontSession({...attachments, rangeUrl: range => `/assets/font/${range}.pbf`});
    assert.equal(fonts.supportsRenderer("mapbox"), false);
    await fonts.prepare();
    assert.equal(fonts.supportsRenderer("mapbox"), true);
    const map = blankMap(); fonts.configure(map, [layer], "mapbox");
    assert.equal(fonts.ownsGlyphTemplate(map.glyphs), true);
    assert.equal(fonts.ownsGlyphTemplate(map.glyphs.replace("opengeo-font:", "other:")), false);
    const delegate = url => ({url, headers:{Authorization:"provider-secret"}});
    const url = map.glyphs.replace("{fontstack}", encodeURIComponent(PINNED_MAP_FONT_STACK)).replace("{range}", "0-255");
    assert.deepEqual(fonts.transformRequest(url, "Glyphs", delegate, "mapbox"), {
      url:"https://studio.test/assets/font/0-255.pbf", credentials:"omit"
    });
    assert.equal(fonts.canRender(layer, data("Café Ω Москва")), true);
    const provider = "https://provider.test/Provider%20Sans/0-255.pbf";
    assert.deepEqual(fonts.transformRequest(provider, "Glyphs", delegate, "mapbox"), delegate(provider));
    for (const rangeUrl of [undefined, () => "https://other.test/font.pbf", () => "https://user:secret@studio.test/font.pbf",
      () => "/font.pbf?access_token=secret", () => "data:application/octet-stream;base64,AA==", () => "/font.pbf#fragment"]) {
      const missing = createMapFontSession({...attachments, rangeUrl});
      await missing.prepare();
      assert.equal(missing.supportsRenderer("mapbox"), false);
      assert.equal(missing.supportsRenderer("maplibre"), true);
      missing.configure(blankMap(), [layer], "mapbox");
      assert.equal(missing.canRender(layer, data("A")), false);
    }
  } finally {
    if (previous === undefined) delete globalThis.location; else globalThis.location = previous;
  }
});
