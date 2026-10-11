import {publicItemUrl, itemBounds} from "./staticItemSearch.js";

export const COG_PREVIEW_LIMITS = Object.freeze({requests: 16, bytes: 4 * 1024 * 1024,
  milliseconds: 30_000, width: 512, images: 16, sourcePixels: 1024 * 1024});
let libraries;
const loadLibraries = () => libraries ??= Promise.all([
  import("./cogReaderAsset.js").then(module => module.loadCogReader()), import("proj4")])
  .then(([tiff, projection]) => ({...tiff, proj4: projection.default ?? projection}));
function failure(message) {return Object.assign(new Error(message), {code: "cog_preview_unavailable"});}
function mercatorY(latitude) {return Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360));}
function latitudeAt(y) {return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;}
function projectionFor(keys) {
  if (keys.GeographicTypeGeoKey === 4326 && !keys.ProjectedCSTypeGeoKey) return "EPSG:4326";
  if (keys.ProjectedCSTypeGeoKey === 3857) return "EPSG:3857";
  const epsg = keys.ProjectedCSTypeGeoKey;
  if (Number.isInteger(epsg) && (epsg >= 32601 && epsg <= 32660 || epsg >= 32701 && epsg <= 32760)) {
    return `+proj=utm +zone=${epsg % 100} ${epsg >= 32701 ? "+south " : ""}+datum=WGS84 +units=m +no_defs`;
  }
  throw failure("This COG's projection is unsupported. Its reference is preserved; WGS84, Web Mercator and WGS84 UTM are supported.");
}

// Read a bounded current-view raster directly from its public COG. No HEAD,
// full-file fallback, worker pool, persistent copy or provider polling.
export async function readCogPreview(source, {bounds = source.configuration.bounds, signal,
  fetchImplementation = globalThis.fetch, libraryLoader = loadLibraries, onStatus = () => {}} = {}) {
  const url = publicItemUrl(source.sourceUrl), parsed = new URL(url), config = source.configuration;
  if (parsed.search || !/\.tiff?$/i.test(parsed.pathname)) throw failure("A query-free public TIFF reference is required.");
  const bbox = itemBounds(bounds);
  if (bbox[1] <= -85 || bbox[3] >= 85) throw failure("This MapLibre preview supports latitudes between 85° south and north.");
  const bands = config.bands;
  if (!Array.isArray(bands) || ![1, 3].includes(bands.length) || bands.some(band => !Number.isInteger(band) || band < 1 || band > 64)) throw failure("Select one or three one-based display bands.");
  const controller = new AbortController(), abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, {once: true});
  const timer = setTimeout(() => controller.abort(failure("COG preview time limit reached.")), COG_PREVIEW_LIMITS.milliseconds);
  const usage = {requests: 0, bytes: 0, reservedBytes: 0}, begin = performance.now();
  let size = config.sizeBytes ?? null, etag = null, tiff, snapshotVerified = true, rangeHeadersExposed = true;
  const active = new Set();
  const client = {url, async request(options) {
    controller.signal.throwIfAborted();
    const range = new Headers(options.headers).get("range"), match = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
    if (!match) throw failure("The COG reader requested an unsupported byte range.");
    const start = Number(match[1]), end = Number(match[2]);
    const length = (size === null ? end : Math.min(end, size - 1)) - start + 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || length <= 0
      || usage.requests >= COG_PREVIEW_LIMITS.requests || usage.reservedBytes + length > COG_PREVIEW_LIMITS.bytes) {
      throw failure("COG preview request or byte limit reached. Narrow the map view before refreshing.");
    }
    usage.requests++; usage.reservedBytes += length;
    const operation = (async () => {
      const response = await fetchImplementation(url, {signal: controller.signal, credentials: "omit", redirect: "error",
        cache: "no-store", referrerPolicy: "no-referrer", headers: {Range: range}});
      const contentRange = response.headers.get("content-range"), observedEtag = response.headers.get("etag");
      const header = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? "");
      // Some public S3 CORS policies expose neither range nor ETag headers. A
      // known-size asset can still use 206 plus exact Content-Length and bounded
      // body checks. This view explicitly cannot verify an atomic snapshot.
      const hiddenRange = contentRange === null && Number.isSafeInteger(size) && size > 0
        && response.headers.get("content-length") === String(length);
      if (response.status !== 206 || !header && !hiddenRange
        || header && (Number(header[1]) !== start || Number(header[2]) !== Math.min(end, Number(header[3]) - 1)
          || size !== null && Number(header[3]) !== size)
        || etag && etag !== observedEtag) {
        await response.body?.cancel(); throw failure("The COG range or snapshot is unavailable. No whole imagery download was used.");
      }
      if (header) size = Number(header[3]); else rangeHeadersExposed = false;
      if (!observedEtag) snapshotVerified = false; else etag = observedEtag;
      if (!header) snapshotVerified = false;
      const reader = response.body.getReader(), chunks = []; let bytes = 0;
      try {
        while (true) {
          const {done, value} = await reader.read(); if (done) break;
          bytes += value.byteLength; usage.bytes += value.byteLength;
          if (bytes > length || usage.bytes > COG_PREVIEW_LIMITS.bytes) throw failure("COG preview byte limit reached.");
          chunks.push(value);
        }
      } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
      if (bytes !== length) throw failure("The COG byte range was truncated.");
      const buffer = new Uint8Array(bytes); let offset = 0;
      for (const chunk of chunks) {buffer.set(chunk, offset); offset += chunk.byteLength;}
      return {ok: true, status: 206, getHeader: name => name.toLowerCase() === "content-range" && !header
        ? `bytes ${start}-${start + bytes - 1}/${size}` : response.headers.get(name), getData: async () => buffer.buffer};
    })();
    active.add(operation);
    try {return await operation;}
    catch (error) {controller.abort(error); throw error;}
    finally {active.delete(operation);}
  }};
  try {
    controller.signal.throwIfAborted();
    onStatus("Reading COG metadata…");
    const reader = await libraryLoader(); controller.signal.throwIfAborted();
    tiff = await reader.fromCustomClient(client, {allowFullFile: false, blockSize: 65536, cacheSize: 64, maxRanges: 0}, controller.signal);
    const main = await tiff.getImage(0), imageCount = await tiff.getImageCount();
    if (imageCount > COG_PREVIEW_LIMITS.images) throw failure("The COG has too many image directories for this preview.");
    const matrix = main.fileDirectory.getValue("ModelTransformation");
    if (matrix && (matrix[1] !== 0 || matrix[4] !== 0)) throw failure("Rotated TIFF grids are retained but unsupported by this preview.");
    const transform = reader.proj4("EPSG:4326", projectionFor(main.getGeoKeys()));
    const origin = main.getOrigin(), resolution = main.getResolution();
    if (!origin.every(Number.isFinite) || !resolution.every(Number.isFinite) || resolution[0] <= 0 || resolution[1] >= 0) throw failure("A north-up georeferenced COG is required.");
    const positions = [[bbox[0], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[1]], [bbox[2], bbox[3]],
      [(bbox[0] + bbox[2]) / 2, bbox[1]], [(bbox[0] + bbox[2]) / 2, bbox[3]], [bbox[0], (bbox[1] + bbox[3]) / 2], [bbox[2], (bbox[1] + bbox[3]) / 2]]
      .map(point => transform.forward(point));
    const pixelBounds = [Math.max(0, Math.floor(Math.min(...positions.map(p => (p[0] - origin[0]) / resolution[0])))),
      Math.max(0, Math.floor(Math.min(...positions.map(p => (p[1] - origin[1]) / resolution[1])))),
      Math.min(main.getWidth(), Math.ceil(Math.max(...positions.map(p => (p[0] - origin[0]) / resolution[0])))),
      Math.min(main.getHeight(), Math.ceil(Math.max(...positions.map(p => (p[1] - origin[1]) / resolution[1]))))];
    if (pixelBounds[0] >= pixelBounds[2] || pixelBounds[1] >= pixelBounds[3]) throw failure("The current view does not intersect the raster grid.");
    const targetScale = Math.max((pixelBounds[2] - pixelBounds[0]) / 512, (pixelBounds[3] - pixelBounds[1]) / 512, 1);
    let image = main, scaleX = 1, scaleY = 1;
    for (let index = 1; index < imageCount; index++) {
      const candidate = await tiff.getImage(index), candidateScale = main.getWidth() / candidate.getWidth();
      if (candidateScale <= targetScale && candidateScale > scaleX) {image = candidate; scaleX = candidateScale; scaleY = main.getHeight() / candidate.getHeight();}
    }
    const window = [Math.floor(pixelBounds[0] / scaleX), Math.floor(pixelBounds[1] / scaleY), Math.ceil(pixelBounds[2] / scaleX), Math.ceil(pixelBounds[3] / scaleY)];
    if ((window[2] - window[0]) * (window[3] - window[1]) > COG_PREVIEW_LIMITS.sourcePixels) throw failure("The source has insufficient bounded overviews. Zoom in before refreshing.");
    if (bands.some(band => band > image.getSamplesPerPixel())) throw failure("The selected display band is unavailable.");
    const bits = image.getBitsPerSample(), maximum = image.getSampleFormat() !== 1 ? null : bits === 8 ? 255 : bits === 16 ? 65535 : null;
    if (maximum === null) throw failure("This preview currently supports unsigned 8-bit and 16-bit display samples.");
    onStatus("Reading the selected raster window…");
    const rasters = await image.readRasters({window, samples: bands.map(band => band - 1), signal: controller.signal,
      width: 512, height: 512, resampleMethod: "nearest"});
    controller.signal.throwIfAborted();
    const pixels = new Uint8ClampedArray(512 * 512 * 4), northY = mercatorY(bbox[3]), southY = mercatorY(bbox[1]);
    const nodata = Number.parseFloat(main.fileDirectory.getValue("GDAL_NODATA"));
    onStatus("Projecting raster pixels for the map…");
    for (let y = 0; y < 512; y++) {
      if (y % 64 === 0) {await new Promise(resolve => setTimeout(resolve, 0)); controller.signal.throwIfAborted();}
      const latitude = latitudeAt(northY + (southY - northY) * (y + 0.5) / 512);
      for (let x = 0; x < 512; x++) {
        const point = transform.forward([bbox[0] + (bbox[2] - bbox[0]) * (x + 0.5) / 512, latitude]);
        const px = ((point[0] - origin[0]) / resolution[0] / scaleX - window[0]) * 512 / (window[2] - window[0]);
        const py = ((point[1] - origin[1]) / resolution[1] / scaleY - window[1]) * 512 / (window[3] - window[1]);
        if (px < 0 || py < 0 || px >= 512 || py >= 512) continue;
        const index = Math.floor(py) * 512 + Math.floor(px), values = rasters.map(raster => raster[index]);
        if (values.some(value => !Number.isFinite(value)) || Number.isFinite(nodata) && values.every(value => value === nodata)) continue;
        const output = (y * 512 + x) * 4;
        for (let channel = 0; channel < 3; channel++) pixels[output + channel] = Math.round(values[Math.min(channel, values.length - 1)] / maximum * 255);
        pixels[output + 3] = 255;
      }
    }
    return {width: 512, height: 512, pixels, coordinates: [[bbox[0], bbox[3]], [bbox[2], bbox[3]], [bbox[2], bbox[1]], [bbox[0], bbox[1]]],
      bounds: bbox, snapshot: {url, etag, size, verified: snapshotVerified, rangeHeadersExposed}, usage, sourceWindow: window, overviewScale: scaleX,
      display: "bounded-current-view", custody: "referenced"};
  } finally {
    controller.abort(); clearTimeout(timer); signal?.removeEventListener("abort", abort);
    await Promise.allSettled([...active]); await tiff?.close(); usage.milliseconds = Math.round(performance.now() - begin);
  }
}

export function cogPreviewCanvas(result) {
  const canvas = document.createElement("canvas"); canvas.width = result.width; canvas.height = result.height;
  canvas.getContext("2d").putImageData(new ImageData(result.pixels, result.width, result.height), 0, 0);
  return canvas;
}
