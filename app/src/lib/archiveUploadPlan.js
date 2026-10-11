import {hashArchiveFileInWorker} from "./archiveHashClient.js";

// Local-only review data. Destination IDs are resolved and authorized by the API;
// this manifest never grants authority to a bucket, key, or another account.
const MAX_FILES = 100_000;
const MAX_PATH_BYTES = 1024;
const encoder = new TextEncoder();

export function archiveRelativePath(value) {
  if (typeof value !== "string" || !value || encoder.encode(value).length > MAX_PATH_BYTES
    || /[\\\u0000-\u001f\u007f]/u.test(value)
    || /[\uD800-\uDFFF]/u.test(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")
    || /^[A-Za-z]:/.test(value)) throw failure("archive_path_invalid");
  // Preserve spelling and Unicode: normalization could collapse distinct originals.
  return value;
}

export function collectArchiveFiles(files) {
  const entries = [], paths = new Set();
  let totalBytes = 0;
  for (const file of files) {
    if (entries.length >= MAX_FILES) throw failure("archive_file_limit");
    const path = archiveRelativePath(file.webkitRelativePath || file.name);
    if (paths.has(path)) throw failure("archive_duplicate_path");
    if (!Number.isSafeInteger(file.size) || file.size < 0
      || !Number.isSafeInteger(file.lastModified) || file.lastModified < 0
      || typeof file.slice !== "function") throw failure("archive_file_invalid");
    totalBytes += file.size;
    if (!Number.isSafeInteger(totalBytes)) throw failure("archive_size_invalid");
    paths.add(path);
    entries.push({path, sizeBytes: file.size, lastModified: file.lastModified, file});
  }
  if (!entries.length) throw failure("archive_empty");
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {entries, totalBytes};
}

// Routing is deliberately reviewed, not inferred from names or bounding boxes.
// A rule applies to an exact path or a whole directory boundary, longest first.
export function routeArchiveFiles(selection, rules, destinationIds) {
  const allowed = new Set(destinationIds);
  const prefixes = new Set();
  const checked = rules.map(({path, destinationId}) => {
    archiveRelativePath(path);
    if (prefixes.has(path) || !allowed.has(destinationId)) throw failure("archive_route_invalid");
    prefixes.add(path);
    return {path, destinationId};
  }).sort((a, b) => b.path.length - a.path.length);
  return selection.entries.map((entry) => ({...entry, destinationId: checked.find(
    (rule) => entry.path === rule.path || entry.path.startsWith(`${rule.path}/`)
  )?.destinationId ?? null}));
}

export async function hashArchivePlan(entries, {hashFile = hashArchiveFileInWorker, signal, onProgress = () => {}} = {}) {
  if (typeof hashFile !== "function") throw failure("archive_hasher_required");
  if (entries.some((entry) => typeof entry.destinationId !== "string" || !entry.destinationId)) {
    throw failure("archive_route_required");
  }
  const files = [], objects = [], canonical = new Map();
  let hashedBytes = 0;
  for (const entry of entries) {
    signal?.throwIfAborted();
    const sha256 = await hashFile(entry.file, {signal, onProgress: ({hashedBytes: currentBytes}) =>
      onProgress({hashedFiles: files.length, totalFiles: entries.length,
        hashedBytes: hashedBytes + currentBytes, currentPath: entry.path})});
    signal?.throwIfAborted();
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw failure("archive_checksum_invalid");
    if (entry.expectedSha256 && entry.expectedSha256 !== sha256) {
      throw failure("archive_selection_changed");
    }
    // Deduplicate only within a reviewed destination. Equal bytes in separate
    // access/geographic destinations remain separate objects.
    const identity = JSON.stringify([entry.destinationId, entry.sizeBytes, sha256]);
    let objectIndex = canonical.get(identity);
    if (objectIndex === undefined) {
      objectIndex = objects.length;
      canonical.set(identity, objectIndex);
      objects.push({destinationId: entry.destinationId, path: entry.path,
        sizeBytes: entry.sizeBytes, sha256});
    }
    files.push({path: entry.path, sizeBytes: entry.sizeBytes, lastModified: entry.lastModified,
      sha256, objectIndex, mode: null});
    hashedBytes += entry.sizeBytes;
    onProgress({hashedFiles: files.length, totalFiles: entries.length, hashedBytes});
  }
  return {schema: "opengeo-local-archive-plan/v1", files, objects,
    logicalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    uploadBytes: objects.reduce((sum, file) => sum + file.sizeBytes, 0),
    filesystemLimits: ["Browser selection does not expose Unix modes, symbolic links, or empty directories."]};
}

// Reload requires reselecting the original folder. Matching path/size/time is only
// a fast rejection check: every file must be rehashed before a resumed upload.
export function matchArchiveSelection(plan, selection) {
  const selected = new Map(selection.entries.map((entry) => [entry.path, entry]));
  if (selected.size !== plan.files.length) throw failure("archive_selection_changed");
  return plan.files.map((file) => {
    const entry = selected.get(file.path);
    if (!entry || entry.sizeBytes !== file.sizeBytes || entry.lastModified !== file.lastModified) {
      throw failure("archive_selection_changed");
    }
    return {...entry, expectedSha256: file.sha256,
      destinationId: plan.objects[file.objectIndex].destinationId};
  });
}

function failure(code) {return Object.assign(new Error(code), {code});}
