import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {test} from "node:test";
import {POINT_SYMBOLS, POINT_SYMBOL_COLLECTIONS, REFERENCE_SYMBOLS, normalizePointSymbolStyle,
  pointSymbolImages, pointSymbolImageId, pointSymbolPreviewSvg, referenceSymbolPreviewSvg,
  ensurePointSymbolAssets, ensureReferenceSymbolAssets} from "../src/lib/pointSymbols.js";

const digest = value => createHash("sha256").update(value).digest("hex");
const sourceSymbol = path => POINT_SYMBOLS.find(symbol => symbol.source.path === path);

test("the complete pinned Maki and OSM point inventories have stable closed identities and local source metadata", () => {
  assert.equal(POINT_SYMBOLS.length, 1142);
  assert.equal(new Set(POINT_SYMBOLS.map(symbol => symbol.id)).size, 1142);
  assert.deepEqual(POINT_SYMBOL_COLLECTIONS.map(collection => [collection.id,
    POINT_SYMBOLS.filter(symbol => symbol.collection === collection.id).length]),
  [["builtin", 6], ["maki-8.2.0", 215], ["osm-carto-1cc4b89c", 921]]);
  assert.equal(POINT_SYMBOLS.filter(symbol => symbol.source.path?.startsWith("symbols/shields/")).length, 660);
  const maki = POINT_SYMBOLS.filter(symbol => symbol.collection === "maki-8.2.0");
  assert.ok(new Set(maki.map(symbol => symbol.category)).size >= 8);
  for (const symbol of POINT_SYMBOLS.slice(6)) {
    assert.ok(symbol.label && symbol.category && symbol.tags.length);
    assert.equal(symbol.source.license, "CC0-1.0");
    assert.match(symbol.source.archiveSha256, /^[a-f0-9]{64}$/);
    assert.ok(symbol.source.url.includes(symbol.source.commit));
    assert.ok(Object.isFrozen(symbol) && Object.isFrozen(symbol.source) && Object.isFrozen(symbol.tags));
    assert.equal(normalizePointSymbolStyle({pointSymbol: symbol.id}).pointSymbol, symbol.id);
  }
  assert.equal(sourceSymbol("icons/hospital.svg").id, "maki-8-2-0-hospital");
  assert.equal(sourceSymbol("symbols/amenity/hospital.svg").id, "osm-carto-1cc4b89c-amenity--hospital");
  for (const value of ["maki-hospital", "maki-8-2-1-hospital", "osm-carto-latest-hospital", "constructor", "https://example.test/icon.svg"]) {
    assert.throws(() => normalizePointSymbolStyle({pointSymbol: value}), /Unknown point symbol/);
  }
});

test("all known point glyphs decode synchronously after deliberate loading and only selected categories are returned", async () => {
  await ensurePointSymbolAssets();
  assert.equal(pointSymbolImages()[0].pixels.data.every(value => value === 0), true);
  const imported = sourceSymbol("icons/hospital.svg").id;
  assert.throws(() => pointSymbolImages({pointSymbol: imported}), /assets have not been loaded/);
  await ensurePointSymbolAssets({pointSymbol: "circle", renderer: "category", categorySymbols: {Hospital: imported}});
  for (const {id} of POINT_SYMBOLS) {
    const images = pointSymbolImages({pointSymbol: id});
    assert.equal(images.length, 1);
    const [{pixels, pixelRatio}] = images;
    assert.deepEqual([pixels.width, pixels.height, pixels.data.length, pixelRatio], [64, 64, 16384, 2]);
    assert.equal(pixels.data.some((value, index) => index % 4 === 3 && value), id !== "circle", id);
  }
  const a = sourceSymbol("icons/hospital.svg").id, b = sourceSymbol("symbols/amenity/hospital.svg").id;
  const style = {pointSymbol: a, renderer: "category", categorySymbols: {A: a, B: b}};
  assert.deepEqual(pointSymbolImages(style).map(image => image.id), [a, b].map(pointSymbolImageId));
  assert.deepEqual(pointSymbolImages({...style, renderer: "single"}).map(image => image.id), [pointSymbolImageId(a)]);
  const first = pointSymbolImages(style)[0].pixels, second = pointSymbolImages(style)[0].pixels;
  first.data.fill(0);assert.ok(second.data.some(value => value));
});

test("the six original images and previews remain byte-for-byte compatible", () => {
  const expected = {
    circle: ["4fe7b59af6de3b665b67788cc2f99892ab827efae3a467342b3bb4e3bc8e5bfe", "c4c06ff41139d9cf5301098c8ac11de31d92e2942d874f12b11ecea0b6dc04db"],
    hospital: ["2e86448d4d484040263cf2f9d7654af612f615726feac5f08b6720baaed83545", "30865ca8d34c5d7fba6e701ba0942aa972b82e7c9b453e11a0f345fce924ce2b"],
    clinic: ["98b544383f2f095e42cfa7cd684ea0c4696795d2183c60e3fb60d6851ec09997", "261012f2e7c3fe984d21abbfd894f5980a364801c8db1d64089b7b0c7006c61e"],
    school: ["9bd2746204d866dc986e9c6d770a3a43f2624336189da07157a73af50e9daec3", "bf007a334122fbe6061712df5cf6d447e73ba39b08137db7d5b11aa896d795f9"],
    star: ["7ee5f2ca3f39fdddf4d3dd9d0755e2133cd63ff7efa5bc09312ce5f5e95c06e4", "da69348dd95a8f180055d3ad7954a9001a4be4bd111905e106b6176080384863"],
    flag: ["a5645438d187537d3ed7b94554717ae33c4e2205d78cc8eae83ce4adccc6df9f", "860b5384d9037f495f9c659793d1ff33e0d8230fce04973ab831b088df82bb2e"]
  };
  for (const [id, [image, preview]] of Object.entries(expected)) {
    assert.equal(digest(pointSymbolImages({pointSymbol: id})[0].pixels.data), image, id);
    assert.equal(digest(pointSymbolPreviewSvg({pointSymbol: id})), preview, id);
  }
});

test("OSM original shield colours and alpha are retained, and preview rects reproduce exact pixels", () => {
  const shield = sourceSymbol("symbols/shields/motorway_1x1.svg");
  const pixels = pointSymbolImages({pointSymbol: shield.id})[0].pixels;
  const colors = new Set(Array.from({length: 4096}, (_, index) => Buffer.from(pixels.data.slice(index * 4, index * 4 + 4)).toString("hex")));
  assert.ok(colors.has("eccdd1ff") && colors.has("d39da5ff"));
  assert.ok(pixels.data.some((value, index) => index % 4 === 3 && value > 0 && value < 255));
  for (const symbol of [sourceSymbol("icons/hospital.svg"), sourceSymbol("symbols/amenity/hospital.svg"), shield]) {
    const svg = pointSymbolPreviewSvg({pointSymbol: symbol.id}), actual = new Uint8Array(16384);
    for (const match of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="1" fill="#([a-f0-9]{6})"(?: fill-opacity="([\d.]+)")?\/>/g)) {
      const [, x, y, width, color, alpha] = match;
      const rgba = [...Buffer.from(color, "hex"), alpha ? Math.round(Number(alpha) * 255) : 255];
      for (let offset = 0; offset < Number(width); offset++) actual.set(rgba, (Number(y) * 64 + Number(x) + offset) * 4);
    }
    assert.deepEqual(actual, pointSymbolImages({pointSymbol: symbol.id})[0].pixels.data);
    assert.doesNotMatch(svg, /<script|<image|(?:href|src)=|onload/);
  }
});

test("all 77 pattern and line references load separately and stay outside the Point style profile", async () => {
  assert.equal(REFERENCE_SYMBOLS.length, 77);
  assert.equal(new Set(REFERENCE_SYMBOLS.map(symbol => symbol.id)).size, 77);
  assert.equal(REFERENCE_SYMBOLS.filter(symbol => symbol.format === "png").length, 22);
  assert.throws(() => referenceSymbolPreviewSvg(REFERENCE_SYMBOLS[0].id), /assets have not been loaded/);
  await ensureReferenceSymbolAssets();
  for (const symbol of REFERENCE_SYMBOLS) {
    assert.throws(() => normalizePointSymbolStyle({pointSymbol: symbol.id}), /Unknown point symbol/);
    const svg = referenceSymbolPreviewSvg(symbol.id);
    assert.match(svg, /<rect/);
    assert.doesNotMatch(svg, /<circle|<script|<image|(?:href|src)=|onload/);
  }
  assert.throws(() => referenceSymbolPreviewSvg("circle"), /Unknown reference symbol/);
});
