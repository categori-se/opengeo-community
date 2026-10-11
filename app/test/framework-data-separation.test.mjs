import assert from "node:assert/strict";
import {it} from "node:test";
import {planFrameworkDataSeparation} from "../src/lib/frameworkArchiveInputs.js";

const file = (relativePath, bytes) => ({relativePath, blob: new Blob([new Uint8Array(bytes)])});
it("plans exact large-data paths and retains original Blob identities", () => {
  const source = file("src/index.md", 100), data = file("src/data/water.geojson", 18_930_972);
  const result = planFrameworkDataSeparation([source, data]);
  assert.equal(result.sourceFiles[0].blob, source.blob);
  assert.equal(result.dataFiles[0].blob, data.blob);
  assert.equal(result.sourceBytes, 100); assert.equal(result.dataBytes, 18_930_972);
});
it("does not move executable source or unsafe files into data references", () => {
  for (const path of ["src/large.js", "package.json", "src/../water.geojson", "src/.env"]) {
    assert.throws(() => planFrameworkDataSeparation([file("src/index.md", 100), file(path, 4_194_305)]));
  }
});
it("proposes the largest eligible data files when the whole tree exceeds the limit", () => {
  const files = [file("src/index.md", 100), ...Array.from({length: 5}, (_, i) => file(`src/data/${i}.json`, 4_000_000))];
  const result = planFrameworkDataSeparation(files);
  assert.equal(result.dataFiles.length, 1); assert.ok(result.sourceBytes <= 16_777_216);
  assert.equal(result.sourceFiles.length + result.dataFiles.length, files.length);
});
