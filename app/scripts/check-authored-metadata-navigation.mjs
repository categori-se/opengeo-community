// Built metadata/account controls with local adapter fixtures; no live authentication.
import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
const dist=resolve(process.argv[2]),out=resolve(process.argv[3]);assert.ok(!existsSync(out));await mkdir(out,{recursive:true});
const files=await readdir(resolve(dist,'_import/components'));
const moduleFor=name=>'/_import/components/'+files.find(f=>f.startsWith(name+'.')&&f.endsWith('.js'));
const metadata=moduleFor('AuthoredResourceMetadata'),account=moduleFor('StudioAccountControls');
const origin='https://metadata-navigation.invalid',errors=[],blocked=[],results=[];let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--no-sandbox']});
 const context=await browser.newContext({serviceWorkers:'block'});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!==origin){blocked.push(url.href);return route.abort();}
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><nav><a href="/elsewhere">Leave Studio</a><select aria-label="Studio account"><option value="one">One</option><option value="two">Two</option></select></nav><main></main><script type="module">
   import {AuthoredResourceMetadata,guardAuthoredMetadata} from '${metadata}';import {StudioAccountControls} from '${account}';
   const kind=new URL(location.href).searchParams.get('kind'),id=kind+'-identity';
   window.state={reads:0,saves:0,signouts:0,accountChanges:0};let record={version:0,canEdit:true,document:{schemaVersion:'1.0.0',distributions:[],metadata:{source:[],normalized:[],curated:[],inferred:[]},context:[]}};
   const adapter={getAuthoredKnowledge:async(k,i)=>{if(k!==kind||i!==id)throw Error('Wrong identity');state.reads++;return structuredClone(record);},saveAuthoredKnowledge:async(k,i,p)=>{if(k!==kind||i!==id||p.expectedVersion!==record.version)throw Error('Wrong save identity');state.saves++;await new Promise(resolve=>window.finishSave=resolve);record={version:1,canEdit:true,document:p.document};return structuredClone(record);}};
   document.querySelector('nav').append(StudioAccountControls({signedIn:true,hasUnsavedChanges:()=>false,auth:{signOut:async()=>state.signouts++}}));
   document.querySelector('select').addEventListener('change',()=>state.accountChanges++);
   const host=document.querySelector('main');window.guard=guardAuthoredMetadata(host);host.append(AuthoredResourceMetadata({adapter,kind,id}));
  </script>`});
  const path=resolve(dist,'.'+url.pathname);assert.ok(path.startsWith(dist+'/'));return route.fulfill({contentType:extname(path)==='.js'?'text/javascript':'application/octet-stream',body:await readFile(path)});
 });
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 for(const kind of ['project','publication']){
  await page.goto(origin+'/?kind='+kind);await page.locator('summary').click();
  await page.getByRole('button',{name:'Load metadata record',exact:true}).click();
  await page.getByText('Edit metadata record',{exact:true}).click();
  const input=page.getByLabel('Metadata JSON',{exact:true});await input.waitFor();
  const draft=JSON.parse(await input.inputValue());draft.metadata.curated.push({subject:'resource',property:'http://purl.org/dc/terms/license',value:null,provenance:'unknown'});await input.fill(JSON.stringify(draft));
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByLabel('Studio account',{exact:true}).selectOption('two');await page.getByRole('link',{name:'Leave Studio'}).click();
  assert.equal(page.url(),origin+'/?kind='+kind);assert.equal(await page.getByLabel('Studio account',{exact:true}).inputValue(),'one');assert.equal(await page.evaluate(()=>state.signouts+state.accountChanges),0);
  await page.getByRole('button',{name:'Save metadata revision',exact:true}).click();await page.waitForFunction(()=>typeof finishSave==='function');
  await page.getByRole('button',{name:'Sign out',exact:true}).click();assert.equal(await page.evaluate(()=>state.signouts),0,'Pending save also blocks sign-out');
  await page.evaluate(()=>finishSave());await page.getByText(/Saved metadata revision 1/).waitFor();
  await page.getByLabel('Studio account',{exact:true}).selectOption('two');await page.getByRole('button',{name:'Sign out',exact:true}).click();
  const state=await page.evaluate(()=>window.state);assert.equal(state.saves,1);assert.equal(state.signouts,1);assert.equal(state.accountChanges,1);results.push({kind,...state});
 }
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
 const reviewedFiles=[];for(const path of [metadata,account])reviewedFiles.push({path,sha256:createHash('sha256').update(await readFile(resolve(dist,'.'+path))).digest('hex')});
 const receipt={status:'passed',scope:'Built authored metadata and real account-control components with fixture persistence/auth; not full workspace rendering or live authentication.',results,reviewedFiles,externalRequests:0,pageErrors:errors};await writeFile(resolve(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}finally{await browser?.close();}
