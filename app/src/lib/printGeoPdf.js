import {canonicalJson} from "./artifactCanonicalJson.js";
import {printCaptureOutputSignature} from "./printLayouts.js";

const PT_PER_MM = 72 / 25.4;
const EARTH_RADIUS = 6378137;
// GDAL v3.11.5 writes UL, LL, LR, UR, with geographic latitude/longitude pairs.
// https://github.com/OSGeo/gdal/blob/v3.11.5/frmts/pdf/pdfcreatecopy.cpp#L840-L942
// This is a native-interoperability profile, not a general ISO-conformance claim.
const CONTROL_ORDER = Object.freeze([0, 3, 2, 1]);
const LPTS = Object.freeze([0, 1, 0, 0, 1, 0, 1, 1]);
const registeredDocuments = new WeakSet();
const finite = value => typeof value === "number" && Number.isFinite(value);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const fail = message => {throw Error(`GeoPDF: ${message}`);};
const pair = value => Array.isArray(value) && value.length === 2 && value.every(finite);
const same = (left, right) => canonicalJson(left) === canonicalJson(right);
function closed(value, keys) {
  if (!plain(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)))
    fail("the geographic controls are invalid. Capture the map again.");
}
function projected([lng, lat]) {
  return [EARTH_RADIUS * lng * Math.PI / 180,
    EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
}

/** The original pixel-based letterbox, shared by drawing and registration. */
export function printMapPlacement(frame, capture) {
  if (![frame?.xMm, frame?.yMm].every(value => finite(value) && value >= 0 && value <= 1189)
    || ![frame?.widthMm, frame?.heightMm].every(value => finite(value) && value > 0 && value <= 1189)
    || ![capture?.width, capture?.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 20000))
    fail("the map frame dimensions are invalid.");
  const factor = Math.min(frame.widthMm / capture.width, frame.heightMm / capture.height);
  const width = capture.width * factor, height = capture.height * factor;
  return {x: frame.xMm + (frame.widthMm - width) / 2, y: frame.yMm + (frame.heightMm - height) / 2, width, height};
}

/** Controls are captured from the settled renderer, never inferred from a camera. */
export function assertPrintGeoReference(georeference, cssWidth, cssHeight) {
  if (![cssWidth, cssHeight].every(value => finite(value) && value > 0 && value <= 20000))
    fail("the captured viewport dimensions are invalid.");
  closed(georeference, ["crs", "geographicCrs", "controls"]);
  if (georeference.crs !== "EPSG:3857" || georeference.geographicCrs !== "EPSG:4326"
    || !Array.isArray(georeference.controls) || georeference.controls.length !== 4)
    fail("capture four controls from a flat Earth Mercator map.");
  const expected = [[0, 0], [cssWidth, 0], [cssWidth, cssHeight], [0, cssHeight]];
  for (const [index, control] of georeference.controls.entries()) {
    closed(control, ["css", "lngLat"]);
    if (!pair(control.css) || !same(control.css, expected[index]) || !pair(control.lngLat)
      || Math.abs(control.lngLat[0]) >= 180 || Math.abs(control.lngLat[1]) > 85.051129)
      fail("the geographic controls must match the four captured viewport corners.");
  }
  const longitudes = georeference.controls.map(control => control.lngLat[0]);
  if (Math.max(...longitudes) - Math.min(...longitudes) >= 180)
    fail("a map crossing the antimeridian or a world-copy boundary needs another extent.");
  const points = georeference.controls.map(control => projected(control.lngLat));
  const right = points[1].map((value, axis) => value - points[0][axis]);
  const down = points[3].map((value, axis) => value - points[0][axis]);
  const span = Math.max(Math.hypot(...right), Math.hypot(...down));
  const determinant = right[0] * down[1] - right[1] * down[0];
  const tolerance = Math.max(0.0001, span * 1e-9);
  if (!(span > 0.000001) || !(determinant < -Math.max(1e-12, Math.hypot(...right) * Math.hypot(...down) * 1e-10))
    || points[2].some((value, axis) => Math.abs(value - points[0][axis] - right[axis] - down[axis]) > tolerance))
    fail("the controls do not describe an affine flat Mercator map. Capture the map again.");
  return georeference;
}

/** Page-space registration for the existing single-page, main/inset profile. */
export function printGeoPdfRegistrations(layout, captures, layoutId) {
  if (!layout || layout.id !== layoutId || !Array.isArray(layout.frames) || !layout.frames.length || layout.frames.length > 2
    || ![layout.page?.widthMm, layout.page?.heightMm].every(value => finite(value) && value >= 50 && value <= 1189)
    || typeof captures?.get !== "function") fail("choose a captured single-page layout.");
  const names = new Set();
  return layout.frames.map(frame => {
    if (typeof frame.id !== "string" || !frame.id.length || frame.id.length > 100 || names.has(frame.id))
      fail("map frame identities must be unique.");
    names.add(frame.id);
    const capture = captures.get(`${layoutId}:${frame.id}`), scene = capture?.vectorScene;
    if (!scene?.georeference) fail(`${frame.title ?? frame.id}: capture this map again to include geographic controls.`);
    if (capture.signature !== canonicalJson({view: frame.view, presentation: frame.presentation})
      || capture.outputSignature !== undefined && capture.outputSignature !== printCaptureOutputSignature(frame, layout.dpi)
      || scene.signature !== capture.signature || !same(scene.view, capture.view)
      || scene.cssWidth !== capture.cssWidth || scene.cssHeight !== capture.cssHeight || capture.view?.pitch !== 0)
      fail("the captured view or map settings changed. Capture every map frame again.");
    const georeference = assertPrintGeoReference(scene.georeference, scene.cssWidth, scene.cssHeight);
    const placement = printMapPlacement(frame, capture);
    const {x, y, width, height} = placement, page = layout.page;
    if (x < -1e-8 || y < -1e-8 || x + width > page.widthMm + 1e-8 || y + height > page.heightMm + 1e-8)
      fail("the map viewport lies outside the paper.");
    const lngLat = georeference.controls.map(control => control.lngLat);
    return {frameId: frame.id, name: frame.id, pageNumber: 1, crs: "EPSG:3857",
      bbox: [x, page.heightMm - y - height, x + width, page.heightMm - y].map(value => value * PT_PER_MM),
      lpts: [...LPTS], gpts: CONTROL_ORDER.flatMap(index => [lngLat[index][1], lngLat[index][0]]),
      geographicBounds: [Math.min(...lngLat.map(point => point[0])), Math.min(...lngLat.map(point => point[1])),
        Math.max(...lngLat.map(point => point[0])), Math.max(...lngLat.map(point => point[1]))]};
  });
}

// ESRI WKT expresses the same spherical Mercator projection as EPSG:3857.
// Auxiliary_Sphere_Type=0 uses the WGS84 semimajor axis, matching the renderer.
const MERCATOR_WKT = 'PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]],PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0],PARAMETER["False_Northing",0],PARAMETER["Central_Meridian",0],PARAMETER["Standard_Parallel_1",0],PARAMETER["Auxiliary_Sphere_Type",0],UNIT["Meter",1]]';
// PDF numbers cannot use JavaScript's exponential notation for small controls.
const pdfNumber = value => value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "").replace(/^-0$/, "0");
const pdfArray = values => `[${values.map(pdfNumber).join(" ")}]`;
function pdfString(value) {
  if (/^[\x20-\x7e]*$/.test(value)) return `(${value.replace(/[\\()]/g, character => `\\${character}`)})`;
  return `<FEFF${[...Array(value.length)].map((_, index) => value.charCodeAt(index).toString(16).padStart(4, "0")).join("")}>`;
}
function checkedRegistration(value) {
  if (!plain(value) || typeof value.name !== "string" || !value.name.length || value.name.length > 100
    || value.pageNumber !== 1 || value.crs !== "EPSG:3857"
    || !Array.isArray(value.bbox) || value.bbox.length !== 4 || !value.bbox.every(number => finite(number) && number >= -1e-8 && number <= 14400)
    || !(value.bbox[2] > value.bbox[0] && value.bbox[3] > value.bbox[1])
    || !same(value.lpts, LPTS) || !Array.isArray(value.gpts) || value.gpts.length !== 8
    || !value.gpts.every((number, index) => finite(number) && Math.abs(number) <= (index % 2 ? 180 : 85.051129)))
    fail("the PDF registration is invalid.");
  return {name: value.name, pageNumber: 1, bbox: [...value.bbox], lpts: [...value.lpts], gpts: [...value.gpts]};
}

/** Attach dictionaries without changing the existing painted paths or page streams. */
export function registerPrintPdfMaps(pdf, registrations = []) {
  if (!Array.isArray(registrations) || registrations.length > 2) fail("a page supports one main map and one inset.");
  if (!registrations.length) return;
  const maps = registrations.map(checkedRegistration), internal = pdf?.internal;
  if (registeredDocuments.has(pdf) || !internal?.events?.subscribe || typeof internal.newAdditionalObject !== "function"
    || typeof internal.write !== "function" || typeof pdf.__private__?.setPdfVersion !== "function"
    || pdf.getNumberOfPages?.() !== 1 || new Set(maps.map(map => map.name)).size !== maps.length)
    fail("the PDF writer cannot register this single-page layout.");
  const page = internal.getPageInfo?.(1)?.pageContext;
  if (!page?.mediaBox || page.userUnit !== 1 || page.mediaBox.bottomLeftX !== 0 || page.mediaBox.bottomLeftY !== 0
    || maps.some(map => map.bbox[2] > page.mediaBox.topRightX + 1e-7 || map.bbox[3] > page.mediaBox.topRightY + 1e-7))
    fail("the PDF page dimensions do not match the map registration.");
  registeredDocuments.add(pdf);
  pdf.__private__.setPdfVersion("1.7");
  let pending = [];
  internal.events.subscribe("buildDocument", () => {pending = [];});
  internal.events.subscribe("putPage", event => {
    if (event.pageNumber !== 1) return;
    const viewports = maps.map(map => {
      const gcs = internal.newAdditionalObject(), measure = internal.newAdditionalObject(), viewport = internal.newAdditionalObject();
      pending.push({map, gcs, measure, viewport});return `${viewport.objId} 0 R`;
    });
    internal.write(`/VP [${viewports.join(" ")}]`);
  });
  internal.events.subscribe("putAdditionalObjects", () => {
    for (const {map, gcs, measure, viewport} of pending) {
      gcs.content = `<< /Type /PROJCS /EPSG 3857 /WKT ${pdfString(MERCATOR_WKT)} >>`;
      measure.content = `<< /Type /Measure /Subtype /GEO /Bounds ${pdfArray(LPTS)} /LPTS ${pdfArray(map.lpts)} /GPTS ${pdfArray(map.gpts)} /GCS ${gcs.objId} 0 R >>`;
      viewport.content = `<< /Type /Viewport /Name ${pdfString(map.name)} /BBox ${pdfArray(map.bbox)} /Measure ${measure.objId} 0 R >>`;
    }
  });
}
