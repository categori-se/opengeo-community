// Local acceptance only: no repository, AWS storage, publication or image push.
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PodmanRunner} from "../src/podman-runner.mjs";
import {INVOCATION_SCHEMA, REQUEST_SCHEMA, REQUIRED_SANDBOX, sha256} from "../src/contracts.mjs";

const imageDigest = process.argv[2];
assert.match(imageDigest ?? "", /^sha256:[a-f0-9]{64}$/, "Supply the exact local image ID");
const projectId = randomUUID();
const limits = {cpuMillis: 1000, memoryMiB: 2048, timeoutSeconds: 120,
  maxInputFiles: 128, maxInputBytes: 16 * 1024 * 1024,
  maxOutputFiles: 512, maxOutputBytes: 32 * 1024 * 1024};
const sources = {
  "index.md": '# Article\n\n```js\nconst values = await FileAttachment("./values.json").json();\n```\n\n${values[0]}\n',
  "other.md": "# Independent page\n\nThis discussion has no data dependency.\n",
  "values.json": "[7]\n"
};
const runner = new PodmanRunner();
const cases = [];

async function build(name, files, cache, sourceProjectId = projectId) {
  const inputs = new Map(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
    .map(([path, text]) => [path, Buffer.from(text)]));
  const invocation = {
    schemaVersion: INVOCATION_SCHEMA, buildJobId: randomUUID(),
    requestChecksumSha256: "b".repeat(64), inputManifestChecksumSha256: "c".repeat(64),
    entryPath: "index.md", lockfilePath: null,
    files: [...inputs].map(([path, body]) => ({path, sizeBytes: body.length,
      checksumSha256: sha256(body), contentType: path.endsWith(".md") ? "text/markdown" : "application/json"})),
    request: {schemaVersion: REQUEST_SCHEMA, sourceProjectId, sourceRevisionId: randomUUID(),
      sourceRevisionNumber: 1, sourceManifestChecksumSha256: "c".repeat(64), purpose: "preview",
      compilerImageDigest: imageDigest, frameworkVersion: "1.13.4",
      lockfileFormat: "npm-package-lock-v3", lockfileChecksumSha256: null,
      networkPolicy: "deny_all", resourceLimits: limits}
  };
  const result = await runner.run({invocation, inputs, limits,
    ...(cache === undefined ? {} : {incrementalPageCache: cache})});
  assert.deepEqual(result.sandbox, REQUIRED_SANDBOX);
  assert.equal(result.report.validationReport.publicationAuthorized, false);
  assert([...result.outputs.keys()].every(path => !path.includes("page-cache")));
  for (const file of result.report.outputManifest.files) {
    assert.equal(sha256(result.outputs.get(file.path)), file.checksumSha256);
  }
  cases.push({name, outputTreeChecksumSha256: result.report.outputTreeChecksumSha256,
    outputFiles: result.outputs.size, cache: result.incrementalPageCache?.stats ?? null});
  process.stdout.write(`${JSON.stringify(cases.at(-1))}\n`);
  return result;
}

const initial = await build("cold", sources, {});
assert.equal(initial.incrementalPageCache.stats.rendered, 2);
const unchanged = await build("unchanged", sources, initial.incrementalPageCache);
assert.equal(unchanged.incrementalPageCache.stats.rendered, 0);
assert.equal(unchanged.incrementalPageCache.stats.reused, 2);
assert.deepEqual(unchanged.outputs, initial.outputs);
const edited = {...sources, "values.json": "[21]\n"};
const changed = await build("attachment-changed", edited, unchanged.incrementalPageCache);
assert.equal(changed.incrementalPageCache.stats.rendered, 1);
assert.equal(changed.incrementalPageCache.stats.reused, 1);
const clean = await build("clean-comparison", edited);
assert.deepEqual(changed.outputs, clean.outputs);
const foreign = await build("different-project", sources, initial.incrementalPageCache, randomUUID());
assert.equal(foreign.incrementalPageCache.stats.restored, false);
assert.equal(foreign.incrementalPageCache.stats.reused, 0);
const artifact = await mkdtemp(join(tmpdir(), "opengeo-incremental-container-"));
await writeFile(join(artifact, "result.json"), JSON.stringify({
  schema: "opengeo.incremental-container-check.1", verifiedAt: new Date().toISOString(),
  imageDigest, sandbox: REQUIRED_SANDBOX, cases, awsRequests: 0, publicationAuthorized: false
}, null, 2), {flag: "wx", mode: 0o600});
process.stdout.write(`${JSON.stringify({status: "passed", artifact})}\n`);
