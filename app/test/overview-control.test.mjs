import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {JSDOM} from "jsdom";
import {OverviewControl} from "../src/components/OverviewControl.js";

function fixture(run) {
  const dom=new JSDOM("<!doctype html><body></body>",{pretendToBeVisual:true}), previous=globalThis.document;
  globalThis.document=dom.window.document;
  const handlers=new Map(), calls=[]; let center={lng:0,lat:0};
  const map={getCenter:()=>center,getBounds:()=>({getWest:()=>center.lng-1,getEast:()=>center.lng+1,getSouth:()=>center.lat-1,getNorth:()=>center.lat+1}),
    on:(t,fn)=>handlers.set(t,fn),off:(t,fn)=>{if(handlers.get(t)===fn)handlers.delete(t);},stop(){},
    easeTo:options=>{calls.push(options);center={lng:options.center[0],lat:options.center[1]};},getZoom:()=>9,getBearing:()=>30,getPitch:()=>25};
  const point={type:"FeatureCollection",features:[{type:"Feature",geometry:{type:"LineString",coordinates:[[-2,-2],[2,2]]}}]};
  try {run({dom,map,handlers,calls,point});} finally {globalThis.document=previous;dom.window.close();}
}
const pointer=(dom,target,type,x,y,id=1)=>{const event=new dom.window.MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true});Object.defineProperty(event,"pointerId",{value:id});Object.defineProperty(event,"pointerType",{value:id===2?"touch":"mouse"});target.dispatchEvent(event);};
describe("request-free geographic overview",()=>{
  it("is collapsed without subscriptions, opens actual resident geography, and updates the current extent",()=>fixture(({map,handlers,point})=>{
    const control=OverviewControl(()=>map,{getGeography:()=>[point]});document.body.append(control.element);
    const toggle=control.element.querySelector("button");assert.equal(toggle.getAttribute("aria-expanded"),"false");assert.equal(handlers.size,0);
    toggle.click();assert.equal(handlers.size,3);assert.equal(toggle.getAttribute("aria-expanded"),"true");
    assert.equal(control.element.querySelectorAll(".gis-overview-feature").length,1);assert.ok(control.element.querySelector(".gis-overview-extent"));
    assert.match(control.element.textContent,/Resident Layer geography/);handlers.get("moveend")();
    toggle.click();assert.equal(handlers.size,0);assert.equal(control.element.querySelector(".gis-overview-panel").hidden,true);control.dispose();
  }));
  it("uses native keyboard-operable buttons and equivalent mouse/touch pointer positions without changing other camera fields",()=>fixture(({dom,map,calls,point})=>{
    const control=OverviewControl(()=>map,{getGeography:()=>[point],open:true});document.body.append(control.element);
    const east=control.element.querySelector('[aria-label="Pan main map east"]');east.click();assert.ok(calls[0].center[0]>0);
    const svg=control.element.querySelector("svg");svg.getBoundingClientRect=()=>({left:0,top:0,width:240,height:140});
    pointer(dom,svg,"pointerdown",120,70,1);pointer(dom,svg,"pointerup",150,60,1);const mouse=calls.at(-1).center;
    map.easeTo({center:[0,0]});control.update();pointer(dom,svg,"pointerdown",120,70,2);pointer(dom,svg,"pointerup",150,60,2);
    assert.deepEqual(calls.at(-1).center,mouse);assert.ok(calls.every(x=>!("zoom" in x)&&!("bearing" in x)&&!("pitch" in x)));
    const panel=control.element.querySelector(".gis-overview-panel");panel.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
    assert.equal(document.activeElement,control.element.querySelector("button"));control.dispose();
  }));
  it("cancels gestures and rejects detached old renderer callbacks, then disposes all subscriptions",()=>fixture(({dom,map,handlers,calls})=>{
    let active=map;const control=OverviewControl(()=>active,{open:true});document.body.append(control.element);const svg=control.element.querySelector("svg");svg.getBoundingClientRect=()=>({left:0,top:0,width:240,height:140});
    pointer(dom,svg,"pointerdown",120,70);pointer(dom,svg,"pointercancel",120,70);pointer(dom,svg,"pointerup",180,70);assert.equal(calls.length,0);
    const stale=handlers.get("moveend");active={};stale();control.element.querySelector('[aria-label="Pan main map east"]').click();assert.equal(calls.length,0);
    control.dispose();assert.equal(handlers.size,0);stale();pointer(dom,svg,"pointerdown",120,70);pointer(dom,svg,"pointerup",180,70);assert.equal(calls.length,0);
  }));
  it("bounds malformed geometry and invalid coordinate visits while keeping viewport navigation usable",()=>fixture(({map,calls})=>{
    let reads=0;
    const coordinates=Array(20001).fill([NaN,0]);
    Object.defineProperty(coordinates,10000,{get(){throw Error("unbounded invalid-coordinate tail visited");}});
    for(let i=0;i<10000;i++)Object.defineProperty(coordinates,i,{get(){reads++;return [NaN,0];}});
    const resident=[{type:"LineString",coordinates}];
    let control;
    assert.doesNotThrow(()=>{control=OverviewControl(()=>map,{getGeography:()=>resident,open:true});});
    assert.ok(reads<=10000);assert.ok(control.element.querySelector(".gis-overview-extent"));
    assert.match(control.element.textContent,/limited/);
    control.element.querySelector('[aria-label="Pan main map east"]').click();assert.equal(calls.length,1);control.dispose();
    const malformed=[{type:"FeatureCollection",features:42},{type:"MultiPolygon",coordinates:[null,42,{}]},{type:"GeometryCollection",geometries:{}},{type:"Point",coordinates:[1e308,0]}];
    assert.doesNotThrow(()=>{control=OverviewControl(()=>map,{getGeography:()=>malformed,open:true});});
    assert.ok(Number.isFinite(Number(control.element.querySelector(".gis-overview-extent").getAttribute("x"))));control.dispose();
  }));
  it("lazily clones only visible authorized sources and projects a wider mapped context with owned cleanup",()=>fixture(({dom,map,calls})=>{
    const style={version:8,terrain:{source:"dem"},glyphs:"https://already-authorized.example/fonts/{fontstack}/{range}.pbf",sources:{
      imagery:{type:"raster",tiles:["https://already-authorized.example/{z}/{x}/{y}"],bounds:[-20,40,20,80],minzoom:0,maxzoom:19,scheme:"tms",attribution:"Original credit"},
      hidden:{type:"raster",tiles:["https://must-not-activate.example/{z}"]},dem:{type:"raster-dem",tiles:["https://unused-dem.example/{z}"]}},
      layers:[{id:"base",type:"raster",source:"imagery",paint:{"raster-opacity":.7}},{id:"hidden",type:"raster",source:"hidden",layout:{visibility:"none"}},
        {id:"zoom-hidden",type:"raster",source:"hidden",minzoom:12}]};
    map.getStyle=()=>style;map.getCenter=()=>({lng:10,lat:60});map.getBounds=()=>({getWest:()=>9,getEast:()=>11,getSouth:()=>59,getNorth:()=>61});
    const created=[],removed=[];let fits=[];
    const control=OverviewControl(()=>map,{createMap:options=>{
      const listeners=new Map(),child={on:(t,f)=>listeners.set(t,f),off:(t,f)=>{if(listeners.get(t)===f)listeners.delete(t);},resize(){},
        fitBounds:bounds=>fits.push(bounds),project:([lon,lat])=>({x:120+(lon-10)*10,y:70-Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))*20}),
        unproject:()=>({lng:42,lat:61})};created.push({options,child,listeners});return child;
    },disposeMap:child=>removed.push(child)});
    document.body.append(control.element);assert.equal(created.length,0);control.element.querySelector("button").click();assert.equal(created.length,1);
    const options=created[0].options;assert.deepEqual(Object.keys(options.style.sources),["imagery"]);assert.deepEqual(options.style.sources.imagery,style.sources.imagery);
    assert.notEqual(options.style.sources.imagery,style.sources.imagery);assert.equal(options.style.terrain,undefined);assert.equal(options.style.glyphs,undefined);
    assert.equal(options.interactive,false);assert.equal(options.zoom,7,"start near the primary zoom before broader fitBounds, avoiding transient world tiles");assert.deepEqual(options.attributionControl,{compact:false});assert.ok(fits[0][0][0]<9&&fits[0][1][0]>11&&fits[0][0][1]<59&&fits[0][1][1]>61);
    assert.equal(calls.length,0,"opening does not move the main camera");
    const box=control.element.querySelector(".gis-overview-extent");assert.equal(Number(box.getAttribute("y")),created[0].child.project([10,61]).y);
    control.update();control.update();assert.equal(created.length,1,"ordinary renders reuse the owned child");
    const svg=control.element.querySelector("svg");svg.getBoundingClientRect=()=>({left:0,top:0,width:240,height:140});
    pointer(dom,svg,"pointerdown",120,70);pointer(dom,svg,"pointerup",120,70);assert.deepEqual(calls.at(-1).center,[42,61],"mapped pointer uses public unproject");
    style.sources.vector={type:"vector",url:"https://already-authorized.example/vector.json",attribution:"Vector credit"};
    style.sprite="https://already-authorized.example/sprite";style.layers.push({id:"labels",type:"symbol",source:"vector","source-layer":"places"});
    control.update();assert.equal(created.length,2);assert.equal(created[1].options.style.glyphs,style.glyphs);assert.equal(created[1].options.style.sprite,style.sprite);
    assert.deepEqual(created[1].options.style.sources.vector,style.sources.vector,"normal visible vector basemap identity retained");
    style.sources.imagery.tiles=["https://already-authorized.example/changed/{z}/{x}/{y}"];control.update();assert.equal(created.length,3);assert.equal(removed.length,2,"actual source change retires the old child");
    control.element.querySelector("button").click();assert.equal(removed.length,3);assert.equal(created[2].listeners.size,0);control.dispose();
  }));
  it("preserves authorized resident image identity with boundary geometry and never automatically retries child errors or stale callbacks",()=>fixture(({map})=>{
    map.getStyle=()=>({version:8,sources:{image:{type:"image",url:"blob:owned-original",coordinates:[[0,1],[1,1],[1,0],[0,0]]}},layers:[{id:"image",type:"raster",source:"image"}]});
    const children=[];let disposed=0;
    const control=OverviewControl(()=>map,{getGeography:()=>[{type:"Polygon",coordinates:[[[0,1],[1,1],[1,0],[0,0],[0,1]]]}],createMap:options=>{
      assert.equal(options.style.sources.image.url,"blob:owned-original");const callbacks=new Map();const child={on:(t,f)=>callbacks.set(t,f),off:t=>callbacks.delete(t),resize(){},fitBounds(){},project:([x,y])=>({x,y}),unproject:()=>({lng:0,lat:0})};children.push({child,callbacks});return child;
    },disposeMap:()=>disposed++});document.body.append(control.element);control.element.querySelector("button").click();
    assert.equal(children.length,1,"resident boundary must not replace authorized imagery with an outline-only overview");
    assert.equal(control.element.querySelector(".gis-overview-frame").dataset.mapped,"true");
    assert.equal(control.element.querySelectorAll(".gis-overview-feature").length,1,"boundary remains aligned over mapped imagery");
    const failed=children[0].callbacks.get("error"),stale=children[0].callbacks.get("load");failed();assert.equal(disposed,1);assert.match(control.element.textContent,/unavailable/i);
    assert.equal(control.element.querySelector(".gis-overview-frame").dataset.mapped,"false");
    assert.ok(control.element.querySelector(".gis-overview-water"),"error redraws the coordinate fallback before pointer mapping changes");
    const fallback=control.element.querySelector(".gis-overview-extent");
    assert.ok(Number(fallback.getAttribute("width"))>100,"old projected viewport is replaced by linear fallback extent");
    control.update();control.update();stale();assert.equal(children.length,1,"no automatic retry after source error");
    control.element.querySelector("button").click();control.element.querySelector("button").click();assert.equal(children.length,2,"explicit reopen can retry");
    control.dispose();failed();stale();assert.equal(disposed,2);assert.equal(children[1].callbacks.size,0);
  }));
  it("labels raster-only context honestly, handles dateline extents and reports unsupported adapters",()=>fixture(({map})=>{
    map.getCenter=()=>({lng:179,lat:0});map.getBounds=()=>({getWest:()=>178,getEast:()=>-178,getSouth:()=>-2,getNorth:()=>2});
    const control=OverviewControl(()=>map,{open:true});assert.match(control.element.textContent,/Coordinate locator only/);const rect=control.element.querySelector(".gis-overview-extent");assert.ok(Number(rect.getAttribute("width"))>0);assert.ok(Number(rect.getAttribute("width"))<240);control.dispose();
    const unsupported={}; const unavailable=OverviewControl(()=>unsupported,{open:true});assert.match(unavailable.element.textContent,/does not expose a geographic extent/);unavailable.dispose();
  }));
});
