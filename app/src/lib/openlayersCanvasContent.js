import {validateMapFilter} from './mapFilter.js';
import {BROWSER_PLATFORM_LIMITS} from './browserPlatform.js';
import {normalizePlacesDocument, placesToGeojson, hasKmlGeometryControls} from './kmlPlaces.js';

export const OPENLAYERS_CANVAS_VERSION = '10.10.0';
export const OPENLAYERS_CANVAS_LIMITS = Object.freeze({features: 50000, positions: 500000});
export const OPENLAYERS_CANVAS_CAPTURE_LIMITS = Object.freeze({
  width: BROWSER_PLATFORM_LIMITS.maximumExportWidth,
  height: BROWSER_PLATFORM_LIMITS.maximumExportHeight,
  pixels: BROWSER_PLATFORM_LIMITS.maximumExportPixels,
  bytes: 8 * 1024 * 1024
});
export const OPENLAYERS_CANVAS_CAPABILITIES = Object.freeze({
  navigation: true, identify: true, drawing: true, measurement: true, capture: true,
  geojson: true, xyzBasemap: true, labels: 'system-font-layout',
  featureEditing: false, vectorTiles: false, pmtiles: false, terrain: false,
  globe: false, customGPU: false, maplibreStyle: false
});

const geometryDepth = {Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3};
const styleFields = new Set(['renderer', 'circleColor', 'circleRadius', 'fill', 'stroke', 'strokeWidth',
  'radius', 'opacity', 'fillOpacityFactor', 'polygonMode']);
const vectorSources = new Set(['geojson-object', 'governed-dataset', 'arcgis-feature-layer-snapshot',
  'local-file', 'geojson', 'geojson-archive']);

export function canvasLayerData(dataByLayerId, id) {
  return dataByLayerId?.get?.(id) ?? dataByLayerId?.[id];
}

export function canvasGeometryData(geojson) {
  // Styling and identification read untouched canonical features separately.
  // OL reserves properties.geometry and deduplicates source features by id.
  return {type: 'FeatureCollection', features: geojson.features.map((feature, index) => ({
    type: 'Feature', id: String(index), geometry: feature.geometry, properties: {}
  }))};
}

export function canvasBasicPlacesIssue(layer, geojson) {
  const raw = layer?.kmlDocument;
  if (!raw || raw.kind !== 'document') return 'Load the canonical Places document before displaying this Layer in Canvas.';
  // Inspect the whole document. Unsupported children must never disappear merely
  // because a GeoJSON projection contains only its vector placemarks.
  if ([raw.styles, raw.schemas, raw.resources].some(value => value?.length)) return 'Places Styles, schemas and assets need a Canvas mapping; their complete definitions remain saved.';
  let document;
  try {document = normalizePlacesDocument(raw);} catch {return 'This Places document is outside the validated Canvas profile.';}
  if (!document.visibility || document.view || document.time || document.region || hasKmlGeometryControls(document)) return 'Places visibility, views, time, regions or geometry controls need a Canvas mapping.';
  if (document.styles.length || document.schemas.length || document.resources.length) return 'Places Styles, schemas and assets need a Canvas mapping; their complete definitions remain saved.';
  function positions2D(value) {
    if (!Array.isArray(value)) return false;
    if (typeof value[0] === 'number') return value.length === 2 && value.every(Number.isFinite);
    return value.every(positions2D);
  }
  for (const place of document.children) {
    if (place.kind !== 'placemark') return 'Places folders, links and overlays are unavailable in the initial Canvas profile; the complete document remains saved.';
    if (!place.visibility || place.view || place.time || place.region || place.extrude || place.tessellate
      || place.style || place.styleUrl || place.schemaData.length
      || place.altitudeMode && place.altitudeMode !== 'clampToGround'
      || !['Point', 'LineString', 'Polygon'].includes(place.geometry?.type) || !positions2D(place.geometry.coordinates)) {
      return 'This Places document contains presentation or 3D content outside the basic Canvas profile; its complete definition remains saved.';
    }
  }
  if (JSON.stringify(geojson) !== JSON.stringify(placesToGeojson(document))) return 'Reload the complete canonical Places geometry before displaying this Layer in Canvas.';
  return null;
}

function geometryIssue(geometry, budget) {
  if (geometry === null) return null;
  if (!geometry || !Object.hasOwn(geometryDepth, geometry.type)) return 'This geometry type is unavailable in 2D compatibility mode.';
  const lineValid = line => Array.isArray(line) && line.length >= 2;
  const ringValid = ring => Array.isArray(ring) && ring.length >= 4 && Array.isArray(ring[0])
    && Array.isArray(ring.at(-1)) && ring[0].length === ring.at(-1).length && ring[0].every((value, index) => value === ring.at(-1)[index]);
  const polygonValid = polygon => Array.isArray(polygon) && polygon.every(ringValid);
  if (geometry.type === 'LineString' && !lineValid(geometry.coordinates)
    || geometry.type === 'MultiLineString' && !geometry.coordinates?.every?.(lineValid)
    || geometry.type === 'Polygon' && !polygonValid(geometry.coordinates)
    || geometry.type === 'MultiPolygon' && !geometry.coordinates?.every?.(polygonValid)) return 'This geometry has invalid lines or polygon rings.';
  function coordinates(value, depth) {
    if (!Array.isArray(value)) return false;
    if (depth === 0) {
      if (++budget.positions > OPENLAYERS_CANVAS_LIMITS.positions) return false;
      if (value.length === 3) budget.elevation = true;
      return [2, 3].includes(value.length) && value.every(Number.isFinite)
        && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
    }
    return value.every(child => coordinates(child, depth - 1));
  }
  return coordinates(geometry.coordinates, geometryDepth[geometry.type]) ? null
    : 'Geometry must contain finite WGS84 positions within the 500,000-position scene limit.';
}

export function canvasBasemapReport(basemap) {
  if (!basemap) return {status: 'supported', id: null, title: 'Plain background', issues: []};
  const url = basemap.url ?? basemap.tiles?.[0];
  const issues = [];
  if (typeof url !== 'string' || !url.includes('{z}') || !url.includes('{x}') || !url.includes('{y}')
    || basemap.tiles?.length > 1 || (basemap.scheme && basemap.scheme !== 'xyz')
    || (basemap.type && !['raster', 'xyz', 'xyz-raster'].includes(basemap.type))) {
    issues.push({code: 'basemap-source', message: 'This background needs an XYZ raster mapping. The saved background is retained.'});
  }
  if (typeof url === 'string' && !/^(https?:\/\/|\/)/i.test(url)) {
    issues.push({code: 'basemap-url', message: 'This background URL is unavailable in 2D compatibility mode.'});
  }
  if (!basemap.attribution) issues.push({code: 'basemap-attribution', message: 'The raster background needs attribution before it can be displayed.'});
  return {id: basemap.id ?? null, title: basemap.title ?? 'Raster background',
    status: issues.length ? 'unavailable' : 'supported', issues};
}

/** Inspect canonical records without changing their source, Style or visibility. */
export function openlayersCanvasCompatibility({layers = [], dataByLayerId, basemap} = {}) {
  const ids = new Set(), budget = {features: 0, positions: 0};
  const entries = layers.map(layer => {
    const issues = [], add = (code, message) => issues.push({code, message});
    const reservation = {...budget};
    const geojson = canvasLayerData(dataByLayerId, layer?.layerId);
    if (!layer?.layerId || ids.has(layer.layerId)) add('identity', 'Layer identities must be distinct.');
    ids.add(layer?.layerId);
    if (layer?.sourceType === 'kml-places') {
      const issue = canvasBasicPlacesIssue(layer, geojson);
      if (issue) add('places-content', issue);
      else issues.push({code: 'places-presentation', different: true,
        message: 'Canonical Places geometry uses the shared inline Canvas Style. Its symbols and appearance can differ from full graphics; the source document remains saved.'});
    } else if (layer?.sourceType && !vectorSources.has(layer.sourceType)) {
      add('source', 'This source is unavailable in the initial Canvas profile; its definition remains saved.');
    }
    if (geojson?.type !== 'FeatureCollection' || !Array.isArray(geojson.features) || geojson.crs) {
      add('data', 'Load WGS84 GeoJSON features to display this Layer in 2D compatibility mode.');
    } else {
      reservation.features += geojson.features.length;
      if (reservation.features > OPENLAYERS_CANVAS_LIMITS.features) add('feature-limit', 'This Layer exceeds the 50,000-feature scene limit.');
      else {
        const local = {positions: budget.positions, elevation: false};
        for (const feature of geojson.features) {
          const message = feature?.type !== 'Feature' ? 'The loaded data contains an invalid feature.' : geometryIssue(feature.geometry, local);
          if (message) { add('geometry', message); break; }
        }
        reservation.positions = local.positions;
        if (local.elevation) issues.push({code: 'elevation', different: true, message: 'Elevation is retained in the source and displayed in 2D.'});
      }
    }
    if (layer?.styleReference) add('style-reference', 'This pinned Style needs a Canvas mapping; its original identity and definition are retained.');
    const style = layer?.style ?? {};
    if (style.renderer && !['single', 'status'].includes(style.renderer)) add('style-renderer', 'This thematic Style is unavailable in the initial Canvas profile.');
    if (Object.keys(style).some(key => !styleFields.has(key))) add('style-properties', 'This Style contains symbols or properties outside the initial Canvas profile.');
    if (['fill', 'stroke', 'circleColor'].some(key => style[key] !== undefined && typeof style[key] !== 'string')) add('style-expression', 'Expression-based Styles need a Canvas mapping.');
    if (['strokeWidth', 'circleRadius', 'radius'].some(key => style[key] !== undefined && (!Number.isFinite(style[key]) || style[key] < 0 || style[key] > 128))) add('style-dimension', 'This Style dimension is outside the supported Canvas range.');
    if ([layer?.opacity, style.opacity, style.fillOpacityFactor].some(value => value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1))) add('opacity', 'Layer and Style opacity must be between zero and one.');
    if (style.polygonMode && !['fill', 'line'].includes(style.polygonMode)) add('polygon-style', 'This polygon Style needs a Canvas mapping.');
    if (layer?.clustering?.enabled || layer?.pointClustering?.enabled) add('clustering', 'Point clustering is unavailable in the initial Canvas profile.');
    try { if (layer?.filter) validateMapFilter(layer.filter); }
    catch { add('filter', 'This feature filter needs a Canvas mapping.'); }
    if (layer?.labels?.enabled) {
      const labels = layer.labels;
      if (labels.fontRef) add('label-font', 'This pinned label font is preserved but unavailable in the initial Canvas profile.');
      if (!labels.field || typeof labels.field !== 'string') add('label-field', 'Choose a label field before displaying labels.');
      if (labels.size !== undefined && (!Number.isFinite(labels.size) || labels.size < 1 || labels.size > 128)) add('label-size', 'This label size is outside the supported Canvas range.');
      if (labels.haloWidth !== undefined && (!Number.isFinite(labels.haloWidth) || labels.haloWidth < 0 || labels.haloWidth > 20)) add('label-halo', 'This label halo is outside the supported Canvas range.');
      if (geojson?.features?.length > 5000) add('label-limit', 'This Layer exceeds the initial 5,000-label limit.');
      else if (geojson?.features?.some(feature => {
        const value = feature.properties?.[labels.field];
        return value !== null && value !== undefined && (!['string', 'number', 'boolean'].includes(typeof value)
          || `${labels.prefix ?? ''}${String(value)}${labels.suffix ?? ''}`.length > 256);
      })) add('label-text', 'Canvas labels support scalar text up to 256 characters.');
      issues.push({code: 'label-layout', different: true, message: 'Canvas uses system fonts and its own label placement and collision handling.'});
    }
    const status = issues.some(issue => !issue.different) ? 'unavailable' : issues.length ? 'different' : 'supported';
    // Content excluded from this native scene must not prevent unrelated
    // supported Layers or new drawings from using the remaining allowance.
    if (status !== 'unavailable') Object.assign(budget, reservation);
    return {layerId: layer?.layerId, title: layer?.title ?? layer?.layerId, visible: layer?.visible !== false,
      status, issues, ...(layer?.exportAllowed === false ? {exportAllowed: false} : {}),
      ...(layer?.styleReference ? {styleReference: structuredClone(layer.styleReference)} : {})};
  });
  const background = canvasBasemapReport(basemap);
  const unsupportedLayers = entries.filter(entry => entry.status === 'unavailable');
  const issues = entries.flatMap(entry => entry.issues.map(issue => ({...issue, layerId: entry.layerId, title: entry.title})));
  const report = {renderer: 'openlayers', rendererVersion: OPENLAYERS_CANVAS_VERSION, mode: 'canvas',
    capabilities: OPENLAYERS_CANVAS_CAPABILITIES, entries, layers: entries, unsupportedLayers,
    basemap: background, issues: [...background.issues, ...issues],
    ready: true, fullySupported: !unsupportedLayers.length && background.status !== 'unavailable',
    counts: {features: budget.features, positions: budget.positions}, limits: OPENLAYERS_CANVAS_LIMITS};
  report.canCapture = !canvasCaptureIssue(report, basemap);
  return report;
}

export function validateCanvasCaptureSize(width, height) {
  const limits = OPENLAYERS_CANVAS_CAPTURE_LIMITS;
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('The map needs a visible viewport before capture.');
  if (width > limits.width || height > limits.height || width * height > limits.pixels) throw new Error('Map capture is limited to 4096 pixels per axis and 12 megapixels. Reduce the viewport before exporting.');
}

export function validateCanvasCaptureDataUrl(value) {
  const prefix = 'data:image/png;base64,';
  if (typeof value !== 'string' || !value.startsWith(prefix)) throw new Error('Canvas did not produce a PNG image.');
  const payloadLength = value.length - prefix.length;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (payloadLength === 0 || payloadLength % 4 || payloadLength > Math.ceil(OPENLAYERS_CANVAS_CAPTURE_LIMITS.bytes / 3) * 4
    || payloadLength / 4 * 3 - padding > OPENLAYERS_CANVAS_CAPTURE_LIMITS.bytes) throw new Error('The map image exceeds its 8 MiB capture allowance. Reduce the viewport before exporting.');
}

/** Copy descriptive rights only. A renderer cannot establish a source grant. */
export function canvasSourceRights(record = {}) {
  const text = value => typeof value === 'string' ? value.slice(0, 2048)
    .replace(/\b(?:[a-z][a-z\d+.-]*:\/\/|(?:data|blob):)[^\s<>"']+/gi, '[link omitted]')
    .replace(/(^|\s)\/\/[^\s<>"']+/g, '$1[link omitted]')
    .replace(/\b(?:token|access[_-]?token|api[_-]?key|secret|password|authorization|credential)\s*[=:]\s*[^\s,;]+/gi, '[credential omitted]') : null;
  const fields = ['statement', 'description', 'title', 'identifier', 'status', 'restriction', 'license', 'accessRights', 'rights', 'policy', 'terms'];
  const descriptive = (value, depth = 0) => {
    if (typeof value === 'string') return text(value);
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth >= 2) return null;
    return Object.fromEntries(fields.filter(key => Object.hasOwn(value, key))
      .map(key => [key, descriptive(value[key], depth + 1)]).filter(([, entry]) => entry !== null));
  };
  return {exportPermission: record.exportAllowed === false ? 'denied' : record.exportAllowed === true ? 'declared-allowed' : 'unknown',
    legalVerification: 'not-verified', rights: descriptive(record.rights), accessRights: descriptive(record.accessRights),
    license: descriptive(record.license), policy: descriptive(record.policy)};
}

export function canvasCaptureCanvases(viewport) {
  // Controls can own other maps or canvases. Only the primary renderer belongs
  // to this capture; an OverviewMap canvas is outside its direct layer root.
  const root = [...(viewport?.children ?? [])].find(element => element.classList.contains('ol-layers'));
  return root ? [...root.querySelectorAll('.ol-layer canvas')] : [];
}

/** Evaluate only predicates admitted by validateMapFilter; no expressions or coercion. */
export function canvasFeatureMatches(filter, feature) {
  if (!filter) return true;
  const [op, ...args] = filter, properties = feature?.properties ?? {};
  if (op === 'all') return args.every(value => canvasFeatureMatches(value, feature));
  if (op === 'any') return args.some(value => canvasFeatureMatches(value, feature));
  if (op === '!') return !canvasFeatureMatches(args[0], feature);
  if (op === 'has') return Object.hasOwn(properties, args[0]);
  const field = Array.isArray(args[0]) ? args[0][1] : args[0];
  const actual = Object.hasOwn(properties, field) ? properties[field] : null, expected = args[1];
  if (op === 'in') return expected[1].includes(actual);
  if (op === '==') return actual === expected;
  if (op === '!=') return actual !== expected;
  if (typeof actual !== typeof expected || !['number', 'string'].includes(typeof actual)) return false;
  if (op === '<') return actual < expected;
  if (op === '<=') return actual <= expected;
  if (op === '>') return actual > expected;
  if (op === '>=') return actual >= expected;
  return false;
}

export function canvasFeaturePaint(layer, feature, hasStatus = false) {
  const style = layer.style ?? {}, opacity = (layer.opacityMode === 'composite' ? 1 : layer.opacity ?? 1) * (style.opacity ?? 1);
  let pointColor = style.circleColor ?? '#f97316';
  if ((style.renderer ?? (hasStatus ? 'status' : 'single')) === 'status') {
    pointColor = {verified: '#16a34a', 'needs review': '#f59e0b', draft: '#64748b'}[feature?.properties?.status] ?? pointColor;
  }
  return {pointColor, radius: style.circleRadius ?? style.radius ?? 6,
    fill: style.fill ?? '#22c55e', stroke: style.stroke ?? '#15803d',
    line: style.stroke ?? '#2563eb', strokeWidth: style.strokeWidth ?? 2,
    lineWidth: style.strokeWidth ?? 3, opacity,
    fillOpacity: opacity * (style.fillOpacityFactor ?? 0.45), outlineOnly: style.polygonMode === 'line'};
}

export function canvasCaptureIssue(report, basemap) {
  const unavailable = report.entries.filter(entry => entry.visible && entry.status === 'unavailable');
  if (unavailable.length) return `Capture is unavailable while visible Layers cannot be displayed: ${unavailable.map(entry => entry.title).join(', ')}. Hide them or use the full renderer.`;
  if (report.entries.some(entry => entry.visible && entry.exportAllowed === false)) return 'A visible Layer does not permit image export.';
  if (report.basemap.status === 'unavailable') return 'Capture is unavailable because the selected background cannot be displayed.';
  if (basemap?.exportAllowed === false) return 'The selected background does not permit image export.';
  return null;
}
