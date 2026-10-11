// Built components with deterministic account records; no hosted authentication claim.
import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {chromium} from 'playwright';
const root=resolve('app/dist'),out=resolve('.local-archives/studio-header-20260920/header-fixture');
const module=(await readdir(resolve(root,'_import/components'))).find(x=>/^StartPage\..*\.js$/.test(x));
const styles=(await readFile(resolve(root,'index.html'),'utf8')).match(/href="([^"]+\.css)"/g).map(x=>x.slice(6,-1));
const waybackConfig=await readFile('.local-archives/wayback-20260920/config.json');
const origin='https://header.invalid',id='50000000-0000-4000-8000-000000000099';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium-browser',headless:true});
const receipt={status:'running',scope:'Built Studio components, fixture adapter and empty basemap; no real sign-in or external requests',widths:[]};
await mkdir(out,{recursive:true});
try{for(const width of [1155,390]){
 let waybackReads=0;
 const context=await browser.newContext({viewport:{width,height:966},hasTouch:width===390});
 await context.addInitScript(()=>localStorage.setItem('opengeo.workbench.color-mode','dark'));
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.href==='https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json'){waybackReads++;return route.fulfill({contentType:'application/json',body:waybackConfig});}
  if(url.origin!==origin){if(url.pathname.includes('/styles/'))return route.fulfill({json:{version:8,sources:{},layers:[]}});return route.abort();}
  if(url.pathname==='/workspaces')return route.fulfill({contentType:'text/html',body:'<p>Selected saved Project route</p>'});
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html>${styles.map(h=>`<link rel="stylesheet" href="${h}">`).join('')}<style>html,body{margin:0}</style><script type="module">import {StartPage} from '/_import/components/${module}';window.compositionReads=0;document.body.append(StartPage({adapter:{kind:'api',getSession:async()=>({userId:'test',selectedOrganizationId:'org',memberships:[{organizationId:'org'}]}),selectOrganization:()=>{},listRecentProjects:async()=>[],listCompositions:async()=>{window.compositionReads++;return [{id:'${id}',name:'Bhutan · Boundaries'}];}},auth:{}}));</script>`});
  try{const file=resolve(root,'.'+url.pathname);assert.ok(file.startsWith(root+'/'));return route.fulfill({contentType:({'.js':'text/javascript','.css':'text/css','.json':'application/json'})[extname(file)]??'application/octet-stream',body:await readFile(file)});}catch{return route.abort();}
 });
 const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.getByRole('button',{name:'Close start panel and use an empty map'}).click();
 await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.__opengeoMap?.isStyleLoaded());
 assert.equal(await page.evaluate(()=>window.compositionReads),0);
 assert.doesNotMatch(await page.locator('.gis-app-nav').innerText(),/Demo|Sample datasets|Open Studio/);
 const select=page.getByRole('combobox',{name:'Switch project',exact:true});await select.focus();
 await page.waitForFunction(()=>document.querySelector('.gis-workspace-select option[value="50000000-0000-4000-8000-000000000099"]'));
 assert.equal(await page.evaluate(()=>window.compositionReads),1);
 const toggle=page.locator('.gis-controls-command');
 assert.equal(await toggle.evaluate(el=>{const b=el.getBoundingClientRect(),a=el.parentElement.lastElementChild.getBoundingClientRect();return b.right<=a.left+1&&b.left>=0&&a.right<=innerWidth+1;}),true);
 if(width===390)await toggle.click();
 for(const mode of ['globe','terrainEnabled','openScene3dEnabled','graticule','rightOpen'])assert.equal(await page.locator(`[data-map-mode="${mode}"]`).isVisible(),true);
 await page.locator('[data-map-mode="globe"]').click();assert.equal(await page.locator('[data-map-mode="globe"]').getAttribute('aria-pressed'),'true');
 await toggle.click();
 if(width===390){await page.getByRole('button',{name:'Actions',exact:true}).click();await page.locator('[data-mobile-command-category="controls"] > summary').click();await page.getByRole('menuitem',{name:'Imagery history',exact:true}).click();}
 else await page.getByRole('button',{name:'Imagery history',exact:true}).click();
 const info=page.locator('.gis-history-provenance');await info.scrollIntoViewIfNeeded();
 assert.equal(await info.evaluate(el=>{const dl=el.querySelector('dl'),dt=dl.querySelector('dt'),dd=dl.querySelector('dd');return dl.scrollWidth<=dl.clientWidth+1&&dd.getBoundingClientRect().top>=dt.getBoundingClientRect().bottom-1&&dd.scrollWidth<=dd.clientWidth+1;}),true);
 await page.screenshot({path:resolve(out,`source-info-${width}.png`)});
 assert.equal(waybackReads,0);
 const mapBefore=await page.locator('.opengeo-workbench').evaluate(el=>JSON.stringify(el.__opengeoMap.getStyle().sources));
 await page.getByLabel('Imagery source to explore',{exact:true}).selectOption('esri-world-imagery-wayback');
 await page.getByLabel('Wayback release date',{exact:true}).waitFor();
 assert.equal(waybackReads,1);
 await page.getByLabel('Wayback release date',{exact:true}).selectOption('10');
 const link=page.getByRole('link',{name:'Open selected release in Wayback ↗',exact:true});
 assert.match(await link.getAttribute('href'),/active=10$/);
 assert.equal(await link.getAttribute('target'),'_blank');
 assert.equal(await page.locator('.opengeo-workbench').evaluate(el=>JSON.stringify(el.__opengeoMap.getStyle().sources)),mapBefore);
 await page.screenshot({path:resolve(out,`wayback-${width}.png`)});
 page.once('dialog',dialog=>dialog.accept());await select.selectOption(id);await page.waitForURL('**/workspaces?composition='+id);
 assert.deepEqual(errors,[]);receipt.widths.push({width,projectRouteCorrect:true,metadataFits:true,toggleBesideAccount:true,globeWorks:true,noEagerProjectFetch:true,waybackMetadataOnly:true,waybackReleaseLink:true});await context.close();
}receipt.status='passed';}catch(e){receipt.status='failed';receipt.error=String(e);throw e;}finally{await browser.close();await writeFile(resolve(out,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));}
