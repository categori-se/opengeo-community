import {canonicalJson} from './artifactCanonicalJson.js';
import {sha256Hex} from './managedUpload.js';
import {polygonMeasurementMetrics} from './areaMeasurement.js';
import {meanRadiusMeters,spatialBodyDefinition} from './spatialBody.js';
import {worldCoverProfileForUrl} from './publishedBaselineSources.js';
import {assertRasterValidationAssessment,rasterValidationGeoJson,rasterValidationReviewState,verifyRasterValidationPlanIdentity} from './rasterValidation.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const MAX_BYTES = 2_200_000;
const MAX_CELLS = 1_048_576;
const MAX_MAP = 1024;
const encoder = new TextEncoder();
const EARTH_RADIUS = meanRadiusMeters(spatialBodyDefinition('earth'));
const plain = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = () => {throw Error('The raster analysis report, complete cell map or source evidence is invalid.');};
const require = condition => {if (!condition) fail();};
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_CELLS;
const positive = value => Number.isFinite(value) && value > 0;
const nonnegative = value => Number.isFinite(value) && value >= 0;
const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1e-7, Math.abs(b) * 1e-9);
const text = (value, max = 240) => typeof value === 'string' && value.length <= max;
const nullableText = (value, max) => value === null || text(value, max);
const coordinate = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
  && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 85.05112878;
const vector = value => Array.isArray(value) && [2, 3].includes(value.length) && value.every(Number.isFinite);
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, structuredClone(value[key])]));
function keys(value, expected) {
  require(plain(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)));
}
function strings(value, max = 4096) {require(Array.isArray(value) && value.length <= 64 && value.every(item => text(item, max)));}
function datePeriod(value) {
  if (value === null) return;
  keys(value, ['start', 'end']);
  require(Object.values(value).every(date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date) && value.start <= value.end);
}

/** Validate exported evidence locally. This is consistency checking, not source
 * authentication or independent validation of classifications and declarations. */
export function rasterAnalysisEvidence(collection) {
  const receipt = collection?.['opengeo:analysis'];
  if (!plain(receipt) || !['rasterComparison', 'rasterPatches', 'rasterValidation', 'rasterHeightDifference'].some(key => Object.hasOwn(receipt, key))) return null;
  const kinds = ['rasterComparison', 'rasterPatches', 'rasterValidation', 'rasterHeightDifference'].filter(key => Object.hasOwn(receipt, key));
  require(kinds.length === 1);
  const kind = kinds[0]; keys(receipt, [kind]);
  require(collection.type === 'FeatureCollection' && Array.isArray(collection.features)
    && collection.features.length > 0 && collection.features.length <= (kind === 'rasterValidation' ? 512 : MAX_MAP));
  // Bound traversals before canonicalization, cloning or per-feature validation.
  boundedJson({type: collection.type, features: collection.features, 'opengeo:analysis': receipt});
  const report = structuredClone(receipt[kind]);
  if (kind === 'rasterHeightDifference') return rasterHeightDifferenceEvidence(collection.features, report);
  if (kind === 'rasterValidation') return rasterValidationEvidence(collection.features, report);
  const comparison = kind === 'rasterComparison';
  keys(report, ['schemaVersion', 'status', 'scope', ...(comparison ? ['inputs', 'coverage', 'transitions', 'comparability']
    : ['input', 'criteria', 'coverage', 'summary', 'patches']), 'map', 'method', 'accuracy', 'outputRights', 'limitations',
    ...(comparison ? ['outputCustody'] : []), 'usage', ...(comparison && report.schemaVersion === 'opengeo.cached-raster-comparison.1.1.0' ? ['referenceEvaluation'] : [])]);
  require(report.status === 'complete' && (comparison
    ? ['opengeo.cached-raster-comparison.1.0.0', 'opengeo.cached-raster-comparison.1.1.0'].includes(report.schemaVersion)
    : report.schemaVersion === 'opengeo.cached-raster-patches.1.0.0'));
  if (report.schemaVersion === 'opengeo.cached-raster-comparison.1.1.0') require(plain(report.referenceEvaluation));
  keys(report.scope, ['kind', 'width', 'height', 'fullDataset', 'cornerCoordinates']);
  const {width, height, cornerCoordinates} = report.scope, total = width * height;
  require(Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0 && count(total)
    && report.scope.fullDataset === false && report.scope.kind === (comparison ? 'paired-loaded-grid-window' : 'loaded-grid-window')
    && Array.isArray(cornerCoordinates) && cornerCoordinates.length === 4 && cornerCoordinates.every(coordinate));
  const roles = comparison ? ['before', 'after'] : ['input'];
  if (comparison) keys(report.inputs, roles);
  const fullInputs = comparison ? report.inputs : {input: report.input};
  const inputs = Object.fromEntries(roles.map(role => [role, validateInput(fullInputs[role], width, height)]));
  if (comparison) {
    const a = fullInputs.before.source, b = fullInputs.after.source;
    require(a.projection === b.projection && effectiveGrid(a).every((value, index) => closeGrid(value, effectiveGrid(b)[index])));
  }
  keys(report.map, ['available', comparison ? 'changedCells' : 'targetCells', 'featureLimit', 'status']);
  const mappedCount = comparison ? report.coverage?.changedCells : report.coverage?.targetCells;
  require(report.map.available === true && report.map.status === 'complete' && report.map.featureLimit === MAX_MAP
    && report.map[comparison ? 'changedCells' : 'targetCells'] === mappedCount && mappedCount === collection.features.length);
  keys(report.accuracy, ['status', 'classificationAccuracy', comparison ? 'changeAccuracy' : 'patchAccuracy', 'fieldValidation']);
  require(report.accuracy.status === 'unknown' && Object.entries(report.accuracy).every(([key, value]) => key === 'status' || value === null));
  keys(report.outputRights, ['status', 'license', 'accessRights', 'statement']);
  require(report.outputRights.status === 'not-established' && report.outputRights.license === null
    && report.outputRights.accessRights === null && text(report.outputRights.statement, 1000));
  strings(report.limitations);
  require(report.limitations.length > 0);
  if (comparison) validateComparison(report, total);
  else validatePatches(report, total);
  validateFeatures(collection.features, report, comparison);
  const summary = {schemaVersion: `opengeo.cached-raster-${comparison ? 'comparison' : 'patches'}-summary.${report.schemaVersion.endsWith('1.1.0') ? '1.1.0' : '1.0.0'}`,
    reportSchemaVersion: report.schemaVersion, status: report.status, scope: structuredClone(report.scope),
    inputs, coverage: structuredClone(report.coverage), map: structuredClone(report.map),
    method: structuredClone(report.method), accuracy: structuredClone(report.accuracy), outputRights: structuredClone(report.outputRights),
    limitations: structuredClone(report.limitations), usage: structuredClone(report.usage),
    ...(comparison ? {comparability: structuredClone(report.comparability), transitionCount: report.transitions.length,
      ...(report.referenceEvaluation ? {referenceEvaluation: {...pick(report.referenceEvaluation, ['schemaVersion', 'status', 'roles', 'basis', 'scope', 'overall', 'method', 'quality', 'limitations']),
        classCount: report.referenceEvaluation.classes.length, confusionCount: report.referenceEvaluation.confusion.length}} : {})}
      : {criteria: structuredClone(report.criteria), summary: structuredClone(report.summary)})};
  const attributions = [...new Set(Object.values(inputs).map(input => input.source.reference.attribution).filter(Boolean))];
  return {kind, operation: comparison ? 'raster-compare' : 'raster-patches', report, inputs, summary,
    source: {attribution: attributions.join('\n') || null, license: null}};
}

/** Complete continuous cells retain their source values once in the original.
 * This validates internal consistency, not physical elevation or source truth. */
function rasterHeightDifferenceEvidence(features, report) {
  keys(report, ['schemaVersion', 'status', 'inputs', 'coverage', 'statistics', 'review', 'scope', 'method', 'map',
    'outputRights', 'outputCustody', 'limitations', 'usage']);
  require(report.schemaVersion === 'opengeo.cached-raster-height-difference.1.0.0' && report.status === 'complete'
    && report.outputCustody === 'locally-created-derived-summary');
  keys(report.scope, ['kind', 'width', 'height', 'fullDataset', 'cornerCoordinates']);
  const {width, height, cornerCoordinates} = report.scope, total = width * height;
  require(Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0
    && total <= MAX_MAP && total === features.length && report.scope.kind === 'paired-loaded-grid-window'
    && report.scope.fullDataset === false && Array.isArray(cornerCoordinates) && cornerCoordinates.length === 4 && cornerCoordinates.every(coordinate));
  keys(report.inputs, ['surface', 'terrain']);
  const factors = {metres: 1, 'international-feet': .3048, 'us-survey-feet': 1200 / 3937};
  for (const role of ['surface', 'terrain']) {
    const input = report.inputs[role];
    keys(input, ['role', 'roleAuthority', 'elevationConfirmed', 'band', 'units', 'metersPerUnit', 'source', 'pins']);
    require(input.role === role && input.roleAuthority === 'user-declared-unverified' && input.elevationConfirmed === true
      && Object.hasOwn(factors, input.units) && input.metersPerUnit === factors[input.units]);
    validateStoredRasterSource(input, width, height);
    require(typeof input.pins.layerId === 'string' && input.pins.layerId.trim());
  }
  const {surface, terrain} = report.inputs;
  require(surface.pins.layerId !== terrain.pins.layerId || surface.band !== terrain.band);
  require(surface.source.projection === terrain.source.projection
    && effectiveGrid(surface.source).every((value, index) => closeGrid(value, effectiveGrid(terrain.source)[index])));
  keys(report.review, ['confirmed', 'basis', 'authority']);
  require(report.review.confirmed === true && report.review.authority === 'user-declared-unverified'
    && text(report.review.basis, 500) && report.review.basis.trim() && report.review.basis === report.review.basis.trim());
  keys(report.map, ['available', 'status', 'totalCells', 'featureLimit']);
  require(report.map.available === true && report.map.status === 'complete' && report.map.totalCells === total && report.map.featureLimit === MAX_MAP);
  keys(report.method, ['id', 'version', 'formula', 'weighting', 'units', 'unitConversions', 'valueScaling',
    'elevationAndVerticalCompatibility', 'alignment', 'excludedPairs', 'sourceStatus', 'resampling', 'reprojection', 'aoiClipping', 'classification', 'accuracy']);
  const method = report.method;
  require(method.id === 'cached-surface-minus-terrain' && method.version === '1.0.0' && method.formula === 'surfaceMeters - terrainMeters'
    && method.units === 'metres' && method.weighting === 'equal-valid-cached-cell-counts' && equal(method.unitConversions, factors)
    && method.resampling === 'none' && method.reprojection === 'none' && method.aoiClipping === 'none'
    && method.classification === 'none' && method.accuracy === 'not established');
  for (const key of ['valueScaling', 'elevationAndVerticalCompatibility', 'excludedPairs', 'sourceStatus']) require(text(method[key], 1000) && method[key]);
  require(equal(method.alignment, {projection: 'identical', grid: 'matching-effective-projected-origin-and-resolution',
    everyCellCorner: true, toleranceDegrees: 1e-10, interpretation: 'area'}));
  keys(report.outputRights, ['status', 'license', 'accessRights', 'statement']);
  require(report.outputRights.status === 'not-established' && report.outputRights.license === null
    && report.outputRights.accessRights === null && text(report.outputRights.statement, 1000));
  strings(report.limitations); require(report.limitations.length > 0);
  keys(report.usage, ['processedCells', 'additionalRasterReads', 'milliseconds']);
  require(report.usage.processedCells === total && report.usage.additionalRasterReads === 0 && nonnegative(report.usage.milliseconds));
  const statuses = ['valid', 'null', 'noData', 'nan', 'missing', 'invalid'], counts = Object.fromEntries(['surface', 'terrain']
    .map(role => [role, Object.fromEntries(statuses.map(status => [`${status}Cells`, 0]))])), corners = new Map();
  let paired = 0, min = null, max = null, mean = null, negative = 0, positivePairs = 0, zero = 0;
  const retainCorner = (column, row, point) => {
    require(coordinate(point)); const key = `${column}:${row}`;
    if (surface.source.projection === 'EPSG:4326') {
      const [x, y, dx, dy] = effectiveGrid(surface.source);
      require(Math.abs(point[0] - (x + column * dx)) <= 1e-10 && Math.abs(point[1] - (y + row * dy)) <= 1e-10);
    }
    if (corners.has(key)) require(equal(corners.get(key), point)); else corners.set(key, point);
  };
  features.forEach((feature, index) => {
    keys(feature, ['type', 'geometry', 'properties']); require(feature.type === 'Feature');
    keys(feature.geometry, ['type', 'coordinates']); const rings = feature.geometry.coordinates;
    require(feature.geometry.type === 'Polygon' && Array.isArray(rings) && rings.length === 1
      && Array.isArray(rings[0]) && rings[0].length === 5 && rings[0].every(coordinate) && equal(rings[0][0], rings[0][4]));
    const cell = feature.properties;
    keys(cell, ['column', 'row', 'surfaceRawValue', 'terrainRawValue', 'surfaceMeters', 'terrainMeters', 'surfaceStatus', 'terrainStatus', 'pairStatus', 'differenceMeters']);
    const column = index % width, row = Math.floor(index / width); require(cell.column === column && cell.row === row);
    [[column, row], [column + 1, row], [column + 1, row + 1], [column, row + 1]]
      .forEach(([x, y], corner) => retainCorner(x, y, rings[0][corner]));
    require(positive(polygonMeasurementMetrics(rings[0].slice(0, 4)).areaSquareMeters));
    for (const role of ['surface', 'terrain']) {
      const raw = cell[`${role}RawValue`], meters = cell[`${role}Meters`], status = cell[`${role}Status`], input = report.inputs[role];
      require(statuses.includes(status)); counts[role][`${status}Cells`]++;
      require(raw === null || Number.isFinite(raw));
      if (status === 'valid') require(raw !== null && raw !== input.source.noData && Number.isFinite(meters) && meters === raw * input.metersPerUnit);
      else {
        require(meters === null);
        if (status === 'noData') require(raw !== null && raw === input.source.noData);
        else if (status === 'invalid') require(raw === null || !Number.isFinite(raw * input.metersPerUnit));
        else require(raw === null);
      }
    }
    const valid = cell.surfaceStatus === 'valid' && cell.terrainStatus === 'valid';
    require(cell.pairStatus === (valid ? 'valid' : 'excluded'));
    if (!valid) {require(cell.differenceMeters === null); return;}
    const difference = cell.surfaceMeters - cell.terrainMeters;
    require(Number.isFinite(difference) && cell.differenceMeters === difference); paired++;
    min = min === null ? difference : Math.min(min, difference); max = max === null ? difference : Math.max(max, difference);
    mean = paired === 1 ? difference : mean * (1 - 1 / paired) + difference / paired;
    if (difference < 0) negative++; else if (difference > 0) positivePairs++; else zero++;
  });
  require(equal(cornerCoordinates, [[0, 0], [width, 0], [width, height], [0, height]].map(([x, y]) => corners.get(`${x}:${y}`))));
  require(equal(report.coverage, {totalCells: total, validPairs: paired, excludedPairs: total - paired, inputStatus: counts}));
  require(equal(report.statistics, {minimumMeters: min, maximumMeters: max, meanMeters: mean, negativeCells: negative, zeroCells: zero, positiveCells: positivePairs}));
  const inputs = structuredClone(report.inputs), summary = {
    schemaVersion: 'opengeo.cached-raster-height-difference-summary.1.0.0', reportSchemaVersion: report.schemaVersion,
    ...pick(report, ['status', 'scope', 'inputs', 'coverage', 'statistics', 'review', 'map', 'method', 'outputRights', 'outputCustody', 'limitations', 'usage'])
  }, attributions = [...new Set(Object.values(inputs).map(input => input.source.reference.attribution).filter(Boolean))];
  return {kind: 'rasterHeightDifference', operation: 'raster-height-difference', report, inputs, summary,
    source: {attribution: attributions.join('\n') || null, license: null}};
}

/** Samples and append-only review events stay in the exact original once. The
 * shared source validator retains file-version/reference facts without turning
 * them into native feature generations or authenticating their declarations. */
function rasterValidationEvidence(features, report) {
  assertRasterValidationAssessment(report);
  const complete = rasterValidationGeoJson(report);
  require(equal(complete.features, features));
  const {plan} = report;
  const input = validateInput(plan.input, plan.scope.width, plan.scope.height);
  const {uniqueCells, reviewedCells, unresolvedCells, unreviewedCells} = rasterValidationReviewState(report);
  const summary = {
    schemaVersion: 'opengeo.cached-raster-validation-summary.1.0.0', reportSchemaVersion: report.schemaVersion,
    status: report.status,
    plan: pick(plan, ['schemaVersion', 'id', 'scope', 'criteria', 'coverage', 'strata', 'method', 'limitations', 'usage']),
    inputs: {input}, reviewCounts: {events: report.reviews.length, uniqueCells: uniqueCells.length, reviewedCells, unresolvedCells, unreviewedCells},
    estimates: report.estimates === null ? null : {...pick(report.estimates, ['classAreas', 'overallAgreement', 'confidence']),
      classCount: report.estimates.classes.length, confusionCount: report.estimates.confusion.length},
    quality: structuredClone(report.quality), limitations: structuredClone(report.limitations),
    outputRights: structuredClone(report.outputRights)
  };
  return {kind: 'rasterValidation', operation: 'raster-validate', report, inputs: {input}, summary,
    source: {attribution: input.source.reference.attribution, license: null}};
}

/** Full tables/crosswalks remain once in original GeoJSON, with an exact pointer. */
export function archivedRasterAnalysisReceipt(evidence, {distributionId, sha256} = {}) {
  const match = typeof distributionId === 'string' && /^urn:opengeo:dataset:([^:]+):version:([^:]+):original$/.exec(distributionId);
  require(match && UUID.test(match[1]) && UUID.test(match[2]) && typeof sha256 === 'string' && SHA.test(sha256));
  require(evidence && ['rasterComparison', 'rasterPatches', 'rasterValidation', 'rasterHeightDifference'].includes(evidence.kind) && plain(evidence.summary));
  return {operation: evidence.operation, persisted: false, crs: 'CRS:84', [evidence.kind]: {...structuredClone(evidence.summary),
    audit: {distributionId, jsonPointer: `/properties/opengeo:analysis/${evidence.kind}`, sha256, checksumMethod: 'opengeo-canonical-json-sha256'}}};
}

/** Call only after the existing authorized exact-original download. No source reads. */
export async function verifyRasterAnalysisArchive(bytes, {objectSha256, reference} = {}) {
  require(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= MAX_BYTES
    && typeof objectSha256 === 'string' && SHA.test(objectSha256));
  require(await sha256Hex(new Blob([bytes])) === objectSha256);
  let collection;
  try {collection = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));} catch {fail();}
  require(plain(collection?.properties) && plain(reference) && plain(reference.audit));
  const receipt = collection.properties['opengeo:analysis'];
  const evidence = rasterAnalysisEvidence({...collection, 'opengeo:analysis': receipt});
  require(evidence !== null);
  if (evidence.kind === 'rasterValidation') await verifyRasterValidationPlanIdentity(evidence.report);
  const summary = archivedRasterAnalysisReceipt(evidence, reference.audit)[evidence.kind];
  require(equal(summary, reference) && await sha256Hex(new Blob([canonicalJson(evidence.report)])) === reference.audit.sha256);
  return structuredClone({receipt, collection});
}

function boundedJson(value) {
  const stack = [[value, 0]], seen = new Set(); let nodes = 0;
  while (stack.length) {
    const [item, depth] = stack.pop(); require(++nodes <= 150_000 && depth <= 24);
    if (item && typeof item === 'object') {
      require(!seen.has(item) && (Array.isArray(item) || plain(item))); seen.add(item);
      for (const child of Object.values(item)) stack.push([child, depth + 1]);
    } else require(item === null || typeof item === 'boolean' || typeof item === 'string' || typeof item === 'number' && Number.isFinite(item));
  }
  require(encoder.encode(JSON.stringify(value)).byteLength <= MAX_BYTES);
}

function validateStoredRasterSource(input, width, height) {
  require(Number.isSafeInteger(input.band) && input.band > 0);
  keys(input.pins, ['layerId', 'sourceType', 'datasetId', 'datasetVersionId', 'sourceVersion', 'objectId']);
  const pins = input.pins;
  require((pins.layerId === null || text(pins.layerId, 160) && pins.layerId.trim())
    && (pins.sourceType === null || ['cog-raster', 'governed-dataset'].includes(pins.sourceType))
    && ['datasetId', 'datasetVersionId', 'objectId'].every(key => pins[key] === null || typeof pins[key] === 'string' && UUID.test(pins[key]))
    && (pins.sourceVersion === null || Number.isSafeInteger(pins.sourceVersion) && pins.sourceVersion > 0));
  keys(input.source, ['imageIndex', 'projection', 'scaleX', 'scaleY', 'window', 'origin', 'resolution', 'interpretation', 'noData', 'reference']);
  const source = input.source;
  require(count(source.imageIndex) && text(source.projection) && source.projection.trim() && positive(source.scaleX) && positive(source.scaleY)
    && Array.isArray(source.window) && source.window.length === 4 && source.window.every(value => Number.isSafeInteger(value) && value >= 0)
    && source.window[2] - source.window[0] === width && source.window[3] - source.window[1] === height
    && vector(source.origin) && vector(source.resolution) && source.resolution.slice(0, 2).every(value => value !== 0)
    && source.interpretation === 'area' && (source.noData === null || source.noData === 'NaN' || Number.isFinite(source.noData)));
  keys(source.reference, ['url', 'etag', 'size', 'verified', 'license', 'attribution']);
  const reference = source.reference;
  require(typeof reference.verified === 'boolean' && nullableText(reference.etag, 1024)
    && (reference.size === null || Number.isSafeInteger(reference.size) && reference.size > 0)
    && nullableText(reference.license, 4096) && nullableText(reference.attribution, 4096));
  require(!reference.verified || text(reference.etag, 1024) && reference.etag.trim() && reference.size !== null);
  if (reference.url !== null) {
    require(text(reference.url, 4096)); let url;
    try {url = new URL(reference.url);} catch {fail();}
    require(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash);
  }
  // Partial managed facts remain recorded, but never become an invented generation.
  require(pins.datasetId && pins.datasetVersionId || reference.url !== null);
  return {pins, source, reference};
}

function validateInput(input, width, height) {
  keys(input, ['band', 'source', 'pins', 'interpretation', 'sourcePeriod', 'periodAuthority', 'nativeProfile']);
  const {pins, source, reference} = validateStoredRasterSource(input, width, height);
  keys(input.interpretation, ['classification', 'period', 'crosswalk']);
  require(nullableText(input.interpretation.classification, 200)); datePeriod(input.interpretation.period); datePeriod(input.sourcePeriod);
  const crosswalk = input.interpretation.crosswalk;
  require(plain(crosswalk) && Object.keys(crosswalk).length <= 256);
  for (const [code, group] of Object.entries(crosswalk)) require(/^-?(0|[1-9]\d*)$/.test(code) && Number.isSafeInteger(Number(code))
    && String(Number(code)) === code && text(group, 160) && group && group === group.trim().normalize('NFC'));
  const profile = input.band === 1 ? worldCoverProfileForUrl(reference.url) : null;
  if (profile) {
    const expected = {...pick(profile, ['id', 'title', 'version', 'observationPeriod', 'resolutionMeters', 'crs', 'band', 'license', 'attribution', 'classMeanings', 'evidenceUrls', 'limitations']),
      identityAuthority: 'published-url-profile; actual-coverage-and-accuracy-not-verified'};
    require(equal(input.nativeProfile, expected) && input.periodAuthority === 'published-source-profile' && equal(input.sourcePeriod, profile.observationPeriod));
  } else require(input.nativeProfile === null && input.periodAuthority === 'user-supplied-unverified' && equal(input.sourcePeriod, input.interpretation.period));
  return {band: input.band, pins: structuredClone(pins), source: structuredClone(source), sourcePeriod: structuredClone(input.sourcePeriod),
    periodAuthority: input.periodAuthority, interpretation: {classification: input.interpretation.classification,
      period: structuredClone(input.interpretation.period), crosswalkEntries: Object.keys(crosswalk).length},
    nativeProfile: profile ? pick(profile, ['id', 'title', 'version', 'observationPeriod', 'resolutionMeters', 'crs', 'band', 'license', 'attribution']) : null,
    missingFacts: ['datasetId', 'datasetVersionId', 'sourceVersion', 'objectId'].filter(key => pins[key] === null)
      .concat(['url', 'etag', 'size'].filter(key => reference[key] === null).map(key => `reference.${key}`))};
}

function partition(value, names, totalCells, totalArea) {
  require(names.every(name => count(value[`${name}Cells`]) && nonnegative(value[`${name}AreaSquareMeters`])
    && (value[`${name}Cells`] === 0) === (value[`${name}AreaSquareMeters`] === 0)));
  require(names.reduce((sum, name) => sum + value[`${name}Cells`], 0) === totalCells
    && close(names.reduce((sum, name) => sum + value[`${name}AreaSquareMeters`], 0), totalArea));
}

function validateComparison(report, total) {
  const c = report.coverage;
  keys(c, ['totalCells', 'totalAreaSquareMeters', ...['pairedMapped', 'excluded', 'changed', 'unchanged'].flatMap(name => [`${name}Cells`, `${name}AreaSquareMeters`]), 'inputStatus']);
  require(c.totalCells === total && positive(c.totalAreaSquareMeters));
  partition(c, ['pairedMapped', 'excluded'], total, c.totalAreaSquareMeters);
  partition(c, ['changed', 'unchanged'], c.pairedMappedCells, c.pairedMappedAreaSquareMeters);
  keys(c.inputStatus, ['before', 'after']);
  for (const status of Object.values(c.inputStatus)) {
    keys(status, ['mapped', 'noData', 'unclassified', 'unmapped'].flatMap(name => [`${name}Cells`, `${name}AreaSquareMeters`]));
    partition(status, ['mapped', 'noData', 'unclassified', 'unmapped'], total, c.totalAreaSquareMeters);
    require(status.mappedCells >= c.pairedMappedCells);
  }
  require(Array.isArray(report.transitions) && report.transitions.length <= 4096);
  const seen = new Set(); let paired = 0, changed = 0, raw = 0, pairedArea = 0, changedArea = 0;
  for (const row of report.transitions) {
    keys(row, ['beforeCode', 'afterCode', 'beforeMeaning', 'afterMeaning', 'beforeGroup', 'afterGroup', 'cells', 'areaSquareMeters', 'changed']);
    require(count(row.cells) && row.cells > 0 && positive(row.areaSquareMeters));
    for (const role of ['before', 'after']) {
      const code = row[`${role}Code`], input = report.inputs[role]; require(Number.isSafeInteger(code));
      require(row[`${role}Group`] === (input.interpretation.crosswalk[String(code)] ?? null)
        && row[`${role}Meaning`] === (input.nativeProfile?.classMeanings[String(code)] ?? null));
    }
    const key = `${row.beforeCode}:${row.afterCode}`; require(!seen.has(key)); seen.add(key);
    const mapped = row.beforeGroup !== null && row.afterGroup !== null;
    require(row.changed === (mapped ? row.beforeGroup !== row.afterGroup : null));
    raw += row.cells;
    if (mapped) {paired += row.cells; pairedArea += row.areaSquareMeters;}
    if (row.changed) {changed += row.cells; changedArea += row.areaSquareMeters;}
  }
  require(raw <= total && paired === c.pairedMappedCells && changed === c.changedCells
    && close(pairedArea, c.pairedMappedAreaSquareMeters) && close(changedArea, c.changedAreaSquareMeters));
  const m = report.method;
  keys(m, ['id', 'version', 'area', 'areaUnit', 'radiusMeters', 'classification', 'groupNormalization', 'pairedCoverage', 'excludedCoverage', 'changed', 'rawTransitions',
    'alignment', 'resampling', 'aoiClipping', 'partialCells', 'displayTransparency', 'criteria']);
  require(m.id === 'paired-categorical-cell-corner-comparison' && m.version === '1.0.0' && m.areaUnit === 'square-meter'
    && m.area === 'mean-sphere-geodesic-cell-corner-polygons' && m.radiusMeters === EARTH_RADIUS && m.resampling === 'none'
    && m.aoiClipping === 'none' && m.partialCells === 'not-applied' && m.displayTransparency === 'ignored'
    && m.classification === 'explicit-native-safe-integer-code-crosswalks' && m.groupNormalization === 'trimmed-unicode-NFC-case-sensitive'
    && m.pairedCoverage === 'both-codes-mapped' && m.excludedCoverage === 'either-input-noData-unclassified-or-unmapped'
    && m.changed === 'paired-mapped-normalized-groups-differ' && m.rawTransitions === 'all-safe-integer-code-pairs-including-unmapped');
  require(equal(m.alignment, {projection: 'identical', grid: 'matching-effective-projected-origin-and-resolution', everyCellCorner: true,
    toleranceDegrees: 1e-10, dimensions: 'horizontal-XY; optional-third-source-axis-retained-not-used'}));
  keys(m.criteria, ['categoricalConfirmed', 'methodReview']); require(equal(m.criteria.categoricalConfirmed, {before: true, after: true}));
  keys(m.criteria.methodReview, ['confirmed', 'basis']);
  const review = m.criteria.methodReview;
  require(typeof review.confirmed === 'boolean' && text(review.basis, 500) && review.basis === review.basis.trim() && (!review.confirmed || review.basis));
  keys(report.comparability, ['status', 'periodOrder', 'algorithmCompatibility', 'basis', 'changeInterpretation']);
  const a = report.inputs.before.sourcePeriod, b = report.inputs.after.sourcePeriod;
  const order = !a || !b ? 'missing' : a.end < b.start ? 'ordered' : b.end < a.start ? 'reversed' : 'overlapping';
  const incompatible = Object.values(report.inputs).some(input => /\/v100\/2020\/map\/ESA_WorldCover_10m_2020_v100_/.test(input.source.reference.url ?? ''))
    && Object.values(report.inputs).some(input => input.nativeProfile !== null);
  require(report.comparability.periodOrder === order && report.comparability.basis === review.basis
    && report.comparability.algorithmCompatibility === (incompatible ? 'known-incompatible' : review.confirmed ? 'user-confirmed' : 'not-established')
    && report.comparability.status === (incompatible ? 'known-incompatible' : order === 'ordered' && review.confirmed ? 'declared-comparable' : 'not-established')
    && text(report.comparability.changeInterpretation, 1000));
  keys(report.usage, ['processedCells', 'additionalRasterReads', 'milliseconds']);
  require(report.usage.processedCells === total && report.usage.additionalRasterReads === 0 && nonnegative(report.usage.milliseconds)
    && report.outputCustody === 'locally-created-derived-summary');
  if (report.referenceEvaluation) validateEvaluation(report);
}

function validateEvaluation(report) {
  const e = report.referenceEvaluation, c = report.coverage;
  keys(e, ['schemaVersion', 'status', 'roles', 'basis', 'scope', 'overall', 'classes', 'confusion', 'method', 'quality', 'limitations']);
  require(e.schemaVersion === 'opengeo.categorical-reference-agreement.1.0.0' && e.status === 'complete' && text(e.basis, 500) && e.basis.trim());
  keys(e.roles, ['reference', 'candidate']); require(['before', 'after'].includes(e.roles.reference) && e.roles.candidate === (e.roles.reference === 'before' ? 'after' : 'before'));
  require(equal(e.scope, {kind: 'paired-loaded-grid-mapped-cells', fullDataset: false, totalCells: c.totalCells, pairedCells: c.pairedMappedCells, excludedCells: c.excludedCells}));
  const ratio = (n, d) => d > 0 ? n / d : null;
  require(equal(e.overall, {pairedCells: c.pairedMappedCells, matchedCells: c.unchangedCells, disagreedCells: c.changedCells,
    agreementFraction: ratio(c.unchangedCells, c.pairedMappedCells)}));
  const classes = new Map(), confusion = new Map();
  for (const input of Object.values(report.inputs)) for (const group of Object.values(input.interpretation.crosswalk)) classes.set(group, {group, referenceCells: 0, candidateCells: 0, matchedCells: 0});
  for (const row of report.transitions) if (row.changed !== null) {
    const referenceGroup = row[`${e.roles.reference}Group`], candidateGroup = row[`${e.roles.candidate}Group`];
    classes.get(referenceGroup).referenceCells += row.cells; classes.get(candidateGroup).candidateCells += row.cells;
    if (referenceGroup === candidateGroup) classes.get(referenceGroup).matchedCells += row.cells;
    const key = JSON.stringify([referenceGroup, candidateGroup]);
    confusion.set(key, {referenceGroup, candidateGroup, cells: (confusion.get(key)?.cells ?? 0) + row.cells});
  }
  const expected = [...classes.values()].map(row => ({...row, precision: ratio(row.matchedCells, row.candidateCells), recall: ratio(row.matchedCells, row.referenceCells),
    f1: ratio(2 * row.matchedCells, row.referenceCells + row.candidateCells), iou: ratio(row.matchedCells, row.referenceCells + row.candidateCells - row.matchedCells),
    countDifference: row.candidateCells - row.referenceCells}));
  require(Array.isArray(e.classes) && e.classes.length === expected.length && e.classes.every(row => expected.some(value => equal(row, value)))
    && new Set(e.classes.map(row => row.group)).size === expected.length
    && Array.isArray(e.confusion) && e.confusion.length === confusion.size && e.confusion.every(row => equal(row, confusion.get(JSON.stringify([row.referenceGroup, row.candidateGroup])) ?? null))
    && new Set(e.confusion.map(row => JSON.stringify([row.referenceGroup, row.candidateGroup]))).size === confusion.size);
  require(equal(e.quality, {referenceQuality: 'unknown', classificationAccuracy: null, uncertainty: null}));
  require(equal(e.method, {id: 'crosswalk-group-reference-agreement', version: '1.0.0', weighting: 'equal-cached-cell-counts', derivedFrom: 'existing-raw-code-transitions',
    population: 'paired-mapped-cached-cells-only', classInventory: 'union-of-all-declared-crosswalk-groups-including-absent-groups', orientation: 'rows-reference; columns-candidate',
    referenceAuthority: 'user-designated-unverified', zeroDenominators: 'null', precision: 'matched/candidate', recall: 'matched/reference', f1: '2*matched/(reference+candidate)',
    iou: 'matched/(reference+candidate-matched)', countDifference: 'candidate-reference', agreementFraction: 'matched/paired-mapped'}));
  strings(e.limitations);
}

function validatePatches(report, total) {
  const c = report.coverage, names = ['target', 'mappedOther', 'noData', 'unclassified', 'unmapped'];
  keys(c, ['totalCells', 'totalAreaSquareMeters', ...names.flatMap(name => [`${name}Cells`, `${name}AreaSquareMeters`]), 'mappedCells', 'mappedAreaSquareMeters']);
  require(c.totalCells === total && positive(c.totalAreaSquareMeters)); partition(c, names, total, c.totalAreaSquareMeters);
  require(c.mappedCells === c.targetCells + c.mappedOtherCells && close(c.mappedAreaSquareMeters, c.targetAreaSquareMeters + c.mappedOtherAreaSquareMeters));
  keys(report.criteria, ['group', 'connectivity', 'basis']);
  require(Object.values(report.input.interpretation.crosswalk).includes(report.criteria.group) && [4, 8].includes(report.criteria.connectivity)
    && text(report.criteria.basis, 500) && report.criteria.basis.trim() && report.criteria.basis === report.criteria.basis.trim());
  const edgeFields = ['observedOtherGroupEdgeMeters', 'missingEdgeMeters', 'windowEdgeMeters'];
  require(Array.isArray(report.patches) && report.patches.length > 0 && report.patches.length <= 4096);
  let cells = 0, area = 0; const edges = Object.fromEntries(edgeFields.map(key => [key, 0]));
  for (const [index, patch] of report.patches.entries()) {
    keys(patch, ['id', 'cells', 'areaSquareMeters', ...edgeFields, 'touchesWindowBoundary', 'touchesMissingData']);
    require(patch.id === `patch-${index + 1}` && count(patch.cells) && patch.cells > 0 && positive(patch.areaSquareMeters)
      && edgeFields.every(key => nonnegative(patch[key])) && patch.touchesWindowBoundary === (patch.windowEdgeMeters > 0)
      && patch.touchesMissingData === (patch.missingEdgeMeters > 0));
    cells += patch.cells; area += patch.areaSquareMeters; for (const key of edgeFields) edges[key] += patch[key];
  }
  require(cells === c.targetCells && close(area, c.targetAreaSquareMeters));
  const s = report.summary, largest = Math.max(...report.patches.map(patch => patch.areaSquareMeters));
  keys(s, ['patchCount', 'targetCells', 'targetAreaSquareMeters', 'largestPatchAreaSquareMeters', 'meanPatchAreaSquareMeters', 'largestPatchShareOfTarget', 'patchesPer100HectaresOfMappedArea', ...edgeFields]);
  require(s.patchCount === report.patches.length && s.targetCells === cells && close(s.targetAreaSquareMeters, area)
    && close(s.largestPatchAreaSquareMeters, largest) && close(s.meanPatchAreaSquareMeters, area / s.patchCount)
    && close(s.largestPatchShareOfTarget, largest / area) && close(s.patchesPer100HectaresOfMappedArea, s.patchCount * 1_000_000 / c.mappedAreaSquareMeters)
    && edgeFields.every(key => close(s[key], edges[key])));
  const m = report.method;
  keys(m, ['id', 'version', 'area', 'areaUnit', 'radiusMeters', 'edgeUnit', 'edges', 'connectivity', 'patchIdentity', 'classification', 'groupNormalization',
    'densityDenominator', 'densityAreaUnit', 'edgeAccounting', 'externalConnectivity', 'resampling', 'aoiClipping', 'dissolve', 'partialCells', 'displayTransparency']);
  require(m.id === 'crosswalk-group-cached-cell-patches' && m.version === '1.0.0' && m.area === 'mean-sphere-geodesic-cell-corner-polygons'
    && m.areaUnit === 'square-meter' && m.radiusMeters === EARTH_RADIUS && m.edgeUnit === 'meter' && m.edges === 'mean-sphere-great-circle-cardinal-cell-edges'
    && m.connectivity === report.criteria.connectivity && m.patchIdentity === 'first-row-major-unlabelled-target-seed'
    && m.classification === 'explicit-native-safe-integer-code-crosswalk' && m.groupNormalization === 'trimmed-unicode-NFC-case-sensitive'
    && m.densityDenominator === 'mapped-target-plus-mapped-other-area' && m.densityAreaUnit === '100-hectares (1,000,000 square meters)'
    && m.externalConnectivity === 'unknown' && m.resampling === 'none' && m.aoiClipping === 'none' && m.dissolve === 'none'
    && m.partialCells === 'not-applied' && m.displayTransparency === 'ignored');
  require(equal(m.edgeAccounting, {observedOtherGroup: 'target-to-cardinal-mapped-other', missing: 'target-to-cardinal-noData-unclassified-or-unmapped',
    window: 'target-to-outside-cached-window', targetShared: 'zero-including-eight-neighbor-connectivity'}));
  keys(report.usage, ['processedCells', 'componentVisitedCells', 'additionalRasterReads', 'typedWorkspaceBytes', 'totalJavaScriptHeapBytes', 'milliseconds']);
  require(report.usage.processedCells === total && report.usage.componentVisitedCells === cells && report.usage.additionalRasterReads === 0
    && report.usage.typedWorkspaceBytes === 17 * total && report.usage.totalJavaScriptHeapBytes === null && nonnegative(report.usage.milliseconds));
}

function effectiveGrid(source) {
  const step = [source.resolution[0] * source.scaleX, source.resolution[1] * source.scaleY];
  return [source.origin[0] + source.window[0] * step[0], source.origin[1] + source.window[1] * step[1], ...step];
}
function closeGrid(a, b) {return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Number.EPSILON * 16 * Math.max(1, Math.abs(a), Math.abs(b));}

function validateFeatures(features, report, comparison) {
  const input = comparison ? report.inputs.before : report.input, grid = effectiveGrid(input.source), vertices = new Map(), totals = new Map();
  const expected = comparison ? new Map(report.transitions.filter(row => row.changed).map(row => [`${row.beforeCode}:${row.afterCode}`, row]))
    : new Map(report.patches.map(row => [row.id, row]));
  const {width, height, cornerCoordinates} = report.scope;
  let lastIndex = -1;
  for (const feature of features) {
    keys(feature, ['type', 'geometry', 'properties']); keys(feature.geometry, ['type', 'coordinates']);
    const p = feature.properties;
    keys(p, comparison ? ['column', 'row', 'beforeCode', 'afterCode', 'beforeMeaning', 'afterMeaning', 'beforeGroup', 'afterGroup', 'areaSquareMeters', 'changed']
      : ['patchId', 'code', 'meaning', 'group', 'row', 'column', 'areaSquareMeters']);
    const index = p.row * width + p.column;
    require(feature.type === 'Feature' && feature.geometry.type === 'Polygon' && count(p.row) && p.row < height && count(p.column) && p.column < width
      && index > lastIndex && positive(p.areaSquareMeters)); lastIndex = index;
    const rings = feature.geometry.coordinates;
    require(Array.isArray(rings) && rings.length === 1 && Array.isArray(rings[0]) && rings[0].length === 5 && rings[0].every(coordinate)
      && equal(rings[0][0], rings[0][4]));
    require(close(polygonMeasurementMetrics(rings[0]).areaSquareMeters, p.areaSquareMeters));
    for (const [position, [dx, dy]] of [[0, [0, 0]], [1, [1, 0]], [2, [1, 1]], [3, [0, 1]]]) {
      const x = p.column + dx, y = p.row + dy, point = rings[0][position], key = `${x}:${y}`;
      if (vertices.has(key)) require(equal(vertices.get(key), point)); else vertices.set(key, point);
      const corner = x === 0 && y === 0 ? 0 : x === width && y === 0 ? 1 : x === width && y === height ? 2 : x === 0 && y === height ? 3 : -1;
      if (corner >= 0) require(equal(cornerCoordinates[corner], point));
      // Native geographic grids expose exact cell coordinates without loading a
      // projection runtime. Other supported grids retain shared-corner and area checks.
      if (input.source.projection === 'EPSG:4326') require(Math.abs(point[0] - (grid[0] + x * grid[2])) <= 1e-10
        && Math.abs(point[1] - (grid[1] + y * grid[3])) <= 1e-10);
    }
    const id = comparison ? `${p.beforeCode}:${p.afterCode}` : p.patchId, row = expected.get(id);
    require(row !== undefined);
    if (comparison) require(p.changed === true && ['beforeCode', 'afterCode', 'beforeMeaning', 'afterMeaning', 'beforeGroup', 'afterGroup'].every(key => p[key] === row[key]));
    else require(Number.isSafeInteger(p.code) && p.group === report.criteria.group
      && p.group === report.input.interpretation.crosswalk[String(p.code)] && p.meaning === (report.input.nativeProfile?.classMeanings[String(p.code)] ?? null));
    const total = totals.get(id) ?? {cells: 0, area: 0}; total.cells++; total.area += p.areaSquareMeters; totals.set(id, total);
  }
  require(expected.size === totals.size);
  for (const [id, row] of expected) require(totals.get(id)?.cells === row.cells && close(totals.get(id)?.area, row.areaSquareMeters));
}
