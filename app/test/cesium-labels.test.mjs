import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {loadCesiumLabelFont,CESIUM_FONT_ROOT} from '../src/lib/cesiumLabels.js';
import {isCredentialFreeShellPath} from '../scripts/studio-pwa-assets.mjs';

test('native fonts verify original bytes, reject substitution and release their registration',async()=>{
 const originalFetch=globalThis.fetch,calls=[],faces=new Set();let corrupt=false;
 const doc={defaultView:{FontFace:class {async load(){return this;}}},fonts:{add:face=>faces.add(face),delete:face=>faces.delete(face)},createElement:()=>({getContext:()=>({measureText:text=>({width:text.length*7})})})};
 try {
  globalThis.fetch=async(url,options)=>{
   assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');calls.push(url);
   const bytes=await readFile(new URL('../src/assets/render-fonts/opengeo-open-sans-v1/1/'+url.split('/').at(-1),import.meta.url));
   if(corrupt && url.endsWith('.ttf'))bytes[0]^=1;
   return new Response(bytes);
  };
  const font=await loadCesiumLabelFont(doc);
  assert.match(font.text('Site A',18).font,/OpenGeo Open Sans v1/);assert.equal(faces.size,1);
  assert.throws(()=>font.text('樹',18),/coverage_missing/);
  assert.equal(font.text('A'.repeat(40),18).text,'A'.repeat(40),'Unbroken words retain their text');
  assert.equal(font.text('Site A monitoring location',12).text,'Site A monitoring\nlocation');
  assert.equal(font.text('First\nSecond',18).text,'First\nSecond');
  font.destroy();assert.equal(faces.size,0);
  corrupt=true;await assert.rejects(loadCesiumLabelFont(doc),/font_mismatch/);assert.equal(faces.size,0);
  assert.equal(calls.length,4);
  assert.equal(isCredentialFreeShellPath(`${CESIUM_FONT_ROOT.slice(1)}OpenSans-Regular.ttf`),false);
 } finally {globalThis.fetch=originalFetch;}
});

test('screen-space label placement respects overlap, priority, offscreen and hidden labels',async()=>{
 const {selectCesiumLabels}=await import('../src/lib/cesiumLabelLayout.js');
 const box={minX:10,minY:20,maxX:80,maxY:50};
 const items=[{id:'top',visible:true,box},{id:'lower',visible:true,box},{id:'hidden',visible:false,box:{minX:100,minY:20,maxX:180,maxY:50}},{id:'visible',visible:true,box:{minX:100,minY:20,maxX:180,maxY:50}},{id:'offscreen',visible:true,box:{minX:210,minY:0,maxX:280,maxY:50}}];
 assert.deepEqual([...selectCesiumLabels(items,200,200)],['top','visible']);
 items[1].allowOverlap=true;assert.deepEqual([...selectCesiumLabels(items,200,200)],['top','lower','visible']);
 items[0].visible=false;items[1].allowOverlap=false;assert.deepEqual([...selectCesiumLabels(items,200,200)],['lower','visible']);
});
