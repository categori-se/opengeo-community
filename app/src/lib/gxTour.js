import {CAMERA_TOUR_LIMITS, CAMERA_TOUR_SCHEMA_VERSION, normalizeCameraTour} from "./cameraTour.js";

const KML = "http://www.opengis.net/kml/2.2", GX = "http://www.google.com/kml/ext/2.2";
// Exchange uses an explicit reference viewport, not an assertion that KML metres
// and a renderer zoom are equivalent on every device or projection.
const WORLD_METRES = 40075016.68557849, REFERENCE_HEIGHT = 768, FOV = 2 * Math.atan(1 / 3);
const children = node => Array.from(node.children ?? []);
const is = (node, name, ns = KML) => node.localName === name && node.namespaceURI === ns;
const fail = (code, message) => Object.assign(new Error(message), {code});
const bytes = value => new TextEncoder().encode(value).byteLength;
const escape = value => String(value).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"})[c]);

/** Parse a single bounded playlist without attaching data or reading resources. */
export function parseGxTour(text, {Parser = globalThis.DOMParser} = {}) {
  if (typeof text !== "string" || bytes(text) > CAMERA_TOUR_LIMITS.maximumSerializedBytes) throw fail("gx_tour_size", "Use a KML file of at most 256 KiB.");
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text) || /<\?(?!xml\s)/i.test(text)) throw fail("gx_tour_active_xml", "Document types, entities and processing instructions are unsupported.");
  if (typeof Parser !== "function") throw fail("gx_tour_parser", "The XML reader is unavailable.");
  const doc = new Parser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length || !is(doc.documentElement, "kml")) throw fail("gx_tour_xml", "Use valid KML 2.2 XML.");
  const report = [], elements = [];
  const walk = (node, depth = 0) => {
    if (depth > 32 || elements.length >= 8192) throw fail("gx_tour_complexity", "The KML structure exceeds the tour reader's limits.");
    elements.push(node);
    if (node.localName === "href" && !safeResourceAddress(node.textContent.trim())) {
      throw fail("gx_tour_resource_unsafe", "Unsafe resource addresses are rejected. No resource was opened.");
    }
    if (["NetworkLink", "NetworkLinkControl", "Link", "Url"].includes(node.localName)) throw fail("gx_tour_resource_unsupported", "Network-linked tour resources are unsupported. No resource was opened.");
    for (const child of children(node)) walk(child, depth + 1);
  };
  walk(doc.documentElement);
  const tours = elements.filter(node => is(node, "Tour", GX));
  if (tours.length !== 1) throw fail("gx_tour_single_required", "Choose a KML document containing exactly one gx:Tour.");
  const tourNode = tours[0], playlists = children(tourNode).filter(node => is(node, "Playlist", GX));
  if (playlists.length !== 1) throw fail("gx_tour_playlist", "The tour needs exactly one gx:Playlist.");
  const playlist = playlists[0], keyframes = [];
  const note = (code, path, message) => report.push({code, path, message});
  const read = (node, name, fallback, ns = KML) => {
    const found = children(node).filter(child => is(child, name, ns));
    if (found.length > 1 || found.some(child => children(child).length)) throw fail("gx_tour_field", `The ${name} field must be one literal value.`);
    return found.length ? found[0].textContent.trim() : fallback;
  };
  const number = (node, name, fallback, min, max, ns = KML) => {
    const raw = read(node, name, fallback, ns), value = typeof raw === "number" ? raw : raw === "" ? NaN : Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) throw fail("gx_tour_number", `The ${name} value is outside the supported range.`);
    return value;
  };
  const duration = (node, maximum) => {
    const ms = number(node, "duration", 0, 0, maximum / 1000, GX) * 1000, rounded = Math.round(ms);
    if (Math.abs(ms - rounded) > Number.EPSILON * Math.max(1, Math.abs(ms)) * 8) throw fail("gx_tour_duration", "Tour timing must use whole milliseconds.");
    return rounded;
  };
  const unknown = (node, allowed, path) => {
    for (const child of children(node)) if (!allowed.some(([name, ns]) => is(child, name, ns))) note("unsupported_element", `${path}/${child.nodeName}`, "This element is omitted from the imported camera tour.");
    for (const attr of Array.from(node.attributes ?? [])) if (!attr.name.startsWith("xmlns") && attr.name !== "id") note("unsupported_attribute", `${path}/@${attr.name}`, "This attribute is omitted from the imported camera tour.");
  };
  unknown(tourNode, [["name", KML], ["Playlist", GX]], "gx:Tour");
  unknown(playlist, [["FlyTo", GX], ["Wait", GX]], "gx:Playlist");
  for (const node of elements) if (is(node, "kml") || is(node, "Document") || is(node, "Folder")) {
    unknown(node, [["Document", KML], ["Folder", KML], ["Tour", GX], ["name", KML]], node.nodeName);
  }
  for (const node of elements) if (["Placemark", "GroundOverlay", "ScreenOverlay", "PhotoOverlay", "Style", "Schema"].some(name => is(node, name))) note("non_tour_content", node.nodeName, "This separate KML content is not imported by the camera tour reader.");
  for (const [index, primitive] of children(playlist).entries()) {
    const path = `gx:Playlist[${index + 1}]`;
    if (is(primitive, "Wait", GX)) {
      unknown(primitive, [["duration", GX]], path);
      if (!keyframes.length) throw fail("gx_tour_initial_wait", "A leading Wait has no starting camera. Begin the playlist with FlyTo.");
      keyframes.at(-1).holdMilliseconds += duration(primitive, CAMERA_TOUR_LIMITS.maximumHoldMilliseconds);
      if (keyframes.at(-1).holdMilliseconds > CAMERA_TOUR_LIMITS.maximumHoldMilliseconds) throw fail("gx_tour_hold_limit", "Combined waits at a view exceed 60 seconds.");
      continue;
    }
    if (!is(primitive, "FlyTo", GX)) {
      note("unsupported_primitive_timing", path, `${primitive.nodeName} execution, timing, audio, object updates and playback controls are not represented. The imported timeline includes only supported FlyTo and Wait primitives.`);
      continue;
    }
    unknown(primitive, [["duration", GX], ["flyToMode", GX], ["LookAt", KML], ["Camera", KML]], path);
    const views = children(primitive).filter(node => is(node, "LookAt") || is(node, "Camera"));
    if (views.length !== 1) throw fail("gx_tour_view", "Each FlyTo needs exactly one Camera or LookAt view.");
    const view = views[0], cameraView = is(view, "Camera");
    unknown(view, ["longitude", "latitude", "altitude", "heading", "tilt", "altitudeMode", cameraView ? "roll" : "range"].map(name => [name, KML]), `${path}/${view.localName}`);
    const center = [number(view, "longitude", 0, -180, 180), number(view, "latitude", 0, -85.051129, 85.051129)];
    const pitch = number(view, "tilt", 0, 0, 85), bearing = number(view, "heading", 0, -360, 360);
    const altitude = number(view, "altitude", 0, -Number.MAX_VALUE, Number.MAX_VALUE);
    const mode = read(view, "altitudeMode", "clampToGround");
    if (!["clampToGround", "relativeToGround", "absolute"].includes(mode)) throw fail("gx_tour_altitude_mode", "Sea-floor and unknown altitude modes are unsupported.");
    if (cameraView && (pitch !== 0 || number(view, "roll", 0, -180, 180) !== 0)) throw fail("gx_tour_camera_orientation", "Tilted or rolled KML Cameras cannot be converted to the current tour model. Use LookAt or tour JSON.");
    if (!cameraView && altitude !== 0 && mode !== "clampToGround") throw fail("gx_tour_target_altitude", "Elevated LookAt targets cannot be retained by the current tour model.");
    const range = cameraView ? altitude : number(view, "range", 0, 0, Number.MAX_VALUE);
    if (!(range > 0)) throw fail("gx_tour_range", "LookAt range or Camera altitude must be greater than zero.");
    const zoom = rangeToZoom(range, center[1]);
    if (!Number.isFinite(zoom) || zoom < 0 || zoom > 22) throw fail("gx_tour_zoom", "The KML view exceeds the supported tour zoom range.");
    const transitionMilliseconds = duration(primitive, CAMERA_TOUR_LIMITS.maximumTransitionMilliseconds);
    const flyToMode = read(primitive, "flyToMode", "bounce", GX);
    if (!["smooth", "bounce"].includes(flyToMode)) throw fail("gx_tour_fly_mode", "Unknown gx:flyToMode.");
    note("camera_reference_conversion", path, "Metres are converted to zoom using a 768-pixel-high Mercator reference view with a 36.87-degree field of view; framing varies by viewport, projection and terrain. Ground is treated as zero height.");
    note("interpolation_conversion", path, `KML ${flyToMode} flight is approximated by the existing smooth tour interpolation.`);
    if (!keyframes.length && transitionMilliseconds) note("initial_flight_omitted", path, "The first FlyTo establishes the starting view; its travel duration is omitted because no previous camera is stored.");
    keyframes.push({id: `view-${keyframes.length + 1}`, title: `KML view ${keyframes.length + 1}`, camera: {center, zoom, pitch, bearing}, transitionMilliseconds: keyframes.length ? transitionMilliseconds : 0, holdMilliseconds: 0, easing: "smooth"});
    if (keyframes.length > CAMERA_TOUR_LIMITS.maximumKeyframes) throw fail("gx_tour_keyframe_limit", "A tour supports at most 64 views.");
  }
  if (!keyframes.length) throw fail("gx_tour_no_views", "The playlist contains no supported camera views.");
  const tour = normalizeCameraTour({schemaVersion: CAMERA_TOUR_SCHEMA_VERSION, id: "primary-camera-tour", title: read(tourNode, "name", "Imported KML tour"), projection: "mercator", spatialBodyId: "earth", bindings: {}, keyframes});
  return {tour, report: {format: "kml-gx-tour", entries: report, hasLoss: report.length > 0}};
}

/** Standard FlyTo/Wait output; the report names all native semantics it cannot carry. */
export function exportGxTour(value) {
  // Inspect these before normalization: the existing tour schema retains only
  // center/zoom/pitch/bearing, so normalization alone would erase the evidence.
  const extendedCameras = value?.keyframes?.filter(frame => frame?.camera && ["roll", "elevation", "centerClampedToGround"].some(key => Object.hasOwn(frame.camera, key))) ?? [];
  if (extendedCameras.some(({camera}) => (Object.hasOwn(camera, "roll") && camera.roll !== 0)
    || (Object.hasOwn(camera, "elevation") && camera.elevation !== 0)
    || (Object.hasOwn(camera, "centerClampedToGround") && camera.centerClampedToGround !== true))) {
    throw fail("gx_tour_extended_camera", "KML tour export cannot retain camera roll, target elevation or unclamped ground. Keep the original camera data.");
  }
  const tour = normalizeCameraTour(value);
  if (tour.spatialBodyId !== "earth") throw fail("gx_tour_body", "KML tour export requires Earth.");
  const entries = [
    {code: "camera_reference_conversion", path: "gx:Tour", message: "Zoom becomes LookAt range using a 768-pixel-high Mercator reference view with a 36.87-degree field of view. KML viewers, viewport sizes, projection and terrain can change framing."},
    {code: "interpolation_conversion", path: "gx:Tour", message: "Native linear/smooth interpolation is exported as KML smooth flight; the motion path is not exact."},
    {code: "native_metadata_omitted", path: "gx:Tour", message: "View titles, native IDs, exact zoom, projection and map/Layer/imagery/narration bindings are not carried by this camera-only KML. Retain tour JSON for the exact native model."}
  ];
  if (extendedCameras.length) entries.push({code: "extended_camera_defaults_omitted", path: "gx:Tour", message: "Explicit default roll, target elevation and ground-clamping fields are not carried by the camera-only KML model."});
  if (tour.keyframes.some(frame => Object.hasOwn(frame, "layerVisibility"))) entries.push({code: "layer_events_omitted", path: "gx:Playlist", message: "Exact-version Layer visibility events are omitted; KML object updates do not provide the same access/version semantics. Retain tour JSON."});
  const playlist = tour.keyframes.map((frame, index) => {
    const c = frame.camera;
    const view = `<LookAt><longitude>${c.center[0]}</longitude><latitude>${c.center[1]}</latitude><altitude>0</altitude><heading>${c.bearing}</heading><tilt>${c.pitch}</tilt><range>${zoomToRange(c.zoom, c.center[1])}</range><altitudeMode>clampToGround</altitudeMode></LookAt>`;
    return `<gx:FlyTo><gx:duration>${index ? frame.transitionMilliseconds / 1000 : 0}</gx:duration><gx:flyToMode>smooth</gx:flyToMode>${view}</gx:FlyTo>${frame.holdMilliseconds ? `<gx:Wait><gx:duration>${frame.holdMilliseconds / 1000}</gx:duration></gx:Wait>` : ""}`;
  }).join("\n");
  const kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="${KML}" xmlns:gx="${GX}"><Document><gx:Tour><name>${escape(tour.title)}</name><gx:Playlist>\n${playlist}\n</gx:Playlist></gx:Tour></Document></kml>\n`;
  if (bytes(kml) > CAMERA_TOUR_LIMITS.maximumSerializedBytes) throw fail("gx_tour_size", "The exported KML exceeds 256 KiB.");
  return {kml, report: {format: "kml-gx-tour", entries, hasLoss: true}};
}

function rangeToZoom(range, latitude) {
  return Math.log2(WORLD_METRES * Math.cos(latitude * Math.PI / 180) * REFERENCE_HEIGHT / (1024 * Math.tan(FOV / 2) * range));
}
function zoomToRange(zoom, latitude) {
  return WORLD_METRES * Math.cos(latitude * Math.PI / 180) * REFERENCE_HEIGHT / (1024 * Math.tan(FOV / 2) * 2 ** zoom);
}

function safeResourceAddress(value) {
  if (!value || /[\u0000-\u0020\u007f\\]/u.test(value)) return false;
  if (/^https?:\/\//i.test(value)) {
    try {const url = new URL(value);return Boolean(url.hostname) && !url.username && !url.password;} catch {return false;}
  }
  return /^[A-Za-z0-9._/-]+$/.test(value) && !value.startsWith("/") && !value.split("/").includes("..");
}
