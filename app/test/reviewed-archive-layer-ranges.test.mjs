import assert from 'node:assert/strict';
import {test} from 'node:test';
import {reviewedArchiveLayerRanges} from '../src/lib/reviewedArchiveLayerRanges.js';
import {addMapLayer} from '../src/components/WorkbenchView.js';

const record={min_zoom:7,max_zoom:20,attribution:'Offline fixture',tile_layers:[
  {source_layer:'data',geometry_type:'Polygon'}, {source_layer:'fine',geometry_type:'Polygon'}]};
const metadata={opengeo_layer_zoom_ranges:{version:1,layers:[
  {source_layer:'data',min_zoom:7,max_zoom:14}, {source_layer:'fine',min_zoom:7,max_zoom:20}]}};

test('legacy archives retain the reviewed range; explicit detail ranges stay inside it',()=>{
  assert.deepEqual(reviewedArchiveLayerRanges(record,{}).map(x=>x.maxZoom),[20,20]);
  assert.deepEqual(reviewedArchiveLayerRanges(record,metadata).map(x=>x.maxZoom),[14,20]);
  for(const patch of [{max_zoom:21},{min_zoom:6},{min_zoom:15,max_zoom:14},{max_zoom:'14'},{source_layer:'unknown'}]){
    const changed=structuredClone(metadata);Object.assign(changed.opengeo_layer_zoom_ranges.layers[0],patch);
    assert.throws(()=>reviewedArchiveLayerRanges(record,changed),/Invalid archive/);
  }
  const duplicate=structuredClone(metadata);duplicate.opengeo_layer_zoom_ranges.layers[1].source_layer='data';
  assert.throws(()=>reviewedArchiveLayerRanges(record,duplicate),/Invalid archive/);
});

test('one hidden catalog layer attaches coarse and fine sources and tracks both for removal',()=>{
  const sources=[],paints=[];
  const state={map:{addSource(id,value){sources.push({id,...value});},addLayer(value){paints.push(value);},getStyle(){return {layers:[]};}},
    layerHandles:new Map(),archiveTileSessions:new Map([['fixture',{url:'reviewed-archive://fixture/tiles.json',record,
      layerRanges:reviewedArchiveLayerRanges(record,metadata),source:{stats:()=>({closed:false})}}]])};
  addMapLayer(state,{layerId:'fixture',geometryType:'Polygon',visible:false,style:{}},null,[]);
  assert.equal(sources.length,2);
  assert.match(sources[0].url,/source_layer=data$/);assert.match(sources[1].url,/source_layer=fine$/);
  assert.ok(paints.length>=2&&paints.every(p=>p.layout.visibility==='none'));
  for(const paint of paints)assert.equal(paint.source,sources[paint['source-layer']==='data'?0:1].id);
  assert.deepEqual(state.layerHandles.get('fixture').sourceIds,sources.map(s=>s.id));
});

test('paired overview and vector detail have disjoint zooms and share layer lifecycle',()=>{
  const sources=[],paints=[];
  const archive={url:'reviewed-archive://fixture/tiles.json',record:{...record,max_zoom:14,tile_layers:[record.tile_layers[0]]},
    header:{minLon:88,minLat:26,maxLon:92,maxLat:29},layerRanges:[{sourceLayer:'data',minZoom:12,maxZoom:14}],
    raster:{review:{min_zoom:7,max_zoom:11,vector_min_zoom:12,tile_size:512}},source:{stats:()=>({closed:false})}};
  const state={map:{addSource(id,value){sources.push({id,...value});},addLayer(value){paints.push(value);},getStyle(){return {layers:[]};}},
    layerHandles:new Map(),archiveTileSessions:new Map([['fixture',archive]])};
  addMapLayer(state,{layerId:'fixture',geometryType:'Polygon',visible:false,style:{}},null,[]);
  const raster=paints.find(p=>p.type==='raster');
  assert.equal(raster.minzoom,7);assert.equal(raster.maxzoom,12);
  assert.ok(paints.filter(p=>p.type!=='raster').every(p=>p.minzoom===12));
  assert.ok(paints.every(p=>p.layout.visibility==='none'));
  assert.equal(sources.find(s=>s.type==='raster').maxzoom,11);
  const handle=state.layerHandles.get('fixture');
  assert.deepEqual(handle.sourceIds,sources.map(s=>s.id));
  assert.ok(handle.layerIds.includes(raster.id));assert.equal(handle.rasterOverviewId,raster.id);
});
