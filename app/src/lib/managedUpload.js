export const MANAGED_FORMATS = Object.freeze({
  kml: Object.freeze({label: "KML source", extensions: [".kml"], contentType: "application/vnd.google-earth.kml+xml"}),
  geojson: Object.freeze({label: "GeoJSON", extensions: [".geojson", ".json"], contentType: "application/geo+json"}),
  csv: Object.freeze({label: "CSV", extensions: [".csv"], contentType: "text/csv"}),
  shapefile: Object.freeze({label: "Shapefile ZIP", extensions: [".zip"], contentType: "application/zip"}),
  geopackage: Object.freeze({label: "GeoPackage", extensions: [".gpkg"], contentType: "application/geopackage+sqlite3"}),
  geoparquet: Object.freeze({label: "GeoParquet", extensions: [".parquet", ".geoparquet"], contentType: "application/vnd.apache.parquet"}),
  cog: Object.freeze({label: "Cloud-optimized GeoTIFF", extensions: [".tif", ".tiff"], contentType: "image/tiff"}),
  pmtiles: Object.freeze({label: "PMTiles", extensions: [".pmtiles"], contentType: "application/vnd.pmtiles"}),
  png: Object.freeze({label: "PNG image", extensions: [".png"], contentType: "image/png"}),
  jpeg: Object.freeze({label: "JPEG image", extensions: [".jpg", ".jpeg"], contentType: "image/jpeg"}),
  pdf: Object.freeze({label: "PDF document", extensions: [".pdf"], contentType: "application/pdf"}),
  odt: Object.freeze({label: "OpenDocument text", extensions: [".odt"], contentType: "application/vnd.oasis.opendocument.text"})
});

export const MANAGED_FILE_ACCEPT = Object.values(MANAGED_FORMATS)
  .flatMap((definition) => definition.extensions)
  .join(",");

export const MANAGED_UPLOAD_ERROR_MESSAGES = Object.freeze({
  upload_size_exceeds_limit: "The file exceeds this deployment's upload limit.",
  upload_ticket_unresolved: "The source registration response was lost. Check the catalog before starting another upload.",
  upload_expired: "The signed upload expired. Choose the file and try again.",
  upload_object_missing: "S3 did not report the uploaded object. Try the upload again.",
  upload_verification_failed: "The uploaded object's size, type, or checksum did not match the request.",
  signed_upload_failed: "S3 rejected the signed upload.",
  upload_network_unavailable: "The signed S3 destination could not be reached.",
  upload_storage_unavailable: "Managed upload storage is temporarily unavailable.",
  ingestion_store_unavailable: "The dataset catalog is temporarily unavailable.",
  action_forbidden: "Your role cannot upload datasets to this project.",
  http_422: "The file metadata is not accepted for the selected format."
});

export async function ingestManagedFile(options) {
  return createManagedUploadSession(options).run();
}

// Deliberate recovery only: no new registration, no policy persistence and no polling.
export async function resumeManagedUpload({adapter, projectId, uploadId, file, checksumSha256}) {
  try {return await adapter.completeUpload(projectId, uploadId);}
  catch (error) {
    if (!["upload_expired", "upload_object_missing"].includes(error?.code)) throw error;
  }
  if (typeof adapter.renewUpload !== "function") throw codedError("upload_expired");
  let ticket;
  try {ticket = await adapter.renewUpload(projectId, uploadId);}
  catch (error) {
    if (error?.code === "upload_already_completed") return adapter.completeUpload(projectId, uploadId);
    throw error;
  }
  if (ticket.uploadId !== uploadId) throw codedError("upload_verification_failed");
  // Expiry does not tell us whether storage accepted bytes before the interruption.
  try {return await adapter.completeUpload(projectId, uploadId);}
  catch (error) {if (error?.code !== "upload_object_missing") throw error;}
  if (!(file instanceof Blob) || !/^[a-f0-9]{64}$/.test(checksumSha256 ?? "")
    || await sha256Hex(file) !== checksumSha256) throw codedError("upload_verification_failed");
  const expires = Date.parse(ticket.expiresAt);
  if (!Number.isFinite(expires) || expires <= Date.now()) throw codedError("upload_expired");
  await adapter.uploadFile(ticket.upload, file);
  return adapter.completeUpload(projectId, uploadId);
}

// Keep this session in the owning registration dialog; never serialize its signed policy.
export function createManagedUploadSession({
  adapter, projectId, file, name = fileBaseName(file?.name), description = null,
  classification = "internal", format = inferManagedFormat(file?.name), tags = ["opened-locally"],
  purpose = "ingest",
  onStage = () => {}, assertCurrentScope = async () => {}, stagedTarget = null,
  beforeRequest = async () => {}, onTicket = async () => {}
}) {
  if (!adapter || typeof adapter.requestUpload !== "function"
    || typeof adapter.uploadFile !== "function" || typeof adapter.completeUpload !== "function") {
    throw codedError("managed_upload_unavailable");
  }
  const definition = validateManagedUpload({file, name, format, purpose, stagedTarget});
  const normalized = normalizeManagedTags(tags);
  const metadata = {name: name.trim(), description: description?.trim() || null, classification,
    format, filename: file.name, contentType: definition.contentType, sizeBytes: file.size, tags: normalized,
    ...(purpose !== "ingest" ? {purpose} : {}),
    ...(stagedTarget ? {targetDatasetId: stagedTarget.datasetId, expectedBaseVersionId: stagedTarget.baseVersionId} : {})};
  let checksumSha256, ticket, completion, inFlight;
  let requestStarted = false, uploadAttempted = false, uploaded = false;
  const execute = async () => {
    await assertCurrentScope();
    if (completion) return completion;
    if (!checksumSha256) {onStage("hashing", "Hashing the source file locally…"); checksumSha256 = await sha256Hex(file);}
    if (!ticket) {
      if (requestStarted) throw codedError("upload_ticket_unresolved");
      await assertCurrentScope();
      onStage("requesting", "Requesting a short-lived exact S3 upload policy…");
      await beforeRequest({checksumSha256});
      requestStarted = true;
      ticket = await adapter.requestUpload(projectId, {...metadata, checksumSha256});
    }
    if ((ticket.purpose ?? "ingest") !== purpose) throw codedError("upload_verification_failed");
    await onTicket({uploadId: ticket.uploadId});
    await assertCurrentScope();
    // An upload response can be lost after S3 accepted the file. Verify before any repeat POST.
    if (uploadAttempted && !uploaded) {
      try {return finish(await adapter.completeUpload(projectId, ticket.uploadId));}
      catch (error) {
        if (error?.code !== "upload_object_missing") throw error;
        uploadAttempted = false;
      }
    }
    if (!uploaded) {
      const expires = Date.parse(ticket.expiresAt);
      if (!Number.isFinite(expires) || expires <= Date.now()) throw codedError("upload_expired");
      await assertCurrentScope();
      onStage("uploading", "Uploading directly to encrypted managed storage…");
      uploadAttempted = true;
      await adapter.uploadFile(ticket.upload, file);
      uploaded = true;
    }
    await assertCurrentScope();
    onStage("verifying", purpose === "pmtiles_original" ? "Verifying the preserved original…" : "Verifying the immutable object and queuing inspection…");
    return finish(await adapter.completeUpload(projectId, ticket.uploadId));
  };
  function finish(result) {
    if ((result.purpose ?? "ingest") !== purpose) throw codedError("upload_verification_failed");
    completion = result;
    if (result.purpose === "pmtiles_original") onStage("preserved", `${result.dataset.name} is preserved as version ${result.versionNumber}. Create PMTiles to make a map display.`);
    else onStage("queued", `${result.dataset.name} is queued as version ${result.versionNumber}.`);
    return completion;
  }
  return {
    run() {
      if (!inFlight) inFlight = execute().finally(() => {inFlight = null;});
      return inFlight;
    },
    get checksumSha256() {return checksumSha256;},
    get datasetId() {return completion?.dataset?.id ?? ticket?.dataset?.id ?? null;}
  };
}

export function validateManagedUpload({file, name, format, purpose = "ingest", stagedTarget = null}) {
  if (!(file instanceof Blob) || file.size < 1 || typeof file.name !== "string") {
    throw codedError("http_422");
  }
  if (typeof name !== "string" || !name.trim()) throw codedError("http_422");
  if (!["ingest", "pmtiles_original"].includes(purpose)) throw codedError("http_422");
  if (purpose === "pmtiles_original") {
    if (format !== "geojson" || stagedTarget != null) throw codedError("http_422");
    if (file.size > 512 * 1024 * 1024) throw codedError("upload_size_exceeds_limit");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{2,254}$/.test(file.name)) throw codedError("http_422");
  if (format === "kml" && file.size > 4 * 1024 * 1024) throw codedError("upload_size_exceeds_limit");
  const definition = MANAGED_FORMATS[format];
  if (!definition
    || !definition.extensions.some((extension) => file.name.toLowerCase().endsWith(extension))) {
    throw codedError("http_422");
  }
  return definition;
}

export function normalizeManagedTags(value) {
  const source = Array.isArray(value) ? value : String(value ?? "").split(",");
  const tags = source.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean);
  const unique = [...new Set(tags)];
  if (unique.length > 12 || unique.some((tag) => tag.length > 64)) throw codedError("http_422");
  return unique;
}

export async function sha256Hex(file) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function inferManagedFormat(filename) {
  const normalized = String(filename ?? "").toLowerCase();
  return Object.entries(MANAGED_FORMATS)
    .find(([, definition]) => definition.extensions.some((extension) => normalized.endsWith(extension)))?.[0] ?? null;
}

export function fileBaseName(filename) {
  return String(filename ?? "").replace(/\.[^.]+$/, "").trim();
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
