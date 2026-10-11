import {constants, closeSync, fstatSync, openSync, readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {join} from "node:path";

// Only the host's read-only contract directory may supply this optional cache.
// Never derive it from authored source files or a browser-provided checksum.
export function readPageCacheInput(directory) {
  try {
    const metadata = JSON.parse(readBounded(join(directory, "manifest.json"), 1024));
    if (Object.keys(metadata).length !== 1 || !/^[a-f0-9]{64}$/.test(metadata.checksumSha256)) return {};
    const body = readBounded(join(directory, "pages.json"), 32 * 1024 * 1024);
    if (createHash("sha256").update(body).digest("hex") !== metadata.checksumSha256) return {};
    return {body, checksumSha256: metadata.checksumSha256};
  } catch {
    // Cache availability is never required to compile the verified source.
    return {};
  }
}

function readBounded(path, maximumBytes) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const facts = fstatSync(fd);
    if (!facts.isFile() || facts.size > maximumBytes) throw Error("Invalid cache file");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
