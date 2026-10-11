import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {chromium} from 'playwright';
let input='';for await(const chunk of process.stdin) input+=chunk;
const config=JSON.parse(input),origin='https://refresh-browser.invalid',errors=[],requests=[];
if(config.custodyOnly){await custodyBrowser();process.exit(0);}
const bundle=await build({stdin:{contents:`import {ResourceKnowledge} from './src/components/ResourceKnowledge.js';import {OpenGeoApiClient} from './src/lib/apiClient.js';
const adapter=new OpenGeoApiClient({baseUrl:'/api',tokenProvider:()=> 'admin',organizationProvider:()=>${JSON.stringify(config.organizationId)}});
document.querySelector('main').append(ResourceKnowledge({adapter,datasetId:${JSON.stringify(config.datasetId)},projectId:${JSON.stringify(config.projectId)}}));`,resolveDir:resolve('.')},bundle:true,format:'esm',write:false});
const browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--no-sandbox']});
try{
 const context=await browser.newContext();
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
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
 await page.goto(origin);await page.getByRole('button',{name:'Load metadata record',exact:true}).waitFor();
 assert.equal(requests.length,0);
 await page.getByRole('button',{name:'Load metadata record',exact:true}).click();
 await page.getByRole('button',{name:'Check provider metadata',exact:true}).click();
 await page.getByRole('button',{name:'Check metadata progress',exact:true}).click();
 await page.getByText('Provider metadata check: completed.',{exact:false}).waitFor();
 await page.getByRole('button',{name:'Find completed metadata discoveries',exact:true}).click();
 await page.getByRole('button',{name:'Review response',exact:true}).first().click();
 const compare=page.getByRole('region',{name:'Compare provider responses'});
 await compare.getByLabel('Earlier source document').selectOption('0');
 await compare.getByText('Source text differs, beginning',{exact:false}).waitFor();
 await page.getByRole('button',{name:'Accept reviewed response',exact:true}).click();
 await page.getByText('Saved metadata revision 4.',{exact:false}).waitFor();
 await page.reload();await page.getByRole('button',{name:'Load metadata record',exact:true}).click();
 await page.getByText('Metadata revision 4.',{exact:true}).waitFor();
 const saved=await page.getByLabel('Metadata JSON',{exact:true}).inputValue();
 const document=JSON.parse(saved);
 assert.equal(document.metadata.source.length,2);
 assert.equal(document.metadata.curated[0].value,null);
 assert.equal(document.metadata.source[1].content,config.expectedText);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({status:'passed',actualApiAndDatabase:true,componentBundle:true,initialRequests:0,explicitDiscovery:true,manualProgress:true,earlierComparison:true,acceptedAndReopened:true,exactSourceText:true,curationUnchanged:true,requests:requests.length,errors}));
}finally{await browser.close();}

async function custodyBrowser(){
 const candidate=resolve(config.retainedCandidate),assets=resolve(candidate,'app/dist'),release=JSON.parse(await readFile(resolve(candidate,'dist/opengeo-studio-release.json'),'utf8'));
 assert.equal(release.artifactTree.digest,'a919a55aa43d5eed71269db2d9dd4b4cd0086e344ede0123b27ca738b97edb3d');
 const files=new Map(release.artifactTree.files.map(file=>[file.path,file]));
 const module=name=>{const file=release.artifactTree.files.find(file=>new RegExp(`^_import/(?:components|lib)/${name}\\.[a-f0-9]+\\.js$`).test(file.path));assert(file);return '/'+file.path;};
 const knowledge=module('ResourceKnowledge'),client=module('apiClient'),css=release.artifactTree.files.find(file=>/^_file\/style\.[a-f0-9]+\.css$/.test(file.path));assert(css);
 const browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--no-sandbox']});
 let writes=0,softwareRequests=0;
 try{
  const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());assert.equal(url.origin,origin,'No provider/storage request');
   if(url.pathname.startsWith('/api/')){
    assert.equal(url.pathname,`/api/datasets/${config.datasetId}/metadata`);assert(!url.search);assert(['GET','PUT'].includes(request.method()));assert.equal(request.headers().authorization,'Bearer admin');assert.equal(request.headers()['x-opengeo-organization'],config.organizationId);assert(requests.length<11);
    if(request.method()==='PUT'){const body=JSON.parse(request.postData());assert(writes<5);assert.equal(body.expected_version,writes+1);writes++;}
    const response=await route.fetch({url:`http://127.0.0.1:${config.apiPort}${url.pathname.slice(4)}`,maxRetries:0});requests.push({method:request.method(),path:url.pathname,status:response.status()});assert(response.ok());return route.fulfill({response});
   }
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><link rel="stylesheet" href="/${css.path}"><main></main><script type="module">import {ResourceKnowledge} from ${JSON.stringify(knowledge)};import {OpenGeoApiClient} from ${JSON.stringify(client)};const adapter=new OpenGeoApiClient({baseUrl:'/api',tokenProvider:()=> 'admin',organizationProvider:()=>${JSON.stringify(config.organizationId)}});document.querySelector('main').append(ResourceKnowledge({adapter,datasetId:${JSON.stringify(config.datasetId)}}));</script>`});
   const file=files.get(decodeURIComponent(url.pathname).slice(1));assert(file&&softwareRequests<250);const bytes=await readFile(resolve(assets,file.path));assert.equal(bytes.length,file.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);softwareRequests++;return route.fulfill({contentType:({'.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2'})[extname(file.path)]??'application/octet-stream',body:bytes});
  });
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);await page.getByRole('button',{name:'Load metadata record',exact:true}).waitFor();assert.equal(requests.length,0);
  await page.getByRole('button',{name:'Load metadata record',exact:true}).click();await page.getByText('Metadata revision 1.',{exact:true}).waitFor();
  const cases=[['hosted','hosted'],['created','locally_created'],['database-registered','referenced'],['service-copy','hosted'],['live-reference','referenced']],results=[];
  for(let index=0;index<cases.length;index++){
   const [name,custody]=cases[index],id=`urn:distribution:${name}`;
   await page.getByText('Add a representation',{exact:true}).click();await page.getByLabel('Distribution URI',{exact:true}).fill(id);await page.getByLabel('Custody relationship',{exact:true}).selectOption(custody);await page.getByLabel('Access URL (optional)',{exact:true}).fill(`https://example.test/${name}`);await page.getByLabel('Media type (optional)',{exact:true}).fill('application/geo+json');await page.getByRole('button',{name:'Add representation to draft',exact:true}).click();
   await page.getByText('Add a metadata claim',{exact:true}).click();
   const claim=async(property,value,unknown)=>{await page.getByLabel('Applies to',{exact:true}).focus();await page.getByLabel('Applies to',{exact:true}).selectOption(id);await page.getByLabel('Property',{exact:true}).selectOption(property==='type'?'custom':`http://purl.org/dc/terms/${property}`);if(property==='type')await page.getByLabel('Other property URI',{exact:true}).fill('http://purl.org/dc/terms/type');await page.getByLabel('Knowledge state',{exact:true}).selectOption(unknown?'unknown':'known');await page.getByLabel('Claim value',{exact:true}).fill(value);await page.getByRole('button',{name:'Add claim to draft',exact:true}).click();};
   await claim('type',name,false);for(const property of ['license','accessRights','rights'])await claim(property,'',true);
   assert.equal(writes,index,'Guided edits remain drafts until Save');await page.getByRole('button',{name:'Save metadata revision',exact:true}).click();await page.getByText(`Saved metadata revision ${index+2}.`,{exact:true}).waitFor();
   await page.reload();await page.getByRole('button',{name:'Load metadata record',exact:true}).click();await page.getByText(`Metadata revision ${index+2}.`,{exact:true}).waitFor();
   const document=JSON.parse(await page.getByLabel('Metadata JSON',{exact:true}).inputValue());assert.deepEqual(document.metadata.source,config.originalDocument.metadata.source);assert.deepEqual(document.metadata.normalized,config.originalDocument.metadata.normalized);assert.deepEqual(document.metadata.curated[0],config.originalDocument.metadata.curated[0]);assert.deepEqual(document.distributions[0],config.originalDocument.distributions[0]);assert.equal(document.distributions.length,index+2);
   for(const [origin,custody] of cases.slice(0,index+1)){const subject=`urn:distribution:${origin}`;assert.equal(document.distributions.find(distribution=>distribution.id===subject).custody,custody);assert(document.metadata.curated.some(claim=>claim.subject===subject&&claim.property==='http://purl.org/dc/terms/type'&&claim.value===origin));for(const property of ['license','accessRights','rights'])assert(document.metadata.curated.some(claim=>claim.subject===subject&&claim.property===`http://purl.org/dc/terms/${property}`&&claim.value===null&&claim.provenance==='unknown'));}
   assert(await page.getByText(`Custody: ${custody}`,{exact:true}).count());results.push({origin:name,custody,metadataRevision:index+2,reopened:true,distributionRightsRemainUnknown:true});
  }
  assert.equal(writes,5);assert.equal(requests.filter(request=>request.method==='GET').length,6);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'passed',actualSealedUI:true,studioDigest:release.artifactTree.digest,actualHttpAndPostgres:true,guidedWrites:5,persistedReadbacks:5,originClassesDistinct:true,unknownCustodyAndOriginalKnowledgePreserved:true,distributionRightsDoNotInherit:true,sourceOperations:0,providerRequests:0,AWSRequests:0,applicationBuilds:0,softwareRequests,requests:requests.length,results,tokenVerification:'local fixture',limits:['Metadata classification only; no source acquisition, database-table serving or live-provider lifecycle claim.']}));
 }finally{await browser.close();}
}
