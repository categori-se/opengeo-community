// Build the retained real Framework project, not a substitute one-page fixture.
// No original files, public routes or cloud resources are changed.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readdir, readFile, writeFile, mkdir} from 'node:fs/promises';
import {join, dirname, resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright';
import {PodmanRunner, podmanArguments} from '../../services/observable-coordinator/src/podman-runner.mjs';
import {DATA_INVOCATION_SCHEMA, REQUEST_SCHEMA, REQUIRED_SANDBOX, sha256} from '../../services/observable-coordinator/src/contracts.mjs';
import {inspectInputs} from '../../services/observable-builder/src/contract.mjs';

const imageDigest=process.argv[2]; assert.match(imageDigest??'',/^sha256:[a-f0-9]{64}$/);
const root=resolve(new URL('../..',import.meta.url).pathname);
const source=join(root,'.local-archives/studio-discovery-release-20260912/root-original');
const work=await mkdtemp('/tmp/opengeo-framework-project-container-');
const inputs=new Map();
const media=path=>({md:'text/markdown',js:'text/javascript',json:'application/json',geojson:'application/geo+json',css:'text/css',png:'image/png'})[path.split('.').at(-1)];
async function collect(prefix='') {
  for(const item of await readdir(join(source,prefix),{withFileTypes:true})) {
    const path=prefix+item.name;
    if(item.isDirectory()) await collect(path+'/');
    else {assert(item.isFile(),'No symlinks in the retained source');assert(media(path),path);inputs.set(path,await readFile(join(source,path)));}
  }
}
await collect();
const files=[...inputs].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,body])=>({path,contentType:media(path),sizeBytes:body.length,checksumSha256:sha256(body)}));
const limits={cpuMillis:1000,memoryMiB:2048,timeoutSeconds:120,maxInputFiles:128,maxInputBytes:16*1024*1024,maxOutputFiles:512,maxOutputBytes:32*1024*1024};
const largeAttachment='src/data/examples/temane-water-areas-local.geojson';
// This retained 18 MiB file uses the existing separately bounded data-attachment
// contract, exactly as the reviewed root ingestion path does. No bytes omitted.
const invocation={schemaVersion:DATA_INVOCATION_SCHEMA,buildJobId:randomUUID(),requestChecksumSha256:'b'.repeat(64),inputManifestChecksumSha256:'c'.repeat(64),
  entryPath:'src/index.md',lockfilePath:'package-lock.json',files:files.filter(file=>file.path!==largeAttachment),dataFiles:files.filter(file=>file.path===largeAttachment),
  request:{schemaVersion:REQUEST_SCHEMA,sourceProjectId:randomUUID(),sourceRevisionId:randomUUID(),sourceRevisionNumber:2,
    sourceManifestChecksumSha256:'c'.repeat(64),purpose:'preview',compilerImageDigest:imageDigest,frameworkVersion:'1.13.4',
    lockfileFormat:'npm-package-lock-v3',lockfileChecksumSha256:sha256(inputs.get('package-lock.json')),networkPolicy:'deny_all',resourceLimits:limits}};
const receipt={imageDigest,sourceFiles:files.length,sourceManifest:files,compiled:false,sourceUnchanged:false,publicationAuthorized:false,awsRequests:0};
let browser;
try {
  const runner=new PodmanRunner();
  const incremental=process.argv.includes('--incremental');
  const result=await runner.run({invocation,inputs,limits,...(incremental?{incrementalPageCache:{}}:{})});
  assert.deepEqual(result.sandbox,REQUIRED_SANDBOX);
  receipt.compiled=true;receipt.outputFiles=result.outputs.size;receipt.outputTreeChecksumSha256=result.report.outputTreeChecksumSha256;
  for(const [path,bytes] of result.outputs) {const target=join(work,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes);}
  browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync)});
  const page=await browser.newPage(); const external=[], missing=[], errors=[];
  page.on('pageerror', error=>errors.push(error.message));
  const origin='https://framework-project.invalid';
  await page.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin) {external.push(url.href);return route.abort();}
    const path=decodeURIComponent(url.pathname).replace(/\/$/,'/index.html');
    const resolved=result.outputs.has('dist'+path)?path:path+'.html';
    const bytes=result.outputs.get('dist'+resolved);
    if(!bytes) missing.push(path);
    return route.fulfill({status:bytes?200:404,contentType:resolved.endsWith('.html')?'text/html':media(resolved)||'application/octet-stream',body:bytes??Buffer.from('Not found')});
  });
  await page.goto(origin);
  await page.getByRole('heading',{name:'Field-ready workflows for spatial analysis, mapping, and infrastructure screening.'}).waitFor();
  await page.locator('.site-card').first().waitFor();
  receipt.reactiveCards=await page.locator('.site-card').count();
  receipt.projectHeader=await page.locator('.site-header-shell').count();
  receipt.projectFooter=await page.locator('.site-footer-shell').count();
  receipt.projectStyles=await page.locator('link[rel="stylesheet"]').evaluateAll(links=>links.map(link=>link.getAttribute('href')));
  receipt.blockedExternalRequests=external;
  await page.screenshot({path:join(work,'root.png'),fullPage:true});
  assert.equal(receipt.projectHeader,1,'The authored Framework header must be preserved');
  assert.equal(receipt.projectFooter,1,'The authored Framework footer must be preserved');
  await page.goto(origin+'/toolkit/visualization/leaflet');
  const map=page.locator('.leaflet-container');
  await map.waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('.leaflet-overlay-pane path').length>0);
  receipt.localMapFeatures=await page.locator('.leaflet-overlay-pane path').count();
  receipt.mapPositioning=await map.evaluate(element=>({overflow:getComputedStyle(element).overflow,
    panePosition:getComputedStyle(element.querySelector('.leaflet-map-pane')).position}));
  assert.equal(receipt.mapPositioning.overflow,'hidden','Leaflet packaged CSS must load');
  assert.equal(receipt.mapPositioning.panePosition,'absolute');
  const before=await page.locator('.leaflet-overlay-pane').innerHTML();
  await page.locator('.leaflet-control-zoom-in').click();
  await page.waitForFunction(previous=>document.querySelector('.leaflet-overlay-pane').innerHTML!==previous,before);
  receipt.mapZoomChangesGeometry=true;
  await map.screenshot({path:join(work,'leaflet.png')});
  receipt.missingOutputRequests=missing;
  receipt.browserErrors=errors;
  assert.deepEqual(missing,[]);
  assert.deepEqual(errors,[]);
  if(incremental) {
    const pageCount=result.report.routeManifest.length;
    assert.equal(result.incrementalPageCache.stats.rendered,pageCount);
    const unchanged=await runner.run({invocation,inputs,limits,incrementalPageCache:result.incrementalPageCache});
    assert.equal(unchanged.incrementalPageCache.stats.rendered,0);
    assert.equal(unchanged.incrementalPageCache.stats.reused,pageCount);
    assert.deepEqual(unchanged.outputs,result.outputs);
    // Change the module imported by authored head/header/footer functions, not
    // the config wrapper itself. Only an in-memory test copy is edited.
    const changedInputs=new Map(inputs), changedPath='src/data/site.js';
    const previous=changedInputs.get(changedPath).toString();
    const changed=previous.replace('title: "OpenGeo.tools"','title: "OpenGeo compatibility check"');
    assert.notEqual(changed,previous);
    changedInputs.set(changedPath,Buffer.from(changed));
    const changedInvocation=structuredClone(invocation);
    const file=changedInvocation.files.find(file=>file.path===changedPath);
    file.sizeBytes=Buffer.byteLength(changed);file.checksumSha256=sha256(Buffer.from(changed));
    const edited=await runner.run({invocation:changedInvocation,inputs:changedInputs,limits,
      incrementalPageCache:unchanged.incrementalPageCache});
    assert.equal(edited.incrementalPageCache.stats.rendered,pageCount);
    assert.equal(edited.incrementalPageCache.stats.reused,0);
    for(const [path,body] of edited.outputs) if(path.endsWith('.html')) {
      assert.match(body.toString(),/<strong>OpenGeo compatibility check<\/strong>/);
    }
    const clean=await runner.run({invocation:changedInvocation,inputs:changedInputs,limits});
    assert.deepEqual(edited.outputs,clean.outputs);
    receipt.incremental={cold:result.incrementalPageCache.stats,unchanged:unchanged.incrementalPageCache.stats,
      importedConfigurationChanged:edited.incrementalPageCache.stats,cleanBytesIdentical:true};
  }
  receipt.passed=true;
} catch(error) {
  receipt.passed=false;receipt.error=String(error.message);process.exitCode=1;
  // Read-only source validation explains admission failures without exposing
  // compiler stdout, executing user code on the host, or loosening the runner.
  try {inspectInputs(invocation,source);receipt.inputValidation='passed';}
  catch(inputError) {receipt.inputValidation=inputError.code??String(inputError.message);}
  if (process.argv.includes('--diagnose') && receipt.inputValidation === 'passed') {
    // Diagnostic-only native rerun. Same UID, network, memory and filesystem
    // restrictions; compiler output stays in this local private artifact folder.
    const paths=Object.fromEntries(['contract','input','workspace','result'].map(name=>[name,join(work,name)]));
    for (const directory of Object.values(paths)) await mkdir(directory,{mode:0o700});
    await writeFile(join(paths.contract,'invocation.json'),JSON.stringify(invocation));
    for (const [path,bytes] of inputs) {const target=join(paths.input,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes);}
    const diagnostic=join(work,'diagnostic.mjs');
    await writeFile(diagnostic,`import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
const original=cp.spawnSync; cp.spawnSync=(...args)=>{const result=original(...args);
writeFileSync('/result/process.json',JSON.stringify({status:result.status,signal:result.signal,error:result.error?.code,stdout:String(result.stdout??''),stderr:String(result.stderr??'')}));return result;};
syncBuiltinESMExports();
const {runBuild}=await import('/srv/opengeo/src/contract.mjs');
try {runBuild({invocation:JSON.parse(readFileSync('/contract/invocation.json')),inputRoot:'/input',workspaceRoot:'/workspace/job',
observableCliPath:'/srv/opengeo/node_modules/.bin/observable',frameworkCacheRoot:'/opt/opengeo-framework-cache',
allowSourceConfiguration:process.env.OPEN_GEO_FRAMEWORK_PROJECT_CONFIG==='isolated'});}
catch(error) {writeFileSync('/result/failure.json',JSON.stringify({code:error.code,message:error.message}));process.exitCode=1;}
`);
    const args=podmanArguments({...paths,imageDigest,limits});
    args.splice(args.indexOf(imageDigest),0,'--entrypoint','/nodejs/bin/node',`--volume=${diagnostic}:/diagnostic.mjs:ro,Z`);
    args.push('/diagnostic.mjs');
    const diagnosticRun=spawnSync('podman',args,{encoding:'utf8',timeout:125000,maxBuffer:1024*1024});
    receipt.diagnosticExitCode=diagnosticRun.status;
    receipt.diagnosticDirectory=paths.result;
  }
}
finally {
  if(browser) await browser.close();
  receipt.sourceUnchanged=(await Promise.all(files.map(async file=>sha256(await readFile(join(source,file.path)))===file.checksumSha256))).every(Boolean);
  await writeFile(join(work,'receipt.json'),JSON.stringify(receipt,null,2));
  console.log(JSON.stringify({...receipt,sourceManifest:undefined,artifactDirectory:work}));
}
