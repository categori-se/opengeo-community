import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile, mkdir, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {existsSync} from "node:fs";
import {chromium} from "playwright";

const root = new URL("../", import.meta.url);
const output = new URL("../../.local-archives/noaa/studio-archive-ui/", import.meta.url);
const files = new Map([
  ["/src/components/SourceArchivePanel.js", "src/components/SourceArchivePanel.js"],
  ["/src/lib/sourceArchival.js", "src/lib/sourceArchival.js"], ["/style.css", "src/style.css"]
]);
const html = `<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/style.css"><style>
:root {--theme-foreground:#202020;--theme-background:#fafafa;--theme-background-alt:#f0f0f0;--theme-foreground-muted:#555;--theme-foreground-faintest:#bbb;--theme-foreground-focus:#1254ba}
:root[data-theme=dark] {--theme-foreground:#e6e6e6;--theme-background:#151515;--theme-background-alt:#242424;--theme-foreground-muted:#aaa;--theme-foreground-faintest:#555;--theme-foreground-focus:#75a7ff}
body {margin:0;background:var(--theme-background);font:14px/1.45 system-ui}main {box-sizing:border-box;padding:16px;max-width:720px;margin:auto}h4 {font-size:18px}button,select{font:inherit}select{max-width:100%;color:var(--theme-foreground);background:var(--theme-background-alt)}
</style><body><main class="project-dataset-card"></main><script type="module">
import {SourceArchivePanel} from '/src/components/SourceArchivePanel.js';
const id='40000000-0000-4000-8000-000000000001';
const context={organizationId:'10000000-0000-4000-8000-000000000001',projectId:'20000000-0000-4000-8000-000000000001',sourceDatasetId:'30000000-0000-4000-8000-000000000001',sourceRevisionNumber:1};
const adapter={listSourceArchiveJobs:async()=>[],createSourceArchivePlan:async request=>({...request,id,sha256:'a'.repeat(64),expiresAt:'2099-01-01T00:00:00Z',inventoryComplete:true,fileCount:122,totalBytes:44356133142,estimatedExecutionCostUsd:0.1,maximumExecutionCostUsd:5,estimatedMonthlyStorageUsd:0.95,destination:{connectionId:id,label:'Regional archive / source-collection-with-a-long-preserved-original-directory-name',access:'public'}}),startSourceArchiveCapture:async()=>{throw Error('Not a live capture')},getSourceArchiveJob:async()=>{},controlSourceArchiveJob:async()=>{}};
document.querySelector('main').append(SourceArchivePanel({adapter,context}));
</script>`;
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/") { res.setHeader("Content-Type", "text/html"); res.end(html); }
    else if (files.has(path)) {
      res.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : "text/javascript");
      res.end(await readFile(new URL(files.get(path), root)));
    } else { res.statusCode = 404; res.end(); }
  } catch { res.statusCode = 500; res.end(); }
});
let browser;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const executablePath = ["/usr/bin/chromium-browser", "/usr/bin/chromium"].find(existsSync);
  browser = await chromium.launch({headless:true, ...(executablePath ? {executablePath} : {})});
  await mkdir(output, {recursive:true});
  const results = [];
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1100]) {
      const page = await browser.newPage({viewport:{width,height:850}}), errors=[];
      page.on("pageerror", error=>errors.push(error.message));
      await page.goto('http://127.0.0.1:'+server.address().port);
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      await page.getByRole('combobox',{name:'What to preserve'}).selectOption('originals_and_metadata');
      await page.getByRole('button',{name:'Review size and cost'}).click();
      await page.getByText('Estimated monthly storage',{exact:true}).waitFor();
      const layout=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth,background:getComputedStyle(document.querySelector('button')).backgroundColor}));
      assert.ok(layout.scroll<=layout.width, JSON.stringify(layout));
      assert.deepEqual(errors,[]);
      await page.screenshot({path:fileURLToPath(new URL(theme+'-'+width+'.png',output)),fullPage:true});
      results.push({theme,width,...layout});
      await page.close();
    }
  }
  assert.notEqual(results[0].background,results[2].background);
  await writeFile(new URL('result.json',output),JSON.stringify({status:'passed',liveApi:false,results},null,2));
  console.log(JSON.stringify({status:'passed',layouts:results.length,liveApi:false,output:fileURLToPath(output)}));
} finally {
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
