import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {chromium} from 'playwright';
const dist=resolve(process.argv[2]),out=resolve(process.argv[3]);assert.ok(!existsSync(out));await mkdir(out,{recursive:true});
const origin='https://spatial-exchange.invalid',errors=[];let browser;
const input={type:'FeatureCollection',license:null,provenance:{source:'survey',confidence:0.5},bbox:[85,27,86,28],
 features:[{type:'Feature',id:'kathmandu',license:'source-specific',properties:{geometry:'survey term',nested:{unit:'m'}},geometry:{type:'Point',coordinates:[85.324,27.7172],meaning:{unit:'degrees'}}}]};
try {
 browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const context=await browser.newContext({acceptDownloads:true});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!==origin){if(url.href.includes('/styles/'))return route.fulfill({json:{version:8,sources:{},layers:[]}});return route.abort();}
  const path=resolve(dist,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));assert.ok(path.startsWith(dist+'/'));
  try {return route.fulfill({contentType:({'.js':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json'})[extname(path)]??'application/octet-stream',body:await readFile(path)});}catch{return route.fulfill({status:404,body:''});}
 });
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin);await page.locator('.opengeo-workbench').waitFor();
 await page.getByRole('button',{name:'Add data',exact:true}).first().click();
 await page.locator('.gis-file-drop input[type=file]').first().setInputFiles({name:'Survey.geojson',mimeType:'application/geo+json',buffer:Buffer.from(JSON.stringify(input))});
 await page.locator('.browser-layer-registration').getByRole('button',{name:'Add Layer to Project',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.__opengeoLayers?.some(l=>l.title==='Survey'));
 await page.getByRole('button',{name:'Layer',exact:true}).click();
 await page.getByRole('menuitem',{name:'Layer properties',exact:true}).click();
 const download=async name=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name,exact:true}).click();const item=await pending;await item.saveAs(resolve(out,item.suggestedFilename()));return JSON.parse(await readFile(await item.path(),'utf8'));};
 const data=await download('Download layer');
 assert.equal(data.license,null);assert.deepEqual(data.provenance,input.provenance);
 assert.equal(data.features[0].license,'source-specific');assert.deepEqual(data.features[0].properties,input.features[0].properties);
 assert.deepEqual(data.features[0].geometry.meaning,{unit:'degrees'});
 assert.equal(Object.hasOwn(data,'bbox'),false);
 const report=await download('Download conversion report');
 assert.deepEqual(report.sourceConversion.preservedSpatialMetadata,[{path:'',member:'bbox',value:input.bbox}]);
 assert.equal(report.format,'geojson');assert.equal(report.propertiesPreserved,true);
 assert.deepEqual(errors,[]);
 const receipt={status:'passed',scope:'Built browser Demo local-file import, review, actual GeoJSON/report downloads; all external requests intercepted. Not deployed acceptance.',nullLicensePreserved:true,nestedProvenancePreserved:true,geometryNamedAttributePreserved:true,sourceBoundsInReport:true,errors};
 await writeFile(resolve(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}finally{await browser?.close();}
