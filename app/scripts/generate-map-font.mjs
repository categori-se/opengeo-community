// Generates the complete explicitly covered glyph asset, never downloads fonts.
// Run in an isolated network namespace; Chromium only receives verified inputs.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(`${appRoot}/package.json`);
const {chromium} = require("playwright");
const {build} = require("esbuild");
const {default: Pbf} = await import(pathToFileURL(require.resolve("pbf")));
const output = resolve(appRoot, "src/assets/render-fonts/opengeo-open-sans-v1/1");
const fontPath = "/usr/share/fonts/open-sans/OpenSans-Regular.ttf";
const licensePath = "/usr/share/doc/open-sans-fonts/LICENSE.txt";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const font = await readFile(fontPath), license = await readFile(licensePath);
const fontSha256 = "8ab4aa561e7db0eb3e1af8b0bed2a315e0a33fe2ed3070e645d1b89f8efc1d5c";
const licenseSha256 = "3ddf9be5c28fe27dad143a5dc76eea25222ad1dd68934a047064e56ed2fa40c5";
assert.equal(sha(font), fontSha256);
assert.equal(sha(license), licenseSha256);
// Captured with fc-query --format '%{charset}' for this exact RPM font file.
// The source checksum and coverage checksum prevent accidental substitution.
const charset = "20-7e a0-17f 192 1a0-1a1 1af-1b0 1f0 1fa-1ff 218-21b 237 2bc 2c6-2c7 2c9 2d8-2dd 2f3 300-301 303 309 30f 323 384-38a 38c 38e-3a1 3a3-3ce 3d1-3d2 3d6 400-486 488-513 1e00-1e01 1e3e-1e3f 1e80-1e85 1ea0-1ef9 1f4d 2000-200b 2013-2015 2017-201e 2020-2022 2026 2030 2032-2033 2039-203a 203c 2044 2070 2074-2079 207f 20a3-20a4 20a7 20ab-20ac 2105 2113 2116 2120 2122 2126 212e 215b-215e 2202 2206 220f 2211-2212 221a 221e 222b 2248 2260 2264-2265 25ca fb00-fb04 feff fffc-fffd";
const coverageSha256 = "d52c6f4ae88ef800f2f5ba57cdf22e1fb8dd6684333b472fe5a4b233c861cf33";
assert.equal(sha(charset), coverageSha256);
const codepoints = charset.split(" ").flatMap(range => {
  const [start, end = start] = range.split("-").map(value => parseInt(value, 16));
  return Array.from({length: end - start + 1}, (_, index) => start + index);
});
assert.equal(new Set(codepoints).size, codepoints.length);
const fontStack = "OpenGeo Open Sans v1";
const origin = "https://opengeo-font-generation.invalid";
const bundle = await build({stdin: {contents: "import TinySDF from '@mapbox/tiny-sdf'; window.TinySDF = TinySDF;",
  resolveDir: appRoot}, bundle: true, write: false, format: "iife", platform: "browser", logLevel: "silent"});
const javascript = bundle.outputFiles[0].contents;
let browser;
try {
  browser = await chromium.launch({headless: true, executablePath: "/usr/bin/chromium-browser",
    args: ["--no-sandbox", "--disable-background-networking", "--disable-dev-shm-usage"]});
  const context = await browser.newContext({serviceWorkers: "block"});
  const denied = [];
  await context.route("**/*", async route => {
    const url = route.request().url();
    if (url === `${origin}/`) return route.fulfill({contentType: "text/html", body:
      '<!doctype html><meta charset="utf-8"><script src="/sdf.js"></script>'});
    if (url === `${origin}/sdf.js`) return route.fulfill({contentType: "text/javascript", body: Buffer.from(javascript)});
    if (url === `${origin}/font.ttf`) return route.fulfill({contentType: "font/ttf", body: font});
    denied.push(url);
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  await page.goto(origin);
  const glyphs = await page.evaluate(async ({fontStack, codepoints}) => {
    const face = new FontFace(fontStack, "url('/font.ttf')", {weight: "400", style: "normal"});
    document.fonts.add(await face.load());
    await document.fonts.ready;
    if (face.status !== "loaded") throw new Error("font_unavailable");
    const sdf = new TinySDF({fontSize: 24, buffer: 3, radius: 8, cutoff: 0.25,
      fontFamily: fontStack, fontWeight: "400", fontStyle: "normal"});
    return codepoints.map(id => { const glyph = sdf.draw(String.fromCodePoint(id)); return {...glyph, id, data: [...glyph.data]}; });
  }, {fontStack, codepoints});
  assert.deepEqual(denied, []);
  const ranges = [];
  await mkdir(output, {recursive: true});
  for (const start of [...new Set(codepoints.map(id => Math.floor(id / 256) * 256))]) {
    const range = `${start}-${start + 255}`;
    const selected = glyphs.filter(({id}) => start <= id && id < start + 256);
    const writer = new Pbf();
    writer.writeMessage(1, (_, stack) => {
      stack.writeStringField(1, fontStack);
      stack.writeStringField(2, range);
      for (const glyph of selected) {
        assert.equal(glyph.data.length, (glyph.glyphWidth + 6) * (glyph.glyphHeight + 6));
        stack.writeMessage(3, (glyph, item) => {
          item.writeVarintField(1, glyph.id);
          item.writeBytesField(2, Uint8Array.from(glyph.data));
          item.writeVarintField(3, glyph.glyphWidth);
          item.writeVarintField(4, glyph.glyphHeight);
          item.writeSVarintField(5, glyph.glyphLeft);
          item.writeSVarintField(6, glyph.glyphTop);
          item.writeVarintField(7, Math.round(glyph.glyphAdvance));
        }, glyph);
      }
    });
    const bytes = Buffer.from(writer.finish());
    await writeFile(`${output}/${range}.pbf`, bytes);
    ranges.push({range, checksumSha256: sha(bytes), sizeBytes: bytes.length});
  }
  const manifest = {schema: "opengeo.glyph-manifest.1.0.0", id: "opengeo-open-sans-v1", version: 1,
    fontStack, fontSha256, licenseSha256, license: "Apache-2.0",
    provenance: {upstream: "Open Sans by Steve Matteson / Ascender, distributed by Google Fonts",
      upstreamUrl: "http://www.google.com/fonts/specimen/Open+Sans",
      package: "open-sans-fonts-1.10-24.fc43.noarch", sourcePackage: "open-sans-fonts-1.10-24.fc43.src.rpm",
      fontFilename: "OpenSans-Regular.ttf", upstreamCommit: null,
      note: "Source bytes and license match installed Fedora RPM checksums. No upstream download or newer font substitution."},
    generator: {name: "TinySDF", version: JSON.parse(await readFile(`${appRoot}/node_modules/@mapbox/tiny-sdf/package.json`)).version,
      fontSize: 24, buffer: 3, radius: 8, cutoff: 0.25, chromium: await browser.version(), maplibre: "5.24.0",
      sourceChecksumSha256: sha(await readFile(fileURLToPath(import.meta.url)))},
    coverage: "Complete charset reported by fc-query for the exact source font: Latin, Greek, Cyrillic, punctuation and symbols. No Arabic, CJK or emoji coverage claim.",
    coverageSha256, legacyFontFidelity: false, codepoints, ranges};
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(`${output}/manifest.json`, bytes);
  await writeFile(`${output}/LICENSE.txt`, license);
  console.log(JSON.stringify({path: output, id: manifest.id, version: 1, fontStack,
    manifestChecksumSha256: sha(bytes), codepoints: codepoints.length, ranges: ranges.length,
    glyphBytes: ranges.reduce((total, range) => total + range.sizeBytes, 0)}, null, 2));
} finally {
  if (browser) await browser.close();
}
