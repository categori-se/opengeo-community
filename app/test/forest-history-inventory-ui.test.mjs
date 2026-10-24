import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {RasterBaseline} from "../src/components/RasterBaseline.js";

const profileId="jrc-tmf-2025-main-classes",confirmation="I checked this band against the selected product and release";
function fixtureGrid({url="https://imagery.example/unverified-classes.tif"}={}) {
  const values=[[10,50,70],[999,null,10]];let active=true,reads=0;
  return {width:3,height:2,metadata:{bands:[1,2],window:[0,0,3,2],projection:"EPSG:4326",interpretation:"area",imageIndex:4,
    scaleX:16,scaleY:16,origin:[85,28],resolution:[.001,-.001],noData:0,
    source:{url,etag:null,size:4096,verified:false,license:null,attribution:null}},
    active:()=>active,release(){active=false;},get reads(){return reads;},
    coordinate(column,row,corner=false){const offset=corner?0:.5;return[85+(column+offset)*.001,28-(row+offset)*.001];},
    value(column,row,band){assert.equal(band,1);reads++;return values[row][column];}};
}
async function withView(options,body) {
  const dom=new JSDOM("<!doctype html><body></body>"),prior=globalThis.document;globalThis.document=dom.window.document;
  const grid=fixtureGrid(options),downloads=[],view=RasterBaseline({getGrid:()=>grid,onDownload:value=>downloads.push(value)});document.body.append(view);
  const field=label=>view.querySelector(`[aria-label="${label}"]`),button=label=>[...view.querySelectorAll("button")].find(value=>value.textContent===label),
    change=(label,value)=>{const input=field(label);if(input.type==="checkbox")input.checked=value;else input.value=value;input.dispatchEvent(new dom.window.Event("change",{bubbles:true}));},
    submit=()=>view.querySelector("form").dispatchEvent(new dom.window.Event("submit",{cancelable:true})),
    status=()=>view.querySelector('[role="status"]').textContent;
  async function until(predicate){for(let i=0;i<100&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(predicate(),status());}
  const selectProfile=()=>{change("Published product interpretation",profileId);change("This band contains categorical class codes",true);change(confirmation,true);};
  try{await body({view,grid,downloads,field,button,change,submit,status,until,selectProfile});}
  finally{view.dispose();globalThis.document=prior;dom.window.close();}
}

it("requires a deliberate product selection and both confirmations before inventorying loaded cells",async()=>{
  await withView({},async({view,grid,field,change,submit,status,until})=>{
    assert.equal(field("Published product interpretation").value,"");assert.equal(field(confirmation).disabled,true);assert.equal(grid.reads,0);
    change("Published product interpretation",profileId);assert.equal(field(confirmation).disabled,false);assert.equal(field(confirmation).closest("label").hidden,false);
    change(confirmation,true);submit();assert.match(status(),/Confirm that the selected band contains categorical/);assert.equal(grid.reads,0);
    change("This band contains categorical class codes",true);change(confirmation,false);submit();assert.match(status(),/checked this band against the selected product and release/);assert.equal(grid.reads,0);
    change(confirmation,true);submit();await until(()=>view.querySelector("table"));assert.equal(grid.reads,6);
    assert.match(view.textContent,/Declared by you; unverified/);assert.match(view.textContent,/30 m; loaded overview cells/);
    assert.match(view.textContent,/1982/);assert.match(view.textContent,/1990/);assert.match(view.textContent,/2025/);
    assert.match(view.textContent,/Ongoing deforestation or degradation \(2023-2025\)/);assert.match(view.textContent,/does not separate those processes/);
    assert.match(view.textContent,/does not verify the raster’s product identity, coverage, rights, forest condition or impact/);
  });
});

it("exports the original legend and separate meanings while retaining unknown codes and NoData",async()=>{
  await withView({},async({view,grid,downloads,button,change,submit,until,selectProfile})=>{
    selectProfile();change("Class meanings (optional; one code = meaning per line)","50 = Reviewed class label");submit();await until(()=>view.querySelector("table"));
    const table=view.querySelector("table"),headers=[...table.querySelectorAll("th")].map(value=>value.textContent);
    assert.ok(headers.includes("Source-identified meaning"));assert.ok(headers.includes("User meaning"));
    const row=[...table.querySelectorAll("tbody tr")].find(value=>value.cells[0].textContent==="50");
    assert.match(row.textContent,/Ongoing deforestation or degradation/);assert.match(row.textContent,/Not identified/);assert.match(row.textContent,/Reviewed class label/);
    assert.match(table.textContent,/Unknown code/);assert.match(table.textContent,/Source NoData/);
    const reads=grid.reads;button("Download inventory JSON").click();button("Download inventory CSV").click();assert.equal(downloads.length,2);
    const record=JSON.parse(downloads[0].text),profile=record.interpretation.publishedProfile,known=record.classes.find(value=>value.code===50),unknown=record.classes.find(value=>value.code===999);
    assert.match(record.schemaVersion,/1\.2\.0$/);assert.equal(profile.id,profileId);assert.equal(profile.identityAuthority,"user-declared-unverified");assert.equal(profile.nominalResolutionMeters,30);
    assert.match(profile.legend.sha256,/^[0-9a-f]{64}$/);assert.equal(profile.legend.bytes,10518);assert.equal(profile.legend.entries.find(value=>value.code===70).label.endsWith("  "),true);
    assert.equal(known.meaning,"Reviewed class label");assert.equal(known.sourceMeaning,null);assert.match(known.profileMeaning,/Ongoing deforestation or degradation/);
    assert.equal(unknown.meaning,null);assert.equal(unknown.profileMeaning,null);assert.equal(record.coverage.noDataCells,1);
    assert.equal(record.source.product,undefined);assert.equal(record.source.reference.url,"https://imagery.example/unverified-classes.tif");assert.equal(record.source.reference.license,null);assert.equal(record.source.reference.verified,false);
    assert.match(downloads[1].text,/source_meaning/);assert.match(downloads[1].text,/profile_meaning/);assert.match(downloads[1].text,/user-declared-unverified/);
    assert.match(downloads[1].text,/"999"/);assert.match(downloads[1].text,/"noData"/);assert.match(downloads[1].text,/Reviewed class label/);
    profile.legend.entries[0].label="Mutated downloaded copy";button("Download inventory JSON").click();
    assert.notEqual(JSON.parse(downloads[2].text).interpretation.publishedProfile.legend.entries[0].label,"Mutated downloaded copy");assert.equal(grid.reads,reads);
  });
});

it("rejects a mismatched band without reading cells or exporting a partial result",async()=>{
  await withView({},async({view,grid,field,button,change,submit,status,selectProfile})=>{
    selectProfile();change("Categorical band","2");assert.equal(field(confirmation).checked,false);change(confirmation,true);submit();
    assert.match(status(),/requires band 1/);assert.equal(grid.reads,0);assert.equal(view.querySelector("table"),null);assert.equal(button("Download inventory JSON").disabled,true);
  });
});

it("rejects a recognized conflicting WorldCover product instead of relabeling its classes",async()=>{
  await withView({url:"https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N00E000_Map.tif"},async({view,grid,button,submit,status,until,selectProfile})=>{
    selectProfile();submit();await until(()=>/recognized source is a different published product/.test(status()));
    assert.equal(grid.reads,0);assert.equal(view.querySelector("table"),null);assert.equal(button("Download inventory CSV").disabled,true);
  });
});

it("clears results and confirmation when the product or cached window changes",async()=>{
  await withView({},async({view,grid,downloads,field,button,change,submit,until,selectProfile})=>{
    selectProfile();submit();await until(()=>view.querySelector("table"));const reads=grid.reads;
    change("Published product interpretation","");assert.equal(view.querySelector("table"),null);assert.equal(field(confirmation).checked,false);assert.equal(field(confirmation).disabled,true);
    assert.equal(button("Download inventory JSON").disabled,true);button("Download inventory JSON").click();assert.equal(downloads.length,0);assert.equal(grid.reads,reads);
    selectProfile();submit();await until(()=>view.querySelector("table"));grid.release();view.updateSource();
    assert.equal(view.querySelector("table"),null);assert.equal(field(confirmation).checked,false);assert.equal(button("Download inventory CSV").disabled,true);
  });
});
