// Fixed runtime entry point. All sources/glyphs are already sealed by the worker;
// this process has its own empty network namespace and receives no AWS secrets.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync, writeFileSync} from "node:fs";
import {createRequire} from "node:module";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const [requestPath, outputPath] = process.argv.slice(2);
const bytes = readFileSync(requestPath);
assert.ok(bytes.length <= 40_000_000, "saved_map_gl_input_limit");
const request = JSON.parse(bytes);
assert.equal(request.schema, "opengeo.maplibre-render-request.1.0.0");
const network = readFileSync("/proc/net/dev", "utf8");
assert.ok(network.split("\n").filter((line) => line.includes(":")).every((line) => /^\s*lo:/.test(line)), "saved_map_gl_network_not_isolated");
const runtime = request.runtime;
const packageBytes = readFileSync(runtime.playwrightPackage);
assert.equal(sha(packageBytes), runtime.playwrightPackageChecksumSha256);
assert.equal(JSON.parse(packageBytes).version, runtime.playwrightVersion);
const require = createRequire(runtime.playwrightPackage);
const {chromium} = require("playwright");
const bundle = readFileSync(runtime.bundle);
assert.equal(sha(bundle), runtime.bundleChecksumSha256);
const origin = "https://opengeo-render.invalid";
const assets = new Map();
for (const font of request.fonts) {
  for (const range of font.ranges) {
    const body = Buffer.from(range.contentBase64, "base64");
    assert.equal(body.length, range.sizeBytes);
    assert.equal(sha(body), range.checksumSha256);
    assets.set(`/glyphs/${encodeURIComponent(font.fontStack)}/${range.range}.pbf`, body);
  }
}
const sources = {};
const layers = [{id: "opengeo-background", type: "background", paint: {"background-color": request.background}}];
const raisedLabels = [];
for (const occurrence of request.occurrences) {
  const source = `opengeo-source-${occurrence.position}`;
  sources[source] = {type: "geojson", data: occurrence.source};
  for (const layer of occurrence.style.layers) {
    const destination = layer.type === "symbol" && layer.metadata?.["opengeo:drawOrder"] === "above-data" ? raisedLabels : layers;
    destination.push({...layer, source});
  }
}
layers.push(...raisedLabels);
const style = {version: 8, glyphs: `${origin}/glyphs/{fontstack}/{range}.pbf`, sources, layers};
let browser;
let deniedRequests = 0;
const errors = [];
try {
  browser = await chromium.launch({
    executablePath: runtime.browser, headless: true,
    args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
      "--disable-background-networking", "--disable-dev-shm-usage", "--renderer-process-limit=2",
      "--js-flags=--max-old-space-size=256"],
  });
  assert.equal(await browser.version(), runtime.browserVersion);
  const context = await browser.newContext({
    viewport: {width: request.width, height: request.height}, deviceScaleFactor: 1,
    serviceWorkers: "block", acceptDownloads: false,
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    let body, contentType;
    if (url.origin === origin && url.pathname === "/") {
      body = "<!doctype html><meta charset=utf-8><style>html,body,#map{margin:0;width:100%;height:100%;overflow:hidden}.maplibregl-canvas-container{position:absolute;inset:0}.maplibregl-canvas{position:absolute;left:0;top:0}</style><div id=map></div><script src=/map.js></script>";
      contentType = "text/html";
    } else if (url.origin === origin && url.pathname === "/map.js") {
      body = bundle; contentType = "text/javascript";
    } else if (url.origin === origin && assets.has(url.pathname)) {
      body = assets.get(url.pathname); contentType = "application/x-protobuf";
    }
    if (body === undefined || route.request().method() !== "GET") {
      deniedRequests++;
      await route.abort("blockedbyclient");
    } else {
      await route.fulfill({status: 200, body, contentType});
    }
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error" || /glyph.*(fallback|locally)|Unable to load glyph/i.test(message.text())) errors.push(message.text());
  });
  await page.goto(origin, {waitUntil: "domcontentloaded", timeout: 15000});
  const result = await page.evaluate(async ({style, request}) => {
    let localGlyphCalls = 0;
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(...args) {
      localGlyphCalls++;
      return original.apply(this, args);
    };
    // The release bundle must expose this exact upstream engine, not an adapter
    // with an approximate glyph/label renderer.
    const engine = window.opengeoMapLibre;
    if (!engine || engine.getVersion() !== request.maplibreVersion) throw new Error("saved_map_gl_engine_mismatch");
    const errors = [];
    const map = new engine.Map({
      container: "map", style: {...style,layers:style.layers.slice(0,1)}, ...request.view, interactive: false, attributionControl: false,
      canvasContextAttributes: {preserveDrawingBuffer: true}, localIdeographFontFamily: false,
      fadeDuration: 0, renderWorldCopies: false, pixelRatio: 1,
    });
    map.on("error", (event) => errors.push(String(event.error)));
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('saved_map_gl_load_timeout')),15000);
      map.once('load',()=>{clearTimeout(timer);resolve()});
    });
    for(const occurrence of request.occurrences) {
      for(const [id,pattern] of Object.entries(occurrence.style.metadata?.['opengeo:patterns']??{})) {
        if(map.hasImage(id))continue;
        const image=new Image();
        image.src='data:image/svg+xml,'+encodeURIComponent(pattern.svg);
        await image.decode();
        const tile=document.createElement('canvas');tile.width=tile.height=64;
        const context=tile.getContext('2d');context.drawImage(image,0,0,64,64);
        map.addImage(id,context.getImageData(0,0,64,64),{pixelRatio:64/pattern.size});
      }
    }
    for(const layer of style.layers.slice(1))map.addLayer(layer);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("saved_map_gl_idle_timeout")), 15000);
      map.once("idle", () => { clearTimeout(timeout); resolve(); });
    });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (errors.length) throw new Error("saved_map_gl_style_or_source_failed");
    const canvas = map.getCanvas();
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const digest = await crypto.subtle.digest("SHA-256", pixels);
    const pixelSha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    return {png: canvas.toDataURL("image/png").split(",")[1], localGlyphCalls,
      fontFaceCount: document.fonts.size, width: canvas.width, height: canvas.height,
      maplibreVersion: engine.getVersion(), pixelSha256};
  }, {style, request: {view: request.view, maplibreVersion: request.maplibreVersion, occurrences: request.occurrences}});
  assert.deepEqual(errors, []);
  assert.equal(deniedRequests, 0, "saved_map_gl_request_denied");
  assert.equal(result.localGlyphCalls, 0, "saved_map_gl_font_fallback_forbidden");
  assert.equal(result.fontFaceCount, 0, "saved_map_gl_font_fallback_forbidden");
  assert.equal(result.width, request.width);
  assert.equal(result.height, request.height);
  const png = Buffer.from(result.png, "base64");
  assert.ok(png.length <= 20_971_520);
  writeFileSync(outputPath, png, {flag: "wx"});
  delete result.png;
  process.stdout.write(JSON.stringify({status: "pass", ...result, deniedRequests, pngSha256: sha(png)}));
} finally {
  if (browser) await browser.close();
}
