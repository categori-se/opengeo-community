import assert from "node:assert/strict";
import {test} from "node:test";
import {computeRasterBaseline,rasterBaselineJson,rasterBaselineCsv} from "../src/lib/rasterBaseline.js";
import {RasterBaseline} from "../src/components/RasterBaseline.js";

function grid(values=[[10,20],[10,null]]) {
  let reads=0;
  return {width:2,height:2,metadata:{bands:[1],window:[0,0,2,2],projection:"EPSG:4326",interpretation:"area",imageIndex:0,scaleX:1,scaleY:1,
    source:{url:"https://example.org/classes.tif",verified:true}},active:()=>true,get reads(){return reads;},
    coordinate(c,r,corner=false){return [(c+(corner?0:.5))*.001,.002-(r+(corner?0:.5))*.001];},value(c,r){reads++;return values[r][c];}};
}
const polygon=(w,s,e,n)=>({type:"Polygon",coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]});
const source={layerId:"study",featureId:"aoi-1",sourceGeneration:2};
const run=(input,aoi,extra={})=>computeRasterBaseline({grid:input,band:1,categoricalConfirmed:true,aoi:aoi?{geometry:aoi,source}:null,yieldControl:async()=>{},...extra});
const near=(a,b,tolerance=1e-7)=>assert(Math.abs(a-b)<=Math.max(.00001,Math.abs(b)*tolerance),`${a} != ${b}`);

test("partial-cell AOI areas use intersections and exclude untouched values without reads",async()=>{
  const input=grid(),result=await run(input,polygon(.00025,.00125,.00075,.00175));
  assert.equal(result.scope.aoiClipped,true);assert.equal(result.classes.length,1);assert.equal(result.classes[0].code,10);
  assert.equal(result.coverage.touchedCells,1);assert.equal(result.coverage.partialCells,1);assert.equal(input.reads,1);
  assert.equal(result.coverage.outsideAoiCells,3);assert.equal(result.coverage.aoiCoverage,"complete-cached-window");
  near(result.classes[0].areaSquareMeters,result.coverage.requestedAreaSquareMeters);
  const radius=result.method.radiusMeters,expected=radius**2*.0005*Math.PI/180*(Math.sin(.00175*Math.PI/180)-Math.sin(.00125*Math.PI/180));
  near(result.classes[0].areaSquareMeters,expected);assert(result.classes[0].shareOfAoi>.999999);
  assert.deepEqual(result.scope.aoi.geometry,polygon(.00025,.00125,.00075,.00175));
});

test("AOI beyond the window retains classified, NoData and unloaded areas separately",async()=>{
  const input=grid(),result=await run(input,polygon(-.001,-.001,.003,.003));
  assert.equal(input.reads,4);assert.equal(result.coverage.noDataCells,1);
  assert.equal(result.coverage.aoiCoverage,"partial-cached-window");
  assert(result.coverage.outsideWindowAreaSquareMeters>result.coverage.totalAreaSquareMeters*2.9);
  near(result.coverage.requestedAreaSquareMeters,result.coverage.totalAreaSquareMeters+result.coverage.outsideWindowAreaSquareMeters);
  near(result.coverage.totalAreaSquareMeters,result.coverage.noDataAreaSquareMeters+result.classes.reduce((sum,row)=>sum+row.areaSquareMeters,0));
  assert(result.classes.reduce((sum,row)=>sum+row.shareOfAoi,0)<.25);
  assert(rasterBaselineCsv(result).includes("outsideWindow"));
});

test("holes and concavity preserve coverage instead of using an AOI bounding rectangle",async()=>{
  const geometry={type:"Polygon",coordinates:[polygon(.0001,.0001,.0019,.0019).coordinates[0],polygon(.0005,.0005,.0015,.0015).coordinates[0]]};
  const result=await run(grid([[10,10],[10,10]]),geometry);
  assert(result.coverage.partialCells===4);near(result.coverage.requestedAreaSquareMeters,result.coverage.totalAreaSquareMeters);
  assert(result.coverage.totalAreaSquareMeters<result.coverage.gridWindowAreaSquareMeters*.6);
});

test("fully unloaded AOI produces an honest empty observation with finite exports",async()=>{
  const input=grid(),result=await run(input,polygon(.01,.01,.011,.011));
  assert.equal(input.reads,0);assert.equal(result.classes.length,0);assert.equal(result.coverage.totalAreaSquareMeters,0);
  assert.equal(result.coverage.touchedCells,0);assert(result.coverage.outsideWindowAreaSquareMeters>0);
  assert(!rasterBaselineCsv(result).includes("NaN"));assert(!rasterBaselineJson(result).includes("NaN"));
});

test("invalid AOIs and changed AOI identity stop computation and stale exports",async()=>{
  const input=grid();await assert.rejects(run(input,{type:"Polygon",coordinates:[[[0,0],[.002,.002],[0,.002],[.002,0],[0,0]]]}),/aoi_topology_invalid/);
  assert.equal(input.reads,0);
  let current=true;const aoi={geometry:polygon(0,0,.001,.001),source,isCurrent:()=>current};
  const result=await run(input,null,{aoi});current=false;
  assert.throws(()=>rasterBaselineJson(result),/aoi_changed/);
  await assert.rejects(run(input,null,{aoi}),/aoi_changed/);
});

test("WorldCover native dates and meanings survive requested periods and user overrides",async()=>{
  const input=grid();input.metadata.source.url="https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N00E000_Map.tif";
  const result=await run(input,null,{periodStart:"2025-01-01",periodEnd:"2025-12-31",requestedStart:"2025-01-01",requestedEnd:"2025-12-31",classMeanings:{10:"Declared forest"}});
  assert.equal(result.source.product.observationPeriod.start,"2021-01-01");
  assert.equal(result.interpretation.period.start,"2025-01-01");assert.equal(result.method.temporalSuitability,"disjoint");
  const tree=result.classes.find(row=>row.code===10);assert.equal(tree.sourceMeaning,"Tree cover");assert.equal(tree.meaning,"Declared forest");
  const shrub=result.classes.find(row=>row.code===20);assert.equal(shrub.meaning,"Shrubland");
});

test("actual AOI controls calculate partial areas and clear results when geometry changes",async()=>{
  const {JSDOM}=await import("jsdom"),dom=new JSDOM("<!doctype html><body></body>"),prior=globalThis.document;globalThis.document=dom.window.document;
  try {
    const input=grid(),entry={id:"study:0",title:"Study polygon",geometry:polygon(.00025,.00125,.00075,.00175),source},downloads=[];
    const view=RasterBaseline({getGrid:()=>input,getAois:()=>[entry],onDownload:value=>downloads.push(value)});document.body.append(view);
    const select=view.querySelector('select[aria-label="Analysis area"]');select.value=entry.id;select.dispatchEvent(new dom.window.Event("change",{bubbles:true}));
    view.querySelector('input[type="checkbox"]').checked=true;view.querySelector("form").dispatchEvent(new dom.window.Event("submit",{cancelable:true}));
    for(let i=0;i<100&&!view.querySelector("table");i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert(view.querySelector("table"));assert.match(view.textContent,/Outside loaded window/);
    const button=[...view.querySelectorAll("button")].find(node=>node.textContent==="Download inventory JSON");button.click();assert.equal(downloads.length,1);
    assert.equal(JSON.parse(downloads[0].text).scope.aoi.source.featureId,"aoi-1");
    entry.geometry=polygon(.0001,.0011,.0009,.0019);view.updateSource();assert.equal(view.querySelector("table"),null);assert(button.disabled);
    view.dispose();
  }finally{globalThis.document=prior;dom.window.close();}
});
