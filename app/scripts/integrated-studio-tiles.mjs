import assert from "node:assert/strict";
import {readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {JSDOM} from "jsdom";

export function verifyTileAppend(before, after, render) {
  return verifyDerivedAppend(before, after, render, "image/png");
}

export function verifyDerivedAppend(before, after, render, contentType) {
  assert.ok(["image/png", "image/tiff"].includes(contentType));
  assert.equal(render.state,"completed");
  const additions=[];
  const retained=after.map(version=>({...version,objects:version.objects.filter(object=>{
    if(object.id!==render.output_object_id)return true;
    assert.equal(version.id,render.dataset_version_id);
    assert.equal(object.role,"derived");assert.equal(object.content_type,contentType);
    assert.equal(object.checksum_sha256,render.output_checksum_sha256);
    assert.equal(object.size_bytes,render.output_size_bytes);
    additions.push(object);return false;
  })}));
  assert.equal(additions.length,1,"Exactly the explicit render output may be added");
  assert.deepEqual(retained,before,"All pre-existing version facts and objects must remain unchanged");
  return additions[0];
}

export async function prepareStudioTiles({page, work, worker}) {
  const queue = () => JSON.parse(readFileSync(join(work,"queue.json")));
  assert.deepEqual(queue(),[]);
  await page.getByText("Tile cache settings",{exact:true}).click();
  await page.getByLabel("Minimum tile zoom",{exact:true}).fill("7");
  await page.getByLabel("Maximum tile zoom",{exact:true}).fill("7");
  await page.getByLabel("Maximum stored tiles",{exact:true}).fill("2");
  const originalViewport=page.viewportSize();
  await page.setViewportSize({width:390,height:844});
  await page.locator(".tile-seed-plan-catalog input").first().scrollIntoViewIfNeeded();
  assert.equal(await page.locator(".tile-seed-plan-catalog input").evaluateAll(inputs=>inputs.every(input=>{const r=input.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})),true);
  await page.locator(".tile-seed-plan-catalog").screenshot({path:join(work,"tile-settings-mobile.png")});
  await page.setViewportSize(originalViewport);
  const saved=page.waitForResponse(r=>r.url().endsWith("/tile-cache")&&r.request().method()==="PUT");
  await page.getByRole("button",{name:"Save tile cache settings",exact:true}).click();
  const response=await saved;assert.equal(response.status(),200);const policy=await response.json();
  assert.equal(policy.version_number,1);assert.equal(policy.maximum_entries,2);
  assert.deepEqual(queue(),[]);
  await page.reload();
  await page.getByText("Published objects · 1",{exact:true}).click();
  await page.locator(".project-service-binding > summary").filter({hasText:"watersheds · sealed and current"}).click();
  await page.getByText(/Current generation 1 · zoom 7–7 · 0\/2/).waitFor();
  await page.getByLabel("Exact tiles (one z,row,col coordinate per line; at most 64)",{exact:true}).fill("7,47,38");
  await page.getByRole("button",{name:"Preview exact tile seed plan",exact:true}).click();
  await page.getByRole("button",{name:"Confirm and activate render workers",exact:true}).waitFor();
  assert.deepEqual(queue(),[],"Preview must not dispatch work");
  const confirmed=page.waitForResponse(r=>r.url().endsWith("/seed-plans")&&r.request().method()==="POST");
  await page.getByRole("button",{name:"Confirm and activate render workers",exact:true}).click();
  const result=await confirmed;assert.equal(result.status(),202);const plan=await result.json();
  assert.equal(queue().length,1,"Only the explicitly selected tile is queued");
  await worker();assert.deepEqual(queue(),[]);
  await page.reload();
  await page.getByText("Published objects · 1",{exact:true}).click();
  await page.locator(".project-service-binding > summary").filter({hasText:"watersheds · sealed and current"}).click();
  await page.getByText(/Current generation 1 · zoom 7–7 · 1\/2/).waitFor();
  await page.locator(".tile-seed-plan-catalog").screenshot({path:join(work,"prepared-tile.png")});
  return {policy,plan,settingsReopened:true,previewDidNotQueue:true,explicitlyQueuedTiles:1};
}

export async function readStudioTiles({baseUrl, organizationId, denied=false, work}) {
  const endpoint=baseUrl.replace(/\/ogc$/,"/wmts");
  const headers={authorization:"Bearer synthetic-local-owner","x-opengeo-organization":organizationId,"user-agent":"OpenGeo-Integrated-HTTP/1.0"};
  const requests=[];
  async function read(parameters,authenticated=true) {
    const url=endpoint+"?"+new URLSearchParams(parameters);
    const response=await fetch(url,{headers:authenticated?headers:{"user-agent":headers["user-agent"]},redirect:"error",signal:AbortSignal.timeout(15000)});
    const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length<=2097152);
    requests.push({query:parameters,status:response.status});return {response,bytes};
  }
  const capabilities={SERVICE:"WMTS",REQUEST:"GetCapabilities",VERSION:"1.0.0"};
  assert.equal((await read(capabilities,false)).response.status,401);
  const cap=await read(capabilities);assert.equal(cap.response.status,200);
  const dom=new JSDOM(cap.bytes.toString(),{contentType:"application/xml"});
  const layers=[...dom.window.document.getElementsByTagNameNS("http://www.opengis.net/wmts/1.0","Layer")];
  const names=layers.map(layer=>layer.getElementsByTagNameNS("http://www.opengis.net/ows/1.1","Identifier")[0]?.textContent);
  dom.window.close();assert.equal(names.includes("watersheds"),!denied);
  const tile={SERVICE:"WMTS",REQUEST:"GetTile",VERSION:"1.0.0",LAYER:"watersheds",STYLE:"default",FORMAT:"image/png",TILEMATRIXSET:"WebMercatorQuad",TILEMATRIX:"7",TILEROW:"47",TILECOL:"38"};
  const image=await read(tile);assert.equal(image.response.status,denied?404:200);
  if(denied)return {withdrawnUndiscoverable:true,withdrawnTileDenied:true,anonymousDenied:true,requests};
  assert.match(image.response.headers.get("content-type"),/^image\/png/);
  assert.equal(image.bytes.subarray(0,8).toString("hex"),"89504e470d0a1a0a");
  assert.equal(image.bytes.readUInt32BE(16),256);assert.equal(image.bytes.readUInt32BE(20),256);
  assert.equal((await read({...tile,TILECOL:"39"})).response.status,404);
  writeFileSync(join(work,"service-tile.png"),image.bytes);
  return {collection:"watersheds",sha256:createHash("sha256").update(image.bytes).digest("hex"),width:256,height:256,unseededTileDenied:true,anonymousDenied:true,requests};
}
