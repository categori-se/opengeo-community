import assert from "node:assert/strict";
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createHash} from "node:crypto";
import {JSDOM} from "jsdom";
import {readServiceMetadata} from "./integrated-studio-service-clients.mjs";
import {verifyDerivedAppend} from "./integrated-studio-tiles.mjs";

const run=promisify(execFile);
const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");
const subsets=["Long(-71.12,-71.04)","Lat(42.34,42.41)"];
const environment={PATH:"/usr/bin:/bin",LANG:"C.UTF-8",PROJ_NETWORK:"OFF",GDAL_PAM_ENABLED:"NO",NO_PROXY:"127.0.0.1",no_proxy:"127.0.0.1",http_proxy:"http://127.0.0.1:9",https_proxy:"http://127.0.0.1:9"};
async function gdal(command,args) {return (await run(`/usr/bin/${command}`,args,{env:environment,timeout:30_000,maxBuffer:2_097_152})).stdout;}

export function decodeCoverageMultipart(body, contentType) {
  assert.ok(body.length<=3_100_000);
  const boundary=contentType.match(/boundary="?([^";\s]+)/i)?.[1];assert.ok(boundary);
  const marker=Buffer.from(`--${boundary}`),parts=[];
  let offset=body.indexOf(marker);
  assert.equal(offset,0);
  while(true) {
    offset+=marker.length;
    if(body.subarray(offset,offset+2).toString()==="--")break;
    assert.equal(body.subarray(offset,offset+2).toString(),"\r\n");offset+=2;
    const endHeader=body.indexOf(Buffer.from("\r\n\r\n"),offset);assert.ok(endHeader>=offset&&endHeader-offset<2048);
    const headers=body.subarray(offset,endHeader).toString();
    const next=body.indexOf(marker,endHeader+4);assert.ok(next>endHeader);
    assert.equal(body.subarray(next-2,next).toString(),"\r\n");
    parts.push({headers,bytes:body.subarray(endHeader+4,next-2)});assert.ok(parts.length<=2);offset=next;
  }
  assert.equal(parts.length,2);assert.match(parts[0].headers,/Content-Type: application\/gml\+xml/i);assert.match(parts[1].headers,/Content-Type: image\/tiff/i);
  return parts;
}

export async function exerciseStudioWcs({page,project,origin,organizationId,work,worker,readApi,publishedObjects=2}) {
  const sourcePath=join(work,"wcs-source.tif"),pgm=join(work,"wcs-source.pgm");
  const pixels=Buffer.from(Array.from({length:64*32},(_,i)=>i%256));
  writeFileSync(pgm,Buffer.concat([Buffer.from("P5\n64 32\n255\n"),pixels]),{flag:"wx"});
  const gdalVersion=(await gdal("gdalinfo",["--version"])).trim();
  assert.equal(gdalVersion,'GDAL 3.11.5 "Eganville", released 2025/10/29');
  await gdal("gdal_translate",["-of","COG","-co","COMPRESS=DEFLATE","-a_srs","EPSG:4326","-a_ullr","-71.15","42.45","-71.00","42.30",pgm,sourcePath]);
  const source=readFileSync(sourcePath),queue=()=>JSON.parse(readFileSync(join(work,"queue.json")));
  await page.locator(`a[href*="project=${project.id}"][href*="manage=data"]`).first().click();
  await page.getByLabel("Dataset, image, or document file",{exact:true}).setInputFiles({name:"elevation.tif",mimeType:"image/tiff",buffer:source});
  await page.getByLabel("Dataset, image, or document name",{exact:true}).fill("Pilot elevation");
  const uploaded=page.waitForResponse(response=>response.url().endsWith("/complete")&&response.request().method()==="POST");
  await page.getByRole("button",{name:"Hash and upload",exact:true}).click();
  const uploadedResponse=await uploaded;assert.equal(uploadedResponse.status(),200);
  const datasetId=(await uploadedResponse.json()).dataset.id;await worker();
  await page.reload();await page.locator(`[data-dataset-id="${datasetId}"]`).waitFor();
  const before=await readApi(`/projects/${project.id}/datasets/${datasetId}/versions`);
  assert.equal(before[0].state,"active");
  const original=before[0].objects.find(item=>item.role==="original");assert.equal(original.checksum_sha256,sha256(source));
  const datasetCard=page.locator(`[data-dataset-id="${datasetId}"]`);
  await datasetCard.getByRole("button",{name:"Metadata & publishing",exact:true}).click();
  await page.getByLabel("Governed dataset license",{exact:true}).fill("CC0-1.0");
  await page.getByLabel("Governed dataset attribution",{exact:true}).fill("OpenGeo synthetic elevation fixture");
  const registered=page.waitForResponse(response=>response.url().endsWith("/resources")&&response.request().method()==="POST");
  await page.getByRole("button",{name:"Create governed catalog record",exact:true}).click();
  const registeredResponse=await registered;assert.equal(registeredResponse.status(),201);
  const metadataResource=await registeredResponse.json();
  await page.locator(`a[href*="project=${project.id}"][href*="manage=services"]`).first().click();
  await page.getByText("Add or retire published objects",{exact:true}).click();
  await page.getByLabel("Validated current COG dataset",{exact:true}).selectOption(datasetId);
  await page.getByLabel("Coverage identifier",{exact:true}).fill("elevation");
  const sealed=page.waitForResponse(response=>response.url().endsWith("/coverages")&&response.request().method()==="POST");
  await page.getByRole("button",{name:"Seal exact current COG",exact:true}).click();
  const sealResponse=await sealed;assert.equal(sealResponse.status(),201);const coverage=await sealResponse.json();
  const discoveryBase=`${origin}/api/projects/${project.id}/services/watershed-pilot/ogc`;
  const metadataRequests=[];
  async function readMetadataHttp(url,authenticated=true) {
    const response=await fetch(url,{redirect:"error",signal:AbortSignal.timeout(10_000),headers:authenticated?
      {authorization:"Bearer synthetic-local-owner","x-opengeo-organization":organizationId}:{}});
    const body=await response.text();assert.ok(Buffer.byteLength(body)<=2_097_152);
    metadataRequests.push({authenticated,status:response.status});
    return {status:response.status,document:body?JSON.parse(body):null};
  }
  // Discovery and its links must use the same externally visible origin. readApi
  // uses a Unix socket with localhost as Host and is unsuitable for link traversal.
  const discoveryResponse=await readMetadataHttp(`${discoveryBase}/collections/elevation`);
  assert.equal(discoveryResponse.status,200);
  const metadataLinks=discoveryResponse.document.links.filter(link=>link.rel==="describedby");
  assert.equal(metadataLinks.length,1);
  const readMetadata=()=>readServiceMetadata({link:metadataLinks[0],baseUrl:discoveryBase,
    projectId:project.id,expectedMetadata:{resourceId:metadataResource.id,license:"CC0-1.0"},
    read:readMetadataHttp});
  const governedMetadata=await readMetadata();
  await page.reload();await page.getByText(`Published objects · ${publishedObjects}`,{exact:true}).click();
  const card=page.locator(".project-service-binding").filter({has:page.locator(":scope > summary").filter({hasText:/^elevation · sealed and current/})});
  await card.locator(":scope > summary").click();
  const preparation=card.locator(".wcs-subset-preparation");await preparation.locator(":scope > summary").click();
  await preparation.getByLabel("WCS subset clauses · one axis trim or slice per line",{exact:true}).fill("Long(*,-71.04)\nLat(42.34,*)");
  const openPlanned=page.waitForResponse(response=>response.url().includes("/subset-plan?")&&response.request().method()==="GET");
  await preparation.getByRole("button",{name:"Preview WCS subset",exact:true}).click();
  const openPlanResponse=await openPlanned;assert.equal(openPlanResponse.status(),200);const openPlan=await openPlanResponse.json();
  const explicitPlan=await readApi(`/projects/${project.id}/services/watershed-pilot/coverages/elevation/subset-plan?${new URLSearchParams([["subset","Lat(42.34,42.45)"],["subset","Long(-71.15,-71.04)"]])}`);
  assert.deepEqual(openPlan,explicitPlan);assert.deepEqual(queue(),[]);
  await preparation.getByLabel("WCS subset clauses · one axis trim or slice per line",{exact:true}).fill(subsets.join("\n"));
  const planned=page.waitForResponse(response=>response.url().includes("/subset-plan?")&&response.request().method()==="GET");
  await preparation.getByRole("button",{name:"Preview WCS subset",exact:true}).click();
  const planResponse=await planned;assert.equal(planResponse.status(),200);const plan=await planResponse.json();
  await preparation.getByText(/34 × 14 pixels/).waitFor();assert.deepEqual(queue(),[]);
  const viewport=page.viewportSize();await page.setViewportSize({width:390,height:844});
  await preparation.scrollIntoViewIfNeeded();
  assert.equal(await preparation.locator("textarea").evaluate(item=>{const b=item.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth;}),true);
  await preparation.screenshot({path:join(work,"wcs-subset-mobile.png")});await page.setViewportSize(viewport);
  const endpoint=`${origin}/api/projects/${project.id}/services/watershed-pilot/wcs`;
  const query=new URLSearchParams({SERVICE:"WCS",VERSION:"2.0.1",REQUEST:"GetCoverage",COVERAGEID:"elevation",FORMAT:"image/tiff",MEDIATYPE:"multipart/related"});
  for(const clause of subsets)query.append("SUBSET",clause);
  const requests=[];
  async function read(parameters,authenticated=true) {
    const response=await fetch(`${endpoint}?${parameters}`,{redirect:"error",signal:AbortSignal.timeout(15_000),headers:{"user-agent":"OpenGeo-Integrated-HTTP/1.0",...(authenticated?{authorization:"Bearer synthetic-local-owner","x-opengeo-organization":organizationId}:{})}});
    const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length<3_100_000);
    requests.push({query:String(parameters),authenticated,status:response.status});return {response,bytes};
  }
  assert.equal((await read(query,false)).response.status,401);
  const multipleQuery=new URLSearchParams({SERVICE:"WCS",VERSION:"2.0.1",REQUEST:"DescribeCoverage",COVERAGEID:"elevation,elevation"});
  const multiple=await read(multipleQuery);assert.equal(multiple.response.status,200);
  const descriptions=new JSDOM(multiple.bytes.toString(),{contentType:"application/xml"});
  const descriptionNodes=[...descriptions.window.document.getElementsByTagNameNS("http://www.opengis.net/wcs/2.0","CoverageId")];
  assert.deepEqual(descriptionNodes.map(item=>item.textContent),["elevation","elevation"]);
  const xmlIds=[...descriptions.window.document.getElementsByTagName("*")].map(item=>item.getAttributeNS("http://www.opengis.net/gml/3.2","id")).filter(Boolean);
  assert.equal(xmlIds.length,6);assert.equal(new Set(xmlIds).size,6);descriptions.window.close();
  const fullOpen=new URLSearchParams(query);fullOpen.delete("SUBSET");fullOpen.append("SUBSET","Long(*,*)");fullOpen.append("SUBSET","Lat(*,*)");
  const fullResponse=await read(fullOpen);assert.equal(fullResponse.response.status,200);
  assert.deepEqual(decodeCoverageMultipart(fullResponse.bytes,fullResponse.response.headers.get("content-type"))[1].bytes,source);
  assert.equal((await read(query)).response.status,503);assert.deepEqual(queue(),[]);
  const queued=page.waitForResponse(response=>response.url().endsWith("/derivatives")&&response.request().method()==="POST");
  await preparation.getByRole("button",{name:"Prepare this WCS subset",exact:true}).click();
  const jobResponse=await queued;assert.equal(jobResponse.status(),202);const job=await jobResponse.json();
  assert.equal(job.request_checksum_sha256,plan.request_checksum_sha256);assert.equal(queue().length,1);
  await worker();assert.deepEqual(queue(),[]);
  const completed=await readApi(`/projects/${project.id}/spatial-services/${coverage.service_id}/coverages/${coverage.id}/derivatives/${job.id}`);
  assert.equal(completed.state,"completed");
  await page.reload();await page.getByText(`Published objects · ${publishedObjects}`,{exact:true}).click();await card.locator(":scope > summary").click();
  await card.getByText(/completed/).first().waitFor();
  const output=await read(query);assert.equal(output.response.status,200);
  const parts=decodeCoverageMultipart(output.bytes,output.response.headers.get("content-type"));
  assert.equal(sha256(parts[1].bytes),completed.output_checksum_sha256);
  assert.equal(output.response.headers.get("x-opengeo-coverage-checksum-sha256"),completed.output_checksum_sha256);
  const xml=new JSDOM(parts[0].bytes.toString(),{contentType:"application/xml"});
  const names=(ns,name)=>xml.window.document.getElementsByTagNameNS(ns,name)[0]?.textContent;
  const grid=names("http://www.opengis.net/gml/3.2","high");assert.equal(grid,"33 13");
  const reference=names("http://www.opengis.net/gml/3.2","fileReference");assert.match(reference,/^cid:/);
  assert.ok(parts[1].headers.includes(`<${reference.slice(4)}>`));xml.window.close();
  const tiff=join(work,"wcs-subset.tif");writeFileSync(tiff,parts[1].bytes,{flag:"wx"});
  const inspected=JSON.parse(await gdal("gdalinfo",["-json","-checksum",tiff]));
  assert.deepEqual(inspected.size,[34,14]);assert.equal(inspected.driverShortName,"GTiff");
  assert.equal(inspected.metadata.IMAGE_STRUCTURE.LAYOUT,"COG");
  // Independent GDAL pixel-window extraction: columns 13..46, rows 9..22.
  // Compare every sample, not only output dimensions or a self-derived checksum.
  const expectedPgm=join(work,"wcs-reference.pgm"),actualPgm=join(work,"wcs-subset.pgm");
  await gdal("gdal_translate",["-of","PNM","-srcwin","13","9","34","14",sourcePath,expectedPgm]);
  await gdal("gdal_translate",["-of","PNM",tiff,actualPgm]);
  assert.deepEqual(readFileSync(actualPgm),readFileSync(expectedPgm));
  assert.deepEqual(inspected.geoTransform,[-71.11953125,0.00234375,0,42.4078125,0,-0.0046875]);
  const cache=join(work,"gdal-wcs-cache");mkdirSync(cache);
  const nativeOptions=["-json","--config","GDAL_PAM_ENABLED","YES","--config","GDAL_PAM_PROXY_DIR",cache,"--config","GDAL_HTTP_HEADERS",`Authorization: Bearer synthetic-local-owner,X-OpenGeo-Organization: ${organizationId}`,"--config","GDAL_HTTP_USERAGENT","OpenGeo-Integrated-GDAL/1.0","--config","GDAL_HTTP_TIMEOUT","10","--config","GDAL_HTTP_MAX_RETRY","0","-oo",`CACHE=${cache}`,"-oo","CLEAR_CACHE=YES"];
  const described=JSON.parse(await gdal("gdalinfo",[...nativeOptions,"-oo","SKIP_GETCOVERAGE=YES",`WCS:${endpoint}?version=2.0.1&coverage=elevation`]));
  assert.equal(described.driverShortName,"WCS");assert.deepEqual(described.size,[64,32]);
  const nativePath=join(work,"wcs-native.tif");
  await gdal("gdal_translate",[...nativeOptions.filter(value=>value!=="-json"),"-oo","BandCount=1","-oo","BandType=Byte","-oo","MediaType=multipart/related","-of","GTiff",`WCS:${endpoint}?version=2.0.1&coverage=elevation`,nativePath]);
  const native=JSON.parse(await gdal("gdalinfo",["-json","-checksum",nativePath]));
  const sourceInfo=JSON.parse(await gdal("gdalinfo",["-json","-checksum",sourcePath]));
  assert.deepEqual(native.size,sourceInfo.size);assert.deepEqual(native.geoTransform,sourceInfo.geoTransform);
  assert.equal(native.bands[0].checksum,sourceInfo.bands[0].checksum);
  const nativePgm=join(work,"wcs-native.pgm");await gdal("gdal_translate",["-of","PNM",nativePath,nativePgm]);
  assert.deepEqual(readFileSync(nativePgm),readFileSync(pgm));assert.deepEqual(queue(),[]);
  const after=await readApi(`/projects/${project.id}/datasets/${datasetId}/versions`);
  const outputObject=verifyDerivedAppend(before,after,{...completed,dataset_version_id:coverage.dataset_version_id},"image/tiff");
  await card.getByRole("button",{name:"Withdraw coverage",exact:true}).click();await page.getByText(/elevation · withdrawn/).waitFor();
  assert.equal((await read(query)).response.status,404);assert.deepEqual(queue(),[]);
  assert.deepEqual(await readApi(`/projects/${project.id}/datasets/${datasetId}/versions`),after,"Withdrawal must preserve all source version facts and objects");
  const metadataAfterWithdrawal=await readMetadata();
  const result={governedMetadata,metadataAfterWithdrawal,metadataRequests,datasetId,coverage,plan,job:completed,outputObject,originalSha256:sha256(source),multipartSha256:sha256(output.bytes),grid,reference,gdalVersion,inspected,described,native,sourceInfo,requests,
    subsetMatchesIndependentPixelWindow:true,nativeFullCoverageSamplesUnchanged:true,
    openBoundsPreviewMatchesExplicit:openPlan,multipleDescriptionsHaveUniqueIds:true,fullOpenBoundsReturnExactSource:true,
    priorSourceVersionFactsAndObjectsUnchanged:true,previewAndReadsDidNotQueue:true,explicitDerivativeCount:1,withdrawnSubsetDenied:true,
    scope:"Local built-Studio COG ingestion, governed native-grid WCS trimming and multipart delivery; native GDAL full-coverage RasterIO with explicit band metadata, not arbitrary on-demand windows or Core conformance"};
  writeFileSync(join(work,"wcs-clients.json"),JSON.stringify(result,null,2)+"\n");return result;
}
