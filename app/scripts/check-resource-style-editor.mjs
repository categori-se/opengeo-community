import assert from "node:assert/strict";
import {readFileSync, existsSync} from "node:fs";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {resolve, dirname} from "node:path";
import {createServer} from "node:http";
import {chromium} from "playwright";
import {build} from "esbuild";

// Isolated browser acceptance; no release files, credentials or remote services.
const designerMode = process.env.OPENGEO_PATTERN_DESIGNER_CHECK === "1";
const designerStartedAt = Date.now();
const output = resolve(process.env.OPEN_GEO_STYLE_UI_OUTPUT ?? ".local-archives/studio-sharing/noaa-owner-workflow/framework-live-preview/pattern-designer-ui");
const receiptPath = resolve(process.env.OPEN_GEO_STYLE_UI_RECEIPT ?? output + "/receipt.json");
const prior = designerMode && process.env.OPEN_GEO_STYLE_UI_PRIOR_RECEIPT ? JSON.parse(await readFile(resolve(process.env.OPEN_GEO_STYLE_UI_PRIOR_RECEIPT), "utf8")) : null;
const carriedSeconds = prior?.cumulativeSeconds ?? 0;
assert.ok(!designerMode || carriedSeconds < 45, "The cumulative offline UI allowance is exhausted");
const designerReceipt = {status:"started",scope:"Actual StyleLibrary UI with memory adapter; no account persistence or deployment claim",assertions:[],screenshots:[],viewportWidths:[],externalRequests:0,pageErrors:[],limits:{perRunSeconds:20,cumulativeSeconds:45,providerRequests:0,AWSRequests:0,canonicalBuilds:0},carriedSeconds,
  ...(prior?{priorReceipt:resolve(process.env.OPEN_GEO_STYLE_UI_PRIOR_RECEIPT),carriedProof:{status:prior.status,elapsedSeconds:prior.elapsedSeconds,checkedSources:prior.checkedSources},changedInputReason:process.env.OPEN_GEO_STYLE_UI_REASON??"Changed pattern engine input"}:{})};
const designerBundle = designerMode ? await buildDesignerBundle() : null;
const source = readFileSync(new URL("../src/components/ResourceStyleVersionEditor.js", import.meta.url));
const css = readFileSync(new URL("../src/style.css", import.meta.url));
const server = createServer((request, response) => {
  if (request.url === "/editor.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(source);
  } else if (request.url === "/designer.js" && designerBundle) {
    response.setHeader("Content-Type", "text/javascript");response.end(designerBundle);
  } else if (request.url === "/style.css") {
    response.setHeader("Content-Type", "text/css");
    response.end(css);
  } else if (request.url === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><body style="padding:12px;margin:0"><main' + (designerMode ? '' : ' class="project-resource-editor-panel"') + '></main>' + (designerMode ? '<script type="module" src="/designer.js"></script>' : ''));
  } else {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
let browser;
try {
  const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, "/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/google-chrome"]
    .filter(Boolean).find(existsSync);
  browser = await chromium.launch({headless: true, executablePath, args: ["--no-sandbox"]});
  if (designerMode) {
    let timer;
    try {
      const remaining = Math.min(20_000 - (Date.now() - designerStartedAt), (45 - carriedSeconds) * 1000 - (Date.now() - designerStartedAt));
      assert.ok(remaining > 0, "Offline UI setup exhausted the run allowance");
      await Promise.race([designerJourney(browser),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Offline UI run reached its time ceiling")),remaining);})]);
      designerReceipt.status="passed";
    } finally {clearTimeout(timer);}
  } else {
  for (const width of [390, 1280]) {
    for (const colorScheme of ["light", "dark"]) {
      const context = await browser.newContext({viewport: {width, height: 850}, colorScheme, acceptDownloads: true});
      const origin = `http://127.0.0.1:${server.address().port}`;
      await context.route("**/*", (route) => route.request().url().startsWith(`${origin}/`)
        ? route.continue() : route.abort());
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(origin);
      const original = await page.evaluate(async (scheme) => {
        const {ResourceStyleVersionEditor} = await import("/editor.js");
        document.documentElement.style.setProperty("--theme-background", scheme === "dark" ? "#202020" : "#ffffff");
        document.documentElement.style.setProperty("--theme-foreground", scheme === "dark" ? "#eeeeee" : "#222222");
        document.body.style.background = "var(--theme-background)";
        document.body.style.color = "var(--theme-foreground)";
        const definition = '<StyledLayerDescriptor version="1.0.0">é\r\n</StyledLayerDescriptor>';
        const hash = async (text) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
          .map((value) => value.toString(16).padStart(2, "0")).join("");
        let saved = {id: "s", resourceId: "r", slug: "roads", title: "Roads", format: "sld_1_0", versionNumber: 1, definition, checksumSha256: await hash(definition)};
        const adapter = {
          listResourceStyles: async () => [saved],
          updateResourceStyle: async (_project, _resource, _style, update) => {
            saved = {...saved, ...update, versionNumber: saved.versionNumber + 1, checksumSha256: await hash(update.definition)};
            return saved;
          }
        };
        document.querySelector("main").append(ResourceStyleVersionEditor({adapter, projectId: "p", resourceId: "r", style: saved, canUpdate: true}));
        return definition;
      }, colorScheme);
      await page.getByText("Inspect or edit definition", {exact: true}).click();
      await page.getByLabel("Saved style definition", {exact: true}).fill("<my-draft/>");
      const pendingDownload = page.waitForEvent("download");
      await page.getByRole("button", {name: "Download saved definition", exact: true}).click();
      const download = await pendingDownload;
      assert.equal(download.suggestedFilename(), "roads-v1.sld");
      assert.equal(readFileSync(await download.path(), "utf8"), original);
      await page.getByRole("button", {name: "Save style version", exact: true}).click();
      await page.getByRole("status").filter({hasText: "Saved style version 2"}).waitFor();
      assert.equal(await page.getByLabel("Saved style definition", {exact: true}).inputValue(), "<my-draft/>");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "horizontal overflow");
      assert.deepEqual(errors, []);
      console.log(`PASS Chromium ${width}px ${colorScheme}: saved-byte download, draft version save, containment, no page errors.`);
      await context.close();
    }
  }
  }
} catch (error) {
  if (designerMode) {designerReceipt.status="failed";designerReceipt.error={name:error.name,message:error.message};}
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  if (designerMode) {
    designerReceipt.elapsedSeconds=(Date.now()-designerStartedAt)/1000;
    designerReceipt.cumulativeSeconds=carriedSeconds+designerReceipt.elapsedSeconds;
    await mkdir(dirname(receiptPath),{recursive:true});await writeFile(receiptPath,JSON.stringify(designerReceipt,null,2)+"\n");
    console.log(JSON.stringify(designerReceipt));
  }
}

async function buildDesignerBundle() {
  const result=await build({stdin:{resolveDir:resolve("app"),sourcefile:"style-designer-offline-fixture.js",contents:`
import {StyleLibrary} from './src/components/StyleLibrary.js';
import {savedPattern} from './src/lib/cartographicPatterns.js';
const projectId='10000000-0000-4000-8000-000000000001',resourceId='20000000-0000-4000-8000-000000000001';
const styles=new Map(),versions=new Map(),calls=[];let count=0,view;
const clone=value=>structuredClone(value);
const require=(value,message)=>{if(!value)throw Error(message)};
const hash=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(value=>value.toString(16).padStart(2,'0')).join('');
const scope=(project,resource)=>require(project===projectId&&resource===resourceId,'Wrong fixture resource scope');
const store=async value=>{value.checksumSha256=await hash(value.definition);styles.set(value.id,clone(value));versions.set(value.id+':'+value.versionNumber,clone(value));return clone(value)};
const adapter={kind:'fixture',
 listResources:async project=>{require(project===projectId,'Wrong fixture library');calls.push({method:'listResources'});return [{id:resourceId,title:'Water features',kind:'dataset',state:'active'}]},
 getResourceCapabilities:async(project,resource)=>{scope(project,resource);return {canUpdate:true}},
 listResourceStyles:async(project,resource,{includeArchived=false}={})=>{scope(project,resource);calls.push({method:'listResourceStyles',includeArchived});return [...styles.values()].filter(style=>includeArchived||!style.archived).map(clone)},
 createResourceStyle:async(project,resource,input)=>{scope(project,resource);calls.push({method:'createResourceStyle'});return store({...input,id:'fixture-style-'+(++count),resourceId,versionNumber:1,archived:false})},
 updateResourceStyle:async(project,resource,id,input)=>{scope(project,resource);const current=styles.get(id);require(current&&!current.archived,'Archived style cannot update');require(current.versionNumber===input.expectedVersion,'Wrong expected fixture version');calls.push({method:'updateResourceStyle',id,expectedVersion:input.expectedVersion});return store({...current,...input,versionNumber:current.versionNumber+1})},
 archiveResourceStyle:async(project,resource,id,{expectedVersion})=>{scope(project,resource);const current=styles.get(id);require(current&&current.versionNumber===expectedVersion,'Wrong archive fixture version');calls.push({method:'archiveResourceStyle',id});return store({...current,archived:true})},
 restoreResourceStyle:async(project,resource,id,{expectedVersion})=>{scope(project,resource);const current=styles.get(id);require(current&&current.versionNumber===expectedVersion,'Wrong restore fixture version');calls.push({method:'restoreResourceStyle',id});return store({...current,archived:false})}
};
window.styleFixture={projectId,resourceId,records:()=>[...styles.values()].map(style=>({...clone(style),pattern:savedPattern(style)})),calls:()=>clone(calls),version:(id,number)=>clone(versions.get(id+':'+number))};
window.mountStyleLibrary=()=>{view?.dispose();view?.remove();view=StyleLibrary({adapter,containers:[{id:projectId,name:'Owned account data'}]});document.querySelector('main').replaceChildren(view)};
document.documentElement.style.setProperty('--theme-background','#202020');document.documentElement.style.setProperty('--theme-background-alt','#262626');document.documentElement.style.setProperty('--theme-foreground','#eeeeee');document.documentElement.style.setProperty('--theme-foreground-muted','#aaaaaa');document.documentElement.style.setProperty('--theme-foreground-faintest','#555555');document.documentElement.style.setProperty('--theme-foreground-focus','#669df5');document.body.style.background='var(--theme-background)';document.body.style.color='var(--theme-foreground)';
window.mountStyleLibrary();
`},bundle:true,format:"esm",write:false});
  return result.outputFiles[0].text;
}

async function designerJourney(browser) {
  const origin=`http://127.0.0.1:${server.address().port}`;
  const context=await browser.newContext({viewport:{width:1280,height:900},colorScheme:"dark",serviceWorkers:"block"});
  await context.route("**/*",route=>{const url=new URL(route.request().url());if(url.origin===origin)return route.continue();designerReceipt.externalRequests++;return route.abort();});
  const page=await context.newPage();page.setDefaultTimeout(2500);page.on("pageerror",error=>designerReceipt.pageErrors.push(error.message));
  const passed=name=>designerReceipt.assertions.push(name);
  const button=name=>page.getByRole("button",{name,exact:true});
  const records=()=>page.evaluate(()=>window.styleFixture.records());
  const row=title=>page.locator(".style-saved-row").filter({has:page.getByRole("heading",{name:new RegExp("^"+title.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+" ·")})});
  async function chooseResource(){await page.getByLabel("Data library",{exact:true}).selectOption("10000000-0000-4000-8000-000000000001");await page.getByLabel("Style resource",{exact:true}).selectOption("20000000-0000-4000-8000-000000000001");await page.waitForFunction(()=>!document.querySelector('.style-designer-actions button:nth-child(2)').disabled);}
  async function controls(values){for(const [name,value] of Object.entries(values)){const input=page.getByLabel(name,{exact:true});await input.evaluate((node,next)=>{node.value=String(next);node.dispatchEvent(new Event("input",{bubbles:true}));},value);assert.equal(await input.inputValue(),String(value));}}
  async function snapshot(width){
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,width+"px horizontal overflow");
    const preview=page.locator('.style-pattern-preview img');await preview.evaluate(image=>image.decode());
    const paint=await preview.evaluate(image=>{
      const xml=new DOMParser().parseFromString(decodeURIComponent(image.src.slice(image.src.indexOf(',')+1)),'image/svg+xml');
      const references=[...xml.querySelectorAll('use')].map(node=>node.getAttribute('href'));
      const local=references.every(reference=>reference?.startsWith('#')&&xml.getElementById(reference.slice(1)));
      const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
      const context=canvas.getContext('2d');context.drawImage(image,0,0);const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;let inkPixels=0;
      for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]>0&&(pixels[i]<240||pixels[i+1]<240||pixels[i+2]<240))inkPixels++;
      return {width:image.naturalWidth,uses:references.length,localReferences:local,unsafeNodes:xml.querySelectorAll('image,script,foreignObject').length,inkPixels};
    });
    assert.equal(paint.width,240);assert.equal(paint.uses,49);assert.equal(paint.localReferences,true);assert.equal(paint.unsafeNodes,0);assert.ok(paint.inkPixels>100,"Actual SVG use references must paint ink pixels");
    (designerReceipt.previewPaint??=[]).push({viewportWidth:width,...paint});
    await page.evaluate(()=>scrollTo(0,0));await mkdir(output,{recursive:true});const path=resolve(output,"designer-"+width+".png");await page.screenshot({path,fullPage:false});designerReceipt.screenshots.push(path);designerReceipt.viewportWidths.push(width);
    passed(width+"px49 local-only SVG use references paint actual ink pixels; controls stay within viewport");
  }
  try{
    designerReceipt.stage="desktop-create";await page.goto(origin);await page.waitForFunction(()=>window.styleFixture);
    assert.deepEqual(await page.evaluate(()=>window.styleFixture.calls()),[]);passed("Opening the native designer performs zero adapter calls");await chooseResource();
    await page.getByLabel("Pattern",{exact:true}).selectOption("waves");await page.getByLabel("Style title",{exact:true}).fill("Harbor waves");
    const firstPreview=await page.locator('.style-pattern-preview img').getAttribute('src');
    await controls({"Pattern spacing":24,"Pattern density":1.75,"Pattern direction":30,"Wave height":5.5,"Wave curve":.75,"Pattern opacity":.65});
    assert.notEqual(await page.locator('.style-pattern-preview img').getAttribute('src'),firstPreview);passed("1280px density, direction, wave height/curve and opacity update the live preview");
    await button("Save new Style").click();await page.waitForFunction(()=>window.styleFixture.records().length===1&&document.querySelector('.style-designer-actions button:nth-child(2)').textContent==='Save changes');
    let saved=(await records())[0];assert.equal(saved.versionNumber,1);assert.equal(saved.pattern.version,2);assert.equal(saved.pattern.density,1.75);assert.equal(saved.pattern.angle,30);passed("Create saves a recoverable v2 recipe as style version1");
    await button("New style").click();await row("Harbor waves").getByRole("button",{name:"Edit pattern",exact:true}).click();
    assert.equal(await page.getByLabel("Pattern density",{exact:true}).inputValue(),"1.75");await page.getByLabel("Style title",{exact:true}).fill("Harbor waves edited");await controls({"Pattern direction":45});
    await button("Save changes").click();await page.waitForFunction(()=>window.styleFixture.records()[0].versionNumber===2);
    saved=(await records())[0];assert.equal(saved.title,"Harbor waves edited");assert.equal(saved.pattern.angle,45);assert.equal(await page.evaluate(()=>window.styleFixture.version('fixture-style-1',1).title),"Harbor waves");passed("Saved Edit pattern loads designer controls; rename and Save changes preserve version1 and create version2");await snapshot(1280);
    designerReceipt.stage="mobile-reopen-copy";await page.setViewportSize({width:390,height:900});await page.evaluate(()=>window.mountStyleLibrary());await chooseResource();await row("Harbor waves edited").getByRole("button",{name:"Edit pattern",exact:true}).click();
    assert.equal(await page.getByLabel("Style title",{exact:true}).inputValue(),"Harbor waves edited");assert.equal(await page.getByLabel("Pattern direction",{exact:true}).inputValue(),"45");passed("390px reopened designer recovers renamed version2 and exact parameters");
    await controls({"Pattern spacing":20,"Pattern density":2.5,"Pattern direction":-30,"Wave height":10,"Wave curve":.25,"Pattern opacity":.45});await page.getByLabel("Style title",{exact:true}).fill("Harbor waves copy");await button("Save as copy").click();await page.waitForFunction(()=>window.styleFixture.records().length===2);
    const copy=(await records()).find(style=>style.id==='fixture-style-2');assert.equal(copy.versionNumber,1);assert.equal(copy.pattern.density,2.5);assert.equal(copy.pattern.opacity,.45);assert.equal((await records())[0].versionNumber,2);passed("390px changed controls and Save as copy create a distinct identity without replacing version2");
    designerReceipt.stage="delete-restore";await row("Harbor waves copy").getByRole("button",{name:"Delete",exact:true}).click();assert.equal(await row("Harbor waves copy").locator('.style-delete-confirm').isVisible(),true);assert.equal(await page.evaluate(()=>window.styleFixture.calls().filter(call=>call.method==='archiveResourceStyle').length),0);passed("Delete requires visible inline confirmation before any archive write");
    await row("Harbor waves copy").getByRole("button",{name:"Confirm delete",exact:true}).click();await page.waitForFunction(()=>window.styleFixture.records().find(style=>style.id==='fixture-style-2').archived===true);assert.equal(await row("Harbor waves copy").count(),0);
    await page.getByLabel("Show deleted styles",{exact:true}).check();await row("Harbor waves copy").getByRole("button",{name:"Restore",exact:true}).waitFor();await row("Harbor waves copy").getByRole("button",{name:"Restore",exact:true}).click();await page.waitForFunction(()=>window.styleFixture.records().find(style=>style.id==='fixture-style-2').archived===false);
    const restored=(await records()).find(style=>style.id==='fixture-style-2');assert.equal(restored.versionNumber,copy.versionNumber);assert.equal(restored.checksumSha256,copy.checksumSha256);passed("Show deleted finds the archived identity; Restore retains its exact version and definition");
    await page.evaluate(()=>window.mountStyleLibrary());await chooseResource();await row("Harbor waves copy").getByRole("button",{name:"Edit pattern",exact:true}).click();assert.equal(await page.getByLabel("Pattern density",{exact:true}).inputValue(),"2.5");assert.equal(await page.getByLabel("Pattern direction",{exact:true}).inputValue(),"-30");passed("Restored copy reopens with saved mobile parameters");await snapshot(390);
    assert.equal(designerReceipt.externalRequests,0);assert.deepEqual(designerReceipt.pageErrors,[]);designerReceipt.fixtureCalls=await page.evaluate(()=>window.styleFixture.calls());assert.equal(designerReceipt.fixtureCalls.filter(call=>call.method==='createResourceStyle').length,2);assert.equal(designerReceipt.fixtureCalls.filter(call=>call.method==='updateResourceStyle').length,1);assert.equal(designerReceipt.fixtureCalls.filter(call=>call.method==='archiveResourceStyle').length,1);assert.equal(designerReceipt.fixtureCalls.filter(call=>call.method==='restoreResourceStyle').length,1);passed("Lifecycle makes exactly2 creates,1 version update,1 archive,1 restore; zero external requests/runtime errors");
    designerReceipt.stage="complete";
  }finally{await context.close();}
}
