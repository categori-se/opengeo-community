import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {resolve, extname, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright";

// Exercise the built Studio, not a replacement welcome-dialog fixture.
const root = fileURLToPath(new URL("../dist/", import.meta.url));
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const file = resolve(root, "." + (path === "/" ? "/index.html" : path));
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) throw Error("Invalid path");
    res.setHeader("Content-Type", ({".html":"text/html", ".js":"text/javascript", ".css":"text/css", ".json":"application/json"})[extname(file)] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch {res.statusCode = 404; res.end();}
});
let browser;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const executablePath = ["/usr/bin/chromium-browser", "/usr/bin/chromium"].find(existsSync);
  browser = await chromium.launch({headless:true, ...(executablePath ? {executablePath} : {})});
  const context = await browser.newContext({viewport:{width:1280,height:900}, serviceWorkers:"block"});
  const origin = "http://127.0.0.1:" + server.address().port;
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  const welcome = page.getByRole("dialog", {name:"OpenGeo Studio start"});
  await page.goto(origin);
  await welcome.waitFor();
  assert.equal(await page.getByRole("combobox", {name:"Show welcome screen"}).inputValue(), "daily");
  await page.getByRole("button", {name:"Close start panel and use an empty map"}).click();
  await page.reload();
  await page.locator(".start-workbench-frame").waitFor();
  assert.equal(await welcome.isVisible(), false);
  const tab = await context.newPage();
  await tab.goto(origin);
  await tab.locator(".start-workbench-frame").waitFor();
  assert.equal(await tab.getByRole("dialog", {name:"OpenGeo Studio start"}).isVisible(), false);
  // Simulate a day of absence without a long-running test or auth changes.
  await tab.evaluate(() => localStorage.setItem("opengeo.studio.welcome.visit", String(Date.now() - 86_400_001)));
  await tab.reload();
  await tab.getByRole("dialog", {name:"OpenGeo Studio start"}).waitFor();
  await tab.getByRole("combobox", {name:"Show welcome screen"}).selectOption("manual");
  await tab.getByRole("button", {name:"Continue with an empty map"}).click();
  await tab.reload();
  await tab.locator(".start-workbench-frame").waitFor();
  assert.equal(await tab.getByRole("dialog", {name:"OpenGeo Studio start"}).isVisible(), false);
  console.log(JSON.stringify({status:"passed",checks:["fresh opening", "dismiss", "refresh", "new tab", "day away", "manual preference"],liveAuthentication:false}));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
