import {createPropertyExpression, featureFilter, latest} from "@maplibre/maplibre-gl-style-spec";
import {sha256} from "@noble/hashes/sha2.js";
import {canonicalJson} from "./artifactCanonicalJson.js";
import {assertPrintGeoReference} from "./printGeoPdf.js";
import {printLayerPresentation} from "./printLayouts.js";
import {referencedStylePaint, validateLayerStyleReference} from "./layerStyleReference.js";
import {combineMapFilters} from "./mapFilter.js";

export const PRINT_VECTOR_SCHEMA = "opengeo.print-vector-scene.1.0.0";
export const PRINT_VECTOR_LIMITS = Object.freeze({features: 10000, coordinates: 100000, commands: 30000,
  passes: 128, evaluations: 1000000, bytes: 8 * 1024 * 1024});
const TYPES = new Set(["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"]);
const PAINT = {
  background: ["background-color", "background-opacity"],
  fill: ["fill-color", "fill-opacity", "fill-outline-color", "fill-antialias", "fill-layer-opacity"],
  line: ["line-color", "line-width", "line-opacity", "line-layer-opacity"],
  circle: ["circle-color", "circle-radius", "circle-opacity", "circle-stroke-color", "circle-stroke-width", "circle-stroke-opacity"]
};
const OPERATIONS = new Set(["literal", "get", "has", "id", "geometry-type", "feature-state", "zoom", "case", "match", "step",
  "interpolate", "interpolate-hcl", "interpolate-lab", "linear", "exponential", "cubic-bezier", "typeof", "coalesce", "to-number",
  "to-string", "to-boolean", "to-color", "number", "string", "boolean", "array", "==", "!=", "<", "<=", ">", ">=", "!", "all", "any",
  "in", "at", "length", "index-of", "slice", "+", "-", "*", "/", "%", "^", "min", "max", "abs", "round", "floor", "ceil", "sqrt",
  "ln", "log10", "log2", "concat", "upcase", "downcase", "let", "var", "rgb", "rgba", "none", "!in", "!has"]);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const finite = value => typeof value === "number" && Number.isFinite(value);
const name = value => typeof value === "string" && value.length > 0 && value.length <= 200;
const equal = (left, right) => canonicalJson(left) === canonicalJson(right);
const hash = value => [...sha256(new TextEncoder().encode(canonicalJson(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
const fail = message => {throw Error(`Vector output: ${message}`);};
function closed(value, keys) {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) fail("the captured scene is invalid. Capture the map again.");
}
function boundedJson(value, maximum = PRINT_VECTOR_LIMITS.bytes) {
  let nodes = 0, chars = 0;
  function visit(value, depth) {
    if (++nodes > 600000 || depth > 32) fail("the loaded scene exceeds its safe metadata allowance. Use fewer or smaller Layers.");
    if (typeof value === "string") chars += value.length;
    else if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
    else if (plain(value)) for (const key of Object.keys(value)) {chars += key.length;visit(value[key], depth + 1);}
    else if (value !== null && typeof value !== "boolean" && !finite(value)) fail("the loaded scene contains invalid metadata.");
    if (chars > maximum) fail("the loaded scene exceeds its safe byte allowance. Use fewer or smaller Layers.");
  }
  visit(value, 0);
  const serialized = canonicalJson(value);
  if (new TextEncoder().encode(serialized).byteLength > maximum) fail("the loaded scene exceeds its safe byte allowance. Use fewer or smaller Layers.");
  return serialized;
}
function expressionCost(value) {
  let count = 0;
  function visit(value, depth = 0, literal = false) {
    if (++count > 2048 || depth > 16 || typeof value === "string" && value.length > 4096) fail("a Style expression is too large.");
    if (Array.isArray(value)) {
      if (!literal && !OPERATIONS.has(value[0])) fail(`Style expression ${String(value[0])} needs the existing raster output.`);
      value.forEach((child, index) => visit(child, depth + 1, literal || value[0] === "literal"
        || value[0] === "match" && index >= 2 && index < value.length - 1 && index % 2 === 0));
    } else if (plain(value)) {
      if (!literal) fail("legacy Style functions need the existing raster output.");
      Object.values(value).forEach(child => visit(child, depth + 1, true));
    }
  }
  visit(value);return count;
}
function compilePaint(part) {
  if (!PAINT[part.type] || Object.keys(part.paint ?? {}).some(key => !PAINT[part.type].includes(key)))
    fail(`${part.id} has unsupported paint (patterns, translated/blurred/gradient content require raster output).`);
  if (part.paint?.["fill-outline-color"] !== undefined) fail(`${part.id} has an explicit antialiased fill outline. Use a separate line pass or raster output.`);
  const layout = part.layout ?? {};
  if (Object.keys(layout).some(key => !["visibility", ...(part.type === "line" ? ["line-cap", "line-join", "line-miter-limit", "line-round-limit"] : [])].includes(key)))
    fail(`${part.id} has unsupported layout. Disable labels/sorting or use raster output.`);
  if (part.type === "line" && (layout["line-cap"] !== undefined && !["butt", "round", "square"].includes(layout["line-cap"])
    || layout["line-join"] !== undefined && !["bevel", "round", "miter"].includes(layout["line-join"])
    || layout["line-miter-limit"] !== undefined && (!finite(layout["line-miter-limit"]) || layout["line-miter-limit"] < 1 || layout["line-miter-limit"] > 100)
    || layout["line-round-limit"] !== undefined)) fail(`${part.id} has unsupported line joins/caps. Use the default line layout or raster output.`);
  const programs = new Map();let cost = 0;
  for (const key of PAINT[part.type]) {
    const spec = latest[`paint_${part.type}`]?.[key];
    if (key.endsWith("-layer-opacity")) {
      if (part.paint?.[key] !== undefined && (!finite(part.paint[key]) || part.paint[key] < 0 || part.paint[key] > 1)) fail("composite opacity must be a fixed value between zero and one.");
      continue;
    }
    let value = part.paint?.[key] ?? spec?.default;
    // An unspecified fill outline inherits the evaluated fill color.
    if (key === "fill-outline-color" && part.paint?.[key] === undefined) continue;
    if (value === undefined) fail(`${part.id} has an unavailable Style default.`);
    cost += expressionCost(value);
    const parsed = createPropertyExpression(value, key, spec);
    if (parsed.result !== "success" || parsed.value.globalStateRefs.size) fail(`${part.id} has an unsupported Style expression.`);
    programs.set(key, parsed.value);
  }
  return {programs, cost};
}
function viewFor(map) {
  const center = map.getCenter();
  return {center: [center.lng, center.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing()};
}
function validView(view) {
  return plain(view) && Object.keys(view).length === 4 && Array.isArray(view.center) && view.center.length === 2
    && view.center.every(finite) && Math.abs(view.center[0]) < 180 && Math.abs(view.center[1]) <= 85.051129
    && finite(view.zoom) && view.zoom >= 0 && view.zoom <= 30 && view.pitch === 0 && finite(view.bearing);
}
function sourcePin(layer, input, mapRecord) {
  const canonical = mapRecord?.definition?.layers?.find(item => item.layerId === layer.layerId);
  const pin = input?.inputPin;
  if (!canonical || !plain(pin) || input.id !== layer.layerId || !name(layer.layerId)) fail("a loaded Layer no longer matches this Project. Reopen and capture it again.");
  const result = {};
  for (const key of ["layerId", "datasetId", "datasetVersionId", "sourceVersion"]) {
    const expected = layer[key] ?? null;
    if ((canonical[key] ?? null) !== expected || !Object.hasOwn(pin, key) || pin[key] !== expected) fail(`${layer.title ?? layer.layerId} has changed source/version pins. Reopen it and capture again.`);
    if (expected !== null && !(key === "sourceVersion" && Number.isSafeInteger(expected) && expected >= 0) && !name(expected)) fail("a source pin is invalid.");
    result[key] = expected;
  }
  result.featureGeneration = pin.featureGeneration ?? null;
  result.checksumSha256 = pin.checksumSha256 ?? null;
  result.styleReference = structuredClone(layer.styleReference ?? null);
  if (result.featureGeneration !== null && (!Number.isSafeInteger(result.featureGeneration) || result.featureGeneration < 0)
    || result.checksumSha256 !== null && !/^[a-f0-9]{64}$/.test(result.checksumSha256)) fail("a loaded source receipt is invalid.");
  return result;
}
function geometryParts(geometry, budget) {
  if (geometry === null) return [];
  if (!plain(geometry) || !TYPES.has(geometry.type)) fail("GeometryCollection or unknown geometry needs raster output.");
  const type = geometry.type, coordinates = geometry.coordinates;
  const groups = type === "Point" ? [[[coordinates]]] : type === "MultiPoint" || type === "LineString" ? [[coordinates]]
    : type === "MultiLineString" || type === "Polygon" ? [coordinates] : coordinates;
  if (!Array.isArray(groups) || !groups.length) fail("a loaded geometry is empty or invalid.");
  for (const parts of groups) {
    if (!Array.isArray(parts) || !parts.length) fail("a loaded geometry is invalid.");
    for (const points of parts) {
      if (!Array.isArray(points) || !points.length) fail("a loaded geometry is invalid.");
      let previous = null;
      for (const point of points) {
        if (++budget.coordinates > PRINT_VECTOR_LIMITS.coordinates) fail("the full-source coordinate limit was reached. Use fewer or smaller Layers.");
        if (!Array.isArray(point) || point.length < 2 || !point.slice(0, 2).every(finite) || Math.abs(point[0]) >= 180 || Math.abs(point[1]) > 85.051129)
          fail("coordinates outside the flat Mercator/world boundary need raster output.");
        if (previous && Math.abs(point[0] - previous[0]) >= 180) fail("antimeridian geometry needs raster output.");
        previous = point;
      }
      if (type.includes("LineString") && points.length < 2 || type.includes("Polygon") && (points.length < 4 || !equal(points[0].slice(0, 2), points.at(-1).slice(0, 2))))
        fail("a loaded line or polygon ring is invalid.");
    }
  }
  return groups;
}
function color(value) {
  if (!value?.rgb || !value.rgb.every(finite) || value.rgb.length !== 4 || value.rgb.some(channel => channel < 0 || channel > 1)) fail("a Style color could not be evaluated faithfully.");
  return {color: `rgb(${value.rgb.slice(0, 3).map(channel => Number((channel * 255).toFixed(6))).join(" ")})`, alpha: value.rgb[3]};
}
function number(value, maximum = 4096) {
  if (!finite(value) || value < 0 || value > maximum) fail("a Style width/radius/opacity is outside the vector allowance.");
  return value;
}
function evaluate(programs, feature, state, zoom) {
  const result = {};
  for (const [key, program] of programs) {
    try {result[key] = program.evaluateWithoutErrorHandling({zoom}, feature, state);}
    catch {fail("a Style expression cannot evaluate this source feature. Use raster output or correct its Style.");}
  }
  return result;
}
function commandsFor(part, feature, groups, values, project) {
  const command = (kind, geometry, fill, fillOpacity, stroke = null, strokeOpacity = 0, strokeWidth = 0) => ({kind, ...geometry,
    fill: fill?.color ?? null, fillOpacity: fill ? fill.alpha * fillOpacity : 0,
    stroke: stroke?.color ?? null, strokeOpacity: stroke ? stroke.alpha * strokeOpacity : 0, strokeWidth});
  if (part.type === "background") return [command("rect", project, color(values["background-color"]), number(values["background-opacity"], 1))];
  const type = feature.geometry.type;
  if (part.type === "circle") {
    if (!["Point", "MultiPoint"].includes(type)) return [];
    const radius = number(values["circle-radius"]), width = number(values["circle-stroke-width"]);
    return groups.flat(2).flatMap(point => {
      const [cx, cy] = project(point), commands = [command("circle", {cx, cy, r: radius}, color(values["circle-color"]), number(values["circle-opacity"], 1))];
      // MapLibre's stroke is outside the fill radius. Keep translucent paint
      // separate so the fill never leaks beneath an independently alpha stroke.
      if (width) commands.push(command("circle", {cx, cy, r: radius + width / 2}, null, 0,
        color(values["circle-stroke-color"]), number(values["circle-stroke-opacity"], 1), width));
      return commands;
    });
  }
  if (part.type === "fill") {
    if (!["Polygon", "MultiPolygon"].includes(type)) return [];
    const fill = color(values["fill-color"]), opacity = number(values["fill-opacity"], 1);
    // SVG uses its own edge antialiasing; an ordinary SVG stroke would change
    // geometry extent and overlap alpha instead of reproducing MapLibre's AA.
    return groups.map(parts => ({...command("path", {points: parts.map(points => points.map(project)), closed: true}, fill, opacity),
      lineCap: "butt", lineJoin: "miter", miterLimit: 2}));
  }
  if (!["LineString", "MultiLineString", "Polygon", "MultiPolygon"].includes(type)) return [];
  return groups.flatMap(parts => parts.map(points => ({...command("path", {points: [points.map(project)], closed: type.includes("Polygon")}, null, 0,
    color(values["line-color"]), number(values["line-opacity"], 1), number(values["line-width"])),
    lineCap: part.layout?.["line-cap"] ?? "butt", lineJoin: part.layout?.["line-join"] ?? "miter", miterLimit: number(part.layout?.["line-miter-limit"] ?? 2, 100)})));
}

function installedPass(part) {
  const keys = ["id", "type", "source", "filter", "minzoom", "maxzoom", "paint", "layout"];
  if (!plain(part) || Object.keys(part).some(key => ![...keys, "metadata", "source-layer"].includes(key))) fail("a visible pass has unsupported installed settings.");
  if (part.source !== undefined && (!name(part.source) || /(?:https?:|data:|\/\/)/i.test(part.source))) fail("remote source URLs cannot enter a vector scene.");
  if (part.minzoom !== undefined && (!finite(part.minzoom) || part.minzoom < 0 || part.minzoom > 30)
    || part.maxzoom !== undefined && (!finite(part.maxzoom) || part.maxzoom < 0 || part.maxzoom > 30)) fail("an installed zoom interval is invalid.");
  return Object.fromEntries(keys.filter(key => Object.hasOwn(part, key)).map(key => [key, structuredClone(part[key])]));
}
const zoomFilter = value => Array.isArray(value) && value[0] !== "literal" && (value[0] === "zoom" || value.slice(1).some(zoomFilter));

/** Read-only snapshot of a deliberately closed, complete-source MapLibre profile. */
export function capturePrintVectorScene(context, mapRecord) {
  const map = context?.map;
  if (context?.renderer !== "maplibre" || !context.ready || !map?.isStyleLoaded?.() || map.areTilesLoaded?.() === false || map.isMoving?.())
    fail("wait for the MapLibre map and all visible Layers/Styles to settle, then capture again.");
  // MapLibre 6.4.1 style.ts:658 and map.ts:4330: target expressions may already
  // be serialized while their old paint is still transitioning on the canvas.
  if (typeof map.loaded !== "function" || typeof map.style?.hasTransitions !== "function" || !map.loaded() || map.style.hasTransitions())
    fail("wait for map loading and paint transitions to finish, then capture again.");
  const style = map.getStyle(), canvas = map.getCanvas(), cssWidth = canvas.clientWidth, cssHeight = canvas.clientHeight, view = viewFor(map);
  if (!validView(view) || (map.getRoll?.() ?? 0) !== 0 || (map.getProjection?.()?.type ?? context.project?.projection ?? "mercator") !== "mercator"
    || (context.project?.spatialBody?.id ?? "earth") !== "earth" || map.getTerrain?.() || style.terrain || style.fog)
    fail("use an unpitched Earth Mercator map with terrain/fog disabled.");
  // Studio keeps sky settings in its flat style. In pinned MapLibre 6.4.1,
  // mercator_utils.getMercatorHorizon places that sky beyond the viewport at
  // pitch zero; atmosphere renders only on the globe and ground fog needs terrain.
  // These stored settings do not represent visible content in this admitted view.
  if (![cssWidth, cssHeight].every(value => finite(value) && value > 0 && value <= 20000)) fail("open the map frame before capturing vectors.");
  const corners = [[0, 0], [cssWidth, 0], [cssWidth, cssHeight], [0, cssHeight]].map(point => map.unproject(point));
  if (corners.some(point => !finite(point.lng) || !finite(point.lat) || Math.abs(point.lng) >= 180 || Math.abs(point.lat) > 85.051129)
    || Math.max(...corners.map(point => point.lng)) - Math.min(...corners.map(point => point.lng)) >= 180)
    fail("this frame crosses an antimeridian/world-copy boundary. Zoom to one local extent or use raster output.");
  if (!Array.isArray(style.layers) || style.layers.length > PRINT_VECTOR_LIMITS.passes || !Array.isArray(context.layers)) fail("the installed scene exceeds the vector pass limit.");
  // getStyle() excludes custom WebGL passes; the public order API includes them.
  if (typeof map.getLayersOrder !== "function" || !equal(map.getLayersOrder(), style.layers.map(part => part.id)))
    fail("the renderer contains custom or unenumerated visible passes. Remove them or use raster output.");
  const presentation = context.layers.map(printLayerPresentation), signature = canonicalJson({view, presentation});
  const budget = {coordinates: 0, features: 0, commands: 0, evaluations: 0}, owners = new Map(), sources = new Map(), sourcePins = [], passes = [];
  for (const layer of context.layers) for (const id of context.handles.get(layer.layerId)?.layerIds ?? []) {
    if (owners.has(id)) fail("installed passes have ambiguous Layer ownership.");
    owners.set(id, layer);
  }
  const project = point => {
    const projected = map.project(point), result = [projected.x, projected.y];
    if (!result.every(value => finite(value) && Math.abs(value) <= 10000000)) fail("a projected coordinate exceeds the vector allowance.");
    return result;
  };
  for (const part of style.layers) {
    if (part.layout?.visibility === "none" || finite(part.minzoom) && view.zoom < part.minzoom || finite(part.maxzoom) && view.zoom >= part.maxzoom) continue;
    if (!name(part.id) || !PAINT[part.type]) fail(`${part.id ?? "a visible pass"} is not supported as vectors. Hide labels, sprites, raster/basemap imagery, patterns, heatmaps or 3D content, or use raster output.`);
    // Geometry bucket filters use tile zoom; paint expressions use current map
    // zoom. A source-only snapshot cannot reconstruct the former tile decisions.
    if (zoomFilter(part.filter)) fail(`${part.id} has a zoom-dependent filter. Use a property filter or raster output.`);
    const installed = installedPass(part);boundedJson(installed, 65536);
    const {programs, cost} = compilePaint(part), owner = owners.get(part.id);
    if (part.type === "background") {
      if (part.source || part.filter || Object.keys(part.layout ?? {}).some(key => key !== "visibility")) fail("the background must be a solid color.");
      const values = evaluate(programs, {properties: {}, type: "Point"}, {}, view.zoom);
      passes.push({id: part.id, type: part.type, layerId: null, installed, layerOpacity: 1,
        commands: commandsFor(part, null, null, values, {x: 0, y: 0, width: cssWidth, height: cssHeight})});
      continue;
    }
    if (!owner || owner.visible === false || owner.managedDisplayId || owner.pointClustering?.enabled || context.handles.get(owner.layerId)?.clustered)
      fail(`${part.id} is not a complete unclustered loaded Layer. Hide it or use raster output.`);
    const handle = context.handles.get(owner.layerId), installedSource = style.sources?.[part.source];
    if (handle.sourceId !== part.source || part["source-layer"] || installedSource?.type !== "geojson" || installedSource.cluster)
      fail(`${owner.title ?? part.id} uses a tiled/managed/clustered source. Use a complete loaded GeoJSON Layer or raster output.`);
    if (installedSource.filter !== undefined) fail(`${owner.title ?? part.id} has a source-level worker filter. Use a Layer property filter or raster output.`);
    if (owner.styleReference) {
      if (!handle.boundStyle?.reference || !equal(handle.boundStyle.reference, owner.styleReference)) fail("the pinned Style is unresolved. Reload it before vector capture.");
      const expected = referencedStylePaint(handle.boundStyle, owner).find(item => item.id === part.id);
      if (!expected || expected.type !== part.type || !equal(expected.paint, part.paint ?? {})
        || !equal(combineMapFilters(expected.filter ?? null, owner.filter ?? null), part.filter ?? null)) fail("installed paint differs from the pinned Style. Reload it before vector capture.");
    }
    if (!sources.has(owner.layerId)) {
      const input = context.getPrintDataSource?.(owner.layerId), data = input?.geojson;
      if (data?.type !== "FeatureCollection" || !Array.isArray(data.features) || data.opengeo?.mayBeTruncated || data.opengeo?.schemaVersion === "opengeo.live-feature-page.1.0.0")
        fail(`${owner.title ?? owner.layerId} needs its complete loaded GeoJSON source. Live/truncated pages need raster output.`);
      budget.features += data.features.length;
      if (budget.features > PRINT_VECTOR_LIMITS.features) fail("the full-source feature limit was reached. Use fewer or smaller Layers.");
      const pin = sourcePin(owner, input, mapRecord), canonicalData = boundedJson(data);
      if (installedSource.data?.type !== "FeatureCollection" || boundedJson(installedSource.data) !== canonicalData)
        fail(`${owner.title ?? owner.layerId} has changed installed source data. Reopen it and capture again.`);
      const records = data.features.map((feature, index) => {
        if (!plain(feature) || feature.type !== "Feature" || feature.properties != null && !plain(feature.properties)) fail("a loaded feature is invalid.");
        const groups = geometryParts(feature.geometry, budget);
        const id = typeof installedSource.promoteId === "string" ? feature.properties?.[installedSource.promoteId]
          : installedSource.generateId ? index : feature.id;
        if (installedSource.promoteId !== undefined && typeof installedSource.promoteId !== "string") fail("this source's feature identity mapping needs raster output.");
        return {feature, groups, input: {id, type: feature.geometry?.type.replace(/^Multi/, "") ?? "Unknown", properties: feature.properties ?? {}}};
      });
      pin.geometryChecksumSha256 = hash(data);pin.featureCount = data.features.length;
      sourcePins.push(pin);sources.set(owner.layerId, records);
    }
    const filterValue = part.filter ?? undefined, filterCost = filterValue === undefined ? 0 : expressionCost(filterValue);
    let filter;
    try {filter = featureFilter(filterValue, "printVectorScene.filter");} catch {fail(`${part.id} has an unsupported filter.`);}
    if (filter.needGeometry || filter.getGlobalStateRefs().size) fail(`${part.id} has a geometry/global-state filter that needs raster output.`);
    const commands = [], needsState = [...programs.values()].some(program => program.isStateDependent);
    for (const {feature, groups, input} of sources.get(owner.layerId)) {
      budget.evaluations += cost + filterCost + 1;
      if (budget.evaluations > PRINT_VECTOR_LIMITS.evaluations) fail("the Style evaluation allowance was reached. Use fewer Layers or a simpler Style.");
      if (!feature.geometry || !filter.filter({zoom: view.zoom}, input)) continue;
      let state = {};
      if (needsState && input.id !== undefined) {
        if (typeof map.getFeatureState !== "function") fail("current selection/hover Style state is unavailable. Clear the selection or use raster output.");
        state = map.getFeatureState({source: part.source, id: input.id});boundedJson(state, 32768);
      }
      const values = evaluate(programs, input, state, view.zoom), added = commandsFor(part, feature, groups, values, project);
      budget.commands += added.length;
      if (budget.commands > PRINT_VECTOR_LIMITS.commands) fail("the vector command limit was reached. Use fewer or smaller Layers.");
      commands.push(...added);
    }
    passes.push({id: part.id, type: part.type, layerId: owner.layerId, installed,
      layerOpacity: part.paint?.[`${part.type}-layer-opacity`] ?? 1, commands});
  }
  const georeference = {crs: "EPSG:3857", geographicCrs: "EPSG:4326",
    controls: corners.map((point, index) => ({css: [[0, 0], [cssWidth, 0], [cssWidth, cssHeight], [0, cssHeight]][index], lngLat: [point.lng, point.lat]}))};
  assertPrintGeoReference(georeference, cssWidth, cssHeight);
  const scene = {schemaVersion: PRINT_VECTOR_SCHEMA, cssWidth, cssHeight, view, signature, sourcePins, passes, georeference};
  boundedJson(scene);scene.checksumSha256 = hash(scene);
  return assertPrintVectorScene(scene, {cssWidth, cssHeight, view, signature});
}

/** Validate before creating any SVG nodes; saved layout metadata never contains this scene. */
export function assertPrintVectorScene(scene, capture) {
  closed(scene, ["schemaVersion", "cssWidth", "cssHeight", "view", "signature", "sourcePins", "passes", "georeference", "checksumSha256"]);
  boundedJson(scene);
  if (scene.schemaVersion !== PRINT_VECTOR_SCHEMA || !validView(scene.view) || ![scene.cssWidth, scene.cssHeight].every(value => finite(value) && value > 0 && value <= 20000)
    || !/^[a-f0-9]{64}$/.test(scene.checksumSha256) || typeof scene.signature !== "string" || scene.signature.length > 2000000
    || !Array.isArray(scene.passes) || scene.passes.length > PRINT_VECTOR_LIMITS.passes || !Array.isArray(scene.sourcePins) || scene.sourcePins.length > 250)
    fail("the captured scene is invalid. Capture the map again.");
  if (capture && (scene.cssWidth !== capture.cssWidth || scene.cssHeight !== capture.cssHeight || scene.signature !== capture.signature || !equal(scene.view, capture.view)))
    fail("the vector scene no longer matches the captured map. Capture the frame again.");
  const {checksumSha256, ...payload} = scene;
  if (scene.georeference !== undefined) assertPrintGeoReference(scene.georeference, scene.cssWidth, scene.cssHeight);
  if (hash(payload) !== checksumSha256) fail("the captured vector scene changed. Capture the map again.");
  let commands = 0, coordinates = 0, features = 0;const ids = new Set(), pins = new Set();
  for (const pin of scene.sourcePins) {
    closed(pin, ["layerId", "datasetId", "datasetVersionId", "sourceVersion", "featureGeneration", "checksumSha256", "styleReference", "geometryChecksumSha256", "featureCount"]);
    if (Object.keys(pin).length !== 9 || !name(pin.layerId) || pins.has(pin.layerId) || !Number.isSafeInteger(pin.featureCount) || pin.featureCount < 0 || !/^[a-f0-9]{64}$/.test(pin.geometryChecksumSha256)
      || ![pin.datasetId, pin.datasetVersionId].every(value => value === null || name(value))
      || !(pin.sourceVersion === null || name(pin.sourceVersion) || Number.isSafeInteger(pin.sourceVersion) && pin.sourceVersion >= 0)
      || !(pin.featureGeneration === null || Number.isSafeInteger(pin.featureGeneration) && pin.featureGeneration >= 0)
      || !(pin.checksumSha256 === null || typeof pin.checksumSha256 === "string" && /^[a-f0-9]{64}$/.test(pin.checksumSha256))) fail("the source receipt is invalid.");
    if (pin.styleReference !== null) {try {validateLayerStyleReference(pin.styleReference);} catch {fail("the source Style receipt is invalid.");}}
    pins.add(pin.layerId);features += pin.featureCount;
  }
  if (features > PRINT_VECTOR_LIMITS.features) fail("the scene exceeds its feature limit.");
  for (const pass of scene.passes) {
    closed(pass, ["id", "type", "layerId", "installed", "layerOpacity", "commands"]);
    if (!name(pass.id) || ids.has(pass.id) || !PAINT[pass.type] || pass.installed?.id !== pass.id || pass.installed?.type !== pass.type
      || pass.type === "background" && pass.layerId !== null || pass.type !== "background" && !pins.has(pass.layerId)
      || !finite(pass.layerOpacity) || pass.layerOpacity < 0 || pass.layerOpacity > 1 || !Array.isArray(pass.commands)) fail("an installed vector pass is invalid.");
    ids.add(pass.id);if (!equal(installedPass(pass.installed), pass.installed)) fail("installed pass metadata is invalid.");compilePaint(pass.installed);
    for (const command of pass.commands) {
      if (++commands > PRINT_VECTOR_LIMITS.commands) fail("the scene exceeds its command limit.");
      const paint = ["kind", "fill", "fillOpacity", "stroke", "strokeOpacity", "strokeWidth"];
      closed(command, [...paint, ...(command.kind === "path" ? ["points", "closed", "lineCap", "lineJoin", "miterLimit"]
        : command.kind === "circle" ? ["cx", "cy", "r"] : command.kind === "rect" ? ["x", "y", "width", "height"] : [])]);
      const safeColor = value => value === null || typeof value === "string" && /^rgb\((?:\d+(?:\.\d+)? ){2}\d+(?:\.\d+)?\)$/.test(value)
        && value.slice(4, -1).split(" ").map(Number).every(channel => channel >= 0 && channel <= 255);
      if (!safeColor(command.fill) || !safeColor(command.stroke) || ![command.fillOpacity, command.strokeOpacity].every(value => finite(value) && value >= 0 && value <= 1)
        || !finite(command.strokeWidth) || command.strokeWidth < 0 || command.strokeWidth > 4096) fail("a vector command has invalid paint.");
      if (command.kind === "path") {
        if (!["butt", "round", "square"].includes(command.lineCap) || !["miter", "bevel", "round"].includes(command.lineJoin)
          || !finite(command.miterLimit) || command.miterLimit < 1 || command.miterLimit > 100 || typeof command.closed !== "boolean"
          || !Array.isArray(command.points) || !command.points.length) fail("a vector path is invalid.");
        for (const points of command.points) {
          if (!Array.isArray(points) || points.length < (command.closed ? 4 : 2)) fail("a vector path is invalid.");
          for (const point of points) if (++coordinates > PRINT_VECTOR_LIMITS.coordinates * PRINT_VECTOR_LIMITS.passes
            || !Array.isArray(point) || point.length !== 2 || !point.every(value => finite(value) && Math.abs(value) <= 10000000)) fail("a vector coordinate is invalid.");
          if (command.closed && !equal(points[0], points.at(-1))) fail("a vector ring is open.");
        }
      } else if (command.kind === "circle") {
        if (![command.cx, command.cy, command.r].every(value => finite(value) && Math.abs(value) <= 10000000) || command.r < 0 || command.r > 6144) fail("a vector circle is invalid.");
      } else if (command.kind === "rect") {
        if (pass.type !== "background" || ![command.x, command.y, command.width, command.height].every(finite)
          || command.x !== 0 || command.y !== 0 || command.width !== scene.cssWidth || command.height !== scene.cssHeight) fail("a vector background is invalid.");
      } else fail("an unknown vector command is invalid.");
    }
  }
  return scene;
}
