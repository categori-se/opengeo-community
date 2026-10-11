import assert from "node:assert/strict";
import {readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {JSDOM} from "jsdom";
import {verifyTileAppend} from "./integrated-studio-tiles.mjs";

export async function prepareStudioWms({page, projectId, resourceId, origin, organizationId, work, readApi, worker, datasetId}) {
  const panel=page.locator(".project-wms-publications");
  await panel.locator(":scope > summary").click();
  await panel.getByLabel("WMS resource",{exact:true}).selectOption(resourceId);
  await panel.getByRole("button",{name:"Publish WMS layer",exact:true}).waitFor();
  await panel.getByLabel("WMS layer name",{exact:true}).fill("watershed-map");
  const viewport=page.viewportSize();
  await page.setViewportSize({width:390,height:844});
  await panel.scrollIntoViewIfNeeded();
  assert.equal(await panel.locator("input,select").evaluateAll(items=>items.every(item=>{const bounds=item.getBoundingClientRect();return !bounds.width || bounds.left>=0&&bounds.right<=innerWidth;})),true);
  await panel.screenshot({path:join(work,"wms-publishing-mobile.png")});
  await page.setViewportSize(viewport);
  const saved=page.waitForResponse(response=>response.url().endsWith("/wms-publications")&&response.request().method()==="POST");
  await panel.getByRole("button",{name:"Publish WMS layer",exact:true}).click();
  const response=await saved;assert.equal(response.status(),201);const publication=await response.json();
  await page.reload();await panel.locator(":scope > summary").click();
  await panel.getByText("watershed-map · active",{exact:true}).waitFor();
  await panel.getByText("Connect & preview",{exact:true}).click();
  await panel.getByRole("button",{name:"Preview service document",exact:true}).click();
  await panel.getByLabel("Service document",{exact:true}).filter({hasText:"watershed-map"}).waitFor();
  const endpoint=`${origin}/api/projects/${projectId}/wms`;
  assert.equal(await panel.getByLabel("Connection URL",{exact:true}).inputValue(),`${endpoint}?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0`);
  const queue=()=>JSON.parse(readFileSync(join(work,"queue.json")));
  assert.deepEqual(queue(),[],"WMS publication and preview must not queue processing");
  const versionsBefore=await readApi(`/projects/${projectId}/datasets/${datasetId}/versions`);
  const client=wmsHttp({endpoint,organizationId});
  assert.equal((await client.read({SERVICE:"WMS",REQUEST:"GetCapabilities",VERSION:"1.3.0"},false)).status,401);
  const cap=await client.read({SERVICE:"WMS",REQUEST:"GetCapabilities",VERSION:"1.3.0"});assert.equal(cap.status,200);
  const xml=new JSDOM(cap.bytes.toString(),{contentType:"application/xml"});
  assert.ok([...xml.window.document.getElementsByTagNameNS("http://www.opengis.net/wms","Name")].some(item=>item.textContent==="watershed-map"));xml.window.close();
  const half=20037508.342789244,span=2*half/128;
  const bounds=[-half+38*span,half-48*span,-half+39*span,half-47*span];
  const query={SERVICE:"WMS",REQUEST:"GetMap",VERSION:"1.3.0",LAYERS:"watershed-map",STYLES:"",CRS:"EPSG:3857",BBOX:bounds.join(","),WIDTH:"256",HEIGHT:"256",FORMAT:"image/png",TRANSPARENT:"TRUE"};
  assert.equal((await client.read(query,false)).status,401);assert.deepEqual(queue(),[]);
  const pending=await client.read(query);assert.equal(pending.status,503);assert.match(pending.bytes.toString(),/ServerBusy/);
  assert.equal(queue().length,1,"One explicit WMS map request queues one render");
  await worker();assert.deepEqual(queue(),[]);
  const image=await client.read(query);assert.equal(image.status,200);assert.match(image.type,/^image\/png/);
  assert.equal(image.bytes.subarray(0,8).toString("hex"),"89504e470d0a1a0a");
  assert.equal(image.bytes.readUInt32BE(16),256);assert.equal(image.bytes.readUInt32BE(20),256);
  const sha256=createHash("sha256").update(image.bytes).digest("hex");
  writeFileSync(join(work,"service-map.png"),image.bytes);
  const renders=await readApi(`/projects/${projectId}/resources/${resourceId}/renders`);
  const render=renders.find(item=>item.state==="completed"&&item.output_checksum_sha256===sha256&&item.output_object_id!==null);
  assert.ok(render);
  const object=verifyTileAppend(versionsBefore,await readApi(`/projects/${projectId}/datasets/${datasetId}/versions`),render);
  return {publication,render,object,sha256,bounds,query,requests:client.requests,publicationReopened:true,capabilitiesDidNotQueue:true,explicitMapRenderCount:1};
}

export async function withdrawStudioWms({page, origin, projectId, organizationId, query}) {
  const panel=page.locator(".project-wms-publications");
  if(!await panel.evaluate(item=>item.open))await panel.locator(":scope > summary").click();
  await panel.getByText("watershed-map · active",{exact:true}).click();
  await panel.getByLabel("Permanently withdraw watershed-map",{exact:true}).check();
  await panel.getByRole("button",{name:"Withdraw WMS layer",exact:true}).click();
  await panel.getByText("watershed-map · withdrawn",{exact:true}).waitFor();
  const client=wmsHttp({endpoint:`${origin}/api/projects/${projectId}/wms`,organizationId});
  assert.equal((await client.read(query)).status,404);
  assert.equal((await client.read({SERVICE:"WMS",REQUEST:"GetCapabilities",VERSION:"1.3.0"})).status,404);
  return {withdrawnMapDenied:true,emptyCatalogDenied:true,requests:client.requests};
}

function wmsHttp({endpoint,organizationId}) {
  const requests=[];
  async function read(query,authenticated=true) {
    const response=await fetch(`${endpoint}?${new URLSearchParams(query)}`,{redirect:"error",signal:AbortSignal.timeout(25_000),headers:{"user-agent":"OpenGeo-Integrated-HTTP/1.0",...(authenticated?{authorization:"Bearer synthetic-local-owner","x-opengeo-organization":organizationId}:{})}});
    const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length<=2_097_152);
    requests.push({query,authenticated,status:response.status});
    return {bytes,status:response.status,type:response.headers.get("content-type")};
  }
  return {read,requests};
}
