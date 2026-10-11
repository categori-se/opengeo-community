import assert from "node:assert/strict";
import {existsSync, readFileSync, mkdtempSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {createServer} from "node:http";
import {fileURLToPath} from "node:url";
import {resolve, sep, join} from "node:path";
import {tmpdir} from "node:os";
import {chromium} from "playwright";
import {build} from "esbuild";

// Render the actual source workspace with synthetic metadata and storage.
// No credentials, AWS requests, archive body transfers or releases are used.
const sourceRoot = resolve(fileURLToPath(new URL("../src/", import.meta.url)));
const contractsRoot = resolve(fileURLToPath(new URL("../vendor/workspace-contracts/", import.meta.url)));
const contracts = JSON.parse(readFileSync(join(contractsRoot, "package.json"), "utf8"));
assert.equal(contracts.version, "0.1.0-alpha.9");
const receiptPath = process.env.OPEN_GEO_FRAMEWORK_UI_RECEIPT;
const priorPath = process.env.OPEN_GEO_FRAMEWORK_UI_PRIOR_RECEIPT;
const prior = priorPath ? JSON.parse(readFileSync(resolve(priorPath), "utf8")) : null;
const carriedSeconds = prior?.cumulativeSeconds ?? prior?.elapsedSeconds ?? 0;
assert(Number.isFinite(carriedSeconds) && carriedSeconds >= 0 && carriedSeconds < 60);
const executionSeconds = Math.min(prior ? 40 : 60, 60 - carriedSeconds);
const started = performance.now(), deadline = started + executionSeconds * 1000;
const fixtureText = JSON.stringify({type: "FeatureCollection", features: [], note: "x".repeat(18_930_900)});
const fixtureChecksum = createHash("sha256").update(fixtureText).digest("hex");
const receipt = {schemaVersion: "opengeo.framework-revision-data-ui.1", status: "running",
  limits: {seconds: 60, executionSeconds, viewports: [390, 1280], colorScheme: "dark", cloudRequests: 0},
  checks: [], fixture: {sizeBytes: Buffer.byteLength(fixtureText), checksumSha256: fixtureChecksum},
  cloudRequests: 0, productionBrowsing: false,
  harnessMethod: "existing esbuild browser fixture path with exact alpha.9 vendor resolution",
  carriedAttempt: prior ? {path: priorPath, status: prior.status, elapsedSeconds: carriedSeconds, assertions: prior.checks.reduce((count, item) => count + item.assertions.length, 0)} : null};
const within = () => assert(performance.now() < deadline, "Local UI check exceeded 60 seconds");
const screenshots = process.argv.includes("--screenshots") ? mkdtempSync(join(tmpdir(), "opengeo-framework-paths-")) : null;
let workspaceBundle;
const server = createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  if (pathname === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/style.css"><body style="padding:12px;margin:0"><main></main>');
    return;
  }
  if (pathname === "/workspace.js") {
    response.setHeader("Content-Type", "text/javascript"); response.end(workspaceBundle); return;
  }
  const path = resolve(sourceRoot, pathname.slice("/src/".length));
  if (pathname.startsWith("/src/") && path.startsWith(sourceRoot + sep)
    && /\.(js|css)$/.test(path) && existsSync(path)) {
    response.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : "text/javascript");
    response.end(readFileSync(path));
  } else { response.writeHead(404); response.end(); }
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
let browser;
try {
  const bundle = await build({stdin: {resolveDir: resolve(sourceRoot, ".."), contents:
    `export {FrameworkSourceWorkspace} from './src/components/ProjectSites.js';`}, bundle: true,
    platform: "browser", format: "esm", write: false, plugins: [{name: "reviewed-local-fixture-dependencies", setup(builder) {
      builder.onResolve({filter: /^@categori\/workspace-contracts(?:\/.*)?$/}, args => {
        const key = args.path === contracts.name ? "." : "." + args.path.slice(contracts.name.length);
        const target = contracts.exports[key];
        assert(typeof target === "string" && target.endsWith(".js"));
        return {path: resolve(contractsRoot, target)};
      });
      builder.onResolve({filter: /^observablehq:stdlib$/}, () => ({path: "unused-renderer-assets", namespace: "fixture"}));
      builder.onLoad({filter: /.*/, namespace: "fixture"}, () => ({contents:
        "export const FileAttachment = path => ({url: async () => '/unused-renderer/' + path});"}));
    }}]});
  workspaceBundle = bundle.outputFiles[0].contents;
  browser = await chromium.launch({headless: true, executablePath: ["/usr/bin/chromium-browser", "/usr/bin/chromium"].find(existsSync), args: ["--no-sandbox"]});
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const width of [390, 1280]) {
    within();
    const scheme = "dark";
    const check = {width, scheme, assertions: [], status: "running", blockedExternalRequests: 0};
    receipt.checks.push(check);
    const context = await browser.newContext({viewport: {width, height: 900}, colorScheme: scheme});
    await context.route("**/*", route => {
      if (route.request().url().startsWith(origin + "/")) return route.continue();
      check.blockedExternalRequests++;
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(6_000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    await page.evaluate(async ({scheme, fixtureChecksum}) => {
      const {FrameworkSourceWorkspace} = await import("/workspace.js");
      const tokens = scheme === "dark" ? {
        background: "#202020", "background-alt": "#262626", foreground: "#eeeeee", "foreground-muted": "#b8b8b8",
        "foreground-faintest": "#555555", "foreground-focus": "#6e9fff"
      } : {background: "#ffffff", "background-alt": "#f5f5f5", foreground: "#222222", "foreground-muted": "#555555",
        "foreground-faintest": "#cccccc", "foreground-focus": "#185abc"};
      for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(`--theme-${name}`, value);
      document.body.style.background = "var(--theme-background)";
      document.body.style.color = "var(--theme-foreground)";
      document.body.style.fontFamily = "system-ui, sans-serif";
      const localData = new Blob([JSON.stringify({type: "FeatureCollection", features: [], note: "x".repeat(18_930_900)})]);
      const archive = {id: "00000000-0000-4000-8000-000000000087", datasetId: "dataset",
        datasetVersionId: "00000000-0000-4000-8000-000000000086", dataObjectId: "00000000-0000-4000-8000-000000000085",
        sourceProjectId: "source", s3VersionId: "fixture-version", available: true,
        contentType: "application/geo+json", sizeBytes: localData.size, checksumSha256: fixtureChecksum};
      let source = {id: "source", siteId: "site", title: "Coastal atlas", routeNamespace: "atlas", rightsStatus: "unreviewed",
        currentRevisionNumber: 1, currentRevisionId: "revision-1", buildPolicy: {frameworkVersion: "1.13.4", compilerImageDigest: "sha256:" + "b".repeat(64), networkPolicy: "deny_all"}};
      let revision = {id: "revision-1", revisionNumber: 1, title: "Coastal atlas", entryPath: "index.md", lockfilePath: null,
        dataAttachments: [], files: [{relativePath: "index.md", contentType: "text/markdown", blob: new Blob(["# Coastal atlas\n"])}]};
      const fixture = window.fixture = {reads: 0, dataReads: 0, saves: [], unavailable: false, localData};
      const state = {organization: {callerRole: "admin"}, project: {id: "project"}, sites: [{id: "site", title: "Atlas", slug: "atlas"}],
        datasets: [{id: "dataset", name: "Coastal water areas"}], observableSourceProjects: [source], adapter: {
          listObservableSourceProjects: async () => [source],
          listObservableSourceRevisions: async () => [revision],
          readObservableSourceRevisionFile: async (_project, _source, _revision, path) => ({blob: revision.files.find(file => file.relativePath === path).blob}),
          listObservableDataAttachments: async () => { fixture.reads++; return [{...archive, available: !fixture.unavailable}]; },
          requestDatasetDownload: async () => { fixture.dataReads++; throw Error("File bytes are outside this UI check"); },
          saveObservableSourceRevision: async (_project, _source, draft) => {
            fixture.saves.push({bindings: draft.dataAttachments, fileCount: draft.files.length, text: await draft.files[0].blob.text()});
            const revisionNumber = source.currentRevisionNumber + 1;
            revision = {...draft, sourceProjectId: source.id, id: `revision-${revisionNumber}`, revisionNumber};
            source = {...source, currentRevisionNumber: revisionNumber, currentRevisionId: revision.id};
            return revision;
          }
        }};
      const refresh = async () => {
        state.observableSourceProjects = await state.adapter.listObservableSourceProjects();
        document.querySelector("main").replaceChildren(FrameworkSourceWorkspace({state, refresh}));
      };
      await refresh();
    }, {scheme, fixtureChecksum});
    assert.equal(await page.evaluate(() => fixture.reads), 0);
    check.assertions.push("Opening the editor does not load archive metadata or file bytes");
    await page.getByRole("button", {name: "Reload saved draft", exact: true}).click();
    await page.getByLabel("Framework source editor", {exact: true}).fill("# Edited atlas\n");
    await page.getByRole("button", {name: "Insert data…", exact: true}).click();
    check.assertions.push("Insert data opens the file selector through the visible editor toolbar");
    await page.getByLabel("Registered archive file", {exact: true}).selectOption("00000000-0000-4000-8000-000000000087");
    await page.locator(".framework-archive-selection").getByLabel("FileAttachment path", {exact: true}).fill("data/coastal-water.geojson");
    await page.getByRole("button", {name: "Insert file", exact: true}).click();
    assert.equal(await page.getByRole("button", {name: "Undo removal", exact: true}).count(), 0, "Hidden undo must not be exposed as a button");
    const insertedText = await page.getByLabel("Framework source editor", {exact: true}).inputValue();
    assert.ok(insertedText.startsWith("# Edited atlas\n"));
    assert.ok(insertedText.includes('const data_coastal_water = await FileAttachment("data/coastal-water.geojson").json();'));
    check.assertions.push("Registered alias inserts the matching FileAttachment JSON reader at the editor cursor");
    assert.equal(await page.evaluate(() => fixture.saves.length), 0);
    await page.locator(".source-editor-file-tray > summary").click();
    await page.getByText("Import files or a project folder", {exact: true}).click();
    await page.evaluate(() => {
      const selection = new DataTransfer();
      const currentText = document.querySelector('textarea[aria-label="Framework source editor"]').value;
      for (const [path, blob] of [["index.md", new Blob([currentText])], ["data/coastal-water.geojson", fixture.localData]]) {
        const file = new File([blob], path.split("/").at(-1));
        Object.defineProperty(file, "webkitRelativePath", {value: `atlas/${path}`});
        selection.items.add(file);
      }
      const input = document.querySelector("input[webkitdirectory]");
      input.files = selection.files;
      input.dispatchEvent(new Event("change", {bubbles: true}));
    });
    await page.getByRole("status").filter({hasText: "selected data file matches its exact registered archive"}).waitFor();
    check.assertions.push("The local 19 MB file reconciles to its exact registered checksum without entering the source tree");
    assert.equal(await page.getByLabel("Framework source file", {exact: true}).locator("option").count(), 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "horizontal overflow before Save draft");
    check.assertions.push("The editor and open data/import controls fit the viewport before saving");
    const layout = await page.locator(".framework-revision-data").evaluate(element => ({
      width: element.getBoundingClientRect().width
    }));
    if (width === 1280) assert.ok(layout.width > 900, "Source editing must use the available desktop width");
    if (screenshots) await page.locator(".framework-revision-data").screenshot({path: join(screenshots, `${width}-${scheme}.png`)});
    await page.getByRole("button", {name: "Save draft", exact: true}).click();
    await page.waitForFunction(() => fixture.saves.length === 1);
    await page.getByRole("button", {name: "Reload saved draft", exact: true}).click();
    await page.getByRole("button", {name: "Insert data…", exact: true}).click();
    assert.equal(await page.getByLabel("Archive file path 1", {exact: true}).inputValue(), "data/coastal-water.geojson");
    assert.equal(await page.getByLabel("Framework source editor", {exact: true}).inputValue(), insertedText);
    check.assertions.push("Save and reopen preserve the inserted source text and exact attachment ID/alias");
    await page.getByRole("button", {name: "Remove archive file path 1", exact: true}).click();
    await page.getByRole("button", {name: "Undo removal", exact: true}).click();
    check.assertions.push("Removing and undoing a file alias preserves its reference");
    await page.evaluate(() => { fixture.unavailable = true; });
    await page.getByLabel("Framework source editor", {exact: true}).fill(insertedText + "\n<!-- Updated draft -->\n");
    await page.getByRole("button", {name: "Save draft", exact: true}).click();
    await page.getByText(/Could not confirm the source revision.*archived file is unavailable/).waitFor();
    assert.deepEqual(await page.evaluate(() => fixture.saves), [{bindings: [{attachmentId: "00000000-0000-4000-8000-000000000087", relativePath: "data/coastal-water.geojson"}], fileCount: 1, text: insertedText}]);
    assert.equal(await page.getByRole("button", {name: "Insert FileAttachment for data/coastal-water.geojson", exact: true}).isDisabled(), true);
    assert.equal(await page.evaluate(() => fixture.dataReads), 0);
    check.assertions.push("Unavailable files prevent source saving and further snippet insertion; no file body was requested");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "horizontal overflow after withdrawal");
    assert.deepEqual(errors, []);
    assert.equal(check.blockedExternalRequests, 0);
    check.assertions.push("No horizontal overflow, uncaught page errors, or external requests");
    check.metadataReads = await page.evaluate(() => fixture.reads);
    check.savedRevisions = await page.evaluate(() => fixture.saves.length);
    check.status = "pass";
    within();
    console.log(`PASS Chromium ${width}px ${scheme}: registered alias/code insertion, exact 19 MB reconciliation, Save/reopen pins and text, remove/undo, unavailable-file denial, containment.`);
    await context.close();
  }
  receipt.status = "pass";
  if (screenshots) console.log(`Screenshots: ${screenshots}`);
} catch (error) {
  receipt.status = "failed";
  receipt.error = {name: error?.name ?? "Error", message: String(error?.message ?? "Local UI check failed").slice(0, 1000)};
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  receipt.elapsedSeconds = Number(((performance.now() - started) / 1000).toFixed(6));
  receipt.cumulativeSeconds = Number((receipt.elapsedSeconds + carriedSeconds).toFixed(6));
  if (receiptPath) writeFileSync(resolve(receiptPath), JSON.stringify(receipt, null, 2) + "\n", {mode: 0o600});
}
