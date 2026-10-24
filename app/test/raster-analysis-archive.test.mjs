import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {computeRasterComparison,rasterComparisonGeoJson} from '../src/lib/rasterComparison.js';
import {computeRasterPatches,rasterPatchesGeoJson} from '../src/lib/rasterPatches.js';
import {computeRasterHeightDifference,rasterHeightDifferenceGeoJson} from '../src/lib/rasterHeightDifference.js';
import {rasterAnalysisEvidence,archivedRasterAnalysisReceipt,verifyRasterAnalysisArchive} from '../src/lib/rasterAnalysisArchive.js';
import {canonicalJson} from '../src/lib/artifactCanonicalJson.js';
import {createRasterValidationPlan,createRasterValidationAssessment,reviewRasterValidationCell,
  evaluateRasterValidationAssessment,rasterValidationGeoJson,rasterValidationReviewState} from '../src/lib/rasterValidation.js';

const id = number => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const sha = value => createHash('sha256').update(value).digest('hex');
function input(values, number = 1, {managed = true, step = .001} = {}) {
  const width = values[0].length, height = values.length;
  const grid = {width, height, metadata: {bands: [1], imageIndex: 0, projection: 'EPSG:4326', interpretation: 'area',
    window: [0, 0, width, height], origin: [85, 28, 0], resolution: [step, -step, 0], scaleX: 1, scaleY: 1, noData: null,
    source: {url: `https://example.org/${number}.tif`, etag: `"observed-${number}"`, size: 4096, verified: true, license: 'CC-BY-4.0', attribution: `Provider ${number}`}},
    active: () => true, coordinate: (column, row) => [85 + column * step, 28 - row * step], value: (column, row) => values[row][column]};
  return {grid, band: 1, categoricalConfirmed: true, crosswalk: {10: 'Forest', 20: 'Other', 30: 'Absent'},
    pins: managed ? {layerId: `layer-${number}`, sourceType: 'governed-dataset', datasetId: id(number), datasetVersionId: id(number + 10),
      sourceVersion: number, objectId: id(number + 20)} : {layerId: `reference-${number}`, sourceType: 'cog-raster'}};
}
async function comparison(evaluated = false) {
  const before = input([[10, 20, null], [10, 99, 20]]), after = input([[20, 20, 10], [10, 20, 10]], 2, {managed: false});
  const result = await computeRasterComparison({before, after, yieldControl: async () => {},
    ...(evaluated ? {referenceEvaluation: {reference: 'before', basis: 'Explicit illustrative reference; quality is unknown.'}} : {})});
  before.grid.value = after.grid.value = () => assert.fail('Archive validation must not read source cells.');
  return rasterComparisonGeoJson(result);
}
async function heightCells() {
  const surface = {...input([[1.25, -9999], [null, 0]], 4), units: 'international-feet', elevationConfirmed: true},
    terrain = {...input([[1, 2], [3, 0]], 5, {managed: false}), units: 'metres', elevationConfirmed: true};
  surface.grid.metadata.noData = -9999;
  const result = await computeRasterHeightDifference({surface, terrain,
    review: {confirmed: true, basis: 'Illustrative compatible vertical references; accuracy unverified.'}, yieldControl: async () => {}});
  const collection = rasterHeightDifferenceGeoJson(result);
  surface.grid.value = terrain.grid.value = () => assert.fail('Archive validation must not reread elevation cells.');
  return collection;
}

test('continuous height cells retain all exclusions, source units and exact archive lineage without raster reads', async () => {
  const collection = await heightCells(), evidence = rasterAnalysisEvidence(collection);
  assert.equal(evidence.kind, 'rasterHeightDifference'); assert.equal(evidence.operation, 'raster-height-difference');
  assert.equal(evidence.report.coverage.validPairs, 2); assert.equal(evidence.report.coverage.excludedPairs, 2);
  assert.equal(evidence.report.statistics.negativeCells, 1); assert.equal(evidence.report.statistics.zeroCells, 1);
  assert.equal(evidence.inputs.surface.units, 'international-feet'); assert.equal(evidence.summary.method.classification, 'none');
  assert.equal(evidence.source.license, null); assert.equal(evidence.summary.map.totalCells, 4);
  const audit = {distributionId: `urn:opengeo:dataset:${id(31)}:version:${id(32)}:original`, sha256: sha(canonicalJson(evidence.report))},
    reference = archivedRasterAnalysisReceipt(evidence, audit).rasterHeightDifference,
    bytes = new TextEncoder().encode(JSON.stringify({type: 'FeatureCollection', features: collection.features,
      properties: {'opengeo:analysis': collection['opengeo:analysis']}}));
  const reopened = await verifyRasterAnalysisArchive(bytes, {objectSha256: sha(bytes), reference});
  assert.deepEqual(reopened.collection.features, collection.features);
  assert.deepEqual(reopened.receipt.rasterHeightDifference, evidence.report);
  assert.equal(reference.audit.jsonPointer, '/properties/opengeo:analysis/rasterHeightDifference');
});

test('height archives reject altered differences, raw values, cells, source authority, missingness and unsupported metadata', async () => {
  const original = await heightCells();
  const edits = [
    value => {value.features[0].properties.differenceMeters = 5;},
    value => {value.features[0].properties.surfaceMeters = 5;},
    value => {value.features[0].properties.surfaceRawValue = null;},
    value => {value.features.pop();},
    value => {value.features[1].properties.column = 0;},
    value => {value.features[1].geometry.coordinates[0][0][0] += .01;},
    value => {
      for (const feature of value.features) for (const point of feature.geometry.coordinates[0]) point[0] += .01;
      for (const point of value['opengeo:analysis'].rasterHeightDifference.scope.cornerCoordinates) point[0] += .01;
    },
    value => {value['opengeo:analysis'].rasterHeightDifference.inputs.surface.units = 'metres';},
    value => {value['opengeo:analysis'].rasterHeightDifference.inputs.surface.source.reference.url = 'https://example.org/x?token=private';},
    value => {value['opengeo:analysis'].rasterHeightDifference.review.authority = 'verified';},
    value => {value['opengeo:analysis'].rasterHeightDifference.method.accuracy = 'verified';},
    value => {value['opengeo:analysis'].rasterHeightDifference.statistics.negativeCells = 0;},
    value => {value['opengeo:analysis'].rasterHeightDifference.coverage.inputStatus.surface.nullCells = 0;},
    value => {value.features[0].properties.privateContext = 'private';},
    value => {value['opengeo:analysis'].rasterHeightDifference.privateContext = 'private';}
  ];
  for (const edit of edits) {const changed = structuredClone(original); edit(changed); assert.throws(() => rasterAnalysisEvidence(changed), /invalid/);}
});
async function patches(values = [[10, 20, null], [10, 99, 10]], options = {}) {
  const source = input(values, 3, options);
  const result = await computeRasterPatches({input: source, group: 'Forest', connectivity: 4, basis: 'Observed loaded-window patches only.', yieldControl: async () => {}});
  source.grid.value = () => assert.fail('Archive validation must not read source cells.');
  return rasterPatchesGeoJson(result);
}
async function validation({estimated = false, unresolved = false, maximum = false} = {}) {
  const source = input(maximum ? [[10, 20, 30, 40]] : [[10, 20], [10, 20]], 4);
  const referenceClasses = maximum ? ['Forest', 'Other', 'Absent', 'Water'] : ['Forest', 'Other'];
  if (maximum) source.crosswalk[40] = 'Water';
  const plan = await createRasterValidationPlan({input: source, seed: 'fixed-reviewed-seed', samplesPerStratum: maximum ? 128 : 2,
    referenceClasses, question: 'Estimate class areas in this frozen cached window.',
    labelingProtocol: 'Assign a whole-cell reference class from dated independent imagery; preserve uncertainty.', yieldControl: async () => {}});
  source.grid.value = () => assert.fail('Archive validation must not read source cells.');
  let report = createRasterValidationAssessment(plan);
  const cells = rasterValidationReviewState(report).uniqueCells;
  const review = sample => ({cellId: sample.cellId, referenceClass: sample.stratum, reviewer: 'Illustrative reviewer',
    evidence: 'Dated independent reference imagery, revision 1; quality is unverified.', basis: 'Whole-cell dominant reference class.',
    reviewedAt: '2026-10-23T21:00:00Z'});
  if (unresolved || estimated) report = reviewRasterValidationCell(report, {...review(cells[0]), referenceClass: null});
  if (estimated) {
    for (const sample of cells) report = reviewRasterValidationCell(report, review(sample));
    report = await evaluateRasterValidationAssessment(report, {yieldControl: async () => {}});
  }
  return rasterValidationGeoJson(report);
}

test('validation drafts and estimates archive complete draws with bounded source, review and class-area summaries', async () => {
  for (const collection of [await validation({unresolved: true}), await validation({estimated: true})]) {
    const retained = structuredClone(collection), evidence = rasterAnalysisEvidence(collection), {summary} = evidence;
    assert.equal(evidence.kind, 'rasterValidation'); assert.equal(evidence.operation, 'raster-validate');
    assert.deepEqual(evidence.report, retained['opengeo:analysis'].rasterValidation);
    assert.equal(summary.plan.samples, undefined); assert.equal(summary.plan.input, undefined); assert.equal(summary.reviews, undefined);
    assert.deepEqual(summary.plan.criteria, evidence.report.plan.criteria);
    assert.deepEqual(summary.plan.strata, evidence.report.plan.strata);
    assert.deepEqual(summary.plan.coverage, evidence.report.plan.coverage);
    assert.equal(summary.inputs.input.pins.sourceVersion, 4); assert.equal(summary.inputs.input.pins.objectId, id(24));
    assert.equal(summary.inputs.input.interpretation.crosswalk, undefined);
    assert.equal(summary.quality.classificationAccuracy, null); assert.equal(summary.outputRights.license, null);
    assert.equal(summary.reviewCounts.events, evidence.report.reviews.length);
    if (evidence.report.status === 'estimated') {
      assert.deepEqual(summary.estimates.classAreas, evidence.report.estimates.classAreas);
      assert.equal(summary.estimates.confusion, undefined); assert.equal(summary.reviewCounts.unresolvedCells, 0);
    } else {
      assert.equal(summary.estimates, null); assert.equal(summary.reviewCounts.unresolvedCells, 1);
      assert(summary.reviewCounts.unreviewedCells > 0);
    }
    evidence.report.status = 'edited'; summary.plan.criteria.seed = 'edited'; assert.deepEqual(collection, retained);
  }
});

test('validation archive retains all 512 with-replacement draws and binds every Polygon and latest review', async () => {
  const complete = await validation({maximum: true}), evidence = rasterAnalysisEvidence(complete);
  assert.equal(complete.features.length, 512); assert.equal(evidence.summary.reviewCounts.uniqueCells, 4);
  assert.equal(new Set(complete.features.map(feature => feature.properties.cellId)).size, 4);
  const original = await validation({estimated: true});
  for (const mutate of [value => {value.features.pop();}, value => {value.features.reverse();},
    value => {value.features[0].geometry.coordinates[0][1][0] += .001;},
    value => {const properties = value.features[0].properties; properties.referenceClass = properties.referenceClass === 'Other' ? 'Forest' : 'Other';},
    value => {value.features[0].properties.sampleId = value.features[1].properties.sampleId;},
    value => {value['opengeo:analysis'].rasterValidation.estimates.classAreas[0].areaSquareMeters++;},
    value => {value['opengeo:analysis'].rasterValidation.reviews[0].sequence = 2;},
    value => {value['opengeo:analysis'].rasterValidation.plan.input.pins.sourceVersion = 0;},
    value => {value['opengeo:analysis'].rasterValidation.quality.classificationAccuracy = 1;}]) {
    const changed = structuredClone(original); mutate(changed); assert.throws(() => rasterAnalysisEvidence(changed));
  }
  const oversized = structuredClone(complete); oversized.features.push(structuredClone(oversized.features[0]));
  assert.throws(() => rasterAnalysisEvidence(oversized), /raster analysis/);
  assert.throws(() => rasterAnalysisEvidence({...complete, features: []}), /raster analysis/);
});

test('draft and estimated validation originals verify exact full-report hashes, original pointers and unchanged review history', async () => {
  for (const collection of [await validation({unresolved: true}), await validation({estimated: true})]) {
    const evidence = rasterAnalysisEvidence(collection), reportSha = sha(canonicalJson(evidence.report));
    const receipt = archivedRasterAnalysisReceipt(evidence, {distributionId: `urn:opengeo:dataset:${id(80)}:version:${id(81)}:original`, sha256: reportSha});
    const reference = receipt.rasterValidation, original = {type: 'FeatureCollection', features: collection.features,
      properties: {'opengeo:analysis': collection['opengeo:analysis']}};
    assert.equal(reference.audit.jsonPointer, '/properties/opengeo:analysis/rasterValidation');
    const bytes = new TextEncoder().encode(JSON.stringify(original)), objectSha256 = sha(bytes);
    const verified = await verifyRasterAnalysisArchive(bytes, {objectSha256, reference});
    assert.deepEqual(verified.collection, original); assert.deepEqual(verified.receipt, collection['opengeo:analysis']);
    for (const change of [value => {value.audit.sha256 = '0'.repeat(64);}, value => {value.audit.jsonPointer += '/wrong';},
      value => {value.reviewCounts.events++;}, value => {value.plan.criteria.seed = 'changed';}]) {
      const changed = structuredClone(reference); change(changed);
      await assert.rejects(verifyRasterAnalysisArchive(bytes, {objectSha256, reference: changed}));
    }
    const changedOriginal = structuredClone(original);
    changedOriginal.properties['opengeo:analysis'].rasterValidation.reviews[0].evidence += ' Edited after archive.';
    const changedBytes = new TextEncoder().encode(JSON.stringify(changedOriginal));
    await assert.rejects(verifyRasterAnalysisArchive(changedBytes, {objectSha256: sha(changedBytes), reference}));
  }
  // Even a self-consistent rewritten object/report summary cannot silently
  // replace the frozen sample-plan identity.
  const forged = structuredClone(await validation()); forged['opengeo:analysis'].rasterValidation.plan.id = 'a'.repeat(64);
  const evidence = rasterAnalysisEvidence(forged);
  const receipt = archivedRasterAnalysisReceipt(evidence, {distributionId: `urn:opengeo:dataset:${id(80)}:version:${id(81)}:original`,
    sha256: sha(canonicalJson(evidence.report))});
  const bytes = new TextEncoder().encode(JSON.stringify({type: 'FeatureCollection', features: forged.features,
    properties: {'opengeo:analysis': forged['opengeo:analysis']}}));
  await assert.rejects(verifyRasterAnalysisArchive(bytes, {objectSha256: sha(bytes), reference: receipt.rasterValidation}), /plan_checksum_invalid/);
});

test('shared raster evidence recognizes only complete exported maps and returns detached bounded summaries', async () => {
  assert.equal(rasterAnalysisEvidence({type: 'FeatureCollection', features: []}), null);
  for (const collection of [await comparison(), await comparison(true), await patches()]) {
    const retained = structuredClone(collection), evidence = rasterAnalysisEvidence(collection), summary = evidence.summary;
    assert.deepEqual(evidence.report, retained['opengeo:analysis'][evidence.kind]);
    assert.equal(evidence.source.license, null); assert(evidence.source.attribution.includes('Provider'));
    assert.equal(summary.transitions, undefined); assert.equal(summary.patches, undefined);
    assert(Object.values(summary.inputs).every(value => value.interpretation.crosswalk === undefined));
    if (summary.referenceEvaluation) {
      assert.equal(summary.referenceEvaluation.classes, undefined); assert.equal(summary.referenceEvaluation.confusion, undefined);
      assert.equal(summary.referenceEvaluation.quality.classificationAccuracy, null);
    }
    evidence.report.status = 'edited'; assert.deepEqual(collection, retained);
  }
});

test('comparison validates count partitions, crosswalk/criteria bindings, complete transitions and evaluated metrics', async () => {
  const original = await comparison(true);
  const mutations = [
    value => {value['opengeo:analysis'].rasterComparison.coverage.excludedCells++;},
    value => {value['opengeo:analysis'].rasterComparison.inputs.before.interpretation.crosswalk[10] = 'Changed';},
    value => {value['opengeo:analysis'].rasterComparison.method.criteria.methodReview.confirmed = true;},
    value => {value['opengeo:analysis'].rasterComparison.referenceEvaluation.classes[0].precision = 1;},
    value => {value['opengeo:analysis'].rasterComparison.referenceEvaluation.roles.reference = 'after';},
    value => {value['opengeo:analysis'].rasterComparison.referenceEvaluation.quality.referenceQuality = 'verified';},
    value => {value['opengeo:analysis'].rasterComparison.referenceEvaluation = null;},
    value => {value['opengeo:analysis'].rasterComparison.map.available = false;},
    value => {value.features.pop();}, value => {value.features[0].properties.beforeCode = 20;}
  ];
  for (const mutate of mutations) {const changed = structuredClone(original); mutate(changed); assert.throws(() => rasterAnalysisEvidence(changed), /raster analysis/);}
});

test('patches bind criteria, patch identity/counts/areas and cell geometry rather than accepting altered receipts', async () => {
  const original = await patches();
  const mutations = [value => {value['opengeo:analysis'].rasterPatches.criteria.group = 'Other';},
    value => {value['opengeo:analysis'].rasterPatches.criteria.connectivity = 8;},
    value => {value['opengeo:analysis'].rasterPatches.summary.patchCount++;},
    value => {value['opengeo:analysis'].rasterPatches.patches[0].areaSquareMeters++;},
    value => {value.features[0].properties.patchId = 'patch-2';},
    value => {value.features[0].geometry.coordinates[0][1][0] += .0001;},
    value => {for (const point of value.features[0].geometry.coordinates[0]) point[0] += .00001;},
    value => {value.features[0].properties.row = 1;},
    value => {value['opengeo:analysis'].rasterPatches.accuracy.status = 'verified';},
    value => {value['opengeo:analysis'].rasterPatches.outputRights.license = 'CC0';}];
  for (const mutate of mutations) {const changed = structuredClone(original); mutate(changed); assert.throws(() => rasterAnalysisEvidence(changed), /raster analysis/);}
});

test('source summaries retain exact managed pins or observed reference facts and reject invented or credential-bearing evidence', async () => {
  const original = await comparison(), evidence = rasterAnalysisEvidence(original);
  assert.deepEqual(evidence.inputs.before.pins, original['opengeo:analysis'].rasterComparison.inputs.before.pins);
  assert.equal(evidence.inputs.after.pins.datasetId, null); assert.equal(evidence.inputs.after.source.reference.etag, '"observed-2"');
  assert(evidence.inputs.after.missingFacts.includes('datasetVersionId'));
  const mutations = [input => {input.pins.generation = 7;}, input => {input.pins.datasetVersionId = 'invented';},
    input => {input.source.reference.url = 'https://example.org/file.tif?token=secret';},
    input => {input.source.reference.url = 'https://user:secret@example.org/file.tif';},
    input => {input.source.reference.etag = null;}, input => {input.source.reference.size = null;},
    input => {input.source.reference.independentlyVerified = true;}];
  for (const mutate of mutations) {const changed = structuredClone(original); mutate(changed['opengeo:analysis'].rasterComparison.inputs.after);
    assert.throws(() => rasterAnalysisEvidence(changed), /raster analysis/);}
  const unknown = structuredClone(original), reference = unknown['opengeo:analysis'].rasterComparison.inputs.after.source.reference;
  Object.assign(reference, {verified: false, etag: null, size: null});
  assert(rasterAnalysisEvidence(unknown).inputs.after.missingFacts.includes('reference.etag'));
});

test('raster maps admit all 1024 cells without truncation, withholding empty/partial/oversized maps', async () => {
  const complete = await patches([Array(1024).fill(10)], {step: .000001});
  assert.equal(rasterAnalysisEvidence(complete).report.coverage.targetCells, 1024);
  const oversized = structuredClone(complete); oversized.features.push(structuredClone(oversized.features[0]));
  assert.throws(() => rasterAnalysisEvidence(oversized), /raster analysis/);
  assert.throws(() => rasterAnalysisEvidence(awaitedEmpty(complete)), /raster analysis/);
  const tooLarge = await patches(); tooLarge['opengeo:analysis'].rasterPatches.limitations = ['x'.repeat(2_200_000)];
  assert.throws(() => rasterAnalysisEvidence(tooLarge), /raster analysis/);
});
function awaitedEmpty(collection) {return {...collection, features: []};}

test('exact original readback verifies object/report hashes, complete data and the immutable distribution/pointer summary', async () => {
  for (const collection of [await comparison(true), await patches()]) {
    const evidence = rasterAnalysisEvidence(collection), reportSha = sha(canonicalJson(evidence.report));
    const receipt = archivedRasterAnalysisReceipt(evidence, {distributionId: `urn:opengeo:dataset:${id(80)}:version:${id(81)}:original`, sha256: reportSha});
    const reference = receipt[evidence.kind], original = {type: 'FeatureCollection', features: collection.features,
      properties: {'opengeo:analysis': collection['opengeo:analysis']}};
    const bytes = new TextEncoder().encode(JSON.stringify(original)), objectSha256 = sha(bytes);
    const verified = await verifyRasterAnalysisArchive(bytes, {objectSha256, reference});
    assert.deepEqual(verified.collection, original); assert.deepEqual(verified.receipt, collection['opengeo:analysis']);
    await assert.rejects(verifyRasterAnalysisArchive(bytes, {objectSha256: '0'.repeat(64), reference}), /raster analysis/);
    for (const change of [value => {value.audit.sha256 = '0'.repeat(64);}, value => {value.audit.jsonPointer += '/wrong';},
      value => {value.coverage.totalCells++;}]) {
      const changed = structuredClone(reference); change(changed);
      await assert.rejects(verifyRasterAnalysisArchive(bytes, {objectSha256, reference: changed}), /raster analysis/);
    }
    original.features[0].properties.areaSquareMeters++;
    const changedBytes = new TextEncoder().encode(JSON.stringify(original));
    await assert.rejects(verifyRasterAnalysisArchive(changedBytes, {objectSha256: sha(changedBytes), reference}), /raster analysis/);
  }
});
