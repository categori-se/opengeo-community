import {HISTORICAL_IMAGERY_LIMITS} from "./historicalImagery.js";

export const ACQUISITION_SOURCES = Object.freeze({
  "nasa-gibs-hls-l30-nbar": {shortName: "HLSL30", version: "2.0"},
  "nasa-gibs-hls-s30-nbar": {shortName: "HLSS30", version: "2.0"}
});
export const ACQUISITION_LIMITS = Object.freeze({granules: 200, bytes: 2097152, polygonVertices: 2048, timeoutMilliseconds: 8000});
const fail = code => {throw Object.assign(Error(code), {code});};
const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const longitudeNear = (longitude, reference) => reference + ((longitude - reference + 180) % 360 + 360) % 360 - 180;

/** CMR polygon coordinates are latitude longitude pairs; boxes alone are candidates. */
export function cmrFootprintContains(polygons, [longitude, latitude]) {
  if (!Array.isArray(polygons) || polygons.length > 16) return false;
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || polygon.length !== 1 || typeof polygon[0] !== "string" || polygon[0].length > 131072) continue;
    const tokens = polygon[0].trim().split(/\s+/);
    if (tokens.length < 8 || tokens.length % 2 || tokens.length > ACQUISITION_LIMITS.polygonVertices * 2) continue;
    const ring = [];
    for (let index = 0; index < tokens.length; index += 2) {
      const lat = Number(tokens[index]), lon = Number(tokens[index + 1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {ring.length = 0;break;}
      ring.push([longitudeNear(lon, ring.at(-1)?.[0] ?? longitude), lat]);
    }
    if (ring.length < 4 || ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) continue;
    if (Math.max(...ring.map(point => point[0])) - Math.min(...ring.map(point => point[0])) > 180) continue;
    const pointLongitude = longitudeNear(longitude, ring[0][0]);
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const [x, y] = ring[index], [px, py] = ring[previous];
      const cross = (pointLongitude - px) * (y - py) - (latitude - py) * (x - px);
      if (Math.abs(cross) < 1e-10 && pointLongitude >= Math.min(x, px) && pointLongitude <= Math.max(x, px)
        && latitude >= Math.min(y, py) && latitude <= Math.max(y, py)) return true;
      if ((y > latitude) !== (py > latitude) && pointLongitude < (px - x) * (latitude - y) / (py - y) + x) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

export function parseAcquisitionAvailability(value, {sourceId, position, startDate, endDate, hits = null} = {}) {
  if (!ACQUISITION_SOURCES[sourceId] || !Array.isArray(position) || position.length !== 2
    || !position.every(Number.isFinite) || Math.abs(position[0]) > 180 || Math.abs(position[1]) > 90) fail("acquisition_scope_invalid");
  if (!date(startDate) || !date(endDate) || startDate > endDate
    || (Date.parse(endDate) - Date.parse(startDate)) / 86400000 >= HISTORICAL_IMAGERY_LIMITS.maximumWindowDays) fail("acquisition_window_limit");
  const entries = value?.feed?.entry;
  if (!Array.isArray(entries) || entries.length > ACQUISITION_LIMITS.granules) fail("acquisition_response_invalid");
  const granules = [], dates = new Set();let unknownFootprints = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || entry.id.length > 200 || !/^G[0-9]+-[A-Za-z0-9_]+$/.test(entry.id)
      || typeof entry.time_start !== "string" || !Number.isFinite(Date.parse(entry.time_start))) fail("acquisition_granule_invalid");
    const acquiredAt = new Date(entry.time_start).toISOString(), acquisitionDate = acquiredAt.slice(0, 10);
    if (acquisitionDate < startDate || acquisitionDate > endDate) continue;
    if (!cmrFootprintContains(entry.polygons, position)) {unknownFootprints++;continue;}
    dates.add(acquisitionDate);
    granules.push({id: entry.id, acquiredAt, endTime: Number.isFinite(Date.parse(entry.time_end)) ? new Date(entry.time_end).toISOString() : null,
      footprint: structuredClone(entry.polygons),
      source: "NASA CMR metadata footprint", recordUrl: `https://cmr.earthdata.nasa.gov/search/concepts/${entry.id}.html`});
  }
  return {sourceId, position: [...position], startDate, endDate, dates: [...dates].sort(), granules,
    unknownFootprints, returned: entries.length, totalHits: Number.isSafeInteger(hits) && hits >= 0 ? hits : null,
    complete: Number.isSafeInteger(hits) ? hits <= entries.length : entries.length < ACQUISITION_LIMITS.granules,
    coverageMeaning: "Acquisition metadata footprint at captured point; cloud-free or populated pixels are not guaranteed.", spatiallyConfirmed: true};
}

export function acquisitionEvidenceForProject(project) {
  const value = project?.extensions?.historicalAcquisitionEvidence;
  if (!value) return null;
  try {
    if (!/^[a-f0-9]{64}$/.test(value.responseSha256) || !Number.isFinite(Date.parse(value.observedAt))
      || !Array.isArray(value.granules) || value.granules.length > ACQUISITION_LIMITS.granules) return null;
    const result = parseAcquisitionAvailability({feed: {entry: value.granules.map(granule => ({id: granule.id, time_start: granule.acquiredAt,
      time_end: granule.endTime, polygons: granule.footprint}))}}, value);
    return {...result, observedAt: value.observedAt, responseSha256: value.responseSha256,
      complete: value.complete === true, unknownFootprints: Number.isSafeInteger(value.unknownFootprints) && value.unknownFootprints >= 0 ? value.unknownFootprints : 0};
  } catch {return null;}
}

export async function fetchAcquisitionAvailability(sourceId, {position, startDate, endDate, fetchImpl = globalThis.fetch, signal} = {}) {
  // Validate the complete scope before any provider request.
  parseAcquisitionAvailability({feed: {entry: []}}, {sourceId, position, startDate, endDate});
  const source = ACQUISITION_SOURCES[sourceId];
  const url = new URL("https://cmr.earthdata.nasa.gov/search/granules.json");
  for (const [key, value] of Object.entries({short_name: source.shortName, version: source.version, point: position.join(","),
    temporal: `${startDate}T00:00:00Z,${endDate}T23:59:59Z`, page_size: ACQUISITION_LIMITS.granules, sort_key: "start_date"})) url.searchParams.set(key, value);
  const timeout = AbortSignal.timeout(ACQUISITION_LIMITS.timeoutMilliseconds);
  const response = await fetchImpl(url.href, {credentials: "omit", redirect: "error", headers: {Accept: "application/json"},
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout});
  if (!response.ok || !response.headers.get("content-type")?.includes("json")) fail("acquisition_provider_unavailable");
  if (Number(response.headers.get("content-length")) > ACQUISITION_LIMITS.bytes) fail("acquisition_response_limit");
  const reader = response.body?.getReader();if (!reader) fail("acquisition_response_invalid");
  const chunks = [];let length = 0;
  try {
    for (;;) {const {done, value} = await reader.read();if (done) break;length += value.length;if (length > ACQUISITION_LIMITS.bytes) fail("acquisition_response_limit");chunks.push(value);}
  } finally {await reader.cancel().catch(() => {});}
  const bytes = new Uint8Array(length);let offset = 0;for (const chunk of chunks) {bytes.set(chunk, offset);offset += chunk.length;}
  const result = parseAcquisitionAvailability(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)),
    {sourceId, position, startDate, endDate, hits: response.headers.has("CMR-Hits") ? Number(response.headers.get("CMR-Hits")) : null});
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return {...result, responseSha256: Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join(""), observedAt: new Date().toISOString()};
}
