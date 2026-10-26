import {assertStacItemReference} from "./stacItemSearch.js";
import {prepareBaselineAoi} from "./baselineAoi.js";
import {canonicalJson} from "./artifactCanonicalJson.js";
import {sha256Hex} from "./managedUpload.js";
import {publicItemUrl} from "./staticItemSearch.js";

export const STAC_SOURCE_SUITABILITY_LIMITS = Object.freeze({candidates: 20, outputBytes: 65_536,
  selectedBytes: 16_384, milliseconds: 5_000});
const SCHEMA = "opengeo.stac-source-suitability.1.0.0";
const AXES = ["coverage", "dates", "resolution", "taxonomy", "quality", "rights", "cost"];
const STATUSES = ["matches", "partial", "unknown", "mismatch"];
const CRITERIA = ["bounds", "periodStart", "periodEnd", "maximumResolutionMeters", "requiredBandNames",
  "requiredClassNames", "maximumCloudCover", "acceptedLicenses", "maximumTransferBytes", "priority"];
const SCOPE = Object.freeze({providerRequests: 0, authorization: "not-established", availability: "unverified",
  countryAttribution: "not-inferred", coverage: "declared-item-footprint-only", aoiAccuracy: "unknown", processingCost: "unknown"});
const COVERAGE_METHOD = Object.freeze({id: "gnomonic-geodesic-triangle-cell-intersection", version: "1.0.0",
  edges: "shortest-great-circle-between-supplied-vertices", areaUnit: "square-meter", ellipsoidalSurvey: false});
const RESOLUTION_MEANING = "Nominal source declaration; not effective detail or positional accuracy.";
const TAXONOMY_MEANING = "Selected band and asset declarations; exact names, no implicit crosswalk.";
const COST_MEANING = "Declared asset file size; not processing time, charges or transfer pricing.";
const plain = value => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = message => Object.assign(Error(message), {code: "stac_source_suitability_invalid"});
const equal = (left, right) => canonicalJson(left) === canonicalJson(right);
const positive = value => typeof value === "number" && Number.isFinite(value) && value > 0;
const text = value => typeof value === "string" && value.length > 0 && value.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(value);
const assessment = (status, basis, evidence) => ({status, basis, evidence});
const hash = value => sha256Hex(new Blob([canonicalJson(value)]));

/** Review retained public Item/asset references locally. No provider or account calls. */
export async function reviewStacSources({selections, criteria, timestamp, signal, assertCurrent} = {}) {
  return review(selections, normalizeCriteria(criteria), instant(timestamp), budget({signal, assertCurrent}));
}

export async function validateStacSourceSuitability(report, {selections} = {}) {
  const check = budget({}); check();
  bounded(report, STAC_SOURCE_SUITABILITY_LIMITS.outputBytes);
  const expected = await review(selections, normalizeCriteria(report?.criteria), instant(report?.reviewedAt), check);
  if (!equal(report, expected)) throw fail("The source suitability report changed; compare its retained references again.");
  return structuredClone(report);
}

/** Bind only a recomputed selected candidate to its current reference. Other
 * candidates' stored facts are checked for schema/ranking consistency, not verified.
 */
export async function bindStacSourceSuitability({report, candidateId} = {}, {reference, assetKey, bands, signal, assertCurrent} = {}) {
  const check = budget({signal, assertCurrent}); check();
  await validateStoredReport(report, check);
  const stored = report.candidates.find(candidate => candidate.id === candidateId);
  if (!stored) throw fail("Choose a candidate from the current source comparison.");
  const current = await review([{reference, assetKey, bands}], normalizeCriteria(report.criteria), report.reviewedAt, check);
  const selected = {...current.candidates[0], rank: stored.rank};
  if (!equal(stored, selected)) throw fail("The selected reference, bands or suitability criteria changed; compare again.");
  const result = {schemaVersion: "opengeo.stac-source-suitability-selection.1.0.0", reviewedAt: report.reviewedAt,
    criteria: structuredClone(report.criteria), method: structuredClone(report.method), candidate: structuredClone(stored),
    reportChecksumSha256: await hash(report)};
  check(); bounded(result, STAC_SOURCE_SUITABILITY_LIMITS.selectedBytes); return result;
}

function budget({signal, assertCurrent}) {
  const started = performance.now();
  return () => {signal?.throwIfAborted(); assertCurrent?.();
    if (performance.now() - started >= STAC_SOURCE_SUITABILITY_LIMITS.milliseconds) throw fail("The five-second local source review limit was reached.");};
}
function keys(value, expected, label) {
  if (!plain(value) || !equal(Object.keys(value).sort(), [...expected].sort())) throw fail(`${label} has an invalid schema.`);
}
function bounded(value, maximum) {
  let rendered; try {rendered = canonicalJson(value);} catch {throw fail("Source suitability must be plain finite JSON.");}
  if (new TextEncoder().encode(rendered).byteLength > maximum) throw fail("The source suitability report exceeds its byte limit.");
}
function instant(value) {
  if (typeof value !== "string" || value.length > 64
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw fail("Use an ISO review timestamp with a timezone.");
  date(value.slice(0, 10));
  if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) throw fail("Use a valid review timestamp.");
  return value;
}
function date(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString().slice(0, 10) !== value) throw fail("Use valid YYYY-MM-DD study dates.");
  return value;
}
function strings(value, label, maximum = 32) {
  if (!Array.isArray(value) || value.length > maximum || value.some(item => !text(item)) || new Set(value).size !== value.length) throw fail(`${label} must be a bounded list of distinct exact names.`);
  return [...value];
}
function normalizeCriteria(value) {
  if (!plain(value) || Object.keys(value).some(key => !CRITERIA.includes(key))) throw fail("Source suitability criteria are invalid.");
  const {bounds, periodStart = null, periodEnd = null, maximumResolutionMeters = null, requiredBandNames = [],
    requiredClassNames = [], maximumCloudCover = null, acceptedLicenses = [], maximumTransferBytes = null, priority = "coverage"} = value;
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[0] < -180 || bounds[2] > 180
    || bounds[1] < -80 || bounds[3] > 80 || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]
    || bounds[2] - bounds[0] > 6 || bounds[3] - bounds[1] > 6) throw fail("Choose ordered noncrossing study bounds spanning at most six degrees, within 80 degrees latitude.");
  if ((periodStart === null) !== (periodEnd === null) || periodStart !== null && (date(periodStart) > date(periodEnd))) throw fail("Choose both ordered study dates, or leave both blank.");
  if (maximumResolutionMeters !== null && !positive(maximumResolutionMeters)
    || maximumCloudCover !== null && (typeof maximumCloudCover !== "number" || !Number.isFinite(maximumCloudCover) || maximumCloudCover < 0 || maximumCloudCover > 100)
    || maximumTransferBytes !== null && (!Number.isSafeInteger(maximumTransferBytes) || maximumTransferBytes < 1)
    || !AXES.includes(priority)) throw fail("Choose supported resolution, cloud-cover, byte limits and ranking priority.");
  return {bounds: [...bounds], periodStart, periodEnd, maximumResolutionMeters,
    requiredBandNames: strings(requiredBandNames, "Required bands"), requiredClassNames: strings(requiredClassNames, "Required classes"),
    maximumCloudCover, acceptedLicenses: strings(acceptedLicenses, "Accepted distribution licenses"), maximumTransferBytes, priority};
}
function method(criteria) {
  return {id: "retained-stac-asset-lexicographic-review", version: "1.0.0",
    lexicographicOrder: [criteria.priority, ...AXES.filter(axis => axis !== criteria.priority)], statusOrder: [...STATUSES],
    rankMeaning: "Ordinal evidence comparison; not approval or authorization."};
}
function compare(criteria) {
  const order = method(criteria).lexicographicOrder;
  return (left, right) => {for (const axis of order) {const difference = STATUSES.indexOf(left.assessments[axis].status) - STATUSES.indexOf(right.assessments[axis].status); if (difference) return difference;}
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;};
}
async function identityId(identity) {
  const {endpoint, collectionId, itemId, assetKey, bands} = identity;
  return `stac-${await hash({endpoint, collectionId, itemId, assetKey, bands})}`;
}
function selectedAsset({reference, assetKey, bands} = {}) {
  assertStacItemReference(reference);
  const asset = reference.assets.find(value => value.key === assetKey), declared = asset?.original?.["raster:bands"] ?? asset?.bands;
  if (!asset?.cogCompatible || !Array.isArray(bands) || ![1, 3].includes(bands.length) || new Set(bands).size !== bands.length
    || bands.some(band => !Number.isInteger(band) || band < 1 || band > 64 || declared?.length > 0 && band > declared.length)) throw fail("Choose a compatible TIFF asset and one or three valid, distinct one-based bands.");
  return asset;
}
async function review(selections, criteria, reviewedAt, check) {
  check();
  if (!Array.isArray(selections) || !selections.length || selections.length > STAC_SOURCE_SUITABILITY_LIMITS.candidates) throw fail("Compare one to twenty retained source candidates.");
  const [west, south, east, north] = criteria.bounds, corners = [[west, south], [east, south], [east, north], [west, north]];
  const study = await prepareBaselineAoi({geometry: {type: "Polygon", coordinates: [[...corners, corners[0]]]}, assertCurrent: check});
  const footprints = new Map(), candidates = [];
  for (const selection of selections) {
    check(); const asset = selectedAsset(selection), {reference, bands, assetKey} = selection;
    const identity = {endpoint: reference.query.endpoint, collectionId: reference.collectionId, itemId: reference.id,
      assetKey, bands: [...bands], href: asset.href, snapshotSha256: reference.snapshot.sha256};
    const id = await identityId(identity); check();
    if (candidates.some(candidate => candidate.id === id)) throw fail("The same source, asset and bands were selected more than once.");
    const geometry = reference.original.geometry, cacheKey = canonicalJson(geometry ?? null);
    let coverage = footprints.get(cacheKey);
    if (!coverage) {
      coverage = {fraction: null, intersectionAreaSquareMeters: null, studyAreaSquareMeters: study.areaSquareMeters,
        method: null, basis: "declared-item-footprint", validPixelCoverage: "unknown", unknownReason: "missing-item-geometry"};
      if (geometry) try {
        const prepared = await prepareBaselineAoi({geometry, assertCurrent: check}); check();
        let area = prepared.intersectCell(corners); check();
        if (area > study.areaSquareMeters + Math.max(1e-6, study.areaSquareMeters * 1e-9)) throw Object.assign(Error(), {code: "baseline_aoi_intersection_inconsistent"});
        area = Math.min(area, study.areaSquareMeters);
        coverage = {...coverage, fraction: area / study.areaSquareMeters, intersectionAreaSquareMeters: area,
          method: {...COVERAGE_METHOD}, unknownReason: null};
      } catch (error) {check(); if (!error.code?.startsWith("baseline_aoi_")) throw error; coverage.unknownReason = error.code;}
      footprints.set(cacheKey, coverage);
    }
    const facts = sourceFacts(reference, asset, bands, criteria, coverage); validateFacts(facts, criteria);
    candidates.push({id, identity, title: typeof reference.original.properties.title === "string" ? reference.original.properties.title : reference.id,
      rank: 0, facts, assessments: assess(facts, criteria)});
  }
  candidates.sort(compare(criteria)); candidates.forEach((candidate, index) => {candidate.rank = index + 1;});
  const report = {schemaVersion: SCHEMA, reviewedAt, criteria, method: method(criteria), candidates, scope: {...SCOPE}, limits: {...STAC_SOURCE_SUITABILITY_LIMITS}};
  check(); bounded(report, STAC_SOURCE_SUITABILITY_LIMITS.outputBytes); return report;
}
function periodFraction(start, end, criteria) {
  if (criteria.periodStart === null) return null;
  const first = Date.parse(criteria.periodStart), last = Date.parse(criteria.periodEnd) + 86_400_000 - 1;
  return Math.max(0, Math.min(last, Date.parse(end)) - Math.max(first, Date.parse(start))) / (last - first);
}
function sourceFacts(reference, asset, bands, criteria, coverage) {
  const original = asset.original, bandMetadata = bands.map(band => original["raster:bands"]?.[band - 1]),
    selectedResolution = bandMetadata.map(band => band?.spatial_resolution);
  let meters = null, authority = null;
  if (positive(original.gsd)) {meters = original.gsd; authority = "asset.gsd";}
  else if (selectedResolution.every(positive)) {meters = Math.max(...selectedResolution); authority = "selected raster:bands.spatial_resolution";}
  else if (positive(reference.original.properties.gsd)) {meters = reference.original.properties.gsd; authority = "item.properties.gsd";}
  const bandNames = new Set(), classNames = new Set();
  const classes = value => {if (Array.isArray(value)) for (const item of value) if (typeof item?.name === "string") classNames.add(item.name);};
  classes(original["classification:classes"]);
  for (const band of bands) for (const key of ["eo:bands", "bands", "raster:bands"]) {
    const metadata = original[key]?.[band - 1];
    if (key !== "raster:bands") for (const name of [metadata?.name, metadata?.common_name]) if (typeof name === "string") bandNames.add(name);
    classes(metadata?.["classification:classes"]);
  }
  return {coverage: structuredClone(coverage), observationPeriod: {start: reference.start, end: reference.end,
    requestedCoverageFraction: periodFraction(reference.start, reference.end, criteria)}, resolution: {meters, authority, interpretation: RESOLUTION_MEANING},
    taxonomy: {bandNames: [...bandNames].sort(), classNames: [...classNames].sort(), interpretation: TAXONOMY_MEANING},
    quality: {itemCloudCoverPercent: Number.isFinite(reference.cloudCover) && reference.cloudCover >= 0 && reference.cloudCover <= 100 ? reference.cloudCover : null,
      scope: "whole-item-declaration", aoiAccuracy: "unknown"},
    rights: {assetLicense: typeof original.license === "string" ? original.license : null,
      itemLicense: typeof reference.license === "string" ? reference.license : null, authorization: "not-established", broaderRights: "unknown", derivedOutputRights: "unknown"},
    cost: {assetBytes: Number.isSafeInteger(original["file:size"]) && original["file:size"] > 0 ? original["file:size"] : null,
      basis: COST_MEANING, processingCost: "unknown", monetaryCost: "unknown"}};
}
function assess(facts, criteria) {
  const {coverage, observationPeriod: dates, resolution, taxonomy, quality, rights, cost} = facts;
  const requestedFirst = criteria.periodStart === null ? null : Date.parse(criteria.periodStart),
    requestedLast = criteria.periodEnd === null ? null : Date.parse(criteria.periodEnd) + 86_400_000 - 1;
  const dateStatus = requestedFirst === null ? "unknown" : Date.parse(dates.start) > requestedLast || Date.parse(dates.end) < requestedFirst ? "mismatch"
    : Date.parse(dates.start) <= requestedFirst && Date.parse(dates.end) >= requestedLast ? "matches" : "partial";
  const requirements = [...criteria.requiredBandNames.map(name => [name, taxonomy.bandNames]), ...criteria.requiredClassNames.map(name => [name, taxonomy.classNames])];
  const matched = requirements.filter(([name, names]) => names.includes(name)).length;
  const taxonomyStatus = !requirements.length ? "unknown" : matched === requirements.length ? "matches" : matched ? "partial"
    : (!criteria.requiredBandNames.length || taxonomy.bandNames.length) && (!criteria.requiredClassNames.length || taxonomy.classNames.length) ? "mismatch" : "unknown";
  return {
    coverage: assessment(coverage.fraction === null ? "unknown" : coverage.fraction >= 1 - 1e-9 ? "matches" : coverage.fraction > 0 ? "partial" : "mismatch",
      coverage.fraction === null ? `Declared footprint coverage is unknown (${coverage.unknownReason}); bounding boxes are not substituted.`
        : "Intersection of declared Item geometry and study bounds; valid pixels, observations and inventory completeness remain unknown.", ["facts.coverage", "criteria.bounds"]),
    dates: assessment(dateStatus, "Compare only the declared observation interval with requested whole UTC dates; temporal overlap does not establish complete observations.",
      ["facts.observationPeriod", "criteria.periodStart", "criteria.periodEnd"]),
    resolution: assessment(criteria.maximumResolutionMeters === null || resolution.meters === null ? "unknown" : resolution.meters <= criteria.maximumResolutionMeters ? "matches" : "mismatch",
      "Compare declared nominal raster resolution only; input imagery and accuracy are not inferred.", ["facts.resolution", "criteria.maximumResolutionMeters"]),
    taxonomy: assessment(taxonomyStatus, "Compare requested band and class names exactly with selected distribution declarations; absent names and implicit crosswalks are not supplied.",
      ["facts.taxonomy", "criteria.requiredBandNames", "criteria.requiredClassNames"]),
    quality: assessment(criteria.maximumCloudCover === null || quality.itemCloudCoverPercent === null ? "unknown" : quality.itemCloudCoverPercent <= criteria.maximumCloudCover ? "partial" : "mismatch",
      "Cloud cover is a whole-Item declaration only; passing the threshold does not establish AOI cloud cover, accuracy or fitness for use.", ["facts.quality", "criteria.maximumCloudCover"]),
    rights: assessment(!criteria.acceptedLicenses.length || rights.assetLicense === null ? "unknown" : criteria.acceptedLicenses.includes(rights.assetLicense) ? "partial" : "mismatch",
      "Compare only the selected asset's declared license. Item terms are context, never inherited; access, authorization and broader or derived rights remain unestablished.",
      ["facts.rights", "criteria.acceptedLicenses"]),
    cost: assessment(criteria.maximumTransferBytes === null || cost.assetBytes === null ? "unknown" : cost.assetBytes <= criteria.maximumTransferBytes ? "partial" : "mismatch",
      "Declared file size is a transfer-volume proxy only; partial reads, processing, charges and monetary cost remain unknown.", ["facts.cost", "criteria.maximumTransferBytes"])
  };
}
async function validateStoredReport(report, check) {
  bounded(report, STAC_SOURCE_SUITABILITY_LIMITS.outputBytes);
  keys(report, ["schemaVersion", "reviewedAt", "criteria", "method", "candidates", "scope", "limits"], "Source suitability report");
  const criteria = normalizeCriteria(report.criteria); instant(report.reviewedAt);
  if (report.schemaVersion !== SCHEMA || !equal(criteria, report.criteria) || !equal(report.method, method(criteria))
    || !equal(report.scope, SCOPE) || !equal(report.limits, STAC_SOURCE_SUITABILITY_LIMITS)
    || !Array.isArray(report.candidates) || !report.candidates.length || report.candidates.length > STAC_SOURCE_SUITABILITY_LIMITS.candidates) throw fail("Source suitability report facts or method changed.");
  const ids = new Set();
  for (const candidate of report.candidates) {
    check(); keys(candidate, ["id", "identity", "title", "rank", "facts", "assessments"], "Source candidate");
    const identity = candidate.identity;
    keys(identity, ["endpoint", "collectionId", "itemId", "assetKey", "bands", "href", "snapshotSha256"], "Source identity");
    if (![identity.collectionId, identity.itemId, identity.assetKey, candidate.title].every(text)
      || !Array.isArray(identity.bands) || ![1, 3].includes(identity.bands.length) || new Set(identity.bands).size !== identity.bands.length
      || identity.bands.some(band => !Number.isInteger(band) || band < 1 || band > 64) || !/^[a-f0-9]{64}$/.test(identity.snapshotSha256)) throw fail("Source candidate identity is invalid.");
    const endpoint = new URL(publicItemUrl(identity.endpoint)), href = new URL(publicItemUrl(identity.href));
    if (endpoint.search || endpoint.hash || !/\/search\/?$/.test(endpoint.pathname) || href.search || href.hash || !/\.tiff?$/i.test(href.pathname)
      || candidate.id !== await identityId(identity) || ids.has(candidate.id)) throw fail("Source candidate pins or identity changed.");
    ids.add(candidate.id); validateFacts(candidate.facts, criteria);
    if (!equal(candidate.assessments, assess(candidate.facts, criteria))) throw fail("Source candidate assessments changed.");
  }
  const ranked = [...report.candidates].sort(compare(criteria));
  if (ranked.some((candidate, index) => candidate !== report.candidates[index] || candidate.rank !== index + 1)) throw fail("Source suitability ranking changed.");
  check();
}
function validateFacts(facts, criteria) {
  keys(facts, ["coverage", "observationPeriod", "resolution", "taxonomy", "quality", "rights", "cost"], "Source facts");
  const {coverage: c, observationPeriod: d, resolution: r, taxonomy: t, quality: q, rights, cost} = facts;
  keys(c, ["fraction", "intersectionAreaSquareMeters", "studyAreaSquareMeters", "method", "basis", "validPixelCoverage", "unknownReason"], "Footprint facts");
  if (!positive(c.studyAreaSquareMeters) || c.basis !== "declared-item-footprint" || c.validPixelCoverage !== "unknown"
    || (c.fraction === null ? c.intersectionAreaSquareMeters !== null || c.method !== null || !text(c.unknownReason)
      : typeof c.fraction !== "number" || c.fraction < 0 || c.fraction > 1 || !Number.isFinite(c.intersectionAreaSquareMeters)
        || c.intersectionAreaSquareMeters < 0 || c.intersectionAreaSquareMeters > c.studyAreaSquareMeters
        || Math.abs(c.fraction - c.intersectionAreaSquareMeters / c.studyAreaSquareMeters) > 1e-12 || !equal(c.method, COVERAGE_METHOD) || c.unknownReason !== null)) throw fail("Footprint evidence is invalid.");
  keys(d, ["start", "end", "requestedCoverageFraction"], "Observation facts"); instant(d.start); instant(d.end);
  if (Date.parse(d.start) > Date.parse(d.end) || d.requestedCoverageFraction !== periodFraction(d.start, d.end, criteria)) throw fail("Observation evidence changed.");
  keys(r, ["meters", "authority", "interpretation"], "Resolution facts");
  if (r.interpretation !== RESOLUTION_MEANING || (r.meters === null ? r.authority !== null : !positive(r.meters)
    || !["asset.gsd", "selected raster:bands.spatial_resolution", "item.properties.gsd"].includes(r.authority))) throw fail("Resolution evidence is invalid.");
  keys(t, ["bandNames", "classNames", "interpretation"], "Taxonomy facts"); strings(t.bandNames, "Declared bands", 128); strings(t.classNames, "Declared classes", 512);
  if (t.interpretation !== TAXONOMY_MEANING) throw fail("Taxonomy interpretation changed.");
  keys(q, ["itemCloudCoverPercent", "scope", "aoiAccuracy"], "Quality facts");
  if (q.scope !== "whole-item-declaration" || q.aoiAccuracy !== "unknown" || q.itemCloudCoverPercent !== null
    && (typeof q.itemCloudCoverPercent !== "number" || !Number.isFinite(q.itemCloudCoverPercent) || q.itemCloudCoverPercent < 0 || q.itemCloudCoverPercent > 100)) throw fail("Quality evidence is invalid.");
  keys(rights, ["assetLicense", "itemLicense", "authorization", "broaderRights", "derivedOutputRights"], "Rights facts");
  if ([rights.assetLicense, rights.itemLicense].some(value => value !== null && !text(value)) || rights.authorization !== "not-established"
    || rights.broaderRights !== "unknown" || rights.derivedOutputRights !== "unknown") throw fail("Rights evidence is invalid.");
  keys(cost, ["assetBytes", "basis", "processingCost", "monetaryCost"], "Cost facts");
  if (cost.assetBytes !== null && (!Number.isSafeInteger(cost.assetBytes) || cost.assetBytes < 1) || cost.basis !== COST_MEANING
    || cost.processingCost !== "unknown" || cost.monetaryCost !== "unknown") throw fail("Cost evidence is invalid.");
}
