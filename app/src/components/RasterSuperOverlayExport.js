import {exportRasterSuperOverlay} from "../lib/kmlRegionation.js";

export const RASTER_OVERLAY_IMAGE_LIMITS = Object.freeze({bytes: 4 * 1024 * 1024, axis: 4096, pixels: 16_777_216});
const fail = message => {throw Error(message);};

/** Inspect a bounded PNG/JPEG header before invoking any allocating decoder. */
function imageHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width, height, mediaType;
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) {
    if (bytes.length < 33 || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) fail("The PNG header is malformed.");
    width = view.getUint32(16);height = view.getUint32(20);mediaType = "image/png";
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    mediaType = "image/jpeg";
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset++] !== 255) fail("The JPEG marker sequence is malformed.");
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue;
      if (offset + 2 > bytes.length) fail("The JPEG header is truncated.");
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) fail("The JPEG segment is truncated.");
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) fail("The JPEG size header is malformed.");
        height = view.getUint16(offset + 3);width = view.getUint16(offset + 5);break;
      }
      offset += length;
    }
  } else fail("Choose a PNG or JPEG image; SVG and other active formats are not decoded.");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > RASTER_OVERLAY_IMAGE_LIMITS.axis || height > RASTER_OVERLAY_IMAGE_LIMITS.axis
    || width * height > RASTER_OVERLAY_IMAGE_LIMITS.pixels)
    fail("The image must be at most 4096 by 4096 pixels and 16,777,216 pixels total.");
  return {width, height, mediaType};
}

export async function readRasterOverlayImage(file, {document: doc = globalThis.document, signal} = {}) {
  signal?.throwIfAborted();
  if (!file || typeof file.arrayBuffer !== "function" || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > RASTER_OVERLAY_IMAGE_LIMITS.bytes)
    fail("Choose a local PNG or JPEG of at most 4 MiB.");
  const bytes = new Uint8Array(await file.arrayBuffer());signal?.throwIfAborted();
  if (bytes.length !== file.size) fail("The selected image size changed while reading it.");
  const header = imageHeader(bytes);
  const decoder = doc.defaultView?.createImageBitmap ?? globalThis.createImageBitmap;
  if (typeof decoder !== "function") fail("This browser cannot decode a bounded image for export.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));signal?.throwIfAborted();
  const sha256 = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
  let bitmap, canvas;
  try {
    bitmap = await decoder.call(doc.defaultView, new Blob([bytes], {type: header.mediaType}),
      {imageOrientation: "none", premultiplyAlpha: "none", colorSpaceConversion: "none"});
    signal?.throwIfAborted();
    if (bitmap.width !== header.width || bitmap.height !== header.height) fail("Decoded dimensions differ from the inspected image header.");
    canvas = doc.createElement("canvas");canvas.width = header.width;canvas.height = header.height;
    const context = canvas.getContext("2d", {willReadFrequently: true});
    if (!context) fail("A local pixel surface is unavailable.");
    context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, header.width, header.height).data;signal?.throwIfAborted();
    return {...header, rgba: new Uint8ClampedArray(rgba), sha256, byteLength: bytes.length,
      filename: String(file.name ?? "raster-image").slice(0, 240)};
  } finally {bitmap?.close?.();if (canvas) {canvas.width = 0;canvas.height = 0;}}
}

/** Deliberate local export. Georeferencing is entered by the user, never inferred
 * from a photograph, a file extension or the current map camera. */
export function RasterSuperOverlayExport({available = () => true, assertScope = () => {}, download = null,
  onStatus = () => {}, document: doc = globalThis.document} = {}) {
  const element = doc.createElement("details");element.className = "gis-raster-super-overlay-export";element.dataset.rasterSuperOverlay = "true";
  const text = (tag, value) => {const node = doc.createElement(tag);node.textContent = value;return node;};
  element.append(text("summary", "Export a raster super overlay"), text("p", "Select a local PNG/JPEG and enter its exact north-up WGS84 pixel edges. These coordinates are your declaration; a photograph has no inferred georeferencing. No upload, provider request or processing job is created."));
  const form = doc.createElement("form"), inputs = new Map();
  const field = (name, type = "text") => {
    const label = text("label", name), input = doc.createElement("input");input.type = type;input.required = true;
    input.setAttribute("aria-label", name);if (type === "number") input.step = "any";else input.maxLength = name === "Raster attribution" ? 8192 : 240;
    label.append(input);form.append(label);inputs.set(name, input);return input;
  };
  const file = field("Raster image file", "file");file.accept = ".png,.jpg,.jpeg,image/png,image/jpeg";
  field("Raster source identity");field("Raster export title");field("Raster attribution");
  for (const side of ["west", "south", "east", "north"]) field(`Raster ${side} edge`, "number");
  const tileLabel = text("label", "Raster tile size"), tiles = doc.createElement("select");tiles.setAttribute("aria-label", "Raster tile size");
  for (const size of [256, 512, 1024]) {const option = text("option", `${size} pixels`);option.value = String(size);tiles.append(option);}tiles.value = "512";
  tileLabel.append(tiles);form.append(tileLabel);
  const confirmation = doc.createElement("input");confirmation.type = "checkbox";confirmation.setAttribute("aria-label", "Confirm declared north-up EPSG:4326 grid");
  const confirmLabel = doc.createElement("label");confirmLabel.append(confirmation, " I declare these EPSG:4326 west/south/east/north edges describe this north-up image, with no unrecorded rotation or reprojection.");form.append(confirmLabel);
  const status = text("p", ""), limits = text("p", "Limits: 4 MiB input, 4096 pixels/axis, 31 overview/leaf tiles, 64 KiB per PNG and 96 KiB combined images. Richer imagery may exceed the existing native budget; no image will be silently omitted.");status.setAttribute("role", "status");
  const prepare = text("button", "Prepare raster super overlay"), cancel = text("button", "Cancel raster preparation"), kmz = text("button", "Download raster KMZ"), report = text("button", "Download raster loss report");
  for (const button of [prepare, cancel, kmz, report]) button.type = "button";
  form.append(prepare, cancel, kmz, report, limits, status);form.addEventListener("submit", event => event.preventDefault());element.append(form);
  let disposed = false, operation = null, prepared = null;
  const announce = value => {if (disposed) return;status.textContent = value;onStatus(value);};
  const update = () => {
    if (disposed) return;
    const enabled = available();prepare.disabled = !enabled || Boolean(operation);cancel.disabled = !operation;
    for (const input of [...inputs.values(), confirmation, tiles]) input.disabled = !enabled || Boolean(operation);
    kmz.disabled = report.disabled = !enabled || Boolean(operation) || !prepared;
    if (!enabled && operation) operation.abort();
  };
  const invalidate = () => {prepared = null;if (operation) operation.abort();else announce("Export settings changed. Prepare the raster again before downloading.");update();};
  for (const input of [...inputs.values(), confirmation, tiles]) input.addEventListener("change", invalidate);
  cancel.addEventListener("click", () => {operation?.abort();announce("Canceling raster preparation…");});
  const settings = () => {
    const numeric = side => {const raw = inputs.get(`Raster ${side} edge`).value.trim();if (!raw || !Number.isFinite(Number(raw))) fail(`Enter the exact ${side} image edge.`);return Number(raw);};
    if (!confirmation.checked) fail("Confirm the declared north-up EPSG:4326 grid before preparing an export.");
    const identity = inputs.get("Raster source identity").value.trim(), name = inputs.get("Raster export title").value.trim(), attribution = inputs.get("Raster attribution").value.trim();
    if (!identity || !name || !attribution) fail("Enter source identity, export title and recorded attribution. State Unknown where provenance is unavailable.");
    const bounds = [numeric("west"), numeric("south"), numeric("east"), numeric("north")];
    if (Math.abs(bounds[0]) > 180 || Math.abs(bounds[2]) > 180 || bounds[1] < -90 || bounds[3] > 90 || bounds[1] >= bounds[3] || bounds[0] === bounds[2]) fail("Image edges must be valid WGS84 coordinates with south below north and different west/east edges. West above east crosses the antimeridian.");
    return {identity, name, attribution, bounds, tileSize: Number(tiles.value)};
  };
  prepare.addEventListener("click", async () => {
    if (disposed || operation || !available()) return;
    const controller = operation = new AbortController();prepared = null;update();
    try {
      const choice = settings(), selected = file.files?.[0];await assertScope();controller.signal.throwIfAborted();
      if (disposed || !available()) fail("The selected workspace is no longer available.");
      announce("Reading the bounded local image…");
      const image = await readRasterOverlayImage(selected, {document: doc, signal: controller.signal});await assertScope();controller.signal.throwIfAborted();
      if (disposed || !available()) fail("The selected workspace changed before export.");
      announce("Preparing local overview and exact leaf tiles…");
      const result = await exportRasterSuperOverlay({...choice, ...image, signal: controller.signal,
        source: {identity: choice.identity, sha256: image.sha256, crs: "EPSG:4326", grid: "north-up-pixel-edges",
          georeferencing: "User-declared pixel edges; not inferred from this image or independently verified.",
          portrayal: "RGBA from browser decoding and canvas read. Original PNG/JPEG encoding, EXIF, ICC metadata and numeric raster bands remain in the source file.",
          originalFile: {filename: image.filename, bytes: image.byteLength, mediaType: image.mediaType},
          custody: "Original selected local file is unchanged and is not embedded in this portrayal export."}}, {DOMParser: doc.defaultView.DOMParser});
      await assertScope();controller.signal.throwIfAborted();if (disposed || !available()) fail("The selected workspace changed before the prepared result was accepted.");
      prepared = {...result, name: choice.name};announce(`Raster ready · ${image.width} × ${image.height} pixels · ${result.report.images.length} tiles. Review the loss report; the original file is unchanged.`);
    } catch (error) {if (!disposed) announce(controller.signal.aborted ? "Raster preparation canceled. No download or source change occurred." : `Raster export unavailable: ${error.message}`);}
    finally {if (operation === controller) operation = null;update();}
  });
  const send = download ? value => download.length >= 2 ? download(value.filename, value.bytes, value.mediaType) : download(value) : (({bytes, filename, mediaType}) => {
    const url = URL.createObjectURL(new Blob([bytes], {type: mediaType})), link = doc.createElement("a");
    link.href = url;link.download = filename;doc.body.append(link);link.click();link.remove();setTimeout(() => URL.revokeObjectURL(url), 0);
  });
  const save = async kind => {
    if (disposed || !prepared || operation || !available()) return;
    const result = prepared;
    try {
      await assertScope();if (disposed || !available() || result !== prepared) fail("The prepared raster or workspace changed. Prepare it again.");
      const basename = result.name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100) || "raster";
      await send(kind === "kmz" ? {bytes: result.bytes, filename: `${basename}.kmz`, mediaType: "application/vnd.google-earth.kmz"}
        : {bytes: new TextEncoder().encode(JSON.stringify(result.report, null, 2) + "\n"), filename: `${basename}-loss-report.json`, mediaType: "application/json"});
    } catch (error) {announce(`Raster download unavailable: ${error.message}`);}
  };
  kmz.addEventListener("click", () => save("kmz"));report.addEventListener("click", () => save("report"));
  update();
  // Keep the existing Node-returning embedding contract while exposing lifecycle
  // methods for retained Workbench instances.
  return Object.assign(element, {element, update, dispose() {if (disposed) return;disposed = true;operation?.abort();prepared = null;element.remove();}});
}
