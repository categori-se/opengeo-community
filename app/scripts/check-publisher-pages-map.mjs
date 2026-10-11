import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const url='https://pages.studio.opengeo.tools/p/publisher-check-map/';
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium-browser'});
const result={url,offline:false,embedded:false};
try{
 const context=await browser.newContext({serviceWorkers:'block'});
 const response=await context.request.get(url);assert.equal(response.status(),200);
 const html=await response.text();assert.ok(html.includes('Publisher acceptance map'));
 const offline=await browser.newContext({offline:true,serviceWorkers:'block'});
 const local=await offline.newPage();await local.setContent(html,{waitUntil:'load'});
 await local.getByText('Offline edition · selected vector data included',{exact:true}).waitFor({timeout:30000});
 await local.getByRole('button',{name:'Zoom in',exact:true}).click();
 await local.locator('.maplibregl-canvas').screenshot({path:'.local-archives/publisher-pages-release-20260915/offline-map.png'});
 result.offline=true;await offline.close();
 const parent=await context.newPage();
 await parent.setContent(`<iframe title="Published map" src="${url}" width="900" height="600"></iframe>`);
 const frame=parent.frameLocator('iframe');
 await frame.getByText('Offline edition · selected vector data included',{exact:true}).waitFor({timeout:30000});
 await frame.getByRole('button',{name:'Zoom in',exact:true}).click();result.embedded=true;
 await writeFile('.local-archives/publisher-pages-release-20260915/map-portability.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
}finally{await browser.close();}
