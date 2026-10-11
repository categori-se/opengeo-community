import {normalizeObservableSourceFiles, normalizeObservableRevisionAttachments, parseDownloadTicket, publicReferencedFileUrl} from "./apiClient.js";
import {choosePublicationBackupContextPath} from "./publicationSourceArchive.js";

const FILE_LIMIT = 4_194_304, TREE_LIMIT = 16_777_216;
const PUBLIC_FILE_LIMIT = 67_108_864;
const assertCurrent = current => {if (!current()) throw new TypeError("The source draft changed during backup");};
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");

/** Only an explicit backup action reads these authorized, immutable dependencies. */
export async function readPublicationSourceBackupInputs({adapter, projectId, sourceProjectId, files,
  entryPath, dataAttachments, artifactReferences, isCurrent = () => true, onProgress = () => {}, signal}) {
  const checkCurrent = () => {signal?.throwIfAborted(); assertCurrent(isCurrent);};
  checkCurrent();
  normalizeObservableRevisionAttachments(dataAttachments, files);
  if (!artifactReferences || !Array.isArray(artifactReferences.references)
    || typeof adapter.readPublicationArtifactBackupInputs !== "function") {
    throw new TypeError("Saved map dependency metadata is unavailable; a complete backup cannot be made");
  }
  const sourceFiles = normalizeObservableSourceFiles(files);
  const registry = dataAttachments.length ? await adapter.listObservableDataAttachments(projectId, sourceProjectId) : [];
  checkCurrent();
  const resolved = await adapter.readPublicationArtifactBackupInputs(projectId, sourceProjectId,
    {expectedReferenceRevision: artifactReferences.revision, ...(signal ? {signal} : {})});
  checkCurrent();
  if (resolved.projectId !== projectId || resolved.sourceProjectId !== sourceProjectId
    || resolved.referenceRevision !== artifactReferences.revision || !Array.isArray(resolved.pins)
    || resolved.pins.length !== artifactReferences.references.length) {
    throw new TypeError("Saved map references changed during backup");
  }
  const dependencies = dataAttachments.map(binding => {
    const matches = registry.filter(item => item.id === binding.attachmentId);
    const record = matches[0];
    if (matches.length !== 1 || !record.available || record.sourceProjectId !== sourceProjectId) {
      throw new TypeError(`Archived data is unavailable for ${binding.relativePath}`);
    }
    return {kind: "data", relativePath: binding.relativePath, pin: {
      path: binding.relativePath, attachmentId: record.id, datasetId: record.datasetId,
      datasetVersionId: record.datasetVersionId, dataObjectId: record.dataObjectId,
      s3VersionId: record.s3VersionId, checksumSha256: record.checksumSha256,
      sizeBytes: record.sizeBytes, contentType: record.contentType
    }};
  });
  for (const reference of artifactReferences.references) {
    const matches = resolved.pins.filter(pin => pin.path === reference.path);
    const pin = matches[0];
    if (matches.length !== 1 || pin.artifactId !== reference.artifact_id || pin.mode !== reference.mode
      || pin.version !== reference.version || reference.mode === "pinned" && pin.resolvedVersion !== reference.version) {
      throw new TypeError("Saved map references changed during backup");
    }
    dependencies.push({kind: "artifact", relativePath: pin.path, download: pin, pin: {
      artifactId: pin.artifactId, version: pin.resolvedVersion, outputObjectId: pin.output.objectId,
      manifestChecksumSha256: pin.manifestChecksumSha256, checksumSha256: pin.output.checksumSha256,
      sizeBytes: pin.output.sizeBytes, contentType: pin.output.mediaType
    }});
  }
  // Reject unsupported/colliding paths and projected sizes before fetching bodies.
  const contextPath = choosePublicationBackupContextPath(entryPath,
    [...sourceFiles.map(file => file.relativePath), ...dependencies.map(item => item.relativePath)]);
  const layout = normalizeObservableSourceFiles([...sourceFiles, ...dependencies.map(item => ({
    relativePath: item.relativePath, contentType: item.pin.contentType, blob: new Blob(["x"])
  })), {relativePath: contextPath, contentType: "application/json", blob: new Blob(["x"])}]);
  normalizeObservableRevisionAttachments([], layout);
  if (dependencies.some(item => !Number.isSafeInteger(item.pin.sizeBytes) || item.pin.sizeBytes < 1 || item.pin.sizeBytes > FILE_LIMIT
      || !/^[0-9a-f]{64}$/.test(item.pin.checksumSha256))
    || sourceFiles.reduce((sum, item) => sum + item.blob.size, 0) + dependencies.reduce((sum, item) => sum + item.pin.sizeBytes, 0) > TREE_LIMIT) {
    throw new TypeError("Complete backup exceeds 4 MiB per file or 16 MiB total");
  }
  const fetchImplementation = adapter.fetchImplementation?.bind(adapter) ?? globalThis.fetch?.bind(globalThis);
  for (const [index, item] of dependencies.entries()) {
    checkCurrent();
    onProgress(`Reading saved dependency ${index + 1} of ${dependencies.length}: ${item.relativePath}`);
    const ticket = item.kind === "data"
      ? await adapter.requestDatasetDownload(projectId, item.pin.datasetId, item.pin.datasetVersionId, item.pin.dataObjectId)
      : await adapter.downloadPortableArtifact(item.download.projectId, item.download.resourceId, item.pin.version);
    checkCurrent();
    item.blob = await readExactDependency(ticket, item.pin, fetchImplementation, isCurrent, signal);
    delete item.download;
  }
  checkCurrent();
  return dependencies;
}

export async function readExactDependency(ticket, pin, fetchImplementation, current, signal, maxBytes = FILE_LIMIT) {
  signal?.throwIfAborted();
  if (typeof fetchImplementation !== "function") throw new TypeError("Authorized dependency downloading is unavailable");
  const checked = parseDownloadTicket({...ticket, expires_at: ticket.expiresAt});
  if (Date.parse(checked.expiresAt) <= Date.now()
    || pin.s3VersionId && new URL(checked.url).searchParams.get("versionId") !== pin.s3VersionId) {
    throw new TypeError("The exact saved dependency version is unavailable");
  }
  return readBoundedDependency(checked.url, pin, fetchImplementation, current, signal, maxBytes);
}

/** Read an exact public reference directly, without creating an archived copy. */
export async function readPublicFileDependency(record, fetchImplementation, current, signal, maxBytes = PUBLIC_FILE_LIMIT) {
  signal?.throwIfAborted();
  if (!record || record.available !== true || record.kind !== "referenced-public-file" || record.custody !== "referenced"
    || !["image/tiff", "image/geotiff"].includes(record.contentType)
    || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 1 || record.sizeBytes > PUBLIC_FILE_LIMIT
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PUBLIC_FILE_LIMIT || record.sizeBytes > maxBytes
    || !/^[0-9a-f]{64}$/.test(record.checksumSha256)) {
    throw new TypeError("The exact public TIFF dependency is unavailable or exceeds 64 MiB");
  }
  const url = publicReferencedFileUrl(record.url);
  if (typeof fetchImplementation !== "function") throw new TypeError("Public TIFF downloading is unavailable");
  assertCurrent(current);
  return readBoundedDependency(url, record, fetchImplementation, current, signal, maxBytes,
    "Could not read the public TIFF; the provider must allow anonymous browser access (CORS)");
}

async function readBoundedDependency(url, pin, fetchImplementation, current, signal, maxBytes, failureMessage) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, {once: true});
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const checkCurrent = () => {controller.signal.throwIfAborted(); assertCurrent(current);};
  let reader;
  try {
    let response;
    try {
      response = await fetchImplementation(url, {method: "GET", credentials: "omit",
        referrerPolicy: "no-referrer", redirect: "error", signal: controller.signal});
    } catch (error) {
      if (failureMessage && !controller.signal.aborted) throw new TypeError(failureMessage);
      throw error;
    }
    checkCurrent();
    if (!response.ok || !response.body?.getReader) throw new TypeError(failureMessage ?? "Could not read a saved dependency");
    const size = response.headers.get("content-length");
    if (size !== null && Number(size) !== pin.sizeBytes) throw new TypeError("Saved dependency size changed");
    reader = response.body.getReader();
    const chunks = []; let bytes = 0;
    for (;;) {
      const {done, value} = await reader.read();
      checkCurrent();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > pin.sizeBytes || bytes > maxBytes) throw new TypeError("Saved dependency exceeds its declared size");
      chunks.push(value);
    }
    const blob = new Blob(chunks, {type: pin.contentType});
    if (bytes !== pin.sizeBytes || await digest(await blob.arrayBuffer()) !== pin.checksumSha256) {
      throw new TypeError("Saved dependency checksum or size changed");
    }
    checkCurrent();
    return blob;
  } finally {
    clearTimeout(timeout); controller.abort();
    signal?.removeEventListener("abort", cancel);
    if (reader) {try {await reader.cancel();} catch { /* The original read failure remains authoritative. */ }}
  }
}
