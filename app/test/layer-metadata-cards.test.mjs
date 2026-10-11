import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {LayerMetadataCards, ARCGIS_METADATA_PROPERTY, ARCHIVE_CAPTURE_PROPERTY} from '../src/components/LayerMetadataCards.js';
import {loadProviderPreview} from '../src/lib/catalogLayerPreview.js';
it('keeps provider geometry, schema, zero values and archive provenance distinct from current versions',()=>{
 const dom=new JSDOM('<!doctype html>');const old=globalThis.document;globalThis.document=dom.window.document;
 try {
  const knowledge={version:2,document:{metadata:{normalized:[{subject:'resource',property:ARCGIS_METADATA_PROPERTY,value:{name:'Parcels',geometryType:'esriGeometryPolygon',description:'<b>Parcel boundaries</b><img src="https://invalid.example/spy">',extent:{xmin:100,ymin:200,xmax:300,ymax:400,spatialReference:{wkid:102100,latestWkid:3857}},hasZ:false,hasM:false,minScale:0,maxScale:1128,fields:[{name:'status',alias:'Status',type:'esriFieldTypeString',nullable:false,length:50,domain:{type:'codedValue',codedValues:[{name:'Complete',code:'C'}]}}]}},{subject:'resource',property:ARCHIVE_CAPTURE_PROPERTY,value:{featureCount:81,providerCount:81,capturedAt:null,observationKind:'Historical capture',sha256:'a'.repeat(64)}}]}}};
  const node=LayerMetadataCards({dataset:{featureCount:0},knowledge});
  assert.match(node.textContent,/GeometryPolygon/);assert.match(node.textContent,/WKID 3857 \(source 102100\)/);assert.match(node.textContent,/Elevation \(Z\)No/);assert.match(node.textContent,/Current version features0Captured features81/);
  assert.match(node.textContent,/Capture timeNot recorded/);assert.match(node.textContent,/Status/);assert.match(node.textContent,/Required/);assert.equal(node.querySelectorAll('tbody tr').length,1);assert.equal(node.querySelector('img'),null);
 }finally{globalThis.document=old;dom.window.close();}
});
it('preserves small parcel rings and holes without provider simplification or rounding',async()=>{
 const ring=[[90.1,26.8000011],[90.1000037,26.8000011],[90.1000037,26.8000046],[90.1,26.8000046],[90.1,26.8000011]];
 const geometry={type:'Polygon',coordinates:[ring,ring.map(([x,y])=>[x+0.0000001,y+0.0000001])]};
 const result=await loadProviderPreview('https://nsdi.systems.gov.bt/server/rest/services/Hosted/test/FeatureServer/0',{fetchImplementation:async url=>{
  const u=new URL(url);
  if(!u.pathname.endsWith('/query'))return Response.json({capabilities:'Query',supportedQueryFormats:'geoJSON',objectIdField:'fid',fields:[{name:'fid'}],maxRecordCount:1000,advancedQueryCapabilities:{supportsPagination:true}});
  assert.equal(u.searchParams.has('maxAllowableOffset'),false);assert.equal(u.searchParams.has('geometryPrecision'),false);
  return Response.json({type:'FeatureCollection',features:[{type:'Feature',properties:{fid:1},geometry}]});
 }});assert.deepEqual(result.geojson.features[0].geometry,geometry);
});
