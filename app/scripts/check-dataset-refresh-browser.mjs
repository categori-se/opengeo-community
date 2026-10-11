import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';
let input='';for await(const chunk of process.stdin) input+=chunk;
const config=JSON.parse(input),origin='https://dataset-refresh.invalid',errors=[],requests=[];let uploads=0;
const bundle=await build({stdin:{contents:`import {DatasetRefresh} from './src/components/DatasetRefresh.js';import {OpenGeoApiClient} from './src/lib/apiClient.js';
window.actor='admin';const adapter=new OpenGeoApiClient({baseUrl:'/api',tokenProvider:()=>window.actor,organizationProvider:()=>${JSON.stringify(config.organizationId)}});
const dataset=await adapter.getCatalogDataset(${JSON.stringify(config.datasetId)});window.currentVersion=dataset.currentVersionId;
document.querySelector('main').append(DatasetRefresh({adapter,dataset}));`,resolveDir:resolve('.')},bundle:true,format:'esm',write:false});
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
 const check=()=>page.getByRole('button',{name:'Check processing and candidates',exact:true});
 const inspect=()=>page.getByRole('button',{name:'Review selected candidate',exact:true});
 async function review(){
  await check().click();await page.getByText('Candidate status updated.',{exact:false}).waitFor();
  await page.getByLabel('Staged data version',{exact:true}).selectOption(config.candidateVersionId);
  await inspect().click();await page.getByText('Review ready.',{exact:false}).waitFor();
  if(config.expectedDimension) assert.match(await page.locator('tr').filter({hasText:'Declared coordinate dimension'}).innerText(),new RegExp(String(config.expectedDimension)));
 }
 await page.goto(origin);await check().waitFor();
 assert.equal(requests.length,1);assert.equal(requests[0][0],'GET');
 await review();
 if(config.capture) await page.getByText("Provider-reported query matches:",{exact:false}).waitFor();
 else await page.getByText("The source's independent feature count is unknown.",{exact:true}).waitFor();
 const accept=()=>page.getByRole('button',{name:'Make this version current',exact:true});
 assert.equal(await accept().isDisabled(),true);
 assert.equal(await page.evaluate(()=>window.currentVersion),config.baseVersionId);
 // Reopening resumes the same retained candidate; no upload or processing occurs.
 await page.reload();await check().waitFor();await review();
 await page.getByRole('checkbox').check();
 await page.evaluate(()=>{window.actor='editor';});
 await accept().click();await page.getByText('You no longer have access to update this Layer.',{exact:true}).waitFor();
 await page.reload();await check().waitFor();
 assert.equal(await page.evaluate(()=>window.currentVersion),config.baseVersionId);
 await review();await page.getByRole('checkbox').check();await accept().click();
 await page.getByText('Layer data updated.',{exact:true}).waitFor();
 await page.reload();await check().waitFor();
 assert.equal(await page.evaluate(()=>window.currentVersion),config.candidateVersionId);
 await check().click();await page.getByText('Candidate status updated.',{exact:false}).waitFor();
 assert.equal(await page.getByLabel('Staged data version').locator('option').count(),1);
 assert.equal(requests.filter(([method,path])=>method==='POST'&&path.endsWith('/accept')).length,2);
 if(config.upload){
  const bytes=Buffer.from(JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',properties:{name:'Browser staged point'},geometry:{type:'Point',coordinates:config.coordinateZ==null?[85,27]:[85,27,config.coordinateZ]}}]}));
  await page.getByLabel('Candidate data file',{exact:true}).setInputFiles({name:'browser-candidate.geojson',mimeType:'application/geo+json',buffer:bytes});
  await page.getByRole('button',{name:'Stage candidate',exact:true}).click();
  await page.getByText('Candidate queued.',{exact:false}).waitFor();
  assert.equal(uploads,1);
  await page.reload();await check().waitFor();
  assert.equal(await page.evaluate(()=>window.currentVersion),config.candidateVersionId);
  await check().click();await page.getByText('Candidate status updated.',{exact:false}).waitFor();
  const queued=page.getByLabel('Staged data version').locator('option').filter({hasText:'queued'});
  assert.equal(await queued.count(),1);assert.equal(await queued.isDisabled(),true);
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({status:'passed',actualApiAndDatabase:true,componentBundle:true,initialRequests:1,initialWrites:0,manualCandidateRecovery:true,reviewAcknowledgement:true,readerAcceptanceDenied:true,acceptedAndReopened:true,requests:requests.length,errors,uploadBrowserVerified:Boolean(config.upload),syntheticStorageUploads:uploads,workerExecutionVerified:false}));
}finally{await browser.close();}
