import assert from "node:assert/strict";
import {readFileSync, existsSync} from "node:fs";
import {createServer} from "node:http";
import {build} from "esbuild";
import {chromium} from "playwright";
import {fileURLToPath} from "node:url";

// Actual Data component and CSS; controlled adapters and loopback only.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("../src/components/ProjectDatasets.js", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "browser", logLevel: "silent"
});
const css = readFileSync(new URL("../src/style.css", import.meta.url));
const server = createServer((request, response) => {
  if (request.url === "/datasets.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(bundled.outputFiles[0].contents);
  } else if (request.url === "/style.css") {
    response.setHeader("Content-Type", "text/css");
    response.end(css);
  } else if (request.url === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local dataset inspection check</title><link rel="stylesheet" href="/style.css"><style>body{margin:0;font-family:system-ui;background:var(--theme-background);color:var(--theme-foreground)}main{padding:1rem;min-width:0}</style><main></main></html>');
  } else response.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  const executablePath = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(existsSync);
  browser = await chromium.launch({headless: true, executablePath, args: ["--no-sandbox"]});
  for (const width of [390, 1280]) for (const colorScheme of ["light", "dark"]) {
    const context = await browser.newContext({viewport: {width, height: 850}, colorScheme});
    const origin = `http://127.0.0.1:${server.address().port}`;
    await context.route("**/*", (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await page.evaluate(async (scheme) => {
      const {ProjectDatasets} = await import("/datasets.js");
      const variables = {
        "--theme-background": scheme === "dark" ? "#202020" : "#fff",
        "--theme-background-alt": scheme === "dark" ? "#292929" : "#f5f5f5",
        "--theme-foreground": scheme === "dark" ? "#eee" : "#222",
        "--theme-foreground-focus": scheme === "dark" ? "#8ab4ff" : "#225cbb"
      };
      for (const [name, value] of Object.entries(variables)) document.documentElement.style.setProperty(name, value);
      window.reads = {catalog: 0, history: 0};
      const adapter = {
        kind: "api",
        listResources() { window.reads.catalog++; return new Promise((resolve) => { window.resolveCatalog = resolve; }); },
        listDatasetVersions() { window.reads.history++; return new Promise((resolve) => { window.resolveHistory = resolve; }); },
        async listDatasetPermissions() { return []; },
        async createResource() { throw new Error("This check must not save"); }
      };
      const dataset = {
        id: "80000000-0000-4000-8000-000000000081", name: "Watershed observations",
        description: "Local controlled data for view-switching checks", classification: "internal",
        sourceType: "upload", format: "geojson", status: "active",
        currentVersionId: "81000000-0000-4000-8000-000000000081", currentVersionNumber: 1,
        currentVersionState: "active", featureCount: 2, extent: [-72, 41, -71, 42],
        crs: "EPSG:4326", geometryType: "Polygon", qualityResults: {checks: [], warnings: [], errors: []},
        processingJobState: "completed", tags: [], capabilities: {read: true, edit: true, download: true, managePermissions: true}
      };
      document.querySelector("main").append(ProjectDatasets({state: {
        adapter, session: {userId: "20000000-0000-4000-8000-000000000081"},
        organization: {id: "10000000-0000-4000-8000-000000000081", callerRole: "member"},
        project: {id: "50000000-0000-4000-8000-000000000081", callerRole: "owner"},
        datasets: [dataset], sources: [], maps: [], resources: [], metadataProfiles: [],
        datasetConnectionBindings: [], basemapConnectionBindings: []
      }, refresh: async () => {}}));
    }, colorScheme);
    const governance = page.getByRole("button", {name: "Metadata & publishing", exact: true});
    const history = page.getByRole("button", {name: "Version history", exact: true});
    await governance.click();
    await history.click();
    await page.evaluate(() => window.resolveCatalog([]));
    const active = page.locator(".project-dataset-inspection-view:not([hidden])");
    assert.match(await active.textContent(), /Loading authorized logical versions/);
    assert.equal(await page.getByLabel("Governed dataset title", {exact: true}).isVisible(), false);
    await page.evaluate(() => window.resolveHistory([]));
    await active.getByRole("heading", {name: "Logical version history"}).waitFor();
    await governance.click();
    const title = page.getByLabel("Governed dataset title", {exact: true});
    await title.fill("Keep the team's unfinished draft");
    await page.getByRole("button", {name: "Dataset access", exact: true}).click();
    await page.getByLabel("Dataset access user ID", {exact: true}).fill("unfinished member choice");
    await governance.focus();
    await page.keyboard.press("Enter");
    assert.equal(await title.inputValue(), "Keep the team's unfinished draft");
    assert.equal(await governance.getAttribute("aria-expanded"), "true");
    await active.getByRole("button", {name: "Hide view", exact: true}).click();
    assert.equal(await governance.evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press("Enter");
    assert.equal(await title.inputValue(), "Keep the team's unfinished draft");
    await page.getByRole("button", {name: "Dataset access", exact: true}).click();
    assert.equal(await page.getByLabel("Dataset access user ID", {exact: true}).inputValue(), "unfinished member choice");
    assert.equal(await active.count(), 1);
    assert.deepEqual(await page.evaluate(() => window.reads), {catalog: 1, history: 1});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}/${colorScheme}: horizontal overflow`);
    for (const name of ["Hide view", "Reload view"]) {
      const bounds = await active.getByRole("button", {name, exact: true}).boundingBox();
      assert.ok(bounds.height >= 44 && bounds.width >= 44, `${name}: touch target too small`);
    }
    assert.deepEqual(errors, []);
    console.log(`Data views ${width}px/${colorScheme}: late response, retained drafts, keyboard focus, containment and touch controls passed`);
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
