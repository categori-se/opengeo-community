import assert from "node:assert/strict";
import {test} from "node:test";
import {EventEmitter} from "node:events";
import {withPrintResolution} from "../src/components/WorkbenchView.js";

function fixture({firstRender, render = true, clamp = false, automatic = false} = {}) {
  const map = new EventEmitter(), canvas = {clientWidth:600, clientHeight:300, width:750, height:375};
  let devicePixelRatio = 1.25, scheduled = false, frames = 0;
  map._overridePixelRatio = automatic ? undefined : 1.25;
  const layers = [{layerId:"local", datasetId:"source", datasetVersionId:"version-7", sourceVersion:"sha256:exact",
    styleReference:{styleId:"style", version:4}, style:{circleColor:"#2563eb"}, labels:{}}];
  const style = {version:8, sources:{local:{type:"geojson", data:{type:"FeatureCollection", features:[]}}},
    layers:[{id:"local-points", type:"circle", source:"local", paint:{"circle-color":"#2563eb"}}]};
  const camera = {center:[12,34], zoom:5, pitch:0, bearing:10}, padding = {top:10,right:20,bottom:30,left:40};
  const context = {state:{map}, shell:{}, layers, disposed:false};
  context.shell.getPrintContext = () => ({map:context.state.map, ready:true, renderer:"maplibre", layers});
  map.getCanvas = () => canvas;
  map.getStyle = () => structuredClone(style);
  map.getPadding = () => ({...padding});
  map.getCenter = () => ({lng:camera.center[0], lat:camera.center[1]});
  for (const key of ["zoom","pitch","bearing"]) map[`get${key[0].toUpperCase()}${key.slice(1)}`] = () => camera[key];
  map.getPixelRatio = () => map._overridePixelRatio ?? devicePixelRatio;
  map.isStyleLoaded = map.areTilesLoaded = map.loaded = () => true;
  map.isMoving = () => false;
  const changes = [], events = [];
  for (const name of ["move","moveend","idle"]) map.on(name, () => events.push({name, guarded:Boolean(context.printResolutionCapture)}));
  map.setPixelRatio = value => {
    map._overridePixelRatio = value;changes.push(value);
    const effective = map.getPixelRatio();
    canvas.width = Math.floor(canvas.clientWidth * (clamp && changes.length === 1 ? effective / 2 : effective));
    canvas.height = Math.floor(canvas.clientHeight * (clamp && changes.length === 1 ? effective / 2 : effective));
    for (const name of ["move","moveend"]) map.emit(name);
  };
  map.triggerRepaint = () => {
    if (scheduled || !render) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;frames++;
      if (frames === 1) firstRender?.({context,map,canvas,style,camera,padding,layers});
      map.emit("render");map.emit("idle");
    });
  };
  const clean = () => {
    assert.equal(context.printResolutionCapture, null);
    assert.equal(context.cancelPrintResolution, null);
    assert.equal(map.listenerCount("render"), 0);
    assert.equal(map.listenerCount("error"), 0);
    assert.equal(map.listenerCount("remove"), 0);
  };
  return {context,map,canvas,style,camera,padding,layers,changes,events,clean,setDevicePixelRatio:value=>{devicePixelRatio=value;}};
}

test("print resolution re-rasterizes the same loaded viewport and restores the buffer before releasing its guard", async () => {
  for (const automatic of [false,true]) {
    const value = fixture({automatic}), before = structuredClone({style:value.style,camera:value.camera,padding:value.padding,layers:value.layers});
    const phases = [];
    const result = await withPrintResolution(value.context, {maxWidth:1200,maxHeight:900,onPhase:phase=>phases.push(phase)}, async current => {
      assert.equal(current.map, value.map);
      assert.deepEqual([value.canvas.width,value.canvas.height], [1200,600]);
      assert.deepEqual([value.canvas.clientWidth,value.canvas.clientHeight], [600,300]);
      assert.equal(current.layers[0].datasetVersionId, "version-7");
      return "captured";
    });
    assert.equal(result, "captured");
    assert.deepEqual(value.changes, [2,automatic ? null : 1.25]);
    assert.deepEqual([value.canvas.width,value.canvas.height], [750,375]);
    assert.deepEqual({style:value.style,camera:value.camera,padding:value.padding,layers:value.layers}, before);
    assert.deepEqual(phases, ["rendering","capturing","restoring"]);
    assert.ok(value.events.length > 0 && value.events.every(event=>event.guarded));
    value.setDevicePixelRatio(2);
    assert.equal(value.map.getPixelRatio(), automatic ? 2 : 1.25);
    value.clean();
  }
});

test("graphics failure rejects capture immediately with its recovery message", async () => {
  let captured = false;
  const context = {shell:{getPrintContext:()=>({map:null,ready:false,renderer:"maplibre",
    unavailableReason:"Map graphics unavailable. Retry the map before capturing."})}};
  await assert.rejects(withPrintResolution(context, {maxWidth:1200,maxHeight:900}, () => {captured=true;}),
    /Map graphics unavailable.*Retry/);
  assert.equal(captured,false);
  assert.equal(context.printResolutionCapture,undefined);
});

test("changed map/style/camera/padding/source pin/viewport and GPU clamping cannot produce an accepted capture", async () => {
  const changes = [
    ({context}) => {context.state.map = null;},
    ({style}) => {style.layers[0].paint["circle-color"] = "#ff0000";},
    ({camera}) => {camera.zoom++;},
    ({padding}) => {padding.left++;},
    ({layers}) => {layers[0].datasetVersionId = "version-8";},
    ({canvas}) => {canvas.clientWidth++;}
  ];
  for (const change of changes) {
    const value = fixture({firstRender:change});let captures = 0;
    await assert.rejects(withPrintResolution(value.context,{maxWidth:1200,maxHeight:900},()=>{captures++;}), /changed while capturing/);
    assert.equal(captures,0);
    if (value.context.state.map) assert.equal(value.map.getPixelRatio(),1.25);
    value.clean();
  }
  const value = fixture({clamp:true});
  await assert.rejects(withPrintResolution(value.context,{maxWidth:1200,maxHeight:900},()=>{}), /lower DPI/);
  assert.equal(value.map.getPixelRatio(),1.25);value.clean();
});

test("capture failure, abort, timeout and concurrent attempts release listeners and restore the original ratio", async () => {
  for (const cancel of [false,true]) {
    const value = fixture(), controller = new AbortController();
    const pending = withPrintResolution(value.context,{maxWidth:1200,maxHeight:900,signal:controller.signal}, async () => {
      await assert.rejects(withPrintResolution(value.context,{maxWidth:600,maxHeight:300},()=>{}), /already running/);
      if (cancel) {controller.abort();return new Promise(()=>{});}
      throw Error("snapshot refused");
    });
    await assert.rejects(pending, cancel ? /cancelled/ : /snapshot refused/);
    assert.equal(value.map.getPixelRatio(),1.25);value.clean();
  }
  const value = fixture();
  const originalRepaint = value.map.triggerRepaint;
  value.map.triggerRepaint = () => {if (value.changes.length > 1) originalRepaint();};
  await assert.rejects(withPrintResolution(value.context,{maxWidth:1200,maxHeight:900},()=>{}), /settle|print frame/);
  assert.equal(value.map.getPixelRatio(),1.25);value.clean();
});
