import {WORLDCOVER_2021, FTW_GLOBAL, assessBaselinePeriod, worldCoverReferences} from "./publishedBaselineSources.js";
import {canonicalJson} from "./artifactCanonicalJson.js";
import {exactKeys} from "./apiResponseContracts.js";

export const BASELINE_SOURCE_SUITABILITY_LIMITS = Object.freeze({sources: 2, outputBytes: 16_384});
const PURPOSES = ["land-cover", "field-boundaries", "land-cover-and-fields"];
const PRIORITIES = ["dates", "resolution", "coverage", "quality", "rights", "cost"];
const STATUSES = ["matches", "partial", "unknown", "mismatch"];
const CRITERIA_KEYS = ["purpose", "bounds", "periodStart", "periodEnd", "maximumResolutionMeters", "priority"];
const SCOPE = Object.freeze({providerRequests: 0, availability: "unverified", geographicCoverage: "unknown",
  countryAttribution: "not-inferred", sourceQuality: "unknown", authorization: "not-established", processingCost: "unknown"});

/** Compare only the two retained published-product profiles. This review does
 * not discover sources, contact providers, approve a source or grant access.
 */
export function reviewBaselineSources({purpose, bounds, periodStart = null, periodEnd = null,
  maximumResolutionMeters = null, priority = "dates", timestamp} = {}) {
  const criteria = validateCriteria({purpose, bounds, periodStart, periodEnd, maximumResolutionMeters, priority});
  if (!isoTimestamp(timestamp)) throw Error("Source review requires an ISO timestamp with a timezone.");
  const report = createReport(criteria, timestamp); bounded(report); return report;
}

/** The fixed profile and its deterministic assessments are a closed schema.
 * A saved report cannot introduce providers, altered facts or approval claims.
 */
export function validateBaselineSourceSuitability(report) {
  closed(report, ["schemaVersion", "reviewedAt", "criteria", "method", "candidates", "scope", "limits"], "Baseline source suitability");
  bounded(report);
  closed(report.criteria, CRITERIA_KEYS, "Baseline source criteria");
  if (!isoTimestamp(report.reviewedAt) || !Array.isArray(report.candidates)
    || report.candidates.length !== BASELINE_SOURCE_SUITABILITY_LIMITS.sources) throw Error("Invalid source review timestamp or candidate inventory.");
  const expected = createReport(validateCriteria(report.criteria), report.reviewedAt);
  if (canonicalJson(report) !== canonicalJson(expected)) throw Error("Source suitability facts, assessments, ranking or schema are inconsistent.");
  return structuredClone(report);
}

function validateCriteria(criteria) {
  const {purpose, bounds, periodStart, periodEnd, maximumResolutionMeters, priority} = criteria;
  if (!PURPOSES.includes(purpose)) throw Error("Choose land cover, field boundaries or both as the baseline purpose.");
  if (!PRIORITIES.includes(priority)) throw Error("Choose a supported source ranking priority.");
  if (!(periodStart === null || typeof periodStart === "string") || !(periodEnd === null || typeof periodEnd === "string")) throw Error("Study dates must be YYYY-MM-DD strings or null.");
  if (maximumResolutionMeters !== null && (typeof maximumResolutionMeters !== "number"
    || !Number.isFinite(maximumResolutionMeters) || maximumResolutionMeters <= 0)) throw Error("Maximum raster resolution must be a positive number of meters, or blank.");
  // Reuse the maintained bounded AOI and real ordered-date admission. Its four
  // tile ceiling applies here too; candidate tile metadata is never read online.
  worldCoverReferences({bounds, periodStart, periodEnd});
  return {purpose, bounds: [...bounds], periodStart, periodEnd, maximumResolutionMeters, priority};
}

function createReport(criteria, reviewedAt) {
  const candidates = [candidate(WORLDCOVER_2021, "land-cover", criteria), candidate(FTW_GLOBAL, "field-boundaries", criteria)];
  candidates.sort((left, right) => statusRank(left.assessments.purpose.status) - statusRank(right.assessments.purpose.status)
    || statusRank(left.assessments[criteria.priority].status) - statusRank(right.assessments[criteria.priority].status)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  candidates.forEach((item, index) => {item.rank = index + 1;});
  return {schemaVersion: "opengeo.baseline-source-suitability.1.0.0", reviewedAt, criteria,
    method: {id: "fixed-published-source-lexicographic-review", version: "1.0.0",
      candidateInventory: [WORLDCOVER_2021.id, FTW_GLOBAL.id], lexicographicOrder: ["purpose", criteria.priority, "id"],
      statusOrder: [...STATUSES], rankMeaning: "ordinal criteria comparison; not approval or authorization"},
    candidates, scope: {...SCOPE}, limits: {...BASELINE_SOURCE_SUITABILITY_LIMITS}};
}

function candidate(source, productPurpose, criteria) {
  const worldCover = source === WORLDCOVER_2021;
  const periods = worldCover ? [WORLDCOVER_2021.observationPeriod] : FTW_GLOBAL.observationPeriods;
  const sourceFacts = {productType: worldCover ? "categorical-land-cover" : "predicted-field-boundaries",
    distributionVersion: worldCover ? WORLDCOVER_2021.version : FTW_GLOBAL.distributionVersion,
    versionStability: worldCover ? "version-named-distribution; object bytes not pinned" : "mutable-alpha; object bytes not pinned",
    releasedAt: worldCover ? WORLDCOVER_2021.releasedAt : null,
    observationPeriods: structuredClone(periods), nominalRasterResolutionMeters: worldCover ? WORLDCOVER_2021.resolutionMeters : null,
    inputImageryResolutionMeters: worldCover ? null : FTW_GLOBAL.resolutionMeters,
    outputResolutionInterpretation: worldCover ? "Nominal raster pixel size; loaded overviews and map accuracy remain separate."
      : "Input imagery resolution does not establish effective polygon resolution or boundary accuracy.",
    taxonomy: {classes: worldCover ? {...WORLDCOVER_2021.classMeanings} : {}, featureMeaning: worldCover
      ? "Eleven native land-cover classes; cropland is annual herbaceous cover, not actual cultivation, crop species or tenure."
      : "Predicted field outlines; no crop classes, cadastral identities, cultivation or tenure are established."},
    license: source.license, accessRights: "unknown", broaderRights: "unknown", derivedOutputRights: "unknown",
    availability: "unverified", declaredGeographicScope: "global product metadata; actual AOI coverage unverified",
    aoiCoverage: "unknown", aoiQuality: "unknown", processingCost: "unknown",
    confidence: worldCover ? null : structuredClone(FTW_GLOBAL.confidence),
    evidenceUrls: [...source.evidenceUrls], limitations: [...source.limitations]};
  const purposeStatus = criteria.purpose === productPurpose ? "matches" : criteria.purpose === "land-cover-and-fields" ? "partial" : "mismatch";
  const datesStatus = periodStatus(periods, criteria);
  const assessments = {
    purpose: assessment(purposeStatus, worldCover
      ? "Categorical land cover supports land-cover analysis; it does not supply mapped field boundaries."
      : "Predicted field boundaries support field-outline inventories; they do not supply land-cover classes.", ["sourceFacts.productType", "criteria.purpose"]),
    dates: assessment(datesStatus, datesStatus === "unknown" ? "No requested period was supplied; source observation periods remain separate."
      : datesStatus === "matches" ? "The union of declared source periods covers the requested dates; actual AOI observation timing is unverified."
        : datesStatus === "partial" ? "Declared source periods overlap only part of the requested period; gaps are not bridged."
          : "Declared source observation periods are disjoint from the requested dates.", ["sourceFacts.observationPeriods", "criteria.periodStart", "criteria.periodEnd"]),
    resolution: assessment(worldCover && criteria.maximumResolutionMeters !== null
      ? WORLDCOVER_2021.resolutionMeters <= criteria.maximumResolutionMeters ? "matches" : "mismatch" : "unknown",
    worldCover ? criteria.maximumResolutionMeters === null ? "No maximum raster pixel size was requested; nominal 10 m is not an accuracy estimate."
      : "Compare nominal 10 m raster pixels with the requested maximum; loaded overviews and actual accuracy require separate evidence."
      : "The 10 m imagery input does not establish effective polygon resolution or individual boundary accuracy.",
    [worldCover ? "sourceFacts.nominalRasterResolutionMeters" : "sourceFacts.inputImageryResolutionMeters", "sourceFacts.outputResolutionInterpretation"]),
    coverage: assessment("unknown", "Global metadata and candidate tile bounds do not establish actual AOI coverage, source completeness or country membership.", ["sourceFacts.declaredGeographicScope", "sourceFacts.aoiCoverage", "criteria.bounds"]),
    taxonomy: assessment(purposeStatus, sourceFacts.taxonomy.featureMeaning, ["sourceFacts.taxonomy", "criteria.purpose"]),
    quality: assessment("unknown", worldCover ? "AOI-specific positional, thematic and completeness quality have not been assessed."
      : "The 500 m regional reliability value is not a calibrated polygon probability or an individual boundary accuracy measurement.",
    worldCover ? ["sourceFacts.aoiQuality"] : ["sourceFacts.aoiQuality", "sourceFacts.confidence"]),
    rights: assessment("partial", "Declared CC BY 4.0 terms are retained; access, broader terms and derived-output rights are not established or authorized.",
    ["sourceFacts.license", "sourceFacts.accessRights", "sourceFacts.broaderRights", "sourceFacts.derivedOutputRights"]),
    cost: assessment("unknown", "Source bytes, processing time and charges are unknown. Zero provider requests in this local review do not mean zero processing cost.",
    ["scope.providerRequests", "sourceFacts.processingCost"])
  };
  return {id: source.id, title: source.title, rank: 0, sourceFacts, assessments,
    recommendation: {status: "requires-evidence", basis: purposeStatus === "mismatch"
      ? "This source does not supply the requested data type; its rank does not make it appropriate for that purpose."
      : purposeStatus === "partial" ? "This source addresses only part of the purpose; complementary data and AOI, rights, quality and cost evidence remain required."
        : "Confirm AOI coverage, observation timing, accuracy, access and processing cost before choosing this source."}};
}

function periodStatus(periods, criteria) {
  const assessments = periods.map(period => assessBaselinePeriod({sourceStart: period.start, sourceEnd: period.end,
    requestedStart: criteria.periodStart, requestedEnd: criteria.periodEnd}));
  if (criteria.periodStart === null && criteria.periodEnd === null) return "unknown";
  if (assessments.includes("matches")) return "matches";
  if (!assessments.includes("partial")) return "mismatch";
  // Walk only actual source intervals. Consecutive annual intervals may form a
  // union; missing days/years never become implied observations.
  let cursor = Date.parse(criteria.periodStart);
  const end = Date.parse(criteria.periodEnd), day = 86_400_000;
  for (const period of [...periods].sort((left, right) => left.start < right.start ? -1 : 1)) {
    const first = Date.parse(period.start), last = Date.parse(period.end);
    if (last < cursor) continue;
    if (first > cursor) return "partial";
    cursor = Math.max(cursor, last + day);
    if (cursor > end) return "matches";
  }
  return "partial";
}
function assessment(status, basis, evidence) {return {status, basis, evidence};}
function statusRank(status) {return STATUSES.indexOf(status);}
function bounded(value) {if (new TextEncoder().encode(JSON.stringify(value)).byteLength > BASELINE_SOURCE_SUITABILITY_LIMITS.outputBytes) throw Error("Source suitability report exceeds its byte limit.");}
function closed(value, keys, label) {if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`${label} is invalid.`); exactKeys(value, keys, label);}
function isoTimestamp(value) {
  if (typeof value !== "string" || value.length > 64) return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    && hour <= 23 && minute <= 59 && second <= 59;
}
