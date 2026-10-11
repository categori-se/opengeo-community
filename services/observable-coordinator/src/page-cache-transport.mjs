import {constants} from "node:fs";
import {mkdir, open, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {sha256} from "./contracts.mjs";

const MAX_BYTES = 32 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;

export function verifiedPageCacheStats(cache) {
  const stats = cache?.stats;
  if (!verifiedPageCache(cache) || !stats || typeof stats !== "object" || Array.isArray(stats) ||
      Object.keys(stats).sort().join(",") !== "checksumSha256,rendered,restored,reused" ||
      stats.checksumSha256 !== cache.checksumSha256 || typeof stats.restored !== "boolean" ||
      ![stats.rendered, stats.reused].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 10_000) ||
      stats.rendered + stats.reused > 10_000 || (!stats.restored && stats.reused > 0)) return null;
  // Deliberately exclude cache bytes, checksums, paths and arbitrary fields.
  return {restored: stats.restored, renderedPages: stats.rendered, reusedPages: stats.reused};
}

export function verifiedPageCache(cache) {
  if (!Buffer.isBuffer(cache?.body) || cache.body.length > MAX_BYTES ||
      !HASH.test(cache.checksumSha256) || sha256(cache.body) !== cache.checksumSha256) return null;
  return {body: cache.body, checksumSha256: cache.checksumSha256};
}

// Opt-in host transport only. Storage admission must establish the provenance of
// the checksum and bytes before calling this; hashing is not authentication.
export async function stagePageCache(contractDirectory, cache) {
  const directory = join(contractDirectory, "page-cache");
  await mkdir(directory, {mode: 0o700});
  const valid = verifiedPageCache(cache);
  if (valid) await writeFile(join(directory, "pages.json"), cache.body, {flag: "wx", mode: 0o400});
  await writeFile(join(directory, "manifest.json"), JSON.stringify(valid ? {
    checksumSha256: cache.checksumSha256
  } : {}), {flag: "wx", mode: 0o400});
}

export async function readPageCacheResult(workspace) {
  try {
    const stats = JSON.parse(await readBounded(join(workspace, ".opengeo-page-cache-result.json"), 1024));
    if (Object.keys(stats).sort().join(",") !== "checksumSha256,rendered,restored,reused" ||
        !HASH.test(stats.checksumSha256) || typeof stats.restored !== "boolean" ||
        ![stats.rendered, stats.reused].every(value => Number.isSafeInteger(value) && value >= 0)) return null;
    const body = await readBounded(join(workspace, ".opengeo-page-cache-output.json"), MAX_BYTES);
    if (sha256(body) !== stats.checksumSha256) return null;
    const cache = {body, checksumSha256: stats.checksumSha256, stats};
    return verifiedPageCacheStats(cache) ? cache : null;
  } catch {
    // Missing, corrupt or oversized sidecars do not invalidate a complete build.
    return null;
  }
}

async function readBounded(path, maximumBytes) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const facts = await file.stat();
    if (!facts.isFile() || facts.size > maximumBytes) throw Error("Invalid cache file");
    return await file.readFile();
  } finally {
    await file.close();
  }
}
