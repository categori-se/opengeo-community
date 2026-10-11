import assert from 'node:assert/strict';
import {reviewedRasterOverview,validateVectorZoomRange,validateOverviewHeader,validateOverviewPng} from '../src/lib/reviewedRasterOverview.js';
const object={bucket:'bucket',prefix:'private/',expected_owner:'123456789012',key:'private/vector',sha256:'a'.repeat(64),size_bytes:128,decoded_size_bytes:128,feature_count:10};
const overview={object_index:1,min_zoom:7,max_zoom:11,vector_min_zoom:12,tile_size:512,description:'Class overview',recipe:{version:1,tile_size:512,zooms:[7,8,9,10,11],sourceVectorSha256:object.sha256}};
const record={objects:[object,{...object,key:'private/raster',feature_count:0}],raster_overview:overview,min_zoom:7,max_zoom:14,feature_count:10,download_bytes:256,decoded_bytes:256,tile_layers:[{geometry_type:'Polygon'}]};
assert.equal(reviewedRasterOverview(record),overview);
for(const mutate of [r=>r.objects[1].feature_count++,r=>r.objects[1].bucket='other',r=>r.download_bytes++,r=>r.raster_overview.vector_min_zoom=11,r=>r.raster_overview.recipe.sourceVectorSha256='b'.repeat(64)]){
 const bad=structuredClone(record);mutate(bad);assert.throws(()=>reviewedRasterOverview(bad));
}
const header={specVersion:3,tileType:2,tileCompression:1,minZoom:7,maxZoom:11,minLon:88,minLat:26,maxLon:92,maxLat:29};
validateOverviewHeader(overview,header,header,{opengeo_raster_overview:overview.recipe});
assert.throws(()=>validateOverviewHeader(overview,{...header,tileType:1},header,{opengeo_raster_overview:overview.recipe}));
assert.throws(()=>validateOverviewHeader(overview,header,{...header,minLon:89},{opengeo_raster_overview:overview.recipe}));
assert.throws(()=>validateOverviewPng(new Uint8Array(33)));
const png=new Uint8Array(33);png.set([137,80,78,71,13,10,26,10]);const view=new DataView(png.buffer);view.setUint32(8,13);view.setUint32(12,0x49484452);view.setUint32(16,512);view.setUint32(20,512);png[24]=8;png[25]=3;
assert.equal(validateOverviewPng(png),png);view.setUint32(16,65536);assert.throws(()=>validateOverviewPng(png));
console.log('Reviewed raster overview identity, zoom, bounds and image-budget checks passed');

// A paired logical Layer covers zooms 7–14 while vector detail may start at 12.
const reviewedPair=reviewedRasterOverview(record);
for(const minZoom of [7,12]) validateVectorZoomRange(record,{minZoom,maxZoom:14},reviewedPair);
for(const minZoom of [6,8,11,13]) assert.throws(()=>validateVectorZoomRange(record,{minZoom,maxZoom:14},reviewedPair));
assert.throws(()=>validateVectorZoomRange(record,{minZoom:12,maxZoom:14},null));
validateVectorZoomRange(record,{minZoom:7,maxZoom:14},null);
assert.throws(()=>validateVectorZoomRange(record,{minZoom:12,maxZoom:19},reviewedPair));
