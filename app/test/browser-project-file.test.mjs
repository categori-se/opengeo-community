import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readBrowserProjectFile, BROWSER_PROJECT_FILE_BYTES} from '../src/lib/browserProjectFile.js';
import {emptyMapDefinition} from '../src/lib/mapDefinition.js';
import {definitionWithPrintLayouts, newProjectPrintLayout} from '../src/lib/printLayouts.js';

const file = layers => JSON.stringify({...emptyMapDefinition(),layers,persistence:{mode:'browser-only-demo'}});
const layer = {layerId:'local',title:'Local points',sourceType:'geojson-object',geojson:{type:'FeatureCollection',features:[]}};
test('native browser project preserves embedded data and rejects ambiguous or unavailable sources', () => {
  const parsed=readBrowserProjectFile(file([layer]));
  assert.deepEqual(parsed.layers[0],layer);
  assert.throws(()=>readBrowserProjectFile(file([layer,layer])),/unique/);
  assert.throws(()=>readBrowserProjectFile(file([{...layer,geojson:undefined}])),/not included/);
  assert.throws(()=>readBrowserProjectFile(file([{...layer,sourceType:'kml-places',geojson:undefined}])),/document.*missing/);
  assert.throws(()=>readBrowserProjectFile(' '.repeat(BROWSER_PROJECT_FILE_BYTES+1)),/2 MB/);
  assert.throws(()=>readBrowserProjectFile(file([{...layer,geojson:undefined,sourceType:'xyz-raster',sourceUrl:'https://example.test/tiles?token=secret'}])),/credential-free/);
  assert.throws(()=>readBrowserProjectFile(file([{...layer,geojson:undefined,browserCatalogId:'missing'}])),/unavailable/);
  assert.throws(()=>readBrowserProjectFile('{"persistence":{"mode":"browser-only-demo"},"__proto__":{}}'),/unsupported object key/);
});

test('browser project backup retains print settings and rejects broken source bindings or embedded captures', () => {
  const map = {id: 'browser-project', name: 'Local survey', definition: {...emptyMapDefinition(), layers: [{...layer, datasetId: 'local-data'}]}};
  const layout = newProjectPrintLayout(map, 'paper-one');
  layout.caption = 'Local observations';layout.frames[0].presentation[0].style = {circleColor: '#f97316'};
  const definition = definitionWithPrintLayouts(map, {schemaVersion: 'opengeo.project-print-layouts.1', projectId: map.id, layouts: [layout]});
  const serialized = JSON.stringify({...definition, persistence: {mode: 'browser-only-demo'}});
  const reopened = readBrowserProjectFile(serialized);
  assert.deepEqual(reopened.layers, map.definition.layers);
  assert.deepEqual(reopened.extensions.opengeoPrintLayouts.layouts[0], layout);
  for (const mutate of [draft => {draft.extensions.opengeoPrintLayouts.layouts[0].frames[0].presentation[0].datasetId = 'another-dataset';},
    draft => {draft.extensions.opengeoPrintLayouts.layouts[0].frames[0].image = 'data:image/png;base64,private';}]) {
    const invalid = JSON.parse(serialized);mutate(invalid);
    assert.throws(() => readBrowserProjectFile(JSON.stringify(invalid)), /print|source|layout/i);
  }
});
