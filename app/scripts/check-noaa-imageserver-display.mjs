import assert from "node:assert/strict";
import {readFile, writeFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {chromium} from "playwright";
import {imageServerTileUrl} from "../src/lib/imageServer.js";

const readback = JSON.parse(await readFile(process.argv[2], "utf8"));
assert.equal(readback.mode, "runtime RLS readback");
assert.equal(readback.mapDefinition.layers.length, 7);
const mercator = ([x,y]) => [x*Math.PI/180*6378137, Math.log(Math.tan(Math.PI/4+y*Math.PI/360))*6378137];
const bbox = [...mercator([-73.4,40.99]),...mercator([-71.8,41.65])].join(",");
const layers = readback.mapDefinition.layers.map(layer => ({title:layer.title, url:imageServerTileUrl(layer.sourceUrl,layer.sourceConfiguration).replace("{bbox-epsg-3857}",bbox)}));
const browser = await chromium.launch({headless:true,executablePath:["/usr/bin/chromium-browser","/usr/bin/chromium"].find(existsSync)});
try {
  const context = await browser.newContext({serviceWorkers:"block"});
  const page = await context.newPage();
  await page.goto("https://studio.opengeo.tools",{waitUntil:"domcontentloaded"});
  // Real provider requests from the deployed origin; no user credentials,
  // response substitution or original imagery downloads.
  const results = await page.evaluate(async layers => {
    const results=[];
    for (const layer of layers) {
      try {
        const response=await fetch(layer.url,{credentials:"omit",signal:AbortSignal.timeout(30000)});
        const bytes=await response.arrayBuffer();
        const bitmap=await createImageBitmap(new Blob([bytes],{type:response.headers.get("content-type")}));
        const canvas=new OffscreenCanvas(bitmap.width,bitmap.height);
        const ctx=canvas.getContext("2d");ctx.drawImage(bitmap,0,0);
        const pixels=ctx.getImageData(0,0,bitmap.width,bitmap.height).data;
        let visible=0;for(let i=3;i<pixels.length;i+=4) if(pixels[i]) visible++;
        results.push({title:layer.title,status:response.status,bytes:bytes.byteLength,width:bitmap.width,height:bitmap.height,nonTransparentPixels:visible});
        bitmap.close();
      } catch(error) {results.push({title:layer.title,error:error.message});}
    }
    return results;
  },layers);
  const evidence={checkedAt:new Date().toISOString(),origin:"https://studio.opengeo.tools",mode:"real display requests; not owner-session UI acceptance",results};
  await writeFile(process.argv[3],JSON.stringify(evidence,null,2)+"\n");
  console.log(JSON.stringify(evidence,null,2));
  assert.equal(results.length,7);
  for(const result of results) assert.equal(result.status,200,JSON.stringify(result));
  assert.ok(results[0].nonTransparentPixels>0,"Default CIR16 display is empty in the reviewed Connecticut extent");
} finally {await browser.close();}
