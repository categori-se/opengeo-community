// Local built app, current source CSS, and no external requests.
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {resolve, extname} from "node:path";
import {chromium} from "playwright";

const dist = resolve("dist");
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  const file = resolve(dist, `.${path === "/" ? "/index.html" : decodeURIComponent(path)}`);
  if (!file.startsWith(`${dist}/`)) return res.writeHead(403).end();
  try {
    res.setHeader("Content-Type", ({".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json"})[extname(file)] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch {res.writeHead(404).end();}
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({executablePath: ["/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]});
try {
  const page = await browser.newPage({viewport: {width: 940, height: 1026}, serviceWorkers: "block"});
  await page.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.goto(origin);
  await page.locator(".gis-map-control-stack").waitFor();
  await page.addStyleTag({content: await readFile("src/style.css", "utf8")});
  for (const [width, height] of [[940,1026], [1024,768], [1120,800], [1280,720], [820,900], [390,844], [900,450]]) {
    await page.setViewportSize({width, height});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const result = await page.evaluate(() => {
      const rect = selector => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return {left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width};
      };
      return {map: rect(".gis-map"), controls: rect(".gis-map-control-stack"), shell: rect(".opengeo-workbench"), tracks: getComputedStyle(document.querySelector(".opengeo-workbench")).gridTemplateColumns, column: rect(".gis-map-column"), topbar: rect(".gis-topbar")};
    });
    console.log(JSON.stringify({width, height, ...result}));
    assert.ok(result.controls.right <= width && result.controls.left >= 0, "Map controls must remain inside the viewport");
    assert.ok(result.controls.top >= result.map.top && result.controls.bottom <= result.map.bottom, "Map controls must fit vertically");
  }
} finally {await browser.close(); await new Promise(resolve => server.close(resolve));}
