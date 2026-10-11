import {verifyReviewedArchiveBytes} from "./archivedGeojson.js";

const LIMIT = 64 * 1024 ** 2;
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const size = value => Number.isSafeInteger(value) && value >= 1 && value <= LIMIT;

// Only invoked after explicit archive selection. Never used as a live-error handler.
export async function loadLayerArchive(options) {
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 180000;
  if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 180000) {
    throw Error("Archive read deadline is invalid.");
  }
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, {once: true});
  const timer = setTimeout(() => controller.abort(new DOMException("Archive read deadline exceeded.", "TimeoutError")), timeoutMilliseconds);
  try {return await readLayerArchive({...options, signal: controller.signal});}
  finally {clearTimeout(timer); options.signal?.removeEventListener("abort", abort);}
}

async function readLayerArchive({record, layer, signal, assertScope = async () => {},
  fetchImpl = fetch, onProgress = () => {}}) {
  if (record?.dataset_id !== layer.datasetId || record.source_version !== layer.sourceVersion
    || record.source_url !== layer.sourceUrl || record.format !== "geojson"
    || !Array.isArray(record.objects) || !record.objects.length || record.objects.length > 200) {
    throw Error("Archive no longer matches this layer. Refresh its source first.");
  }
  let bytes = 0, decodedBytes = 0, count = 0;
  const identities = new Set();
  for (const obj of record.objects) {
    const identity = JSON.stringify([obj.bucket, obj.key, obj.version_id]);
    if (identities.has(identity) || !size(obj.size_bytes) || !size(obj.decoded_size_bytes)
      || !validHash(obj.sha256) || !validHash(obj.decoded_sha256)
      || !Number.isSafeInteger(obj.feature_count) || obj.feature_count < 0
      || !["identity", "gzip"].includes(obj.encoding)) throw Error("Invalid archive inventory.");
    identities.add(identity); bytes += obj.size_bytes; decodedBytes += obj.decoded_size_bytes; count += obj.feature_count;
  }
  if (bytes > LIMIT || decodedBytes > LIMIT || count > 100000
    || bytes !== record.download_bytes || decodedBytes !== record.decoded_bytes || count !== record.feature_count) {
    throw Error("This archive needs a verified map derivative before display.");
  }
  const check = async () => {signal?.throwIfAborted(); await assertScope(); signal?.throwIfAborted();};
  const features = [];
  let downloaded = 0;
  for (const obj of record.objects) {
    await check();
    const ticket = obj.ticket, url = new URL(ticket?.url);
    if (ticket.method !== "GET" || url.origin !== "https://s3.us-east-1.amazonaws.com"
      || url.username || url.password || url.hash || !url.searchParams.has("X-Amz-Signature")
      || decodeURIComponent(url.pathname) !== `/${obj.bucket}/${obj.key}`
      || url.searchParams.get("versionId") !== obj.version_id || !obj.version_id || obj.version_id === "null"
      || !ticket.headers || Object.keys(ticket.headers).some(key => key !== "x-amz-expected-bucket-owner")
      || !/^[0-9]{12}$/.test(obj.expected_owner)
      || ticket.headers["x-amz-expected-bucket-owner"] !== obj.expected_owner) throw Error("Invalid archive read ticket.");
    const response = await fetchImpl(url.href, {method: "GET", headers: ticket.headers,
      credentials: "omit", redirect: "error", cache: "no-store", signal});
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel(); throw Error("Archived copy could not be downloaded.");
    }
    const reader = response.body.getReader(), body = new Uint8Array(obj.size_bytes);
    let received = 0;
    try {
      while (true) {
        await check();
        const {done, value} = await reader.read();
        if (done) break;
        if (received + value.byteLength > body.byteLength) throw Error("Archive size verification failed.");
        body.set(value, received); received += value.byteLength; downloaded += value.byteLength;
        onProgress({downloaded, total: bytes});
      }
    } finally {await reader.cancel().catch(() => {});}
    if (received !== body.byteLength) throw Error("Archive download was incomplete.");
    const collection = await verifyReviewedArchiveBytes(body, {sizeBytes: obj.size_bytes,
      decodedSizeBytes: obj.decoded_size_bytes, objectSha256: obj.sha256, decodedSha256: obj.decoded_sha256,
      contentEncoding: obj.encoding, featureCount: obj.feature_count, geometryType: layer.geometryType});
    await check();
    for (const feature of collection.features) features.push(feature);
  }
  const collection = {type: "FeatureCollection", features};
  Object.defineProperty(collection, "opengeo", {enumerable: false, value: Object.freeze({
    schemaVersion: "opengeo.reviewed-archive-view.1", sourceMode: "reviewed-archive",
    archiveId: record.id, capturedAt: record.captured_at, authoritativeUrl: record.source_url,
    sourceVersion: record.source_version, attribution: record.attribution,
    unlocatedFeatureCount: features.filter(feature => feature.geometry === null || feature.geometry?.coordinates?.length === 0).length,
    rights: structuredClone(record.rights ?? {}), provenance: structuredClone(record.provenance ?? {}),
    objects: record.objects.map(({bucket, key, version_id, sha256, decoded_sha256}) =>
      Object.freeze({bucket, key, versionId: version_id, sha256, decodedSha256: decoded_sha256}))
  })});
  return collection;
}
