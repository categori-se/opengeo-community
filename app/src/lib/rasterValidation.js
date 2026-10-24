import {polygonMeasurementMetrics} from './areaMeasurement.js';
import {meanRadiusMeters, spatialBodyDefinition} from './spatialBody.js';
import {canonicalJson} from './artifactCanonicalJson.js';
import {sha256Hex} from './managedUpload.js';
import {prepareCategoricalRasterInput, classifyCategoricalRasterCell, validateCachedRasterGrid,
  normalizeCategoricalRasterPins} from './rasterComparison.js';

export const RASTER_VALIDATION_LIMITS = Object.freeze({cells: 1_048_576, strata: 16, referenceClasses: 32,
  draws: 512, drawsPerStratum: 128, reviewEvents: 2048, exportBytes: 1_048_576, milliseconds: 10_000,
  typedBytesPerCell: 17});
const PLAN = 'opengeo.cached-raster-validation-plan.1.0.0';
const REPORT = 'opengeo.cached-raster-validation.1.0.0';
const encoder = new TextEncoder(), verified = new WeakSet();
const fail = code => Object.assign(Error(`validation_${code}`), {code: `validation_${code}`});
const require = (ok, code = 'report_invalid') => {if (!ok) throw fail(code);};
const plain = x => x !== null && typeof x === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(x));
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1e-8, Math.abs(b) * 1e-9);
const count = x => Number.isSafeInteger(x) && x >= 0;
const keys = (value, names) => require(plain(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)));
const point = x => Array.isArray(x) && x.length === 2 && x.every(Number.isFinite) && Math.abs(x[0]) <= 180 && Math.abs(x[1]) <= 85.05112878;
const RIGHTS = Object.freeze({status: 'not-established', license: null, accessRights: null,
  statement: 'Input terms do not determine output permissions.'});
const QUALITY = Object.freeze({referenceAuthority: 'user-reviewed-unverified', classificationAccuracy: null,
  referenceInterpretationError: null, temporalAlignment: 'user-assessed-not-verified', areaModelError: null,
  uncertaintyScope: 'sampling-design-conditional'});
const METHOD = Object.freeze({id: 'stratified-area-pps-with-replacement', version: '1.0.0',
  samplingUnit: 'whole-cached-cell', stratification: 'explicit-mapped-crosswalk-group',
  drawProbability: 'cell-area/stratum-area', replacement: true, duplicateDraws: 'retain-multiplicity; one-fixed-reference-label-per-cell',
  randomization: 'SHA-256(seed,NUL,group,NUL,draw-number); 53-bits-from-first-two-digest-words',
  seedIndependence: 'required-before-reference-review; not-verified',
  area: 'mean-sphere-geodesic-cell-corner-polygons', radiusMeters: meanRadiusMeters(spatialBodyDefinition('earth')), areaUnit: 'square-meter',
  estimator: 'Hansen-Hurwitz; sum_h A_h*k_hj/n_h', variance: 'sum_h A_h^2*q_hj*(1-q_hj)/(n_h-1)',
  finitePopulationCorrection: 'none-with-replacement', interval: 'exact-Clopper-Pearson; Bonferroni-H-times-J; sum-area-scaled-bounds',
  confidenceLevel: .95, confidenceScope: 'simultaneous-predeclared-reference-class-areas',
  intervalDerivation: 'PPS/Hansen-Hurwitz substitution plus Clopper-Pearson/Bonferroni; not an Olofsson formula',
  references: ['https://online.stat.psu.edu/stat506/Lesson03',
    'https://www150.statcan.gc.ca/n1/pub/12-001-x/2020002/article/00001/02-eng.htm',
    'https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm',
    'https://itl.nist.gov/div898/handbook/prc/section4/prc473.htm',
    'https://nottingham-repository.worktribe.com/output/728216/good-practices-for-estimating-area-and-assessing-accuracy-of-land-change']});
const LIMITATIONS = Object.freeze([
  'The assessment domain is only the frozen loaded eligible cells. NoData, noncategorical and unmapped cells are excluded explicitly; unloaded source regions are not assessed.',
  'Reference labels describe entire sampled cells under the declared labeling rule, not subpixel cover fractions. Inspect the whole footprint against suitable reference evidence.',
  'Draws are independent with replacement in the declared randomization design. Repeated cells retain every draw and share one fixed latest reference label; distinct reviewed cells and draw counts differ.',
  'Choose the seed before reference review. Redrawing, adapting sample size to observed labels, nonresponse or selectively replacing samples invalidates the stated design.',
  'All selected distinct cells require resolved reference labels before estimation. Ambiguous or missing reviews are retained, never silently omitted.',
  'Intervals are conservative simultaneous 95% bounds for the predeclared reference-class areas, conditional on the sampling design and fixed labels. They exclude reference, temporal, positional and spherical-area-model errors.',
  'Agreement, precision, recall and F1 are conditional point estimates. The class-area intervals are not confidence intervals for those metrics or evidence of independently validated classification accuracy.',
  'Zero observed errors can yield a zero plug-in standard error. Exact binomial bounds retain sampling uncertainty; this does not establish perfect accuracy.',
  'Source and reference permissions, completeness and analytical quality are not established by this assessment.'
]);

function text(value, maximum, code) {
  require(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum, code);
  return value.trim().normalize('NFC');
}
function immutable(value) {
  const copy = structuredClone(value), stack = [copy];
  while (stack.length) {const item = stack.pop(); if (item && typeof item === 'object') {Object.freeze(item); stack.push(...Object.values(item));}}
  return copy;
}
function bounded(value) {
  const stack = [[value, 0, false]], ancestors = new Set(); let nodes = 0;
  while (stack.length) {
    const [item, depth, leaving] = stack.pop();
    if (leaving) {ancestors.delete(item); continue;}
    require(++nodes <= 150_000 && depth <= 24, 'export_limit');
    if (item && typeof item === 'object') {
      // JSON can repeat a shared object. Reject cycles on the current path only,
      // while counting every serialized occurrence against the export limit.
      require(!ancestors.has(item) && (plain(item) || Array.isArray(item)), 'report_invalid'); ancestors.add(item);
      stack.push([item, depth, true]);
      for (const child of Object.values(item)) stack.push([child, depth + 1]);
    } else require(item === null || ['string', 'boolean'].includes(typeof item) || typeof item === 'number' && Number.isFinite(item));
  }
  require(encoder.encode(JSON.stringify(value)).byteLength <= RASTER_VALIDATION_LIMITS.exportBytes, 'export_limit');
}
function accepted(report) {bounded(report); assertRasterValidationAssessment(report); const result = immutable(report); verified.add(result); return result;}
const planIdentity = plan => {const {id, usage, ...identity} = plan; return identity;};
const cellId = (row, column) => `cell-r${row}-c${column}`;

/** One raster-value pass. The second pass visits only the bounded typed workspace. */
export async function createRasterValidationPlan({input, seed, samplesPerStratum, referenceClasses, question,
  labelingProtocol, signal, onProgress = () => {}, yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)),
  now = () => performance.now()} = {}) {
  signal?.throwIfAborted(); const started = now(), prepared = prepareCategoricalRasterInput(input), grid = input.grid;
  validateCachedRasterGrid(grid);
  seed = text(seed, 128, 'seed_required'); question = text(question, 500, 'question_required');
  labelingProtocol = text(labelingProtocol, 1000, 'labeling_protocol_required');
  require(Number.isSafeInteger(samplesPerStratum) && samplesPerStratum >= 2 && samplesPerStratum <= 128, 'allocation_invalid');
  require(Array.isArray(referenceClasses) && referenceClasses.length > 0 && referenceClasses.length <= 32, 'reference_classes_invalid');
  referenceClasses = referenceClasses.map(value => text(value, 160, 'reference_classes_invalid'));
  require(new Set(referenceClasses).size === referenceClasses.length, 'reference_classes_invalid');
  const pinSignature = JSON.stringify(prepared.pins), metadataSignature = JSON.stringify(grid.metadata),
    width = grid.width, height = grid.height, total = width * height;
  const guard = () => {
    signal?.throwIfAborted();
    require(input.grid === grid && input.band === prepared.band && grid.active() && (!input.isCurrent || input.isCurrent())
      && JSON.stringify(normalizeCategoricalRasterPins(input.pins ?? {})) === pinSignature
      && JSON.stringify(grid.metadata) === metadataSignature, 'source_changed');
    require(now() - started < RASTER_VALIDATION_LIMITS.milliseconds, 'compute_limit');
  };
  const corner = (column, row) => {const p = grid.coordinate(column, row, true); require(point(p), 'cell_geometry_unsupported'); return [...p];};
  const weights = new Float64Array(total), codes = new Float64Array(total), groups = new Uint8Array(total); groups.fill(255);
  const strata = [], byGroup = new Map(), status = Object.fromEntries(['mapped', 'noData', 'unclassified', 'unmapped'].flatMap(name => [[`${name}Cells`, 0], [`${name}AreaSquareMeters`, 0]]));
  let totalArea = 0;
  for (let row = 0, at = 0; row < height; row++) {
    let left = corner(0, row), lowerLeft = corner(0, row + 1);
    for (let column = 0; column < width; column++, at++) {
      if (at % 256 === 0) guard();
      const right = corner(column + 1, row), lowerRight = corner(column + 1, row + 1),
        area = polygonMeasurementMetrics([left, right, lowerRight, lowerLeft]).areaSquareMeters;
      require(Number.isFinite(area) && area > 0, 'cell_geometry_unsupported'); totalArea += area;
      const value = classifyCategoricalRasterCell(grid.value(column, row, prepared.band), prepared);
      status[`${value.status}Cells`]++; status[`${value.status}AreaSquareMeters`] += area;
      if (value.status === 'mapped') {
        if (!byGroup.has(value.group)) {
          require(strata.length < 16 && (strata.length + 1) * samplesPerStratum <= 512, 'sample_limit');
          byGroup.set(value.group, strata.length); strata.push({group: value.group, cells: 0, areaSquareMeters: 0, draws: samplesPerStratum});
        }
        const index = byGroup.get(value.group), stratum = strata[index];
        stratum.cells++; stratum.areaSquareMeters += area; weights[at] = area; codes[at] = value.code; groups[at] = index;
      }
      left = right; lowerLeft = lowerRight;
      if ((at + 1) % 2048 === 0) {onProgress({stage: 'frame', processedCells: at + 1, totalCells: total}); await yieldControl(); guard();}
    }
  }
  guard(); require(strata.length > 0, 'no_eligible_cells');
  const targets = [];
  for (const stratum of strata) {
    const draws = [];
    for (let draw = 1; draw <= samplesPerStratum; draw++) {
      const digest = await sha256Hex(new Blob([seed, '\0', stratum.group, '\0', String(draw)])); guard();
      const first = Number.parseInt(digest.slice(0, 8), 16), second = Number.parseInt(digest.slice(8, 16), 16),
        uniform = ((first >>> 5) * 67108864 + (second >>> 6)) / 9007199254740992;
      let target = uniform * stratum.areaSquareMeters;
      if (target >= stratum.areaSquareMeters) target = stratum.areaSquareMeters * (1 - Number.EPSILON);
      draws.push({target, drawNumber: draw});
    }
    targets.push(draws.sort((a, b) => a.target - b.target || a.drawNumber - b.drawNumber));
  }
  const cumulative = new Float64Array(strata.length), next = new Uint16Array(strata.length), selected = [];
  for (let at = 0; at < total; at++) {
    if (at % 256 === 0) guard();
    const h = groups[at]; if (h === 255) continue; cumulative[h] += weights[at];
    while (next[h] < targets[h].length && targets[h][next[h]].target < cumulative[h]) {
      const draw = targets[h][next[h]++], row = Math.floor(at / width), column = at % width;
      selected.push({stratumIndex: h, cellId: cellId(row, column), stratum: strata[h].group, drawNumber: draw.drawNumber,
        code: codes[at], meaning: prepared.nativeProfile?.classMeanings[String(codes[at])] ?? null, row, column,
        areaSquareMeters: weights[at], selectionProbability: weights[at] / strata[h].areaSquareMeters,
        corners: [corner(column, row), corner(column + 1, row), corner(column + 1, row + 1), corner(column, row + 1)]});
    }
    if ((at + 1) % 4096 === 0) {await yieldControl(); guard();}
  }
  require(next.every(value => value === samplesPerStratum), 'sampling_invalid');
  const samples = selected.sort((a, b) => a.stratumIndex - b.stratumIndex || a.drawNumber - b.drawNumber)
    .map(({stratumIndex, ...sample}, index) => ({id: `draw-${String(index + 1).padStart(4, '0')}`, ...sample}));
  const eligibleArea = strata.reduce((sum, stratum) => sum + stratum.areaSquareMeters, 0);
  const plan = {schemaVersion: PLAN, id: null, input: prepared,
    scope: {kind: 'loaded-eligible-whole-cells', fullDataset: false, width, height,
      cornerCoordinates: [corner(0, 0), corner(width, 0), corner(width, height), corner(0, height)]},
    criteria: {seed, samplesPerStratum, referenceClasses, question, labelingProtocol},
    coverage: {totalCells: total, totalAreaSquareMeters: totalArea, eligibleCells: status.mappedCells,
      eligibleAreaSquareMeters: eligibleArea, excludedCells: total - status.mappedCells,
      excludedAreaSquareMeters: status.noDataAreaSquareMeters + status.unclassifiedAreaSquareMeters + status.unmappedAreaSquareMeters,
      inputStatus: status}, strata, samples, method: {...METHOD}, limitations: [...LIMITATIONS],
    usage: {processedCells: total, additionalRasterReads: 0, typedWorkspaceBytes: 17 * total + cumulative.byteLength + next.byteLength,
      totalJavaScriptHeapBytes: null, milliseconds: 0}};
  plan.id = await sha256Hex(new Blob([canonicalJson(planIdentity(plan))])); guard();
  plan.usage.milliseconds = now() - started; bounded(plan); validatePlan(plan); return immutable(plan);
}

export function createRasterValidationAssessment(plan) {
  validatePlan(plan);
  return accepted({schemaVersion: REPORT, status: 'awaiting-reference-review', plan: structuredClone(plan), reviews: [], estimates: null,
    quality: {...QUALITY}, outputRights: {...RIGHTS}, limitations: [...LIMITATIONS]});
}

export function rasterValidationReviewState(report) {
  const unique = new Map(), latest = new Map();
  for (const sample of report.plan.samples) if (!unique.has(sample.cellId)) unique.set(sample.cellId, sample);
  for (const event of report.reviews) latest.set(event.cellId, event);
  let reviewedCells = 0, unresolvedCells = 0;
  for (const id of unique.keys()) {const event = latest.get(id); if (event?.referenceClass != null) reviewedCells++; else if (event) unresolvedCells++;}
  return {uniqueCells: [...unique.values()], reviewedCells, unresolvedCells, unreviewedCells: unique.size - latest.size, latest};
}

/** Decisions append; correcting a label preserves its previous reviewer/evidence. */
export function reviewRasterValidationCell(report, {cellId: id, referenceClass, reviewer, evidence, basis, reviewedAt} = {}) {
  assertRasterValidationAssessment(report);
  require(report.plan.samples.some(sample => sample.cellId === id), 'review_cell_invalid');
  require(referenceClass === null || report.plan.criteria.referenceClasses.includes(referenceClass), 'reference_class_invalid');
  require(report.reviews.length < 2048, 'review_limit');
  require(typeof reviewedAt === 'string' && Number.isFinite(Date.parse(reviewedAt)) && /(?:Z|[+-]\d{2}:\d{2})$/.test(reviewedAt), 'review_time_invalid');
  const event = {sequence: report.reviews.length + 1, cellId: id, referenceClass,
    reviewer: text(reviewer, 160, 'reviewer_required'), evidence: text(evidence, 1000, 'evidence_required'),
    basis: text(basis, 500, 'review_basis_required'), reviewedAt};
  return accepted({...report, status: 'awaiting-reference-review', estimates: null, reviews: [...report.reviews, event]});
}

/** Stable binomial tail sums avoid subtracting a nearly-one CDF. */
function binomialProbability(n, p, from, to) {
  if (p === 0) return from === 0 ? 1 : 0;
  if (p === 1) return to === n ? 1 : 0;
  const terms = []; let combination = 0, maximum = -Infinity;
  for (let k = 0; k <= n; k++) {
    if (k >= from && k <= to) {const log = combination + k * Math.log(p) + (n - k) * Math.log1p(-p); terms.push(log); maximum = Math.max(maximum, log);}
    if (k < n) combination += Math.log(n - k) - Math.log(k + 1);
  }
  return Math.min(1, Math.exp(maximum) * terms.reduce((sum, log) => sum + Math.exp(log - maximum), 0));
}
export function exactBinomialInterval(successes, draws, alpha = .05) {
  require(Number.isSafeInteger(draws) && draws >= 2 && draws <= 512 && count(successes) && successes <= draws
    && Number.isFinite(alpha) && alpha > 0 && alpha < 1, 'interval_invalid');
  const tail = alpha / 2;
  const solve = (from, to, increasing) => {
    let lower = 0, upper = 1;
    for (let i = 0; i < 52; i++) {
      const middle = (lower + upper) / 2, probability = binomialProbability(draws, middle, from, to);
      if ((probability < tail) === increasing) lower = middle; else upper = middle;
    }
    // Outward rounding retains conservative numerical bounds.
    return increasing ? lower : upper;
  };
  return {lower: successes === 0 ? 0 : solve(successes, draws, true),
    upper: successes === draws ? 1 : solve(0, successes, false)};
}

/** Also exported for independent numerical fixtures of the pinned estimator. */
export function estimatePpsStrata({strata, referenceClasses, counts}) {
  require(Array.isArray(strata) && strata.length > 0 && strata.length <= 16 && Array.isArray(referenceClasses)
    && referenceClasses.length > 0 && referenceClasses.length <= 32 && new Set(referenceClasses).size === referenceClasses.length);
  const totalArea = strata.reduce((sum, s) => sum + s.areaSquareMeters, 0), H = strata.length, J = referenceClasses.length;
  require(Number.isFinite(totalArea) && totalArea > 0 && Array.isArray(counts) && counts.length === H);
  const areaRows = referenceClasses.map(referenceClass => ({referenceClass, areaSquareMeters: 0, standardErrorSquareMeters: 0,
    lower95SquareMeters: 0, upper95SquareMeters: 0})), variances = new Float64Array(J), confusion = [];
  for (let h = 0; h < H; h++) {
    const stratum = strata[h], n = stratum.draws;
    require(Number.isSafeInteger(n) && n >= 2 && n <= 128 && Number.isFinite(stratum.areaSquareMeters) && stratum.areaSquareMeters > 0
      && Array.isArray(counts[h]) && counts[h].length === J && counts[h].every(count) && counts[h].reduce((sum, k) => sum + k, 0) === n);
    for (let j = 0; j < J; j++) {
      const k = counts[h][j], q = k / n, area = stratum.areaSquareMeters * q,
        interval = exactBinomialInterval(k, n, .05 / (H * J));
      areaRows[j].areaSquareMeters += area; variances[j] += stratum.areaSquareMeters ** 2 * q * (1 - q) / (n - 1);
      areaRows[j].lower95SquareMeters += stratum.areaSquareMeters * interval.lower;
      areaRows[j].upper95SquareMeters += stratum.areaSquareMeters * interval.upper;
      confusion.push({mappedGroup: stratum.group, referenceClass: referenceClasses[j], draws: k,
        estimatedAreaSquareMeters: area, areaFraction: area / totalArea});
    }
  }
  for (let j = 0; j < J; j++) areaRows[j].standardErrorSquareMeters = Math.sqrt(Math.max(0, variances[j]));
  const ratio = (n, d) => d > 0 ? n / d : null, allGroups = [...new Set([...strata.map(s => s.group), ...referenceClasses])];
  const diagonal = group => confusion.find(row => row.mappedGroup === group && row.referenceClass === group)?.estimatedAreaSquareMeters ?? 0;
  const classes = allGroups.map(group => {
    const matched = diagonal(group), mapped = strata.find(s => s.group === group)?.areaSquareMeters ?? 0,
      reference = areaRows.find(row => row.referenceClass === group)?.areaSquareMeters ?? 0;
    return {group, precision: ratio(matched, mapped), recall: ratio(matched, reference), f1: ratio(2 * matched, mapped + reference)};
  });
  return {classAreas: areaRows, confusion, classes, overallAgreement: allGroups.reduce((sum, group) => sum + diagonal(group), 0) / totalArea,
    confidence: {level: .95, scope: 'simultaneous-predeclared-reference-class-areas', method: 'clopper-pearson-bonferroni', strata: H, classes: J}};
}
function estimateReport(report) {
  const state = rasterValidationReviewState(report); require(state.reviewedCells === state.uniqueCells.length, 'reviews_incomplete');
  const {strata, criteria} = report.plan, counts = strata.map(() => criteria.referenceClasses.map(() => 0));
  const h = new Map(strata.map((s, i) => [s.group, i])), j = new Map(criteria.referenceClasses.map((group, i) => [group, i]));
  for (const sample of report.plan.samples) counts[h.get(sample.stratum)][j.get(state.latest.get(sample.cellId).referenceClass)]++;
  return estimatePpsStrata({strata, referenceClasses: criteria.referenceClasses, counts});
}
export async function evaluateRasterValidationAssessment(report, {signal, onProgress = () => {},
  yieldControl = () => new Promise(resolve => setTimeout(resolve, 0))} = {}) {
  signal?.throwIfAborted(); assertRasterValidationAssessment(report); await yieldControl(); signal?.throwIfAborted();
  const estimates = estimateReport(report); onProgress({stage: 'estimated'}); signal?.throwIfAborted();
  return accepted({...report, status: 'estimated', estimates});
}

function validatePlan(plan) {
  bounded(plan); require(plain(plan) && plan.schemaVersion === PLAN && /^[a-f0-9]{64}$/.test(plan.id ?? ''));
  keys(plan, ['schemaVersion', 'id', 'input', 'scope', 'criteria', 'coverage', 'strata', 'samples', 'method', 'limitations', 'usage']);
  const {scope, criteria, coverage, strata, samples} = plan;
  keys(scope, ['kind', 'fullDataset', 'width', 'height', 'cornerCoordinates']);
  keys(criteria, ['seed', 'samplesPerStratum', 'referenceClasses', 'question', 'labelingProtocol']);
  keys(coverage, ['totalCells', 'totalAreaSquareMeters', 'eligibleCells', 'eligibleAreaSquareMeters', 'excludedCells', 'excludedAreaSquareMeters', 'inputStatus']);
  require(scope?.kind === 'loaded-eligible-whole-cells' && scope.fullDataset === false && count(scope.width) && scope.width > 0
    && count(scope.height) && scope.height > 0 && scope.width * scope.height <= 1_048_576
    && Array.isArray(scope.cornerCoordinates) && scope.cornerCoordinates.length === 4 && scope.cornerCoordinates.every(point));
  require(text(criteria?.seed, 128) === criteria.seed && text(criteria.question, 500) === criteria.question
    && text(criteria.labelingProtocol, 1000) === criteria.labelingProtocol && Number.isSafeInteger(criteria.samplesPerStratum)
    && criteria.samplesPerStratum >= 2 && criteria.samplesPerStratum <= 128 && Array.isArray(criteria.referenceClasses)
    && criteria.referenceClasses.length > 0 && criteria.referenceClasses.length <= 32
    && new Set(criteria.referenceClasses).size === criteria.referenceClasses.length
    && criteria.referenceClasses.every(group => text(group, 160) === group));
  const input = plan.input, fakeGrid = {active: () => true, width: scope.width, height: scope.height,
    coordinate() {}, value() {}, metadata: {...input?.source, bands: [input?.band], source: input?.source?.reference}};
  validateCachedRasterGrid(fakeGrid);
  require(equal(input, prepareCategoricalRasterInput({grid: fakeGrid, band: input.band, categoricalConfirmed: true,
    crosswalk: input.interpretation.crosswalk, classification: input.interpretation.classification,
    periodStart: input.interpretation.period?.start, periodEnd: input.interpretation.period?.end, pins: input.pins})));
  require(Array.isArray(strata) && strata.length > 0 && strata.length <= 16 && new Set(strata.map(s => s.group)).size === strata.length
    && strata.every(s => Object.values(input.interpretation.crosswalk).includes(s.group) && count(s.cells) && s.cells > 0
      && Number.isFinite(s.areaSquareMeters) && s.areaSquareMeters > 0 && s.draws === criteria.samplesPerStratum));
  for (const s of strata) keys(s, ['group', 'cells', 'areaSquareMeters', 'draws']);
  require(coverage.totalCells === scope.width * scope.height && coverage.eligibleCells === strata.reduce((sum, s) => sum + s.cells, 0)
    && close(coverage.eligibleAreaSquareMeters, strata.reduce((sum, s) => sum + s.areaSquareMeters, 0))
    && count(coverage.excludedCells) && coverage.eligibleCells + coverage.excludedCells === coverage.totalCells
    && Number.isFinite(coverage.excludedAreaSquareMeters) && coverage.excludedAreaSquareMeters >= 0
    && close(coverage.eligibleAreaSquareMeters + coverage.excludedAreaSquareMeters, coverage.totalAreaSquareMeters));
  const statuses = ['mapped', 'noData', 'unclassified', 'unmapped'], status = coverage.inputStatus;
  require(plain(status) && statuses.every(name => count(status[`${name}Cells`]) && Number.isFinite(status[`${name}AreaSquareMeters`])
    && status[`${name}AreaSquareMeters`] >= 0 && (status[`${name}Cells`] === 0) === (status[`${name}AreaSquareMeters`] === 0)) && statuses.reduce((sum, name) => sum + status[`${name}Cells`], 0) === coverage.totalCells
    && close(statuses.reduce((sum, name) => sum + status[`${name}AreaSquareMeters`], 0), coverage.totalAreaSquareMeters)
    && status.mappedCells === coverage.eligibleCells && close(status.mappedAreaSquareMeters, coverage.eligibleAreaSquareMeters));
  keys(status, statuses.flatMap(name => [`${name}Cells`, `${name}AreaSquareMeters`]));
  require(Array.isArray(samples) && samples.length === strata.length * criteria.samplesPerStratum && samples.length <= 512);
  const cells = new Map(), drawCounts = new Map();
  for (const [index, sample] of samples.entries()) {
    keys(sample, ['id', 'cellId', 'stratum', 'drawNumber', 'code', 'meaning', 'row', 'column', 'areaSquareMeters', 'selectionProbability', 'corners']);
    const stratum = strata.find(s => s.group === sample.stratum), drawNumber = (drawCounts.get(sample.stratum) ?? 0) + 1;
    require(stratum && sample.id === `draw-${String(index + 1).padStart(4, '0')}` && sample.drawNumber === drawNumber
      && count(sample.row) && sample.row < scope.height && count(sample.column) && sample.column < scope.width
      && sample.cellId === cellId(sample.row, sample.column) && Number.isSafeInteger(sample.code)
      && sample.stratum === input.interpretation.crosswalk[String(sample.code)]
      && sample.meaning === (input.nativeProfile?.classMeanings[String(sample.code)] ?? null)
      && Array.isArray(sample.corners) && sample.corners.length === 4 && sample.corners.every(point)
      && close(polygonMeasurementMetrics(sample.corners).areaSquareMeters, sample.areaSquareMeters)
      && sample.areaSquareMeters > 0 && sample.areaSquareMeters <= stratum.areaSquareMeters * (1 + 1e-9)
      && sample.selectionProbability > 0 && sample.selectionProbability <= 1
      && sample.selectionProbability === sample.areaSquareMeters / stratum.areaSquareMeters);
    const {id, drawNumber: unused, ...cell} = sample;
    if (cells.has(sample.cellId)) require(equal(cells.get(sample.cellId), cell)); else cells.set(sample.cellId, cell);
    drawCounts.set(sample.stratum, drawNumber);
  }
  require(strata.every(s => drawCounts.get(s.group) === s.draws) && equal(plan.method, METHOD) && equal(plan.limitations, LIMITATIONS));
  keys(plan.usage, ['processedCells', 'additionalRasterReads', 'typedWorkspaceBytes', 'totalJavaScriptHeapBytes', 'milliseconds']);
  require(plan.usage?.processedCells === coverage.totalCells && plan.usage.additionalRasterReads === 0
    && plan.usage.typedWorkspaceBytes === 17 * coverage.totalCells + 10 * strata.length && plan.usage.totalJavaScriptHeapBytes === null
    && Number.isFinite(plan.usage.milliseconds) && plan.usage.milliseconds >= 0 && plan.usage.milliseconds < 10_000);
}
export function assertRasterValidationAssessment(report) {
  if (verified.has(report)) return report;
  bounded(report); require(plain(report) && report.schemaVersion === REPORT && ['awaiting-reference-review', 'estimated'].includes(report.status));
  keys(report, ['schemaVersion', 'status', 'plan', 'reviews', 'estimates', 'quality', 'outputRights', 'limitations']);
  validatePlan(report.plan); require(equal(report.quality, QUALITY) && equal(report.outputRights, RIGHTS) && equal(report.limitations, LIMITATIONS));
  require(Array.isArray(report.reviews) && report.reviews.length <= 2048);
  const cells = new Set(report.plan.samples.map(sample => sample.cellId));
  for (const [i, event] of report.reviews.entries()) {
    keys(event, ['sequence', 'cellId', 'referenceClass', 'reviewer', 'evidence', 'basis', 'reviewedAt']);
    require(event.sequence === i + 1 && cells.has(event.cellId)
    && (event.referenceClass === null || report.plan.criteria.referenceClasses.includes(event.referenceClass))
    && text(event.reviewer, 160) === event.reviewer && text(event.evidence, 1000) === event.evidence && text(event.basis, 500) === event.basis
    && typeof event.reviewedAt === 'string' && Number.isFinite(Date.parse(event.reviewedAt)) && /(?:Z|[+-]\d{2}:\d{2})$/.test(event.reviewedAt));
  }
  if (report.status === 'estimated') require(equal(report.estimates, estimateReport(report)));
  else require(report.estimates === null);
  return report;
}
/** The checksum identifies a declared frozen plan; it does not authenticate its
 * sampling population, random seed selection or reference interpretations. */
export async function verifyRasterValidationPlanIdentity(report) {
  assertRasterValidationAssessment(report);
  require(await sha256Hex(new Blob([canonicalJson(planIdentity(report.plan))])) === report.plan.id, 'plan_checksum_invalid');
  return true;
}
export async function parseRasterValidationJson(value) {
  require(typeof value === 'string' && encoder.encode(value).byteLength <= 1_048_576, 'export_limit');
  let report; try {report = JSON.parse(value);} catch {throw fail('report_invalid');}
  assertRasterValidationAssessment(report);
  await verifyRasterValidationPlanIdentity(report);
  return accepted(report);
}
function exportText(value) {require(encoder.encode(value).byteLength <= 1_048_576, 'export_limit'); return value;}
export function rasterValidationJson(report) {assertRasterValidationAssessment(report); return exportText(JSON.stringify(report, null, 2) + '\n');}
export function rasterValidationGeoJson(report) {
  assertRasterValidationAssessment(report); const {latest} = rasterValidationReviewState(report);
  const features = report.plan.samples.map(sample => {
    const review = latest.get(sample.cellId);
    return {type: 'Feature', geometry: {type: 'Polygon', coordinates: [[...sample.corners.map(p => [...p]), [...sample.corners[0]]]]},
      properties: {sampleId: sample.id, cellId: sample.cellId, stratum: sample.stratum, drawNumber: sample.drawNumber,
        code: sample.code, meaning: sample.meaning, areaSquareMeters: sample.areaSquareMeters, selectionProbability: sample.selectionProbability,
        referenceClass: review?.referenceClass ?? null, reviewStatus: !review ? 'unreviewed' : review.referenceClass === null ? 'unresolved' : 'reviewed',
        reviewer: review?.reviewer ?? null, evidence: review?.evidence ?? null, basis: review?.basis ?? null, reviewedAt: review?.reviewedAt ?? null}};
  });
  const collection = {type: 'FeatureCollection', features, 'opengeo:analysis': {rasterValidation: report}};
  // A portable collection owns its JSON values. In-memory aliases in the frozen
  // plan (such as equal declared/source periods) are not shared export objects.
  return JSON.parse(exportText(JSON.stringify(collection)));
}
function csv(value) {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function rasterValidationCsv(report) {
  assertRasterValidationAssessment(report); const {latest} = rasterValidationReviewState(report);
  const rows = [['record_type', 'id', 'mapped_group', 'reference_class', 'draw_number', 'cell_area_m2', 'draw_probability', 'estimated_area_m2', 'standard_error_m2', 'lower_95_m2', 'upper_95_m2', 'reviewer', 'evidence', 'basis', 'reviewed_at', 'context'],
    ['context', report.plan.id, '', '', '', '', '', '', '', '', '', '', '', '', '', {schemaVersion: report.schemaVersion, scope: report.plan.scope,
      criteria: report.plan.criteria, input: report.plan.input, method: report.plan.method, coverage: report.plan.coverage,
      strata: report.plan.strata, confidence: report.estimates?.confidence ?? null, quality: report.quality, outputRights: report.outputRights, limitations: report.limitations}]];
  for (const s of report.plan.samples) {const r = latest.get(s.cellId); rows.push(['draw', s.id, s.stratum, r?.referenceClass, s.drawNumber,
    s.areaSquareMeters, s.selectionProbability, '', '', '', '', r?.reviewer, r?.evidence, r?.basis, r?.reviewedAt, {cellId: s.cellId, row: s.row, column: s.column, code: s.code, meaning: s.meaning, corners: s.corners}]);}
  for (const a of report.estimates?.classAreas ?? []) rows.push(['class_area', '', '', a.referenceClass, '', '', '', a.areaSquareMeters,
    a.standardErrorSquareMeters, a.lower95SquareMeters, a.upper95SquareMeters, '', '', '', '', '']);
  for (const c of report.estimates?.confusion ?? []) rows.push(['confusion', '', c.mappedGroup, c.referenceClass, c.draws, '', '', c.estimatedAreaSquareMeters, '', '', '', '', '', '', '', {areaFraction: c.areaFraction}]);
  return exportText(rows.map(row => row.map(csv).join(',')).join('\n') + '\n');
}
