import {COG_PREVIEW_LIMITS, readAuthorizedCogPreview, releaseCogPreview} from "./cogPreview.js";
import {itemBounds} from "./staticItemSearch.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function unavailable(message = "The exact managed COG could not be read. Refresh deliberately after checking access and the selected version.") {
  return Object.assign(new Error(message), {code: "managed_cog_unavailable"});
}
function safeError(error, signal) {
  // Network, adapter and decoder errors can contain a private download URL.
  // Do not retain their text, cause, request, response or abort reason.
  if (signal?.aborted) {
    return new DOMException("The managed COG read was cancelled or exceeded its time limit.", "AbortError");
  }
  return unavailable();
}
function displayBands(value) {
  if (!Array.isArray(value) || ![1, 3].includes(value.length)
    || value.some(band => !Number.isInteger(band) || band < 1 || band > 64)) throw unavailable();
  return [...value];
}
function text(value) {return typeof value === "string" && value.length <= 8192 ? value : null;}

function exactTicket(ticket, datasetId, filename) {
  const url = new URL(ticket.url), allowed = new Set(["X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-Date",
    "X-Amz-Expires", "X-Amz-Security-Token", "X-Amz-SignedHeaders", "X-Amz-Signature",
    "response-content-disposition", "versionId"]);
  const required = [...allowed].filter(key => key !== "X-Amz-Security-Token");
  const expiry = Date.parse(ticket.expiresAt), seconds = Number(url.searchParams.get("X-Amz-Expires"));
  const path = decodeURIComponent(url.pathname).split("/");
  const index = path.indexOf("datasets");
  if (ticket.method !== "GET" || url.origin !== "https://s3.us-east-1.amazonaws.com"
    || url.username || url.password || url.hash || url.port || index < 2 || path[index + 1] !== datasetId
    || path.some(part => part === "." || part === ".." || part.includes("\\"))
    || [...url.searchParams.keys()].some(key => !allowed.has(key))
    || required.some(key => url.searchParams.getAll(key).length !== 1)
    || url.searchParams.getAll("X-Amz-Security-Token").length > 1
    || url.searchParams.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256"
    || url.searchParams.get("X-Amz-SignedHeaders") !== "host"
    || !/^[0-9a-f]{64}$/.test(url.searchParams.get("X-Amz-Signature") ?? "")
    || !url.searchParams.get("versionId") || url.searchParams.get("versionId") === "null"
    || url.searchParams.get("response-content-disposition") !== `attachment; filename="${filename}"`
    || !Number.isSafeInteger(seconds) || seconds < 60 || seconds > 900
    || !Number.isFinite(expiry) || expiry <= Date.now()) throw unavailable();
  return {url: url.href, expiry};
}

/** Resolve one exact active managed original. A binding retains no credentials or
 * ticket. Each explicit read reauthorizes and obtains one immutable S3-version
 * ticket. Only the bounded range decoder sees bytes; no whole-file fallback or
 * checksum verification is implied by a partial read.
 */
export async function loadManagedCogData({adapter, projectId, datasetId, versionId,
  assertScope = async () => {}, authorize = assertScope, fetchImpl = globalThis.fetch,
  signal, bands = [1], attribution = null, license = null, libraryLoader} = {}) {
  const check = async requestSignal => {requestSignal?.throwIfAborted(); await assertScope(); requestSignal?.throwIfAborted();};
  try {
    if (![projectId, datasetId, versionId].every(id => UUID.test(id ?? ""))
      || typeof adapter?.listDatasetVersions !== "function" || typeof adapter.requestDatasetDownload !== "function"
      || typeof fetchImpl !== "function") throw unavailable();
    await check(signal);
    let version;
    for (let offset = 0; offset < 1000; offset += 100) {
      const versions = await adapter.listDatasetVersions(projectId, datasetId, {limit: 100, offset});
      await check(signal);
      if (!Array.isArray(versions) || versions.length > 100) throw unavailable();
      version = versions.find(candidate => candidate.id === versionId);
      if (version || versions.length < 100) break;
    }
    const originals = version?.objects?.filter(object => object.role === "original") ?? [];
    if (version?.state !== "active" || !Number.isSafeInteger(version.versionNumber) || version.versionNumber < 1
      || String(version.geometryType).toLowerCase() !== "raster" || originals.length !== 1
      || version.format != null && version.format !== "cog"
      || !version.qualityResults?.checks?.some(check => check.code === "cog_layout_verified" && check.status === "passed")) {
      throw unavailable();
    }
    const object = originals[0];
    if (!UUID.test(object.id ?? "") || typeof object.filename !== "string" || object.filename.length > 180
      || !/^[a-z0-9_][a-z0-9._ -]*\.tiff?$/i.test(object.filename)
      || object.contentType !== "image/tiff" || !Number.isSafeInteger(object.sizeBytes) || object.sizeBytes < 1) throw unavailable();
    const bounds = itemBounds(version.extent), configuredBands = displayBands(bands);
    const sourceUrl = `urn:opengeo:dataset:${datasetId}:version:${versionId}:original`;
    const configuration = {bounds: [...bounds], bands: [...configuredBands], sizeBytes: object.sizeBytes,
      ...(text(attribution) !== null ? {attribution: text(attribution)} : {}),
      ...(text(license) !== null ? {license: text(license)} : {})};
    // Copy selected metadata: later mutation of an adapter response cannot change
    // which exact object this binding authorizes.
    const objectId = object.id, filename = object.filename, sizeBytes = object.sizeBytes;
    const source = {sourceUrl, configuration};
    return {datasetId, datasetVersionId: versionId, objectId, versionNumber: version.versionNumber,
      source, async read(requestedSource, options = {}) {
        // The initial resolution signal is intentionally not captured here.
        const deadline = AbortSignal.timeout(COG_PREVIEW_LIMITS.milliseconds);
        const requestSignal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
        let result;
        try {
          await check(requestSignal);
          if (requestedSource?.sourceUrl !== sourceUrl) throw unavailable();
          await authorize(); await check(requestSignal);
          const ticket = exactTicket(await adapter.requestDatasetDownload(projectId, datasetId, versionId, objectId), datasetId, filename);
          await check(requestSignal);
          const current = async () => {
            try {await check(requestSignal); if (Date.now() >= ticket.expiry) throw unavailable();}
            catch {throw unavailable();}
          };
          const privateFetch = async (identity, request) => {
            await current();
            if (identity !== sourceUrl) throw unavailable();
            let response;
            try {response = await fetchImpl(ticket.url, {...request, method: "GET", credentials: "omit",
              redirect: "error", cache: "no-store", referrerPolicy: "no-referrer"});}
            catch {throw unavailable();}
            try {
              await current();
              if (response.url && response.url !== ticket.url || response.redirected) throw unavailable();
            } catch (error) {await response.body?.cancel(); throw error;}
            return response;
          };
          const presented = requestedSource.configuration ?? {};
          const readSource = {sourceUrl, configuration: {bounds: [...bounds], sizeBytes,
            bands: displayBands(presented.bands ?? configuredBands),
            attribution: text(presented.attribution ?? configuration.attribution),
            license: text(presented.license ?? configuration.license)}};
          result = await readAuthorizedCogPreview(readSource, {...options, signal: requestSignal,
            fetchImplementation: privateFetch, assertCurrent: current,
            ...(libraryLoader ? {libraryLoader} : {})});
          await authorize(); await current();
          return result;
        } catch (error) {releaseCogPreview(result); throw safeError(error, requestSignal);}
      }};
  } catch (error) {throw safeError(error, signal);}
}
