import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
const out=resolve('.local-archives/bhutan-catalog-sync-20260920/browser'),dist=resolve('app/dist');await mkdir(out,{recursive:true});
const component=(await readdir(resolve(dist,'_import/components'))).find(x=>/^PlatformDirectory\..*\.js$/.test(x));
const styles=(await readFile(resolve(dist,'workspaces.html'),'utf8')).match(/href="([^"]+\.css)"/g).map(x=>x.slice(6,-1));
const origin='https://catalog.invalid',receipt={status:'running',externalRequests:0,widths:[]};
const browser=await chromium.launch({executablePath:'/usr/bin/chromium-browser',headless:true,args:['--no-sandbox']});
try{for(const width of [1155,390]){
 const context=await browser.newContext({viewport:{width,height:900},colorScheme:'dark'});const errors=[];
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());if(u.origin!==origin){receipt.externalRequests++;return route.abort();}
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8">${styles.map(h=>`<link rel="stylesheet" href="${h}">`).join('')}<style>body{margin:0;padding:12px;box-sizing:border-box}main{max-width:100%}</style><main class="platform-surface platform-directory"></main><script type="module">
  import {renderDirectoryState} from '/_import/components/${component}';
  const root=document.querySelector('main'),id='f340b616-691b-4770-b22e-03a6913f96f1';
  const records=Array.from({length:50},(_,i)=>({id:'record-'+i,projectId:id,projectName:'Bhutan Geospatial Data',name:'ICIMOD · HKHClimHydro/BasinModel/MapServer:'+i+' · Retained source',sourceType:'arcgis',format:'arcgis',classification:'internal',updatedAt:'2026-09-20T12:00:00Z',spatialSearchAvailable:i%3!==0,sourceSpatialMetadata:{spatialReference:{wkid:4326}},catalogMatchCount:50,preservationSummary:{mapArchives:i%3===0?1:0,dataPreserved:i%3===1,metadataPreserved:true,sourceVersion:1,connectionValidation:'syntax_only'}}));
  const state={status:'ready',adapter:{kind:'api',searchDatasets:async({offset=0,limit=25})=>records.slice(offset,offset+limit)},session:{displayName:'Aaron Dennis',memberships:[]},organization:{id:'account',name:'OpenGeo.tools',callerRole:'admin'},projects:[],clients:[],teams:[],userConnections:[],userBasemapConnections:[],directoryDetailsLoading:false};
  window.renderView=view=>renderDirectoryState(root,state,()=>{},null,{view});window.renderView('data');</script>`});
  try{return route.fulfill({body:await readFile(resolve(dist,'.'+u.pathname)),contentType:u.pathname.endsWith('.js')?'text/javascript':u.pathname.endsWith('.css')?'text/css':'application/octet-stream'});}catch{return route.abort();}
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await page.getByText(/50 matching records/).waitFor();
 assert.equal(await page.locator('.platform-resource-navigation').count(),0);
 await page.getByText('Account settings',{exact:true}).click();await page.getByRole('link',{name:'Teams',exact:true}).waitFor({state:'visible'});await page.getByText('Account settings',{exact:true}).click();
 const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,items:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(e=>({tag:e.tagName,cls:e.className,width:e.getBoundingClientRect().width}))}));console.log(JSON.stringify(overflow));assert.ok(overflow.scroll<=width+1,'Page must fit; table may scroll within its container');
 assert.ok(await page.getByText('Archive ready for map',{exact:true}).count()>0);assert.ok(await page.getByText('Data archive linked',{exact:true}).count()>0);
 await page.screenshot({path:resolve(out,`catalog-${width}.png`)});
 await page.getByRole('button',{name:'Load more',exact:true}).scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelectorAll('.platform-catalog-table tbody tr').length>=48).catch(async()=>{await page.getByRole('button',{name:'Load more',exact:true}).click();});
 await page.evaluate(()=>window.renderView('sources'));await page.getByRole('heading',{name:'Connections',exact:true}).waitFor();
 assert.equal(await page.locator('#source-capabilities').count(),0);assert.equal(await page.locator('.studio-navigation [aria-current]').count(),0);
 await page.evaluate(()=>window.renderView('teams'));await page.getByRole('heading',{name:'Account teams',exact:true}).waitFor();
 assert.equal(await page.locator('.platform-account-navigation [aria-current]').innerText(),'Teams');assert.deepEqual(errors,[]);receipt.widths.push({width,fit:true,accountNavigation:true,catalogIndicators:true,incrementalLoading:true});await context.close();
}assert.equal(receipt.externalRequests,0);receipt.status='passed';}finally{await browser.close();await writeFile(resolve(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));}
