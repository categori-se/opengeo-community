// Built Studio UI acceptance. HTTP metadata storage is a test substitute;
// database migration/history/authorization have separate owning tests.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createServer} from "node:http";
import {existsSync} from "node:fs";
import {readFile, readdir, mkdir, writeFile} from "node:fs/promises";
import {resolve, extname} from "node:path";
import {chromium} from "playwright";
const dist=resolve("dist"), output=resolve("../.local-archives/resource-model-20260919");
await mkdir(output,{recursive:true});
const id="80000000-0000-4000-8000-000000000001";
const modules=await readdir(resolve(dist,"_import/components"));
const stylePicker=modules.find(name=>/^LayerStylePicker\.[a-f0-9]+\.js$/.test(name));
const component=modules.find(name=>/^LayerResourcePage\.[a-f0-9]+\.js$/.test(name));
const client=(await readdir(resolve(dist,"_import/lib"))).find(name=>/^apiClient\.[a-f0-9]+\.js$/.test(name));
const css=(await readdir(resolve(dist,"_file"))).find(name=>/^style\.[a-f0-9]+\.css$/.test(name));
const theme=(await readdir(resolve(dist,"_observablehq"))).find(name=>/^theme-.*\.css$/.test(name));
assert.ok(component&&client&&css&&theme);
let current={dataset_id:id,version:0,document:{schemaVersion:"1.0.0",distributions:[],metadata:{source:[],normalized:[],curated:[],inferred:[]},context:[]},created_by:null,created_at:null,can_edit:true};
const recordId="a0000000-0000-4000-8000-000000000001", projectId="50000000-0000-4000-8000-000000000001";
const recordedAt="2026-09-19T12:00:00Z", author="20000000-0000-4000-8000-000000000001";
const governed={id:recordId,project_id:projectId,kind:"dataset",slug:"boundaries",dataset_id:id,map_id:null,
  visibility:"restricted",state:"draft",version_number:2,title:"Boundary metadata",abstract:"Retained survey metadata",
  language:"en",license:null,attribution:null,keywords:[],spatial_extent:null,temporal_start:null,temporal_end:null,
  owner_user_id:author,origin_namespace:null,origin_identifier:null,relationship_count:0,created_at:recordedAt,updated_at:recordedAt,
  metadata_profile:"opengeo.core.v1",metadata_extensions:{survey:{unit:"persons"}},content:{blocks:[]},provenance:{method:"survey"},
  change_message:null,version_created_by:author,version_created_at:recordedAt,external_identifiers:[],relationships:[],translations:{},
  managed_metadata_profile_id:null,managed_metadata_profile_version:null,metadata_validation:null};
const retainedSource={id:"f0000000-0000-4000-8000-000000000001",resource_id:recordId,
  resource_version_id:"b0000000-0000-4000-8000-000000000001",source_format:"dcat_3",source_version:"3",
  source_namespace:"provider",source_identifier:"boundaries",document:{survey:{unit:"persons"}},source_sha256:"a".repeat(64),
  checksum_basis:"canonical_json",canonical_json_sha256:"a".repeat(64),conversion_report:{},imported_by:author,imported_at:recordedAt};
const styleDefinition='{ "version": 8, "sources": {}, "layers": [] }\r\n';
const savedStyle={id:"d0000000-0000-4000-8000-000000000001",resource_id:recordId,slug:"boundaries",format:"maplibre",version_number:3,title:"Boundary style",media_type:"application/json",definition:styleDefinition,checksum_sha256:createHash("sha256").update(styleDefinition).digest("hex"),change_message:null,created_by:author,created_at:recordedAt,updated_at:recordedAt};
const historicalDefinition='{"version":8,"name":"Original boundaries","sources":{},"layers":[]}\r\n';
const historicalStyle={...savedStyle,version_number:1,definition:historicalDefinition,checksum_sha256:createHash("sha256").update(historicalDefinition).digest("hex")};
const pickerDefinition='{"version":8,"sources":{},"layers":[{"id":"boundaries","type":"line","paint":{"line-color":"#123456","line-width":3,"line-opacity":0.5}}]}';
const pickerStyle={...savedStyle,version_number:2,definition:pickerDefinition,checksum_sha256:createHash("sha256").update(pickerDefinition).digest("hex")};
const discoveryBody=Buffer.from(' { "title": "Boundary source" }\r\n');
const discoveryMetadata={dataset_id:id,discovery_job_id:"86000000-0000-4000-8000-000000000001",source_type:"arcgis",service_url:"https://example.test/FeatureServer",collection_ref:"0",
  document:{status:"retained",body_base64:discoveryBody.toString("base64"),byte_length:discoveryBody.length,sha256:createHash("sha256").update(discoveryBody).digest("hex"),retrieved_at:recordedAt}};
const history=new Map(), requests=[];
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,"http://localhost");
  if(url.pathname===`/api/datasets/${id}/discovery-metadata`){
    requests.push({method:req.method,path:url.pathname});res.setHeader("Content-Type","application/json");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(discoveryMetadata));return;
  }
  const recordPath=`/api/projects/${projectId}/resources/${recordId}`;
  if(url.pathname===`${recordPath}/styles/${savedStyle.id}/versions/2`){
    res.setHeader("Content-Type","application/json");res.end(JSON.stringify(pickerStyle));return;
  }
  if(url.pathname===`${recordPath}/styles/${savedStyle.id}/versions/1`){
    requests.push({method:req.method,path:url.pathname});res.setHeader("Content-Type","application/json");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(historicalStyle));return;
  }
  if([`${recordPath}/styles`,`${recordPath}/capabilities`].includes(url.pathname)){
    requests.push({method:req.method,path:url.pathname});res.setHeader("Content-Type","application/json");
    res.end(JSON.stringify(url.pathname.endsWith("/styles")?[savedStyle]:{can_read:true,can_update:false,can_publish:false,can_manage_permissions:false}));return;
  }
  if([`/api/datasets/${id}/resources`,recordPath,`${recordPath}/metadata/source`].includes(url.pathname)){
    requests.push({method:req.method,path:url.pathname});
    const payload=url.pathname.endsWith("/metadata/source")?retainedSource:url.pathname===recordPath?governed:[{...governed,version_number:1}];
    res.setHeader("Content-Type","application/json");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(payload));return;
  }
  if(url.pathname===`/api/datasets/${id}/metadata`){
    requests.push({method:req.method,path:url.pathname});
    if(req.method==="PUT"){
      let bytes="";for await(const chunk of req) bytes+=chunk;
      const draft=JSON.parse(bytes);
      if(draft.expected_version!==current.version){res.writeHead(409).end();return;}
      current={...current,version:current.version+1,document:draft.document};history.set(current.version,structuredClone(current));
    }
    res.setHeader("Content-Type","application/json");res.setHeader("Cache-Control","no-store");
    res.end(JSON.stringify(url.searchParams.has("version")?history.get(Number(url.searchParams.get("version"))):current));return;
  }
  if(url.pathname==="/style-check"){
    res.setHeader("Content-Type","text/html");res.end(`<!doctype html><html><head><link rel="stylesheet" href="/_file/${css}"></head><body><main></main><script type="module">
    import {LayerStylePicker} from '/_import/components/${stylePicker}';
    import {OpenGeoApiClient} from '/_import/lib/${client}';
    const adapter=new OpenGeoApiClient({tokenProvider:()=>"local-test",organizationProvider:()=>"10000000-0000-4000-8000-000000000001"});
    document.querySelector('main').append(LayerStylePicker({adapter,layer:{datasetId:'${id}',geometryType:'LineString'},onApply:(reference,resolved)=>{window.appliedStyle={reference,resolved};}}));
    </script></body></html>`);return;
  }
  if(url.pathname==="/check"){
    res.setHeader("Content-Type","text/html");res.end(`<!doctype html><html><head><link rel="stylesheet" href="/_observablehq/${theme}"><link rel="stylesheet" href="/_file/${css}"></head><body><main></main><script type="module">
    import {renderLayerResource} from '/_import/components/${component}';
    import {OpenGeoApiClient} from '/_import/lib/${client}';
    const adapter=new OpenGeoApiClient({tokenProvider:()=>"local-test",organizationProvider:()=>"10000000-0000-4000-8000-000000000001"});
    document.querySelector('main').append(renderLayerResource({adapter,dataset:{id:'${id}',projectId:'50000000-0000-4000-8000-000000000001',name:'Reusable boundaries',sourceType:'arcgis',format:'arcgis',capabilities:{edit:true}}}));
    </script></body></html>`);return;
  }
  const pathname=url.pathname==="/layers"?"/layers.html":url.pathname;
  const file=resolve(dist,`.${decodeURIComponent(pathname)}`);
  if(!file.startsWith(dist+"/")){res.writeHead(403).end();return;}
  try{res.setHeader("Content-Type",({".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".woff2":"font/woff2"})[extname(file)]??"application/octet-stream");res.end(await readFile(file));}
  catch{res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
  browser=await chromium.launch({headless:true,executablePath:["/usr/bin/chromium-browser","/usr/bin/chromium"].find(existsSync)});
  const page=await browser.newPage({viewport:{width:1100,height:900},serviceWorkers:"block"});
  const errors=[];page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/*",route=>route.request().url().startsWith(origin)?route.continue():route.abort());
  await page.goto(`${origin}/layers?id=${id}&adapter=fixture`);
  await page.locator(".layer-resource h1").waitFor();
  assert.equal(await page.locator(".layer-resource").getAttribute("data-resource-id"),id);
  await page.getByRole("button", {name:"Add resource to project",exact:true}).click();
  await page.getByText("Resource available in this project. Its identity, metadata and source are shared; configure its map presentation in the project.", {exact:true}).waitFor();
  await page.goto(`${origin}/check`);
  await page.getByRole("heading",{name:"Reusable boundaries",exact:true}).waitFor();
  assert.equal(requests.length,0,"opening a layer does not create or fetch metadata automatically");
  await page.getByRole("button",{name:"Load metadata record",exact:true}).click();
  await page.getByText("No metadata assertions recorded yet. Unknown rights remain unknown.",{exact:true}).waitFor();
  await page.getByText("Edit metadata record",{exact:true}).click();
  const original=' { "population": { "value": 42, "unit": "persons" } }\n';
  const draft={...current.document,distributions:[{id:"urn:distribution:live",custody:"referenced"},{id:"urn:distribution:copy",custody:null}],metadata:{
    source:[{id:"urn:source:one",content:original,mediaType:"application/json",sourceUrl:"https://example.org/metadata",retrievedAt:"2026-09-19T12:00:00Z"}],
    normalized:[{subject:"urn:distribution:live",property:"http://purl.org/dc/terms/license",value:null,provenance:"unknown"}],curated:[],
    inferred:[{subject:"resource",property:"http://purl.org/dc/terms/subject",value:{population:{unit:"persons"}},provenance:"machine_inferred",confidence:0.4}]}};
  await page.getByLabel("Metadata JSON",{exact:true}).fill(JSON.stringify(draft,null,2));
  assert.equal(await page.getByRole("button",{name:"Reload metadata record",exact:true}).isDisabled(),true);
  await page.getByRole("button",{name:"Save metadata revision",exact:true}).click();
  await page.getByText("Saved metadata revision 1.",{exact:true}).waitFor();
  await page.reload();
  await page.getByRole("button",{name:"Load metadata record",exact:true}).click();
  await page.getByText("Metadata revision 1.",{exact:true}).waitFor();
  assert.deepEqual(current.document,draft);assert.equal(current.document.metadata.source[0].content,original);
  assert.equal(requests.filter(item=>item.method==="PUT").length,1);
  await page.getByText("Add a representation",{exact:true}).click();
  await page.getByLabel("Distribution URI",{exact:true}).fill("urn:distribution:guided");
  await page.getByLabel("Custody relationship",{exact:true}).selectOption("referenced");
  await page.getByRole("button",{name:"Add representation to draft",exact:true}).click();
  await page.getByText("Add a metadata claim",{exact:true}).click();
  await page.getByLabel("Applies to",{exact:true}).selectOption("urn:distribution:guided");
  await page.getByLabel("Property",{exact:true}).selectOption("http://purl.org/dc/terms/license");
  await page.getByLabel("Knowledge state",{exact:true}).selectOption("unknown");
  await page.getByRole("button",{name:"Add claim to draft",exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),"guided forms fit a narrow viewport");
  await page.setViewportSize({width:1100,height:900});
  await page.getByRole("button",{name:"Save metadata revision",exact:true}).click();
  await page.getByText("Saved metadata revision 2.",{exact:true}).waitFor();
  assert.equal(current.document.metadata.curated[0].subject,"urn:distribution:guided");
  assert.equal(current.document.metadata.curated[0].value,null);
  assert.equal(current.document.metadata.source[0].content,original);
  await page.getByRole("button",{name:"Inspect preserved discovery response",exact:true}).click();
  await page.getByRole("button",{name:"Download retained response",exact:true}).waitFor();
  const downloadPromise=page.waitForEvent("download");
  await page.getByRole("button",{name:"Download retained response",exact:true}).click();
  const download=await downloadPromise;
  assert.deepEqual(await readFile(await download.path()),discoveryBody);
  await page.getByRole("button",{name:"Find metadata records",exact:true}).click();
  await page.getByRole("heading",{name:"Boundary metadata",exact:true}).waitFor();
  await page.getByRole("button",{name:"Inspect record",exact:true}).click();
  await page.getByText("The record changed since listing; the current revision is shown.",{exact:true}).waitFor();
  await page.getByRole("button",{name:"Inspect saved Styles",exact:true}).click();
  await page.getByText("Inspect definition",{exact:true}).click();
  const styleDownloadPromise=page.waitForEvent("download");
  await page.getByRole("button",{name:"Download saved definition",exact:true}).click();
  const styleDownload=await styleDownloadPromise;
  assert.equal(styleDownload.suggestedFilename(),"boundaries-v3.json");
  assert.equal(await readFile(await styleDownload.path(),"utf8"),styleDefinition);
  await page.getByText("Inspect a saved version",{exact:true}).click();
  await page.getByLabel("Style version number",{exact:true}).fill("1");
  await page.getByRole("button",{name:"Load exact Style version",exact:true}).click();
  await page.getByText("Verified saved version 1. Your current draft is unchanged.",{exact:true}).waitFor();
  await page.getByText("Inspect definition",{exact:true}).last().click();
  const historicalDownloadPromise=page.waitForEvent("download");
  await page.getByRole("button",{name:"Download saved definition",exact:true}).last().click();
  const historicalDownload=await historicalDownloadPromise;
  assert.equal(historicalDownload.suggestedFilename(),"boundaries-v1.json");
  assert.equal(await readFile(await historicalDownload.path(),"utf8"),historicalDefinition);
  await page.getByRole("button",{name:"Inspect retained import source",exact:true}).click();
  await page.getByText("Retained import loaded.",{exact:true}).waitFor();
  await page.getByText("Retained structured JSON; original provider whitespace is not represented.",{exact:true}).waitFor();
  await page.reload();
  await page.getByRole("button",{name:"Find metadata records",exact:true}).click();
  await page.getByRole("heading",{name:"Boundary metadata",exact:true}).waitFor();
  await page.screenshot({path:resolve(output,"resource-desktop.png"),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),"no horizontal page overflow");
  await page.screenshot({path:resolve(output,"resource-phone.png"),fullPage:true});
  assert.deepEqual(errors,[]);
  await page.goto(`${origin}/style-check`);
  await page.getByRole("button",{name:"Find Styles for this Layer",exact:true}).click();
  await page.getByRole("button",{name:"Styles in Boundary metadata",exact:true}).click();
  await page.getByLabel("Version of Boundary style",{exact:true}).fill("2");
  await page.getByRole("button",{name:"Apply Boundary style",exact:true}).click();
  await page.getByText("Applied Boundary style, version 2. Save the Project to retain this selection.",{exact:true}).waitFor();
  const applied=await page.evaluate(()=>window.appliedStyle);
  assert.equal(applied.reference.versionNumber,2);
  assert.equal(applied.reference.styleId,savedStyle.id);
  assert.equal(applied.resolved.parts[0].paint["line-color"],"#123456");
  assert.equal(Object.hasOwn(applied.reference,"definition"),false);
  assert.deepEqual(errors,[]);
  const evidence={schema:"opengeo.resource-model-local-ui.1",builtLayerRoute:true,existingProjectReference:true,metadataSaveReopen:true,governedRecordInspectionReopen:true,guidedDistributionRights:true,discoveryBytesDownload:true,layerStyleDownload:true,exactStyleHistoryDownload:true,exactStylePicker:true,sourceTextPreserved:true,narrowLayout:true,
    substitutions:["Fixture adapter for standalone shell; local HTTP metadata store for save/reopen; no cloud identity provider or live deployment"],requests};
  await writeFile(resolve(output,"browser.json"),JSON.stringify(evidence,null,2)+"\n");
  console.log(JSON.stringify(evidence,null,2));
}finally{await browser?.close();await new Promise(done=>server.close(done));}
