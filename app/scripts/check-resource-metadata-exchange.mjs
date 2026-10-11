import assert from "node:assert/strict";
import {readFileSync, existsSync} from "node:fs";
import {createHash} from "node:crypto";
import {createServer} from "node:http";
import {chromium} from "playwright";

// Loopback-only UI acceptance with an in-memory adapter, not deployment evidence.
const source = readFileSync(new URL("../src/components/ResourceMetadataExchange.js", import.meta.url));
const css = readFileSync(new URL("../src/style.css", import.meta.url));
const server = createServer((request, response) => {
  if (request.url === "/exchange.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(source);
  } else if (request.url === "/style.css") {
    response.setHeader("Content-Type", "text/css");
    response.end(css);
  } else if (request.url === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><body style="padding:12px;margin:0"><main class="project-resource-editor-panel"></main>');
  } else {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
let browser;
try {
  const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, "/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean).find(existsSync);
  browser = await chromium.launch({headless: true, executablePath, args: ["--no-sandbox"]});
  for (const width of [390, 1280]) {
    for (const colorScheme of ["light", "dark"]) {
      const context = await browser.newContext({viewport: {width, height: 850}, colorScheme, acceptDownloads: true});
      const origin = `http://127.0.0.1:${server.address().port}`;
      await context.route("**/*", (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(origin);
      const expected = await page.evaluate(async (scheme) => {
        const {ResourceMetadataExchange} = await import("/exchange.js");
        document.documentElement.style.setProperty("--theme-background", scheme === "dark" ? "#202020" : "#ffffff");
        document.documentElement.style.setProperty("--theme-foreground", scheme === "dark" ? "#eeeeee" : "#222222");
        document.body.style.background = "var(--theme-background)";
        document.body.style.color = "var(--theme-foreground)";
        const xml = '<?xml version="1.0"?><metadata>é\r\n&lt;script&gt;</metadata>';
        const json = {title: "Watershed observations", description: '<img src="https://untrusted.invalid/example">', lineage: "x".repeat(2000)};
        window.exportCalls = [];
        window.noDocument = false;
        const adapter = {exportResourceMetadata: async (...args) => {
          window.exportCalls.push(args);
          const target = args[2];
          const isXml = target === "iso_19115_3" || target === "datacite_4_7_xml";
          return {target, targetVersion: "test", status: window.noDocument ? "not_exportable_missing_required_metadata" : "mapped_with_explicit_losses",
            document: isXml || window.noDocument ? null : json, documentText: isXml && !window.noDocument ? xml : null,
            report: {mapped: ["title"], unmapped: ["content"], conformanceClaimed: false, missingRequired: window.noDocument ? ["doi"] : []}};
        }};
        document.querySelector("main").append(ResourceMetadataExchange({adapter, projectId: "project-1", resource: {id: "resource-1", language: "en"}}));
        return {xml, json};
      }, colorScheme);
      const select = page.getByLabel("Metadata format", {exact: true});
      const targets = await select.locator("option").evaluateAll((options) => options.map((option) => option.value));
      assert.equal(targets.length, 8);
      for (const target of targets) {
        // Avoid submitting dozens of downloads in a sub-second automation burst.
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await select.selectOption(target);
        if (target === "ogc_records_1_0") await page.getByLabel("OGC record language", {exact: true}).fill("fr");
        await page.getByRole("button", {name: "Prepare metadata export", exact: true}).click();
        const downloadEvent = page.waitForEvent("download");
        await page.getByRole("button", {name: "Download metadata", exact: true}).click();
        const download = await downloadEvent;
        const bytes = readFileSync(await download.path());
        const isXml = target === "iso_19115_3" || target === "datacite_4_7_xml";
        assert.equal(bytes.toString("utf8"), isXml ? expected.xml : JSON.stringify(expected.json, null, 2));
        const reportEvent = page.waitForEvent("download");
        await page.getByRole("button", {name: "Download conversion report", exact: true}).click();
        const reportDownload = await reportEvent;
        const receipt = JSON.parse(readFileSync(await reportDownload.path(), "utf8"));
        assert.equal(receipt.document.filename, download.suggestedFilename());
        assert.equal(receipt.document.checksumSha256, createHash("sha256").update(bytes).digest("hex"));
        assert.equal(receipt.target, target);
        assert.equal(receipt.report.conformanceClaimed, false);
        await page.locator("summary").filter({hasText: "Metadata document"}).click();
        await page.locator("summary").filter({hasText: "Conversion report"}).click();
        assert.equal(await page.locator("main img, main script").count(), 0);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${target}: horizontal overflow`);
      }
      const calls = await page.evaluate(() => window.exportCalls);
      assert.equal(calls.length, 8);
      assert.deepEqual(calls.find((call) => call[2] === "ogc_records_1_0")[3], {language: "fr"});
      await page.evaluate(() => {window.noDocument = true;});
      await select.selectOption("datacite_4_7_xml");
      await page.getByRole("button", {name: "Prepare metadata export", exact: true}).click();
      await page.getByRole("status").filter({hasText: "Required metadata is missing"}).waitFor();
      assert.equal(await page.getByRole("button", {name: "Download metadata", exact: true}).count(), 0);
      assert.equal(await page.getByRole("button", {name: "Download conversion report", exact: true}).count(), 1);
      assert.deepEqual(errors, []);
      console.log(`PASS Chromium ${width}px ${colorScheme}: eight document/report download pairs, exact XML, JSON, checksums, inert previews, missing-metadata state, layout containment.`);
      await context.close();
    }
  }
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
