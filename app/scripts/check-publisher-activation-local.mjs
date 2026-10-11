// Exercise the actual staged UI using local-only API fixtures; never publish.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {readFile,readdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const dist=resolve(process.argv[2] ?? fileURLToPath(new URL('../dist/',import.meta.url)));
const output=await mkdtemp('/tmp/opengeo-publisher-activation-');
const modules=await readdir(resolve(dist,'_import/components'));
const project=modules.find(name=>/^ProjectSites\./.test(name));
const directory=modules.find(name=>/^PlatformDirectory\./.test(name));
const theme=(await readdir(resolve(dist,'_observablehq'))).find(name=>name.endsWith('.css'));
const css=(await readdir(resolve(dist,'_file'))).find(name=>/^style\..*\.css$/.test(name));
const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/check') {
    res.setHeader('Content-Type','text/html');
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/_observablehq/${theme}"><link rel="stylesheet" href="/_file/${css}"><main class="platform-surface" id="workspace"></main>`);return;
  }
  const file=resolve(dist,`.${decodeURIComponent(path)}`);
  if(!file.startsWith(dist+'/')){res.writeHead(403).end();return;}
  try {res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json'})[extname(file)]??'application/octet-stream');res.end(await readFile(file));}
  catch{res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
const errors=[],external=[],failures=[];
try {
  browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync)});
  const page=await browser.newPage(),drafts=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('response',response=>{if(response.status()>=400)failures.push({path:new URL(response.url()).pathname,status:response.status()});});
  page.on('requestfailed',request=>failures.push({path:new URL(request.url()).pathname,error:request.failure()?.errorText}));
  await page.route('**/*',route=>{if(route.request().url().startsWith(origin+'/'))return route.continue();external.push(route.request().url());return route.abort();});
  await page.goto(origin+'/check?new=publication');
  await page.evaluate(async module=>{
    const {renderDirectoryState}=await import(`/_import/components/${module}`);
    renderDirectoryState(document.querySelector('#workspace'),{status:'ready',adapter:{kind:'api',saveObservableSourceRevision:async()=>{}},
      session:{displayName:'Publisher test'},organization:{id:'org',name:'Studio',callerRole:'admin'},projects:[],clients:[],teams:[],
      userConnections:[],userBasemapConnections:[],publicationWorkspaces:[]},()=>{},null,{view:'publishing'});
  },directory);
  const expected=['framework','html','map','notebook','jupyter'];
  assert.deepEqual(await page.getByLabel('Publication format',{exact:true}).locator('option:not(:disabled)').evaluateAll(items=>items.map(item=>item.value)),expected);
  assert.equal(await page.getByLabel('Source identifier',{exact:true}).isVisible(),true);
  assert.equal(await page.getByText('Private draft. Choose a public address later in Publish.',{exact:true}).isVisible(),true);
  assert.equal(await page.getByText(/Planned address:/).count(),0);
  for(const width of [1280,390]) {
    await page.setViewportSize({width,height:900});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    await page.screenshot({path:`${output}/new-publication-${width}.png`,fullPage:true});
  }
  for(const format of expected) {
    await page.evaluate(async module=>{
      const {ProjectPublishingWorkspace}=await import(`/_import/components/${module}`);
      window.saved=null;window.calls=[];
      const adapter={kind:'api'};
      for(const method of ['createResource','createSite','createObservableSourceProject'])adapter[method]=async()=>{window.calls.push(method);return{id:method+'-id',versionNumber:1,currentRevisionNumber:0};};
      adapter.saveObservableSourceRevision=async(project,source,draft)=>{
        window.calls.push('saveObservableSourceRevision');
        window.saved={entry:draft.entryPath,files:await Promise.all(draft.files.map(async file=>({path:file.relativePath,media:file.contentType,text:await file.blob.text()})))};
      };
      document.querySelector('#workspace').replaceChildren(ProjectPublishingWorkspace({state:{adapter,organization:{callerRole:'admin'},
        project:{id:'project',name:'Field atlas',callerRole:'owner'},sites:[],resources:[],observableSourceProjects:[]},refresh:async()=>{}}));
    },project);
    await page.locator('summary').filter({hasText:'New publication'}).click();
    await page.getByLabel('Publication format',{exact:true}).selectOption(format);
    await page.getByRole('button',{name:'Set up private publication',exact:true}).click();
    await page.waitForFunction(()=>window.saved!==null);
    const saved=await page.evaluate(()=>({saved:window.saved,calls:window.calls}));
    assert.deepEqual(saved.calls,['createResource','createSite','createObservableSourceProject','saveObservableSourceRevision']);
    assert.equal(saved.saved.entry,format==='framework'?'index.md':format==='jupyter'?'index.ipynb':'index.html');
    assert.equal(JSON.parse(saved.saved.files.find(file=>file.path==='opengeo.publication.json').text).format,format);
    drafts.push({format,entry:saved.saved.entry,files:saved.saved.files.length});
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  const receipt={passed:true,fixtureOnly:true,output,dist,formats:expected,drafts,widths:[1280,390],
    endpointsDeferred:true,publications:0,awsRequests:0,externalRequests:0};
  await writeFile(`${output}/receipt.json`,JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify(receipt));
} catch(error) {
  await writeFile(`${output}/failure.json`,JSON.stringify({errors,external,failures,message:error.message},null,2)+'\n');
  console.error(JSON.stringify({output,errors,external,failures}));throw error;
} finally {await browser?.close();await new Promise(done=>server.close(done));}
