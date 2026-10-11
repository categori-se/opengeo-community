import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cancelNativeAnalysisPreview, runNativeAnalysisPreview} from '../src/components/WorkbenchView.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => {resolve = done;});
  return {promise, resolve};
}

function context(overrides = {}) {
  return {
    state: {analysisPreviewDraft: {operation: 'centroid', source: 'source'}},
    layers: [{layerId: 'source', datasetId: 'dataset', sourceType: 'governed-dataset', title: 'Source'}],
    render() {},
    getAnalysisCollection: async () => ({generation: 1}),
    ...overrides
  };
}

test('deliberate cancellation aborts waiting and sends one fresh-signal request for the exact preview', async () => {
  const waiting = deferred();
  let request;
  let previewSignal;
  let calls = 0;
  const view = context({
    previewVectorAnalysis: async (_dataset, payload, options) => {
      request = payload;
      previewSignal = options.signal;
      return waiting.promise;
    },
    cancelVectorAnalysis: async (dataset, previewId, {signal}) => {
      calls++;
      assert.equal(dataset, 'dataset');
      assert.equal(previewId, request.preview_id);
      assert.equal(previewSignal.aborted, true);
      assert.notEqual(signal, previewSignal);
      assert.equal(signal.aborted, false);
      return {state: 'cancellation_requested'};
    }
  });
  const running = runNativeAnalysisPreview(view);
  await Promise.resolve();
  await Promise.resolve();
  await cancelNativeAnalysisPreview(view);
  await cancelNativeAnalysisPreview(view);
  waiting.resolve({features: [{}]});
  await running;
  assert.equal(calls, 1);
  assert.equal(view.state.analysisPreviewResult, null);
  assert.match(view.state.analysisPreviewMessage, /cancellation requested/);
});

test('cancel during version reads launches no server cancellation or later preview', async () => {
  const versions = deferred();
  let calls = 0;
  const view = context({
    getAnalysisCollection: () => versions.promise,
    previewVectorAnalysis: () => {calls++;},
    cancelVectorAnalysis: () => {calls++;}
  });
  const running = runNativeAnalysisPreview(view);
  await cancelNativeAnalysisPreview(view);
  versions.resolve({generation: 1});
  await running;
  assert.equal(calls, 0);
  assert.equal(view.state.analysisPreviewResult, null);
});

test('new preview has a fresh identity and rejects stale preview and cancel responses', async () => {
  const oldPreview = deferred();
  const oldCancel = deferred();
  const ids = [];
  const view = context({
    previewVectorAnalysis: async (_dataset, payload) => {
      ids.push(payload.preview_id);
      return ids.length === 1 ? oldPreview.promise : {features: []};
    },
    cancelVectorAnalysis: () => oldCancel.promise
  });
  const first = runNativeAnalysisPreview(view);
  await Promise.resolve();
  await Promise.resolve();
  const cancellation = cancelNativeAnalysisPreview(view);
  await runNativeAnalysisPreview(view);
  const result = view.state.analysisPreviewResult;
  const message = view.state.analysisPreviewMessage;
  oldPreview.resolve({features: [{}]});
  oldCancel.resolve({state: 'not_running'});
  await Promise.all([first, cancellation]);
  assert.equal(new Set(ids).size, 2);
  assert.equal(view.state.analysisPreviewResult, result);
  assert.equal(view.state.analysisPreviewMessage, message);
});

test('no active query and failed cancellation preserve discard without retry', async () => {
  for (const fails of [false, true]) {
    const waiting = deferred();
    let calls = 0;
    const view = context({
      previewVectorAnalysis: () => waiting.promise,
      cancelVectorAnalysis: async () => {
        calls++;
        if (fails) throw Error('unavailable');
        return {state: 'not_running'};
      }
    });
    const running = runNativeAnalysisPreview(view);
    await Promise.resolve();
    await Promise.resolve();
    await cancelNativeAnalysisPreview(view);
    waiting.resolve({features: []});
    await running;
    assert.equal(calls, 1);
    assert.equal(view.state.analysisPreviewResult, null);
    assert.match(view.state.analysisPreviewMessage, fails ? /could not be confirmed/ : /No active calculation/);
  }
});
