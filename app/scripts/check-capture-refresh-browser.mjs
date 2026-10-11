import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';
let input='';for await(const chunk of process.stdin) input+=chunk;
const config=JSON.parse(input),origin='https://dataset-refresh.invalid',errors=[],requests=[];let uploads=0;
const bundle=await build({stdin:{contents:`import {CaptureRefresh} from './src/components/CaptureRefresh.js';import {OpenGeoApiClient} from './src/lib/apiClient.js';
window.actor='admin';const adapter=new OpenGeoApiClient({baseUrl:'/api',tokenProvider:()=>window.actor,organizationProvider:()=>${JSON.stringify(config.organizationId)}});
const dataset=await adapter.getCatalogDataset(${JSON.stringify(config.datasetId)});window.currentVersion=dataset.currentVersionId;
document.querySelector('main').append(CaptureRefresh({adapter,dataset}));`,resolveDir:resolve('.')},bundle:true,format:'esm',write:false});
const browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--no-sandbox']});
try{
 const context=await browser.newContext();
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(config.upload && url.href==='https://s3.us-east-1.amazonaws.com/local.invalid') {
   uploads++;assert.equal(route.request().method(),'POST');
   const response=await route.fetch({url:`http://127.0.0.1:${config.apiPort}/_fixture/upload`});
   return route.fulfill({response});
  }
  assert.equal(url.origin,origin,'Unexpected external request');
  if(url.pathname.startsWith('/api/')) {
   requests.push([route.request().method(),url.pathname]);
   const response=await route.fetch({url:`http://127.0.0.1:${config.apiPort}${url.pathname.slice(4)}${url.search}`});
   return route.fulfill({response});
  }
  if(url.pathname==='/bundle.js') return route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text});
  return route.fulfill({contentType:'text/html',body:'<!doctype html><main></main><script type="module" src="/bundle.js"></script>'});
 });
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin);
 const inspect=page.getByRole('button',{name:'Inspect connected refresh source',exact:true});
 await inspect.waitFor();assert.equal(requests.length,1);
 await inspect.click();await page.getByText('The prior capture area',{exact:false}).waitFor();
 if(config.failure) {
  assert.equal(await page.evaluate(()=>window.currentVersion),config.baseVersionId);
  await page.getByRole('button',{name:'Inspect earlier source refreshes',exact:true}).click();
  await page.getByText('The source reported a different feature count than it returned.',{exact:false}).waitFor();
  assert.equal(requests.filter(([method])=>method!=='GET').length,0);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'passed',currentVersionRetained:true,clearCountFailure:true,inspectionWrites:0,errors}));
 } else {
 await page.getByRole('button',{name:'Review refresh estimate',exact:true}).click();
 await page.getByText('Review the capture scope, rights and limits.',{exact:false}).waitFor();
 for(const checkbox of await page.getByRole('checkbox').all()) await checkbox.check();
 await page.getByRole('button',{name:'Start source refresh',exact:true}).click();
 await page.getByText('Source refresh queued',{exact:false}).waitFor();
 assert.equal(requests.filter(([method,path])=>method==='POST'&&path.endsWith('/protected-copies')).length,1);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({status:'passed',actualApiAndDatabase:true,componentBundle:true,explicitConfirmation:true,initialWrites:0,requests:requests.length,errors}));
 }
}finally{await browser.close();}
