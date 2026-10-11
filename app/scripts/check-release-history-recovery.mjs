// Exercise the built component with deterministic failures; no live API or storage.
import assert from 'node:assert/strict';
import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve, extname} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
const dist=resolve(process.argv[2] ?? 'dist'), out=resolve(process.argv[3] ?? '../.local-archives/release-history-browser');
assert.ok(!existsSync(out),'Preserve existing acceptance evidence');
await mkdir(out,{recursive:true});
const file=(await readdir(resolve(dist,'_import/components'))).find(f=>f.startsWith('ArtifactReleases.')&&f.endsWith('.js'));
assert.ok(file);const modulePath=`/_import/components/${file}`,origin='https://release-recovery.invalid',blocked=[],errors=[];
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--no-sandbox']});
 const context=await browser.newContext({serviceWorkers:'block'});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!==origin){blocked.push(url.href);return route.abort();}
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><main></main><script type="module">
   import {ArtifactReleases} from '${modulePath}';
   window.state={fail:false,published:0,revoked:0};
   const record={id:'release-1',title:'Reviewed image',version_number:1,license:'CC0-1.0'};
   const adapter={listArtifactReleases:async()=>{if(state.fail)throw Error('History unavailable');return {can_publish:true,has_more:false,records:state.published?[{...record,revoked_at:state.revoked?'now':null}]:[]};},
    publicArtifactReleaseUrl:async()=>'/public/image',createArtifactRelease:async()=>{state.published++;state.fail=true;return record;},revokeArtifactRelease:async()=>{state.revoked++;state.fail=true;}};
   window.component=ArtifactReleases({adapter});document.querySelector('main').append(component);component.setTarget({id:'artifact-1',version_number:1});
  </script>`});
  const path=resolve(dist,'.'+url.pathname);assert.ok(path.startsWith(dist+'/'));
  return route.fulfill({contentType:extname(path)==='.js'?'text/javascript':'application/octet-stream',body:await readFile(path)});
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
 const click=name=>page.getByRole('button',{name,exact:true}).click();
 await page.goto(origin);await click('Load public releases');await click('Publish inspected image');
 await page.getByLabel('Release title',{exact:true}).fill('Reviewed image');await page.getByLabel('Output attribution',{exact:true}).fill('Local fixture');await page.getByLabel('Output license',{exact:true}).selectOption('CC0-1.0');
 await click('Publish this image publicly');await page.getByText(/Public release created: release-1\. Release history could not refresh/).waitFor();
 assert.equal(await page.locator('dialog').evaluate(d=>d.open),false);
 await page.evaluate(()=>{state.fail=false;});await click('Load public releases');await page.getByRole('link',{name:'Open public output'}).waitFor();
 await click('Revoke public release');await page.getByText(/Public release revoked\. Release history could not refresh/).waitFor();
 assert.equal(await page.getByRole('link',{name:'Open public output'}).count(),0);assert.equal(await page.getByRole('button',{name:'Revoke public release'}).count(),0);
 await page.evaluate(()=>{state.fail=false;});await click('Load public releases');await page.getByText(/Saved public releases loaded/).waitFor();
 const counts=await page.evaluate(()=>state);assert.equal(counts.published,1);assert.equal(counts.revoked,1);assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
 await page.screenshot({path:resolve(out,'recovered.png')});
 const receipt={status:'passed',scope:'Built component in Chromium with local adapter fixtures; not API persistence, hosted or full-shell acceptance.',component:modulePath,sha256:createHash('sha256').update(await readFile(resolve(dist,'.'+modulePath))).digest('hex'),published:counts.published,revoked:counts.revoked,confirmedMutationHistoryRecovery:true,revokedLinkRemoved:true,externalRequests:blocked.length,pageErrors:errors};
 await writeFile(resolve(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}finally{await browser?.close();}
