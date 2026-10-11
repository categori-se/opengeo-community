import {canReuseDeferredObservableSourceFile} from "./apiClient.js";

/** Compare a working tree with the revision opened in this editor, not the server head. */
export async function sourceRevisionChanges(baseline, draft, reuseContext = {}) {
  const before = new Map(baseline.files.map(file => [file.relativePath, file]));
  const after = new Map(draft.files.map(file => [file.relativePath, file]));
  const added = [], changed = [], removed = [];
  for (const [path, file] of after) {
    const original = before.get(path);
    if (!original) added.push(path);
    else if (original.contentType !== file.contentType || !await sameFile(original, file, reuseContext)) changed.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) removed.push(path);
  const settingsChanged = ["title", "rightsStatus", "entryPath", "lockfilePath"]
    .some(key => (baseline[key] ?? null) !== (draft[key] ?? null));
  const bindings = items => JSON.stringify((items ?? [])
    .map(({attachmentId, relativePath}) => [relativePath, attachmentId])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const attachmentsChanged = bindings(baseline.dataAttachments) !== bindings(draft.dataAttachments);
  const references = items => JSON.stringify((items ?? [])
    .map(({referenceId, relativePath}) => [relativePath, referenceId])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const referencedFilesChanged = references(baseline.referencedFiles) !== references(draft.referencedFiles);
  return {added, changed, removed, settingsChanged, attachmentsChanged, referencedFilesChanged,
    unchanged: !added.length && !changed.length && !removed.length && !settingsChanged && !attachmentsChanged && !referencedFilesChanged};
}

async function sameFile(left, right, reuseContext) {
  const retained = canReuseDeferredObservableSourceFile(left, reuseContext) ? left
    : canReuseDeferredObservableSourceFile(right, reuseContext) ? right : null;
  if (!retained) return sameBytes(left.blob, right.blob);
  const other = retained === left ? right : left;
  if (!other.blob) return canReuseDeferredObservableSourceFile(other, reuseContext);
  if (!(other.blob instanceof Blob) || other.blob.size !== retained.sizeBytes) return false;
  const digest = await crypto.subtle.digest("SHA-256", await other.blob.arrayBuffer());
  const checksum = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return checksum === retained.checksumSha256;
}

async function sameBytes(left, right) {
  if (!(left instanceof Blob) || !(right instanceof Blob)) return false;
  if (left === right) return true;
  if (left.size !== right.size) return false;
  const a = new Uint8Array(await left.arrayBuffer());
  const b = new Uint8Array(await right.arrayBuffer());
  return a.every((byte, index) => byte === b[index]);
}
