import assert from "node:assert/strict";
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {spawn} from "node:child_process";
import {prepareStudioTiles, readStudioTiles, verifyTileAppend} from "./integrated-studio-tiles.mjs";
import {prepareStudioWms, withdrawStudioWms} from "./integrated-studio-wms.mjs";

export function checkedServiceLink(href, base, projectId) {
  const url = new URL(href, base);
  const origin = new URL(base).origin;
  assert.equal(url.origin, origin);
  assert.ok(!url.username && !url.password && !url.hash);
  assert.ok([`/api/projects/${projectId}/`, `/projects/${projectId}/`].some(prefix => url.pathname.startsWith(prefix)));
  return url.href;
}

export async function readServiceHttp({baseUrl, projectId, organizationId, expected, expectedMetadata = null, metadataDenied = false, denied = false, fetchImplementation = fetch}) {
  const traces = [];
  async function read(href, authenticated = true) {
    const url = checkedServiceLink(href, baseUrl, projectId);
    const response = await fetchImplementation(url, {redirect:"error",credentials:"omit",signal:AbortSignal.timeout(15_000),
      headers:{accept:"application/json", "user-agent":"OpenGeo-Integrated-HTTP/1.0",
        ...(authenticated ? {authorization:"Bearer synthetic-local-owner","x-opengeo-organization":organizationId} : {})}});
    const body = await response.text();
    assert.ok(Buffer.byteLength(body) <= 2_097_152);
    traces.push({path:new URL(url).pathname,status:response.status});
    return {status:response.status,document:body ? JSON.parse(body) : null};
  }
  assert.equal((await read(baseUrl,false)).status,401);
  const landing=await read(baseUrl);assert.equal(landing.status,200);
  const data=landing.document.links.find(link=>link.rel==="data");assert.ok(data);
  const catalog=await read(data.href);assert.equal(catalog.status,200);
  const collection=catalog.document.collections.find(item=>item.id==="watersheds");
  if (denied) {
    assert.equal(collection,undefined);
    assert.equal((await read(`${baseUrl}/collections/watersheds/items`)).status,404);
    return {withdrawnUndiscoverable:true,withdrawnItemsDenied:true,anonymousRejected:true,traces};
  }
  assert.ok(collection,"The authored collection is missing from service discovery");
  let metadata = null;
  if (expectedMetadata) {
    const link=collection.links.find(link=>link.rel==='describedby' && link.type==='application/geo+json');
    assert.ok(link,'Service must link to governed metadata');
    metadata=await readServiceMetadata({link,baseUrl,projectId,expectedMetadata,metadataDenied,read});
  }
  const items=collection.links.find(link=>link.rel==="items" && link.type==="application/geo+json");assert.ok(items);
  const url=new URL(checkedServiceLink(items.href,baseUrl,projectId));url.searchParams.set("limit","1");
  let next=url.href, pages=0;const features=[];const visited=new Set();
  while (next) {
    assert.ok(++pages<=3 && !visited.has(next),"Unexpected pagination loop");visited.add(next);
    const page=await read(next);assert.equal(page.status,200);
    assert.equal(page.document.type,"FeatureCollection");
    features.push(...page.document.features);
    next=page.document.links?.find(link=>link.rel==="next")?.href;
  }
  assert.equal(pages,2);assert.equal(features.length,2);
  const observed=features.map(feature=>({geometry:feature.geometry,properties:{name:feature.properties.name,value:feature.properties.value}}))
    .sort((a,b)=>a.properties.name.localeCompare(b.properties.name));
  assert.deepEqual(observed,expected);
  assert.equal(new Set(features.map(feature=>feature.id)).size,2);
  return {metadata,collection:collection.id,features:observed,featureIds:features.map(feature=>feature.id),pages,anonymousRejected:true,traces};
}

export async function readServiceMetadata({link,baseUrl,projectId,expectedMetadata,metadataDenied=false,read}) {
  const href=checkedServiceLink(link.href,baseUrl,projectId);
  assert.equal(new URL(href).pathname.replace(/^\/api(?=\/projects\/)/,''), `/projects/${projectId}/records/collections/resources/items/${expectedMetadata.resourceId}`);
  assert.equal((await read(href,false)).status,401);
  const response=await read(href);
  if(metadataDenied) {
    assert.ok([403,404].includes(response.status),'Revoked metadata must be denied independently of service discovery');
    return {resourceAccessDenied:true,status:response.status};
  }
  assert.equal(response.status,200);
  assert.equal(response.document.id,expectedMetadata.resourceId);
  assert.equal(response.document.properties.license,expectedMetadata.license);
  return {resourceId:response.document.id,license:response.document.properties.license,anonymousRejected:true};
}

async function qgis({work, root, baseUrl, projectId, organizationId, expected, denied = false}) {
  const mode=denied ? "denied" : "read",input=join(work,`qgis-${mode}.json`),profile=join(work,`qgis-${mode}-profile`);
  mkdirSync(profile,{mode:0o700});
  writeFileSync(input,JSON.stringify({baseUrl,projectId,organizationId,collection:"watersheds",token:"synthetic-local-owner",expected,denied,tiles:true,maps:true}),{mode:0o600,flag:"wx"});
  const result=await new Promise((resolve,reject)=>{
    const child=spawn("/usr/bin/python3",[join(root,"scripts/integrated_studio_qgis.py"),input],{
      env:{...process.env,QT_QPA_PLATFORM:"offscreen",QGIS_CUSTOM_CONFIG_PATH:profile,XDG_CACHE_HOME:profile,NO_PROXY:"127.0.0.1",PYTHONDONTWRITEBYTECODE:"1"},
      stdio:["ignore","pipe","pipe"],timeout:90_000,killSignal:"SIGKILL"});
    let stdout="",stderr="";
    child.stdout.on("data",data=>{stdout+=data;if(stdout.length>2_097_152)child.kill("SIGKILL");});
    child.stderr.on("data",data=>{stderr=(stderr+data).slice(0,262144);});
    child.on("error",reject);
    child.on("close",code=>{
      writeFileSync(join(work,`qgis-${mode}.log`),stderr);
      if(code!==0) return reject(new Error(`QGIS ${mode} failed (${code}): ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch(error) { reject(error); }
    });
  });
  return result;
}

export async function exerciseServiceClients({page, project, datasetId, resourceId, source, readApi, origin, organizationId, root, work, worker}) {
  const versionsBefore = await readApi(`/projects/${project.id}/datasets/${datasetId}/versions`);
  await page.locator(`a[href*="project=${project.id}"][href*="manage=data"]`).first().click();
  const card=page.locator(`[data-dataset-id="${datasetId}"]`);
  await card.getByRole("button",{name:"Edit features",exact:true}).click();
  await card.getByLabel("Field 1 stable name",{exact:true}).fill("name");
  await card.getByLabel("Field 1 display label",{exact:true}).fill("Name");
  await card.getByLabel("Field 1 help text",{exact:true}).fill("Watershed name");
  await card.getByLabel("Field 1 choices",{exact:true}).fill("");
  await card.getByRole("button",{name:"Add field",exact:true}).click();
  await card.getByLabel("Field 2 stable name",{exact:true}).fill("value");
  await card.getByLabel("Field 2 type",{exact:true}).selectOption("integer");
  await card.getByLabel("Field 2 display label",{exact:true}).fill("Value");
  await card.getByRole("button",{name:"Create empty feature collection",exact:true}).click();
  await card.getByRole("button",{name:"Create feature",exact:true}).waitFor();
  const expected=JSON.parse(source).features.map(feature=>({geometry:feature.geometry,properties:{name:feature.properties.name,value:feature.properties.value}}))
    .sort((a,b)=>a.properties.name.localeCompare(b.properties.name));
  for (const feature of expected) {
    await card.getByLabel("GeoJSON geometry",{exact:true}).fill(JSON.stringify(feature.geometry));
    await card.getByLabel("Feature property name",{exact:true}).fill(feature.properties.name);
    await card.getByLabel("Feature property value",{exact:true}).fill(String(feature.properties.value));
    const created=page.waitForResponse(response=>response.url().endsWith(`/datasets/${datasetId}/features`)&&response.request().method()==="POST");
    await card.getByRole("button",{name:"Create feature",exact:true}).click();
    assert.equal((await created).status(),201);
    await card.getByText(new RegExp(`${expected.indexOf(feature)+1} live feature`)).waitFor();
  }
  await page.reload();
  await card.getByRole("button",{name:"Edit features",exact:true}).click();
  await card.getByText(/2 live features/).waitFor();
  const authored=await readApi(`/projects/${project.id}/datasets/${datasetId}/features?limit=100&offset=0`);
  assert.equal(authored.numberMatched,2);
  await page.locator(`a[href*="project=${project.id}"][href*="manage=services"]`).first().click();
  await page.getByText("Add or retire published objects",{exact:true}).click();
  await page.getByLabel("Authoritative feature dataset",{exact:true}).selectOption(datasetId);
  await page.getByLabel("Published map resource",{exact:true}).selectOption(resourceId);
  await page.getByLabel("Current render profile",{exact:true}).locator("option").first().waitFor({state:"attached"});
  await page.getByLabel("Collection identifier",{exact:true}).fill("watersheds");
  await page.getByLabel("Collection title",{exact:true}).fill("Watershed observations");
  const sealed=page.waitForResponse(response=>response.url().endsWith("/collections")&&response.request().method()==="POST");
  await page.getByRole("button",{name:"Seal current generations",exact:true}).click();
  assert.equal((await sealed).status(),201);
  await page.reload();
  await page.getByText("Published objects · 1",{exact:true}).click();
  await page.locator(".project-service-binding > summary").filter({hasText:"watersheds · sealed and current"}).click();
  await page.getByRole("button",{name:"Withdraw binding",exact:true}).waitFor();
  await page.locator(".project-service-card").screenshot({path:join(work,"populated-service.png")});
  const options={work,root,baseUrl:`${origin}/api/projects/${project.id}/services/watershed-pilot/ogc`,projectId:project.id,organizationId,expected,expectedMetadata:{resourceId,license:"CC-BY-4.0"}};
  const tiles=await prepareStudioTiles({page,work,worker});
  const tileHttp=await readStudioTiles(options);
  assert.equal(tiles.plan.items.length,1);
  const tileRender=await readApi(`/projects/${project.id}/resources/${resourceId}/renders/${tiles.plan.items[0].render_job_id}`);
  assert.equal(tileRender.state,"completed");assert.equal(tileHttp.sha256,tileRender.output_checksum_sha256);
  const tileObject=verifyTileAppend(versionsBefore,await readApi(`/projects/${project.id}/datasets/${datasetId}/versions`),tileRender);
  const wms=await prepareStudioWms({page,projectId:project.id,resourceId,origin,organizationId,work,readApi,worker,datasetId});
  const versionsAfterRenders=await readApi(`/projects/${project.id}/datasets/${datasetId}/versions`);
  const http=await readServiceHttp(options),native=await qgis(options);
  assert.deepEqual(JSON.parse(readFileSync(join(work,"queue.json"))),[],"Client reads must not queue processing");
  assert.deepEqual(new Set(http.featureIds),new Set(authored.features.map(feature=>feature.id)));
  const wmsDenied=await withdrawStudioWms({page,origin,projectId:project.id,organizationId,query:wms.query});
  await page.getByText("Published objects · 1",{exact:true}).click();
  await page.locator(".project-service-binding > summary").filter({hasText:"watersheds · sealed and current"}).click();
  await page.getByRole("button",{name:"Withdraw binding",exact:true}).click();
  await page.getByText(/watersheds · withdrawn/).waitFor();
  const httpDenied=await readServiceHttp({...options,denied:true}),qgisDenied=await qgis({...options,denied:true});
  const tileHttpDenied=await readStudioTiles({...options,denied:true});
  assert.deepEqual(JSON.parse(readFileSync(join(work,"queue.json"))),[],"Denied reads must not queue processing");
  assert.deepEqual(await readApi(`/projects/${project.id}/datasets/${datasetId}/versions`),versionsAfterRenders,"Client reads and withdrawals must preserve all version facts and objects");
  const result={authoredAndReopened:true,originalUploadUnchanged:true,collectionSealedThroughStudio:true,http,qgis:native,httpDenied,qgisDenied,tiles,tileHttp,tileHttpDenied,tileRender,tileObject,clientReadsDidNotQueue:true,
    wms,wmsDenied,scope:"Local Studio-authored features, prepared WMTS tiles and named single-layer WMS map; native QGIS and independent HTTP; not automatic upload-to-editable import, deployed acceptance or protocol conformance"};
  writeFileSync(join(work,"service-clients.json"),JSON.stringify(result,null,2)+"\n");
  return result;
}
