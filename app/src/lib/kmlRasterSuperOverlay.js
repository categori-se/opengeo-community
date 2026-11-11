import {strToU8, zipSync, zlibSync} from "fflate";

export const RASTER_SUPER_OVERLAY_LIMITS = Object.freeze({
  sourceBytes: 64 * 1024 ** 2, sourcePixels: 16_777_216, sampleBytes: 64 * 1024 ** 2,
  archiveBytes: 64 * 1024 ** 2, expandedBytes: 64 * 1024 ** 2,
  tileSize: 256, tiles: 341, milliseconds: 30_000
});
const R = 6378137;
const xml = value => String(value).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"})[c]);
// KML descriptions are HTML-bearing. Encode text for both the HTML and XML
// layers so source credits cannot become executable balloon content.
const description = value => xml(xml(value));
const validText = value => typeof value === "string" && [...value].every(c => {
  const n = c.codePointAt(0);
  return [9, 10, 13].includes(n) || n >= 0x20 && n <= 0xd7ff || n >= 0xe000 && n <= 0xfffd || n >= 0x10000 && n <= 0x10ffff;
});
const failure = (code, message) => Object.assign(new Error(message), {code});
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
  .map(value => value.toString(16).padStart(2, "0")).join("");

/** Deliberate full-file conversion, never a provider fetch or map screenshot.
 * The original file stays with its owner. No map, Catalog or account is changed.
 */
export async function exportRasterSuperOverlay(file, {
  signal, attribution = "", onProgress = () => {}, assertCurrent = () => {},
  libraryLoader = async () => (await import("./cogReaderAsset.js")).loadCogReader()
} = {}) {
  const limits = RASTER_SUPER_OVERLAY_LIMITS, start = performance.now();
  const check = () => {
    signal?.throwIfAborted(); assertCurrent();
    if (performance.now() - start > limits.milliseconds)
      throw failure("super_overlay_timeout", "Raster export exceeded its time limit. The original file is unchanged.");
  };
  check();
  if (!validText(attribution) || strToU8(attribution).length > 8192)
    throw failure("super_overlay_attribution", "Source credits and reuse terms must fit within 8 KiB.");
  if (!validText(file?.name) || strToU8(file.name).length > 1024)
    throw failure("super_overlay_filename", "The source filename contains unsupported text or exceeds 1 KiB.");
  if (!file || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > limits.sourceBytes)
    throw failure("super_overlay_source_size", "Choose a GeoTIFF no larger than 64 MiB.");
  const bytes = new Uint8Array(await file.arrayBuffer()); check();
  if (bytes.byteLength !== file.size) throw failure("super_overlay_source_changed", "The file size changed while reading.");
  const sourceHash = await hash(bytes); check();
  const reader = await libraryLoader(); check();
  // Reuse the pinned custom-client reader with an entirely local transport.
  const client = {url: "opengeo-local-raster.tif", async request({headers}) {
    check();
    const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(headers).get("range") ?? "");
    if (!match) throw failure("super_overlay_range", "The TIFF reader requested an unsupported local range.");
    const first = Number(match[1]), last = Math.min(Number(match[2]), bytes.length - 1);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || first > last)
      throw failure("super_overlay_range", "The TIFF contains an invalid local byte range.");
    const data = bytes.slice(first, last + 1);
    return {ok: true, status: 206, getData: async () => data.buffer,
      getHeader: name => name.toLowerCase() === "content-range" ? `bytes ${first}-${last}/${bytes.length}` : null};
  }};
  let tiff;
  try {
    onProgress("Reading the original raster…");
    tiff = await reader.fromCustomClient(client, {allowFullFile: false, blockSize: 65536, cacheSize: 4, maxRanges: 0}, signal);
    const image = await tiff.getImage(0); check();
    const width = image.getWidth(), height = image.getHeight(), samples = image.getSamplesPerPixel();
    if (![width, height].every(v => Number.isSafeInteger(v) && v > 0) || width * height > limits.sourcePixels
      || ![1, 3, 4].includes(samples) || width * height * samples > limits.sampleBytes)
      throw failure("super_overlay_grid_size", "Use a raster of at most 16 million pixels with one gray, three RGB or four RGBA bands.");
    // Do not ask the reader to walk an unbounded or cyclic IFD chain.
    for (let i = 1; i <= 16; i++) {
      let overview;
      try {overview = await tiff.getImage(i);}
      catch (error) {if (error?.index === i && error.message === `No image at index ${i}`) break; throw error;}
      check();
      if (i === 16) throw failure("super_overlay_directories", "The TIFF has too many image directories.");
      if (!(overview.fileDirectory.getValue("NewSubfileType") & 1))
        throw failure("super_overlay_pages", "Separate TIFF pages require an explicit selection; no page was discarded.");
    }
    const tag = name => image.fileDirectory.getValue(name);
    const copyright = String(tag("Copyright") ?? "").replace(/\0+$/, "");
    if (!validText(copyright) || strToU8(copyright).length > 8192)
      throw failure("super_overlay_copyright", "Source copyright text is invalid or exceeds 8 KiB; it was not discarded.");
    const credits = [copyright, attribution].filter((v, i, all) => v && all.indexOf(v) === i).join("\n\n");
    const photo = tag("PhotometricInterpretation"), extra = tag("ExtraSamples");
    if (samples === 1 ? ![0, 1].includes(photo) : photo !== 2 || samples === 4 && ![1, 2].includes(extra?.[0]))
      throw failure("super_overlay_color", "Use explicit gray, RGB or RGBA color interpretation. Palette and scientific band mapping require a display conversion first.");
    for (let i = 0; i < samples; i++) if (image.getBitsPerSample(i) !== 8 || image.getSampleFormat(i) !== 1)
      throw failure("super_overlay_sample_type", "This export preserves 8-bit display colors. Convert other sample types with an explicit display range first.");
    const keys = image.getGeoKeys(), matrix = tag("ModelTransformation");
    const projection = keys.ProjectedCSTypeGeoKey === 3857 ? "EPSG:3857"
      : !keys.ProjectedCSTypeGeoKey && keys.GeographicTypeGeoKey === 4326 ? "EPSG:4326" : null;
    const origin = [...image.getOrigin()], resolution = image.getResolution();
    if (!projection || keys.GTRasterTypeGeoKey != null && ![1, 2].includes(keys.GTRasterTypeGeoKey)
      || projection === "EPSG:3857" && keys.ProjLinearUnitsGeoKey != null && keys.ProjLinearUnitsGeoKey !== 9001
      || projection === "EPSG:4326" && keys.GeogAngularUnitsGeoKey != null && keys.GeogAngularUnitsGeoKey !== 9102
      || ![...origin, ...resolution].every(Number.isFinite) || resolution[0] <= 0 || resolution[1] >= 0
      || matrix && (matrix[1] !== 0 || matrix[4] !== 0))
      throw failure("super_overlay_projection", "Use a north-up WGS84 or Web Mercator GeoTIFF. Unsupported coordinates are never guessed.");
    const tie = tag("ModelTiepoint");
    if (!matrix && tie?.length === 6) {origin[0] -= tie[0] * resolution[0]; origin[1] -= tie[1] * resolution[1];}
    if (keys.GTRasterTypeGeoKey === 2) {origin[0] -= resolution[0] / 2; origin[1] -= resolution[1] / 2;}
    const toLon = x => projection === "EPSG:4326" ? x : x / R * 180 / Math.PI;
    const toLat = y => projection === "EPSG:4326" ? y : (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;
    const bounds = [toLon(origin[0]), toLat(origin[1] + height * resolution[1]),
      toLon(origin[0] + width * resolution[0]), toLat(origin[1])];
    const [west, south, east, north] = bounds;
    if (!bounds.every(Number.isFinite) || west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north)
      throw failure("super_overlay_bounds", "The raster needs valid non-wrapping geographic bounds. Split antimeridian rasters before export.");
    const noDataTag = tag("GDAL_NODATA"), noData = noDataTag == null ? null : Number(String(noDataTag).replace(/\0/g, "").trim());
    if (noData !== null && (!Number.isInteger(noData) || noData < 0 || noData > 255))
      throw failure("super_overlay_nodata", "The raster's NoData value is incompatible with its 8-bit display samples.");
    const depth = Math.max(0, Math.ceil(Math.log2(Math.max(width, height) / limits.tileSize)));
    const count = (4 ** (depth + 1) - 1) / 3;
    if (count > limits.tiles) throw failure("super_overlay_tile_limit", "The full-resolution pyramid exceeds the tile limit. No partial archive was produced.");
    const raster = await image.readRasters({interleave: true, signal}); check();
    if (!(raster instanceof Uint8Array) || raster.length !== width * height * samples)
      throw failure("super_overlay_samples", "The decoded raster does not match its declared grid.");
    const files = {}, tiles = []; let expanded = 0;
    const add = (path, data, level = 0) => {
      expanded += data.length;
      if (expanded > limits.expandedBytes) throw failure("super_overlay_output_size", "The full pyramid exceeds the archive limit.");
      files[path] = [data, {level}];
    };
    const tileName = (z, x, y) => `r${z}-${x}-${y}`;
    for (let z = 0; z <= depth; z++) for (let y = 0; y < 2 ** z; y++) for (let x = 0; x < 2 ** z; x++) {
      check();
      const n = 2 ** z, box = [west + (east - west) * x / n, north - (north - south) * (y + 1) / n,
        west + (east - west) * (x + 1) / n, north - (north - south) * y / n];
      const rgba = new Uint8Array(limits.tileSize ** 2 * 4);
      for (let row = 0; row < limits.tileSize; row++) {
        if (row % 32 === 0) {await new Promise(resolve => setTimeout(resolve, 0)); check();}
        const lat = box[3] - (box[3] - box[1]) * (row + 0.5) / limits.tileSize;
        const py = projection === "EPSG:4326" ? lat : R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
        const iy = Math.max(0, Math.min(height - 1, Math.floor((py - origin[1]) / resolution[1])));
        for (let column = 0; column < limits.tileSize; column++) {
          const lon = box[0] + (box[2] - box[0]) * (column + 0.5) / limits.tileSize;
          const px = projection === "EPSG:4326" ? lon : lon * Math.PI / 180 * R;
          const ix = Math.max(0, Math.min(width - 1, Math.floor((px - origin[0]) / resolution[0])));
          const input = (iy * width + ix) * samples, output = (row * limits.tileSize + column) * 4;
          const alpha = samples === 4 ? raster[input + 3] : 255;
          for (let channel = 0; channel < 3; channel++) {
            const raw = raster[input + (samples === 1 ? 0 : channel)];
            rgba[output + channel] = samples === 1 && photo === 0 ? 255 - raw
              : samples === 4 && extra[0] === 1 ? alpha ? Math.min(255, Math.round(raw * 255 / alpha)) : 0 : raw;
          }
          const missing = noData !== null && raster[input] === noData
            && (samples === 1 || raster[input + 1] === noData && raster[input + 2] === noData);
          rgba[output + 3] = missing ? 0 : alpha;
        }
      }
      const name = tileName(z, x, y), png = encodePng(rgba, limits.tileSize);
      add(`${name}.png`, png);
      const children = z === depth ? [] : [[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy]) => {
        const cx = 2 * x + dx, cy = 2 * y + dy;
        return {name: tileName(z + 1, cx, cy), box: [box[0] + (box[2] - box[0]) * dx / 2,
          box[3] - (box[3] - box[1]) * (dy + 1) / 2, box[0] + (box[2] - box[0]) * (dx + 1) / 2,
          box[3] - (box[3] - box[1]) * dy / 2]};
      });
      add(`${name}.kml`, strToU8(kmlTile(name, file.name, box, z, children, credits)), 6);
      tiles.push({image: `${name}.png`, kml: `${name}.kml`, level: z, bounds: box, sha256: await hash(png)});
      onProgress(`Preparing raster tiles: ${tiles.length} of ${count}…`);
    }
    const report = {schemaVersion: "opengeo.raster-super-overlay.1", source: {name: String(file.name), sha256: sourceHash,
      bytes: bytes.length, width, height, samples, projection, pixelInterpretation: keys.GTRasterTypeGeoKey === 2 ? "point" : "area", noData,
      attribution: attribution || null, ...(copyright ? {copyright} : {})},
    bounds, tileSize: limits.tileSize, levels: depth + 1, tiles,
    resampling: "Nearest source pixel at each geographic output pixel center; full source extent at every level.",
    preservation: ["Original source checksum and full extent", "8-bit display colors, alpha and declared NoData", "Local-only relative links, geographic Regions and level draw order"],
    losses: ["Display PNGs do not retain numeric bands, original projection or GeoTIFF metadata; retain the original source.",
      "No license or attribution is inferred from a filename; carry the source terms with the output.",
      "This standalone raster pyramid may exceed Studio's inline KML import limits; use a raster-capable external client.",
      "Rotated grids, other projections, palette/scientific samples and wrapping extents require explicit conversion first."], limits};
    // A distinct root link makes relative images resolve inside the KMZ in
    // independent raster clients, including GDAL's KMLSUPEROVERLAY reader.
    add("doc.kml", strToU8(`<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xml(file.name)}</name><description>${description(credits)}</description><NetworkLink><name>${xml(file.name)}</name>${region(bounds, 0)}<Link><href>r0-0-0.kml</href><viewRefreshMode>onRegion</viewRefreshMode></Link></NetworkLink></Document></kml>`), 6);
    add("opengeo-raster-lineage.json", strToU8(JSON.stringify(report, null, 2)), 6); check();
    const archive = zipSync({"doc.kml": files["doc.kml"], ...files}, {mtime: new Date(1980, 0, 1)}); check();
    if (archive.length > limits.archiveBytes) throw failure("super_overlay_output_size", "The archive exceeds its byte limit.");
    return {bytes: archive, report};
  } finally {await tiff?.close();}
}

function region(box, minimum, maximum = -1) {
  return `<Region><LatLonAltBox><west>${box[0]}</west><south>${box[1]}</south><east>${box[2]}</east><north>${box[3]}</north></LatLonAltBox><Lod><minLodPixels>${minimum}</minLodPixels><maxLodPixels>${maximum}</maxLodPixels></Lod></Region>`;
}
function kmlTile(name, title, box, level, children, attribution) {
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xml(title)}</name><description>${description(attribution)}</description>${region(box, level ? 128 : 0)}<GroundOverlay><name>${xml(title)}</name><description>${description(attribution)}</description>${region(box, level ? 128 : 0, children.length ? 256 : -1)}<drawOrder>${level}</drawOrder><Icon><href>${name}.png</href></Icon><LatLonBox><west>${box[0]}</west><south>${box[1]}</south><east>${box[2]}</east><north>${box[3]}</north></LatLonBox></GroundOverlay>${children.map(child => `<NetworkLink><name>${child.name}</name>${region(child.box, 128)}<Link><href>${child.name}.kml</href><viewRefreshMode>onRegion</viewRefreshMode></Link></NetworkLink>`).join("")}</Document></kml>`;
}

const crcTable = Uint32Array.from({length: 256}, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function encodePng(pixels, size) {
  const chunk = (type, data) => {
    const result = new Uint8Array(data.length + 12), view = new DataView(result.buffer);
    view.setUint32(0, data.length); result.set(strToU8(type), 4); result.set(data, 8);
    let crc = 0xffffffff; for (const value of result.subarray(4, -4)) crc = crcTable[(crc ^ value) & 255] ^ crc >>> 8;
    view.setUint32(result.length - 4, (crc ^ 0xffffffff) >>> 0); return result;
  };
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, size); view.setUint32(4, size); header[8] = 8; header[9] = 6;
  const scanlines = new Uint8Array(size * (size * 4 + 1));
  for (let row = 0; row < size; row++) scanlines.set(pixels.subarray(row * size * 4, (row + 1) * size * 4), row * (size * 4 + 1) + 1);
  const chunks = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlibSync(scanlines, {level: 6})), chunk("IEND", new Uint8Array())];
  const output = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let offset = 0;
  for (const c of chunks) {output.set(c, offset); offset += c.length;} return output;
}
