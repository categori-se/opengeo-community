import assert from "node:assert/strict";
import test from "node:test";
import {JSDOM} from "jsdom";
import {ESRI_BASEMAP_OPTIONS, createEsriBasemapSession, esriBasemapDefinition, esriTileConfiguration} from "../src/lib/esriBasemaps.js";
import {EsriBasemapOptions} from "../src/components/EsriBasemapOptions.js";

if (process.env.OPEN_GEO_ESRI_DIST) {await checkEsriBrowser();process.exit(0);}

const ID = "custom-11111111-1111-4111-8111-111111111111";
const KEY = "test-browser-key-not-a-real-credential";
const tile = (option) => option.url.replace("{z}", "2").replace("{x}", "1").replace("{y}", "1");

test("Esri options distinguish public access from keyed services without storing a key", () => {
  const session = createEsriBasemapSession();
  session.configure(KEY);
  for (const option of ESRI_BASEMAP_OPTIONS) {
    const definition = esriBasemapDefinition(option.id, ID);
    assert.equal(definition.kind, "raster");
    assert.equal(new URL(definition.url).search, "");
    assert.ok(!JSON.stringify(definition).includes(KEY));
    assert.equal(esriTileConfiguration(definition.url).tileSize, option.tileSize);
    const request = session.transformRequest(tile(option));
    assert.equal(request.credentials, "omit");
    assert.equal(request.headers?.Authorization, option.requiresKey ? `Bearer ${KEY}` : undefined);
    assert.equal(request.url, tile(option));
  }
  assert.ok(!JSON.stringify(session).includes(KEY));
  session.clear();
  assert.equal(session.configured, false);
  assert.equal(session.transformRequest(tile(ESRI_BASEMAP_OPTIONS[1])).headers, undefined);
  assert.throws(() => esriBasemapDefinition("unknown", ID));
});

test("browser key cannot leak to unrelated hosts, paths, protocols or query URLs", () => {
  const session = createEsriBasemapSession();
  session.configure(KEY);
  for (const url of [
    "https://ibasemaps-api.arcgis.com.evil.example/arcgis/rest/services/World_Imagery/MapServer/tile/2/1/1",
    "http://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/2/1/1",
    "https://ibasemaps-api.arcgis.com:8443/arcgis/rest/services/World_Imagery/MapServer/tile/2/1/1",
    "https://ibasemaps-api.arcgis.com/other-service",
    `${tile(ESRI_BASEMAP_OPTIONS[1])}?redirect=https://evil.example`,
    "https://user:password@ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/2/1/1",
    "https://tiles.arcgis.com/an-unreviewed-organization/tile/2/1/1",
    "https://studio.opengeo.tools/api/projects",
    "not a URL"
  ]) assert.deepEqual(session.transformRequest(url), {url, credentials: "omit"});
  for (const key of ["", "bad\r\nHeader: injected", "bad key", "x".repeat(4097)]) assert.throws(() => session.configure(key));
  assert.equal(createEsriBasemapSession().configured, false);
});

test("Esri configuration requires consent, supports keyed options and clears the password field", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {value: dom.window.document, configurable: true});
  try {
    const selected = [];
    const session = createEsriBasemapSession();
    const panel = EsriBasemapOptions({session, selectBasemap: (value) => {selected.push(value);return true;}});
    const use = [...panel.querySelectorAll("button")].find((button) => button.textContent === "Use Esri basemap");
    const consent = panel.querySelector('[type="checkbox"]');
    const select = panel.querySelector("select");
    const input = panel.querySelector('[type="password"]');
    assert.equal(select.value, "public-imagery");
    assert.equal(select.selectedOptions[0].textContent, "World Imagery · no key required");
    assert.equal(input.closest("label").hidden, true);
    assert.equal(use.disabled, true);
    consent.checked = true;
    consent.dispatchEvent(new dom.window.Event("change"));
    assert.equal(use.disabled, false);
    use.click();
    assert.equal(use.disabled, true);
    await Promise.resolve();
    assert.equal(selected.length, 1);
    assert.equal(session.configured, false);
    select.value = "imagery";
    select.dispatchEvent(new dom.window.Event("change"));
    assert.equal(input.closest("label").hidden, false);
    assert.equal(use.disabled, true);
    input.value = KEY;
    input.dispatchEvent(new dom.window.Event("input"));
    use.click();
    await Promise.resolve();
    assert.equal(session.configured, true);
    assert.equal(input.value, "");
    assert.equal(selected.length, 2);
    assert.ok(!JSON.stringify(selected).includes(KEY));
    [...panel.querySelectorAll("button")].find((button) => button.textContent === "Clear Esri key").click();
    assert.equal(session.configured, false);
    assert.equal(use.disabled, true);
    select.value = "public-imagery";
    select.dispatchEvent(new dom.window.Event("change"));
    assert.equal(input.closest("label").hidden, true);
    assert.equal(use.disabled, false);
    const lunar = EsriBasemapOptions({session, enabled: false, selectBasemap() { assert.fail("must not activate"); }});
    const lunarConsent = lunar.querySelector('[type="checkbox"]');
    lunarConsent.checked = true;
    lunarConsent.dispatchEvent(new dom.window.Event("change"));
    assert.equal(lunar.querySelector("button").disabled, true);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete globalThis.document;
    dom.window.close();
  }
});

test("Esri apply exposes progress, prevents duplicate requests and reports failed checks next to the control", async () => {
  const dom=new JSDOM('<!doctype html><body></body>'),previous=globalThis.document;globalThis.document=dom.window.document;
  try {
    let calls=0,complete;const panel=EsriBasemapOptions({session:createEsriBasemapSession(),selectBasemap:()=>{calls++;return new Promise(resolve=>{complete=resolve;});}});
    document.body.append(panel);const consent=panel.querySelector('[type="checkbox"]'),use=panel.querySelector('.gis-esri-apply'),status=panel.querySelector('[role="status"]');
    consent.checked=true;consent.dispatchEvent(new dom.window.Event('change'));use.click();use.click();
    assert.equal(calls,1);assert.equal(use.disabled,true);assert.equal(consent.disabled,true);assert.equal(panel.getAttribute('aria-busy'),'true');assert.match(status.textContent,/Loading.*current background/);
    complete(false);await Promise.resolve();assert.match(status.textContent,/could not be loaded.*previous background/);assert.equal(use.disabled,false);assert.equal(panel.getAttribute('aria-busy'),'false');
    use.click();complete(true);await Promise.resolve();assert.match(status.textContent,/active/);
    const throwing=EsriBasemapOptions({session:createEsriBasemapSession(),selectBasemap:async()=>{throw Error('Provider internals must not be printed');}});
    const accepted=throwing.querySelector('[type="checkbox"]');accepted.checked=true;accepted.dispatchEvent(new dom.window.Event('change'));throwing.querySelector('.gis-esri-apply').click();await Promise.resolve();await Promise.resolve();
    assert.match(throwing.querySelector('[role="status"]').textContent,/could not be loaded/);assert(!throwing.textContent.includes('Provider internals'));
  }finally{globalThis.document=previous;dom.window.close();}
});

async function checkEsriBrowser() {
  const {readFile,writeFile,mkdir,rename}=await import('node:fs/promises'),{resolve,dirname,extname}=await import('node:path'),{createHash}=await import('node:crypto'),{chromium}=await import('playwright');
  const dist=resolve(process.env.OPEN_GEO_ESRI_DIST),area=dirname(dirname(dist)),batch=resolve('.local-archives/renderer-switch-20260930/esri-activation-fix-20261016'),output=resolve(batch,process.env.OPEN_GEO_ESRI_RUN==='baseline'?'baseline-browser':'final-browser');await mkdir(output,{recursive:true});
  const manifest=JSON.parse(await readFile(resolve(area,'dist/opengeo-studio-build.json'))),files=new Map(manifest.artifactTree.files.map(f=>[f.path,f]));
  const module=name=>'/'+manifest.artifactTree.files.find(f=>f.path.startsWith('_import/'+name+'.')&&f.path.endsWith('.js')).path;
  const entry=await readFile(resolve(dist,'index.html'),'utf8'),styles=[...entry.matchAll(/<link[^>]*href="([^"]+\.css)"[^>]*>/g)].map(m=>`<link rel="stylesheet" href="${m[1]}">`).join('');
  const html=`<!doctype html><meta charset="utf-8">${styles}<style>html,body,#root{height:100%;margin:0}</style><main id="root"></main><script type="module">import {StartPage} from '${module('components/StartPage')}';document.querySelector('#root').append(StartPage({catalog:{workspaces:[]}}));</script>`;
  const tileBytes=await readFile(resolve(batch,'world-imagery-tile.jpg')),hash=b=>createHash('sha256').update(b).digest('hex');
  const receipt={status:'started',buildTree:manifest.artifactTree.digest,limits:{softwareGETs:400,softwareBytes:16777216,seconds:60,localTileResponses:32},softwareGETs:0,softwareBytes:0,localTileResponses:0,AWS:0,API:0,provider:0,saves:0,errors:[],tileSHA256:hash(tileBytes),scope:'Normal compiled Studio Home map, public/no-key consent/apply. One retained real Esri tile reused locally; geographic/provider coverage and user network are not inferred.'};
  let writes=Promise.resolve();const persist=()=>writes=writes.then(async()=>{await writeFile(resolve(output,'receipt.pending'),JSON.stringify(receipt,null,2)+'\n');await rename(resolve(output,'receipt.pending'),resolve(output,'receipt.json'));});await persist();
  if(process.env.OPEN_GEO_ESRI_RUN==='baseline'){const prior=JSON.parse(await readFile(resolve(output,'attempt-1.json')));receipt.priorAttempt={softwareGETs:prior.softwareGETs,softwareBytes:prior.softwareBytes,milliseconds:prior.milliseconds};receipt.limits.softwareGETs-=prior.softwareGETs;receipt.limits.softwareBytes-=prior.softwareBytes;receipt.limits.seconds-=prior.milliseconds/1000;}else{const prior=JSON.parse(await readFile(resolve(batch,'baseline-browser/receipt.json')));receipt.priorBaseline={softwareGETs:prior.softwareGETs+prior.priorAttempt.softwareGETs,softwareBytes:prior.softwareBytes+prior.priorAttempt.softwareBytes,milliseconds:prior.milliseconds+prior.priorAttempt.milliseconds};receipt.limits.softwareGETs=600-receipt.priorBaseline.softwareGETs;receipt.limits.softwareBytes=25165824-receipt.priorBaseline.softwareBytes;receipt.limits.seconds=Math.min(60,(90000-receipt.priorBaseline.milliseconds)/1000);}
  const started=Date.now(),server=await chromium.launchServer({headless:true,executablePath:'/usr/bin/chromium-browser',args:['--no-sandbox','--enable-unsafe-swiftshader','--opengeo-esri-acceptance']}),browser=await chromium.connect(server.wsEndpoint());let page,guard,failedTiles=false;
  try {
    const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
    await context.route('**/*',async route=>{try {
      const request=route.request(),u=new URL(request.url());if(['data:','blob:'].includes(u.protocol))return route.continue();assert(Date.now()-started<receipt.limits.seconds*1000);assert.equal(request.method(),'GET');
      if(u.hostname==='fonts.googleapis.com')return route.abort();
      if(u.href==='https://tiles.openfreemap.org/styles/positron')return route.fulfill({contentType:'application/json',body:JSON.stringify({version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#eef2f4'}}]})});
      if(u.hostname==='services.arcgisonline.com'){
        assert(/^\/arcgis\/rest\/services\/World_Imagery\/MapServer\/tile\/\d+\/\d+\/\d+$/.test(u.pathname));assert.equal(u.search,'');assert.equal(request.headers()['authorization'],undefined);assert(++receipt.localTileResponses<=32);await persist();
        return route.fulfill(failedTiles?{status:503,contentType:'text/plain',body:'Bounded simulated provider outage'}:{contentType:'image/jpeg',body:tileBytes,headers:{'Access-Control-Allow-Origin':'*'}});
      }
      assert.equal(u.origin,'https://compiled-esri.test');assert(!u.pathname.startsWith('/api/'));
      if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:html});
      const file=files.get(decodeURIComponent(u.pathname).slice(1));assert(file,'Unexpected software '+u.pathname);assert(++receipt.softwareGETs<=receipt.limits.softwareGETs);receipt.softwareBytes+=file.bytes;assert(receipt.softwareBytes<=receipt.limits.softwareBytes);await persist();
      const bytes=await readFile(resolve(dist,file.path));assert.equal(hash(bytes),file.sha256);return route.fulfill({body:bytes,contentType:({'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml','.wasm':'application/wasm'})[extname(file.path)]??'application/octet-stream'});
    }catch(error){guard??=error;receipt.guardFailure=error.message;await route.abort().catch(()=>{});}});
    page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>receipt.errors.push(e.message));await page.goto('https://compiled-esri.test/');await page.locator('.start-empty-map').click();
    await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.__opengeoMap?.isStyleLoaded?.());
    await page.evaluate(()=>window.originalMap=document.querySelector('.opengeo-workbench').__opengeoMap);
    const before=await page.evaluate(()=>{const m=window.originalMap;return{center:m.getCenter().toArray(),zoom:m.getZoom(),layers:document.querySelector('.opengeo-workbench').__opengeoLayers.length};});
    await page.locator('.gis-menubar [data-menu="view"] > button').click();await page.getByRole('menuitem',{name:'Change basemap',exact:true}).click();await page.locator('[data-catalog-id="esri-imagery-options"]').click();
    const panel=page.locator('.gis-esri-basemaps'),use=panel.getByRole('button',{name:'Use Esri basemap',exact:true});
    assert.equal(await panel.locator('select').inputValue(),'public-imagery');assert.equal(await panel.locator('input[type="password"]').isVisible(),false);assert.equal(await use.isDisabled(),true);await panel.locator('input[type="checkbox"]').check();await use.click();
    await page.waitForFunction(()=>window.originalMap.getSource('basemap')?.tiles?.[0]?.includes('services.arcgisonline.com'));
    await page.waitForFunction(()=>window.originalMap.areTilesLoaded());receipt.applied=true;receipt.inlineAfterSuccess=await panel.locator('[role="status"]').innerText();
    receipt.sameMap=await page.evaluate(()=>window.originalMap===document.querySelector('.opengeo-workbench').__opengeoMap);assert(receipt.sameMap);
    const active=await page.evaluate(()=>({center:window.originalMap.getCenter().toArray(),zoom:window.originalMap.getZoom(),source:window.originalMap.getSource('basemap').tiles[0],layers:document.querySelector('.opengeo-workbench').__opengeoLayers.length}));assert.deepEqual(active.center,before.center);assert.equal(active.zoom,before.zoom);assert.equal(active.layers,before.layers);receipt.active=active;
    await page.screenshot({path:resolve(output,'applied-dialog.png')});
    if(process.env.OPEN_GEO_ESRI_RUN!=='baseline')assert.match(receipt.inlineAfterSuccess,/active/i);
    failedTiles=true;await use.click();await page.waitForFunction(()=>document.querySelector('.gis-basemap-dialog-feedback')?.dataset.activationState==='failed');
    receipt.inlineAfterFailure=await panel.locator('[role="status"]').innerText();assert.equal(await page.evaluate(()=>window.originalMap.getSource('basemap').tiles[0]),active.source);receipt.failedSelectionRetainsOriginal=true;
    if(process.env.OPEN_GEO_ESRI_RUN!=='baseline')assert.match(receipt.inlineAfterFailure,/could not|failed|unavailable/i);
    await page.screenshot({path:resolve(output,'failed-dialog.png')});
    if(process.env.OPEN_GEO_ESRI_RUN!=='baseline'){
      await page.setViewportSize({width:390,height:844});receipt.themes=[];
      for(const mode of ['light','dark']){
        await page.evaluate(mode=>document.querySelector('.opengeo-workbench').dataset.colorMode=mode,mode);
        const values=await panel.locator('[role="status"]').evaluate(n=>{const c=s=>s.match(/[\d.]+/g).slice(0,3).map(Number),l=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);let p=n,bg=getComputedStyle(p).backgroundColor;while(bg==='rgba(0, 0, 0, 0)'&&p.parentElement){p=p.parentElement;bg=getComputedStyle(p).backgroundColor;}const a=l(c(getComputedStyle(n).color)),b=l(c(bg));return{foreground:getComputedStyle(n).color,background:bg,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};});
        receipt.themes.push({mode,...values});await persist();assert(values.contrast>=4.5);assert(await page.locator('.gis-basemap-dialog').evaluate(n=>n.getBoundingClientRect().width<=innerWidth));await use.scrollIntoViewIfNeeded();await page.screenshot({path:resolve(output,`esri-${mode}-390.png`)});
      }
      await page.setViewportSize({width:1280,height:900});
    }
    await page.getByRole('button',{name:'Close basemap chooser',exact:true}).click();await page.screenshot({path:resolve(output,'imagery-map.png')});
    assert(!guard,guard?.message);assert.deepEqual(receipt.errors,[]);receipt.status=process.env.OPEN_GEO_ESRI_RUN==='baseline'?'baseline-activation-works-inline-outcomes-missing':'passed-public-no-key-activation-and-adjacent-outage-feedback';
  }catch(error){receipt.status='stopped';receipt.failure=error.message;if(page&&!page.isClosed())await page.screenshot({path:resolve(output,'stopped.png')});throw error;}
  finally{await browser.close();await server.close();receipt.browserClosed=true;receipt.milliseconds=Date.now()-started;await persist();}
}
