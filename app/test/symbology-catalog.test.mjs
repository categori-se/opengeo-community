import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {it} from 'node:test';
import {symbologyCatalog} from '../src/lib/symbologyCatalog.js';
import {MASSGIS_SYMBOLOGY} from '../src/lib/massgisSymbology.js';
import {resolveLayerStyle} from '../src/lib/layerStyleReference.js';

const require=createRequire(import.meta.url),{createExpression}=require('@maplibre/maplibre-gl-style-spec');
const uuid='d0000000-0000-4000-8000-000000000002';
async function resolve(definition) {
  const checksumSha256=createHash('sha256').update(definition).digest('hex');
  const style={id:uuid,resourceId:uuid,title:'Library example',versionNumber:1,format:'maplibre',definition,checksumSha256};
  const layer={datasetId:uuid,geometryType:'MultiPolygon',styleReference:{projectId:uuid,resourceId:uuid,styleId:uuid,versionNumber:1,format:'maplibre',checksumSha256}};
  return resolveLayerStyle({getResource:async()=>({id:uuid,projectId:uuid,datasetId:uuid}),getResourceStyleVersion:async()=>style},layer);
}
function evaluate(expression, properties) {
  const compiled=createExpression(expression,{type:'color'});
  assert.equal(compiled.result,'success',JSON.stringify(compiled.value));
  return compiled.value.evaluate({}, {type:3,properties}).toString();
}

it('browses the complete pinned collections and distinct existing land-cover variants',()=>{
  const entries=symbologyCatalog();assert.equal(entries.length,1289);
  assert.equal(new Set(entries.map(e=>e.id)).size,entries.length);
  assert.equal(entries.filter(e=>e.kind==='point').length,1142);
  assert.equal(entries.filter(e=>e.kind==='reference').length,77);
  assert.equal(entries.filter(e=>e.id.startsWith('landcover:')).length,23);
  const water=entries.filter(e=>e.id==='landcover:studio:water'||e.id==='landcover:folio:water');
  assert.equal(water.length,2);assert.notDeepEqual(water[0].recipe.pattern,water[1].recipe.pattern);
  for(const entry of entries) {assert.ok(entry.source.title);assert.ok(entry.source.url);assert.ok(entry.source.license);}
});

it('preserves all 33 MassGIS fields, four recipes and source hash without copying geodata',async()=>{
  const source=await readFile(new URL('../src/data/massgis-enviroscreen.json',import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'),MASSGIS_SYMBOLOGY.sourceSha256);
  const data=JSON.parse(source), expected=[...data.indicatorGroups.flatMap(g=>g.maps),...data.combinedAnalysis.layers];
  const entries=symbologyCatalog().filter(e=>e.id.startsWith('massgis:'));assert.equal(entries.length,33);
  assert.equal(new Set(expected.map(e=>e.style.presetId)).size,4);
  for(const item of expected) {
    const entry=entries.find(e=>e.id===`massgis:${item.slug}`);assert.equal(entry.recipe.field,item.style.field);
    const resolved=await resolve(entry.recipe.definition);assert.ok(resolved.parts.length);
    assert.deepEqual(entry.geometryKinds,['Polygon','MultiPolygon']);
    assert.equal(Object.keys(JSON.parse(entry.recipe.definition).sources).length,0);
  }
});

it('renders every MassGIS ramp at real MapLibre break boundaries and preserves unknown values',async()=>{
  for(const preset of MASSGIS_SYMBOLOGY.presets) {
    const example=MASSGIS_SYMBOLOGY.examples.find(e=>e.presetId===preset.id);
    const entry=symbologyCatalog().find(e=>e.id===`massgis:${example.id}`);
    const resolved=await resolve(entry.recipe.definition);
    const expression=resolved.parts[0].paint[preset.geometry==='line'?'line-color':'fill-color'];
    for(const [value,index] of [[0,0],[19.999,0],[20,1],[40,2],[60,3],[80,4],[100,4]])
      assert.equal(evaluate(expression,{[example.field]:value}),evaluate(preset.colors[index],{}));
    for(const properties of [{},{[example.field]:null},{[example.field]:'unknown'}])
      assert.equal(evaluate(expression,properties),evaluate(preset.nullColor,{}));
  }
});

it('rejects unbounded or executable expression variants in saved numeric styles',async()=>{
  const entry=symbologyCatalog().find(e=>e.id.startsWith('massgis:'));
  const document=JSON.parse(entry.recipe.definition), valid=document.layers[0].paint['fill-color'];
  for(const expression of [
    ['step',['feature-state','value'],'#000000',0,'#ffffff'],
    ['step',['to-number',['coalesce',['get','__proto__'],-1],-1],'#000000',0,'#ffffff'],
    [...valid.slice(0,3),20,'#000000',10,'#ffffff'],
    [...valid.slice(0,3),0,['match',['get','x'],'a','#000000','#ffffff']],
    [...valid.slice(0,3),NaN,'#ffffff']
  ]) {
    const altered=structuredClone(document);altered.layers[0].paint['fill-color']=expression;
    await assert.rejects(resolve(JSON.stringify(altered)),/Unsupported Style color/);
  }
});
