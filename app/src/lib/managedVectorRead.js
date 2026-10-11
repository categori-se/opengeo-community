import {verifyReviewedArchiveBytes} from "./archivedGeojson.js";

const MAX_BYTES = 64 * 1024 ** 2;
const GEOMETRIES = new Set(["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"]);

/** Explicit map-layer activation, never catalog inspection or live-provider fallback.
 * Uses the existing exact-version download authorization; no upload or build occurs.
 */
export async function loadManagedVectorData({adapter, projectId, datasetId, versionId,
  geometryType, assertScope = async () => {}, authorize = assertScope,
  fetchImpl = globalThis.fetch, signal}) {
  const check = async () => {signal?.throwIfAborted(); await assertScope(); signal?.throwIfAborted();};
  await check();
  const boundedPreview = () => adapter.getDatasetSpatialPreview(projectId, datasetId, versionId);
  if (typeof adapter.listDatasetVersions !== "function" || typeof adapter.requestDatasetDownload !== "function") {
    return boundedPreview();
  }
  let version;
  for (let offset = 0; offset < 1000; offset += 100) {
    const versions = await adapter.listDatasetVersions(projectId, datasetId, {limit: 100, offset});
    await check();
    version = versions.find(candidate => candidate.id === versionId);
    if (version || versions.length < 100) break;
  }
  if (!version || version.state !== "active") throw Error("The selected dataset version is unavailable.");
  const family = String(geometryType ?? version.geometryType).replace(/^3D /, "").replace(/ ?Z$/, "");
  const originals = version.objects.filter(object => object.role === "original"
    && /\.geojson$/i.test(object.filename) && ["application/geo+json", "application/json"].includes(object.contentType));
  // Other formats keep their existing bounded preview. Never reinterpret a file
  // or remove its limits to make an incomplete view appear complete.
  if (originals.length !== 1 || !["EPSG:4326", "EPSG:4979"].includes(version.crs) || !GEOMETRIES.has(family)
    || !Number.isSafeInteger(version.featureCount) || version.featureCount < 0 || version.featureCount > 100000) {
    return boundedPreview();
  }
  const object = originals[0];
  if (!Number.isSafeInteger(object.sizeBytes) || object.sizeBytes < 1 || object.sizeBytes > MAX_BYTES
    || !/^[a-f0-9]{64}$/.test(object.checksumSha256)) throw Error("This dataset needs a reviewed tiled representation for map display.");
  // Read eligible GeoJSON from its exact authorized original even below the
  // preview threshold. Worker previews may retain provider extension headers
  // that the narrower preview API rejects (for example Overpass exports).
  // This path keeps those headers and verifies the complete registered bytes.
  await authorize(); await check();
  const ticket = await adapter.requestDatasetDownload(projectId, datasetId, versionId, object.id);
  await check();
  const url = new URL(ticket.url);
  if (ticket.method !== "GET" || url.origin !== "https://s3.us-east-1.amazonaws.com"
    || url.username || url.password || url.hash || !url.searchParams.has("X-Amz-Signature")
    || !url.searchParams.get("versionId") || url.searchParams.get("versionId") === "null"
    || !decodeURIComponent(url.pathname).includes(`/datasets/${datasetId}/`)
    || !Number.isFinite(Date.parse(ticket.expiresAt)) || Date.parse(ticket.expiresAt) <= Date.now()) {
    throw Error("The exact-version download ticket is invalid.");
  }
  const deadline = AbortSignal.timeout(90000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const response = await fetchImpl(url.href, {method: "GET", credentials: "omit", cache: "no-store",
    redirect: "error", referrerPolicy: "no-referrer", signal: requestSignal});
  if (response.status !== 200 || !response.body || (response.url && response.url !== url.href)) {
    await response.body?.cancel(); throw Error("The selected dataset could not be read.");
  }
  const bytes = new Uint8Array(object.sizeBytes), reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      await check(); requestSignal.throwIfAborted();
      const {done, value} = await reader.read();
      if (done) break;
      if (received + value.byteLength > bytes.byteLength) throw Error("Dataset exceeded its registered size.");
      bytes.set(value, received); received += value.byteLength;
    }
  } finally {await reader.cancel().catch(() => {});}
  if (received !== bytes.byteLength) throw Error("Dataset download was incomplete.");
  const geojson = await verifyReviewedArchiveBytes(bytes, {sizeBytes: bytes.byteLength,
    decodedSizeBytes: bytes.byteLength, objectSha256: object.checksumSha256, decodedSha256: object.checksumSha256,
    contentEncoding: "identity", featureCount: version.featureCount, geometryType: family}, {allowNestedProperties: true, allowCaptureMetadata: true});
  await authorize(); await check();
  return {schemaVersion: "opengeo.managed-vector-data.1", datasetVersionId: versionId,
    numberReturned: geojson.features.length, numberMatched: version.featureCount, mayBeTruncated: false, geojson};
}
