import {chromium} from "playwright";
import {readdir, readFile, mkdir, writeFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {createServer} from "node:http";
import {resolve, extname} from "node:path";
import {fileURLToPath} from "node:url";
import assert from "node:assert/strict";

const currentGrouping = process.argv.includes('--current-grouped-resources');
let currentBundle;
if(currentGrouping) {
  const {build}=await import('esbuild');
  const built=await build({stdin:{resolveDir:resolve('app'),contents:"export {organizationCatalog} from './src/components/PlatformDirectory.js';"},
    bundle:true,format:'esm',write:false,plugins:[{name:'local-stdlib',setup(builder){
      builder.onResolve({filter:/^observablehq:stdlib$/},()=>({path:'stdlib',namespace:'local'}));
      builder.onLoad({filter:/.*/,namespace:'local'},()=>({contents:"export const FileAttachment=()=>({url:async()=>'/worker.js'});"}));
    }}]});
  currentBundle=built.outputFiles[0].text;
}
const modules = await readdir(new URL("../dist/_import/components/", import.meta.url));
const component = modules.find(name => /^PlatformDirectory\./.test(name));
const styles = await readdir(new URL("../dist/_observablehq/", import.meta.url));
const theme = styles.find(name => name.endsWith(".css"));
const css = (await readdir(new URL("../dist/_file/", import.meta.url))).find(name => /^style\..*\.css$/.test(name));
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/check") {res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end("<!doctype html><meta charset=\"utf-8\">"); return;}
  if(currentGrouping&&path==='/current-catalog.js'){res.setHeader('Content-Type','text/javascript');res.end(currentBundle);return;}
  if(currentGrouping&&path==='/current-style.css'){res.setHeader('Content-Type','text/css');res.end(await readFile(resolve('app/src/style.css')));return;}
  const file = resolve(dist, `.${decodeURIComponent(path.replace(/^\/dist/, ""))}`);
  if (!file.startsWith(dist)) {res.writeHead(403).end(); return;}
  try {
    res.setHeader("Content-Type", ({".js":"text/javascript", ".css":"text/css", ".json":"application/json"})[extname(file)] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch {res.writeHead(404).end();}
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless: true, executablePath: ["/usr/bin/chromium-browser", "/usr/bin/chromium"].find(existsSync)});
try {
  const page = await browser.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
  await page.goto(`${origin}/check`);
  if(currentGrouping) {
    const started=performance.now(),output=resolve('/tmp/opengeo-catalog-grouping');await mkdir(output,{recursive:true});
    page.setDefaultTimeout(10_000);const deadline=setTimeout(()=>{void browser.close();},20_000);
    try {
      await page.setViewportSize({width:1280,height:900});
      await page.setContent(`<meta charset="utf-8"><link rel="stylesheet" href="/dist/_observablehq/${theme}"><link rel="stylesheet" href="/current-style.css"><div id="observablehq-center"><main id="observablehq-main"><section class="platform-surface platform-directory" id="test-root"></section></main></div>`);
      await page.evaluate(async()=>{
        const {organizationCatalog}=await import('/current-catalog.js');window.IntersectionObserver=undefined;
        const projects=[{id:'library-a',name:'Related data'},{id:'library-b',name:'Related data'}];
        const record=index=>({id:'dataset-'+index,projectId:index%2?'library-b':'library-a',name:'Local layer '+index,
          sourceType:'arcgis',format:'arcgis',status:'active',classification:'public',updatedAt:'2026-10-08T12:00:00Z',
          capabilities:{read:true},preservationSummary:{sourceVersion:1,mapArchives:0,dataPreserved:false,metadataPreserved:true}});
        window.groupingRequests=[];window.sourceReads=0;
        const adapter={kind:'api',searchDatasets:async filters=>{window.groupingRequests.push(filters);
          return filters.query?[record(0),record(1)]:filters.offset?[record(23),record(24),record(25)]:Array.from({length:25},(_,index)=>record(index));},
          getSource:async()=>{window.sourceReads++;throw Error('Local source fixture unavailable');}};
        document.querySelector('#test-root').append(organizationCatalog({adapter,projects,clients:[],organization:{id:'local-account'}},{autoload:true}));
      });
      const groups=page.locator('.platform-catalog-resource-group');await groups.first().waitFor();
      assert.equal(await groups.count(),2);assert.equal(await page.locator('.platform-catalog-resource-row').count(),24);
      assert.equal(await groups.evaluateAll(nodes=>nodes.every(node=>!node.open)),true);
      assert.equal(await page.evaluate(()=>window.sourceReads),0);
      await groups.first().locator(':scope > summary').focus();await page.keyboard.press('Enter');
      assert.equal(await groups.first().evaluate(node=>node.open),true);
      const preservation=groups.first().locator('.platform-catalog-resource-row').first().locator('.catalog-preservation-status > details').first();
      assert.equal(await preservation.evaluate(node=>node.open),false);
      await preservation.locator(':scope > summary').focus();await page.keyboard.press('Enter');
      assert.equal(await preservation.evaluate(node=>node.open),true);
      assert.equal(await preservation.getByText('No data archive linked.',{exact:true}).isVisible(),true);
      assert.equal(await preservation.getByText('Registered connection · availability not established by registration',{exact:true}).isVisible(),true);
      assert.equal(await preservation.getByRole('link',{name:'Archive details',exact:true}).isVisible(),true);
      await preservation.locator(':scope > summary').focus();await page.keyboard.press('Enter');
      assert.equal(await preservation.evaluate(node=>node.open),false);
      await page.evaluate(()=>{window.retainedCatalogRow=document.querySelector('.platform-catalog-resource-row');});
      const preview=groups.first().getByRole('button',{name:'Open map',exact:true}).first();
      await preview.click();await page.getByText('Local source fixture unavailable No archived copy was used.',{exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>window.sourceReads),1);
      await page.evaluate(()=>{window.retainedCatalogPreview=document.querySelector('.platform-catalog-map-row');});
      await page.getByRole('button',{name:'Load more',exact:true}).click();
      await page.waitForFunction(()=>document.querySelectorAll('.platform-catalog-resource-row').length===26);
      assert.equal(await page.evaluate(()=>document.querySelector('.platform-catalog-resource-row')===window.retainedCatalogRow),true);
      assert.equal(await page.evaluate(()=>document.querySelector('.platform-catalog-map-row')===window.retainedCatalogPreview),true);
      assert.equal(await page.locator('.platform-catalog-map-row > td').getAttribute('colspan'),'7');
      assert.equal(await page.locator('.platform-catalog-resource-row').evaluateAll(nodes=>new Set(nodes.map(node=>node.dataset.datasetId)).size),26);
      assert.equal(await page.evaluate(()=>window.sourceReads),1);
      const widths=[],rowHeights={};
      for(const width of [1280,390]) {
        await page.setViewportSize({width,height:900});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`page overflow at${width}`);
        const scroll=groups.first().locator('[role="region"]');
        assert.equal(await scroll.getAttribute('tabindex'),'0');
        if(width===390)assert.equal(await scroll.evaluate(node=>node.scrollWidth>node.clientWidth),true);
        const collapsed=groups.nth(1).locator(':scope > summary');assert((await collapsed.boundingBox()).height<64);
        const heights=await groups.first().locator('.platform-catalog-resource-row').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().height));
        rowHeights[width]={min:Math.min(...heights),max:Math.max(...heights)};
        // Phone titles and the map action may occupy two lines; retain the
        // action's tap size rather than forcing the desktop height.
        const maximum=width===390?80:65;
        assert(heights.every(height=>height>=40&&height<=maximum),`rows outside compact range at ${width}: ${heights}`);
        await page.evaluate(()=>window.scrollTo({top:0,left:0}));
        await page.screenshot({path:resolve(output,`catalog-grouping-${width}.png`)});widths.push(width);
      }
      const query=page.getByRole('searchbox',{name:'Search organization datasets'});await query.fill('Local');
      await page.getByRole('button',{name:'Search catalog',exact:true}).click();
      await page.waitForFunction(()=>document.querySelectorAll('.platform-catalog-resource-row').length===2);
      assert.equal(await groups.evaluateAll(nodes=>nodes.every(node=>node.open)),true);
      assert.equal(await page.evaluate(()=>window.sourceReads),1);
      assert.deepEqual(errors,[]);
      const result={status:'passed-current-source-catalog-grouping-local-fixture',widths,rowsBeforeSearch:26,uniqueDatasetRows:26,
        keyboardDisclosure:true,keyboardPreservationDisclosure:true,preservationFactsRetained:true,rowHeights,previewColSpan:7,previewRowRetained:true,sourceReads:1,catalogCalls:await page.evaluate(()=>window.groupingRequests.length),
        noPageOverflow:true,phoneHorizontalTable:true,searchExpandsGroups:true,elapsedSeconds:(performance.now()-started)/1000,
        externalNetworkRequests:0,AWSRequests:0,authenticationRequests:0,inMemoryWrapperBundles:1,StudioBuilds:0,
        limits:'Current source and CSS with local data fixture. Source-error preview state survives Load more; actual map painting and production grouping not rerun.'};
      await writeFile(resolve(output,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,output}));
    }finally{clearTimeout(deadline);}
  } else {
  await page.setContent(`<meta charset="utf-8"><link rel="stylesheet" href="/dist/_observablehq/${theme}"><link rel="stylesheet" href="/dist/_file/${css}"><div id="observablehq-center"><main id="observablehq-main"><section class="platform-surface platform-directory" id="test-root"></section></main></div>`);
  await page.evaluate(async ({component}) => {
    const {renderDirectoryState} = await import(`/dist/_import/components/${component}`);
    const projects = ["MassGIS · MassEnviroScreen", "NOAA coastal imagery", "Bhutan Geospatial Data"].map((name, i) => ({
      id: `0fa80698-eb22-44ff-9127-8a31bb479c5${i}`, name,
      description: "Private research workspace prepared from the reviewed Observable import catalog. Source conversion is pending under projects/bhutan-geospatial-data using curate_large_archive.",
      status: "active", visibility: "internal", callerRole: "owner", updatedAt: "2026-09-12T12:00:00Z"
    }));
    const records = ["Adult cancer", "Adults without a high school diploma", "Air toxics cancer risk", "Extreme heat days"].map((title, i) => ({
      datasetId: "dataset-1", datasetName: "MassGIS MassEnviroScreen · 2026-04-18 archive", projectId: projects[0].id,
      projectName: projects[0].name, title, layerId: `layer-${i}`, format: "geojson", geometryType: "MultiPolygon", styleField: "STPctileCANCER", legend: {colors: ["#ffffb2", "#fecc5c", "#fd8d3c", "#f03b20", "#bd0026"]},
      service: {kind:"FeatureServer",url:"https://services.example.org/arcgis/rest/services/MassEnviroScreen/FeatureServer",layerId:"0",layerUrl:"https://services.example.org/arcgis/rest/services/MassEnviroScreen/FeatureServer/0",renderingSource:"provider",sourceVersion:2}
    }));
    records.push({...records[0], datasetId: "dataset-2", title: "CIR 16-bit", datasetName: "NOAA CIR 16-bit imagery", projectId: projects[1].id, projectName: projects[1].name, styleField: null, legend: null, geometryType: "Raster", format: "tiff",
      service:{kind:"ImageServer",url:"https://coast.noaa.gov/arcgis/rest/services/Imagery/3Band_CIR_16Bit_Imagery/ImageServer",layerUrl:"https://coast.noaa.gov/arcgis/rest/services/Imagery/3Band_CIR_16Bit_Imagery/ImageServer",layerId:null,renderingSource:"provider",sourceVersion:1}});
    const state = {status: "ready", adapter: {kind: "api", searchLayers: async () => records,
      getSource: async () => {throw new Error("Source details must not be fetched merely by opening directory rows");}}, session: {displayName: "Aaron Dennis"},
      organization: {id: "org", name: "OpenGeo.tools", callerRole: "admin"}, projects, clients: [], teams: [], userConnections: [], userBasemapConnections: [],
      publicSiteDirectory: {numberMatched: 0, records: []}, publicationWorkspaces: [], directoryWarnings: []};
    window.showDirectory = view => renderDirectoryState(document.querySelector("#test-root"), state, () => {}, null, {view});
    window.showDirectory("data");
  }, {component});
  await page.locator(".catalog-layer-toggle").first().waitFor();
  assert.equal(await page.locator(".catalog-source-group").count(), 2);
  const firstToggle = page.locator(".catalog-layer-toggle").first();
  await firstToggle.focus(); await page.keyboard.press("Enter");
  assert.equal(await firstToggle.getAttribute("aria-expanded"), "true");
  assert.equal(await page.getByRole("button", {name:"Preview and downloads",exact:true}).first().isVisible(),true);
  assert.ok(await page.getByText(/Registered connection uses the service endpoint/).first().isVisible());
  const detailId = await firstToggle.getAttribute("aria-controls");
  await page.getByRole("combobox", {name: "Sort this catalog page"}).selectOption("format");
  assert.equal(await page.locator(`[aria-controls="${detailId}"]`).getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator(`[id="${detailId}"]`).isVisible(), true);
  await page.getByRole("combobox", {name: "Group catalog entries"}).selectOption("projects");
  assert.equal(await page.locator(`[id="${detailId}"]`).isVisible(), true);
  await page.getByRole("combobox", {name: "Group catalog entries"}).selectOption("services");
  await page.locator(`[aria-controls="${detailId}"]`).click();
  for (const width of [1280, 940, 390]) {
    await page.setViewportSize({width, height: 900});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `page overflow at ${width}`);
    assert.equal(await page.locator('.studio-navigation a[aria-current="page"]').textContent(), "Catalog");
    await page.screenshot({path: `/tmp/catalog-directory-${width}.png`});
  }
  await page.evaluate(() => window.showDirectory("projects"));
  for (const width of [1280, 390]) {
    await page.setViewportSize({width, height: 900});
    const rows = await page.locator(".platform-project-row").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
    assert.ok(rows.every(height => height < 160), `project rows too tall at ${width}: ${rows}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `projects overflow at ${width}`);
    await page.screenshot({path: `/tmp/project-directory-${width}.png`});
  }
  console.log("Catalog and project directory layouts passed at desktop and mobile widths.");
  assert.deepEqual(errors, []);
  }
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
