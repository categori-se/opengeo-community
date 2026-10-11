import assert from 'node:assert/strict';
import test from 'node:test';
import {cesiumBasemapContent,validateCesiumBasemap} from '../src/lib/cesiumBasemap.js';
import {REVIEWED_KEY_FREE_BASEMAPS} from '../src/lib/reviewedBasemapSources.js';
import {ESRI_BASEMAP_OPTIONS} from '../src/lib/esriBasemaps.js';
const candidates=[...REVIEWED_KEY_FREE_BASEMAPS.filter(s=>s.kind==='raster'),{...ESRI_BASEMAP_OPTIONS[0],minZoom:0,maxZoom:23}];
function style(source){return {sources:{basemap:{type:'raster',tiles:[source.url],tileSize:source.tileSize,minzoom:source.minZoom,maxzoom:source.maxZoom}},layers:[{id:'basemap',source:'basemap',type:'raster',paint:{'raster-opacity':.35}}]};}
test('maps existing public raster identity, limits, opacity and attribution without mutation',()=>{
 for(const source of candidates){const input=style(source),before=JSON.stringify(input),{basemap}=cesiumBasemapContent(input,'original-id');
 assert.equal(basemap.basemapId,'original-id');assert.equal(basemap.opacity,.35);assert.equal(basemap.url,source.url);assert.equal(basemap.maxZoom,source.maxZoom);assert.equal(basemap.attribution,source.attribution);assert.equal(JSON.stringify(input),before);
 input.layers[0].layout={visibility:'none'};assert.equal(cesiumBasemapContent(input).basemap.visible,false);}
});
test('unmapped, credentialed or modified representations retain explicit plain-globe fallback',()=>{
 const input=style(candidates[0]);input.sources.basemap.tiles[0]+='?token=private';assert.equal(cesiumBasemapContent(input).basemap,null);
 const paint=style(candidates[0]);paint.layers[0].paint['raster-hue-rotate']=45;assert.equal(cesiumBasemapContent(paint).basemap,null);
 const mapped=cesiumBasemapContent(style(candidates[0])).basemap;
 for(const change of [{maxZoom:25},{minZoom:6},{opacity:NaN},{url:'https://unreviewed.example/{z}/{x}/{y}.png'},{scheme:'tms'}])assert.throws(()=>validateCesiumBasemap({...mapped,...change}));
 assert.equal(cesiumBasemapContent({sources:{},layers:[]}).basemap,null);
});
