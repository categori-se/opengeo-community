import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readBrowserProjectFile, BROWSER_PROJECT_FILE_BYTES} from '../src/lib/browserProjectFile.js';
import {emptyMapDefinition} from '../src/lib/mapDefinition.js';

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
