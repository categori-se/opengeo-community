import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {cogDisplayEditor, currentProjectDefinition} from "../src/components/WorkbenchView.js";
import {emptyMapDefinition, upgradeMapDefinition} from "../src/lib/mapDefinition.js";
import {cogDisplayOptions} from "../src/lib/cogDisplay.js";

const layer = () => ({layerId: "elevation", datasetId: "70000000-0000-4000-8000-000000000001", title: "Elevation",
  sourceType: "cog-raster", sourceVersion: 7, sourceUrl: "https://imagery.example/elevation.tif",
  sourceConfiguration: {bands: [2], bounds: [0, 0, 8, 8], sizeBytes: 4096, license: "source terms", referenceMetadata: {source: {provider: "retained"}}},
  geometryType: "Raster", visible: true, opacity: 0.8, order: 10, style: {foreign: {preserved: true}}, labels: {enabled: false}});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

it("Project Apply saves only successful display settings and fresh reopen retains exact source and unrelated style", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const value = layer(), original = structuredClone(value), requests = [];
    const session = {result: null, loading: false, refresh(bounds, display) {
      return new Promise((resolve, reject) => requests.push({bounds, display, resolve: result => {this.result = result; resolve(result);}, reject}));
    }, cancel() {requests.at(-1).resolve(undefined);}};
    const context = {layers: [value], project: emptyMapDefinition(), shell: document.body, render() {}, state: {
      layerHandles: new Map([[value.layerId, {cog: session}]]), map: {getBounds: () => ({getWest: () => 1, getSouth: () => 2, getEast: () => 3, getNorth: () => 4})}, activeLayerId: value.layerId}};
    const editor = cogDisplayEditor(context, value); document.body.append(editor);
    const inputs = [...editor.querySelectorAll("input")], form = editor.querySelector("form");
    const button = name => [...editor.querySelectorAll("button")].find(item => item.textContent === name);
    const submit = () => form.dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
    inputs[0].value = "-100"; inputs[1].value = "-200"; submit(); assert.equal(requests.length, 0);
    inputs[1].value = "100"; inputs[2].value = "-9999"; inputs[1].dispatchEvent(new dom.window.Event("input")); assert.equal(requests.length, 0);
    submit(); assert.equal(requests.length, 1); assert.deepEqual(requests[0].bounds, [1, 2, 3, 4]);
    assert.deepEqual(value.style, original.style); requests[0].resolve({pixels: "view-only"}); await tick();
    const applied = {displayRange: {minimum: -100, maximum: 100}, noDataValue: -9999};
    assert.deepEqual(value.style, {...original.style, cogDisplay: applied});
    context.state.map = null;
    const saved = currentProjectDefinition(context), reopened = upgradeMapDefinition(JSON.parse(JSON.stringify(saved)));
    assert.deepEqual(reopened.layers[0], {...original, style: {...original.style, cogDisplay: applied}});
    assert.equal(JSON.stringify(saved).includes("view-only"), false);
    const fresh = cogDisplayEditor({...context, layers: reopened.layers}, reopened.layers[0]);
    assert.deepEqual([...fresh.querySelectorAll("input")].map(input => input.value), ["-100", "100", "-9999"]);
    context.state.map = {getBounds: () => ({getWest: () => 1, getSouth: () => 2, getEast: () => 3, getNorth: () => 4})};
    inputs[1].value = "200"; submit(); requests[1].reject(Error("bounded read failed")); await tick();
    assert.deepEqual(value.style.cogDisplay, applied);
    submit(); button("Cancel raster read").click(); await tick(); assert.deepEqual(value.style.cogDisplay, applied);
    button("Refresh raster window").click(); assert.deepEqual(requests[3].display, applied); requests[3].resolve({}); await tick();
  } finally {if (previous === undefined) delete globalThis.document; else globalThis.document = previous; dom.window.close();}
});

it("saved raster settings reject malformed or wrong-band values without changing legacy definitions", () => {
  const base = layer();
  for (const cogDisplay of [null, {}, {displayRange: {minimum: 1, maximum: 1}}, {displayRange: {minimum: -1e308, maximum: 1e308}},
    {displayRange: {minimum: "0", maximum: 1}}, {displayRange: {minimum: 0, maximum: 1}, noDataValue: Infinity},
    {displayRange: {minimum: 0, maximum: 1}, url: "https://other.example"}]) {
    assert.throws(() => upgradeMapDefinition(emptyMapDefinition({layers: [{...base, style: {cogDisplay}}]})), /finite minimum/);
  }
  const cogDisplay = {displayRange: {minimum: -10, maximum: 10}, noDataValue: null};
  for (const value of [{...base, sourceType: "xyz-raster"}, {...base, sourceConfiguration: {bands: [1, 2, 3]}}]) {
    assert.throws(() => cogDisplayOptions({...value, style: {cogDisplay}}), /one-band/);
  }
  const old = emptyMapDefinition({layers: [base]}); assert.deepEqual(upgradeMapDefinition(old), old);
});

it("compiled Catalog and Project use real scientific raster pixels through Apply, Save and fresh reopen", {
  skip: !process.env.OPEN_GEO_COG_COMPILED_DIST, timeout: 60000
}, async () => {
  const {readFile, writeFile} = await import("node:fs/promises");
  const {resolve, dirname} = await import("node:path");
  const {createHash} = await import("node:crypto");
  const {chromium} = await import("playwright");
  const geotiff = await import("geotiff");
  const viewshedLayoutOnly = process.env.OPEN_GEO_COG_VIEWSHED_LAYOUT_ONLY === "1";
  const viewshedOnly = viewshedLayoutOnly || process.env.OPEN_GEO_COG_VIEWSHED_ONLY === "1";
  const layoutOnly = viewshedLayoutOnly || process.env.OPEN_GEO_COG_CATALOG_LAYOUT_ONLY === "1";
  const inspectOnly = layoutOnly || process.env.OPEN_GEO_COG_INSPECT_ONLY === "1";
  const dist = resolve(process.env.OPEN_GEO_COG_COMPILED_DIST), area = dirname(dirname(dist));
  const manifest = JSON.parse(await readFile(resolve(area, "dist/opengeo-studio-release.json")));
  const files = new Map(manifest.artifactTree.files.map(file => ["/" + file.path, file]));
  const modulePath = name => "/" + [...files.values()].find(file => file.path.startsWith("_import/" + name + ".") && file.path.endsWith(".js")).path;
  const workspaceHTML = await readFile(resolve(dist, "workspaces.html"), "utf8");
  const styles = [...workspaceHTML.matchAll(/<link[^>]*href="([^"]+\.css)"[^>]*>/g)].map(match => `<link rel="stylesheet" href="${match[1]}">`).join("");
  const fixture = new Uint8Array(geotiff.writeArrayBuffer(new Float32Array(Array.from({length: 64}, (_, index) => (viewshedOnly ? [0, 0, 0, 50, 0, -9999, 0, 0] : [-100, -50, 0, 50, 100, -9999, NaN, Infinity])[index % 8])),
    {width: 8, height: 8, SampleFormat: [3], ModelPixelScale: viewshedOnly ? [.001, .001, 0] : [1, 1, 0], ModelTiepoint: [0, 0, 0, 0, viewshedOnly ? .008 : 8, 0], GeographicTypeGeoKey: 4326, GDAL_NODATA: "-9999"}));
  const value = {...layer(), sourceConfiguration: {...layer().sourceConfiguration, ...(viewshedOnly ? {bounds:[0,0,.008,.008]} : {}), bands: [1], sizeBytes: fixture.length}};
  const html = `<!doctype html><meta charset="utf-8">${styles}<style>html,body,#root{height:100%;margin:0}</style><main id="root"></main><script type="module">
    import {MapView} from '${modulePath("components/MapView")}';
    ${layoutOnly ? "" : `import {WorkbenchView} from '${modulePath("components/WorkbenchView")}';`}
    import {upgradeMapDefinition} from '${modulePath("lib/mapDefinition")}';
    const layer = ${JSON.stringify(value)}; const root = document.querySelector('#root');
    window.reference = {sourceUrl:layer.sourceUrl, configuration:layer.sourceConfiguration};
    window.mountProject = definition => {
      root.replaceChildren(WorkbenchView({workspace:{workspaceId:'70000000-0000-4000-8000-000000000002',name:'Local raster'}, role:'owner',
        project:upgradeMapDefinition(definition), layers:definition.layers, restoreBrowserDraft:false, persistenceMode:'fixture',
        saveProject:async definition=>{window.saved=JSON.parse(JSON.stringify(definition));return{id:'70000000-0000-4000-8000-000000000003',version:1,definition:window.saved};}}));
    };
    window.openProject = () => mountProject({schemaVersion:'opengeo.map-definition.1.3.0',activeLayerId:layer.layerId,
      layers:[${inspectOnly || viewshedOnly ? "{...layer,style:{...layer.style,cogDisplay:{displayRange:{minimum:-100,maximum:100},noDataValue:null}}}" : "layer"}],mapViews:[{center:${viewshedOnly ? "[.004,.004],zoom:15" : "[4,4],zoom:5"}}],basemaps:[]});
    root.append(MapView({cog:reference,height:400})); window.ready=true;
  </script>`;
  const limits = viewshedLayoutOnly ? {softwareGETs:90,softwareBytes:8*1024*1024,seconds:30,ranges:2} : viewshedOnly ? {softwareGETs:320,softwareBytes:32*1024*1024,seconds:90,ranges:12} : layoutOnly ? {softwareGETs:80,softwareBytes:8*1024*1024,seconds:30,ranges:8} : inspectOnly ? {softwareGETs:280,softwareBytes:20*1024*1024,seconds:60,ranges:12} : {softwareGETs:1000,softwareBytes:40*1024*1024,seconds:60,ranges:12};
  const begun=Date.now(), receipt = {status:"started",limits,AWS:0,API:0,providerRequests:0,softwareRequests:0,softwareBytes:0,rasterRanges:0,rasterBytes:0,saves:0,errors:[]};
  const browser = await chromium.launch({headless:true, executablePath:"/usr/bin/chromium-browser",args:["--no-sandbox","--enable-unsafe-swiftshader"]});
  try {
    const context = await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:"block"});
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      assert(Date.now()-begun<limits.seconds*1000,"Finite browser window");
      if (["blob:","data:"].includes(url.protocol)) return route.continue();
      if (url.href === value.sourceUrl) {
        assert(receipt.rasterRanges < limits.ranges); const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers().range); assert(match);
        const start = Number(match[1]), end = Math.min(Number(match[2]),fixture.length-1), body = fixture.slice(start,end+1);
        receipt.rasterRanges++; receipt.rasterBytes += body.length;
        return route.fulfill({status:206,body:Buffer.from(body),headers:{"access-control-allow-origin":"*","access-control-expose-headers":"Content-Range,ETag","content-range":`bytes ${start}-${end}/${fixture.length}`,etag:'"local-scientific-fixture"'}});
      }
      if (url.origin === "https://tiles.openfreemap.org" && url.pathname.startsWith("/styles/")) {
        return route.fulfill({contentType:"application/json",body:JSON.stringify({version:8,sources:{},layers:[{id:"background",type:"background",paint:{"background-color":"white"}}]})});
      }
      assert.equal(url.origin,"https://cog.test");
      if (url.pathname === "/") return route.fulfill({contentType:"text/html",body:html});
      const file = files.get(decodeURIComponent(url.pathname)); assert(file,"Unreviewed software request: "+url.pathname);
      assert(receipt.softwareRequests < limits.softwareGETs && receipt.softwareBytes + file.bytes <= limits.softwareBytes);
      const bytes = await readFile(resolve(dist,file.path)); assert.equal(createHash("sha256").update(bytes).digest("hex"),file.sha256);
      receipt.softwareRequests++; receipt.softwareBytes += bytes.length;
      return route.fulfill({body:bytes,contentType:file.path.endsWith(".css")?"text/css":file.path.endsWith(".json")?"application/json":"text/javascript"});
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on("pageerror",error=>receipt.errors.push(error.message));
    await page.goto("https://cog.test/"); await page.waitForFunction(()=>window.ready);
    const openStyle = async () => { await page.getByLabel("Layer actions for Elevation",{exact:true}).click(); await page.getByRole("button",{name:"Style layer",exact:true}).click(); };
    const fill = async () => {
      await page.getByLabel("Display minimum",{exact:true}).fill("-100");
      await page.getByLabel("Display maximum",{exact:true}).fill("100");
      await page.getByRole("button",{name:"Apply display range",exact:true}).click();
    };
    receipt.stage="Catalog initial metadata and range Apply";
    await fill(); await page.waitForFunction(()=>document.querySelector(".map-frame")?.__cogSession?.result?.displayRange?.minimum===-100);
    receipt.catalogColors = await page.evaluate(()=>{const p=document.querySelector(".map-frame").__cogSession.result.pixels;return new Set(Array.from({length:p.length/4},(_,i)=>[...p.slice(i*4,i*4+4)].join(","))).size;});
    assert(receipt.catalogColors >= (viewshedOnly ? 3 : 5));
    if (viewshedLayoutOnly) {
      const panel=page.locator('.gis-grid-viewshed');await panel.locator('summary').click();
      const checkbox=panel.getByLabel('I have reviewed the source terms for this derived output',{exact:true});await checkbox.check();
      const box=await checkbox.boundingBox();assert(box.width<=24&&box.height<=24);
      receipt.checkboxBox=box;await page.screenshot({path:resolve(area,'../catalog-viewshed-checkbox-final.png')});
      receipt.status='passed-compiled-Catalog-viewshed-checkbox-layout';assert.deepEqual(receipt.errors,[]);return;
    }
    if (viewshedOnly) {
      const clickObserver = async catalog => {
        const canvas=page.locator(catalog?'.map-frame canvas.maplibregl-canvas':'.opengeo-workbench canvas.maplibregl-canvas');
        await canvas.scrollIntoViewIfNeeded();
        const point=await page.evaluate(catalog=>{
          const root=document.querySelector(catalog?'.map-frame':'.opengeo-workbench'),box=root.querySelector('canvas.maplibregl-canvas').getBoundingClientRect();
          if(!catalog){const p=root.__opengeoMap.project([.0015,.0035]);return{x:box.left+p.x,y:box.top+p.y};}
          const view=root.__view(),world=512*2**view.zoom,mercator=lat=>(1-Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))/Math.PI)/2;
          return{x:box.left+box.width/2+(.0015-view.center[0])/360*world,y:box.top+box.height/2+(mercator(.0035)-mercator(view.center[1]))*world};
        },catalog);
        await page.mouse.click(point.x,point.y);
      };
      const calculateAndDownload = async catalog => {
        const panel=page.locator('.gis-grid-viewshed');await panel.locator('summary').click();
        await panel.getByLabel('Interpret elevation units',{exact:true}).selectOption('metres');
        await panel.getByLabel('Use this band as elevation',{exact:true}).check();
        await panel.getByLabel('Analysis grid (maximum cells per side)',{exact:true}).selectOption('9');
        await panel.getByRole('button',{name:'Choose observer on map',exact:true}).click();await clickObserver(catalog);
        await panel.getByText('Observer selected. Calculate when ready.',{exact:true}).waitFor();
        const rangesBefore=receipt.rasterRanges;
        await panel.getByRole('button',{name:'Calculate viewshed',exact:true}).click();
        await panel.getByText('Viewshed ready. No additional raster reads were made.',{exact:true}).waitFor();
        await panel.getByLabel('Inspect cached column',{exact:true}).fill('4');await panel.getByLabel('Inspect cached row',{exact:true}).fill('4');
        await panel.getByRole('button',{name:'Inspect cell',exact:true}).click();await panel.locator('dd').filter({hasText:/^occluded$/}).waitFor();
        await panel.getByLabel('I have reviewed the source terms for this derived output',{exact:true}).check();
        const [download]=await Promise.all([page.waitForEvent('download'),panel.getByRole('button',{name:'Download viewshed GeoJSON',exact:true}).click()]);
        const bytes=await readFile(await download.path()),data=JSON.parse(bytes);assert.equal(data.features.length,48);
        assert.deepEqual(data.opengeo.input.window,[0,0,6,8]);
        assert.equal(data.opengeo.observer.pixel.column,1);assert.equal(data.opengeo.observer.pixel.row,4);
        assert.equal(data.features.find(f=>f.properties.column===4&&f.properties.row===4).properties.visibility,'occluded');
        assert.equal(data.features.find(f=>f.properties.column===5&&f.properties.row===4).properties.visibility,'unknown');
        assert.equal(data.features.find(f=>f.properties.column===2&&f.properties.row===4).properties.visibility,'visible');
        assert.equal(receipt.rasterRanges,rangesBefore);assert.equal(data.opengeo.source.source.url,value.sourceUrl);
        receipt[catalog?'catalogOutput':'projectOutput']={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),counts:data.opengeo.counts};
        return data;
      };
      receipt.stage='Catalog cached DEM observer pointer, ridge/NoData analysis and actual GeoJSON download';
      await calculateAndDownload(true);await page.screenshot({path:resolve(area,'../catalog-grid-viewshed.png')});
      receipt.stage='Project cached DEM observer pointer, analysis, download and deliberate temporary map result';
      await page.evaluate(()=>openProject());await page.waitForFunction(()=>Boolean(document.querySelector('.opengeo-workbench')?.__opengeoMap?.getSource('elevation-source')?.getCanvas()));
      await openStyle();const output=await calculateAndDownload(false),rangesBeforeAdd=receipt.rasterRanges;
      await page.getByRole('button',{name:'Add temporary result to map',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('.opengeo-workbench').__opengeoLayers.length===2);
      const state=await page.evaluate(()=>{const root=document.querySelector('.opengeo-workbench'),layers=root.__opengeoLayers,map=root.__opengeoMap;return{layers,data:root.__opengeoData.get(layers[0].layerId),style:map.getStyle().layers};});
      assert.equal(state.layers[0].sourceType,'geojson-object');assert.deepEqual(state.data.features,output.features);assert.deepEqual(state.data.opengeo,output.opengeo);
      assert.equal(state.data['opengeo:analysis'].persisted,false);
      assert.deepEqual(state.layers[1].sourceConfiguration,value.sourceConfiguration);
      assert.deepEqual(state.layers[1].style,{...value.style,cogDisplay:{displayRange:{minimum:-100,maximum:100},noDataValue:null}});
      const rasterIndex=state.style.findIndex(item=>item.id==='elevation-cog'),outputIndex=state.style.findIndex(item=>item.source===state.layers[0].layerId+'-source');
      assert(rasterIndex>=0&&outputIndex>rasterIndex);assert.equal(state.style[outputIndex].type,'fill');
      assert(JSON.stringify(state.style[outputIndex].paint).includes('visibility_code'));
      assert.equal(receipt.rasterRanges,rangesBeforeAdd);assert.equal(receipt.saves,0);assert.deepEqual(receipt.errors,[]);
      await page.screenshot({path:resolve(area,'../project-grid-viewshed.png')});
      receipt.status='passed-compiled-Catalog-Project-cached-grid-viewshed-download-add';receipt.analysisAddedRanges=0;
      receipt.limit='Real local Float32 TIFF and compiled MapLibre with blank basemap; source-preserving local derivation, no hosted persistence or provider accuracy claim.';return;
    }
    if (inspectOnly) {
      const clickAt = async (longitude,latitude,catalog) => {
        const point=await page.evaluate(({longitude,latitude,catalog})=>{
          const root=document.querySelector(catalog?'.map-frame':'.opengeo-workbench'),canvas=root.querySelector('canvas.maplibregl-canvas'),box=canvas.getBoundingClientRect();
          if(!catalog){const p=root.__opengeoMap.project([longitude,latitude]);return{x:box.left+p.x,y:box.top+p.y};}
          const view=root.__view(),world=512*2**view.zoom;
          const mercator=latitude=>(1-Math.log(Math.tan(Math.PI/4+latitude*Math.PI/360))/Math.PI)/2;
          return{x:box.left+box.width/2+(longitude-view.center[0])/360*world,y:box.top+box.height/2+(mercator(latitude)-mercator(view.center[1]))*world};
        },{longitude,latitude,catalog});
        await page.mouse.click(point.x,point.y);
      };
      const catalog=page.getByRole('region',{name:'Raster values'}),rangesBefore=receipt.rasterRanges;
      receipt.stage='Catalog real pointer raw/NoData inspection';
      await clickAt(1.25,6.75,true);await catalog.locator('dd').filter({hasText:/^-50$/}).waitFor();
      await clickAt(5.25,6.75,true);await catalog.getByText('NoData (-9999)',{exact:true}).waitFor();
      assert.equal(receipt.rasterRanges,rangesBefore);
      await page.getByLabel('Transparent value (optional)',{exact:true}).fill('-50');await page.getByRole('button',{name:'Apply display range',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('.map-frame').__cogSession.result?.noDataValue===-50);
      const rangesAfterApply=receipt.rasterRanges;await clickAt(1.25,6.75,true);
      await catalog.getByText("This value is hidden by the display's transparent-value setting.",{exact:true}).waitFor();
      assert.equal(receipt.rasterRanges,rangesAfterApply);await page.screenshot({path:resolve(area,layoutOnly?'../catalog-controls-final.png':'../catalog-cached-identify.png')});
      if (layoutOnly) {
        const refresh=page.getByRole('button',{name:'Refresh raster window',exact:true});
        const refreshBox=await refresh.boundingBox(),fieldset=await page.locator('.map-preview-raster-controls fieldset').boundingBox();
        assert(refreshBox && fieldset && refreshBox.y+refreshBox.height<=fieldset.y,'Refresh stays above display fields');
        assert.equal(await refresh.evaluate(node=>getComputedStyle(node).position),'static');
        receipt.status='passed-compiled-Catalog-controls-flow';receipt.identifyAddedRanges=0;assert.deepEqual(receipt.errors,[]);return;
      }
      receipt.stage='Project real pointer cached inspection without a feature-query service';
      await page.evaluate(()=>openProject());await page.waitForFunction(()=>Boolean(document.querySelector('.opengeo-workbench')?.__opengeoMap?.getSource('elevation-source')?.getCanvas()));
      const before=receipt.rasterRanges;await clickAt(1.25,6.75,false);
      const panel=page.locator('.gis-identify-panel');await panel.locator('dd').filter({hasText:/^-50$/}).waitFor();
      assert.doesNotMatch(await panel.innerText(),/0 matches|Identify unavailable|Add a governed/);
      await clickAt(5.25,6.75,false);await panel.getByText('NoData (-9999)',{exact:true}).waitFor();
      await clickAt(4.25,6.75,false);await panel.locator('dd').filter({hasText:/^100$/}).waitFor();
      assert.equal(receipt.rasterRanges,before);assert.equal(receipt.saves,0);
      await page.screenshot({path:resolve(area,'../project-cached-identify.png')});
      receipt.status='passed-compiled-Catalog-Project-cached-raster-Identify';receipt.rawValues=[-50,100];receipt.sourceNoData=-9999;
      receipt.displayMask=-50;receipt.identifyAddedRanges=0;receipt.fixture='Real Float32 TIFF and compiled MapLibre; blank basemap, no live provider/account/API';
      assert.deepEqual(receipt.errors,[]);return;
    }
    receipt.stage="Project range Apply and Save";
    await page.evaluate(()=>openProject()); await page.waitForFunction(()=>document.querySelector(".opengeo-workbench")?.__opengeoMap?.isStyleLoaded());
    await openStyle(); await fill(); await page.waitForFunction(()=>document.querySelector(".opengeo-workbench").__opengeoLayers[0].style.cogDisplay?.displayRange.minimum===-100);
    await page.getByRole("button",{name:"Save",exact:true}).first().click(); await page.waitForFunction(()=>window.saved); receipt.saves++;
    const saved = await page.evaluate(()=>window.saved); assert.deepEqual(saved.layers[0].sourceConfiguration,value.sourceConfiguration);
    assert.deepEqual(saved.layers[0].style,{...value.style,cogDisplay:{displayRange:{minimum:-100,maximum:100},noDataValue:null}});
    receipt.stage="Project fresh reopen";
    await page.evaluate(()=>mountProject(saved));
    await page.waitForFunction(()=>Boolean(document.querySelector(".opengeo-workbench")?.__opengeoMap?.getSource("elevation-source")?.getCanvas()));
    await openStyle(); assert.equal(await page.getByLabel("Display minimum",{exact:true}).inputValue(),"-100");
    receipt.reopenedColors = await page.evaluate(()=>{const c=document.querySelector(".opengeo-workbench").__opengeoMap.getSource("elevation-source").getCanvas(),p=c.getContext("2d").getImageData(0,0,c.width,c.height).data;return new Set(Array.from({length:p.length/4},(_,i)=>[...p.slice(i*4,i*4+4)].join(","))).size;});
    assert(receipt.reopenedColors>=5); assert.deepEqual(receipt.errors,[]);
    await page.screenshot({path:resolve(area,"../compiled-scientific-cog.png")});
    receipt.status="passed-compiled-Catalog-and-Project-save-fresh-reopen-local-persistence";
    receipt.limit="Local synthetic real Float32 TIFF, actual compiled components and MapLibre; fixture Save callback. No fresh provider, hosted auth or API-persistence claim; basemap local blank.";
  } catch (error) {
    receipt.failure=String(error.message).slice(0,1200);
    const pages=browser.contexts().flatMap(context=>context.pages());
    if(pages[0]) {receipt.visibleText=(await pages[0].locator("body").innerText()).slice(-3500);await pages[0].screenshot({path:resolve(area,"../compiled-scientific-cog-stopped.png")});}
    throw error;
  } finally {await browser.close();receipt.browserClosed=true;receipt.elapsedMilliseconds=Date.now()-begun; await writeFile(resolve(area,viewshedLayoutOnly?"../compiled-viewshed-layout.json":viewshedOnly?"../compiled-grid-viewshed.json":layoutOnly?"../compiled-catalog-controls.json":"../compiled-scientific-cog.json"),JSON.stringify(receipt,null,2)+"\n");}
});
