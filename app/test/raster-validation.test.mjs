import assert from 'node:assert/strict';
import {test} from 'node:test';
import {rasterAnalysisEvidence} from '../src/lib/rasterAnalysisArchive.js';
import {createRasterValidationPlan, createRasterValidationAssessment, reviewRasterValidationCell,
  evaluateRasterValidationAssessment, rasterValidationReviewState, rasterValidationJson, rasterValidationCsv,
  rasterValidationGeoJson, parseRasterValidationJson, assertRasterValidationAssessment,
  verifyRasterValidationPlanIdentity, exactBinomialInterval, estimatePpsStrata} from '../src/lib/rasterValidation.js';

function fixture(values = [[10, 10, 20, null], [10, 20, 20, .5]]) {
  let active = true, reads = 0;
  const grid = {width: values[0].length, height: values.length,
    metadata: {bands: [1], window: [0, 0, values[0].length, values.length], projection: 'EPSG:4326',
      interpretation: 'area', imageIndex: 0, origin: [85, 28, 0], resolution: [.001, -.001, 0], scaleX: 1, scaleY: 1,
      noData: null, source: {url: 'https://example.org/frozen-classes.tif', etag: '"pinned"', size: 4096,
        verified: true, license: 'CC-BY-4.0', attribution: 'Reference fixture provider'}},
    active: () => active, coordinate: (column, row) => [85 + column * .001, 28 - row * .001],
    value(column, row) {reads++; return values[row][column];}};
  const input = {grid, band: 1, categoricalConfirmed: true, classification: 'Declared fixture taxonomy',
    crosswalk: {10: 'Forest', 20: 'Other'}, periodStart: '2021-01-01', periodEnd: '2021-12-31',
    pins: {layerId: 'classes', sourceType: 'cog-raster', datasetId: null, datasetVersionId: null, objectId: null, sourceVersion: null}};
  return {input, grid, get reads() {return reads;}, close() {active = false;}};
}
const parameters = {seed: 'chosen-before-reference-review', samplesPerStratum: 4,
  referenceClasses: ['Forest', 'Other', 'Absent'], question: 'Which whole cells receive each reviewed class?',
  labelingProtocol: 'Interpret the whole sampled footprint under one dominant-class rule; ambiguity remains unresolved.'};
async function plan(f = fixture(), extra = {}) {
  return createRasterValidationPlan({input: f.input, ...parameters, ...extra, yieldControl: async () => {}});
}
const review = (report, cell, referenceClass, extra = {}) => reviewRasterValidationCell(report, {
  cellId: cell.cellId, referenceClass, reviewer: 'Named reviewer', evidence: 'Independent example imagery, observation 2021; synthetic exercise',
  basis: 'Whole-cell labeling rule applied', reviewedAt: '2026-10-23T12:00:00Z', ...extra});

test('PPS freezes only eligible whole cells and records source, scope, design and bounded workspace', async () => {
  const f = fixture(), result = await plan(f);
  assert.equal(f.reads, 8); assert.equal(result.coverage.totalCells, 8); assert.equal(result.coverage.eligibleCells, 6);
  assert.equal(result.coverage.excludedCells, 2); assert.equal(result.coverage.inputStatus.noDataCells, 1);
  assert.equal(result.coverage.inputStatus.unclassifiedCells, 1); assert.equal(result.samples.length, 8);
  assert.equal(result.strata.length, 2); assert.equal(result.usage.additionalRasterReads, 0);
  assert.equal(result.usage.typedWorkspaceBytes, 17 * 8 + 10 * 2); assert.equal(result.usage.totalJavaScriptHeapBytes, null);
  assert.equal(result.scope.fullDataset, false); assert.equal(result.input.source.reference.etag, '"pinned"');
  assert.equal(result.method.replacement, true); assert.equal(result.method.finitePopulationCorrection, 'none-with-replacement');
  for (const sample of result.samples) {
    const stratum = result.strata.find(s => s.group === sample.stratum);
    assert.equal(sample.selectionProbability, sample.areaSquareMeters / stratum.areaSquareMeters);
    assert.equal(sample.corners.length, 4); assert(!['cell-r0-c3', 'cell-r1-c3'].includes(sample.cellId));
  }
  assert(Object.isFrozen(result) && Object.isFrozen(result.samples[0].corners[0]));
  assert.throws(() => {result.samples[0].code = 999;}, TypeError);
  assert.equal(await verifyRasterValidationPlanIdentity(createRasterValidationAssessment(result)), true);
});

test('fixed seed replays draw identities despite runtime timing; a different seed changes draws', async () => {
  const values = [Array(30).fill(10), Array(30).fill(20)];
  const a = await plan(fixture(values)), b = await plan(fixture(values)), c = await plan(fixture(values), {seed: 'different-pre-review-seed'});
  assert.equal(a.id, b.id); assert.deepEqual(a.samples, b.samples); assert.notDeepEqual(a.samples, c.samples);
  assert.notEqual(a.id, c.id);
});

test('with-replacement multiplicity survives one fixed review per distinct cell and later corrections', async () => {
  const f = fixture([[10, 20]]), p = await plan(f, {samplesPerStratum: 8}), original = createRasterValidationAssessment(p);
  assert.equal(p.samples.length, 16); assert.equal(rasterValidationReviewState(original).uniqueCells.length, 2);
  f.close(); f.grid.value = () => assert.fail('Review must never reread the parent grid');
  let report = original;
  for (const cell of rasterValidationReviewState(report).uniqueCells) report = review(report, cell, cell.stratum);
  report = await evaluateRasterValidationAssessment(report);
  assert.equal(report.estimates.overallAgreement, 1); assert.equal(report.estimates.confusion.reduce((sum, row) => sum + row.draws, 0), 16);
  assert.equal(original.reviews.length, 0); assert.equal(report.reviews.length, 2);
  const first = p.samples[0], changed = review(report, first, 'Other', {basis: 'Later interpretation correction retained in history'});
  assert.equal(changed.reviews.length, 3); assert.equal(changed.status, 'awaiting-reference-review'); assert.equal(changed.estimates, null);
  assert.equal(changed.reviews[0].referenceClass, 'Forest'); assert.equal(changed.reviews[2].referenceClass, 'Other');
  const evaluated = await evaluateRasterValidationAssessment(changed);
  assert.equal(evaluated.estimates.confusion.find(r => r.mappedGroup === 'Forest' && r.referenceClass === 'Other').draws, 8);
});

test('unresolved reviews are retained and block full planned assessment rather than become nonresponse omissions', async () => {
  let report = createRasterValidationAssessment(await plan(fixture([[10, 20]])));
  const cells = rasterValidationReviewState(report).uniqueCells;
  report = review(report, cells[0], null, {basis: 'Cloud shadow prevents a defensible reference label'});
  report = review(report, cells[1], 'Other');
  const state = rasterValidationReviewState(report);
  assert.equal(state.unresolvedCells, 1); assert.equal(state.reviewedCells, 1); assert.equal(state.unreviewedCells, 0);
  await assert.rejects(evaluateRasterValidationAssessment(report), /reviews_incomplete/);
  const restored = await parseRasterValidationJson(rasterValidationJson(report));
  assert.deepEqual(restored, report); assert.equal(rasterValidationGeoJson(restored).features[0].properties.reviewStatus, 'unresolved');
});

test('HH area weighting has an independent unequal-stratum numerical golden, not pooled sample fractions', () => {
  const result = estimatePpsStrata({strata: [{group: 'Forest', areaSquareMeters: 100, draws: 10}, {group: 'Other', areaSquareMeters: 300, draws: 10}],
    referenceClasses: ['Forest', 'Other'], counts: [[8, 2], [3, 7]]});
  assert.equal(result.classAreas[0].areaSquareMeters, 170); assert.equal(result.classAreas[1].areaSquareMeters, 230);
  assert.equal(result.overallAgreement, .725); assert.notEqual(result.overallAgreement, 15 / 20);
  assert.deepEqual(result.confusion.map(row => row.estimatedAreaSquareMeters), [80, 20, 90, 210]);
  assert(Math.abs(result.classAreas[0].standardErrorSquareMeters ** 2 - 2277.777777777778) < 1e-9);
  assert.equal(result.classes[0].precision, .8); assert.equal(result.classes[0].recall, 80 / 170);
  assert.deepEqual(result.confidence, {level: .95, scope: 'simultaneous-predeclared-reference-class-areas',
    method: 'clopper-pearson-bonferroni', strata: 2, classes: 2});
});

test('exact binomial endpoints match analytic zero/all-success bounds and preserve uncertainty', () => {
  const alpha = .05 / 6, n = 12, zero = exactBinomialInterval(0, n, alpha), all = exactBinomialInterval(n, n, alpha);
  assert.equal(zero.lower, 0); assert.equal(all.upper, 1);
  assert(Math.abs(zero.upper - (1 - (alpha / 2) ** (1 / n))) < 1e-12);
  assert(Math.abs(all.lower - (alpha / 2) ** (1 / n)) < 1e-12);
  assert(zero.upper > 0 && all.lower < 1);
  const middle = exactBinomialInterval(6, 12, .05);
  assert(Math.abs(middle.lower + middle.upper - 1) < 1e-12); assert(middle.lower < .5 && middle.upper > .5);
});

test('zero-count predeclared classes have positive exact area upper bounds, zero plug-in SE and null recall', () => {
  const r = estimatePpsStrata({strata: [{group: 'Forest', areaSquareMeters: 100, draws: 8}],
    referenceClasses: ['Forest', 'Absent'], counts: [[8, 0]]});
  const absent = r.classAreas[1]; assert.equal(absent.areaSquareMeters, 0); assert.equal(absent.standardErrorSquareMeters, 0);
  assert.equal(absent.lower95SquareMeters, 0); assert(absent.upper95SquareMeters > 0 && absent.upper95SquareMeters < 100);
  assert.equal(r.classes.find(row => row.group === 'Absent').recall, null);
  assert(r.classAreas[0].lower95SquareMeters < 100);
});

test('full methods, geometry, source facts and append-only events survive JSON and CSV exports', async () => {
  const source = fixture([[10, 20]]);
  source.input.periodStart = '2024-01-01'; source.input.periodEnd = '2024-12-31';
  let report = createRasterValidationAssessment(await plan(source));
  for (const cell of rasterValidationReviewState(report).uniqueCells) report = review(report, cell, cell.stratum,
    {evidence: '=UNTRUSTED spreadsheet expression remains literal'});
  report = await evaluateRasterValidationAssessment(report);
  const json = rasterValidationJson(report), csv = rasterValidationCsv(report), map = rasterValidationGeoJson(report);
  assert.deepEqual(await parseRasterValidationJson(json), report); assert.deepEqual(map['opengeo:analysis'].rasterValidation, report);
  assert.equal(map.features.length, report.plan.samples.length); assert.equal(map.features[0].geometry.coordinates[0].length, 5);
  assert.equal(rasterAnalysisEvidence(map).kind, 'rasterValidation');
  assert.notEqual(map['opengeo:analysis'].rasterValidation.plan.input.sourcePeriod,
    map['opengeo:analysis'].rasterValidation.plan.input.interpretation.period);
  assert(csv.includes('class_area') && csv.includes('confusion') && csv.includes('Hansen-Hurwitz'));
  assert(csv.includes("'=UNTRUSTED")); assert.equal(report.quality.classificationAccuracy, null);
  assert.equal(report.outputRights.license, null);
});

test('malformed counts, allocation, evidence, source changes and missing categories fail before accepted output', async () => {
  for (const samplesPerStratum of [1, 129, 1.5]) await assert.rejects(plan(fixture(), {samplesPerStratum}), /allocation_invalid/);
  await assert.rejects(plan(fixture(), {referenceClasses: ['Forest', ' Forest ']}), /reference_classes_invalid/);
  await assert.rejects(plan(fixture(), {seed: ' '}), /seed_required/);
  await assert.rejects(plan(fixture([[null]])), /no_eligible_cells/);
  const f = fixture(); f.input.isCurrent = () => false; await assert.rejects(plan(f), /source_changed/);
  const report = createRasterValidationAssessment(await plan(fixture([[10]]))), cell = report.plan.samples[0];
  assert.throws(() => review(report, cell, 'Not declared'), /reference_class_invalid/);
  assert.throws(() => review(report, cell, 'Forest', {evidence: ''}), /evidence_required/);
  assert.throws(() => review(report, cell, null, {basis: ''}), /review_basis_required/);
  assert.throws(() => estimatePpsStrata({strata: [{group: 'Forest', areaSquareMeters: 10, draws: 2}], referenceClasses: ['Forest'], counts: [[1]]}));
});

test('aborted generation/estimation does not accept partial sampling or discard existing reviews', async () => {
  const controller = new AbortController(); controller.abort(); const f = fixture();
  await assert.rejects(plan(f, {signal: controller.signal}), {name: 'AbortError'}); assert.equal(f.reads, 0);
  let report = createRasterValidationAssessment(await plan(fixture([[10]])));
  report = review(report, report.plan.samples[0], 'Forest');
  await assert.rejects(evaluateRasterValidationAssessment(report, {signal: controller.signal}), {name: 'AbortError'});
  assert.equal(report.reviews.length, 1); assert.equal(report.estimates, null);
});

test('portable assessment validation rejects changed probabilities, unknown fields and altered identity', async () => {
  const report = createRasterValidationAssessment(await plan(fixture()));
  const cyclic = structuredClone(report); cyclic.plan.input.source.loop = cyclic.plan;
  assert.throws(() => assertRasterValidationAssessment(cyclic), /report_invalid/);
  const invalid = structuredClone(report); invalid.plan.samples[0].selectionProbability = 0;
  assert.throws(() => assertRasterValidationAssessment(invalid));
  const extra = structuredClone(report); extra.reviews = [{sequence: 1, cellId: report.plan.samples[0].cellId,
    referenceClass: 'Forest', reviewer: 'Reviewer', evidence: 'Reference', basis: 'Whole cell', reviewedAt: '2026-10-23T12:00:00Z', unreviewedAssertion: true}];
  assert.throws(() => assertRasterValidationAssessment(extra));
  const changed = structuredClone(report); changed.plan.id = 'a'.repeat(64);
  await assert.rejects(parseRasterValidationJson(JSON.stringify(changed)), /plan_checksum_invalid/);
  await assert.rejects(verifyRasterValidationPlanIdentity(changed), /plan_checksum_invalid/);
});

test('512 draws remain complete even when only four distinct cells are selected', async () => {
  const f = fixture([[10, 20, 30, 40]]); f.input.crosswalk = {10: 'A', 20: 'B', 30: 'C', 40: 'D'};
  const p = await plan(f, {samplesPerStratum: 128, referenceClasses: ['A', 'B', 'C', 'D']});
  const report = createRasterValidationAssessment(p); assert.equal(p.samples.length, 512);
  assert.equal(rasterValidationReviewState(report).uniqueCells.length, 4); assert.equal(rasterValidationGeoJson(report).features.length, 512);
  const tooMany = fixture([[10, 20, 30, 40, 50]]); tooMany.input.crosswalk = {10: 'A', 20: 'B', 30: 'C', 40: 'D', 50: 'E'};
  await assert.rejects(plan(tooMany, {samplesPerStratum: 128}), /sample_limit/);
});
