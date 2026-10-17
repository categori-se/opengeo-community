import assert from "node:assert/strict";
import {readFile, readdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import {join, relative as relativePath} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, beforeEach, it} from "node:test";
import {JSDOM} from "jsdom";
import * as kit from "@observablehq/notebook-kit";
import {convertLegacyObservable} from "../../services/observable-builder/src/legacy-observable.mjs";
import {publicationFormat} from "../../services/observable-builder/src/publication-format.mjs";
import {unzipSync, zipSync, strToU8} from "fflate";
import {FrameworkSourceWorkspace, prepareObservableBrowserFiles, appendObservableMarkdownPage} from "../src/components/ProjectSites.js";
import {FrameworkRevisionData} from "../src/components/FrameworkRevisionData.js";
import {normalizeObservableSourceFiles} from "../src/lib/apiClient.js";
import {NotebookCellEditor} from "../src/components/NotebookCellEditor.js";
import {parseNotebookCells, changeNotebookCell} from "../src/lib/notebookCells.js";
import {parseJupyterCells, changeJupyterCell} from "../src/lib/jupyterCells.js";
import {createPublicationSourceArchive, readPublicationSourceArchive} from "../src/lib/publicationSourceArchive.js";
import {readPublicationSourceBackupInputs} from "../src/lib/publicationSourceBackupInputs.js";
import {prepareLegacyNotebookImport} from "../src/lib/legacyNotebookImport.js";
import {planPublicationSourceDownload, createPublicationSourceDownloadReader} from "../src/lib/publicationSourceDownload.js";

const file = (path, content = "source", type = "") => {
  const blob = new Blob([content], {type});
  Object.defineProperties(blob, {name: {value: path.split("/").at(-1)}, webkitRelativePath: {value: path}});
  return blob;
};

it('retains generated revision module names without changing graph identities or source path rules', async () => {
  const root = `import define1 from "./child@17.js"; import define2 from "./child_17.js";
export default function define(runtime, observer) { const main = runtime.module();
const child1 = runtime.module(define1); const child2 = runtime.module(define2);
main.import("value", "first", child1); main.import("value", "second", child2); return main; }`;
  const child = '\uFEFFfunction _value() { return 2; }\r\nexport default function define(runtime, observer) { const main = runtime.module(); main.variable(observer("value")).define("value", _value); return main; }\r\n';
  const dom = new JSDOM('');
  try {
    const draft = await prepareLegacyNotebookImport({file: file('main@4.js', root),
      attachments: [{relativePath: 'child@17.js', blob: new Blob([child])}, {relativePath: 'child_17.js', blob: new Blob([child])}],
      convert: options => convertLegacyObservable(options.source, {...options, kit, document: dom.window.document})});
    const records = draft.conversionReport.retainedModules;
    const generated = records.find(record => record.path === 'child@17.js');
    assert.match(generated.retainedPath, /^original\/modules\/import-[a-f0-9]{64}\.js\.txt$/);
    assert.equal(records.find(record => record.path === 'child_17.js').retainedPath, 'original/modules/child_17.js.txt');
    const retained = draft.files.find(record => record.relativePath === generated.retainedPath);
    assert.deepEqual(new Uint8Array(await retained.blob.arrayBuffer()), new TextEncoder().encode(child));
    assert.match(await draft.files.find(record => record.relativePath === 'index.html').blob.text(), /child@17\.js/);
    assert.equal(draft.conversionReport.provenance.grantsPermission, false);
  } finally {dom.window.close();}
});

it("imports the complete NOAA publication through Studio while preserving exact provider metadata", async () => {
  const root = new URL("../../publications/noaa-coastal-imagery/", import.meta.url);
  const entries = await readdir(root, {recursive: true, withFileTypes: true});
  const selected = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const relative = relativePath(fileURLToPath(root), path);
    if (relative.split("/").some(part => ["dist", "node_modules", ".observablehq"].includes(part))) continue;
    selected.push(file(`noaa-coastal-imagery/${relative}`, await readFile(path)));
  }
  const imported = prepareObservableBrowserFiles([], selected);
  assert.ok(imported.files.some(item => item.relativePath === "src/index.md"));
  assert.ok(imported.files.some(item => item.relativePath === "src/project.md"));
  assert.ok(!imported.files.some(item => item.relativePath === "src/analysis/reading-beyond-visible.md"));
  assert.ok(imported.files.some(item => item.relativePath === "observablehq.config.js"));
  const metadata = imported.files.find(item => item.relativePath === "src/data/coastal-connecticut-2004.xml.txt");
  assert.equal(metadata.contentType, "text/plain");
  assert.deepEqual(Buffer.from(await metadata.blob.arrayBuffer()), await readFile(new URL("../../imports/noaa-cir-preflight-20260909/connecticut-source.xml", import.meta.url)));
  assert.equal(imported.files.filter(item => /^src\/sources\/.*\.md$/.test(item.relativePath)).length, 7);
});

it("adds a page without replacing existing files and rejects path conflicts", async () => {
  const original = {relativePath:"src/index.md", blob:new Blob(["# Home"]), contentType:"text/markdown"};
  const files = [original];
  const next = appendObservableMarkdownPage(files, {relativePath:"src/field-labs/noaa.md", title:'NOAA: "Data"'});
  assert.equal(next.find(item => item.relativePath === original.relativePath).blob, original.blob);
  assert.match(await next[0].blob.text(), /title: "NOAA: \\"Data\\""/);
  assert.equal(files.length, 1);
  for (const path of ["src/INDEX.md", "src/index.md/child.md", "../outside.md", "src/.env", "dist/page.md"]) {
    assert.throws(() => appendObservableMarkdownPage(files, {relativePath:path, title:"Page"}));
  }
  assert.throws(() => appendObservableMarkdownPage([], {relativePath:"src/page.md", title:"Page"}));
  assert.throws(() => appendObservableMarkdownPage(files, {relativePath:"src/page.md", title:"Page", dataAttachments:[{relativePath:"src/page.md"}]}));
});

it("imports the authored tree without reading generated files and reports exclusions", () => {
  const input = [file("atlas/src/methods/transmission-line-analysis.md"), file("atlas/package-lock.json", "{}"),
    file("atlas/node_modules/library/index.js"), file("atlas/dist/index.html"),
    file("atlas/src/.observablehq/cache/index.js"), file("atlas/.git/config"), file("atlas/.gitignore"), file("atlas/src/.gitignore")];
  const result = prepareObservableBrowserFiles([], input);
  assert.deepEqual(result.files.map(f => f.relativePath), ["package-lock.json", "src/methods/transmission-line-analysis.md"]);
  assert.equal(result.files[1].contentType, "text/markdown");
  assert.equal(result.excludedCount, 6);
  assert.ok(result.excludedLocations.includes(".observablehq"));
});

it("rejects secrets, unsafe paths, unsupported source and ambiguous duplicate names", () => {
  for (const path of ["atlas/.env", "atlas/.aws/credentials", "atlas/src/../dist/output.js", "atlas/src\\index.js", "atlas/source.zip"]) {
    assert.throws(() => prepareObservableBrowserFiles([], [file(path)]));
  }
  assert.throws(() => prepareObservableBrowserFiles([], [file("atlas/src/Page.md"), file("atlas/src/page.md")]));
  assert.throws(() => prepareObservableBrowserFiles([file("index.md")], [file("atlas/index.md")]));
});

it("rejects oversize complete trees before any hashing or upload", () => {
  const blob = new Blob([new Uint8Array(4_194_304)]);
  assert.throws(() => normalizeObservableSourceFiles(Array.from({length: 5}, (_, i) => ({relativePath: `data${i}.txt`, blob}))), /16 MiB/);
});

it("identifies large data files without dropping them or replacing the working tree", async () => {
  const {root, saved} = editor();
  selectDirectory(root, [file("atlas/src/index.md", "# Preserve me")]);
  await tick();
  selectDirectory(root, [file("atlas/src/index.md", "# New source"),
    file("atlas/src/data/water.geojson", new Uint8Array(18_930_972))]);
  await tick();
  const guidance = root.querySelector(".framework-import-guidance");
  assert.equal(guidance.hidden, false);
  assert.match(guidance.textContent, /src\/data\/water.geojson/);
  assert.match(guidance.textContent, /18,930,972 bytes/);
  assert.match(guidance.textContent, /SHA-256/);
  assert.equal(root.querySelector('[aria-label="Framework source editor"]').value, "# Preserve me");
  assert.equal(saved.length, 0);
});

let dom, previous, previousMutationObserver;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>");
  previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  previousMutationObserver = Object.getOwnPropertyDescriptor(globalThis, "MutationObserver");
  Object.defineProperty(globalThis, "document", {configurable: true, value: dom.window.document});
  Object.defineProperty(globalThis, "MutationObserver", {configurable: true, value: dom.window.MutationObserver});
});
afterEach(() => {
  if (previous) Object.defineProperty(globalThis, "document", previous);
  else delete globalThis.document;
  if (previousMutationObserver) Object.defineProperty(globalThis, "MutationObserver", previousMutationObserver);
  else delete globalThis.MutationObserver;
  dom.window.close();
});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const savedSourceFiles = async blobs => Promise.all([...blobs].map(async ([relativePath, blob]) => ({
  relativePath, contentType: blob.type, sizeBytes: blob.size,
  checksumSha256: createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex')
})));
async function until(predicate, message) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (predicate()) return;
    await tick();
  }
  assert.ok(predicate(), message);
}
function captureDownloads(t) {
  const blobs = [], downloads = [], revoked = [], releases = [];
  t.mock.method(URL, "createObjectURL", blob => {blobs.push(blob); return `blob:source-${blobs.length}`;});
  t.mock.method(URL, "revokeObjectURL", url => revoked.push(url));
  t.mock.method(dom.window.HTMLAnchorElement.prototype, "click", function () {
    downloads.push({name: this.download, url: this.href, blob: blobs.at(-1)});
  });
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    if (delay === 1000) {releases.push(callback); return 0;}
    return originalTimeout(callback, delay, ...args);
  });
  return {downloads, revoked, release: () => releases.splice(0).forEach(callback => callback())};
}
const archiveRecord = {
  id: "00000000-0000-4000-8000-000000000087", datasetId: "00000000-0000-4000-8000-000000000086",
  datasetVersionId: "00000000-0000-4000-8000-000000000085", dataObjectId: "00000000-0000-4000-8000-000000000084",
  available: true, contentType: "application/geo+json", sizeBytes: 18_930_972, checksumSha256: "a".repeat(64)
};
function editor({adapter = {}, refresh = async () => {}, revision = {}, legacyConverter} = {}) {
  const saved = [];
  const state = {organization: {callerRole: "admin"}, project: {id: "project"},
    sites: [{id: "site", title: "Atlas", slug: "atlas"}],
    observableSourceProjects: [{id: "source", siteId: "site", title: "Atlas source", routeNamespace: "atlas",
      rightsStatus: "unreviewed", currentRevisionNumber: 0, currentRevisionId: null,
      buildPolicy: {frameworkVersion: "1.13.4", compilerImageDigest: "digest", networkPolicy: "deny"}, ...revision}],
    adapter: {listObservableSourceProjects: async () => [], listObservableDataAttachments: async () => [archiveRecord],
      saveObservableSourceRevision: async (...args) => saved.push(args), ...adapter}};
  const root = FrameworkSourceWorkspace({state, refresh, legacyConverter});
  document.body.append(root);
  return {root, saved, state};
}

it("keeps revision saving direct while file interchange and settings use nearby trays", () => {
  const {root} = editor();
  const toolbar = root.querySelector('.source-editor-toolbar');
  assert.deepEqual([...toolbar.querySelectorAll(':scope > button')].map(button => button.textContent),
    ['Save draft', 'Reload saved draft', 'Insert map…', 'Insert data…']);
  assert.equal(root.querySelector('.publication-map-insert').hidden, true);
  toolbar.querySelectorAll(':scope > button')[2].click();
  assert.equal(root.querySelector('.publication-map-insert').open, true);
  const fileTray = root.querySelector('.source-editor-file-tray');
  assert.equal(fileTray.open, false);
  assert.equal(fileTray.querySelector(':scope > summary').textContent, 'Files');
  assert.match(fileTray.textContent, /Import files or a project folder/);
  assert.match(fileTray.textContent, /Download complete input backup/);
  assert.equal(root.querySelector('.source-editor-trays > details:last-child > summary').textContent,
    'Draft settings and data references');
});

it("retains every original byte when a text file is opened but not edited", async () => {
  const {root, saved} = editor();
  const original = file("atlas/a.md", new Uint8Array([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x41, 0x0d, 0x0a]));
  const other = file("atlas/b.md", "# B\r\n");
  selectDirectory(root, [original, other]);
  await tick();
  const select = root.querySelector('[aria-label="Framework source file"]');
  select.value = "b.md";
  select.dispatchEvent(new dom.window.Event("change"));
  await tick();
  [...root.querySelectorAll("button")].find(b => b.textContent === "Save draft").click();
  await tick();
  assert.equal(saved[0][2].files[0].blob, original, "Opening a UTF-8 BOM/CRLF file must not rewrite it");
  assert.equal(saved[0][2].files[1].blob, other, "Committing an unchanged active file must retain exact bytes");
});

it("downloads edited native Jupyter source with its filename, metadata, saved outputs and line endings intact", async t => {
  const capture = captureDownloads(t);
  const source = {nbformat: 4, nbformat_minor: 5, metadata: {custom: {retain: true}, language_info: {name: "python"}},
    cells: [{id: "calculation", cell_type: "code", metadata: {tag: "original"}, source: "x = 1", execution_count: 1,
      outputs: [{output_type: "execute_result", data: {"text/plain": "1"}, metadata: {retained: true}}]}]};
  const {root, saved} = editor();
  selectDirectory(root, [file("atlas/analysis.ipynb", "\uFEFF" + JSON.stringify(source, null, 2).replace(/\n/g, "\r\n"), "application/x-ipynb+json")]);
  await tick(); await tick();
  const edited = structuredClone(source); edited.cells[0].source = "x = 2";
  input(root, "Framework source editor", JSON.stringify(edited, null, 2));
  click(root, "Download source");
  await tick();
  assert.equal(capture.downloads.length, 1);
  const downloaded = capture.downloads[0];
  assert.equal(downloaded.name, "analysis.ipynb");
  assert.equal(downloaded.blob.type, "application/x-ipynb+json");
  assert.deepEqual(new Uint8Array(await downloaded.blob.arrayBuffer()), new TextEncoder().encode("\uFEFF" + JSON.stringify(edited, null, 2).replace(/\n/g, "\r\n")));
  assert.match(root.textContent, /Downloaded analysis.ipynb · current draft/);
  assert.equal(saved.length, 0);
  const imported = prepareObservableBrowserFiles([], [file("restored/analysis.ipynb", await downloaded.blob.arrayBuffer(), downloaded.blob.type)]);
  assert.deepEqual(JSON.parse(await imported.files[0].blob.text()), edited);
  capture.release(); assert.deepEqual(capture.revoked, [downloaded.url]);
});

it("downloads untouched saved text and binary bytes through the existing exact authorized reader", async t => {
  const capture = captureDownloads(t), reads = [];
  const blobs = new Map([
    ["src/index.md", new Blob(["\uFEFF# Preserved\r\n"], {type: "text/markdown"})],
    ["src/image.png", new Blob([new Uint8Array([137, 80, 78, 71, 0, 255])], {type: "image/png"})]
  ]);
  const {root, saved} = editor({revision: {currentRevisionId: "revision", currentRevisionNumber: 3}, adapter: {
    listObservableSourceRevisions: async () => [{id: "revision", revisionNumber: 3, title: "Exact source", entryPath: "src/index.md", lockfilePath: null,
      files: await savedSourceFiles(blobs)}],
    readObservableSourceRevisionFile: async (...args) => {reads.push(args.slice(0, 4)); return {blob: blobs.get(args[3])};}
  }});
  click(root, "Reload saved draft"); await tick(); await tick();
  click(root, "Download source");
  await until(() => capture.downloads.length === 1, "Exact saved text download completed");
  assert.equal(capture.downloads[0].blob, blobs.get("src/index.md"));
  assert.equal(capture.downloads[0].name, "index.md");
  input(root, "Framework source file", "src/image.png");
  assert.equal(reads.length, 1, "Selecting the binary file does not read its bytes");
  click(root, "Download source");
  await until(() => capture.downloads.length === 2, "Exact saved binary download completed");
  assert.deepEqual(reads, [["project", "source", "revision", "src/index.md"], ["project", "source", "revision", "src/image.png"]]);
  assert.equal(capture.downloads[1].blob, blobs.get("src/image.png"));
  assert.equal(capture.downloads[1].name, "image.png");
  assert.match(root.textContent, /Downloaded src\/image.png · saved revision 3/);
  assert.equal(saved.length, 0);
  capture.release(); assert.equal(capture.revoked.length, 2);
});

it("rejects delayed source downloads after selection changes or disposal and permits retry after a read failure", async t => {
  const capture = captureDownloads(t);
  let finish, fail = true;
  const blobs = new Map([["index.md", new Blob(["# Source"], {type: "text/markdown"})],
    ["image.png", new Blob(["image"], {type: "image/png"})]]);
  const {root, saved} = editor({revision: {currentRevisionId: "revision", currentRevisionNumber: 1}, adapter: {
    listObservableSourceRevisions: async () => [{id: "revision", revisionNumber: 1, title: "Source", entryPath: "index.md", lockfilePath: null,
      files: await savedSourceFiles(blobs)}],
    readObservableSourceRevisionFile: async (_project, _source, _revision, path) => {
      if (path === "index.md") return {blob: new Blob(["# Source"], {type: "text/markdown"})};
      if (fail) throw Error("Access denied");
      return new Promise(resolve => {finish = resolve;});
    }
  }});
  click(root, "Reload saved draft"); await tick(); await tick();
  input(root, "Framework source file", "image.png"); click(root, "Download source"); await tick();
  assert.match(root.textContent, /Could not download image.png/);
  assert.equal(capture.downloads.length, 0);
  fail = false; click(root, "Download source");
  await until(() => finish, "Saved source download pending");
  input(root, "Framework source file", "index.md");
  finish({blob: new Blob(["image"], {type: "image/png"})}); await tick();
  assert.equal(capture.downloads.length, 0);
  click(root, "Reload saved draft"); await tick(); await tick();
  finish = null;
  input(root, "Framework source file", "image.png"); click(root, "Download source");
  await until(() => finish, "Second saved source download pending");
  root.remove(); finish({blob: new Blob(["image"], {type: "image/png"})}); await tick();
  assert.equal(capture.downloads.length, 0);
  assert.equal(saved.length, 0);
});

it("downloads the complete current source project and reimports its exact extracted source files without saving or building", async t => {
  const capture = captureDownloads(t), referenceReads = [];
  let builds = 0;
  const references = {revision: 7, references: [
    {path: "src/maps/pinned.html", artifact_id: "00000000-0000-4000-8000-000000000071", mode: "pinned", version: 2},
    {path: "src/maps/current.html", artifact_id: "00000000-0000-4000-8000-000000000072", mode: "current", version: null}
  ]};
  const {root, saved} = editor({adapter: {
    readPublicationArtifactReferences: async (...args) => {referenceReads.push(args); return references;},
    createObservableBuildJob: async () => {builds++;}
  }});
  const original = new Map([
    ["src/index.md", new TextEncoder().encode("\uFEFF# Original\r\n")],
    ["src/notes.md", new TextEncoder().encode("\uFEFF# Untouched\r\n")],
    ["src/plot.png", new Uint8Array([137, 80, 78, 71, 0, 255, 11])],
    ["package-lock.json", new TextEncoder().encode('{"lockfileVersion":3,"packages":{}}\n')]
  ]);
  selectDirectory(root, [...original].map(([path, bytes]) => file(`atlas/${path}`, bytes)));
  await until(() => root.querySelector('[aria-label="Framework source editor"]').value === "# Original\n", "Source opened");
  input(root, "Framework source editor", "# Edited\n");
  input(root, "Source publication rights", "approved");
  assert.equal(referenceReads.length, 0, "Opening and editing does not load saved Artifact references");
  click(root, "Download source project");
  await until(() => capture.downloads.length === 1, root.textContent);
  const downloaded = capture.downloads[0];
  assert.equal(downloaded.name, "atlas-source.zip");
  assert.equal(downloaded.blob.type, "application/zip");
  const entries = unzipSync(new Uint8Array(await downloaded.blob.arrayBuffer()));
  const manifest = JSON.parse(new TextDecoder().decode(entries["opengeo-source-project.json"]));
  assert.equal(manifest.schemaVersion, "opengeo.publication-source-export.1.0.0");
  assert.equal(manifest.content, "working-draft");
  assert.equal(manifest.baseRevision, null);
  assert.deepEqual(manifest.metadata, {projectId: "project", sourceProjectId: "source", siteId: "site", routeNamespace: "atlas",
    title: "Atlas source", entryPath: "src/index.md", lockfilePath: "package-lock.json", rightsStatus: "approved",
    changeSummary: "Update draft", buildPolicy: {frameworkVersion: "1.13.4", compilerImageDigest: "digest", networkPolicy: "deny"}});
  assert.deepEqual(manifest.artifactReferences, {bundled: false, references});
  assert.deepEqual(manifest.dataAttachments, []);
  original.set("src/index.md", new TextEncoder().encode("\uFEFF# Edited\r\n"));
  assert.deepEqual(Object.keys(entries).filter(path => path.startsWith("source/")).sort(), [...original.keys()].map(path => `source/${path}`).sort());
  const restored = prepareObservableBrowserFiles([], manifest.files.map(record => {
    assert.deepEqual(entries[record.archivePath], original.get(record.path), record.path);
    assert.equal(record.sizeBytes, original.get(record.path).byteLength);
    assert.match(record.checksumSha256, /^[a-f0-9]{64}$/);
    return file(`restored/${record.path}`, entries[record.archivePath], record.contentType);
  }));
  assert.equal(restored.files.length, original.size);
  for (const record of restored.files) assert.deepEqual(new Uint8Array(await record.blob.arrayBuffer()), original.get(record.relativePath));
  assert.match(new TextDecoder().decode(entries["README.txt"]), /not a complete offline, workspace, or account backup/);
  assert.deepEqual(referenceReads, [["project", "source"]]);
  assert.equal(saved.length, 0); assert.equal(builds, 0);
  capture.release(); assert.deepEqual(capture.revoked, [downloaded.url]);
});

it("downloads saved source files once and retains original revision and unbundled attachment pins", async t => {
  const capture = captureDownloads(t), reads = [];
  const binding = {attachmentId: archiveRecord.id, relativePath: "src/data/water.geojson"};
  const pin = {path: binding.relativePath, attachmentId: binding.attachmentId, datasetId: archiveRecord.datasetId,
    datasetVersionId: archiveRecord.datasetVersionId, dataObjectId: archiveRecord.dataObjectId,
    s3VersionId: "retained-object-version", checksumSha256: archiveRecord.checksumSha256,
    sizeBytes: archiveRecord.sizeBytes, contentType: archiveRecord.contentType};
  const blobs = new Map([
    ["src/index.md", new Blob(["\uFEFF# Saved source\r\n"], {type: "text/markdown"})],
    ["src/notes.md", new Blob(["# Original notes\r\n"], {type: "text/markdown"})],
    ["src/image.png", new Blob([new Uint8Array([137, 80, 78, 71, 0, 255])], {type: "image/png"})]
  ]);
  const revision = {id: "revision", revisionNumber: 3, title: "Saved tree", rightsStatus: "unreviewed",
    entryPath: "src/index.md", lockfilePath: null, dataAttachments: [binding], manifestChecksumSha256: "b".repeat(64),
    manifest: {schemaVersion: "opengeo.observable-source-revision.2.0.0", dataAttachments: [pin]},
    files: await savedSourceFiles(blobs)};
  const {root, saved} = editor({revision: {currentRevisionId: "revision", currentRevisionNumber: 3}, adapter: {
    listObservableSourceRevisions: async () => [revision],
    readObservableSourceRevisionFile: async (...args) => {reads.push(args.slice(0, 4)); return {blob: blobs.get(args[3])};}
  }});
  click(root, "Reload saved draft");
  await until(() => root.querySelector('[aria-label="Framework source editor"]').value === "# Saved source\n", "Saved source opened");
  assert.deepEqual(reads.map(args => args[3]), ["src/index.md"]);
  input(root, "Framework source editor", "# Current draft\n");
  click(root, "Download source project");
  await until(() => capture.downloads.length === 1, root.textContent);
  const entries = unzipSync(new Uint8Array(await capture.downloads[0].blob.arrayBuffer()));
  const manifest = JSON.parse(new TextDecoder().decode(entries["opengeo-source-project.json"]));
  assert.deepEqual(reads, ["src/index.md", "src/notes.md", "src/image.png"].map(path => ["project", "source", "revision", path]));
  assert.deepEqual(manifest.baseRevision, {purpose: "original-context-only", revision});
  assert.equal(manifest.content, "working-draft");
  assert.deepEqual(manifest.dataAttachments, [{...binding, bundled: false, pinDetails: "retained-base-revision", pin}]);
  assert.equal(entries[`source/${binding.relativePath}`], undefined, "Reference metadata does not materialize external data");
  assert.equal(manifest.artifactReferences, null);
  assert.deepEqual(entries["source/src/index.md"], new TextEncoder().encode("\uFEFF# Current draft\r\n"));
  assert.deepEqual(entries["source/src/notes.md"], new Uint8Array(await blobs.get("src/notes.md").arrayBuffer()));
  assert.deepEqual(entries["source/src/image.png"], new Uint8Array(await blobs.get("src/image.png").arrayBuffer()));
  assert.match(root.textContent, /Saved map reference metadata is unavailable/);
  assert.equal(saved.length, 0); capture.release();
});

it("downloads no partial source archive after a read failure and retries without rereading successful files", async t => {
  const capture = captureDownloads(t), reads = [];
  let fail = true;
  const blobs = new Map([["index.md", new Blob(["# Retained draft"], {type: "text/markdown"})],
    ["notes.md", new Blob(["# Cached notes"], {type: "text/markdown"})],
    ["image.png", new Blob([new Uint8Array([0, 255, 7])], {type: "image/png"})]]);
  const {root, saved} = editor({revision: {currentRevisionId: "revision", currentRevisionNumber: 1}, adapter: {
    listObservableSourceRevisions: async () => [{id: "revision", revisionNumber: 1, title: "Saved source", entryPath: "index.md", lockfilePath: null,
      files: await savedSourceFiles(blobs)}],
    readObservableSourceRevisionFile: async (...args) => {
      reads.push(args[3]);
      if (args[3] === "image.png" && fail) throw Error("Access denied");
      return {blob: blobs.get(args[3])};
    }
  }});
  click(root, "Reload saved draft");
  await until(() => root.querySelector('[aria-label="Framework source editor"]').value === "# Retained draft", "Saved draft opened");
  click(root, "Download source project");
  await until(() => root.textContent.includes("No partial archive was downloaded"), root.textContent);
  assert.equal(capture.downloads.length, 0);
  assert.equal(root.querySelector('[aria-label="Framework source editor"]').value, "# Retained draft");
  assert.deepEqual(reads, ["index.md", "notes.md", "image.png"]);
  fail = false; click(root, "Download source project");
  await until(() => capture.downloads.length === 1, root.textContent);
  assert.deepEqual(reads, ["index.md", "notes.md", "image.png", "image.png"]);
  assert.equal(Object.keys(unzipSync(new Uint8Array(await capture.downloads[0].blob.arrayBuffer()))).filter(path => path.startsWith("source/")).length, 3);
  assert.equal(saved.length, 0); capture.release();
});

it("cancels pending source-project downloads when the draft, rights, file selection or mounted workspace changes", async t => {
  const capture = captureDownloads(t);
  for (const change of ["draft", "rights", "selection", "disposal"]) {
    let finish, referenceReads = 0;
    const {root, saved} = editor({adapter: {readPublicationArtifactReferences: () => {
      referenceReads++; return new Promise(resolve => {finish = resolve;});
    }}});
    selectDirectory(root, [file("atlas/index.md", "# Retain this"), file("atlas/notes.md", "# Notes")]);
    await until(() => root.querySelector('[aria-label="Framework source editor"]').value === "# Retain this", `${change}: source opened`);
    click(root, "Download source project");
    await until(() => finish, `${change}: reference read pending`);
    if (change === "draft") input(root, "Framework source editor", "# Newer edit");
    if (change === "rights") input(root, "Source publication rights", "rejected");
    if (change === "selection") input(root, "Framework source file", "notes.md");
    if (change === "disposal") root.remove();
    finish({revision: 0, references: []}); await tick(); await tick();
    assert.equal(capture.downloads.length, 0, change);
    assert.equal(referenceReads, 1, change);
    assert.equal(saved.length, 0, change);
    if (change !== "disposal") assert.match(root.textContent, /source project changed/i, change);
    if (change === "draft") assert.equal(root.querySelector('[aria-label="Framework source editor"]').value, "# Newer edit");
    root.remove();
  }
});

it("source export estimates bounded bytes before reads and preserves explicit transport selection", async () => {
  const blob = new Blob(['# Exact source'], {type: 'text/markdown'});
  const [expected] = await savedSourceFiles(new Map([['index.md', blob]]));
  assert.deepEqual(planPublicationSourceDownload([{...expected, blob}]), {
    fileCount: 1, totalBytes: blob.size, transferBytes: 0, fileReads: 0
  });
  assert.deepEqual(planPublicationSourceDownload([expected]), {
    fileCount: 1, totalBytes: blob.size, transferBytes: blob.size, fileReads: 1
  });
  for (const files of [[{...expected, sizeBytes: 4_194_305}],
    [{...expected, sizeBytes: undefined}], Array.from({length: 5}, () => ({...expected, sizeBytes: 4_194_304}))]) {
    assert.throws(() => planPublicationSourceDownload(files));
  }
  const calls = [], adapter = {
    readObservableSourceRevisionFile: async (...args) => {calls.push(['get', ...args]); return {blob};},
    readObservableSourceRevisionFileDirect: async (...args) => {calls.push(['direct', ...args]); throw Object.assign(Error('Denied'), {status: 403});}
  };
  const compatible = createPublicationSourceDownloadReader({adapter, projectId: 'project',
    sourceProjectId: 'source', sourceRevisionId: 'revision'});
  assert.equal(await compatible.readFile({...expected}), blob);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'get');
  const direct = createPublicationSourceDownloadReader({adapter, projectId: 'project',
    sourceProjectId: 'source', sourceRevisionId: 'revision', transport: 'direct-s3-v1'});
  await assert.rejects(direct.readFile({...expected}), {status: 403});
  assert.deepEqual(calls.map(call => call[0]), ['get', 'direct'], 'An authorization failure never invokes compatibility fallback');
  const changed = createPublicationSourceDownloadReader({adapter: {
    readObservableSourceRevisionFile: async () => ({blob: new Blob(['# Wrong source'], {type: 'text/markdown'})})
  }, projectId: 'project', sourceProjectId: 'source', sourceRevisionId: 'revision'});
  await assert.rejects(changed.readFile({...expected}), /size or media changed|checksum changed/);
  assert.equal(await compatible.readFile({...expected, blob}), blob);
  await assert.rejects(compatible.readFile({...expected,
    blob: new Blob(['x'.repeat(blob.size)], {type: blob.type})}), /checksum changed/);
  assert.equal(calls.length, 2, 'Cached saved validation does not reread storage');
});

it("source exports validate cached saved bytes and retain deliberate current edits with BOM and CRLF", async t => {
  const capture = captureDownloads(t), reads = [];
  const original = new Blob(['\uFEFF# Saved source\r\n'], {type: 'text/markdown'});
  const wrong = new Blob(['\uFEFF# Wrong source\r\n'], {type: 'text/markdown'});
  const facts = await savedSourceFiles(new Map([['index.md', original]]));
  const {root, saved} = editor({revision: {currentRevisionId: 'revision', currentRevisionNumber: 1}, adapter: {
    listObservableSourceRevisions: async () => [{id: 'revision', revisionNumber: 1, title: 'Draft',
      entryPath: 'index.md', lockfilePath: null, files: facts}],
    readObservableSourceRevisionFile: async (...args) => {reads.push(args); return {blob: wrong};}
  }});
  click(root, 'Reload saved draft');
  await until(() => root.querySelector('[aria-label="Framework source editor"]').value === '# Wrong source\n', 'Cached saved source opened');
  click(root, 'Download source');
  await until(() => root.textContent.includes('Could not download index.md'), 'Wrong saved checksum rejected');
  assert.equal(capture.downloads.length, 0);
  input(root, 'Framework source editor', '# Current edit\n');
  click(root, 'Download source');
  await until(() => capture.downloads.length === 1, 'Current edit downloaded');
  assert.deepEqual(new Uint8Array(await capture.downloads[0].blob.arrayBuffer()),
    new TextEncoder().encode('\uFEFF# Current edit\r\n'));
  assert.equal(reads.length, 1, 'Cached validation and current edits do not reread storage');
  assert.equal(saved.length, 0);
  assert.match(root.textContent, /current draft/);
  capture.release(); root.remove();
});

it("source export cancellation stops late compatible reads without changing drafts or activating tickets", async t => {
  const capture = captureDownloads(t), calls = [];
  let finish, transferSignal;
  const blobs = new Map([['index.md', new Blob(['# Owner draft'], {type: 'text/markdown'})],
    ['image.png', new Blob([new Uint8Array([1, 2, 3])], {type: 'image/png'})]]);
  const facts = await savedSourceFiles(blobs);
  const {root, saved} = editor({revision: {currentRevisionId: 'revision', currentRevisionNumber: 1}, adapter: {
    listObservableSourceRevisions: async () => [{id: 'revision', revisionNumber: 1, title: 'Draft',
      entryPath: 'index.md', lockfilePath: null, files: facts}],
    readObservableSourceRevisionFile: async (_project, _source, _revision, path, options) => {
      calls.push(path);
      if (path === 'image.png') transferSignal = options?.signal;
      return path === 'index.md' ? {blob: blobs.get(path)} : new Promise(resolve => {finish = resolve;});
    },
    readObservableSourceRevisionFileDirect: async () => {throw Error('Undeployed ticket endpoint must not be called');}
  }});
  click(root, 'Reload saved draft');
  await until(() => root.querySelector('[aria-label="Framework source editor"]').value === '# Owner draft', 'Draft opened');
  assert.match(root.textContent, /2 files .*1 unloaded file reads/);
  assert.match(root.textContent, /S3\/KMS charges; actual charges are unknown/);
  assert.deepEqual(calls, ['index.md'], 'Showing an estimate does not fetch unopened source bytes');
  input(root, 'Framework source file', 'image.png'); click(root, 'Download source');
  await until(() => finish, 'Compatible saved source GET pending');
  click(root, 'Cancel download');
  assert.equal(transferSignal.aborted, true, 'Cancel reaches the compatible HTTP reader');
  await until(() => ![...root.querySelectorAll('button')].find(b => b.textContent === 'Download source').disabled, 'Cancel releases controls');
  finish({blob: blobs.get('image.png')}); await tick();
  assert.equal(capture.downloads.length, 0);
  assert.match(root.textContent, /Download cancelled. Your working draft is unchanged/);
  finish = null; click(root, 'Download source'); await until(() => finish, 'Explicit retry pending');
  finish({blob: blobs.get('image.png')}); await until(() => capture.downloads.length === 1, root.textContent);
  assert.deepEqual(calls, ['index.md', 'image.png', 'image.png']);
  assert.equal(saved.length, 0); capture.release(); assert.equal(capture.revoked.length, 1);
});

it("source exports reject account and saved-version changes before any late download", async t => {
  const capture = captureDownloads(t);
  for (const change of ['account', 'user', 'version']) {
    let account = 'original-account', finish;
    const blobs = new Map([['index.md', new Blob(['# Private draft'], {type: 'text/markdown'})],
      ['image.png', new Blob(['image'], {type: 'image/png'})]]);
    const facts = await savedSourceFiles(blobs);
    const {root, saved, state} = editor({revision: {currentRevisionId: 'revision', currentRevisionNumber: 1}, adapter: {
      tokenProvider: () => 'token', organizationProvider: () => account,
      listObservableSourceRevisions: async () => [{id: 'revision', revisionNumber: 1, title: 'Draft',
        entryPath: 'index.md', lockfilePath: null, files: facts}],
      readObservableSourceRevisionFile: async (_project, _source, _revision, path) => path === 'index.md'
        ? {blob: blobs.get(path)} : new Promise(resolve => {finish = resolve;})
    }});
    click(root, 'Reload saved draft');
    await until(() => root.querySelector('[aria-label="Framework source editor"]').value === '# Private draft', `${change}: draft opened`);
    input(root, 'Framework source file', 'image.png'); click(root, 'Download source');
    await until(() => finish, `${change}: saved source GET pending`);
    if (change === 'account') account = 'other-account';
    if (change === 'user') state.session = {userId: 'other-user'};
    if (change === 'version') state.observableSourceProjects[0].currentRevisionId = 'new-version';
    finish({blob: blobs.get('image.png')}); await tick(); await tick();
    assert.equal(capture.downloads.length, 0, change);
    assert.match(root.textContent, /Could not download image.png/, change);
    assert.equal(saved.length, 0, change); root.remove();
  }
});

it("retains archived data bindings when reopening and committing a saved revision", async () => {
  const binding = {attachmentId: "00000000-0000-4000-8000-000000000087", relativePath: "src/data/water.geojson"};
  const {root, saved} = editor({revision: {currentRevisionId: "revision", currentRevisionNumber: 2}, adapter: {
    listObservableSourceRevisions: async () => [{id: "revision", revisionNumber: 2, title: "Archive-backed source",
      entryPath: "src/index.md", lockfilePath: null, dataAttachments: [binding],
      files: [{relativePath: "src/index.md", contentType: "text/markdown"}]}],
    readObservableSourceRevisionFile: async () => ({blob: new Blob(["# Archive-backed source\n"])})
  }});
  [...root.querySelectorAll("button")].find(item => item.textContent === "Reload saved draft").click();
  await tick(); await tick();
  assert.match(root.textContent, /Linked files: src\/data\/water.geojson/);
  root.querySelector("textarea").value = "# Edited archive-backed source\n";
  [...root.querySelectorAll("button")].find(item => item.textContent === "Save draft").click();
  await tick();
  assert.deepEqual(saved[0][2].dataAttachments, [binding]);
  assert.equal(saved[0][2].files.length, 1, "The archive is a reference, not an uploaded source blob");
});

function click(root, name) { [...root.querySelectorAll("button")].find(item => item.textContent === name).click(); }

it("retains public file references through editor reopen and save and refuses incomplete ZIPs", async t => {
  const capture = captureDownloads(t), binding = {referenceId: "00000000-0000-4000-8000-000000000089", relativePath: "src/data/original.tif"};
  let reads = 0;
  const {root, saved} = editor({revision: {currentRevisionId: "revision", currentRevisionNumber: 2}, adapter: {
    listObservableSourceRevisions: async () => [{id: "revision", revisionNumber: 2, title: "Public TIFF source",
      entryPath: "src/index.md", lockfilePath: null, dataAttachments: [], referencedFiles: [binding],
      files: [{relativePath: "src/index.md", contentType: "text/markdown"}]}],
    readObservableSourceRevisionFile: async () => {reads++; return {blob: new Blob(["# Public TIFF source\n"])};}
  }});
  click(root, "Reload saved draft"); await tick(); await tick();
  assert.match(root.textContent, /Connected public files: src\/data\/original.tif/);
  assert.match(root.textContent, /Live preview reads each source once and reuses its verified bytes\. Saving retains references/);
  const readsBefore = reads;
  for (const command of ["Download complete input backup", "Download source project"]) {
    click(root, command); await tick(); await tick();
    assert.match(root.textContent, /Project ZIP export for connected public files is not available yet/);
  }
  assert.equal(capture.downloads.length, 0);
  assert.equal(reads, readsBefore, "an unsupported backup cannot start additional reads");
  input(root, "Framework source editor", "# Edited source\n");
  click(root, "Save draft"); await tick(); await tick();
  assert.deepEqual(saved[0][2].referencedFiles, [binding]);
  assert.equal(saved[0][2].files.length, 1, "public data is metadata, not an uploaded source blob");
});

it("public Catalog file editor connects, inserts and saves an exact TIFF alias without reading data or building", async () => {
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const resource = {id: uuid(90), projectId: uuid(91), datasetId: uuid(92), currentVersionId: uuid(93),
    kind: "dataset", state: "published", versionNumber: 4, title: "Elevation source",
    provenance: {externalSourceVersion: 2, externalSourceUrl: "https://public.example.test/elevation.tif"},
    metadataExtensions: {opengeo: {schemaVersion: "1.3.0", distributions: [{identifier: "original",
      downloadUrl: "https://public.example.test/elevation.tif", mediaType: "image/tiff", byteSize: 8, checksumSha256: "a".repeat(64)}]}}};
  const record = {id: uuid(94), sourceProjectId: "source", datasetId: resource.datasetId, sourceVersion: 2,
    resourceId: resource.id, resourceVersionId: resource.currentVersionId, resourceVersionNumber: 4, distributionId: "original",
    url: resource.provenance.externalSourceUrl, contentType: "image/tiff", sizeBytes: 8, checksumSha256: "a".repeat(64),
    available: true, kind: "referenced-public-file", custody: "referenced"};
  let registered = false, bodyReads = 0, builds = 0;
  const writes = [], metadataReads = [];
  const dataset = {id: resource.datasetId, name: "Elevation", status: "active", sourceType: "cog", format: "cog",
    capabilities: {read: true, download: false}};
  const {root, saved, state} = editor({revision: {currentRevisionId: "revision", currentRevisionNumber: 2}, adapter: {
    listObservableSourceRevisions: async () => [{id: "revision", revisionNumber: 2, title: "TIFF analysis", entryPath: "src/index.md",
      lockfilePath: null, dataAttachments: [{attachmentId: archiveRecord.id, relativePath: "src/data/water.geojson"}],
      files: [{relativePath: "src/index.md", contentType: "text/markdown"}, {relativePath: "package.json", contentType: "application/json"}]}],
    readObservableSourceRevisionFile: async (_project, _source, _revision, path) => ({blob: new Blob([
      path === "package.json" ? '{"type":"module"}' : "# TIFF analysis\n"])}),
    listObservableDataAttachments: async () => [archiveRecord], listObservablePublicFileReferences: async () => registered ? [record] : [],
    listDatasetVersions: async () => [], registerObservableDataAttachment: async () => {throw Error("No archive write expected");},
    searchDatasets: async () => [dataset], attachDataset: async (...args) => {writes.push(["link", ...args]); return dataset;},
    listDatasetResources: async () => [resource], getResource: async (...args) => {metadataReads.push(args); return resource;},
    registerObservablePublicFileReference: async (...args) => {writes.push(["reference", ...args]); registered = true; return record;},
    requestDatasetDownload: async () => {bodyReads++; throw Error("No data read expected");},
    requestObservableBuild: async () => {builds++; throw Error("No build expected");}
  }});
  click(root, "Reload saved draft"); await tick(); await tick();
  const data = root.querySelector('.framework-revision-data');
  click(data, "Search Catalog"); await tick();
  input(data, "Dataset", resource.datasetId); await tick();
  input(data, "Catalog metadata record", resource.id); await tick();
  input(data, "Public source file", "original");
  assert.equal(writes.length, 0, "selection is read-only");
  click(data, "Link dataset and use file"); await tick(); await tick();
  assert.deepEqual(metadataReads, [[resource.projectId, resource.id]], "metadata stays in its original workspace");
  assert.deepEqual(writes[1], ["reference", "project", "source", {datasetId: resource.datasetId, sourceVersion: 2,
    resourceId: resource.id, resourceVersionId: resource.currentVersionId, distributionId: "original"}]);
  assert.equal(saved.length, 0);
  assert.equal(data.querySelector('[aria-label="FileAttachment path"]').value, "src/data/elevation.tif");
  click(data, "Insert file");
  assert.match(root.querySelector('[aria-label="Framework source editor"]').value, /FileAttachment\("(?:\.\/)?data\/elevation\.tif"\)\.arrayBuffer\(\)/);
  assert.match(root.textContent, /Connected public files: src\/data\/elevation.tif/);
  data.querySelector('[aria-label="Insert FileAttachment for src/data/elevation.tif"]').click();
  assert.equal(data.querySelectorAll('[aria-label="Source file path 1"]').length, 1, "inserting code reuses the alias");
  click(root, "Save draft"); await tick(); await tick();
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0][2].referencedFiles, [{referenceId: record.id, relativePath: "src/data/elevation.tif"}]);
  assert.deepEqual(saved[0][2].dataAttachments, [{attachmentId: archiveRecord.id, relativePath: "src/data/water.geojson"}]);
  assert.equal(saved[0][2].files.length, 2, "only the authored page and package metadata are saved");
  assert.deepEqual([bodyReads, builds], [0, 0]);
  root.remove();
  assert.equal(state.project.id, "project");
});

it("public Catalog file editor validates shared paths and size and preserves removed aliases for undo", async () => {
  const referenceId = "00000000-0000-4000-8000-000000000095";
  const record = {id: referenceId, kind: "referenced-public-file", available: true, filename: "elevation.tif",
    contentType: "image/tiff", sizeBytes: 50 * 1024 * 1024};
  let references = [{referenceId, relativePath: "src/data/elevation.tif"}];
  let archives = [{attachmentId: archiveRecord.id, relativePath: "src/data/water.geojson"}];
  const state = {project: {id: "project"}, adapter: {listObservableDataAttachments: async () => [archiveRecord],
    listObservablePublicFileReferences: async () => [record]}};
  const files = [{relativePath: "src/index.md"}];
  const data = FrameworkRevisionData({state, sourceProject: {id: "source"}, getBindings: () => archives,
    getReferencedFiles: () => references, getFiles: () => files, isLocked: () => false,
    onChange: value => {archives = value;}, onReferencesChange: value => {references = value;}});
  document.body.append(data.element);
  await assert.rejects(data.prepareCommit(archives), /exceed 64 MiB/);
  click(data.element, "Remove path"); // remove archived alias, not the Catalog file
  assert.equal(archives.length, 0);
  await data.prepareCommit(archives);
  const rename = data.element.querySelector('[aria-label="Source file path 1"]');
  rename.value = "SRC/INDEX.md"; rename.dispatchEvent(new dom.window.Event("input"));
  assert.equal(rename.getAttribute("aria-invalid"), "true");
  rename.value = "src/data/elevation.tif"; rename.dispatchEvent(new dom.window.Event("input"));
  click(data.element, "Remove path");
  assert.equal(references.length, 0);
  click(data.element, "Undo removal");
  assert.deepEqual(references, [{referenceId, relativePath: "src/data/elevation.tif"}]);
  assert.throws(() => appendObservableMarkdownPage(files, {relativePath: "src/data/elevation.tif/page.md", title: "Page", referencedFiles: references}), /conflicts/);
  assert.throws(() => appendObservableMarkdownPage(files, {relativePath: "src/new.md", title: "Page",
    referencedFiles: Array.from({length: 127}, (_, n) => ({relativePath: `src/data/file-${n}.tif`}))}), /128 files/);
  data.element.remove();
});

it("public Catalog file editor discards late inventory after an account change", async () => {
  let finish;
  const state = {project: {id: "project"}, session: {userId: "owner"}, adapter: {
    listObservableDataAttachments: async () => [], listObservablePublicFileReferences: () => new Promise(resolve => {finish = resolve;})}};
  const data = FrameworkRevisionData({state, sourceProject: {id: "source"}, getBindings: () => [], getReferencedFiles: () => [],
    getFiles: () => [], isLocked: () => false, onChange() {}, onReferencesChange() {}});
  document.body.append(data.element); click(data.element, "Load registered files"); await tick();
  state.session = {userId: "other"}; finish([{id: "late", kind: "referenced-public-file", filename: "private.tif", contentType: "image/tiff", sizeBytes: 8, available: true}]);
  await tick();
  assert.doesNotMatch(data.element.textContent, /private.tif/);
  data.element.remove();
});

it("public Catalog file editor rejects a saved draft arriving after account changes without reading its entry", async () => {
  let finish, reads = 0;
  const {root, state} = editor({revision: {currentRevisionId: "revision", currentRevisionNumber: 2}, adapter: {
    listObservableSourceRevisions: () => new Promise(resolve => {finish = resolve;}),
    readObservableSourceRevisionFile: async () => {reads++; throw Error("Stale entry read");}
  }});
  click(root, "Reload saved draft"); await tick();
  state.session = {userId: "other"};
  finish([{id: "revision", revisionNumber: 2, title: "Other account private source", entryPath: "src/index.md", lockfilePath: null,
    referencedFiles: [{referenceId: "00000000-0000-4000-8000-000000000096", relativePath: "src/data/private.tif"}],
    files: [{relativePath: "src/index.md", contentType: "text/markdown"}]}]);
  await tick();
  assert.equal(reads, 0);
  assert.doesNotMatch(root.textContent, /Connected public files: src\/data\/private.tif/);
  root.remove();
});

it("commits explicit publication rights without changing or reuploading saved source files", async () => {
  const original = new Blob(["<h1>Invented CC0 sample</h1>"], {type: "text/html"});
  const revision = {id: "revision", revisionNumber: 2, title: "Sample", rightsStatus: "unreviewed",
    entryPath: "index.html", lockfilePath: null, dataAttachments: [],
    files: [{relativePath: "index.html", contentType: "text/html", sourceObjectId: "existing-object"}]};
  const {root, saved} = editor({revision: {currentRevisionId: "revision", currentRevisionNumber: 2}, adapter: {
    listObservableSourceRevisions: async () => [revision],
    readObservableSourceRevisionFile: async () => ({blob: original})
  }});
  click(root, "Reload saved draft"); await tick(); await tick();
  const rights = root.querySelector('[aria-label="Source publication rights"]');
  assert.equal(rights.value, "unreviewed", "Opening a draft must not approve it");
  rights.value = "approved";
  click(root, "Save draft"); await tick(); await tick();
  assert.equal(saved.length, 1);
  assert.equal(saved[0][2].rightsStatus, "approved");
  assert.equal(saved[0][2].expectedRevision, 2);
  assert.equal(saved[0][2].files[0].blob, original);
  assert.equal(saved[0][2].reuseRevision.id, "revision");
});

it("offers an import review for native notebook source without rewriting or uploading it", async () => {
  for (const [path, type, source] of [
    ['index.html', 'text/html', '<!doctype html><notebook><script id="1" type="module">const value = 7;</script></notebook>'],
    ['index.ipynb', 'application/x-ipynb+json', '{"nbformat":4,"nbformat_minor":5,"metadata":{},"cells":[]}']
  ]) {
    const original = file(`atlas/${path}`, source, type);
    const {root, saved} = editor();
    selectDirectory(root, [original]); await tick(); await tick();
    const review = root.querySelector('.notebook-import-review');
    assert.equal(review.hidden, false);
    assert.match(review.textContent, /Review notebook import/);
    assert.equal(root.querySelector('[aria-label="Framework source editor"]').value, source);
    assert.equal(await original.text(), source);
    assert.equal(saved.length, 0);
    root.remove();
  }
});
function input(root, name, value) {
  const control = root.querySelector(`[aria-label="${name}"]`);
  control.value = value;
  control.dispatchEvent(new dom.window.Event(control.tagName === "SELECT" ? "change" : "input"));
  return control;
}
async function loadArchive(root) {
  click(root, "Load registered files");
  await tick();
  input(root, "Registered archive file", archiveRecord.id);
}

it("adds and edits a Markdown page through the interface, preserving the unsaved current page until explicit commit", async () => {
  const {root, saved} = editor();
  selectDirectory(root, [file("atlas/src/index.md", "# Home")]);
  await tick();
  input(root, "Framework source editor", "# Edited home");
  const setLabeled = (name, value) => {
    const label = [...root.querySelectorAll("label")].find(item => item.querySelector("span")?.textContent === name);
    label.querySelector("input").value = value;
  };
  setLabeled("New page source path", "src/field-labs/noaa.md");
  setLabeled("New page title", "NOAA field lab");
  click(root, "Add page to working revision");
  await tick();
  assert.equal(saved.length, 0);
  assert.equal(root.querySelector('[aria-label="Framework source file"]').value, "src/field-labs/noaa.md");
  input(root, "Framework source editor", "# NOAA field lab\n\nSource and archive details.");
  click(root, "Save draft");
  await tick();
  assert.equal(saved.length, 1);
  const committed = saved[0][2].files;
  assert.equal(await committed.find(item => item.relativePath === "src/index.md").blob.text(), "# Edited home");
  assert.match(await committed.find(item => item.relativePath === "src/field-labs/noaa.md").blob.text(), /Source and archive details/);
});

it("inserts a registered file and preserves authored text through path edits without writing before save", async () => {
  let reads = 0;
  const {root, saved} = editor({adapter: {listObservableDataAttachments: async () => { reads++; return [archiveRecord]; }}});
  selectDirectory(root, [file("atlas/src/index.md", "# Home")]);
  await tick();
  assert.equal(reads, 0);
  input(root, "Framework source editor", "# Unsaved edit");
  await loadArchive(root);
  assert.equal(reads, 1);
  input(root, "FileAttachment path", "src/data/water.geojson");
  click(root, "Insert file");
  assert.equal(saved.length, 0);
  const linkedSource = root.querySelector("textarea").value;
  assert.match(linkedSource, /# Unsaved edit/);
  assert.match(linkedSource, /const data_water = await FileAttachment\("data\/water\.geojson"\)\.json\(\);/);
  input(root, "Archive file path 1", "src/data/changed.geojson");
  assert.equal(root.querySelector("textarea").value, linkedSource);
  click(root, "Remove path");
  assert.match(root.textContent, /The Catalog file and earlier revisions remain available/);
  click(root, "Undo removal");
  assert.equal(root.querySelector('[aria-label="Archive file path 1"]').value, "src/data/changed.geojson");
  click(root, "Save draft");
  await tick();
  assert.equal(reads, 2, "Commit must recheck availability before uploading authored source");
  assert.deepEqual(saved[0][2].dataAttachments, [{attachmentId: archiveRecord.id, relativePath: "src/data/changed.geojson"}]);
  assert.equal(saved[0][2].files.length, 1);
  assert.equal(await saved[0][2].files[0].blob.text(), linkedSource);
});

it("rejects unsafe paths, collisions, media mismatches and repeated-reference size overflow before upload", async () => {
  const {root, saved} = editor();
  selectDirectory(root, [file("atlas/src/data/a.geojson", "{}")]);
  await tick();
  await loadArchive(root);
  for (const path of ["../water.geojson", "src/processor.js", "package.json", "src/data/A.GEOJSON", "src/data/a.geojson/child.json", "src/data/water.csv"]) {
    input(root, "FileAttachment path", path);
    click(root, "Insert file");
    assert.equal(root.querySelectorAll('[aria-label^="Archive file path "]').length, 0, path);
  }
  for (const path of ["src/data/b.geojson", "src/data/c.geojson", "src/data/d.geojson", "src/data/e.geojson"]) {
    input(root, "FileAttachment path", path);
    click(root, "Insert file");
  }
  assert.equal(root.querySelectorAll('[aria-label^="Archive file path "]').length, 3);
  assert.match(root.textContent, /exceed 64 MiB/);
  input(root, "FileAttachment path", "");
  input(root, "Archive file path 1", "src/data/c.geojson");
  click(root, "Save draft");
  await tick();
  assert.equal(saved.length, 0);
  assert.match(root.textContent, /paths must not collide/);
  assert.equal(root.querySelector('[aria-label="Archive file path 1"]').value, "src/data/c.geojson", "Invalid draft text must not disappear");
});

it("retains source and path edits when archive access is withdrawn and can retry after access recovers", async () => {
  let available = true;
  const {root, saved} = editor({adapter: {listObservableDataAttachments: async () => [{...archiveRecord, available}]}});
  selectDirectory(root, [file("atlas/index.md", "# Home")]);
  await tick();
  await loadArchive(root);
  input(root, "FileAttachment path", "water.geojson");
  click(root, "Insert file");
  input(root, "Framework source editor", "# Preserve this draft");
  available = false;
  click(root, "Save draft");
  await tick();
  assert.equal(saved.length, 0);
  assert.match(root.textContent, /archived file is unavailable/);
  assert.equal(root.querySelector("textarea").value, "# Preserve this draft");
  assert.equal(root.querySelector('[aria-label="Archive file path 1"]').disabled, false);
  available = true;
  click(root, "Save draft");
  await tick();
  assert.equal(saved.length, 1);
});

it("locks archive inputs during the commit-time metadata check and ignores a late earlier inventory", async () => {
  let reads = 0, finishCheck, finishOld;
  const {root, saved} = editor({adapter: {listObservableDataAttachments: async () => {
    if (++reads === 1) return [archiveRecord];
    if (reads === 2) return new Promise(resolve => { finishOld = resolve; });
    return new Promise(resolve => { finishCheck = resolve; });
  }}});
  selectDirectory(root, [file("atlas/index.md", "# Home")]);
  await tick();
  await loadArchive(root);
  input(root, "FileAttachment path", "water.geojson");
  click(root, "Insert file");
  click(root, "Reload registered files");
  click(root, "Save draft");
  click(root, "Save draft");
  assert.equal(reads, 3);
  assert.equal(saved.length, 0);
  assert.equal(root.querySelector('[aria-label="Archive file path 1"]').disabled, true);
  finishOld([]);
  await tick();
  assert.equal(root.querySelector('[aria-label="Archive file path 1"]').disabled, true);
  finishCheck([archiveRecord]);
  await tick();
  assert.equal(saved.length, 1);
  assert.equal(saved[0][2].dataAttachments[0].relativePath, "water.geojson");
});

it("retains all draft paths through inventory failures and recovers with an explicit reload", async () => {
  let fail = false;
  const {root} = editor({adapter: {listObservableDataAttachments: async () => {
    if (fail) throw new Error("Unavailable");
    return [archiveRecord];
  }}});
  await loadArchive(root);
  input(root, "FileAttachment path", "data/water.geojson");
  click(root, "Insert file");
  fail = true;
  click(root, "Reload registered files");
  await tick();
  assert.match(root.textContent, /paths and source edits are unchanged/);
  assert.equal(root.querySelector('[aria-label="Archive file path 1"]').value, "data/water.geojson");
  assert.equal(root.querySelector('[aria-label="Registered archive file"]').disabled, true);
  fail = false;
  click(root, "Reload registered files");
  await tick();
  assert.equal(root.querySelector('[aria-label="Registered archive file"]').disabled, false);
});

it("does not discard an unadded archive path when committing or overwrite bindings with a late saved revision", async () => {
  let finish;
  const {root, saved} = editor({revision: {currentRevisionId: "old", currentRevisionNumber: 1}, adapter: {
    listObservableSourceRevisions: async () => [{id: "old", revisionNumber: 1, title: "Old", entryPath: "index.md",
      files: [{relativePath: "index.md", contentType: "text/markdown"}], dataAttachments: []}],
    readObservableSourceRevisionFile: async () => new Promise(resolve => { finish = resolve; })
  }});
  selectDirectory(root, [file("atlas/index.md", "# Current")]);
  await tick();
  await loadArchive(root);
  input(root, "FileAttachment path", "water.geojson");
  click(root, "Save draft");
  await tick();
  assert.equal(saved.length, 0);
  assert.match(root.textContent, /Insert the selected file or clear its name/);
  click(root, "Reload saved draft");
  await tick();
  click(root, "Insert file");
  const insertedSource = root.querySelector("textarea").value;
  assert.match(insertedSource, /# Current/);
  assert.match(insertedSource, /FileAttachment\("water\.geojson"\)/);
  finish({blob: new Blob(["# Old"])});
  await tick();
  assert.equal(root.querySelector("textarea").value, insertedSource);
  assert.equal(root.querySelector('[aria-label="Archive file path 1"]').value, "water.geojson");
  click(root, "Save draft");
  await tick();
  assert.equal(saved[0][2].dataAttachments.length, 1);
});

it("preserves the caret and edited archive path when an inventory response arrives", async () => {
  let finish, reads = 0;
  const {root} = editor({adapter: {listObservableDataAttachments: async () => {
    if (++reads === 1) return [archiveRecord];
    return new Promise(resolve => { finish = resolve; });
  }}});
  await loadArchive(root);
  input(root, "FileAttachment path", "water.geojson");
  click(root, "Insert file");
  click(root, "Reload registered files");
  const path = input(root, "Archive file path 1", "data/renamed.geojson");
  path.focus();
  path.setSelectionRange(5, 12);
  finish([archiveRecord]);
  await tick();
  assert.equal(document.activeElement.value, "data/renamed.geojson");
  assert.equal(document.activeElement.selectionStart, 5);
  assert.equal(document.activeElement.selectionEnd, 12);
});

it("cannot commit an older tree while a newly selected folder's archive verification is pending", async () => {
  let finish, reads = 0;
  const {root, saved} = editor({adapter: {listObservableDataAttachments: async () => {
    if (++reads === 2) return new Promise(resolve => { finish = resolve; });
    return [archiveRecord];
  }}});
  selectDirectory(root, [file("atlas/index.md", "# Old")]);
  await tick();
  await loadArchive(root);
  input(root, "FileAttachment path", "data/water.geojson");
  click(root, "Insert file");
  selectDirectory(root, [file("atlas/index.md", "# Selected")]);
  click(root, "Save draft");
  await tick();
  assert.equal(saved.length, 0);
  assert.match(root.textContent, /wait for the selected folder's archive checks/);
  finish([archiveRecord]);
  await tick(); await tick();
  assert.equal(root.querySelector("textarea").value, "# Selected");
  click(root, "Save draft");
  await tick();
  assert.equal(await saved[0][2].files[0].blob.text(), "# Selected");
});

it("retains the edited working tree after a selected data file fails archive reconciliation", async () => {
  const {root, saved} = editor();
  selectDirectory(root, [file("atlas/index.md", "# Old")]);
  await tick();
  await loadArchive(root);
  input(root, "FileAttachment path", "data/water.geojson");
  click(root, "Insert file");
  input(root, "Framework source editor", "# Keep my edits");
  selectDirectory(root, [file("atlas/index.md", "# Replacement"), file("atlas/data/water.geojson", "{}")] );
  await tick();
  assert.match(root.textContent, /local size does not match/);
  assert.equal(root.querySelector("textarea").value, "# Keep my edits");
  click(root, "Save draft");
  await tick();
  assert.equal(await saved[0][2].files[0].blob.text(), "# Keep my edits");
  assert.equal(saved[0][2].dataAttachments.length, 1);
});

it("preserves the original UTF-8 marker and uniform CRLF endings when text is edited", async () => {
  const {root, saved} = editor();
  selectDirectory(root, [file("atlas/index.md", "\uFEFF# Original\r\n\r\nText\r\n")]);
  await tick();
  root.querySelector("textarea").value = "# Changed\n\nText\n";
  [...root.querySelectorAll("button")].find(b => b.textContent === "Save draft").click();
  await tick();
  assert.deepEqual(new Uint8Array(await saved[0][2].files[0].blob.arrayBuffer()), new TextEncoder().encode("\uFEFF# Changed\r\n\r\nText\r\n"));
});

it("skips an unchanged saved tree, then commits an edit without replacing other binary bytes", async () => {
  const blobs = new Map([
    ["src/index.md", new Blob(["\uFEFF# Saved\r\n"], {type: "text/markdown"})],
    ["src/preview.png", new Blob([new Uint8Array([137, 80, 78, 71])], {type: "image/png"})]
  ]);
  const {root, saved} = editor({revision: {currentRevisionId: "revision", currentRevisionNumber: 3}, adapter: {
    listObservableSourceRevisions: async () => [{id: "revision", revisionNumber: 3, title: "Saved title", entryPath: "src/index.md", lockfilePath: null,
      files: [...blobs].map(([relativePath, blob]) => ({relativePath, contentType: blob.type}))}],
    readObservableSourceRevisionFile: async (_project, _source, _revision, path) => ({blob: blobs.get(path)})
  }});
  [...root.querySelectorAll("button")].find(b => b.textContent === "Reload saved draft").click();
  await tick();
  await tick();
  assert.match(root.textContent, /Saved revision 3 opened/);
  [...root.querySelectorAll("button")].find(b => b.textContent === "Save draft").click();
  await tick();
  assert.equal(saved.length, 0);
  assert.match(root.textContent, /No changes from opened revision 3/);
  assert.equal(root.querySelector("textarea").disabled, false);
  root.querySelector("textarea").value = "# Edited\n";
  [...root.querySelectorAll("button")].find(b => b.textContent === "Save draft").click();
  await tick();
  assert.equal(saved[0][2].expectedRevision, 3);
  assert.equal(saved[0][2].entryPath, "src/index.md");
  assert.equal(saved[0][2].title, "Saved title");
  assert.equal(saved[0][2].files.find(f => f.relativePath === "src/preview.png").blob, blobs.get("src/preview.png"));
  assert.equal(await saved[0][2].files.find(f => f.relativePath === "src/index.md").blob.text(), "# Edited\r\n");
});
function selectDirectory(root, files) {
  const input = root.querySelector("input[webkitdirectory]");
  Object.defineProperty(input, "files", {configurable: true, value: files});
  input.dispatchEvent(new dom.window.Event("change"));
}

it("finds nested pages, preserves drafts across navigation and retains them after invalid selection", async () => {
  const {root, saved} = editor();
  selectDirectory(root, [file("atlas/src/index.md", "Home"), file("atlas/src/methods/transmission-line-analysis.md", "Transmission")]);
  await tick();
  const text = root.querySelector("textarea");
  text.value = "Edited home";
  const search = root.querySelector('[aria-label="Find source file"]');
  search.value = "transmission";
  search.dispatchEvent(new dom.window.Event("input"));
  assert.equal(text.value, "Edited home");
  const select = root.querySelector('[aria-label="Framework source file"]');
  assert.equal([...select.options].filter(o => !o.hidden).length, 1);
  select.value = "src/methods/transmission-line-analysis.md";
  select.dispatchEvent(new dom.window.Event("change"));
  await tick();
  assert.equal(text.value, "Transmission");
  text.value = "Edited transmission";
  selectDirectory(root, [file("atlas/.env", "must not import")]);
  assert.match(root.textContent, /previous working tree has not been replaced/);
  assert.equal(text.value, "Edited transmission");
  [...root.querySelectorAll("button")].find(b => b.textContent === "Save draft").click();
  await tick();
  const draft = saved[0][2];
  assert.equal(draft.entryPath, "src/index.md");
  assert.equal(draft.lockfilePath, null);
  assert.equal(await draft.files[0].blob.text(), "Edited home");
  assert.equal(await draft.files[1].blob.text(), "Edited transmission");
});

it("does not overwrite a pending file with text from the previous editor", async () => {
  const {root, saved} = editor();
  let release;
  const slow = file("atlas/b.md", "Original B");
  slow.text = () => new Promise(resolve => {release = resolve;});
  selectDirectory(root, [file("atlas/a.md", "A"), slow, file("atlas/c.md", "C")]);
  await tick();
  const select = root.querySelector('[aria-label="Framework source file"]');
  select.value = "b.md";
  select.dispatchEvent(new dom.window.Event("change"));
  select.value = "c.md";
  select.dispatchEvent(new dom.window.Event("change"));
  await tick();
  release("Original B");
  await tick();
  assert.equal(root.querySelector("textarea").value, "C");
  [...root.querySelectorAll("button")].find(b => b.textContent === "Save draft").click();
  await tick();
  const b = saved[0][2].files.find(f => f.relativePath === "b.md");
  assert.equal(b.blob, slow);
});

it("locks one source tree during upload and does not submit it twice", async () => {
  let finish;
  const captured = [];
  const {root} = editor({adapter: {saveObservableSourceRevision: async (...args) => {
    captured.push(args);
    await new Promise(resolve => { finish = resolve; });
  }}});
  selectDirectory(root, [file("atlas/index.md", "Original")]);
  await tick();
  const submit = [...root.querySelectorAll("button")].find(b => b.textContent === "Save draft");
  submit.click();
  submit.dispatchEvent(new dom.window.Event("click"));
  assert.equal(captured.length, 1);
  assert.ok([...root.querySelectorAll("fieldset input, fieldset select, fieldset textarea, fieldset button")].every(control => control.disabled));
  selectDirectory(root, [file("atlas/index.md", "Replacement")]);
  assert.equal(await captured[0][2].files[0].blob.text(), "Original");
  finish();
  await tick();
  assert.equal(captured.length, 1);
});

it("retries only workspace loading when a committed revision's refresh fails", async () => {
  let refreshes = 0;
  const {root, saved} = editor({refresh: async () => {
    if (++refreshes === 1) throw new Error("Connection lost during reload");
  }});
  selectDirectory(root, [file("atlas/index.md", "Original")]);
  await tick();
  [...root.querySelectorAll("button")].find(b => b.textContent === "Save draft").click();
  await tick();
  assert.equal(saved.length, 1);
  assert.match(root.textContent, /draft was saved, but the workspace could not be reloaded/);
  assert.equal(root.querySelector("textarea").disabled, true);
  [...root.querySelectorAll("button")].find(b => b.textContent === "Reload saved revision").click();
  await tick();
  assert.equal(refreshes, 2);
  assert.equal(saved.length, 1);
});

it("retains edited files and restores input availability after an upload error", async () => {
  const {root} = editor({adapter: {saveObservableSourceRevision: async () => { throw new Error("Connection lost"); }}});
  selectDirectory(root, [file("atlas/index.md", "Original")]);
  await tick();
  root.querySelector("textarea").value = "Changed";
  const submit = [...root.querySelectorAll("button")].find(b => b.textContent === "Save draft");
  submit.click();
  await tick();
  assert.equal(root.querySelector("textarea").value, "Changed");
  assert.equal(root.querySelector("textarea").disabled, false);
  assert.equal(submit.disabled, false);
  assert.equal([...root.querySelectorAll("button")].find(b => b.textContent === "Reload saved draft").disabled, true);
  assert.match(root.textContent, /Could not confirm the source revision/);
});

it("does not replace new text with an older pending saved-revision read", async () => {
  let finish;
  const {root, saved} = editor({revision: {currentRevisionId: "revision", currentRevisionNumber: 1}, adapter: {
    listObservableSourceRevisions: async () => [{id: "revision", revisionNumber: 1, title: "Old", entryPath: "index.md", files: [{relativePath: "index.md", contentType: "text/markdown"}]}],
    readObservableSourceRevisionFile: async () => new Promise(resolve => { finish = resolve; })
  }});
  selectDirectory(root, [file("atlas/index.md", "Current")]);
  await tick();
  [...root.querySelectorAll("button")].find(b => b.textContent === "Reload saved draft").click();
  await tick();
  const text = root.querySelector("textarea");
  text.value = "Newer edit";
  text.dispatchEvent(new dom.window.Event("input"));
  finish({blob: new Blob(["Old saved text"], {type: "text/markdown"})});
  await tick();
  assert.equal(text.value, "Newer edit");
  [...root.querySelectorAll("button")].find(b => b.textContent === "Save draft").click();
  await tick();
  assert.equal(await saved[0][2].files[0].blob.text(), "Newer edit");
});

it("local adapter acceptance: cell edits commit and reopen through the source workspace without losing metadata or attachments", async t => {
  const downloads = captureDownloads(t);
  const untouchedCell = '<script id="19" type="text/markdown" data-note="keep"># Original narrative</script>';
  const original = '\uFEFF<!doctype html>\r\n<notebook data-provenance="keep"><title>Source preservation</title>\r\n'
    + '<script id="11" type="module" pinned data-cell="keep">const image = FileAttachment("plot.png"); const result = 1;</script>\r\n'
    + untouchedCell + '\r\n</notebook>\r\n';
  const image = file("atlas/plot.png", new Uint8Array([137, 80, 78, 71, 0, 255, 17]), "image/png");
  const authored = editor();
  selectDirectory(authored.root, [file("atlas/index.html", original, "text/html"), image,
    file("atlas/opengeo.publication.json", '{"schema":"opengeo.publication.1","format":"notebook","entry":"index.html"}', "application/json")]);
  await tick(); await tick();
  const canonical = authored.root.querySelector('[aria-label="Framework source editor"]');
  const cells = NotebookCellEditor({textarea: canonical, loadTools: () => ({parseNotebookCells, changeNotebookCell})});
  authored.root.append(cells.element);
  try {
    await cells.open("index.html");
    const body = cells.element.querySelector('[aria-label="Cell source"]');
    body.value = 'const image = FileAttachment("plot.png"); const result = 2;';
    body.dispatchEvent(new dom.window.Event("input", {bubbles: true}));
    assert.equal(authored.saved.length, 0, "A cell edit only changes the working source");
    click(authored.root, "Save draft"); await tick(); await tick();
    assert.equal(authored.saved.length, 1);
    const draft = authored.saved[0][2], stored = new Map(draft.files.map(record => [record.relativePath, record.blob]));
    const committed = await stored.get("index.html").text();
    assert.deepEqual(parseNotebookCells(committed).cells.map(cell => cell.id), [11, 19]);
    assert.equal(parseNotebookCells(committed).cells[0].value, body.value);
    assert.match(committed, /data-provenance="keep"/); assert.match(committed, /pinned data-cell="keep"/);
    assert.ok(committed.includes(untouchedCell), "The other cell retains exact source and attributes");
    assert.deepEqual(new Uint8Array(await stored.get("index.html").slice(0, 3).arrayBuffer()), new Uint8Array([239, 187, 191]));
    assert.doesNotMatch(committed, /(?:^|[^\r])\n/, "The workspace preserves uniform CRLF on commit");
    assert.equal(stored.get("plot.png"), image);
    cells.dispose(); authored.root.remove();
    const reads = [];
    const reopened = editor({revision: {currentRevisionId: "committed", currentRevisionNumber: 1}, adapter: {
      listObservableSourceRevisions: async () => [{id: "committed", revisionNumber: 1, title: draft.title, entryPath: draft.entryPath,
        lockfilePath: draft.lockfilePath, rightsStatus: draft.rightsStatus, dataAttachments: [],
        files: await savedSourceFiles(stored)}],
      readObservableSourceRevisionFile: async (...args) => {reads.push(args.slice(0, 4)); return {blob: stored.get(args[3])};}
    }});
    click(reopened.root, "Reload saved draft"); await tick(); await tick();
    const reopenedText = reopened.root.querySelector('[aria-label="Framework source editor"]').value;
    assert.equal(parseNotebookCells(reopenedText).cells[0].value, 'const image = FileAttachment("plot.png"); const result = 2;');
    assert.ok(reopenedText.includes(untouchedCell));
    input(reopened.root, "Framework source file", "plot.png");
    click(reopened.root, "Download source");
    await until(() => downloads.downloads.length === 1, "Exact saved notebook attachment downloaded");
    assert.equal(downloads.downloads[0].blob, image);
    assert.deepEqual(new Uint8Array(await downloads.downloads[0].blob.arrayBuffer()), new Uint8Array([137, 80, 78, 71, 0, 255, 17]));
    assert.deepEqual(reads, [["project", "source", "committed", "index.html"], ["project", "source", "committed", "plot.png"]]);
    assert.equal(reopened.saved.length, 0);
    downloads.release();
  } finally {cells.dispose();}
});

it("local adapter acceptance: Jupyter cell text and structure save and reopen while preserving outputs, metadata and exact untouched bytes", async t => {
  const downloads = captureDownloads(t);
  const before = "answer = 1\nprint(answer)\n", after = "answer = 2\nprint(answer)\n";
  const sourceToken = JSON.stringify(before), editedToken = JSON.stringify(after);
  const original = '\uFEFF' + String.raw`{
 "nbformat": 4, "nbformat_minor": 5,
 "metadata": {"kernelspec":{"name":"python3","display_name":"Python 3"},"language_info":{"name":"python"},"unknown":{"weight":1e2,"escaped":"\u0061","negativeZero":-0.0}},
 "cells": [
  {"id":"code-cell", "cell_type":"code", "metadata":{"tags":["retained"],"custom":{"keep":true}}, "execution_count":17,
   "outputs":[{"output_type":"stream","name":"stdout","text":["1\n"]}], "source":SOURCE_TOKEN},
  {"id":"markdown-cell","cell_type":"markdown","metadata":{"unknown":"keep"},"attachments":{"embedded.png":{"image/png":"iVBORw0KGgo="}},"source":["![Embedded](attachment:embedded.png)\n"]},
  {"id":"raw-cell","cell_type":"raw","metadata":{"format":"text/plain"},"source":["untouched", " raw\n"]}
 ], "custom_top_level":{"preserve":true}
}
`.replace('SOURCE_TOKEN', sourceToken).replace(/\n/g, '\r\n');
  let expected = original.replace(sourceToken, editedToken);
  const imageBytes = new Uint8Array([137, 80, 78, 71, 0, 255, 19]);
  const image = file("atlas/plot.png", imageBytes, "image/png");
  const authored = editor();
  selectDirectory(authored.root, [file("atlas/index.ipynb", original, "application/x-ipynb+json"), image]);
  await until(() => !authored.root.querySelector('[aria-label="Framework source editor"]').disabled
    && authored.root.querySelector('[aria-label="Framework source editor"]').value.includes('code-cell'), "Jupyter source opened");
  const canonical = authored.root.querySelector('[aria-label="Framework source editor"]');
  const tools = {parseNotebookCells, changeNotebookCell, parseJupyterCells, changeJupyterCell};
  const cells = NotebookCellEditor({textarea: canonical, loadTools: () => tools});
  authored.root.append(cells.element);
  let reopenedCells;
  try {
    await cells.open("index.ipynb");
    const body = cells.element.querySelector('[aria-label="Cell source"]');
    assert.equal(body.value, before);
    body.value = after; body.dispatchEvent(new dom.window.Event("input", {bubbles: true}));
    assert.equal(authored.saved.length, 0, "Editing a cell does not save or execute it");
    assert.match(cells.element.textContent, /Saved outputs are retained and may be stale/);
    assert.equal(canonical.value, expected.slice(1).replace(/\r\n/g, '\n'), 'Text edit only replaces its source token');
    click(cells.element, 'Duplicate cell'); click(cells.element, 'Move cell down');
    input(cells.element, 'New cell type', 'raw'); click(cells.element, 'Add cell');
    input(cells.element, 'Cell source', 'New source note');
    click(cells.element, 'Remove cell'); click(cells.element, 'Undo cell change');
    expected = '\uFEFF' + canonical.value.replace(/\n/g, '\r\n');
    const authoredCells = JSON.parse(canonical.value).cells;
    assert.deepEqual(authoredCells.map(cell => cell.cell_type), ['code', 'markdown', 'code', 'raw', 'raw']);
    assert.deepEqual({...authoredCells[2], id: 'code-cell'}, authoredCells[0], 'Duplicate retains saved outputs and metadata');
    assert.equal(new Set(authoredCells.map(cell => cell.id)).size, 5);
    assert.match(canonical.value, /"weight":1e2,"escaped":"\\u0061","negativeZero":-0.0/);
    assert.match(canonical.value, /"source":\["untouched", " raw\\n"\]/);
    assert.equal(authored.saved.length, 0, 'Structural changes remain an unsaved draft');
    click(authored.root, "Save draft");
    await until(() => authored.saved.length === 1, "Jupyter source committed");
    const draft = authored.saved[0][2], stored = new Map(draft.files.map(record => [record.relativePath, record.blob]));
    assert.equal(draft.entryPath, "index.ipynb"); assert.equal(draft.lockfilePath, null);
    assert.deepEqual(new Uint8Array(await stored.get("index.ipynb").arrayBuffer()), new TextEncoder().encode(expected),
      "Save retains the exact edited source, original BOM and CRLF, with untouched metadata and cell bytes");
    const parsed = JSON.parse(await stored.get("index.ipynb").text());
    assert.equal(parsed.cells[0].execution_count, 17);
    assert.deepEqual(parsed.cells[0].outputs, [{output_type: "stream", name: "stdout", text: ["1\n"]}]);
    assert.deepEqual(parsed.cells.map(cell => cell.id), authoredCells.map(cell => cell.id));
    assert.deepEqual([parsed.cells[0].id, parsed.cells[1].id, parsed.cells[4].id], ['code-cell', 'markdown-cell', 'raw-cell']);
    assert.deepEqual(parsed.cells[1].attachments, {"embedded.png": {"image/png": "iVBORw0KGgo="}});
    assert.equal(stored.get("plot.png"), image);
    cells.dispose(); authored.root.remove();

    const reads = [];
    const reopened = editor({revision: {currentRevisionId: "committed", currentRevisionNumber: 1}, adapter: {
      listObservableSourceRevisions: async () => [{id: "committed", revisionNumber: 1, title: draft.title,
        entryPath: draft.entryPath, lockfilePath: draft.lockfilePath, rightsStatus: draft.rightsStatus, dataAttachments: [],
        files: await savedSourceFiles(stored)}],
      readObservableSourceRevisionFile: async (...args) => {reads.push(args.slice(0, 4)); return {blob: stored.get(args[3])};}
    }});
    click(reopened.root, "Reload saved draft");
    const reopenedText = reopened.root.querySelector('[aria-label="Framework source editor"]');
    await until(() => !reopenedText.disabled && reopenedText.value.includes('code-cell'), "Saved Jupyter source reopened");
    assert.equal(reopenedText.value, expected.slice(1).replace(/\r\n/g, '\n'));
    reopenedCells = NotebookCellEditor({textarea: reopenedText, loadTools: () => tools});
    reopened.root.append(reopenedCells.element);
    await reopenedCells.open("index.ipynb");
    assert.equal(reopenedCells.element.querySelector('[aria-label="Cell source"]').value, after);
    assert.deepEqual(parseJupyterCells(reopenedText.value).cells.map(cell => cell.mode), ['code', 'markdown', 'code', 'raw', 'raw']);
    click(reopened.root, "Download source"); await until(() => downloads.downloads.length === 1, "Reopened notebook downloaded");
    assert.deepEqual(new Uint8Array(await downloads.downloads[0].blob.arrayBuffer()), new TextEncoder().encode(expected));
    input(reopened.root, "Framework source file", "plot.png");
    click(reopened.root, "Download source"); await until(() => downloads.downloads.length === 2, "Preserved binary downloaded");
    assert.deepEqual(new Uint8Array(await downloads.downloads[1].blob.arrayBuffer()), imageBytes);
    assert.deepEqual(reads, [["project", "source", "committed", "index.ipynb"], ["project", "source", "committed", "plot.png"]]);
    assert.equal(reopened.saved.length, 0, "Reopening and downloading do not create another revision");
    downloads.release();
  } finally {cells.dispose(); reopenedCells?.dispose();}
});

function selectSourceArchive(root, blob) {
  const control = root.querySelector('[aria-label="OpenGeo Studio source project ZIP"]');
  Object.defineProperty(control, 'files', {configurable: true, value: [blob]});
  control.dispatchEvent(new dom.window.Event('change'));
}
const archiveApply = root => [...root.querySelectorAll('button')].find(button => button.textContent === 'Use imported source');

const backupSha = bytes => createHash('sha256').update(bytes).digest('hex');
function backupFixture() {
  const source = '\uFEFF# Retained inputs\r\n<iframe src="maps/example.html"></iframe>\r\n';
  const data = new TextEncoder().encode('name,value\r\nSample,7\r\n');
  const map = new TextEncoder().encode('<!doctype html><title>Invented sample</title><p>Frozen map output</p>');
  const record = {...archiveRecord, sourceProjectId: 'source', s3VersionId: 'data-version',
    contentType: 'text/csv', sizeBytes: data.byteLength, checksumSha256: backupSha(data)};
  const binding = {attachmentId: record.id, relativePath: 'src/data/example.csv'};
  const reference = {path: 'src/maps/example.html', artifact_id: '11111111-1111-4111-8111-111111111111', mode: 'current', version: null};
  const references = {revision: 2, references: [reference]};
  const pin = {path: reference.path, artifactId: reference.artifact_id, mode: 'current', version: null,
    resolvedVersion: 4, manifestChecksumSha256: 'b'.repeat(64), projectId: 'map-project', resourceId: 'map-resource',
    output: {objectId: '22222222-2222-4222-8222-222222222222', mediaType: 'text/html', sizeBytes: map.byteLength, checksumSha256: backupSha(map)}};
  const calls = [], ticket = (object, version) => {
    const url = new URL(`https://s3.us-east-1.amazonaws.com/sample-backup/${object}`);
    for (const [name, value] of Object.entries({'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': 'invented',
      'X-Amz-Date': '20990101T000000Z', 'X-Amz-Expires': '300', 'X-Amz-SignedHeaders': 'host',
      'X-Amz-Signature': '0'.repeat(64), 'response-content-disposition': 'attachment; filename="sample"', versionId: version})) url.searchParams.set(name, value);
    return {url: url.href, method: 'GET', expiresAt: '2099-01-01T00:05:00Z'};
  };
  const adapter = {
    listObservableDataAttachments: async () => [record],
    readPublicationArtifactReferences: async () => structuredClone(references),
    readPublicationArtifactBackupInputs: async (project, source, options) => {
      calls.push(['resolve', project, source, options]);
      return {projectId: project, sourceProjectId: source, referenceRevision: 2, pins: [pin]};
    },
    requestDatasetDownload: async (...args) => {calls.push(['data', ...args]); return ticket('data', record.s3VersionId);},
    downloadPortableArtifact: async (...args) => {calls.push(['map', ...args]); return ticket('map', 'map-version');},
    fetchImplementation: async (url, options) => {
      calls.push(['fetch', new URL(url).pathname.split('/').at(-1), options.credentials, options.redirect, options.referrerPolicy]);
      return new Response(new URL(url).pathname.endsWith('/data') ? data : map);
    }
  };
  const revision = {id: 'input-revision', revisionNumber: 1, title: 'Original', entryPath: 'src/index.md',
    lockfilePath: null, rightsStatus: 'approved', dataAttachments: [binding], files: [{relativePath: 'src/index.md',
      contentType: 'text/markdown', sizeBytes: new TextEncoder().encode(source).byteLength, checksumSha256: backupSha(source)}]};
  return {source, data, map, record, binding, references, pin, calls, ticket, adapter, revision};
}
async function backupEditor(fixture, adapter = {}) {
  const opened = editor({revision: {currentRevisionId: fixture.revision.id, currentRevisionNumber: 1}, adapter: {
    ...fixture.adapter, listObservableSourceRevisions: async () => [fixture.revision],
    readObservableSourceRevisionFile: async () => ({blob: new Blob([fixture.source], {type: 'text/markdown'})}), ...adapter
  }});
  click(opened.root, 'Reload saved draft');
  await until(() => opened.root.querySelector('[aria-label="Framework source editor"]').value.includes('# Retained inputs'), 'Backup source opened');
  return opened;
}

it('complete input backup cancellation aborts active dependency HTTP and stops later reads and ZIP delivery', async t => {
  const capture = captureDownloads(t);
  for (const phase of ['headers', 'body']) {
    const f = backupFixture();
    let transferSignal, bodyPending = false;
    const {root, saved} = await backupEditor(f, {fetchImplementation: async (_url, options) => {
      transferSignal = options.signal;
      if (phase === 'headers') return new Promise((_resolve, reject) => {
        transferSignal.addEventListener('abort', () => reject(transferSignal.reason), {once: true});
      });
      return new Response(new ReadableStream({
        start(controller) {transferSignal.addEventListener('abort', () => controller.error(transferSignal.reason), {once: true});},
        pull() {bodyPending = true;}
      }));
    }});
    click(root, 'Download complete input backup');
    await until(() => transferSignal && (phase === 'headers' || bodyPending), `${phase}: dependency transfer pending`);
    click(root, 'Cancel download');
    assert.equal(transferSignal.aborted, true, `${phase}: Cancel reaches active S3 HTTP`);
    await until(() => ![...root.querySelectorAll('button')].find(b => b.textContent === 'Download complete input backup').disabled,
      `${phase}: Cancel releases controls`);
    await tick();
    assert.equal(capture.downloads.length, 0, phase);
    assert.equal(f.calls.filter(call => call[0] === 'map').length, 0, `${phase}: no next dependency read`);
    assert.equal(saved.length, 0);
    assert.match(root.textContent, /Download cancelled. Your working draft is unchanged/);
    assert.equal(root.querySelector('[aria-label="Framework source editor"]').value,
      f.source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'));
    root.remove();
  }
  capture.release();
});

it('downloads a complete input backup and restores saves and reopens its exact inputs and persistent provenance', async t => {
  const f = backupFixture(), capture = captureDownloads(t);
  const original = await backupEditor(f);
  assert.equal(f.calls.length, 0, 'Opening the editor does not copy dependencies');
  click(original.root, 'Download complete input backup');
  await until(() => capture.downloads.length === 1, original.root.textContent);
  assert.equal(capture.downloads[0].name, 'atlas-input-backup.zip');
  const imported = await readPublicationSourceArchive(capture.downloads[0].blob);
  const bytes = new Map(await Promise.all(imported.files.map(async item => [item.relativePath, new Uint8Array(await item.blob.arrayBuffer())])));
  assert.deepEqual(bytes.get('src/index.md'), new TextEncoder().encode(f.source));
  assert.deepEqual(bytes.get(f.binding.relativePath), f.data);
  assert.deepEqual(bytes.get(f.pin.path), f.map);
  assert.equal(imported.manifest.dependencies[1].pin.version, 4, 'Current selection is frozen to an exact edition');
  assert.deepEqual(f.calls.filter(call => call[0] === 'map'), [['map', 'map-project', 'map-resource', 4]]);
  const resolutionCalls = f.calls.filter(call => call[0] === 'resolve');
  assert.deepEqual(resolutionCalls.map(([kind, project, source, {signal, ...options}]) => [kind, project, source, options]),
    [['resolve', 'project', 'source', {expectedReferenceRevision: 2}]]);
  assert.equal(resolutionCalls[0][3].signal instanceof AbortSignal, true, 'Dependency resolution receives the same cancellation scope');
  assert(f.calls.filter(call => call[0] === 'fetch').every(call => call.slice(2).join(',') === 'omit,error,no-referrer'));
  assert.equal(original.saved.length, 0, 'Export does not save');
  original.root.remove();
  let referenceWrites = 0;
  const destination = await backupEditor(f, {readPublicationArtifactReferences: async () => ({revision: 0, references: []}),
    savePublicationArtifactReferences: async () => {referenceWrites++;}});
  selectSourceArchive(destination.root, capture.downloads[0].blob);
  await until(() => !archiveApply(destination.root).disabled, 'Backup reviewed');
  click(destination.root, 'Use imported source');
  await until(() => destination.root.textContent.includes('Verified source, data, compiled map output'), destination.root.textContent);
  assert.equal(destination.root.querySelectorAll('[aria-label^="Choose destination file for "]').length, 0);
  assert.equal(destination.root.querySelector('.publication-artifact-references'), null, 'Copied output needs no map reconnection');
  click(destination.root, 'Save draft');
  await until(() => destination.saved.length === 1, destination.root.textContent);
  const draft = destination.saved[0][2];
  assert.deepEqual(draft.dataAttachments, [], 'Matching reference becomes an explicitly restored local data file');
  assert.equal(draft.rightsStatus, 'unreviewed'); assert.equal(referenceWrites, 0);
  const stored = new Map(draft.files.map(item => [item.relativePath, item.blob]));
  for (const [path, value] of bytes) assert.deepEqual(new Uint8Array(await stored.get(path).arrayBuffer()), value);
  const context = JSON.parse(await stored.get(imported.manifest.contextPath).text());
  assert.equal(context.grantsAuthority, false); assert.equal(context.rightsStatus, 'unreviewed');
  assert.equal(context.custody, 'explicit-restoration-copy');
  destination.root.remove();
  const reopened = editor({revision: {currentRevisionId: 'restored', currentRevisionNumber: 2}, adapter: {
    listObservableSourceRevisions: async () => [{id: 'restored', revisionNumber: 2, title: draft.title,
      entryPath: draft.entryPath, lockfilePath: null, rightsStatus: draft.rightsStatus, dataAttachments: [],
      files: await savedSourceFiles(stored)}],
    readObservableSourceRevisionFile: async (...args) => ({blob: stored.get(args[3])})
  }});
  click(reopened.root, 'Reload saved draft');
  await until(() => reopened.root.querySelector('[aria-label="Framework source editor"]').value.includes('# Retained inputs'), 'Restored entry reopened');
  input(reopened.root, 'Framework source file', imported.manifest.contextPath);
  await until(() => reopened.root.querySelector('[aria-label="Framework source editor"]').value.includes('explicit-restoration-copy'), 'Persistent provenance reopened');
  assert.equal(reopened.saved.length, 0); capture.release();
});

it('makes no partial complete input backup after denied or mismatched dependency bytes', async t => {
  const capture = captureDownloads(t), f = backupFixture();
  let bodies = 0;
  const {root, saved} = await backupEditor(f, {fetchImplementation: async () => {bodies++; return new Response('changed bytes');}});
  click(root, 'Download complete input backup');
  await until(() => root.textContent.includes('No partial archive was downloaded'), root.textContent);
  assert.equal(capture.downloads.length, 0); assert.equal(saved.length, 0); assert.equal(bodies, 1, 'Failure stops without a retry or second dependency');
  assert.equal(root.querySelector('[aria-label="Framework source editor"]').value, '# Retained inputs\n<iframe src="maps/example.html"></iframe>\n');
  root.remove();
  const denied = await backupEditor(f, {readPublicationArtifactBackupInputs: async () => {throw new Error('access denied');}});
  click(denied.root, 'Download complete input backup');
  await until(() => denied.root.textContent.includes('No partial archive was downloaded'), denied.root.textContent);
  assert.equal(bodies, 1); assert.equal(capture.downloads.length, 0); assert.equal(denied.saved.length, 0); capture.release();
});

it('preserves the destination draft on complete backup map conflicts and edits made during restore', async t => {
  const f = backupFixture(), capture = captureDownloads(t), source = await backupEditor(f);
  click(source.root, 'Download complete input backup'); await until(() => capture.downloads.length === 1, source.root.textContent); source.root.remove();
  const destination = editor({adapter: {readPublicationArtifactReferences: async () => f.references}});
  selectDirectory(destination.root, [file('atlas/src/index.md', '# Destination draft')]); await tick();
  selectSourceArchive(destination.root, capture.downloads[0].blob); await until(() => !archiveApply(destination.root).disabled, 'Conflict backup reviewed');
  click(destination.root, 'Use imported source');
  await until(() => destination.root.textContent.includes('Remove conflicting saved map references'), destination.root.textContent);
  assert.equal(destination.root.querySelector('[aria-label="Framework source editor"]').value, '# Destination draft');
  assert.equal(destination.saved.length, 0); destination.root.remove();
  let finish;
  const stale = editor({adapter: {readPublicationArtifactReferences: async () => new Promise(resolve => {finish = resolve;})}});
  selectDirectory(stale.root, [file('atlas/src/index.md', '# Before')]); await tick();
  selectSourceArchive(stale.root, capture.downloads[0].blob); await until(() => !archiveApply(stale.root).disabled, 'Restore reviewed');
  click(stale.root, 'Use imported source'); await until(() => finish, 'Destination read pending');
  input(stale.root, 'Framework source editor', '# Edited while checking');
  finish({revision: 0, references: []}); await tick(); await tick();
  assert.equal(stale.root.querySelector('[aria-label="Framework source editor"]').value, '# Edited while checking');
  assert.equal(stale.saved.length, 0); assert.equal(archiveApply(stale.root).disabled, true); capture.release();
});

it('bounds complete backup reads and stops on stale drafts version mismatches and path collisions', async () => {
  const f = backupFixture(), files = [{relativePath: 'src/index.md', blob: new Blob([f.source]), contentType: 'text/markdown'}];
  const selection = {adapter: f.adapter, projectId: 'project', sourceProjectId: 'source', files,
    entryPath: 'src/index.md', dataAttachments: [f.binding], artifactReferences: f.references};
  let cancelled = 0, bodies = 0;
  await assert.rejects(readPublicationSourceBackupInputs({...selection, adapter: {...f.adapter,
    fetchImplementation: async () => {bodies++; return new Response(new ReadableStream({pull(controller) {
      controller.enqueue(new Uint8Array(f.data.byteLength + 1));
    }, cancel() {cancelled++;}}));}
  }}), /declared size/);
  assert.equal(bodies, 1); assert.equal(cancelled, 1);
  await assert.rejects(readPublicationSourceBackupInputs({...selection, adapter: {...f.adapter,
    requestDatasetDownload: async () => f.ticket('data', 'different-version')
  }}), /exact saved dependency version/);
  let current = true;
  await assert.rejects(readPublicationSourceBackupInputs({...selection, isCurrent: () => current, adapter: {...f.adapter,
    requestDatasetDownload: async (...args) => {current = false; return f.adapter.requestDatasetDownload(...args);}
  }}), /draft changed/);
  const ticketsBefore = f.calls.filter(call => call[0] === 'data' || call[0] === 'map').length;
  await assert.rejects(readPublicationSourceBackupInputs({...selection, files: [...files,
    {relativePath: 'src/maps/example.html', blob: new Blob(['existing']), contentType: 'text/html'}]}), /unique/);
  assert.equal(f.calls.filter(call => call[0] === 'data' || call[0] === 'map').length, ticketsBefore, 'Collisions fail before body tickets');
});

const legacySource = '\uFEFFfunction _data(FileAttachment) { return FileAttachment("data.json").json(); }\r\n'
  + 'function _count(data) { return data.length; }\r\n'
  + 'export default function define(runtime, observer) {\r\n'
  + 'const main = runtime.module();\r\n'
  + 'const fileAttachments = new Map([["data.json", new URL("./files/data-hash", import.meta.url)]]);\r\n'
  + 'main.builtin("FileAttachment", runtime.fileAttachments(name => fileAttachments.get(name)));\r\n'
  + 'main.variable(observer("data")).define("data", ["FileAttachment"], _data);\r\n'
  + 'main.variable(observer("count")).define("count", ["data"], _count);\r\nreturn main;\r\n}\r\n';
const legacyConverter = ({source, ...options}) => convertLegacyObservable(source, {...options, kit, document});
function selectLegacy(root, source, attachments = []) {
  for (const [label, value] of [['Observable JavaScript or JSON export', [source]], ['Original Observable export folder', attachments]]) {
    const control = root.querySelector(`[aria-label="${label}"]`);
    Object.defineProperty(control, 'files', {configurable: true, value});
    control.dispatchEvent(new dom.window.Event('change'));
  }
}

it('preserves selected notice bytes and distinguishes identical from differing primary folder copies', async () => {
  const original = file('export@7.js', legacySource), notice = '\uFEFFCopyright retained\r\nPermission retained.\r\n';
  const attachments = [{relativePath: original.name, blob: original},
    {relativePath: 'files/data-hash', blob: new Blob(['[{"x":1}]'])},
    {relativePath: 'LICENSE.txt', blob: new Blob([notice])},
    {relativePath: 'child/LICENSE.txt', blob: new Blob(['Different child terms'])},
    {relativePath: 'child/NOTICE.md', blob: new Blob(['# Attribution\r\n'])},
    {relativePath: 'COPYING', blob: new Blob([])},
    {relativePath: 'license-data.csv', blob: new Blob(['ordinary,data'])}];
  const draft = await prepareLegacyNotebookImport({file: original, attachments, convert: legacyConverter});
  const notices = draft.conversionReport.retainedNotices;
  assert.deepEqual(notices.map(item => item.path), ['LICENSE.txt', 'child/LICENSE.txt', 'child/NOTICE.md']);
  assert.equal(new Set(notices.map(item => item.retainedPath)).size, 3);
  for (const item of notices) {
    const supplied = attachments.find(file => file.relativePath === item.path).blob;
    const retained = draft.files.find(file => file.relativePath === item.retainedPath).blob;
    assert.deepEqual(await retained.arrayBuffer(), await supplied.arrayBuffer());
    assert.equal(item.checksumSha256, createHash('sha256').update(Buffer.from(await supplied.arrayBuffer())).digest('hex'));
  }
  assert.deepEqual(draft.conversionReport.unusedSelectedFiles, ['COPYING', 'license-data.csv']);
  assert.equal(draft.conversionReport.provenance.grantsPermission, false);
  assert.equal(draft.manifest.baseRevision, null);
  const different = await prepareLegacyNotebookImport({file: original,
    attachments: attachments.map(entry => entry.relativePath === original.name ? {...entry, blob: new Blob([legacySource + '// different folder copy'])} : entry), convert: legacyConverter});
  assert(different.conversionReport.unusedSelectedFiles.includes(original.name));
});

it('reviews saves and reopens the pinned upstream bar chart with its exact original module data and license', async () => {
  const directory = new URL('./fixture/observable-bar-chart-527/', import.meta.url);
  const pin = JSON.parse(await readFile(new URL('source-pin.json', directory), 'utf8'));
  const bytes = new Map();
  for (const record of pin.files) {
    const raw = await readFile(new URL(record.path, directory));
    assert.equal(createHash('sha256').update(raw).digest('hex'), record.sha256);
    bytes.set(record.path, raw);
  }
  const authored = editor({legacyConverter, revision: {rightsStatus: 'approved'}});
  selectLegacy(authored.root, file(pin.main, bytes.get(pin.main)),
    [...bytes].map(([path, raw]) => file(`export/${path}`, raw)));
  click(authored.root, 'Review Observable conversion');
  await until(() => !archiveApply(authored.root).disabled, 'Real upstream export staged');
  assert.match(authored.root.textContent, /Retained license and attribution notices: LICENSE.txt/);
  assert.doesNotMatch(authored.root.textContent, /Selected files not copied:.*LICENSE.txt/);
  assert.equal(authored.saved.length, 0);
  click(authored.root, 'Use imported source');
  await until(() => authored.root.querySelector('[aria-label="Framework source editor"]').value.includes('<notebook'), 'Real upstream source opened');
  assert.equal(authored.root.querySelector('[aria-label="Source publication rights"]').value, 'unreviewed');
  click(authored.root, 'Save draft');
  await until(() => authored.saved.length === 1, 'Real upstream source explicitly saved');
  const draft = authored.saved[0][2], stored = new Map(draft.files.map(file => [file.relativePath, file.blob]));
  const report = JSON.parse(await stored.get('original/observable-conversion.json').text());
  assert.equal(draft.rightsStatus, 'unreviewed');
  assert.deepEqual(Buffer.from(await stored.get(report.original.retainedPath).arrayBuffer()), bytes.get(pin.main));
  for (const record of [...report.retainedModules, ...report.retainedNotices]) {
    assert.deepEqual(Buffer.from(await stored.get(record.retainedPath).arrayBuffer()), bytes.get(record.path));
  }
  for (const record of report.attachments) assert.deepEqual(Buffer.from(await stored.get(record.name).arrayBuffer()), bytes.get(record.path));
  assert.equal(report.unusedSelectedFiles.length, 0);
  authored.root.remove();
  const reopened = editor({revision: {currentRevisionId: 'upstream-527', currentRevisionNumber: 1}, adapter: {
    listObservableSourceRevisions: async () => [{id: 'upstream-527', revisionNumber: 1, title: draft.title,
      entryPath: draft.entryPath, lockfilePath: null, rightsStatus: 'unreviewed', dataAttachments: [],
      files: await savedSourceFiles(stored)}],
    readObservableSourceRevisionFile: async (...args) => ({blob: stored.get(args[3])})
  }});
  await until(() => reopened.root.querySelector('[aria-label="Framework source editor"]').value.includes('<notebook'), 'Saved upstream source reopened');
  input(reopened.root, 'Framework source file', report.retainedNotices[0].retainedPath);
  await until(() => reopened.root.querySelector('[aria-label="Framework source editor"]').value.includes('Copyright 2017'), 'Original notice reopened');
  assert.equal(reopened.saved.length, 0);
  assert.equal(reopened.root.querySelector('[aria-label="Source publication rights"]').value, 'unreviewed');
});

it("converts a legacy module through review and explicit save, retaining original bytes, mapped attachments and the loss report on reopen", async () => {
  const authored = editor({legacyConverter, revision: {rightsStatus: 'approved'}});
  selectDirectory(authored.root, [file('current/index.html', '<h1>Current draft</h1>')]); await tick();
  const original = file('export@7.js', legacySource), data = new Uint8Array([91,123,34,120,34,58,49,125,93]);
  selectLegacy(authored.root, original, [file('export/files/data-hash', data), file('export/unused.txt', 'retain on disk')]);
  click(authored.root, 'Review Observable conversion');
  await until(() => !archiveApply(authored.root).disabled, 'Legacy conversion staged for review');
  assert.match(authored.root.textContent, /2 cells converted; 1 local attachments retained/);
  assert.match(authored.root.textContent, /Selected files not copied: unused.txt/);
  assert.equal(authored.root.querySelector('[aria-label="Framework source editor"]').value, '<h1>Current draft</h1>');
  assert.equal(authored.saved.length, 0);
  const title = [...authored.root.querySelectorAll('label')].find(label => label.querySelector('span')?.textContent === 'Imported revision title').querySelector('input');
  title.value = 'Converted research'; title.dispatchEvent(new dom.window.Event('input'));
  click(authored.root, 'Use imported source');
  await until(() => authored.root.querySelector('[aria-label="Framework source editor"]').value.includes('<notebook'), 'Converted notebook opened');
  assert.equal(authored.saved.length, 0);
  assert.equal(authored.root.querySelector('[aria-label="Source publication rights"]').value, 'unreviewed');
  click(authored.root, 'Save draft'); await until(() => authored.saved.length === 1, 'Converted source explicitly committed');
  const draft = authored.saved[0][2], stored = new Map(draft.files.map(record => [record.relativePath, record.blob]));
  assert.equal(draft.title, 'Converted research'); assert.equal(draft.entryPath, 'index.html'); assert.equal(draft.lockfilePath, null);
  const buildFiles = await Promise.all(draft.files.map(async record => ({path: record.relativePath,
    contentType: record.contentType, sizeBytes: record.blob.size, bytes: Buffer.from(await record.blob.arrayBuffer())})));
  assert.equal(publicationFormat(draft.entryPath, buildFiles, record => record.bytes), 'notebook', 'Saved conversion selects the native compiler');
  assert.deepEqual(new Uint8Array(await stored.get('original/observable-export.js.txt').arrayBuffer()), new TextEncoder().encode(legacySource));
  assert.deepEqual(new Uint8Array(await stored.get('data.json').arrayBuffer()), data);
  const report = JSON.parse(await stored.get('original/observable-conversion.json').text());
  assert.equal(report.original.name, 'export@7.js'); assert.equal(report.attachments[0].path, 'files/data-hash');
  assert.deepEqual(report.unusedSelectedFiles, ['unused.txt']);
  assert.equal(report.provenance.grantsPermission, false);
  authored.root.remove();
  const reopened = editor({legacyConverter, revision: {currentRevisionId: 'converted', currentRevisionNumber: 1}, adapter: {
    listObservableSourceRevisions: async () => [{id: 'converted', revisionNumber: 1, title: draft.title,
      entryPath: draft.entryPath, lockfilePath: null, rightsStatus: 'unreviewed', dataAttachments: [],
      files: await savedSourceFiles(stored)}],
    readObservableSourceRevisionFile: async (...args) => ({blob: stored.get(args[3])})
  }});
  await until(() => reopened.root.querySelector('[aria-label="Framework source editor"]').value.includes('<notebook'), 'Committed conversion reopened');
  input(reopened.root, 'Framework source file', 'original/observable-conversion.json');
  await until(() => !reopened.root.querySelector('[aria-label="Framework source editor"]').disabled, 'Original conversion report reopened');
  assert.equal(JSON.parse(reopened.root.querySelector('[aria-label="Framework source editor"]').value).original.checksumSha256, report.original.checksumSha256);
  assert.equal(reopened.saved.length, 0);
});

it("reviews, saves and reopens a notebook with module-scoped helpers and a parameterized child while retaining its original bytes", async () => {
  const child = '\uFEFFconst childConfig = {shift: 2};\r\nfunction childOffset(value) { return value + childConfig.shift; }\r\n'
    + 'function _x(seed) { return childOffset(seed); }\r\nexport default function define(runtime, observer) {\r\n'
    + 'const main = runtime.module();\r\nmain.variable(observer("x")).define("x", ["seed"], _x);\r\nreturn main;\r\n}\r\n';
  const parent = 'import define1 from "./child.js";\nconst parentConfig = {multiplier: 2};\n'
    + 'function scale(value) { return value * parentConfig.multiplier; }\n'
    + 'function _input() { return 5; }\nfunction _total(value) { return scale(value); }\n'
    + 'export default function define(runtime, observer) { const main = runtime.module();\n'
    + 'main.variable(observer("input")).define("input", _input);\n'
    + 'const child1 = runtime.module(define1).derive([{name: "input", alias: "seed"}], main); main.import("x", "value", child1);\n'
    + 'main.variable(observer("total")).define("total", ["value"], _total); return main; }';
  const authored = editor({legacyConverter});
  selectLegacy(authored.root, file('parent.js', parent), [file('export/child.js', child), file('export/unused.txt', 'private unused bytes')]);
  click(authored.root, 'Review Observable conversion');
  await until(() => !archiveApply(authored.root).disabled, 'Child notebook conversion reviewed');
  assert.match(authored.root.textContent, /1 imported notebooks included/);
  assert.match(authored.root.textContent, /Selected files not copied: unused.txt/);
  assert.equal(authored.saved.length, 0);
  click(authored.root, 'Use imported source');
  await until(() => authored.root.querySelector('[aria-label="Framework source editor"]').value.includes('opengeo-legacy-modules'), 'Local graph opened');
  click(authored.root, 'Save draft');
  await until(() => authored.saved.length === 1, 'Local graph explicitly saved');
  const draft = authored.saved[0][2], stored = new Map(draft.files.map(record => [record.relativePath, record.blob]));
  assert.equal(draft.rightsStatus, 'unreviewed');
  assert.match(await stored.get('index.html').text(), /with \{input as seed\}/);
  assert.deepEqual(new Uint8Array(await stored.get('original/observable-export.js.txt').arrayBuffer()), new TextEncoder().encode(parent));
  assert.equal(stored.has('original/modules/parent.js.txt'), false, 'The primary original is retained once.');
  assert.deepEqual(new Uint8Array(await stored.get('original/modules/child.js.txt').arrayBuffer()), new TextEncoder().encode(child));
  assert.equal(stored.has('unused.txt'), false);
  const report = JSON.parse(await stored.get('original/observable-conversion.json').text());
  assert.equal(report.retainedModules.length, 1, 'Only the supplied child is an imported notebook.');
  assert.equal(report.rootLexicalScope.modulePath, 'parent.js');
  assert.equal(report.retainedModules[0].path, 'child.js');
  assert.equal(report.retainedModules[0].sizeBytes, new TextEncoder().encode(child).length);
  authored.root.remove();
  const reopened = editor({legacyConverter, revision: {currentRevisionId: 'module-import', currentRevisionNumber: 1}, adapter: {
    listObservableSourceRevisions: async () => [{id: 'module-import', revisionNumber: 1, title: draft.title,
      entryPath: 'index.html', lockfilePath: null, rightsStatus: 'unreviewed', dataAttachments: [],
      files: await savedSourceFiles(stored)}],
    readObservableSourceRevisionFile: async (...args) => ({blob: stored.get(args[3])})
  }});
  await until(() => reopened.root.querySelector('[aria-label="Framework source editor"]').value.includes('opengeo-legacy-modules'), 'Saved local graph reopened');
  assert.equal(reopened.root.querySelector('[aria-label="Framework source editor"]').value, await stored.get('index.html').text());
  assert.equal(reopened.saved.length, 0); reopened.root.remove();
});

it("preserves a draft for missing legacy attachments, unsupported modules and a conversion made stale by editing", async () => {
  const f = editor({legacyConverter}); selectDirectory(f.root, [file('current/index.html', '<h1>Keep me</h1>')]); await tick();
  selectLegacy(f.root, file('export.js', legacySource)); click(f.root, 'Review Observable conversion');
  await until(() => /Missing exported attachment/.test(f.root.textContent), 'Missing attachment reported');
  assert.equal(archiveApply(f.root).disabled, true);
  assert.equal(f.root.querySelector('[aria-label="Framework source editor"]').value, '<h1>Keep me</h1>');
  selectLegacy(f.root, file('export.js', 'throw Error("must never run");')); click(f.root, 'Review Observable conversion');
  await until(() => /Unsupported top-level/.test(f.root.textContent), 'Unsupported module retained');
  assert.equal(f.saved.length, 0);
  f.root.remove();
  let finish;
  const delayed = editor({legacyConverter: options => new Promise(resolve => {finish = () => resolve(legacyConverter(options));})});
  selectDirectory(delayed.root, [file('current/index.html', '<h1>Current</h1>')]); await tick();
  selectLegacy(delayed.root, file('source.json', JSON.stringify({title: 'Legacy', nodes: [{id: 1, mode: 'js', value: 'value = 1'}]})));
  click(delayed.root, 'Review Observable conversion'); await until(() => Boolean(finish), 'Converter pending');
  input(delayed.root, 'Framework source editor', '<h1>Newer edit</h1>'); finish();
  await until(() => /changed during conversion/.test(delayed.root.textContent), 'Stale conversion rejected');
  assert.equal(archiveApply(delayed.root).disabled, true);
  assert.equal(delayed.root.querySelector('[aria-label="Framework source editor"]').value, '<h1>Newer edit</h1>');
  assert.equal(delayed.saved.length, 0);
  finish = null;
  click(delayed.root, 'Review Observable conversion'); await until(() => Boolean(finish), 'Second conversion pending');
  const superseded = finish;
  selectSourceArchive(delayed.root, new Blob(['invalid zip']));
  await until(() => /Could not open this source project/.test(delayed.root.textContent), 'ZIP replaces conversion review');
  assert.equal([...delayed.root.querySelectorAll('button')].find(button => button.textContent === 'Review Observable conversion').disabled, false);
  superseded(); await tick();
  assert.equal(archiveApply(delayed.root).disabled, true);
  finish = null;
  click(delayed.root, 'Review Observable conversion'); await until(() => Boolean(finish), 'Conversion available after switching import modes');
  finish(); await until(() => !archiveApply(delayed.root).disabled, 'Fresh review recovered');
  assert.equal(delayed.root.querySelector('[aria-label="Framework source editor"]').value, '<h1>Newer edit</h1>');
  assert.equal(delayed.saved.length, 0);
});

it("reviews an OpenGeo ZIP before applying, then commits and reopens exact files without adopting original authority or external bindings", async t => {
  const capture = captureDownloads(t);
  const original = new Map([
    ['src/imported.md', new TextEncoder().encode('\uFEFF# Imported source\r\n\r\nRetained text.\r\n')],
    ['src/image.png', new Uint8Array([137, 80, 78, 71, 0, 255, 23])],
    ['package-lock.json', new TextEncoder().encode('{"lockfileVersion":3,"packages":{}}\n')]
  ]);
  const foreignAttachmentId = '00000000-0000-4000-8000-000000000099';
  const metadata = {title: 'Imported research', entryPath: 'src/imported.md', lockfilePath: 'package-lock.json',
    projectId: 'foreign-project', sourceProjectId: 'foreign-source', siteId: 'foreign-site', routeNamespace: 'foreign-route',
    rightsStatus: 'approved', buildPolicy: {compilerImageDigest: 'foreign-compiler', networkPolicy: 'allow'},
    changeSummary: 'Foreign revision note'};
  const exported = await createPublicationSourceArchive({metadata,
    files: [...original].map(([relativePath, bytes]) => ({relativePath, blob: new Blob([bytes])})),
    dataAttachments: [{attachmentId: foreignAttachmentId, relativePath: 'src/data/foreign.csv'}],
    artifactReferences: {revision: 9, references: [{artifactId: foreignAttachmentId, version: 7}]},
    baseRevision: {id: 'foreign-revision', revisionNumber: 99, manifest: {original: true}}});
  const {root, saved} = editor();
  selectDirectory(root, [file('atlas/index.md', '# Keep this draft')]);
  await until(() => root.querySelector('[aria-label="Framework source editor"]').value === '# Keep this draft', 'Destination opened');
  await loadArchive(root);
  input(root, 'FileAttachment path', 'src/data/destination.geojson'); click(root, 'Insert file');
  const destinationDraft = root.querySelector('[aria-label="Framework source editor"]').value;
  assert.match(destinationDraft, /# Keep this draft/);
  assert.match(destinationDraft, /FileAttachment\("src\/data\/destination\.geojson"\)/);
  input(root, 'Source publication rights', 'approved');
  selectSourceArchive(root, exported.blob);
  await until(() => !archiveApply(root).disabled, 'Complete ZIP reviewed');
  assert.equal(root.querySelector('[aria-label="Framework source editor"]').value, destinationDraft);
  assert.equal(root.querySelector('[aria-label="Source publication rights"]').value, 'approved');
  assert.match(root.textContent, /Imported research/); assert.match(root.textContent, /foreign-project/);
  assert.equal(saved.length, 0, 'Review does not replace or save the destination draft');
  click(root, 'Use imported source');
  await until(() => root.querySelector('[aria-label="Framework source editor"]').value === '# Imported source\n\nRetained text.\n', 'Imported source opened');
  assert.equal(saved.length, 0, 'Applying a reviewed tree is still a local draft');
  assert.equal(root.querySelector('[aria-label="Source publication rights"]').value, 'unreviewed');
  click(root, 'Download source project');
  await until(() => capture.downloads.length === 1, 'Destination context exported');
  const current = JSON.parse(new TextDecoder().decode(unzipSync(new Uint8Array(await capture.downloads[0].blob.arrayBuffer()))['opengeo-source-project.json']));
  assert.deepEqual(current.metadata, {projectId: 'project', sourceProjectId: 'source', siteId: 'site', routeNamespace: 'atlas',
    title: metadata.title, entryPath: metadata.entryPath, lockfilePath: metadata.lockfilePath, rightsStatus: 'unreviewed',
    changeSummary: 'Import source project; review external references',
    buildPolicy: {frameworkVersion: '1.13.4', compilerImageDigest: 'digest', networkPolicy: 'deny'}});
  assert.equal(current.baseRevision, null); assert.equal(current.artifactReferences, null);
  assert.deepEqual(current.dataAttachments.map(({attachmentId, relativePath}) => ({attachmentId, relativePath})),
    [{attachmentId: archiveRecord.id, relativePath: 'src/data/destination.geojson'}]);
  click(root, 'Save draft');
  await until(() => saved.length === 1, 'Imported source committed');
  assert.deepEqual(saved[0].slice(0, 2), ['project', 'source']);
  const draft = saved[0][2], stored = new Map(draft.files.map(record => [record.relativePath, record.blob]));
  assert.equal(draft.expectedRevision, 0); assert.equal(draft.title, metadata.title);
  assert.equal(draft.entryPath, metadata.entryPath); assert.equal(draft.lockfilePath, metadata.lockfilePath);
  assert.equal(draft.rightsStatus, 'unreviewed'); assert.equal(draft.reuseRevision, undefined);
  assert.deepEqual(draft.dataAttachments, [{attachmentId: archiveRecord.id, relativePath: 'src/data/destination.geojson'}]);
  assert.deepEqual([...stored.keys()].sort(), [...original.keys()].sort());
  for (const [path, bytes] of original) assert.deepEqual(new Uint8Array(await stored.get(path).arrayBuffer()), bytes, path);
  root.remove();
  const reads = [];
  const reopened = editor({revision: {currentRevisionId: 'imported', currentRevisionNumber: 1}, adapter: {
    listObservableSourceRevisions: async () => [{id: 'imported', revisionNumber: 1, title: draft.title, entryPath: draft.entryPath,
      lockfilePath: draft.lockfilePath, rightsStatus: draft.rightsStatus, dataAttachments: draft.dataAttachments,
      files: await savedSourceFiles(stored)}],
    readObservableSourceRevisionFile: async (...args) => {reads.push(args.slice(0, 4)); return {blob: stored.get(args[3])};}
  }});
  click(reopened.root, 'Reload saved draft');
  await until(() => reopened.root.querySelector('[aria-label="Framework source editor"]').value === '# Imported source\n\nRetained text.\n', 'Saved import reopened');
  assert.equal(reopened.root.querySelector('[aria-label="Source publication rights"]').value, 'unreviewed');
  input(reopened.root, 'Framework source file', 'src/image.png'); click(reopened.root, 'Download source');
  await until(() => capture.downloads.length === 2, 'Imported binary reopened');
  assert.deepEqual(new Uint8Array(await capture.downloads[1].blob.arrayBuffer()), original.get('src/image.png'));
  assert.deepEqual(reads, [['project', 'source', 'imported', 'src/imported.md'], ['project', 'source', 'imported', 'src/image.png']]);
  assert.equal(reopened.saved.length, 0); capture.release();
});

it("rejects checksum failures and failed ZIP reads without replacing or saving the current draft", async () => {
  const exported = await createPublicationSourceArchive({files: [{relativePath: 'index.md', blob: new Blob(['# Imported'])}],
    metadata: {title: 'Imported', entryPath: 'index.md', lockfilePath: null}});
  const entries = unzipSync(new Uint8Array(await exported.blob.arrayBuffer()));
  const manifest = JSON.parse(new TextDecoder().decode(entries['opengeo-source-project.json']));
  manifest.files[0].checksumSha256 = '0'.repeat(64);
  entries['opengeo-source-project.json'] = strToU8(JSON.stringify(manifest));
  const badChecksum = new Blob([zipSync(entries, {level: 0, mtime: new Date(1980, 0, 1)})]);
  const failedRead = new Blob([exported.blob]);
  failedRead.arrayBuffer = async () => {throw Error('Selected ZIP became unreadable');};
  const {root, saved} = editor();
  selectDirectory(root, [file('atlas/index.md', '# Original')]);
  await until(() => root.querySelector('[aria-label="Framework source editor"]').value === '# Original', 'Destination opened');
  input(root, 'Framework source editor', '# Unsaved work'); input(root, 'Source publication rights', 'approved');
  for (const [blob, message] of [[badChecksum, 'SHA-256'], [failedRead, 'Selected ZIP became unreadable']]) {
    selectSourceArchive(root, blob);
    await until(() => root.textContent.includes(message), `Archive rejected: ${message}`);
    assert.equal(archiveApply(root).disabled, true);
    assert.equal(root.querySelector('[aria-label="Framework source editor"]').value, '# Unsaved work');
    assert.equal(root.querySelector('[aria-label="Source publication rights"]').value, 'approved');
    assert.equal(saved.length, 0);
  }
  click(root, 'Save draft'); await until(() => saved.length === 1, 'Original draft remains saveable');
  assert.equal(await saved[0][2].files[0].blob.text(), '# Unsaved work'); assert.equal(saved[0][2].rightsStatus, 'approved');
});

it("refuses stale ZIP replacement after draft, rights, file selection or disposal changes during verification or after review", async () => {
  const exported = await createPublicationSourceArchive({files: [{relativePath: 'imported.md', blob: new Blob(['# Imported'])}],
    metadata: {title: 'Imported', entryPath: 'imported.md', lockfilePath: null}});
  const bytes = await exported.blob.arrayBuffer();
  for (const stage of ['reading', 'reviewed']) for (const change of ['draft', 'rights', 'selection', 'disposal']) {
    const {root, saved} = editor();
    selectDirectory(root, [file('atlas/index.md', '# Keep current'), file('atlas/notes.md', '# Other file')]);
    await until(() => root.querySelector('[aria-label="Framework source editor"]').value === '# Keep current', `${stage}/${change}: destination opened`);
    let finish;
    const blob = new Blob([bytes]);
    if (stage === 'reading') blob.arrayBuffer = () => new Promise(resolve => {finish = resolve;});
    selectSourceArchive(root, blob);
    await until(() => stage === 'reading' ? finish : !archiveApply(root).disabled, `${stage}/${change}: selected ZIP reached stage`);
    if (change === 'draft') input(root, 'Framework source editor', '# Newer work');
    if (change === 'rights') input(root, 'Source publication rights', 'rejected');
    if (change === 'selection') input(root, 'Framework source file', 'notes.md');
    if (change === 'disposal') root.remove();
    if (stage === 'reading') finish(bytes);
    else click(root, 'Use imported source');
    if (change === 'disposal') {await tick(); await tick();}
    else await until(() => root.textContent.includes(stage === 'reading' ? 'changed during verification' : 'changed after review'), `${stage}/${change}: stale import refused`);
    assert.equal(saved.length, 0, `${stage}/${change}`);
    assert.equal(archiveApply(root).disabled, true, `${stage}/${change}`);
    const expected = change === 'draft' ? '# Newer work' : change === 'selection' ? '# Other file' : '# Keep current';
    await until(() => root.querySelector('[aria-label="Framework source editor"]').value === expected, `${stage}/${change}: retained draft`);
    if (change === 'rights') assert.equal(root.querySelector('[aria-label="Source publication rights"]').value, 'rejected');
    root.remove();
  }
});


it("reconnects imported data paths deliberately, replaces only that draft path and commits/reopens destination identities", async () => {
  const foreignId = '00000000-0000-4000-8000-000000000099';
  const replacement = {...archiveRecord, id: '00000000-0000-4000-8000-000000000098', checksumSha256: 'b'.repeat(64)};
  const path = 'src/data/water.geojson';
  const exported = await createPublicationSourceArchive({metadata: {title: 'Portable source', entryPath: 'src/index.md'},
    files: [{relativePath: 'src/index.md', blob: new Blob(['\uFEFF# Portable\r\n']), contentType: 'text/markdown'}],
    dataAttachments: [{attachmentId: foreignId, relativePath: path}],
    baseRevision: {manifest: {dataAttachments: [{attachmentId: foreignId, path, checksumSha256: archiveRecord.checksumSha256}]}}});
  let reads = 0;
  const {root, saved} = editor({adapter: {listObservableDataAttachments: async () => {reads++; return [archiveRecord, replacement];}}});
  selectDirectory(root, [file('atlas/src/index.md', '# Destination')]); await tick(); await tick();
  await loadArchive(root); input(root, 'FileAttachment path', path); click(root, 'Insert file');
  selectSourceArchive(root, exported.blob); await until(() => !archiveApply(root).disabled, 'Import reviewed');
  click(root, 'Use imported source'); await tick(); await tick();
  assert.equal(reads, 1, 'ZIP review/apply must not load or copy any dependency');
  assert.match(root.textContent, /Imported data paths/);
  root.querySelector(`[aria-label="Choose destination file for ${path}"]`).click();
  assert.equal(root.querySelector('[aria-label="Registered archive file"]').value, '', 'Never auto-select the imported identity');
  input(root, 'Registered archive file', replacement.id);
  assert.match(root.textContent, /Different bytes from the original/);
  assert.match(root.textContent, /Replaces the draft reference/);
  assert.equal(root.querySelector('[aria-label="Archive file path 1"]').value, path);
  assert.equal(saved.length, 0);
  click(root, 'Reconnect file');
  assert.equal(root.querySelectorAll('[aria-label^="Archive file path "]').length, 1);
  assert.match(root.textContent, /Imported file reconnected/);
  const reconnectedSource = '# Portable\n\n\n```js\nconst data_water = await FileAttachment("data/water.geojson").json();\n```\n';
  assert.equal(root.querySelector('[aria-label="Framework source editor"]').value, reconnectedSource);
  assert.equal(saved.length, 0);
  click(root, 'Save draft'); await until(() => saved.length === 1, 'Reconnected source committed');
  assert.equal(reads, 2, 'Commit checks current metadata once');
  const draft = saved[0][2];
  assert.deepEqual(draft.dataAttachments, [{attachmentId: replacement.id, relativePath: path}]);
  assert.equal(draft.rightsStatus, 'unreviewed');
  assert.deepEqual(new Uint8Array(await draft.files[0].blob.arrayBuffer()), new TextEncoder().encode('\uFEFF' + reconnectedSource.replace(/\n/g, '\r\n')));
  const reopened = editor({revision: {currentRevisionId: 'reconnected', currentRevisionNumber: 1}, adapter: {
    listObservableSourceRevisions: async () => [{id: 'reconnected', revisionNumber: 1, title: draft.title,
      entryPath: draft.entryPath, lockfilePath: draft.lockfilePath, rightsStatus: draft.rightsStatus,
      dataAttachments: draft.dataAttachments, files: draft.files.map(({relativePath, contentType}) => ({relativePath, contentType}))}],
    readObservableSourceRevisionFile: async () => ({blob: draft.files[0].blob}),
    listObservableDataAttachments: async () => [replacement]
  }});
  click(reopened.root, 'Reload saved draft'); await until(() => !!reopened.root.querySelector('[aria-label="Archive file path 1"]'), 'Saved binding reopened');
  assert.equal(reopened.root.querySelector('[aria-label="Archive file path 1"]').value, path);
  assert.match(reopened.root.textContent, new RegExp(replacement.id));
  assert.equal(reopened.root.querySelector('[aria-label="Framework source editor"]').value, reconnectedSource);
  assert.equal(reopened.root.querySelectorAll('[aria-label^="Choose destination file for "]').length, 0);
});

it("keeps imported data reconnection local and rejects unavailable, colliding and newly revoked files before saving", async () => {
  const path = 'src/data/water.geojson';
  const exported = await createPublicationSourceArchive({metadata: {entryPath: 'src/index.md'},
    files: [{relativePath: 'src/index.md', blob: new Blob(['# Source'])}, {relativePath: 'src/local.geojson', blob: new Blob(['{}'])}],
    dataAttachments: [{attachmentId: '00000000-0000-4000-8000-000000000099', relativePath: path}]});
  let reads = 0, available = false;
  const {root, saved} = editor({adapter: {listObservableDataAttachments: async () => {reads++; return [{...archiveRecord, available}];}}});
  selectSourceArchive(root, exported.blob); await until(() => !archiveApply(root).disabled, 'Import reviewed');
  click(root, 'Use imported source'); await tick(); await tick();
  assert.equal(reads, 0);
  root.querySelector(`[aria-label="Choose destination file for ${path}"]`).click();
  await until(() => reads === 1 && !root.querySelector('[aria-label="Registered archive file"]').disabled, 'Destination metadata loaded');
  input(root, 'Registered archive file', archiveRecord.id);
  const reconnect = [...root.querySelectorAll('button')].find(item => item.textContent === 'Reconnect file');
  assert.equal(reconnect.disabled, true); reconnect.click();
  assert.equal(root.querySelectorAll('[aria-label^="Archive file path "]').length, 0);
  available = true; click(root, 'Reload registered files'); await tick();
  input(root, 'Registered archive file', archiveRecord.id);
  input(root, 'FileAttachment path', 'src/local.geojson'); click(root, 'Insert file');
  assert.match(root.textContent, /must not collide/);
  assert.equal(root.querySelectorAll('[aria-label^="Archive file path "]').length, 0);
  root.querySelector(`[aria-label="Choose destination file for ${path}"]`).click();
  input(root, 'Registered archive file', archiveRecord.id); click(root, 'Reconnect file');
  const reconnectedSource = root.querySelector('[aria-label="Framework source editor"]').value;
  assert.match(reconnectedSource, /# Source/);
  assert.match(reconnectedSource, /const data_water = await FileAttachment\("data\/water\.geojson"\)\.json\(\);/);
  available = false;
  click(root, 'Save draft'); await until(() => /archived file is unavailable/.test(root.textContent), 'Revocation detected');
  assert.equal(saved.length, 0, 'No source is uploaded after the metadata check denies access');
  assert.equal(root.querySelector('[aria-label="Archive file path 1"]').value, path, 'Retain the failed draft for recovery');
  assert.equal(root.querySelector('[aria-label="Framework source editor"]').value, reconnectedSource);
  assert.equal(reads, 3);
});

it("clears imported reconnection choices when another source folder or saved revision is opened", async () => {
  const exported = await createPublicationSourceArchive({metadata: {entryPath: 'src/index.md'},
    files: [{relativePath: 'src/index.md', blob: new Blob(['# Imported'])}],
    dataAttachments: [{attachmentId: archiveRecord.id, relativePath: 'src/data/water.geojson'}]});
  const {root, saved} = editor();
  selectSourceArchive(root, exported.blob); await until(() => !archiveApply(root).disabled, 'Import reviewed');
  click(root, 'Use imported source'); await tick(); await tick();
  root.querySelector('[aria-label="Choose destination file for src/data/water.geojson"]').click();
  await tick();
  selectDirectory(root, [file('atlas/src/index.md', '# Different folder')]);
  await until(() => root.querySelector('[aria-label="Framework source editor"]').value === '# Different folder', 'Replacement folder opened');
  assert.equal(root.querySelectorAll('[aria-label^="Choose destination file for "]').length, 0);
  assert.equal(root.querySelector('[aria-label="FileAttachment path"]').value, '');
  click(root, 'Save draft'); await until(() => saved.length === 1, 'Replacement folder committed');
  assert.deepEqual(saved[0][2].dataAttachments, []);
});


it("reconnects ZIP map aliases through Files, protects unsaved reference edits and retains source through failed access/save", async () => {
 const foreign='99999999-9999-4999-8999-999999999999', destination='22222222-2222-4222-8222-222222222222';
 const path='src/maps/imported.html', source='\uFEFF# Imported map\r\n\r\n<iframe src="maps/imported.html"></iframe>\r\n';
 const exported=await createPublicationSourceArchive({metadata:{title:'Imported map source',entryPath:'src/index.md'},
  files:[{relativePath:'src/index.md',blob:new Blob([source])}],
  artifactReferences:{revision:99,references:[{path,artifact_id:foreign,mode:'pinned',version:99}]}});
 let stored={revision:2,references:[]},reads=0,denied=true,referenceWrites=0;
 const {root,saved}=editor({adapter:{readPublicationArtifactReferences:async()=>{reads++;return structuredClone(stored);},
  listResources:async()=>[{id:'destination-map',title:'Destination'}],
  readArtifactEdition:async()=>({id:destination,current_version_number:8,editions:[{version_number:8},{version_number:4}]}),
  savePublicationArtifactReferences:async(_project,_source,revision,references)=>{
   referenceWrites++;assert.equal(revision,2);
   if(denied)throw {code:'artifact_access_denied'};
   stored={revision:3,references:structuredClone(references)};return structuredClone(stored);
  }}});
 selectSourceArchive(root,exported.blob);await until(()=>!archiveApply(root).disabled,'ZIP reviewed');click(root,'Use imported source');await tick();await tick();
 assert.equal(reads,0);assert.equal(referenceWrites,0);
 const maps=root.querySelector('.publication-artifact-references');assert.ok(maps);
 const mapClick=async label=>{[...maps.querySelectorAll('button')].find(button=>button.textContent===label).click();await tick();};
 await mapClick('Load saved references');input(maps,'Imported map path to reconnect',path);
 await mapClick('Load map resources');await mapClick('Load retained editions');input(maps,'Retained Artifact edition to add','4');
 await mapClick('Reconnect imported map');assert.equal(referenceWrites,0);
 click(root,'Save draft');await tick();assert.equal(saved.length,0);assert.match(root.textContent,/Save or discard the map reference edits/);
 // A newly reviewed ZIP must not erase the controls needed to recover this draft.
 selectSourceArchive(root,exported.blob);await until(()=>!archiveApply(root).disabled,'Second import reviewed');
 click(root,'Use imported source');assert.equal(root.querySelector('.publication-artifact-references'),maps);
 assert.match(root.textContent,/Save or discard the map reference edits/);
 await mapClick('Save Artifact references');assert.match(maps.textContent,/artifact_access_denied/);
 assert.equal(maps.querySelector('[aria-label="Artifact asset path"]').value,path);assert.equal(saved.length,0);
 denied=false;await mapClick('Save Artifact references');
 assert.deepEqual(stored,{revision:3,references:[{path,artifact_id:destination,mode:'pinned',version:4}]});
 click(root,'Save draft');await until(()=>saved.length===1,'Imported source committed');
 assert.deepEqual(new Uint8Array(await saved[0][2].files[0].blob.arrayBuffer()),new TextEncoder().encode(source));
 assert.equal(saved[0][2].rightsStatus,'unreviewed');assert.equal(saved[0][2].files.length,1,'Reconnection does not copy the map or add an output');
 assert.equal(referenceWrites,2);assert.equal(reads,1);
});

it("retains imported map reference edits made while a saved revision entry is loading", async () => {
  const path = 'src/maps/imported.html', artifactId = '22222222-2222-4222-8222-222222222222';
  const source = '\uFEFF# Imported source\r\n<iframe src="maps/imported.html"></iframe>\r\n';
  const exported = await createPublicationSourceArchive({metadata: {entryPath: 'src/index.md'},
    files: [{relativePath: 'src/index.md', blob: new Blob([source])}],
    artifactReferences: {revision: 99, references: [{path, artifact_id: artifactId, mode: 'pinned', version: 99}]}});
  let finishSourceRead, referenceWrites = 0;
  const {root, saved} = editor({revision: {currentRevisionId: 'revision', currentRevisionNumber: 1}, adapter: {
    listObservableSourceRevisions: async () => [{id: 'revision', revisionNumber: 1, title: 'Saved source',
      entryPath: 'src/index.md', lockfilePath: null, dataAttachments: [],
      files: [{relativePath: 'src/index.md', contentType: 'text/markdown'}]}],
    readObservableSourceRevisionFile: async () => new Promise(resolve => { finishSourceRead = resolve; }),
    readPublicationArtifactReferences: async () => ({revision: 2, references: [{path, artifact_id: artifactId, mode: 'current', version: null}]}),
    savePublicationArtifactReferences: async () => { referenceWrites++; }
  }});
  // A deliberate local selection prevents automatic opening of the saved revision.
  selectDirectory(root, [file('atlas/src/index.md', '# Initial source')]); await tick();
  selectSourceArchive(root, exported.blob); await until(() => !archiveApply(root).disabled, 'Import reviewed');
  click(root, 'Use imported source'); await tick(); await tick();
  const maps = root.querySelector('.publication-artifact-references');
  click(maps, 'Load saved references'); await tick();
  click(root, 'Reload saved draft'); await until(() => finishSourceRead, 'Saved entry read pending');
  input(maps, 'Artifact asset path', 'src/maps/edited.html');
  assert.equal(maps.shouldBlockNavigation(), true);
  finishSourceRead({blob: new Blob(['# Saved replacement'])});
  await until(() => /saved revision could not be opened/.test(root.textContent), 'Reference guard retains both drafts');
  assert.match(root.textContent, /Save or discard the map reference edits/);
  assert.equal(root.querySelector('.publication-artifact-references'), maps);
  assert.equal(maps.querySelector('[aria-label="Artifact asset path"]').value, 'src/maps/edited.html');
  assert.equal(root.querySelector('[aria-label="Framework source editor"]').value, source.slice(1).replace(/\r\n/g, '\n'));
  assert.equal(saved.length, 0); assert.equal(referenceWrites, 0);
});

it("retains imported map reference actions started while a folder archive checksum is being reconciled", async () => {
  const mapPath = 'src/maps/imported.html', dataPath = 'src/data/water.geojson';
  const artifactId = '22222222-2222-4222-8222-222222222222', source = '# Imported source\n';
  const record = {...archiveRecord, sizeBytes: 2, checksumSha256: createHash('sha256').update('{}').digest('hex')};
  const exported = await createPublicationSourceArchive({metadata: {entryPath: 'src/index.md'},
    files: [{relativePath: 'src/index.md', blob: new Blob([source])}],
    dataAttachments: [{attachmentId: record.id, relativePath: dataPath}],
    artifactReferences: {revision: 99, references: [{path: mapPath, artifact_id: artifactId, mode: 'pinned', version: 99}]}});
  let finishArchiveRead, finishReferenceSave, referenceWrites = 0;
  const {root, saved} = editor({adapter: {
    listObservableDataAttachments: async () => [record],
    readPublicationArtifactReferences: async () => ({revision: 2, references: [{path: mapPath, artifact_id: artifactId, mode: 'current', version: null}]}),
    savePublicationArtifactReferences: async (_project, _source, revision, references) => {
      referenceWrites++;
      return new Promise(resolve => { finishReferenceSave = () => resolve({revision: revision + 1, references}); });
    }
  }});
  selectDirectory(root, [file('atlas/src/index.md', '# Initial source')]); await tick();
  await loadArchive(root); input(root, 'FileAttachment path', dataPath); click(root, 'Insert file');
  selectSourceArchive(root, exported.blob); await until(() => !archiveApply(root).disabled, 'Import reviewed');
  click(root, 'Use imported source'); await tick(); await tick();
  const maps = root.querySelector('.publication-artifact-references');
  click(maps, 'Load saved references'); await tick();
  const localData = file(`atlas/${dataPath}`, '{}');
  localData.arrayBuffer = async () => new Promise(resolve => { finishArchiveRead = () => resolve(new TextEncoder().encode('{}').buffer); });
  selectDirectory(root, [file('atlas/src/index.md', '# Folder replacement'), localData]);
  await until(() => finishArchiveRead, 'Archive checksum read pending');
  input(maps, 'Artifact asset path', 'src/maps/edited.html'); click(maps, 'Save Artifact references');
  await until(() => finishReferenceSave, 'Reference save pending');
  finishArchiveRead();
  await until(() => /Source selection is invalid/.test(root.textContent), 'Reference guard retains both drafts');
  assert.match(root.textContent, /Save or discard the map reference edits/);
  assert.equal(root.querySelector('.publication-artifact-references'), maps);
  assert.equal(maps.querySelector('[aria-label="Artifact asset path"]').value, 'src/maps/edited.html');
  assert.equal(root.querySelector('[aria-label="Framework source editor"]').value, source);
  assert.equal(root.querySelector('[aria-label="Archive file path 1"]').value, dataPath);
  assert.equal(saved.length, 0); assert.equal(referenceWrites, 1);
  finishReferenceSave(); await tick();
  assert.equal(maps.shouldBlockNavigation(), false, 'The retained save action can finish normally');
});


it('reviews pinned offline library loaders in Files and preserves the original export and resolutions through save/reopen', async () => {
 const original='\uFEFFfunction _d3(loader) { return loader("d3@7"); }\r\nexport default function define(runtime,observer) {\r\nconst main=runtime.module();\r\nmain.variable(observer("d3")).define("d3",["require"],_d3);\r\nreturn main;\r\n}\r\n';
 const {root,saved}=editor({legacyConverter});
 selectLegacy(root,file('export@7.js',original));click(root,'Review Observable conversion');
 await until(()=>!archiveApply(root).disabled,'Offline library conversion reviewed');
 assert.match(root.textContent,/d3@7 resolves to bundled d3 7\.9\.0/);
 assert.equal(saved.length,0);
 click(root,'Use imported source');await tick();await tick();
 click(root,'Save draft');await until(()=>saved.length===1,'Converted library source committed');
 const draft=saved[0][2],retained=draft.files.find(item=>item.relativePath==='original/observable-export.js.txt');
 assert.deepEqual(new Uint8Array(await retained.blob.arrayBuffer()),new TextEncoder().encode(original));
 const reportFile=draft.files.find(item=>item.relativePath==='original/observable-conversion.json');
 const report=JSON.parse(await reportFile.blob.text());
 assert.equal(report.libraryRequests[0].version,'7.9.0');assert.equal(report.libraryRequests[0].bundled,true);
 assert.equal(draft.rightsStatus,'unreviewed');
 const files=new Map(draft.files.map(item=>[item.relativePath,item.blob]));
 const reopened=editor({revision:{currentRevisionId:'libraries',currentRevisionNumber:1},adapter:{
  listObservableSourceRevisions:async()=>[{id:'libraries',revisionNumber:1,title:draft.title,entryPath:draft.entryPath,
   lockfilePath:draft.lockfilePath,rightsStatus:draft.rightsStatus,dataAttachments:[],files:draft.files.map(({relativePath,contentType})=>({relativePath,contentType}))}],
  readObservableSourceRevisionFile:async(...args)=>({blob:files.get(args[3])})
 }});
 click(reopened.root,'Reload saved draft');await tick();await tick();
 input(reopened.root,'Framework source file',reportFile.relativePath);
 await until(()=>/libraryRequests/.test(reopened.root.querySelector('[aria-label="Framework source editor"]').value),'Resolution report reopened');
 assert.equal(JSON.parse(reopened.root.querySelector('[aria-label="Framework source editor"]').value).libraryRequests[0].version,'7.9.0');
});
