import assert from 'node:assert/strict';
import {it} from 'node:test';
import {parseWaybackReleases,fetchWaybackReleases,waybackViewerUrl,WAYBACK_CATALOG_URL} from '../src/lib/historicalImagery.js';
const release=(id,date)=>({itemID:'a'.repeat(32),itemTitle:`World Imagery (Wayback ${date})`,itemURL:`https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${id}/{level}/{row}/{col}`});
it('validates release identities and dates without trusting provider URLs for navigation',()=>{
 assert.deepEqual(parseWaybackReleases({'20':release('20','2025-05-01'),'10':release('10','2014-02-20')}).map(r=>r.id),['10','20']);
 for(const changed of [{itemURL:'https://attacker.example/'},{itemID:'bad'},{itemTitle:'World Imagery (Wayback 2025-02-30)'}])assert.throws(()=>parseWaybackReleases({'20':{...release('20','2025-05-01'),...changed}}));
 assert.throws(()=>parseWaybackReleases([]));assert.throws(()=>parseWaybackReleases({}));
});
it('fetches just metadata anonymously with bounded response and abort support',async()=>{
 let calls=0;
 const records=await fetchWaybackReleases({fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,WAYBACK_CATALOG_URL);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.ok(options.signal);
  return new Response(JSON.stringify({'20':release('20','2025-05-01')}),{headers:{'Content-Type':'application/json'}});
 }});assert.equal(calls,1);assert.equal(records[0].date,'2025-05-01');
 await assert.rejects(fetchWaybackReleases({fetchImpl:async()=>new Response('x',{headers:{'Content-Type':'text/html'}})}));
 await assert.rejects(fetchWaybackReleases({fetchImpl:async()=>new Response('x'.repeat(262145),{headers:{'Content-Type':'application/json'}})}));
});
it('opens an exact provider release and bounded current camera without credentials',()=>{
 const url=new URL(waybackViewerUrl('26334',{longitude:90.5,latitude:27.4,zoom:8}));
 assert.equal(url.origin,'https://livingatlas.arcgis.com');
 const hash=new URLSearchParams(url.hash.slice(1));assert.equal(hash.get('active'),'26334');assert.equal(hash.get('mapCenter'),'90.50000,27.40000,8.00');
 assert.throws(()=>waybackViewerUrl('1&token=secret'));assert.throws(()=>waybackViewerUrl('1',{zoom:NaN}));
});
