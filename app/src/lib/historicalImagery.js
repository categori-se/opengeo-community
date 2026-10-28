export const HISTORICAL_IMAGERY_SCHEMA_VERSION = "opengeo.historical-imagery.1.0.0";

export const HISTORICAL_IMAGERY_LIMITS = Object.freeze({
  maximumWindowDays: 92,
  maximumDates: 92,
  maximumResponseBytes: 262_144,
  timeoutMilliseconds: 8_000,
  minimumPlaybackIntervalMilliseconds: 1_000,
  maximumPlaybackFrames: 120,
  adjacentFramesToPrefetch: 1
});

const CAPABILITIES_DIGEST = "5a3d12d9a273f44c4f9f51db6bd43c7cdbacf8355564388270ef8f7181a211d4";
const GIBS_ROOT = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
const GIBS_KVP_ROOT = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi";

export const WAYBACK_SOURCE_ID = "esri-world-imagery-wayback";
export const WAYBACK_CATALOG_URL = "https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json";

export function parseWaybackReleases(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw contractError("wayback_catalog_invalid");
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 2048) throw contractError("wayback_catalog_limit");
  return entries.map(([id, item]) => {
    const date = /^World Imagery \(Wayback (\d{4}-\d{2}-\d{2})\)$/.exec(item?.itemTitle ?? "")?.[1];
    if (!/^[1-9][0-9]{0,9}$/.test(id) || !validIsoDate(date)
      || !/^[a-f0-9]{32}$/.test(item.itemID ?? "")
      || item.itemURL !== `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${id}/{level}/{row}/{col}`) {
      throw contractError("wayback_release_invalid");
    }
    return {id, date, itemId: item.itemID};
  }).sort((a, b) => a.date.localeCompare(b.date) || Number(a.id) - Number(b.id));
}

export async function fetchWaybackReleases({fetchImpl = globalThis.fetch, signal} = {}) {
  const timeout = AbortSignal.timeout(HISTORICAL_IMAGERY_LIMITS.timeoutMilliseconds);
  const response = await fetchImpl(WAYBACK_CATALOG_URL, {
    credentials: "omit", redirect: "error", headers: {Accept: "application/json"},
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });
  if (!response.ok) throw contractError("wayback_provider_unavailable");
  if (!response.headers.get("content-type")?.includes("json")) throw contractError("wayback_content_type_invalid");
  if (Number(response.headers.get("content-length")) > HISTORICAL_IMAGERY_LIMITS.maximumResponseBytes) throw contractError("historical_response_limit");
  return parseWaybackReleases(JSON.parse(await readBoundedText(response, HISTORICAL_IMAGERY_LIMITS.maximumResponseBytes)));
}

export function waybackViewerUrl(releaseId, {longitude = 0, latitude = 20, zoom = 2} = {}) {
  if (!/^[1-9][0-9]{0,9}$/.test(String(releaseId))) throw contractError("wayback_release_invalid");
  if (![longitude, latitude, zoom].every(Number.isFinite)) throw contractError("wayback_camera_invalid");
  const camera = [normalizeLongitude(longitude).toFixed(5), Math.max(-85, Math.min(85, latitude)).toFixed(5), Math.max(0, Math.min(23, zoom)).toFixed(2)].join(",");
  return `https://livingatlas.arcgis.com/wayback/#mapCenter=${encodeURIComponent(camera)}&mode=explore&active=${releaseId}`;
}

const SOURCES = Object.freeze([
  Object.freeze({
    sourceId: "nasa-gibs-modis-terra-true-color",
    sourceRevision: "gibs-epsg3857-2026-08-30",
    provider: "NASA Global Imagery Browse Services (GIBS)",
    title: "MODIS Terra true color",
    upstreamLayerId: "MODIS_Terra_CorrectedReflectance_TrueColor",
    description: "Daily global browse mosaics for regional and planetary context.",
    resolution: "250 m to 1 km browse imagery",
    firstObservedDate: "2000-02-24",
    defaultDate: "2026-08-30",
    tileMatrixSet: "GoogleMapsCompatible_Level9",
    maximumZoom: 9,
    format: "jpeg",
    mediaType: "image/jpeg",
    timeMeaning: "mosaic-period",
    coverageMeaning: "provider-global-daily-mosaic-with-pixel-gaps",
    observedPeriods: [
      "2000-02-24/2000-04-25/P1D",
      "2000-04-28/2000-08-06/P1D",
      "2000-08-18/2001-06-15/P1D",
      "2001-07-03/2002-03-19/P1D",
      "2002-03-28/2003-12-16/P1D",
      "2003-12-24/2008-12-20/P1D",
      "2008-12-23/2016-02-18/P1D",
      "2016-02-27/2022-10-10/P1D",
      "2022-10-23/2025-08-08/P1D",
      "2025-08-10/2025-11-08/P1D",
      "2025-11-10/2026-08-30/P1D"
    ]
  }),
  Object.freeze({
    sourceId: "nasa-gibs-hls-l30-nbar",
    sourceRevision: "gibs-epsg3857-2026-08-23",
    provider: "NASA Global Imagery Browse Services (GIBS)",
    title: "HLS Landsat 8/9 reflectance",
    upstreamLayerId: "HLS_L30_Nadir_BRDF_Adjusted_Reflectance",
    description: "Nadir BRDF-adjusted Landsat 8/9 reflectance browse imagery.",
    resolution: "30 m",
    firstObservedDate: "2013-03-22",
    defaultDate: "2026-08-23",
    tileMatrixSet: "GoogleMapsCompatible_Level12",
    maximumZoom: 12,
    format: "png",
    mediaType: "image/png",
    timeMeaning: "mosaic-period",
    coverageMeaning: "provider-time-domain-not-granule-footprint",
    observedPeriods: ["2013-03-22", "2026-03-02/2026-08-23/P1D"]
  }),
  Object.freeze({
    sourceId: "nasa-gibs-hls-s30-nbar",
    sourceRevision: "gibs-epsg3857-2026-08-23",
    provider: "NASA Global Imagery Browse Services (GIBS)",
    title: "HLS Sentinel-2 reflectance",
    upstreamLayerId: "HLS_S30_Nadir_BRDF_Adjusted_Reflectance",
    description: "Nadir BRDF-adjusted Sentinel-2 reflectance browse imagery.",
    resolution: "30 m",
    firstObservedDate: "2015-11-28",
    defaultDate: "2026-08-23",
    tileMatrixSet: "GoogleMapsCompatible_Level12",
    maximumZoom: 12,
    format: "png",
    mediaType: "image/png",
    timeMeaning: "mosaic-period",
    coverageMeaning: "provider-time-domain-not-granule-footprint",
    observedPeriods: ["2015-11-28", "2026-03-02/2026-08-23/P1D"]
  })
].map((source) => Object.freeze({
  ...source,
  adapterId: "nasa-gibs-wmts-time",
  adapterRevision: HISTORICAL_IMAGERY_SCHEMA_VERSION,
  projection: "EPSG:3857",
  capabilityDigest: `sha256:${CAPABILITIES_DIGEST}`,
  capabilityObservedAt: "2026-08-30T00:00:00Z",
  reviewDate: "2026-08-30",
  authentication: "none",
  chargingModel: "public-provider-direct",
  attribution: "Imagery provided by NASA Global Imagery Browse Services (GIBS)",
  termsUrl: "https://www.earthdata.nasa.gov/engage/open-data-services-software/data-use-policy",
  providerRecordUrl: `https://worldview.earthdata.nasa.gov/?l=${encodeURIComponent(source.upstreamLayerId)}`,
  tileUrlTemplate: `${GIBS_ROOT}/${source.upstreamLayerId}/default/{Time}/${source.tileMatrixSet}/{z}/{y}/{x}.${source.format}`,
  describeDomainsUrl: GIBS_KVP_ROOT
})));

const SOURCE_BY_ID = new Map(SOURCES.map((source) => [source.sourceId, source]));

export function reviewedHistoricalImagerySources() {
  return SOURCES.map((source) => structuredClone(source));
}

export function historicalImagerySource(sourceId) {
  const source = SOURCE_BY_ID.get(sourceId);
  return source ? structuredClone(source) : null;
}

export function reviewedHistoricalDates(sourceId, {endDate = null, maximumDates = HISTORICAL_IMAGERY_LIMITS.maximumDates} = {}) {
  const source = requiredSource(sourceId);
  const end = validIsoDate(endDate) ? endDate : source.defaultDate;
  const start = addUtcDays(end, -(Math.min(maximumDates, HISTORICAL_IMAGERY_LIMITS.maximumDates) - 1));
  return expandDailyPeriods(source.observedPeriods, {startDate: start, endDate: end, maximumDates});
}

export function expandDailyPeriods(periods, {
  startDate,
  endDate,
  maximumDates = HISTORICAL_IMAGERY_LIMITS.maximumDates
} = {}) {
  if (!Array.isArray(periods) || periods.length > 2_048) throw contractError("historical_periods_invalid");
  const boundedMaximum = Math.min(
    integerInRange(maximumDates, 1, HISTORICAL_IMAGERY_LIMITS.maximumDates, HISTORICAL_IMAGERY_LIMITS.maximumDates),
    HISTORICAL_IMAGERY_LIMITS.maximumDates
  );
  const start = validIsoDate(startDate) ? startDate : "0000-01-01";
  const end = validIsoDate(endDate) ? endDate : "9999-12-31";
  if (start > end || (validIsoDate(startDate) && validIsoDate(endDate)
    && daysBetween(endDate, startDate) > HISTORICAL_IMAGERY_LIMITS.maximumWindowDays - 1)) {
    throw contractError("historical_window_limit");
  }
  const dates = new Set();
  for (const raw of periods) {
    if (typeof raw !== "string" || raw.length > 96) continue;
    const parts = raw.trim().split("/");
    if (parts.length === 1 && validIsoDate(parts[0])) {
      if (parts[0] >= start && parts[0] <= end) dates.add(parts[0]);
      continue;
    }
    if (parts.length !== 3 || parts[2] !== "P1D" || !validIsoDate(parts[0]) || !validIsoDate(parts[1])) continue;
    const first = parts[0] < start ? start : parts[0];
    const last = parts[1] > end ? end : parts[1];
    if (first > last) continue;
    for (let date = first; date <= last; date = addUtcDays(date, 1)) {
      dates.add(date);
      if (dates.size > boundedMaximum) throw contractError("historical_date_limit");
    }
  }
  return [...dates].sort();
}

export function resolveHistoricalSelection({requestedDate, availableDates, policy = "exact"} = {}) {
  if (!validIsoDate(requestedDate)) throw contractError("historical_date_invalid");
  if (!["exact", "previous", "next", "nearest"].includes(policy)) throw contractError("historical_policy_invalid");
  const dates = [...new Set((availableDates ?? []).filter(validIsoDate))].sort();
  if (!dates.length) return {status: "unavailable", requestedDate, displayedDate: null, policy, reason: "no-provider-dates"};
  if (dates.includes(requestedDate)) {
    return {status: "resolved", requestedDate, displayedDate: requestedDate, policy, reason: "exact"};
  }
  let displayedDate = null;
  if (policy === "previous") displayedDate = dates.filter((date) => date < requestedDate).at(-1) ?? null;
  if (policy === "next") displayedDate = dates.find((date) => date > requestedDate) ?? null;
  if (policy === "nearest") {
    displayedDate = dates.reduce((best, date) => {
      if (!best) return date;
      const candidateDistance = Math.abs(daysBetween(date, requestedDate));
      const bestDistance = Math.abs(daysBetween(best, requestedDate));
      return candidateDistance < bestDistance || (candidateDistance === bestDistance && date < best) ? date : best;
    }, null);
  }
  return displayedDate
    ? {status: "resolved", requestedDate, displayedDate, policy, reason: `adjusted-${policy}`}
    : {status: "unavailable", requestedDate, displayedDate: null, policy, reason: `no-${policy}-date`};
}

export function historicalImageryBasemap({sourceId, sourceRevision, selection} = {}) {
  const source = requiredSource(sourceId);
  if (sourceRevision !== source.sourceRevision) throw contractError("historical_source_revision_unsupported");
  const normalizedSelection = normalizeSelection(selection, source.defaultDate);
  const displayedDate = normalizedSelection.displayedDate;
  return {
    basemapId: `historical-${source.sourceId}-${displayedDate}`,
    title: `${source.title} · ${displayedDate}`,
    section: "Historical imagery",
    kind: "temporal-raster",
    sourceId: source.sourceId,
    sourceRevision: source.sourceRevision,
    selection: normalizedSelection,
    description: `${source.resolution} · ${source.timeMeaning}`,
    url: source.tileUrlTemplate.replace("{Time}", displayedDate),
    tileSize: 256,
    scheme: "xyz",
    minZoom: 0,
    maxZoom: source.maximumZoom,
    attribution: source.attribution
  };
}

export function historicalImageryForProject(project) {
  return normalizeHistoricalImagery(project?.extensions?.historicalImagery);
}

export function normalizeHistoricalImagery(value) {
  const requested = value && typeof value === "object" ? value : {};
  const source = SOURCE_BY_ID.get(requested.sourceId) ?? SOURCES[0];
  const sourceRevision = requested.sourceRevision === source.sourceRevision
    ? requested.sourceRevision
    : source.sourceRevision;
  const selection = normalizeSelection(requested.selection, source.defaultDate);
  const comparison = requested.comparison && typeof requested.comparison === "object"
    ? normalizeSelection(requested.comparison, selection.displayedDate)
    : null;
  const sunlightDateTime = validIsoDateTime(requested.sunlight?.dateTime)
    ? new Date(requested.sunlight.dateTime).toISOString()
    : `${selection.displayedDate}T12:00:00.000Z`;
  return {
    schemaVersion: HISTORICAL_IMAGERY_SCHEMA_VERSION,
    enabled: requested.enabled === true,
    sourceId: source.sourceId,
    sourceRevision,
    selection,
    comparison,
    compareShowing: requested.compareShowing === "comparison" ? "comparison" : "primary",
    compareMode: ["swipe", "side-by-side"].includes(requested.compareMode) ? requested.compareMode : "toggle",
    compareDivider: Number.isFinite(requested.compareDivider)
      ? Math.max(0, Math.min(100, Math.round(requested.compareDivider))) : 50,
    sunlight: {
      enabled: requested.sunlight?.enabled === true,
      dateTime: sunlightDateTime,
      model: "opengeo-approximate-solar-position-1"
    }
  };
}

export function historicalImageryForSave(value) {
  const normalized = normalizeHistoricalImagery(value);
  return structuredClone(normalized);
}

export async function fetchHistoricalAvailability(sourceId, {
  startDate,
  endDate,
  fetchImpl = globalThis.fetch,
  signal
} = {}) {
  const source = requiredSource(sourceId);
  if (!validIsoDate(startDate) || !validIsoDate(endDate) || startDate > endDate
    || daysBetween(endDate, startDate) > HISTORICAL_IMAGERY_LIMITS.maximumWindowDays - 1) {
    throw contractError("historical_window_limit");
  }
  if (typeof fetchImpl !== "function") throw contractError("historical_fetch_unavailable");
  const timeout = new AbortController();
  const abort = () => timeout.abort(signal?.reason);
  signal?.addEventListener?.("abort", abort, {once: true});
  const timer = setTimeout(() => timeout.abort(), HISTORICAL_IMAGERY_LIMITS.timeoutMilliseconds);
  try {
    // GIBS documents and currently requires the KVP TIME delimiter as a raw
    // slash. URLSearchParams percent-encodes it and the service rejects that
    // otherwise equivalent request as an invalid period.
    const availabilityUrl = `${source.describeDomainsUrl}?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0&LAYER=${source.upstreamLayerId}&TILEMATRIXSET=${source.tileMatrixSet}&TIME=${startDate}/${endDate}`;
    const response = await fetchImpl(availabilityUrl, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      headers: {Accept: "application/xml,text/xml;q=0.9"},
      signal: timeout.signal
    });
    if (!response?.ok) throw contractError("historical_provider_unavailable");
    const contentType = response.headers?.get?.("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("xml")) throw contractError("historical_content_type_invalid");
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > HISTORICAL_IMAGERY_LIMITS.maximumResponseBytes) {
      throw contractError("historical_response_limit");
    }
    const text = await readBoundedText(response, HISTORICAL_IMAGERY_LIMITS.maximumResponseBytes);
    const periods = parseTimeValues(text);
    return {
      sourceId: source.sourceId,
      sourceRevision: source.sourceRevision,
      startDate,
      endDate,
      dates: expandDailyPeriods(periods, {startDate, endDate}),
      coverageMeaning: source.coverageMeaning,
      observedAt: new Date().toISOString(),
      requestAuthority: "anonymous-public-provider",
      spatiallyConfirmed: false
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", abort);
  }
}

export function solarPosition(dateTime) {
  if (!validIsoDateTime(dateTime)) throw contractError("sunlight_time_invalid");
  const date = new Date(dateTime);
  const julianDate = date.getTime() / 86_400_000 + 2_440_587.5;
  const days = julianDate - 2_451_545;
  const meanAnomaly = radians(normalizeDegrees(357.5291 + 0.98560028 * days));
  const center = 1.9148 * Math.sin(meanAnomaly)
    + 0.02 * Math.sin(2 * meanAnomaly)
    + 0.0003 * Math.sin(3 * meanAnomaly);
  const eclipticLongitude = radians(normalizeDegrees(280.46646 + 0.98564736 * days + center));
  const obliquity = radians(23.4393 - 0.00000036 * days);
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude));
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const sidereal = radians(normalizeDegrees(280.46061837 + 360.98564736629 * days));
  return {
    dateTime: date.toISOString(),
    subsolarLongitude: normalizeLongitude(degrees(rightAscension - sidereal)),
    subsolarLatitude: degrees(declination),
    model: "opengeo-approximate-solar-position-1",
    declaredAccuracy: "visual planning guide; not a survey or lighting simulation"
  };
}

export function solarElevationAt({longitude, latitude, dateTime} = {}) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw contractError("sunlight_coordinate_invalid");
  }
  const sun = solarPosition(dateTime);
  const hourAngle = radians(normalizeLongitude(longitude - sun.subsolarLongitude));
  const lat = radians(latitude);
  const declination = radians(sun.subsolarLatitude);
  const elevation = Math.asin(
    Math.sin(lat) * Math.sin(declination)
    + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle)
  );
  return {...sun, longitude, latitude, elevationDegrees: degrees(elevation)};
}

export function sunlightGuideGeojson(dateTime) {
  const sun = solarPosition(dateTime);
  const subsolar = unitVector(sun.subsolarLongitude, sun.subsolarLatitude);
  const reference = Math.abs(subsolar[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const axisA = normalizeVector(cross(subsolar, reference));
  const axisB = normalizeVector(cross(subsolar, axisA));
  const segments = [[]];
  let previousLongitude = null;
  for (let degree = 0; degree <= 360; degree += 2) {
    const angle = radians(degree);
    const point = addVectors(scaleVector(axisA, Math.cos(angle)), scaleVector(axisB, Math.sin(angle)));
    const coordinate = vectorCoordinate(point);
    if (previousLongitude !== null && Math.abs(coordinate[0] - previousLongitude) > 180) segments.push([]);
    segments.at(-1).push(coordinate);
    previousLongitude = coordinate[0];
  }
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {kind: "terminator", dateTime: sun.dateTime, model: sun.model},
        geometry: {type: "MultiLineString", coordinates: segments.filter((segment) => segment.length > 1)}
      },
      {
        type: "Feature",
        properties: {kind: "subsolar-point", dateTime: sun.dateTime, model: sun.model},
        geometry: {type: "Point", coordinates: [sun.subsolarLongitude, sun.subsolarLatitude]}
      }
    ]
  };
}

function normalizeSelection(value, fallbackDate) {
  const displayedDate = validIsoDate(value?.displayedDate) ? value.displayedDate : fallbackDate;
  const requestedDate = validIsoDate(value?.requestedDate) ? value.requestedDate : displayedDate;
  const policy = ["exact", "previous", "next", "nearest"].includes(value?.policy) ? value.policy : "exact";
  const reason = typeof value?.reason === "string" && value.reason.length <= 64
    ? value.reason
    : requestedDate === displayedDate ? "exact" : `adjusted-${policy}`;
  return {status: "resolved", requestedDate, displayedDate, policy, reason};
}

function requiredSource(sourceId) {
  const source = SOURCE_BY_ID.get(sourceId);
  if (!source) throw contractError("historical_source_unknown");
  return source;
}

function validIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validIsoDateTime(value) {
  if (typeof value !== "string" || value.length > 48) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime());
}

function addUtcDays(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(left, right) {
  return Math.round((Date.parse(`${left}T00:00:00.000Z`) - Date.parse(`${right}T00:00:00.000Z`)) / 86_400_000);
}

function parseTimeValues(xml) {
  if (typeof xml !== "string" || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw contractError("historical_xml_invalid");
  const values = [];
  const pattern = /<(?:\w+:)?Value\b[^>]*>\s*([^<]{1,96})\s*<\/(?:\w+:)?Value>/gi;
  for (const match of xml.matchAll(pattern)) {
    const value = match[1].trim();
    if (/^\d{4}-\d{2}-\d{2}(?:\/\d{4}-\d{2}-\d{2}\/P1D)?$/.test(value)) values.push(value);
    if (values.length > 2_048) throw contractError("historical_periods_invalid");
  }
  const domainPattern = /<(?:\w+:)?Domain\b[^>]*>\s*([^<]{1,8192})\s*<\/(?:\w+:)?Domain>/gi;
  for (const match of xml.matchAll(domainPattern)) {
    for (const item of match[1].split(",")) {
      const value = item.trim();
      if (/^\d{4}-\d{2}-\d{2}(?:\/\d{4}-\d{2}-\d{2}\/P1D)?$/.test(value)) values.push(value);
      if (values.length > 2_048) throw contractError("historical_periods_invalid");
    }
  }
  if (!values.length) throw contractError("historical_availability_invalid");
  return values;
}

async function readBoundedText(response, maximumBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximumBytes) throw contractError("historical_response_limit");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw contractError("historical_response_limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function contractError(code) {
  return Object.assign(new Error(code), {code});
}

function integerInRange(value, minimum, maximum, fallback) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function radians(value) {
  return value * Math.PI / 180;
}

function degrees(value) {
  return value * 180 / Math.PI;
}

function normalizeDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function normalizeLongitude(value) {
  return ((value + 540) % 360) - 180;
}

function unitVector(longitude, latitude) {
  const lon = radians(longitude);
  const lat = radians(latitude);
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

function cross(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]
  ];
}

function normalizeVector(vector) {
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length);
}

function scaleVector(vector, factor) {
  return vector.map((value) => value * factor);
}

function addVectors(left, right) {
  return left.map((value, index) => value + right[index]);
}

function vectorCoordinate(vector) {
  const normalized = normalizeVector(vector);
  return [degrees(Math.atan2(normalized[1], normalized[0])), degrees(Math.asin(normalized[2]))];
}
