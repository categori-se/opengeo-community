import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {rasterValidationPanel} from "../src/components/WorkbenchView.js";
import {createRasterValidationPlan,createRasterValidationAssessment,rasterValidationGeoJson,rasterValidationJson} from "../src/lib/rasterValidation.js";

async function collection() {
  const grid={width:2,height:1,active:()=>true,metadata:{bands:[1],window:[0,0,2,1],projection:"EPSG:4326",interpretation:"area",imageIndex:0,
    scaleX:1,scaleY:1,origin:[0,1,0],resolution:[.001,-.001,0],noData:-9999,source:{url:"https://example.org/validation.tif",etag:'"classes"',size:4096}},
    coordinate:(column,row,corner=false)=>[(column+(corner?0:.5))*.001,1-(row+(corner?0:.5))*.001],value:column=>column===0?10:20};
  const plan=await createRasterValidationPlan({input:{grid,band:1,categoricalConfirmed:true,crosswalk:{10:"trees",20:"field"},
    pins:{layerId:"original-raster",sourceType:"cog-raster",sourceVersion:1}},seed:"workbench-fixed-seed",samplesPerStratum:2,
    referenceClasses:["trees","field"],question:"Assess the frozen eligible whole cells.",labelingProtocol:"Inspect each entire cell against dated reference imagery.",yieldControl:async()=>{}});
  return rasterValidationGeoJson(createRasterValidationAssessment(plan));
}
async function harness() {
  const dom=new JSDOM("<!doctype html><body></body>"),prior=globalThis.document;globalThis.document=dom.window.document;
  const data=await collection(),layer={layerId:"sample-layer",datasetId:null,title:"Sample review",sourceType:"geojson-object",visible:true},updates=[],fits=[],adds=[];
  const context={workspace:{workspaceId:"workspace"},project:{projectId:"project"},layers:[layer],datasets:[],dataByLayerId:new Map([[layer.layerId,data]]),
    shell:document.createElement("div"),state:{activeLayerId:layer.layerId,activePanel:"processing",spatialBody:{id:"earth"},layerHandles:new Map(),managedCogBindings:new Map(),processingRunSequence:0,
      map:{getSource:()=>({setData:value=>updates.push(value)}),isStyleLoaded:()=>false,fitBounds:(...args)=>fits.push(args)}}};
  context.render=()=>rasterValidationPanel(context);
  context.addLayer=(next,geojson,options)=>{adds.push({layer:next,data:geojson,options});context.layers.unshift(next);context.dataByLayerId.set(next.layerId,geojson);context.state.activeLayerId=next.layerId;context.state.activePanel=options.panelAfterAdd;context.render();};
  const view=rasterValidationPanel(context);document.body.append(view);
  const control=title=>view.querySelector(`[aria-label="${title}"]`),button=title=>[...view.querySelectorAll("button")].find(value=>value.textContent===title);
  const review=()=>{control("Reference class").value="trees";control("Reviewer").value="Analyst";control("Reference evidence (source, date and version)").value="Reference imagery 2022-01-15, v3";
    control("Cell review note").value="The whole cell follows the declared labeling rule.";return view.querySelectorAll("form")[1].onsubmit(new dom.window.Event("submit",{cancelable:true}));};
  return {context,view,data,layer,updates,fits,adds,control,button,review,close(){view.dispose();globalThis.document=prior;dom.window.close();}};
}

test("Processing review replaces the same active sample collection and map source without reopening the raster",async()=>{
  const h=await harness();
  try {
    assert.equal(rasterValidationPanel(h.context),h.view);assert.equal(h.context.state.layerHandles.size,0);
    await h.review();const saved=h.context.dataByLayerId.get(h.layer.layerId);
    assert.notEqual(saved,h.data);assert.equal(saved["opengeo:analysis"].rasterValidation.reviews.length,1);
    assert.equal(h.data["opengeo:analysis"].rasterValidation.reviews.length,0);assert.equal(h.context.layers.length,1);
    assert.deepEqual(h.updates,[saved]);assert.equal(saved.features.length,4);assert.equal(h.context.state.activePanel,"processing");
    h.button("Focus selected cell").click();assert.equal(h.fits.length,1);assert.equal(h.fits[0][1].maxZoom,22);
  }finally{h.close();}
});

test("a started Catalog registration freezes review while retaining focus and exports",async()=>{
  const h=await harness();
  try {
    h.context.baselineRegistrations=new Map([[h.layer.layerId,{layerId:h.layer.layerId,session:{}}]]);rasterValidationPanel(h.context);
    assert.equal(h.button("Record cell review").disabled,true);assert.equal(h.button("Focus selected cell").disabled,false);assert.equal(h.button("Download assessment JSON").disabled,false);
    await h.review();assert.equal(h.updates.length,0);assert.equal(h.context.dataByLayerId.get(h.layer.layerId),h.data);
  }finally{h.close();}
});

test("selection and account changes during review cannot overwrite another draft",async()=>{
  for(const change of [h=>{h.context.state.activeLayerId="other";h.context.layers.push({...h.layer,layerId:"other"});h.context.dataByLayerId.set("other",structuredClone(h.data));},
    h=>{h.context.queryLocationScopeInvalid=true;}]) {
    const h=await harness();
    try {const pending=h.review();change(h);await pending;assert.equal(h.updates.length,0);assert.equal(h.context.dataByLayerId.get(h.layer.layerId),h.data);}
    finally{h.close();}
  }
});

test("opening a saved assessment adds a distinct temporary Layer and keeps Processing active",async()=>{
  const h=await harness();
  try {
    const text=rasterValidationJson(h.data["opengeo:analysis"].rasterValidation);
    await h.view.openAssessmentFile({size:new TextEncoder().encode(text).byteLength,text:async()=>text});
    assert.equal(h.adds.length,1);assert.notEqual(h.adds[0].layer.layerId,h.layer.layerId);assert.equal(h.adds[0].layer.datasetId,null);
    assert.equal(h.adds[0].layer.sourceType,"geojson-object");assert.equal(h.adds[0].options.panelAfterAdd,"processing");assert.equal(h.context.state.activePanel,"processing");
    assert.equal(h.context.dataByLayerId.get(h.layer.layerId),h.data);assert.deepEqual(h.adds[0].data["opengeo:analysis"].rasterValidation,h.data["opengeo:analysis"].rasterValidation);
  }finally{h.close();}
});
