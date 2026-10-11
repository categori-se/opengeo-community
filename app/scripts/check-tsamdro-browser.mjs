// Bounded live browser check; serves local code in an intercepted Studio-origin page.
// No deployment, application API, S3, tiles or user sessions are involved.
import {chromium} from 'playwright';
import {readFile, writeFile} from 'node:fs/promises';
const root=new URL('../../.local-archives/bhutan-local-20260920/',import.meta.url);
const drafts=JSON.parse(await readFile(new URL('catalog-drafts.json',root),'utf8'));
const c=drafts.drafts.find(d=>d.sourceUrl.endsWith('/Bhutan/PastoralMigration/MapServer/2')).request.source;
const script=await readFile(new URL('../src/lib/liveFeatureSource.js',import.meta.url),'utf8');
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium-browser'});
let providerRequests=0;
try {
 const page=await browser.newPage();
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin==='https://studio.opengeo.tools' && url.pathname==='/_local-check/tsamdro')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Local Tsamdro loader check</title>'});
  if(url.origin==='https://studio.opengeo.tools' && url.pathname==='/_local-check/liveFeatureSource.js')return route.fulfill({contentType:'text/javascript',body:script});
  if(url.origin==='https://geoapps.icimod.org' && /^\/icimodarcgis\/rest\/services\/Bhutan\/PastoralMigration\/MapServer\/2(?:\/query)?$/.test(url.pathname) && ++providerRequests<=4)return route.continue();
  return route.abort();
 });
 await page.goto('https://studio.opengeo.tools/_local-check/tsamdro');
 const result=await page.evaluate(async c=>{
  const {loadLiveFeaturePage}=await import('/_local-check/liveFeatureSource.js');
  const value=await loadLiveFeaturePage({sourceType:'arcgis',url:c.url,
   configuration:{objectIdField:c.object_id_field,fields:c.fields,geometryType:c.geometry_type,pageSize:1000,attribution:c.attribution},bounds:[88.7,26.6,92.2,28.4]});
  return {features:value.features.length,receipt:value.opengeo};
 },c);
 const receipt={status:'passed',checkedAt:new Date().toISOString(),...result,providerRequests,s3Requests:0,
  scope:'Headless Chromium using local client module from intercepted Studio-origin page; verifies live GET/POST CORS and geometry parsing, not deployed code or map rendering'};
 await writeFile(new URL('tsamdro-browser-live.json',root),JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify(receipt));
}finally{await browser.close();}
