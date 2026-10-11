import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {BrowserLayerRegistration, browserLayerReviewForProject} from '../src/components/BrowserLayerRegistration.js';
import {readBrowserLayerCatalog, writeBrowserLayerCatalog} from '../src/lib/browserLayerCatalogStore.js';

it('catalog reuse preserves nested knowledge and explicit unknown rights through review and reopen', async () => {
  const dom = new JSDOM('<!doctype html>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  try {
    const layer = {datasetId: 'catalog-one', title: 'Survey', sourceType: 'geojson', metadata: {
      source: {license: 'Provider terms', nested: {rights: ['display'], evidence: 'source-revision-1'}},
      normalized: {schema: {height: {unit: 'm'}}, featureCount: 9},
      curated: {license: null, description: 'Reviewed', ownership: {publisher: 'Survey office'}},
      inferred: {coverage: {confidence: 0.4, method: 'bounds', evidence: ['observation-1']}},
      context: [{relationship: 'derivedFrom', resourceId: 'upstream'}]
    }};
    const before = structuredClone(layer);
    const geojson = {type: 'FeatureCollection', features: [{type: 'Feature', geometry: {type: 'Point', coordinates: [1, 2]}, properties: {}}]};
    let saved;
    const dialog = BrowserLayerRegistration({layer, geojson, source: {license: 'Fallback terms'}, onAdd: async value => {saved = value;}});
    assert.equal(dialog.querySelector('[aria-label="License"]').value, '', 'explicit unknown must not inherit provider terms');
    dialog.querySelector('[aria-label="Description"]').value = 'Updated description';
    dialog.querySelector('form').dispatchEvent(new dom.window.Event('submit', {cancelable: true}));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(saved.datasetId, layer.datasetId);
    assert.deepEqual(saved.metadata.source, before.metadata.source);
    assert.deepEqual(saved.metadata.inferred, before.metadata.inferred);
    assert.deepEqual(saved.metadata.context, before.metadata.context);
    assert.deepEqual(saved.metadata.normalized.schema, before.metadata.normalized.schema);
    assert.equal(saved.metadata.normalized.featureCount, 1);
    assert.deepEqual(saved.metadata.curated.ownership, before.metadata.curated.ownership);
    assert.equal(saved.metadata.curated.description, 'Updated description');
    assert.equal(saved.metadata.curated.license, null);
    assert.deepEqual(layer, before, 'review must not mutate the reusable input');
    const values = new Map();
    const storage = {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value)};
    assert.equal(writeBrowserLayerCatalog(storage, new Map([[saved.datasetId, {layer: saved, geojson}]])), true);
    const restored = readBrowserLayerCatalog(storage).get(saved.datasetId).layer;
    assert.deepEqual(restored, saved, 'the independent catalog retains all knowledge across serialization');
    const reopened = BrowserLayerRegistration({layer: restored, geojson, source: restored.metadata.source, onAdd: async () => {throw new Error('cancel must not add');}});
    assert.equal(reopened.querySelector('[aria-label="License"]').value, '');
    [...reopened.querySelectorAll('button')].find(button => button.textContent === 'Cancel').click();
    assert.equal(document.querySelector('dialog'), null);
    saved.metadata.source.nested.rights.push('changed');
    assert.deepEqual(layer, before, 'nested evidence must be independently cloned');
  } finally {globalThis.document = previous; dom.window.close();}
});


it('delayed source review remains bound to its originating Project and adds only once', async () => {
  const dom = new JSDOM('<!doctype html><main></main>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  try {
    const context = {project: {title: 'First'}, shell: document.querySelector('main')};
    let adds = 0;
    const options = {layer: {title: 'Layer', datasetId: 'source'}, geojson: null, onAdd: async () => {adds++;}};
    const delayed = browserLayerReviewForProject(context);
    context.project = {title: 'New Project'};
    assert.equal(delayed(options), null, 'a late source cannot open review in the new Project');
    assert.equal(document.querySelector('dialog'), null);
    const dialog = browserLayerReviewForProject(context)(options);
    context.project = {title: 'Another Project'};
    dialog.querySelector('form').dispatchEvent(new dom.window.Event('submit', {cancelable: true}));
    assert.equal(adds, 0);
    assert.match(dialog.querySelector('[role="status"]').textContent, /Project has changed/);
    [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Cancel').click();
    const detached = browserLayerReviewForProject(context);
    context.shell.remove();
    assert.equal(detached(options), null);
    document.body.append(context.shell);
    context.disposed = true;
    assert.equal(browserLayerReviewForProject(context)(options), null);
    context.disposed = false;
    let complete;
    const pending = browserLayerReviewForProject(context)({...options, onAdd: () => {adds++; return new Promise(resolve => {complete = resolve;});}});
    const submit = () => pending.querySelector('form').dispatchEvent(new dom.window.Event('submit', {cancelable: true}));
    submit(); submit();
    assert.equal(adds, 1, 'pending confirmation cannot add twice');
    pending.dispatchEvent(new dom.window.Event('cancel', {cancelable: true}));
    assert.equal(pending.isConnected, true, 'Escape cannot dismiss an in-progress addition');
    complete();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(document.querySelector('dialog'), null);
  } finally {globalThis.document = previous; dom.window.close();}
});
