import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readBrowserProjectFile, BROWSER_PROJECT_FILE_BYTES} from '../src/lib/browserProjectFile.js';
import {emptyMapDefinition, KML_MAP_DEFINITION_SCHEMA_VERSION} from '../src/lib/mapDefinition.js';
import {addKmlPlace, createPlacesDocument} from '../src/lib/kmlPlaces.js';
import {definitionWithPrintLayouts, newProjectPrintLayout} from '../src/lib/printLayouts.js';

const file = layers => JSON.stringify({...emptyMapDefinition(),layers,persistence:{mode:'browser-only-demo'}});
const layer = {layerId:'local',title:'Local points',sourceType:'geojson-object',geojson:{type:'FeatureCollection',features:[]}};
test('native1.7 retains leaf settings and rejects mislabeled or malformed controls before hydration', () => {
  const document=addKmlPlace(createPlacesDocument(),'opengeo-places',{kind:'placemark',id:'mixed',name:'Mixed',
    geometry:{type:'GeometryCollection',geometries:[
      {type:'Point',coordinates:[12,45,0],kmlControls:{altitudeMode:'absolute',extrude:true,tessellate:false}},
      {type:'Point',coordinates:[13,46,40],kmlControls:{altitudeMode:null,extrude:false,tessellate:false}}
    ]}});
  const definition={...emptyMapDefinition({schemaVersion:KML_MAP_DEFINITION_SCHEMA_VERSION}),
    layers:[{layerId:'mixed',title:'Mixed controls',sourceType:'kml-places',kmlDocument:document}],persistence:{mode:'browser-only-demo'}};
  assert.deepEqual(readBrowserProjectFile(JSON.stringify(definition)).layers[0].kmlDocument,document);
  assert.throws(()=>readBrowserProjectFile(JSON.stringify({...definition,schemaVersion:'opengeo.map-definition.1.3.0'})),/map_kml_geometry_controls_version_required/);
  const invalid=structuredClone(definition);invalid.layers[0].kmlDocument.children[0].geometry.kmlControls={altitudeMode:null,extrude:false,tessellate:false};
  assert.throws(()=>readBrowserProjectFile(JSON.stringify(invalid)),/places_geometry_controls_invalid/);
});
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
