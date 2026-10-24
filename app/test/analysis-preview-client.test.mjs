import assert from 'node:assert/strict';
import {test} from 'node:test';
import {OpenGeoApiClient} from '../src/lib/apiClient.js';

const project = '10000000-0000-4000-8000-000000000005';
const source = '10000000-0000-4000-8000-000000000008';
const target = '96000000-0000-4000-8000-000000000001';
const preview = '96000000-0000-4000-8000-000000000002';
const request = {operation: 'intersection', source_generation: 2, target_dataset_id: target, target_generation: 3};
const payload = {
  type: 'FeatureCollection',
  features: [{type: 'Feature', id: `${source}:${target}`, properties: {source: {name: 'A'}, target: {name: 'B'}}, geometry: {type: 'Point', coordinates: [1, 2]}}],
  'opengeo:analysis': {operation: 'intersection', version: '1.0.0', sourceDatasetId: source, targetDatasetId: target,
    source_generation: 2, target_generation: 3, distanceMeters: null, persisted: false, crs: 'CRS:84'}
};
function client(response, observe = () => {}) {
  return new OpenGeoApiClient({tokenProvider: () => 'local-test', organizationProvider: () => '10000000-0000-4000-8000-000000000003', fetchImplementation: async (url, options) => {
    observe(url, options);
    return new Response(JSON.stringify(response), {headers: {'Content-Type': 'application/geo+json'}});
  }});
}
test('preview retains composite IDs, namespaced properties and exact lineage; forwards cancellation', async () => {
  const controller = new AbortController();
  const result = await client(payload, (url, options) => {
    assert.ok(String(url).endsWith(`/projects/${project}/datasets/${source}/analysis-preview`));
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), request);
    assert.equal(options.signal, controller.signal);
  }).previewVectorAnalysis(project, source, request, {signal: controller.signal});
  assert.deepEqual(result, payload);
});
test('preview rejects mismatched lineage and unexpected persistence', async () => {
  for (const change of [{sourceDatasetId: target}, {source_generation: 4}, {target_generation: 4}, {targetDatasetId: source}, {operation: 'clip'}, {persisted: true}, {distanceMeters: 5}]) {
    const changed = structuredClone(payload);
    Object.assign(changed['opengeo:analysis'], change);
    await assert.rejects(client(changed).previewVectorAnalysis(project, source, request), (error) => error.code === 'invalid_api_response');
  }
});
test('overlay accepts the dimension-preserving revision and rejects unknown revisions', async () => {
  const revised = structuredClone(payload);
  revised['opengeo:analysis'].version = '1.1.0';
  assert.deepEqual(await client(revised).previewVectorAnalysis(project, source, request), revised);
  revised['opengeo:analysis'].version = '2.0.0';
  await assert.rejects(client(revised).previewVectorAnalysis(project, source, request),
    (error) => error.code === 'invalid_api_response');
});
test('preview rejects oversized output and malformed geometry', async () => {
  const oversized = structuredClone(payload);
  oversized.features = Array.from({length: 1001}, () => payload.features[0]);
  await assert.rejects(client(oversized).previewVectorAnalysis(project, source, request), (error) => error.code === 'invalid_api_response');
  const malformed = structuredClone(payload);
  malformed.features[0].geometry.coordinates = ['bad', 2];
  await assert.rejects(client(malformed).previewVectorAnalysis(project, source, request), (error) => error.code === 'invalid_api_response');
});

test('explicit preview identity is retained and checked separately from analysis inputs', async () => {
  const identified = structuredClone(payload);
  identified['opengeo:analysis'].previewId = preview;
  assert.deepEqual(await client(identified).previewVectorAnalysis(project, source,
    {...request, preview_id: preview}), identified);
  await assert.rejects(client(payload).previewVectorAnalysis(project, source,
    {...request, preview_id: preview}), error => error.code === 'invalid_api_response');
});

test('explicit cancellation sends one independently cancellable request and distinguishes no active query', async () => {
  const controller = new AbortController();
  for (const state of ['cancellation_requested', 'not_running']) {
    let calls = 0;
    const result = await client({preview_id: preview, state}, (url, options) => {
      calls++;
      assert.ok(String(url).endsWith(`/projects/${project}/datasets/${source}/analysis-preview/${preview}/cancel`));
      assert.equal(options.method, 'POST');
      assert.equal(options.signal, controller.signal);
      assert.equal(new Headers(options.headers).get('authorization'), 'Bearer local-test');
    }).cancelVectorAnalysis(project, source, preview, {signal: controller.signal});
    assert.deepEqual(result, {previewId: preview, state});
    assert.equal(calls, 1);
  }
  for (const invalid of [{preview_id: target, state: 'not_running'}, {preview_id: preview, state: 'cancelled'}]) {
    await assert.rejects(client(invalid).cancelVectorAnalysis(project, source, preview),
      error => error.code === 'invalid_api_response');
  }
});

const buildingRequest = {...request, operation: 'building-reconcile'};
function buildingPayload() {
  const ids = Array.from({length: 5}, (_, index) => `97000000-0000-4000-8000-00000000000${index}`);
  const neighbor = (id, iou, degree = 1) => ({featureId: id, intersectionOverUnion: iou, overlapCount: degree});
  const row = (side, id, status, neighbors) => ({type: 'Feature', id: `${side}:${id}`,
    geometry: {type: 'Polygon', coordinates: [[[0, 0], [.001, 0], [.001, .001], [0, .001], [0, 0]]]},
    properties: {input: {side, featureId: id, properties: {name: `${side} original`, confidence: .9}},
      reconciliation: {status, reviewStatus: 'unreviewed', neighbors}}});
  return {type: 'FeatureCollection', features: [
    row('source', ids[0], 'one-to-one-candidate', [neighbor(ids[0], .8)]),
    row('target', ids[0], 'one-to-one-candidate', [neighbor(ids[0], .8)]),
    row('source', ids[1], 'unmatched', []), row('target', ids[1], 'unmatched', []),
    row('source', ids[2], 'ambiguous', [neighbor(ids[2], .5), neighbor(ids[3], .5)]),
    row('target', ids[2], 'ambiguous', [neighbor(ids[2], .5, 2)]),
    row('target', ids[3], 'ambiguous', [neighbor(ids[2], .5, 2)]),
    row('source', ids[4], 'boundary-disagreement', [neighbor(ids[4], .2)]),
    row('target', ids[4], 'boundary-disagreement', [neighbor(ids[4], .2)])
  ], 'opengeo:analysis': {...payload['opengeo:analysis'], operation: 'building-reconcile',
    source_count: 4, target_count: 5, allowed: true, building_polygon_inputs: true,
    buildingReconciliation: {minimumIntersectionOverUnion: .5,
      intersectionMethod: 'PostGIS local projected geography overlay', areaMethod: 'PostGIS spheroidal geography',
      candidateRule: 'one positive-area neighbor on each side',
      ambiguityRule: 'multiple positive-area neighbors on either side', unmatched: 'retained on both sides',
      reviewStatus: 'unreviewed', validatedCount: null, maximumSpanDegrees: 6, maximumAbsoluteLatitude: 80}}};
}

test('building preview preserves both inventories, source properties and symmetric unreviewed relations', async () => {
  const response = buildingPayload();
  assert.deepEqual(await client(response).previewVectorAnalysis(project, source, buildingRequest), response);
});

test('building preview rejects changed method, fabricated validation, omitted inputs and inconsistent graph', async () => {
  const changes = [
    value => {value['opengeo:analysis'].buildingReconciliation.minimumIntersectionOverUnion = .1;},
    value => {value['opengeo:analysis'].buildingReconciliation.validatedCount = 4;},
    value => {value['opengeo:analysis'].building_polygon_inputs = false;},
    value => {value['opengeo:analysis'].allowed = false;},
    value => {value.features.pop();},
    value => {value.features[4].properties.reconciliation.status = 'one-to-one-candidate';},
    value => {value.features[0].properties.reconciliation.neighbors[0].intersectionOverUnion = .7;},
    value => {value.features[5].properties.reconciliation.neighbors[0].overlapCount = 1;},
    value => {value.features[0].properties.reconciliation.neighbors[0].intersectionOverUnion = 1.01;},
    value => {value.features[0].properties.reconciliation.neighbors[0] = null;},
    value => {value.features[0].geometry = {type: 'Point', coordinates: [0, 0]};},
    value => {value.features[0].id = 'unrelated';},
    value => {value.features[0].properties.reconciliation.reviewStatus = 'accepted';}
  ];
  for (const change of changes) {
    const response = buildingPayload(); change(response);
    await assert.rejects(client(response).previewVectorAnalysis(project, source, buildingRequest),
      error => error.code === 'invalid_api_response');
  }
});
