import assert from 'node:assert/strict';
import test from 'node:test';
import {compileCesiumPass} from '../src/lib/cesiumStyle.js';
import {cesiumLayerCompatibility,cesiumPassFeatures} from '../src/lib/cesiumLayers.js';
import {graduatedColorExpression} from '../src/lib/thematicStyle.js';
const feature=(properties={},type='Polygon')=>({type:'Feature',id:'original',properties,geometry:{type,coordinates:type==='Point'?[0,0]:[[[0,0],[1,0],[1,1],[0,0]]]}});
test('upstream expressions retain categorical colour, straight alpha and numeric dimensions',()=>{
 const part={type:'circle',paint:{'circle-color':['match',['get','kind'],['a','b'],'#ff000080','#00ff00'],
   'circle-radius':['interpolate',['linear'],['number',['get','score'],0],0,2,100,12],'circle-opacity':.5}};
 const before=JSON.stringify(part),paint=compileCesiumPass(part).paint(feature({kind:'b',score:50},'Point'));
 assert.deepEqual(paint['circle-color'],[1,0,0,128/255]);assert.equal(paint['circle-radius'],7);assert.equal(paint['circle-opacity'],.5);
 assert.equal(JSON.stringify(part),before);
});
test('graduated Styles use their existing five classes and explicit no-data branch',()=>{
 const program=compileCesiumPass({type:'fill',paint:{'fill-color':graduatedColorExpression({field:'score'})}});
 const expected=['#440154','#3b528b','#21918c','#5ec962','#fde725','#9ca3af','#9ca3af','#9ca3af'];
 [0,20,40,60,80,null,'20',undefined].forEach((score,index)=>{
   const rgb=program.paint(feature({score}))['fill-color'];
   assert.equal('#'+rgb.slice(0,3).map(value=>Math.round(value*255).toString(16).padStart(2,'0')).join(''),expected[index]);
 });
});
test('canonical filters retain original indices and also filter polygon outlines',()=>{
 const part={type:'fill',filter:['!=',['get','status'],'excluded'],paint:{'fill-color':'#ff0000'}};
 const program=compileCesiumPass(part),data={type:'FeatureCollection',features:[feature({status:'excluded'}),feature({status:'keep'})]};
 const before=JSON.stringify(data);
 for(const type of ['fill','line'])assert.deepEqual(cesiumPassFeatures(data,type,f=>program.accepts(f)).features.map(f=>f.properties.opengeoFeatureIndex),[1]);
 assert.equal(cesiumLayerCompatibility([{layer:{layerId:'a',filter:part.filter},geojson:data,parts:[part]}]).ready,true);
 assert.equal(JSON.stringify(data),before);
});
test('context-sensitive or oversized expressions and invalid feature results never substitute paint',()=>{
 for(const expression of [['feature-state','color'],['get','color',['global-state','theme']],['interpolate',['linear'],['zoom'],0,'#000000',20,'#ffffff'],['image','texture']])
   assert.throws(()=>compileCesiumPass({type:'fill',paint:{'fill-color':expression}}));
 assert.throws(()=>compileCesiumPass({type:'fill',paint:{'fill-color':['match',['get','k'],Array.from({length:2100},(_,i)=>i),'#ff0000','#000000']}}));
 assert.throws(()=>compileCesiumPass({type:'fill',paint:{'fill-color':['get','color']}}).paint(feature({color:'not a colour'})));
 assert.throws(()=>compileCesiumPass({type:'circle',paint:{'circle-radius':['number',['get','size']]}}).paint(feature({size:-2})));
 assert.throws(()=>compileCesiumPass({type:'fill',paint:{'fill-color':'red'}}).paint(feature(),{remaining:0}),/evaluation_limit/);
});
