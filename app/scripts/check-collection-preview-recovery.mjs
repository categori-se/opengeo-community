import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
const dist=resolve(process.argv[2]),out=resolve(process.argv[3]);assert.ok(!existsSync(out));await mkdir(out,{recursive:true});
const file=(await readdir(resolve(dist,'_import/components'))).find(f=>f.startsWith('CollectionDirectory.')&&f.endsWith('.js'));
const modulePath=`/_import/components/${file}`,origin='https://collection-recovery.invalid',errors=[],blocked=[];let browser,imageReads=0;
try{
 browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--no-sandbox']});
 const context=await browser.newContext({serviceWorkers:'block'});
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());if(u.origin!==origin){blocked.push(u.href);return route.abort();}
  if(u.pathname==='/preview.png'){imageReads++;return route.fulfill(u.searchParams.get('fail')==='yes'?{status:503,body:''}:{contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nWQAAAAASUVORK5CYII=','base64')});}
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><main></main><script type="module">
   import {CollectionDirectory} from '${modulePath}';
   const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');window.state={reads:0,failMetadata:true,failImage:true};
   const record={id:id(1),title:'Preview collection',description:'',revision:1,role:'owner',members:[{entry_id:id(2),kind:'project',target_id:id(3),title:'Survey',available:true}]};
   const adapter={kind:'api',listCollections:async()=>[record],getCollection:async()=>structuredClone(record),collectionImagePreviews:async()=>{state.reads++;if(state.failMetadata)throw Error('Unavailable');return [{entryId:id(2),title:'Survey',url:'/preview.png?fail='+(state.failImage?'yes':'no'),license:'CC0',attribution:'Fixture'}];}};
   window.component=CollectionDirectory({adapter});document.querySelector('main').append(component);
  </script>`});
  const path=resolve(dist,'.'+u.pathname);assert.ok(path.startsWith(dist+'/'));return route.fulfill({contentType:extname(path)==='.js'?'text/javascript':'application/octet-stream',body:await readFile(path)});
 });
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
 const click=name=>page.getByRole('button',{name,exact:true}).click();
 await click('Load image previews');await page.getByText(/Image previews could not load/).waitFor();
 await page.evaluate(()=>state.failMetadata=false);await click('Load image previews');await page.getByText(/An image is unavailable/).waitFor();
 await page.evaluate(()=>state.failImage=false);await click('Load image previews');await page.waitForFunction(()=>[...document.images].some(i=>i.complete&&i.naturalWidth===1));
 assert.equal(await page.locator('figure').count(),1);
 await click('Preview collection');await page.getByLabel('Collection title',{exact:true}).fill('Unsaved title');
 await page.evaluate(()=>{state.failMetadata=true;state.failImage=true;});await click('Load member previews');await page.getByText(/Previews could not load/).waitFor();
 await page.evaluate(()=>state.failMetadata=false);await click('Load member previews');await page.getByText(/An image is unavailable.*member link/).waitFor();
 await page.evaluate(()=>state.failImage=false);await click('Load member previews');await page.waitForFunction(()=>document.querySelector('ol img')?.naturalWidth===1);
 assert.equal(await page.getByLabel('Collection title',{exact:true}).inputValue(),'Unsaved title');assert.equal(await page.evaluate(()=>component.hasUnsavedChanges()),true);
 assert.equal(await page.getByRole('link',{name:'Project: Survey',exact:true}).count(),1);assert.equal(await page.evaluate(()=>state.reads),6);assert.ok(imageReads>=3&&imageReads<=4,'Two failed image reads and successful decoding; the browser may reuse the successful image');assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
 const receipt={status:'passed',scope:'Built Collection component, deterministic metadata and image failures; not real API authorization or hosted acceptance.',component:modulePath,sha256:createHash('sha256').update(await readFile(resolve(dist,'.'+modulePath))).digest('hex'),metadataRequests:6,imageRequests:imageReads,externalRequests:0,unsavedDraftPreserved:true,imageDecoded:true,duplicateFigures:0};
 await writeFile(resolve(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}finally{await browser?.close();}
