import assert from "node:assert/strict";
import {it} from "node:test";
import {sourceRevisionChanges} from "../src/lib/sourceRevisionChanges.js";

const file = (relativePath, bytes, contentType = "text/markdown") => ({relativePath, contentType, blob: new Blob([bytes])});
const baseline = () => ({title: "Atlas", rightsStatus: "unreviewed", entryPath: "index.md", lockfilePath: null,
  files: [file("index.md", "# Atlas\r\n"), file("symbol.png", new Uint8Array([137, 80, 78, 71]), "image/png")],
  dataAttachments: [{relativePath: "data/points.geojson", attachmentId: "retained-version"}]});

it("treats identical bytes and reordered files/bindings as unchanged without network access", async () => {
  const a = baseline(), b = baseline();
  b.files.reverse(); b.changeSummary = "Edit revision 3";
  assert.equal((await sourceRevisionChanges(a, b)).unchanged, true);
});

it("detects added, changed and removed files independently", async () => {
  const a = baseline(), b = baseline();
  b.files = [file("index.md", "# Updated"), file("methods.md", "# Methods")];
  const result = await sourceRevisionChanges(a, b);
  assert.deepEqual(result.changed, ["index.md"]);
  assert.deepEqual(result.added, ["methods.md"]);
  assert.deepEqual(result.removed, ["symbol.png"]);
  assert.equal(result.unchanged, false);
});

it("does not equate same-length binary edits, BOM or line-ending changes", async () => {
  for (const bytes of [new Uint8Array([137, 80, 78, 72]), "\uFEFF# Atlas\r\n", "# Atlas\n"]) {
    const a = baseline(), b = baseline();
    const index = typeof bytes === "string" ? 0 : 1;
    b.files[index] = {...b.files[index], blob: new Blob([bytes])};
    assert.equal((await sourceRevisionChanges(a, b)).unchanged, false);
  }
});

it("does not skip content type, title, rights, entry or lockfile changes", async () => {
  for (const key of ["title", "rightsStatus", "entryPath", "lockfilePath"]) {
    const a = baseline(), b = baseline(); b[key] = "changed";
    assert.equal((await sourceRevisionChanges(a, b)).settingsChanged, true);
  }
  const a = baseline(), b = baseline(); b.files[0].contentType = "text/plain";
  assert.equal((await sourceRevisionChanges(a, b)).unchanged, false);
});

it("does not skip changed, removed or relocated archive bindings", async () => {
  for (const items of [[], [{relativePath: "data/points.geojson", attachmentId: "new-version"}],
    [{relativePath: "data/renamed.geojson", attachmentId: "retained-version"}]]) {
    const a = baseline(), b = baseline(); b.dataAttachments = items;
    assert.equal((await sourceRevisionChanges(a, b)).attachmentsChanged, true);
  }
});

it("preserves reordered public references and saves changed, removed or relocated pins", async () => {
  const pins = [{referenceId: "one", relativePath: "data/a.tif"}, {referenceId: "two", relativePath: "data/b.tif"}];
  const a = {...baseline(), referencedFiles: pins}, b = {...baseline(), referencedFiles: [...pins].reverse()};
  assert.equal((await sourceRevisionChanges(a, b)).unchanged, true);
  for (const referencedFiles of [[], [{...pins[0], referenceId: "replacement"}, pins[1]],
    [{...pins[0], relativePath: "data/renamed.tif"}, pins[1]]]) {
    const result = await sourceRevisionChanges(a, {...b, referencedFiles});
    assert.equal(result.referencedFilesChanged, true);
    assert.equal(result.unchanged, false);
  }
});

it("compares trusted unread parent files without treating an edited body or stale parent as unchanged", async () => {
  const original = new Blob(['# Original']);
  const digest = await crypto.subtle.digest('SHA-256', await original.arrayBuffer());
  const descriptor = {relativePath: 'index.md', contentType: 'text/markdown', sizeBytes: original.size,
    checksumSha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''),
    sourceObjectId: 'c0000000-0000-4000-8000-000000000001', blob: null};
  const reuseContext = {sourceProjectId: 'source', expectedRevision: 3,
    reuseRevision: {supportsFileReuse: true, sourceProjectId: 'source', revisionNumber: 3, files: [descriptor]}};
  const before = {files: [descriptor]}, after = {files: [{...descriptor}]};
  assert.equal((await sourceRevisionChanges(before, after, reuseContext)).unchanged, true);
  after.files[0].blob = original;
  assert.equal((await sourceRevisionChanges(before, after, reuseContext)).unchanged, true);
  after.files[0].blob = new Blob(['# Modified']);
  assert.deepEqual((await sourceRevisionChanges(before, after, reuseContext)).changed, ['index.md']);
  after.files[0].blob = null;
  assert.equal((await sourceRevisionChanges(before, after, {...reuseContext, expectedRevision: 4})).unchanged, false);
});
