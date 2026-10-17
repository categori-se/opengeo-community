import {publicItemUrl, itemBounds} from "./staticItemSearch.js";

export const COG_PREVIEW_LIMITS = Object.freeze({requests: 16, bytes: 4 * 1024 * 1024,
  milliseconds: 30_000, width: 512, images: 16, sourcePixels: 1024 * 1024, sampleBytes: 8 * 1024 * 1024});
const sampleWindows = new WeakMap();
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
  displayRange = null, noDataValue = null,
  fetchImplementation = globalThis.fetch, libraryLoader = loadLibraries, onStatus = () => {}} = {}) {
  const url = publicItemUrl(source.sourceUrl), parsed = new URL(url), config = source.configuration;
  if (parsed.search || !/\.tiff?$/i.test(parsed.pathname)) throw failure("A query-free public TIFF reference is required.");
  const bbox = itemBounds(bounds);
  if (bbox[1] <= -85 || bbox[3] >= 85) throw failure("This MapLibre preview supports latitudes between 85° south and north.");
  const bands = config.bands;
  if (!Array.isArray(bands) || ![1, 3].includes(bands.length) || bands.some(band => !Number.isInteger(band) || band < 1 || band > 64)) throw failure("Select one or three one-based display bands.");
  if (displayRange !== null && (bands.length !== 1 || !Number.isFinite(displayRange.minimum)
    || !Number.isFinite(displayRange.maximum) || displayRange.minimum >= displayRange.maximum
    || !Number.isFinite(displayRange.maximum - displayRange.minimum))) {
    throw failure("Choose a finite minimum below the maximum for a one-band raster display.");
  }
  if (noDataValue !== null && (bands.length !== 1 || !Number.isFinite(noDataValue))) {
    throw failure("The optional transparent value must be finite and apply to one band.");
  }
  // Display choices are read options, never changes to the Layer's
  // source configuration or the provider's values and NoData declaration.
  const range = displayRange === null ? null : {minimum: displayRange.minimum, maximum: displayRange.maximum};
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
    const keys = main.getGeoKeys(), projection = projectionFor(keys);
    const transform = reader.proj4("EPSG:4326", projection);
    const origin = main.getOrigin(), resolution = main.getResolution();
    if (!origin.every(Number.isFinite) || !resolution.every(Number.isFinite) || resolution[0] <= 0 || resolution[1] >= 0) throw failure("A north-up georeferenced COG is required.");
    const tie = main.fileDirectory.getValue("ModelTiepoint");
    if (!matrix && tie?.length === 6) {origin[0] -= tie[0] * resolution[0];origin[1] -= tie[1] * resolution[1];}
    // GeoTIFF point tie coordinates locate the sample center (GDAL RFC33).
    // Normalize to the corner convention shared by rendering and Identify.
    const pixelIsPoint = keys.GTRasterTypeGeoKey === 2;
    if (pixelIsPoint) {origin[0] -= resolution[0] / 2;origin[1] -= resolution[1] / 2;}
    const positions = [[bbox[0], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[1]], [bbox[2], bbox[3]],
      [(bbox[0] + bbox[2]) / 2, bbox[1]], [(bbox[0] + bbox[2]) / 2, bbox[3]], [bbox[0], (bbox[1] + bbox[3]) / 2], [bbox[2], (bbox[1] + bbox[3]) / 2]]
      .map(point => transform.forward(point));
    const pixelBounds = [Math.max(0, Math.floor(Math.min(...positions.map(p => (p[0] - origin[0]) / resolution[0])))),
      Math.max(0, Math.floor(Math.min(...positions.map(p => (p[1] - origin[1]) / resolution[1])))),
      Math.min(main.getWidth(), Math.ceil(Math.max(...positions.map(p => (p[0] - origin[0]) / resolution[0])))),
      Math.min(main.getHeight(), Math.ceil(Math.max(...positions.map(p => (p[1] - origin[1]) / resolution[1]))))];
    if (pixelBounds[0] >= pixelBounds[2] || pixelBounds[1] >= pixelBounds[3]) throw failure("The current view does not intersect the raster grid.");
    const targetScale = Math.max((pixelBounds[2] - pixelBounds[0]) / 512, (pixelBounds[3] - pixelBounds[1]) / 512, 1);
    let image = main, scaleX = 1, scaleY = 1, imageIndex = 0;
    for (let index = 1; index < imageCount; index++) {
      const candidate = await tiff.getImage(index), candidateScale = main.getWidth() / candidate.getWidth();
      if (candidateScale <= targetScale && candidateScale > scaleX) {image = candidate; imageIndex = index; scaleX = candidateScale; scaleY = main.getHeight() / candidate.getHeight();}
    }
    const window = [Math.max(0, Math.floor(pixelBounds[0] / scaleX)), Math.max(0, Math.floor(pixelBounds[1] / scaleY)),
      Math.min(image.getWidth(), Math.ceil(pixelBounds[2] / scaleX)), Math.min(image.getHeight(), Math.ceil(pixelBounds[3] / scaleY))];
    if ((window[2] - window[0]) * (window[3] - window[1]) > COG_PREVIEW_LIMITS.sourcePixels) throw failure("The source has insufficient bounded overviews. Zoom in before refreshing.");
    if (bands.some(band => band > image.getSamplesPerPixel())) throw failure("The selected display band is unavailable.");
    const sample = bands[0] - 1, bits = image.getBitsPerSample(sample), format = image.getSampleFormat(sample);
    if (bands.length === 3 && bands.some(band => image.getBitsPerSample(band - 1) !== bits
      || image.getSampleFormat(band - 1) !== format)) throw failure("RGB display requires matching unsigned sample types and bit depths.");
    const maximum = format !== 1 ? null : bits === 8 ? 255 : bits === 16 ? 65535 : null;
    const scalarSupported = format === 1 && [8, 16, 32].includes(bits)
      || format === 2 && [8, 16, 32].includes(bits) || format === 3 && [32, 64].includes(bits);
    if (range ? !scalarSupported : maximum === null) throw failure(range
      ? "This one-band preview supports unsigned or signed integers up to 32 bits and 32/64-bit floating-point samples."
      : "Choose a display range for a signed or floating-point one-band raster. The default display supports unsigned 8-bit and 16-bit samples.");
    onStatus("Reading the selected raster window…");
    // Keep the already-decoded selected grid, rather than discarding numeric
    // samples after a512px color conversion. This requests the same source window.
    const rasters = await image.readRasters({window, samples: bands.map(band => band - 1), signal: controller.signal});
    controller.signal.throwIfAborted();
    const rasterWidth = window[2] - window[0], rasterHeight = window[3] - window[1];
    if (rasters.length !== bands.length || rasters.some(raster => raster.length !== rasterWidth * rasterHeight)
      || rasters.reduce((sum, raster) => sum + raster.byteLength, 0) > COG_PREVIEW_LIMITS.sampleBytes) throw failure("The decoded raster window exceeds its sample cache limit.");
    const pixels = new Uint8ClampedArray(512 * 512 * 4), northY = mercatorY(bbox[3]), southY = mercatorY(bbox[1]);
    const sampleValue = value => format === 3 && bits === 32 ? Math.fround(value) : value;
    const noDataTag = main.fileDirectory.getValue("GDAL_NODATA"), nodata = sampleValue(Number.parseFloat(noDataTag));
    const transparent = noDataValue === null ? null : sampleValue(noDataValue);
    const grid = {rasters, rasterWidth, rasterHeight, window: [...window], origin, resolution, scaleX, scaleY, transform,
      bounds: [...bbox], bands: [...bands], nodata, transparent, imageIndex, pixelIsPoint, projection,
      imageWidth: image.getWidth(), imageHeight: image.getHeight(), bits, format,
      nanIsNoData: typeof noDataTag === "string" && noDataTag.replace(/\0/g, "").trim().toLowerCase() === "nan"};
    onStatus("Projecting raster pixels for the map…");
    for (let y = 0; y < 512; y++) {
      if (y % 64 === 0) {await new Promise(resolve => setTimeout(resolve, 0)); controller.signal.throwIfAborted();}
      const latitude = latitudeAt(northY + (southY - northY) * (y + 0.5) / 512);
      for (let x = 0; x < 512; x++) {
        const cell = cachedCell(grid, bbox[0] + (bbox[2] - bbox[0]) * (x + 0.5) / 512, latitude);
        if (!cell) continue;
        const values = rasters.map(raster => raster[cell.index]);
        if (values.some(value => !Number.isFinite(value)) || Number.isFinite(nodata) && values.every(value => value === nodata)
          || transparent !== null && values[0] === transparent) continue;
        const output = (y * 512 + x) * 4;
        for (let channel = 0; channel < 3; channel++) pixels[output + channel] = range
          ? Math.round(Math.max(0, Math.min(1, (values[0] - range.minimum) / (range.maximum - range.minimum))) * 255)
          : Math.round(values[Math.min(channel, values.length - 1)] / maximum * 255);
        pixels[output + 3] = 255;
      }
    }
    const result = {width: 512, height: 512, pixels, coordinates: [[bbox[0], bbox[3]], [bbox[2], bbox[3]], [bbox[2], bbox[1]], [bbox[0], bbox[1]]],
      bounds: bbox, snapshot: {url, etag, size, verified: snapshotVerified, rangeHeadersExposed}, usage, sourceWindow: window, overviewScale: scaleX,
      display: "bounded-current-view", displayRange: range, noDataValue, custody: "referenced"};
    grid.snapshot = {etag, verified: snapshotVerified};
    grid.sourceRecord = {url, etag, size, verified: snapshotVerified,
      license:typeof config.license === "string"?config.license:null,
      attribution:typeof config.attribution === "string"?config.attribution:null};sampleWindows.set(result, grid);
    return result;
  } finally {
    controller.abort(); clearTimeout(timer); signal?.removeEventListener("abort", abort);
    await Promise.allSettled([...active]); await tiff?.close(); usage.milliseconds = Math.round(performance.now() - begin);
  }
}

function cachedCell(grid, longitude, latitude) {
  const [west, south, east, north] = grid.bounds;
  if (longitude < west || longitude >= east || latitude <= south || latitude > north) return null;
  const point = grid.transform.forward([longitude, latitude]);
  const column = Math.floor((point[0] - grid.origin[0]) / grid.resolution[0] / grid.scaleX);
  const row = Math.floor((point[1] - grid.origin[1]) / grid.resolution[1] / grid.scaleY);
  const [left, top, right, bottom] = grid.window;
  if (!Number.isFinite(column) || !Number.isFinite(row) || column < left || column >= right || row < top || row >= bottom) return null;
  return {column, row, index: (row - top) * grid.rasterWidth + column - left};
}

/** Read only the retained decoded window. Never opens a TIFF or dispatches I/O. */
export function sampleCogPreview(result, longitude, latitude) {
  const grid = sampleWindows.get(result);
  if (!grid) return {status: "unavailable"};
  if (![longitude, latitude].every(Number.isFinite) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) return {status: "invalid-location"};
  const cell = cachedCell(grid, longitude, latitude);
  if (!cell) return {status: "outside-window"};
  const values = grid.rasters.map(raster => raster[cell.index]);
  const sourceMissing = value => grid.nanIsNoData && Number.isNaN(value) || Number.isFinite(grid.nodata) && value === grid.nodata;
  const missing = values.every(sourceMissing) ? "source-nodata" : values.some(value => !Number.isFinite(value)) ? "nonfinite"
    : grid.transparent !== null && values[0] === grid.transparent ? "display-mask" : null;
  return {status: "ready", location: [longitude, latitude], pixel: {column: cell.column, row: cell.row},
    grid: {imageIndex: grid.imageIndex, scaleX: grid.scaleX, scaleY: grid.scaleY, width: grid.imageWidth, height: grid.imageHeight,
      interpretation: grid.pixelIsPoint ? "point" : "area", projection: grid.projection},
    samples: values.map((value, index) => ({band: grid.bands[index], value: Number.isFinite(value) ? value : null,
      ...(!Number.isFinite(value) ? {nonfinite: String(value)} : {}),
      missing: sourceMissing(value) ? "source-nodata" : !Number.isFinite(value) ? "nonfinite" : null})),
    missing, snapshot: {...grid.snapshot}, source: "cached-source-window"};
}

export function releaseCogPreview(result) {if (result) sampleWindows.delete(result);}

/** A read-only view of native cached cells. No decoder, request or array copy.
 * Each access resolves the WeakMap again, so a released source cannot be sampled
 * through a retained adapter. Display transparency is not source NoData.
 */
export function cogGridView(result) {
  const grid=sampleWindows.get(result);if(!grid)return null;
  const current=()=>{const value=sampleWindows.get(result);if(!value)throw Error("cog_grid_released");return value;};
  const valid=(g,column,row)=>Number.isInteger(column)&&Number.isInteger(row)&&column>=0&&row>=0&&column<g.rasterWidth&&row<g.rasterHeight;
  const coordinate=(column,row,corner=false)=>{
    const g=current();
    if(corner ? !Number.isInteger(column)||!Number.isInteger(row)||column<0||row<0||column>g.rasterWidth||row>g.rasterHeight : !valid(g,column,row))throw Error("cog_grid_cell_invalid");
    const shift=corner?0:.5;
    const point=g.transform.inverse([g.origin[0]+(g.window[0]+column+shift)*g.resolution[0]*g.scaleX,
      g.origin[1]+(g.window[1]+row+shift)*g.resolution[1]*g.scaleY]);
    if(!point.every(Number.isFinite)||Math.abs(point[0])>180||Math.abs(point[1])>90)throw Error("cog_grid_coordinate_invalid");
    return [...point];
  };
  return Object.freeze({width:grid.rasterWidth,height:grid.rasterHeight,
    metadata:Object.freeze({imageIndex:grid.imageIndex,projection:grid.projection,scaleX:grid.scaleX,scaleY:grid.scaleY,
      window:Object.freeze([...grid.window]),origin:Object.freeze([...grid.origin]),resolution:Object.freeze([...grid.resolution]),
      interpretation:grid.pixelIsPoint?"point":"area",bands:Object.freeze([...grid.bands]),
      noData:Number.isFinite(grid.nodata)?grid.nodata:grid.nanIsNoData?"NaN":null,
      source:Object.freeze({...grid.sourceRecord})}),
    active:()=>sampleWindows.has(result),
    coordinate,
    locate(longitude,latitude){const g=current();if(![longitude,latitude].every(Number.isFinite)||Math.abs(longitude)>180||Math.abs(latitude)>90)return null;
      const cell=cachedCell(g,longitude,latitude);return cell?{column:cell.column-g.window[0],row:cell.row-g.window[1]}:null;},
    value(column,row,band){const g=current(),index=g.bands.indexOf(band);if(!valid(g,column,row)||index<0)throw Error("cog_grid_cell_invalid");
      const value=g.rasters[index][row*g.rasterWidth+column];
      return !Number.isFinite(value)||g.nanIsNoData&&Number.isNaN(value)||Number.isFinite(g.nodata)&&value===g.nodata?null:value;}
  });
}

export function cogPreviewCanvas(result) {
  const canvas = document.createElement("canvas"); canvas.width = result.width; canvas.height = result.height;
  canvas.getContext("2d").putImageData(new ImageData(result.pixels, result.width, result.height), 0, 0);
  return canvas;
}
