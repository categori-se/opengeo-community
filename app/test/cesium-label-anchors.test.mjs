import assert from 'node:assert/strict';
import test from 'node:test';
import Polygon from 'ol/geom/Polygon.js';
import {cesiumLabelAnchors} from '../src/lib/cesiumLabelAnchors.js';
import {cesiumLayerCompatibility} from '../src/lib/cesiumLayers.js';
import {PINNED_MAP_FONT} from '../src/lib/mapFonts.js';
const feature=(type,coordinates,id='original')=>({type:'Feature',id,properties:{name:'Retained',provider:'Source'},geometry:{type,coordinates}});
const data=features=>({type:'FeatureCollection',features});
const outer=[[-4,-4],[4,-4],[4,4],[-4,4],[-4,-4]],hole=[[-1,-1],[-1,1],[1,1],[1,-1],[-1,-1]];
const part={id:'fill',type:'fill',paint:{'fill-color':'#ff0000'}};
function report(geojson){return cesiumLayerCompatibility([{layer:{layerId:'areas',labels:{enabled:true,field:'name',fontRef:PINNED_MAP_FONT}},geojson,parts:[part],labelPart:{type:'symbol'}}]);}
test('area anchors stay inside concave polygons and outside holes without mutating sources',()=>{
 const concave=[[[0,0],[6,0],[6,1],[1,1],[1,5],[6,5],[6,6],[0,6],[0,0]]];
 const original=data([feature('Polygon',[outer,hole]),feature('Polygon',concave)]),before=JSON.stringify(original);
 const anchors=cesiumLabelAnchors(original);
 for(let i=0;i<2;i++)assert.equal(new Polygon(original.features[i].geometry.coordinates).intersectsCoordinate(anchors.features[i].geometry.coordinates),true);
 assert.equal(new Polygon([hole]).intersectsCoordinate(anchors.features[0].geometry.coordinates),false);
 assert.equal(JSON.stringify(original),before);assert.equal(report(original).ready,true);
});
test('multipart occurrences retain original indices, IDs and filter exclusions',()=>{
 const original=data([feature('Polygon',[outer,hole],'excluded'),feature('MultiPolygon',[[outer,hole],[outer]],'islands'),feature('MultiLineString',[[[1,2],[3,4]],[[5,6],[7,8]]],'rivers')]);
 const anchors=cesiumLabelAnchors(original,f=>f.id!=='excluded');
 assert.deepEqual(anchors.features.map(f=>f.properties.opengeoFeatureIndex),[1,1,2,2]);
 assert.deepEqual(anchors.features.slice(2).map(f=>f.geometry.coordinates),[[1,2],[5,6]]);
 assert.equal(new Set(anchors.features.map(f=>f.id)).size,4);
 assert.ok(anchors.features.every(f=>Object.keys(f.properties).join()==='opengeoFeatureIndex'));
});
test('area anchors cross the antimeridian without being placed near Greenwich or in a hole',()=>{
 const outer=[[170,-10],[-170,-10],[-170,10],[170,10],[170,-10]],hole=[[175,-5],[-175,-5],[-175,5],[175,5],[175,-5]];
 const [longitude,latitude]=cesiumLabelAnchors(data([feature('Polygon',[outer,hole])])).features[0].geometry.coordinates;
 assert.ok(Math.abs(longitude)>170 && Math.abs(longitude)<175);assert.ok(Math.abs(latitude)<10);
});
test('native admission bounds multipart occurrences and polygon work and declines polar labels',()=>{
 assert.ok(report(data([feature('MultiPolygon',Array.from({length:5001},()=>[outer]))])).issues.some(issue=>issue.code==='label-limit'));
 assert.ok(report(data([feature('Polygon',[Array.from({length:8000},()=>[0,0])])])).issues.some(issue=>issue.code==='label-geometry-limit'));
 assert.ok(report(data([feature('Polygon',[[[0,86],[1,86],[1,87],[0,86]]])])).issues.some(issue=>issue.code==='labels'));
 assert.throws(()=>cesiumLabelAnchors(data([feature('Polygon',[[[0,0],[1,0],[2,0],[0,0]]])])),/anchor_invalid/);
});
