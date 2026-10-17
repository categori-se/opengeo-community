import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {loadStudioPage} from "../src/lib/studioPageBootstrap.js";

it("returns the loaded surface or one friendly retry state without exposing startup errors", async () => {
  const dom = new JSDOM("<body></body>", {url: "https://demo.studio.opengeo.tools/"});
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const surface = document.createElement("section");
    assert.equal(await loadStudioPage(async () => surface), surface);
    const failure = new Error("Unable to load file: catalog.json");
    const reports = [];
    let retries = 0;
    const error = await loadStudioPage(async () => {throw failure;}, {reportError: value => reports.push(value), retry: () => retries++});
    document.body.append(error);
    assert.equal(document.querySelectorAll('[role="alert"]').length, 1);
    assert.match(error.textContent, /This page couldn’t load/);
    assert.doesNotMatch(error.textContent, /catalog\.json|RuntimeError|Unable to load/);
    assert.deepEqual(reports, [failure]);
    error.querySelector("button").click();
    assert.equal(retries, 1);
    assert.equal(error.querySelector("a").getAttribute("href"), "/");
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
    dom.window.close();
  }
});

it("contains an attachment failure in the actual workspace entry cell", async () => {
  const dom = new JSDOM("<body></body>");
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const markdown = await readFile(new URL("../src/workspaces.md", import.meta.url), "utf8");
    const cell = markdown.split("```js\n").map(block => block.split("```")[0]).find(block => block.startsWith("const workspaceSurface = await"));
    assert.ok(cell);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const run = new AsyncFunction("loadStudioPage", "FileAttachment", "location", `${cell}\nreturn workspaceSurface;`);
    const reports = [];
    const result = await run(load => loadStudioPage(load, {reportError: error => reports.push(error)}),
      () => ({json: async () => {throw Error("Missing fixture catalog");}}), {href: "https://studio.opengeo.tools/workspaces?adapter=fixture"});
    assert.equal(result.querySelector("h1").textContent, "This page couldn’t load");
    assert.equal(reports.length, 1);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
    dom.window.close();
  }
});
