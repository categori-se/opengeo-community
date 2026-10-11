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
    title: boundedTitle(source.title) ?? boundedTitle(safeFallback.title)
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
    bearing: normalizeBearing(source.bearing, safeFallback.bearing)
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
      bearing: map.getBearing()
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

function validCenter(value) {
  return Array.isArray(value)
    && value.length === 2
    && value.every(Number.isFinite);
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
