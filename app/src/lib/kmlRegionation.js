import {strToU8, zipSync, zlibSync} from "fflate";
import {KML_PLACES_LIMITS, exportKml, normalizePlacesDocument, parseKmlFile} from "./kmlPlaces.js";

/** Partition resident vectors without clipping, fetching or mutating their source. */
export async function exportRegionatedKmz(value, {
  maximumFeaturesPerPart = 64, DOMParser = globalThis.DOMParser
} = {}) {
  const source = normalizePlacesDocument(value);
  if (!Number.isSafeInteger(maximumFeaturesPerPart) || maximumFeaturesPerPart < 1
    || maximumFeaturesPerPart > KML_PLACES_LIMITS.maximumPlaces) throw failure("regionation_part_limit", "Choose a positive bounded part size.");
  const leaves = [], ids = new Set([source.id]), emptyFolders = new Map();
  const collect = children => {
    for (const child of children) {
      ids.add(child.id);
      if (child.kind === "folder") {
        if (!child.children.length) emptyFolders.set(child.id, Math.max(0, leaves.length - 1));
        collect(child.children);
      }
      else if (child.kind === "placemark" && child.geometry) leaves.push(child);
      else throw failure("regionation_vector_only", "Regionated export supports vector placemarks and folders. The original document is unchanged.");
    }
  };
  collect(source.children);
  if (!leaves.length) throw failure("regionation_vectors_required", "Add vector placemarks before exporting regions.");
  for (const definition of [...source.styles, ...source.schemas]) ids.add(definition.id);
  const uniqueId = stem => {let id = stem; while (ids.has(id)) id += "-part"; ids.add(id); return id;};
  const partCount = Math.ceil(leaves.length / maximumFeaturesPerPart);
  if (partCount + source.resources.length + 2 > KML_PLACES_LIMITS.maximumKmzEntries)
    throw failure("regionation_archive_entries", "The regions and images exceed the existing KMZ entry limit.");
  const sourceText = exportKml(source), files = {}, parts = [], links = [];
  let expandedBytes = 0;
  const add = (name, bytes, level = 6) => {
    if (Object.hasOwn(files, name)) throw failure("regionation_path_collision", "A source image conflicts with a generated archive path.");
    expandedBytes += bytes.byteLength;
    if (expandedBytes > KML_PLACES_LIMITS.maximumKmzUncompressedBytes)
      throw failure("kmz_uncompressed_too_large", "The expanded regions exceed the existing KMZ byte limit.");
    files[name] = [bytes, {level}];
  };
  for (let offset = 0; offset < leaves.length; offset += maximumFeaturesPerPart) {
    const selected = leaves.slice(offset, offset + maximumFeaturesPerPart);
    const selectedIds = new Set(selected.map(leaf => leaf.id));
    const subset = children => children.flatMap(child => {
      if (child.kind !== "folder") return selectedIds.has(child.id) ? [child] : [];
      const nested = subset(child.children);
      const assigned = emptyFolders.get(child.id);
      return nested.length || (assigned >= offset && assigned < offset + selected.length)
        ? [{...child, children: nested}] : [];
    });
    const entry = `part-${String(parts.length + 1).padStart(4, "0")}.kml`;
    const child = {...source, id: uniqueId(`opengeo-region-document-${parts.length + 1}`),
      region: null, view: null, time: null, children: subset(source.children)};
    const bytes = strToU8(exportKml(child));
    if (bytes.byteLength > KML_PLACES_LIMITS.maximumKmlBytes)
      throw failure("kml_too_large", "A region exceeds the existing KML byte limit.");
    const region = regionFor(selected);
    add(entry, bytes);
    parts.push({entry, placeIds: selected.map(leaf => leaf.id), region, sha256: await digest(bytes)});
    links.push({kind: "network-link", id: uniqueId(`opengeo-region-link-${parts.length}`),
      name: `Region ${parts.length}`, visibility: true, open: false, region,
      link: {href: entry, refreshMode: "onChange", viewRefreshMode: "onRegion"}});
  }
  const root = strToU8(exportKml({...source, children: links}));
  if (root.byteLength > KML_PLACES_LIMITS.maximumKmlBytes) throw failure("kml_too_large", "The region index exceeds the existing KML byte limit.");
  add("doc.kml", root);
  const resources = [];
  for (const resource of source.resources) {
    const bytes = Uint8Array.from(atob(resource.dataBase64), character => character.charCodeAt(0));
    add(resource.path, bytes, 0);
    resources.push({path: resource.path, sha256: await digest(bytes)});
  }
  const report = {schemaVersion: "opengeo.kml-regionation.1", normalizedSourceSha256: await digest(strToU8(sourceText)),
    sourceName: source.name, sourceFeatureCount: leaves.length, parts,
    sourceSerialization: "Existing normalized KML export; this digest does not identify original input bytes.",
    partition: "Contiguous source traversal; original geometry and leaf order are retained without clipping.",
    resources,
    limits: {...KML_PLACES_LIMITS},
    notes: ["Each immutable local child has a geographic Region and no external transport.",
      "Antimeridian-spanning geometry uses conservative global longitude bounds.",
      "Import materializes local links and reports snapshot/refresh semantics; keep the original source.",
      "Raster super overlays and unresident/provider data are not generated."]};
  add("opengeo-regionation.json", strToU8(JSON.stringify(report, null, 2)));
  const archive = zipSync(files, {mtime: new Date(1980, 0, 1)});
  if (archive.byteLength > KML_PLACES_LIMITS.maximumKmzBytes) throw failure("kmz_too_large", "The archive exceeds the existing KMZ byte limit.");
  // Validate the actual local graph before offering a download. Synthetic Region
  // folders count toward the same native size/depth/identity limits on reimport.
  await parseKmlFile({name: "regions.kmz", arrayBuffer: async () => archive.buffer.slice(
    archive.byteOffset, archive.byteOffset + archive.byteLength)}, {DOMParser});
  return {bytes: archive, report};
}

/** Export an explicitly georeferenced resident RGBA grid. Leaf pixels are never
 * resampled; parent images use declared nearest-neighbour overview sampling. */
export async function exportRasterSuperOverlay({width, height, rgba, bounds, source,
  name = "Raster super overlay", attribution = "", tileSize = 512, signal} = {},
  {DOMParser = globalThis.DOMParser} = {}) {
  const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  if (!integer(width, 1, 4096) || !integer(height, 1, 4096) || width * height > 16_777_216
    || !(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) || rgba.length !== width * height * 4)
    throw failure("super_overlay_grid_invalid", "Provide one complete RGBA grid, at most 4096 by 4096 pixels.");
  if (!integer(tileSize, 16, 1024) || (tileSize & (tileSize - 1)))
    throw failure("super_overlay_tile_size", "Choose a power-of-two tile size from 16 to 1024 pixels.");
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)
    || Math.abs(bounds[0]) > 180 || Math.abs(bounds[2]) > 180 || bounds[1] < -90 || bounds[3] > 90
    || bounds[1] >= bounds[3] || bounds[0] === bounds[2])
    throw failure("super_overlay_bounds", "Choose exact west, south, east, north WGS84 grid edges; west greater than east crosses the antimeridian.");
  if (!source || typeof source !== "object" || typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256)
    || typeof source.identity !== "string" || !source.identity.trim() || source.identity.length > 240
    || source.crs !== "EPSG:4326" || source.grid !== "north-up-pixel-edges")
    throw failure("super_overlay_source", "Supply the original source identity/checksum and an explicit north-up EPSG:4326 pixel-edge grid. Reproject other grids first.");
  if (typeof name !== "string" || name.length > 256 || typeof attribution !== "string" || attribution.length > 8192)
    throw failure("super_overlay_metadata", "The raster name or attribution exceeds the existing text limits.");
  const checked = () => signal?.throwIfAborted();
  const files = {}, parts = [], images = [], nodes = [];
  let expanded = 0, resourceBytes = 0;
  const add = (path, data) => {
    expanded += data.byteLength;
    if (expanded > KML_PLACES_LIMITS.maximumKmzUncompressedBytes)
      throw failure("kmz_uncompressed_too_large", "The raster package exceeds the expanded KMZ budget.");
    files[path] = [data, {level: path.endsWith(".png") ? 0 : 6}];
  };
  const longitude = x => {
    const east = bounds[2] < bounds[0] ? bounds[2] + 360 : bounds[2];
    const value = bounds[0] + (east - bounds[0]) * x / width;
    return value > 180 ? value - 360 : value;
  };
  const boxFor = (x, y, w, h) => ({west: longitude(x), east: longitude(x + w),
    north: bounds[3] - (bounds[3] - bounds[1]) * y / height,
    south: bounds[3] - (bounds[3] - bounds[1]) * (y + h) / height, rotation: 0});
  const region = box => ({box: {...box, minAltitude: 0, maxAltitude: 0, altitudeMode: "clampToGround"},
    lod: {minPixels: 0, maxPixels: -1, minFadeExtent: 0, maxFadeExtent: 0}});
  const build = async (x, y, w, h, depth = 0) => {
    checked();
    // Two files per node plus the root and lineage report fit the existing archive budget.
    if (nodes.length >= Math.min(KML_PLACES_LIMITS.maximumKmzResources, Math.floor((KML_PLACES_LIMITS.maximumKmzEntries - 2) / 2)))
      throw failure("super_overlay_node_limit", "This raster needs more than 31 overview/leaf tiles. Increase tile size or choose a smaller complete grid.");
    const id = `raster-${String(nodes.length + 1).padStart(4, "0")}`, box = boxFor(x, y, w, h);
    const node = {id, x, y, width: w, height: h, depth, box, children: []}; nodes.push(node);
    const imageWidth = Math.min(tileSize, w), imageHeight = Math.min(tileSize, h);
    const pixels = new Uint8Array(imageWidth * imageHeight * 4);
    for (let py = 0; py < imageHeight; py++) {
      checked();
      const sy = y + Math.min(h - 1, Math.floor((py + 0.5) * h / imageHeight));
      for (let px = 0; px < imageWidth; px++) {
        const sx = x + Math.min(w - 1, Math.floor((px + 0.5) * w / imageWidth));
        pixels.set(rgba.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (py * imageWidth + px) * 4);
      }
    }
    const png = rgbaPng(pixels, imageWidth, imageHeight), imagePath = `${id}.png`;
    resourceBytes += png.byteLength;
    if (png.byteLength > KML_PLACES_LIMITS.maximumKmzResourceBytes || resourceBytes > KML_PLACES_LIMITS.maximumKmzResourceTotalBytes)
      throw failure("super_overlay_native_resource_limit", "The exact tile images exceed the existing 64 KiB/image or 96 KiB combined native resource budget. No image is omitted or recompressed lossily.");
    add(imagePath, png);
    images.push({path: imagePath, bytes: png.byteLength, sha256: await digest(png), pixelWindow: [x, y, w, h],
      width: imageWidth, height: imageHeight, resampling: w === imageWidth && h === imageHeight ? "none" : "nearest-centre-overview"});
    if (w > tileSize || h > tileSize) {
      const widths = w > tileSize ? [Math.floor(w / 2), w - Math.floor(w / 2)] : [w];
      const heights = h > tileSize ? [Math.floor(h / 2), h - Math.floor(h / 2)] : [h];
      let cy = y;
      for (const ch of heights) {
        let cx = x;
        for (const cw of widths) {node.children.push(await build(cx, cy, cw, ch, depth + 1));cx += cw;}
        cy += ch;
      }
    }
    let document = {kind: "document", id: `${id}-document`, name, description: attribution || null, visibility: true,
      open: false, view: null, time: null, region: null, styles: [], schemas: [], resources: [], children: [{
        kind: "ground-overlay", id, name: `${name} · ${id}`, description: attribution || null, visibility: true,
        view: null, time: null, region: region(box), color: "ffffffff", drawOrder: depth,
        icon: {href: imagePath}, altitude: 0, altitudeMode: "clampToGround", box, quad: null
      }, ...node.children.map(child => ({kind: "network-link", id: `${child.id}-link`, name: child.id,
        visibility: true, open: false, view: null, time: null,
        region: {...region(child.box), lod: {minPixels: tileSize / 2, maxPixels: -1, minFadeExtent: 0, maxFadeExtent: 0}},
        link: {href: `${child.id}.kml`, refreshMode: "onChange", viewRefreshMode: "onRegion"}}))]};
    const kml = strToU8(exportKml(document));add(`${id}.kml`, kml);
    parts.push({entry: `${id}.kml`, sha256: await digest(kml), pixelWindow: [x, y, w, h], depth, box,
      children: node.children.map(child => child.id), image: imagePath});
    return node;
  };
  const root = await build(0, 0, width, height);
  // The conventional doc.kml entry point is itself the root tile document.
  files["doc.kml"] = files[`${root.id}.kml`]; delete files[`${root.id}.kml`];
  parts.find(part => part.entry === `${root.id}.kml`).entry = "doc.kml";
  const report = {schemaVersion: "opengeo.raster-super-overlay.1", source: {...structuredClone(source),
    rgbaSha256: await digest(rgba), width, height, bounds: [...bounds]}, attribution, tileSize, parts, images,
    method: "Quadtree local KML NetworkLinks and PNG GroundOverlays. Leaf RGBA pixels are exact; parent images sample pixel centres with nearest-neighbour selection.",
    limits: {maximumPixels: 16_777_216, maximumNodes: 31, perImageBytes: KML_PLACES_LIMITS.maximumKmzResourceBytes,
      combinedImageBytes: KML_PLACES_LIMITS.maximumKmzResourceTotalBytes},
    losses: ["RGBA is the supplied portrayal; original numeric bands, CRS and source bytes remain in their owning source.",
      "Parent overview images reduce spatial detail; exact leaf pixels and all alpha values are retained.",
      "Native reimport materializes a snapshot; geographic Region conjunctions and draw order remain explicit."]};
  add("opengeo-super-overlay.json", strToU8(JSON.stringify(report, null, 2)));
  checked();
  const bytes = zipSync(files, {mtime: new Date(1980, 0, 1)});
  if (bytes.byteLength > KML_PLACES_LIMITS.maximumKmzBytes) throw failure("kmz_too_large", "The raster archive exceeds the KMZ budget.");
  const restored = await parseKmlFile({name: "raster.kmz", arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)}, {DOMParser});
  if (restored.document.resources.length !== images.length)
    throw failure("super_overlay_reimport_loss", "The complete raster images could not be retained through native reimport.");
  return {bytes, report};
}

function rgbaPng(rgba, width, height) {
  const word = value => Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
  const concat = arrays => {const bytes = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));let at = 0;
    for (const a of arrays) {bytes.set(a, at);at += a.length;}return bytes;};
  const crc = bytes => {let value = 0xffffffff;for (const byte of bytes) {value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);}
    return (value ^ 0xffffffff) >>> 0;};
  const chunk = (type, data) => {const body = concat([strToU8(type), data]);return concat([word(data.length), body, word(crc(body))]);};
  const scanlines = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) scanlines.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return concat([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk("IHDR", concat([word(width), word(height), Uint8Array.of(8, 6, 0, 0, 0)])),
    chunk("IDAT", zlibSync(scanlines, {level: 6})), chunk("IEND", new Uint8Array())]);
}

function regionFor(leaves) {
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  const positions = coordinates => {
    if (typeof coordinates?.[0] === "number") {
      west = Math.min(west, coordinates[0]); east = Math.max(east, coordinates[0]);
      south = Math.min(south, coordinates[1]); north = Math.max(north, coordinates[1]);
    } else coordinates?.forEach(positions);
  };
  const geometry = value => value.type === "GeometryCollection"
    ? value.geometries.forEach(geometry) : positions(value.coordinates);
  leaves.forEach(leaf => geometry(leaf.geometry));
  if (![west, east, south, north].every(Number.isFinite)) throw failure("regionation_empty_geometry", "A placemark has no bounded coordinates.");
  if (east - west > 180) {west = -180; east = 180;}
  if (east === west) {west = Math.max(-180, west - 1e-7); east = Math.min(180, east + 1e-7);}
  if (north === south) {south = Math.max(-90, south - 1e-7); north = Math.min(90, north + 1e-7);}
  return {box: {west, east, south, north}, lod: {minPixels: 0, maxPixels: -1}};
}

async function digest(bytes) {
  if (!globalThis.crypto?.subtle) throw failure("regionation_digest_unavailable", "The secure file digest service is unavailable.");
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map(value => value.toString(16).padStart(2, "0")).join("");
}

function failure(code, message) {return Object.assign(new Error(message), {code});}
