import assert from "node:assert/strict";
import {readFileSync, statSync} from "node:fs";
import {resolve, sep, basename} from "node:path";
import {createHash} from "node:crypto";
import {prepareObservableArchiveBrowserFiles} from "../src/components/ProjectSites.js";

// Read-only reconciliation of a previously inventoried local Framework folder.
// The archive registry entry is synthetic: this does not create an account
// record, capture data, grant rights, upload source or build/publish the site.
const [rootArgument, inventoryArgument] = process.argv.slice(2);
if (!rootArgument || !inventoryArgument) throw new Error("Usage: node check-framework-root-import.mjs LOCAL_ROOT SOURCE_COMPARISON_JSON");
const root = resolve(rootArgument);
const inventory = JSON.parse(readFileSync(inventoryArgument, "utf8"));
assert.equal(inventory.schemaVersion, "opengeo.root-source-comparison.1.0.0");
assert.ok(Array.isArray(inventory.records) && inventory.records.length > 0 && inventory.records.length <= 128);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const records = inventory.records.map(record => {
  assert.ok(typeof record.path === "string" && !record.path.includes("\\")
    && !record.path.split("/").some(part => !part || part === "." || part === ".."));
  const path = resolve(root, record.path);
  assert.ok(path.startsWith(root + sep));
  const facts = statSync(path);
  assert.ok(facts.isFile() && facts.size > 0 && facts.size <= 67_108_864);
  const bytes = readFileSync(path);
  assert.equal(sha(bytes), record.localSha256, `${record.path}: local content changed since inventory`);
  const blob = new Blob([bytes]);
  Object.defineProperties(blob, {name: {value: basename(path)}, webkitRelativePath: {value: `publication/${record.path}`}});
  return {path: record.path, checksumSha256: sha(bytes), bytes: bytes.length, blob};
});
const large = records.filter(record => record.bytes > 4_194_304);
assert.equal(large.length, 1, "Review any changed set of large attachments before adapting this check");
assert.equal(large[0].path, "src/data/examples/temane-water-areas-local.geojson");
const binding = {attachmentId: "00000000-0000-4000-8000-000000000087", relativePath: large[0].path};
const result = await prepareObservableArchiveBrowserFiles([], records.map(record => record.blob), [binding], [{
  id: binding.attachmentId, available: true, contentType: "application/geo+json",
  sizeBytes: large[0].bytes, checksumSha256: large[0].checksumSha256
}]);
assert.equal(result.files.length + result.archivedFiles.length, records.length);
assert.equal(result.excludedCount, 0);
for (const file of result.files) assert.equal(file.blob, records.find(record => record.path === file.relativePath).blob);
assert.equal(result.archivedFiles[0].checksumSha256, large[0].checksumSha256);
console.log(JSON.stringify({status: "passed", scope: "local source with synthetic archive registry",
  sourceFiles: result.files.length, sourceBytes: result.files.reduce((sum, file) => sum + file.blob.size, 0),
  archivedFiles: result.archivedFiles, originalFiles: records.length,
  originalBytes: records.reduce((sum, record) => sum + record.bytes, 0),
  accountRecordsCreated: 0, uploadedBytes: 0, publicationAuthorized: false}, null, 2));
