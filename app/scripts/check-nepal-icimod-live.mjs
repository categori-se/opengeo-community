// Real retained provider samples through the deployed-build live feature reader.
import assert from 'node:assert/strict';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';

const out=resolve('../.local-archives/nepal-srilanka-catalog-20260921/nepal-icimod-services-20260923');
const plan=JSON.parse(await readFile(resolve(out,'catalog-plan.json')));
const registered=JSON.parse(await readFile(resolve(out,'catalog-registration.json'))).records;
const probes=JSON.parse(await readFile(resolve(out,'live-display-probe.json'))).records;
const inputs=plan.records.filter(r=>r.service==='Nepal/Hydropower');
const layers=inputs.map((row,index)=>{
  const source=row.request.source,id=registered.find(r=>r.url===row.url).datasetId;
  return {layerId:'source_'+id,datasetId:id,title:row.request.name,sourceType:'external-feature-reference',
    sourceVersion:1,sourceUrl:row.url,sourceConfiguration:{objectIdField:source.object_id_field,
      fields:source.fields,geometryType:source.geometry_type,pageSize:source.page_size,attribution:'ICIMOD'},
    geometryType:source.geometry_type,bbox:[80,26,89,31],visible:false,opacity:1,order:index,style:{},labels:{}};
});
assert.equal(layers.length,4);
const workbench=(await readdir('dist/_import/components')).find(n=>/^WorkbenchView\.[a-f0-9]+\.js$/.test(n));
const origin='https://nepal-icimod.invalid';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium-browser',headless:true,
  args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const reads=[],errors=[];
try {
  const context=await browser.newContext({viewport:{width:1200,height:850},serviceWorkers:'block'});
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.hostname==='geoapps.icimod.org'){
      assert.equal(route.request().method(),'GET');
      const endpoint=url.origin+url.pathname.replace(/\/query$/,'');
      const probe=probes.find(p=>p.url===endpoint);
      assert.ok(probe && url.pathname.endsWith('/query'));
      reads.push(endpoint);
      return route.fulfill({contentType:'application/geo+json',body:await readFile(resolve(out,probe.path))});
    }
    assert.equal(url.origin,origin,'Unexpected external request');
    if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/maplibre.css"><style>html,body{margin:0}.opengeo-workbench{height:100vh}</style><script type="module">
      import {WorkbenchView} from '/_import/components/${workbench}';
      const layers=${JSON.stringify(layers).replaceAll('<','\\u003c')};
      window.shell=WorkbenchView({workspace:{workspaceId:'3fa15fb0-0823-4a9a-94cb-1bbbf10baa5e',title:'Nepal ICIMOD'},
        project:{layers,mapViews:[{center:[84.8,28],zoom:6}],basemaps:[{basemapId:'blank',title:'Blank',kind:'blank',visible:true}],bookmarks:[]},
        layers,role:'owner',persistenceMode:'api'});document.body.append(shell);</script>`});
    const file=url.pathname==='/style.css'?resolve('src/style.css'):url.pathname==='/maplibre.css'?
      resolve('node_modules/maplibre-gl/dist/maplibre-gl.css'):resolve('dist','.'+url.pathname);
    return route.fulfill({body:await readFile(file),contentType:file.endsWith('.js')?'text/javascript':'text/css'});
  });
  const page=await context.newPage();page.setDefaultTimeout(30000);
  page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
  await page.waitForFunction(()=>shell.__opengeoMap?.isStyleLoaded());
  if(process.argv.includes('--inspect')){
    console.log(JSON.stringify({checkboxes:await page.getByRole('checkbox').evaluateAll(nodes=>nodes.map(n=>({label:n.getAttribute('aria-label'),title:n.title}))),text:await page.locator('body').innerText(),errors}));
    await page.screenshot({path:resolve(out,'hydropower-browser-inspect.png')});
    process.exitCode=0;await browser.close();process.exit(0);
  }
  assert.equal(reads.length,0);
  for(const layer of layers)await page.getByLabel('Show '+layer.title,{exact:true}).check();
  await page.waitForFunction(ids=>ids.every(id=>{
    const map=shell.__opengeoMap,paint=map.getStyle().layers.filter(l=>l.source===id+'-source').map(l=>l.id);
    return paint.length && map.queryRenderedFeatures({layers:paint}).length>0;
  }),layers.map(l=>l.layerId));
  assert.deepEqual(errors,[]);assert.deepEqual(new Set(reads),new Set(inputs.map(r=>r.url)));
  await page.screenshot({path:resolve(out,'hydropower-browser.png')});
  const result={status:'passed',layers:4,hiddenProviderReads:0,interceptedProviderReads:reads.length,uncaughtErrors:0,
    scope:'Actual built Workbench and live-feature reader with exact retained one-feature provider samples. Transport intercepted; not hosted sign-in or complete source inventory.',
    externalRequests:0};
  await writeFile(resolve(out,'hydropower-browser.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await browser.close();}
