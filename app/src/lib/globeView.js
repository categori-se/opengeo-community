export const DEFAULT_MAP_VIEW = Object.freeze({
  id: "primary",
  title: "Primary view",
  center: Object.freeze([0, 20]),
  zoom: 2,
  pitch: 0,
  bearing: 0
});

export const GLOBE_VIEW_LIMITS = Object.freeze({
  minimumLongitude: -180,
  maximumLongitude: 180,
  minimumLatitude: -85.051129,
  maximumLatitude: 85.051129,
  minimumZoom: 0,
  maximumZoom: 22,
  minimumPitch: 0,
  maximumPitch: 85
});

export function normalizeProjection(value) {
  return value === "globe" ? "globe" : "mercator";
}

export function projectionForProject(project) {
  return normalizeProjection(project?.projection ?? project?.mapViews?.[0]?.projection);
}

export function normalizeMapView(value, fallback = DEFAULT_MAP_VIEW) {
  const source = value && typeof value === "object" ? value : {};
  const safeFallback = fallback && typeof fallback === "object" ? fallback : DEFAULT_MAP_VIEW;
  const fallbackCenter = validCenter(safeFallback.center)
    ? safeFallback.center
    : DEFAULT_MAP_VIEW.center;
  const center = validCenter(source.center) ? source.center : fallbackCenter;
  return {
    id: boundedIdentifier(source.id ?? source.viewId) ?? boundedIdentifier(safeFallback.id)
      ?? DEFAULT_MAP_VIEW.id,
    title: boundedTitle(source.title) ?? boundedTitle(source.label) ?? boundedTitle(safeFallback.title)
      ?? DEFAULT_MAP_VIEW.title,
    center: [
      clamp(center[0], GLOBE_VIEW_LIMITS.minimumLongitude, GLOBE_VIEW_LIMITS.maximumLongitude),
      clamp(center[1], GLOBE_VIEW_LIMITS.minimumLatitude, GLOBE_VIEW_LIMITS.maximumLatitude)
    ],
    zoom: boundedNumber(
      source.zoom,
      boundedNumber(
        safeFallback.zoom,
        DEFAULT_MAP_VIEW.zoom,
        GLOBE_VIEW_LIMITS.minimumZoom,
        GLOBE_VIEW_LIMITS.maximumZoom
      ),
      GLOBE_VIEW_LIMITS.minimumZoom,
      GLOBE_VIEW_LIMITS.maximumZoom
    ),
    pitch: boundedNumber(
      source.pitch,
      boundedNumber(
        safeFallback.pitch,
        DEFAULT_MAP_VIEW.pitch,
        GLOBE_VIEW_LIMITS.minimumPitch,
        GLOBE_VIEW_LIMITS.maximumPitch
      ),
      GLOBE_VIEW_LIMITS.minimumPitch,
      GLOBE_VIEW_LIMITS.maximumPitch
    ),
    bearing: normalizeBearing(source.bearing, safeFallback.bearing),
    ...portableViewMetadata(source)
  };
}

export function captureMapView(map, fallback = DEFAULT_MAP_VIEW) {
  if (!map) return normalizeMapView(fallback);
  try {
    const center = map.getCenter();
    return normalizeMapView({
      ...fallback,
      center: [center.lng, center.lat],
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      bearing: map.getBearing(),
      ...(typeof map.getRoll === "function" ? {roll: map.getRoll()} : {}),
      ...(typeof map.getCenterElevation === "function" ? {elevation: map.getCenterElevation()} : {}),
      ...(typeof map.getCenterClampedToGround === "function"
        ? {centerClampedToGround: map.getCenterClampedToGround()} : {})
    }, fallback);
  } catch {
    return normalizeMapView(fallback);
  }
}

export function mapViewsForSave(map, existing = []) {
  const views = Array.isArray(existing) ? existing.slice(0, 8) : [];
  return [
    captureMapView(map, views[0] ?? DEFAULT_MAP_VIEW),
    ...views.slice(1).map((view) => normalizeMapView(view))
  ];
}

export function addNamedMapView(map, existing, title, id) {
  const views = mapViewsForSave(map, existing);
  if (views.length >= 8) throw Error("A Project supports seven named views. Remove a saved view first.");
  if (!boundedIdentifier(id) || views.some(view => view.id === id)) throw Error("Choose a unique saved view.");
  if (!map) throw Error("Wait for the map before saving the current view.");
  return [...views, captureMapView(map, {id, title: namedViewTitle(title)})];
}

export function renameNamedMapView(existing, id, title) {
  const views = mapViewsForSave(null, existing);
  const index = views.findIndex(view => view.id === id);
  if (index < 1) throw Error("Choose a named view to rename.");
  views[index] = {...views[index], title: namedViewTitle(title)};
  return views;
}

export function moveNamedMapView(existing, id, direction) {
  const views = mapViewsForSave(null, existing);
  const index = views.findIndex(view => view.id === id);
  if (index < 1) throw Error("Choose a named view to move.");
  if (direction !== -1 && direction !== 1) throw Error("Choose an adjacent position for the view.");
  const destination = index + direction;
  if (destination < 1 || destination >= views.length) throw Error("This view is already at the end of the list.");
  [views[index], views[destination]] = [views[destination], views[index]];
  return views;
}

export function removeNamedMapView(existing, id) {
  const views = mapViewsForSave(null, existing);
  const index = views.findIndex(view => view.id === id);
  if (index < 1) throw Error("Choose a named view to remove.");
  return views.filter((_, position) => position !== index);
}

function namedViewTitle(value) {
  const title = typeof value === "string" ? value.trim() : "";
  if (!title || title.length > 160) throw Error("Enter a view name of up to 160 characters.");
  return title;
}

export function applyMapProjection(map, requested) {
  const projection = normalizeProjection(requested);
  if (!map) return {requested: projection, effective: "mercator", fallback: true};
  try {
    map.setProjection({type: projection});
    const effective = normalizeProjection(map.getProjection()?.type);
    return {requested: projection, effective, fallback: effective !== projection};
  } catch {
    try {
      map.setProjection({type: "mercator"});
    } catch {
      // The caller still receives a fail-closed 2D fallback result.
    }
    return {requested: projection, effective: "mercator", fallback: projection !== "mercator"};
  }
}

// Optional native camera fields remain in the canonical Project even when the
// chosen renderer cannot reproduce them. Admission must disclose that mismatch.
export function requiresExtendedMapCamera(view) {
  return (Number.isFinite(view?.roll) && view.roll !== 0)
    || (Number.isFinite(view?.elevation) && view.elevation !== 0)
    || view?.centerClampedToGround === false;
}

export function restoreMapView({map, view, engineId}) {
  const camera = normalizeMapView(view);
  if (requiresExtendedMapCamera(camera) && engineId !== "maplibre") {
    return {applied: false, message: "This saved view's roll or target elevation requires MapLibre. Its camera is retained; switch to MapLibre to open it."};
  }
  if (typeof map?.jumpTo !== "function") return {applied: false, message: "The map is not ready to open this saved view."};
  try {
    map.setCenterClampedToGround?.(camera.centerClampedToGround ?? true);
    map.jumpTo({...camera, roll: camera.roll ?? 0, elevation: camera.elevation ?? 0});
    return {applied: true};
  } catch {
    return {applied: false, message: "This map could not open the saved view. Its saved camera is unchanged."};
  }
}

function validCenter(value) {
  return Array.isArray(value)
    && value.length === 2
    && value.every(Number.isFinite);
}

function portableViewMetadata(source) {
  const metadata = {};
  if (Number.isFinite(source.roll) && Math.abs(source.roll) <= 180) metadata.roll = source.roll;
  if (Number.isFinite(source.elevation)) metadata.elevation = source.elevation;
  if (typeof source.centerClampedToGround === "boolean") metadata.centerClampedToGround = source.centerClampedToGround;
  // These imported records describe the saved view; retaining them does not
  // fit the live camera, switch renderers or activate Layer visibility overrides.
  if (Array.isArray(source.bbox) && source.bbox.length === 4 && source.bbox.every(Number.isFinite)) {
    metadata.bbox = [...source.bbox];
  }
  if (typeof source.label === "string" && source.label.length <= 160) metadata.label = source.label;
  if (typeof source.viewKind === "string" && source.viewKind.length <= 100) metadata.viewKind = source.viewKind;
  if (source.layerVisibility && typeof source.layerVisibility === "object" && !Array.isArray(source.layerVisibility)) {
    const entries = Object.entries(source.layerVisibility);
    if (entries.length <= 200 && entries.every(([key, value]) => key.length > 0 && key.length <= 200
      && !["__proto__", "constructor", "prototype"].includes(key) && typeof value === "boolean")) {
      metadata.layerVisibility = Object.fromEntries(entries);
    }
  }
  return metadata;
}

function boundedIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null;
}

function boundedTitle(value) {
  if (typeof value !== "string") return null;
  const title = value.trim();
  return title && title.length <= 160 ? title : null;
}

function boundedNumber(value, fallback, minimum, maximum) {
  return Number.isFinite(value) ? clamp(value, minimum, maximum) : fallback;
}

function normalizeBearing(value, fallback = 0) {
  const bearing = Number.isFinite(value) ? value : Number.isFinite(fallback) ? fallback : 0;
  return ((bearing + 180) % 360 + 360) % 360 - 180;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
