import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, writeFile, symlink, rm, truncate} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {sha256} from "../src/contracts.mjs";
import {podmanArguments} from "../src/podman-runner.mjs";
import {stagePageCache, readPageCacheResult, verifiedPageCacheStats} from "../src/page-cache-transport.mjs";
import {readPageCacheInput} from "../../observable-builder/src/page-cache-input.mjs";

test("cache handoff is bounded, verified and cold on invalid or missing input", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengeo-cache-transport-"));
  const body = Buffer.from('{"schema":"test-cache"}');
  const cache = {body, checksumSha256: sha256(body)};
  try {
    for (const [name, value, accepted] of [
      ["valid", cache, true], ["cold", {}, false],
      ["corrupt", {...cache, checksumSha256: "0".repeat(64)}, false],
      ["large", {body: Buffer.alloc(32 * 1024 * 1024 + 1), checksumSha256: cache.checksumSha256}, false]
    ]) {
      const directory = join(root, name);
      await mkdir(directory);
      await stagePageCache(directory, value);
      const loaded = readPageCacheInput(join(directory, "page-cache"));
      assert.deepEqual(loaded, accepted ? cache : {});
      const manifest = JSON.parse(await readFile(join(directory, "page-cache/manifest.json")));
      assert.deepEqual(manifest, accepted ? {checksumSha256: cache.checksumSha256} : {});
    }
    assert.deepEqual(readPageCacheInput(join(root, "missing")), {});
    const linked = join(root, "linked");
    await mkdir(linked);
    await writeFile(join(linked, "manifest.json"), JSON.stringify({checksumSha256: cache.checksumSha256}));
    await symlink(join(root, "valid/page-cache/pages.json"), join(linked, "pages.json"));
    assert.deepEqual(readPageCacheInput(linked), {});
  } finally {await rm(root, {recursive: true, force: true});}
});

test("cache output is separate, checksum-verified and rejects oversized, linked or invalid files", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengeo-cache-result-"));
  const body = Buffer.from("compiler-owned cache");
  const stats = {restored: false, rendered: 2, reused: 0, checksumSha256: sha256(body)};
  const bodyPath = join(root, ".opengeo-page-cache-output.json");
  const statsPath = join(root, ".opengeo-page-cache-result.json");
  try {
    assert.equal(await readPageCacheResult(root), null);
    await writeFile(bodyPath, body);
    await writeFile(statsPath, JSON.stringify(stats));
    assert.deepEqual(await readPageCacheResult(root), {body, checksumSha256: stats.checksumSha256, stats});
    await writeFile(bodyPath, "corrupt");
    assert.equal(await readPageCacheResult(root), null);
    await truncate(bodyPath, 32 * 1024 * 1024 + 1);
    assert.equal(await readPageCacheResult(root), null);
    await rm(bodyPath);
    await writeFile(join(root, "outside"), body);
    await symlink(join(root, "outside"), bodyPath);
    assert.equal(await readPageCacheResult(root), null);
    await rm(bodyPath);
    await writeFile(bodyPath, body);
    await writeFile(statsPath, JSON.stringify({...stats, rendered: -1}));
    assert.equal(await readPageCacheResult(root), null);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("incremental Podman arguments retain isolation and opt in through the existing contract mount", () => {
  const options = {contract: "/tmp/job/contract", input: "/tmp/job/input",
    workspace: "/tmp/job/workspace", result: "/tmp/job/result",
    imageDigest: `sha256:${"a".repeat(64)}`, limits: {memoryMiB: 1024, cpuMillis: 1000}};
  const original = podmanArguments(options);
  const incremental = podmanArguments({...options, incrementalPages: true});
  assert.deepEqual(incremental.slice(0, original.length), original);
  assert.deepEqual(incremental.slice(original.length), [
    "--contract", "/contract/invocation.json", "--input", "/input",
    "--workspace", "/workspace/job", "--report", "/result/compiler-report.json",
    "--page-cache", "/contract/page-cache"
  ]);
  assert.equal(incremental.filter(arg => arg.startsWith("--volume=")).length, 4);
  assert(incremental.includes("--network=none"));
  assert(incremental.includes("--volume=/tmp/job/contract:/contract:ro,Z"));
});

test("cache counts reject malformed, contradictory, oversized or unrelated claims", () => {
  const body = Buffer.from("verified cache");
  const cache = {body, checksumSha256: sha256(body)};
  const stats = {checksumSha256: cache.checksumSha256, restored: true, rendered: 1, reused: 2};
  assert.deepEqual(verifiedPageCacheStats({...cache, stats}), {restored: true, renderedPages: 1, reusedPages: 2});
  for (const changed of [null, [], {...stats, rendered: -1}, {...stats, reused: 0.5},
    {...stats, rendered: 9999}, {...stats, reused: Number.MAX_SAFE_INTEGER},
    {...stats, restored: false}, {...stats, checksumSha256: "0".repeat(64)},
    {...stats, sourcePath: "private/source.md"}]) {
    assert.equal(verifiedPageCacheStats({...cache, stats: changed}), null);
  }
  assert.equal(verifiedPageCacheStats({...cache, body: Buffer.from("wrong"), stats}), null);
});
