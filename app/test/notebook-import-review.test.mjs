import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {NotebookImportReview} from '../src/components/NotebookImportReview.js';

const source = {path: 'index.html', source: '<notebook><script id="1" type="module">const x=1;</script></notebook>', availablePaths: ['index.html']};
const result = {cellCount: 1, cells: [{id: '1', mode: 'js'}],
  modules: [{name: 'd3', bundled: true, cellIds: ['1']}],
  attachments: [{name: 'missing.json', available: false, cellIds: ['1']}],
  externalReferences: [{kind: 'literal URL', value: 'https://example.test/<img>', cellIds: ['1']}],
  unsupported: [{cellId: '1', message: 'Import is not bundled.'}],
  manualWork: ['Provide the missing attachment.'], limitations: ['Computed references require manual review.'], truncated: false};
const tick = () => new Promise(setImmediate);
async function withReview(callback) {
  const dom = new JSDOM('<!doctype html><body></body>');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: dom.window.document});
  try {await callback(dom.window.document);}
  finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document;
    dom.window.close();
  }
}

it('reviews the selected notebook only on request and displays findings as text without editing source', () => withReview(async document => {
  let calls = 0;
  const review = NotebookImportReview({getSource: () => source, inspect: async value => {
    calls++; assert.deepEqual(value, source); return result;
  }});
  document.body.append(review.element); review.update();
  assert.equal(calls, 0);
  assert.equal(review.element.hidden, false);
  review.element.querySelector('button').click(); await tick();
  assert.equal(calls, 1);
  assert.match(review.element.textContent, /missing.json · path missing or unsupported/);
  assert.match(review.element.textContent, /Computed references require manual review/);
  assert.equal(review.element.querySelector('img'), null);
  assert.match(source.source, /const x=1/);
}));

it('discards a pending review after the source or attachment selection changes', () => withReview(async document => {
  const pending = Promise.withResolvers(); let current = source;
  const review = NotebookImportReview({getSource: () => current, inspect: () => pending.promise});
  document.body.append(review.element); review.update(); review.element.querySelector('button').click();
  current = {...source, availablePaths: [...source.availablePaths, 'missing.json']};
  pending.resolve(result); await tick();
  assert.doesNotMatch(review.element.textContent, /path missing or unsupported/);
  review.update();
  assert.equal(review.element.querySelector('button').disabled, false);
  current = {...source, source: '<h1>Ordinary HTML</h1>'}; review.update();
  assert.equal(review.element.hidden, true);
}));

it('keeps an invalid notebook intact and allows retry after inspection fails', () => withReview(async document => {
  const review = NotebookImportReview({getSource: () => source, inspect: async () => {throw Error('Invalid cell 1');}});
  document.body.append(review.element); review.update(); review.element.querySelector('button').click(); await tick();
  assert.match(review.element.textContent, /Invalid cell 1/);
  assert.match(review.element.textContent, /Source files remain unchanged/);
  assert.equal(review.element.querySelector('button').disabled, false);
}));

it('shows Jupyter saved-output limits without claiming kernel imports were checked', () => withReview(async document => {
  const jupyter = {path: 'analysis.ipynb', source: '{"nbformat":4}', availablePaths: []};
  const review = NotebookImportReview({getSource: () => jupyter, inspect: async value => {
    assert.equal(value, jupyter);
    return {...result, modules: [], moduleInspection: 'Review imports in the original kernel; code dependencies were not analyzed.',
      attachments: [{name: 'plot.png', storage: 'embedded', available: true, cellIds: ['1']},
        {name: 'plot.svg', available: null, cellIds: ['1']}],
      savedOutputs: {total: 3, supported: 2, unsupported: 1, codeCellsWithoutOutput: 1}};
  }});
  document.body.append(review.element); review.update();
  assert.equal(review.element.hidden, false);
  review.element.querySelector('button').click(); await tick();
  assert.match(review.element.textContent, /plot.png · stored in this notebook/);
  assert.match(review.element.textContent, /plot.svg · reference unsupported; file presence not determined/);
  assert.match(review.element.textContent, /3 outputs: 2 have a supported representation; 1 need review/);
  assert.match(review.element.textContent, /Editing does not run a kernel/);
  assert.match(review.element.textContent, /code dependencies were not analyzed/);
}));
