// Bounded references for the published-product baseline pilot. These helpers
// neither discover new providers nor read or preserve any provider object.
const WORLD_COVER_MANUAL = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/docs/WorldCover_PUM_V2.0.pdf";
const WORLD_COVER_ACCESS = "https://esa-worldcover.org/en/data-access";
const WORLD_COVER_RECORD = "https://zenodo.org/records/7254221";

export const WORLDCOVER_2021 = freeze({
  id: "esa-worldcover-2021-v200", title: "ESA WorldCover 2021 v200", version: "v200",
  observationPeriod: {start: "2021-01-01", end: "2021-12-31"}, releasedAt: "2022-10-28",
  resolutionMeters: 10, crs: "EPSG:4326", band: 1, license: "CC-BY-4.0",
  attribution: "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium",
  classMeanings: {10: "Tree cover", 20: "Shrubland", 30: "Grassland", 40: "Cropland", 50: "Built-up",
    60: "Bare / sparse vegetation", 70: "Snow and ice", 80: "Permanent water bodies", 90: "Herbaceous wetland",
    95: "Mangroves", 100: "Moss and lichen"},
  evidenceUrls: [WORLD_COVER_ACCESS, WORLD_COVER_MANUAL, WORLD_COVER_RECORD],
  limitations: [
    "The source describes 2021 land cover; a requested study period does not change its observation dates.",
    "Tile bounds identify candidate coverage; object availability, missing data and complete AOI coverage remain unverified.",
    "One original ESA tile omitted browser CORS permission in the October 23, 2026 Studio-origin check. Native access can work; candidate browser access is not established. Registration never copies the source to bypass this limit.",
    "Nominal 10 m pixels are on a geographic grid; loaded overviews may be coarser and must be disclosed.",
    "Cropland denotes annual herbaceous crops; tree plantations and pasture use other source classes.",
    "The 2020 v100 and 2021 v200 algorithms differ; their differences do not establish land-cover change alone.",
    "Land cover does not establish field boundaries, crop species, tenure, habitat condition or impact."
  ]
});

// A published legend is reusable interpretation evidence. Choosing this profile
// never verifies a raster's identity, dates, access or distribution terms.
export const JRC_TMF_2025_MAIN_CLASSES = freeze({
  id: "jrc-tmf-2025-main-classes", title: "JRC Tropical Moist Forest 2025 — Transition Map Main Classes",
  product: "TransitionMap_MainClasses", releaseYear: 2025, mappingVersion: "1.0.0", band: 1,
  nominalResolutionMeters: 30,
  historyPeriod: {start: "1982-01-01", end: "2025-12-31"},
  reportingPeriod: {start: "1990-01-01", end: "2025-12-31"},
  recentAmbiguityPeriod: {start: "2023-01-01", end: "2025-12-31"},
  classMeanings: {10: "Undisturbed tropical moist forest", 20: "Degraded tropical moist forest",
    30: "Tropical moist forest regrowth", 41: "Deforested Land - Forest converted to tree plantations",
    42: "Deforested Land - Forest converted to water", 43: "Deforested Land - Forest converted to other land cover",
    50: "Ongoing deforestation or degradation (2023-2025)", 60: "Permanent and seasonal water",
    70: "Other land cover (including afforestation)"},
  classColors: {10: "#005000", 20: "#648723", 30: "#d2fa3c", 41: "#ffc894", 42: "#00c896",
    43: "#ffe664", 50: "#fa8c0a", 60: "#0046a0", 70: "#ffffff"},
  legend: {url: "https://forobs.jrc.ec.europa.eu/TMF/download?dataset=TransitionMap_MainClasses&output=qgis&type=symbology",
    sha256: "1180cc10c58f5d37d3a99eb3f4dbaeb932e347fd5bc1df9f05c77e16cf91c87e", bytes: 10518, format: "QGIS QML",
    entries: [
      {code: 10, label: "10. Undisturbed tropical moist forest", color: "#005000", alpha: 255},
      {code: 20, label: "20. Degraded tropical moist forest", color: "#648723", alpha: 255},
      {code: 30, label: "30. Tropical moist forest regrowth", color: "#d2fa3c", alpha: 255},
      {code: 41, label: "41. Deforested Land - Forest converted to tree plantations", color: "#ffc894", alpha: 255},
      {code: 42, label: "42. Deforested Land - Forest converted to water", color: "#00c896", alpha: 255},
      {code: 43, label: "43. Deforested Land - Forest converted to other land cover", color: "#ffe664", alpha: 255},
      {code: 50, label: "50. Ongoing deforestation or degradation (2023-2025)", color: "#fa8c0a", alpha: 255},
      {code: 60, label: "60. Permanent and seasonal water", color: "#0046a0", alpha: 255},
      {code: 70, label: "70. Other land cover (including afforestation)  ", color: "#ffffff", alpha: 255}
    ]},
  evidenceUrls: ["https://forobs.jrc.ec.europa.eu/TMF/data", "https://forobs.jrc.ec.europa.eu/TMF/resources",
    "https://forobs.jrc.ec.europa.eu/TMF/download?dataset=TransitionMap_MainClasses&output=qgis&type=symbology"],
  metadataLimitations: ["The official page's linked metadata XML describes coverage through 2024. It does not independently verify a selected 2025 raster or its identity."],
  license: null, accessRights: null,
  limitations: [
    "This is an explicitly selected published interpretation profile. The raster's product identity, version, observation dates, coverage and class accuracy remain unverified.",
    "History, reporting and recent-ambiguity periods describe the declared product; they do not replace the raster's independently supplied source dates.",
    "Class 50 retains the published label Ongoing deforestation or degradation (2023-2025); this profile does not separate those processes.",
    "Unknown codes remain counted without a published-profile meaning; the legend does not assign source NoData values.",
    "Undisturbed tropical moist forest is a published class label, not proof of pristine forest, critical habitat or ecological condition.",
    "Provider-mapped degradation, deforestation, regrowth and afforestation classes do not establish independent observations, causation, ecological recovery, tenure or impacts.",
    "Nominal 30 m resolution does not establish native-resolution coverage of cached overview cells. Source terms and output permissions require separate review."
  ]
});

export const FTW_GLOBAL = freeze({
  id: "fields-of-the-world-global", title: "Fields of the World global field predictions",
  observationPeriods: [{start: "2024-01-01", end: "2024-12-31"}, {start: "2025-01-01", end: "2025-12-31"}],
  catalogUrl: "https://data.source.coop/ftw/global-data/catalog.json",
  vectorCollectionUrl: "https://data.source.coop/ftw/global-data/predictions/vectors/collection.json",
  evidenceUrls: ["https://fieldsofthe.world/", "https://source.coop/ftw/global-data",
    "https://source.coop/ftw/global-data/predictions/vectors"],
  license: "CC-BY-4.0", resolutionMeters: 10, distributionVersion: "mutable-alpha",
  confidence: {minimum: 0, maximum: 100, missing: null, sourceResolutionMeters: 500,
    method: "Source-provided value sampled at a field's point-on-surface from the 500 m PRUE confidence raster, rescaled as raw / 0.578178 * 100 and capped at 100.",
    interpretation: "Cell-level model reliability; not a calibrated polygon probability or an individual boundary accuracy measurement."},
  limitations: [
    "Remote-sensing field units are predicted field-interior components, not cadastral or land-tenure parcels.",
    "The published alpha paths are mutable; metadata URLs alone do not pin the bytes or verify AOI coverage.",
    "The training benchmark is separate from the global 2024 and 2025 prediction products.",
    "PMTiles is suitable for display; tile-clipped or quantized features do not establish complete analytical footprints.",
    "Confidence may be conservative outside the training distribution; missing confidence remains missing."
  ]
});

// Recognition pins the published distribution convention, not object access or
// bytes. Only canonical, query-free official tile references get this profile.
export function worldCoverProfileForUrl(url) {
  if (typeof url !== "string") return null;
  const match = /^https:\/\/esa-worldcover\.s3\.eu-central-1\.amazonaws\.com\/v200\/2021\/map\/ESA_WorldCover_10m_2021_v200_([NS])(\d{2})([EW])(\d{3})_Map\.tif$/.exec(url);
  if (!match) return null;
  const latitude = Number(match[2]), longitude = Number(match[4]);
  if (latitude % 3 || longitude % 3 || latitude > (match[1] === "S" ? 90 : 87)
    || longitude > (match[3] === "W" ? 180 : 177) || latitude === 0 && match[1] === "S"
    || longitude === 0 && match[3] === "W") return null;
  return WORLDCOVER_2021;
}

// A source period covers a matching request; partial overlap remains explicit.
// These comparisons assess declared dates, not quality or actual observations.
export function assessBaselinePeriod({sourceStart = null, sourceEnd = null, requestedStart = null, requestedEnd = null} = {}) {
  const source = period(sourceStart, sourceEnd), requested = period(requestedStart, requestedEnd);
  if (!source || !requested) return "not-assessed";
  if (source.end < requested.start || source.start > requested.end) return "disjoint";
  return source.start <= requested.start && source.end >= requested.end ? "matches" : "partial";
}

export function worldCoverReferences({bounds, periodStart = null, periodEnd = null} = {}) {
  const requestedBounds = studyBounds(bounds), requestedPeriod = period(periodStart, periodEnd);
  const periodSuitability = assessBaselinePeriod({sourceStart: WORLDCOVER_2021.observationPeriod.start,
    sourceEnd: WORLDCOVER_2021.observationPeriod.end, requestedStart: periodStart, requestedEnd: periodEnd});
  const [west, south, east, north] = requestedBounds;
  const firstX = Math.floor(west / 3), lastX = Math.ceil(east / 3) - 1;
  const firstY = Math.floor(south / 3), lastY = Math.ceil(north / 3) - 1;
  if ((lastX - firstX + 1) * (lastY - firstY + 1) > 4) throw Error("baseline_tile_limit: Choose an AOI intersecting at most four WorldCover tiles.");
  const drafts = [];
  for (let y = firstY; y <= lastY; y++) for (let x = firstX; x <= lastX; x++) {
    const tileWest = x * 3 || 0, tileSouth = y * 3 || 0;
    const tileId = `${tileSouth < 0 ? "S" : "N"}${String(Math.abs(tileSouth)).padStart(2, "0")}${tileWest < 0 ? "W" : "E"}${String(Math.abs(tileWest)).padStart(3, "0")}`;
    const url = `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_${tileId}_Map.tif`;
    drafts.push({name: `${WORLDCOVER_2021.title} · ${tileId}`,
      description: `Published 2021 land-cover classification, nominal 10 m, with native class codes. ${WORLDCOVER_2021.limitations.join(" ")}`,
      classification: "internal", tags: [], source: {type: "cog", url, bands: [1],
        bounds: [tileWest, tileSouth, tileWest + 3, tileSouth + 3], sizeBytes: null,
        attribution: WORLDCOVER_2021.attribution, license: WORLDCOVER_2021.license,
        referenceMetadata: {dataset: WORLDCOVER_2021.id, title: WORLDCOVER_2021.title, version: WORLDCOVER_2021.version,
          tileId, observationPeriod: {...WORLDCOVER_2021.observationPeriod}, releasedAt: WORLDCOVER_2021.releasedAt,
          requestedBounds: [...requestedBounds], requestedPeriod: requestedPeriod ? {...requestedPeriod} : null, periodSuitability,
          classMeanings: {...WORLDCOVER_2021.classMeanings}, categoricalBand: WORLDCOVER_2021.band,
          nominalResolutionMeters: WORLDCOVER_2021.resolutionMeters, crs: WORLDCOVER_2021.crs,
          providerAvailability: "unverified", coverage: "tile-candidate-unverified",
          evidenceUrls: [...WORLDCOVER_2021.evidenceUrls], limitations: [...WORLDCOVER_2021.limitations]}}});
  }
  return drafts;
}

function studyBounds(bounds) {
  const maximumLatitude = 85.0511287798066;
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)
    || bounds[0] < -180 || bounds[2] > 180 || bounds[1] < -maximumLatitude || bounds[3] > maximumLatitude
    || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) throw Error("baseline_bounds_invalid: Enter ordered, noncrossing WGS84 bounds within the map's latitude range.");
  if (bounds[2] - bounds[0] > 6 || bounds[3] - bounds[1] > 6) throw Error("baseline_bounds_limit: Use a study area no wider or taller than six degrees.");
  return [...bounds];
}
function period(start, end) {
  if (start === null && end === null) return null;
  const valid = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!valid(start) || !valid(end) || start > end) throw Error("baseline_period_invalid: Enter both study dates as real ordered YYYY-MM-DD dates, or leave both blank.");
  return {start, end};
}
function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
  return Object.freeze(value);
}
