import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {resolve, extname, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {chromium} from "playwright";

const project = fileURLToPath(new URL("../../publications/noaa-coastal-imagery/", import.meta.url));
const mount = "/analysis/reading-beyond-visible/";
const manifest = JSON.parse(await readFile(resolve(project, "src/data/metadata-manifest.json")));
for (const item of manifest.files) {
  const bytes = await readFile(resolve(project, "src", item.path));
  assert.equal(bytes.length, item.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256);
}
assert.equal(manifest.sources.length, 7);
assert.equal(manifest.sources.filter(source => source.originals.state === "bytes_verified").length, 3);
assert.ok(manifest.sources.every(source => source.fallbackReady === false));
const dist = resolve(project, "dist");
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (!path.startsWith(mount)) throw Error("Outside mount");
    let relative = path.slice(mount.length);
    if (!relative || relative.endsWith("/")) relative += "index.html";
    else if (!extname(relative)) relative += ".html";
    const target = resolve(dist, relative);
    if (!target.startsWith(dist + sep)) throw Error("Unsafe path");
    res.setHeader("Content-Type", ({".html":"text/html", ".js":"text/javascript", ".css":"text/css", ".json":"application/json", ".xml":"application/xml"})[extname(target)] ?? "application/octet-stream");
    res.end(await readFile(target));
  } catch {res.statusCode = 404; res.end();}
});
let browser;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const executablePath = ["/usr/bin/chromium-browser", "/usr/bin/chromium"].find(existsSync);
  browser = await chromium.launch({headless:true, ...(executablePath ? {executablePath} : {})});
  const context = await browser.newContext();
  const origin = "http://127.0.0.1:" + server.address().port;
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [], missing = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => {if (response.url().startsWith(origin) && response.status() >= 400) missing.push(response.url());});
  const paths = ["", "project", "datasets/coastal-connecticut-2004", "datasets/connecticut-infrared-2017", ...manifest.sources.map(source => "sources/" + source.id)];
  for (const path of paths) {
    await page.goto(origin + mount + path);
    await page.locator("main h1").waitFor();
    if (path.startsWith("sources/")) {
      await page.waitForFunction(() => [...document.querySelectorAll("main pre")].some(pre => pre.textContent.includes('"bandCount"')));
      const link = page.getByRole("link", {name:"Download exact preserved JSON"});
      await link.waitFor();
      assert.ok((await link.getAttribute("href")).includes("_file/data/"));
      const expected = manifest.sources.find(source => path.endsWith(source.id));
      const content = await page.locator("main pre").first().textContent();
      assert.equal(JSON.parse(content).bandCount, expected.bandCount);
    }
    assert.equal(await page.locator(".observablehq--error").count(), 0, path);
  }
  await page.goto(origin + mount + "index.html");
  await page.getByRole("heading", {name: "Reading beyond the visible", exact: true}).waitFor();
  assert.equal(await page.locator(".observablehq--error").count(), 0);
  assert.equal(await (await fetch(origin + mount)).text(), await (await fetch(origin + mount + "index.html")).text());
  assert.deepEqual(errors, []);
  assert.deepEqual(missing, []);
  console.log(JSON.stringify({status:"passed",pages:paths.length,metadataFilesVerified:manifest.files.length,nestedMount:mount,externalRequestsBlocked:true,liveStudioRecordsChanged:false,published:false}));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
