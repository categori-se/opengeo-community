import assert from 'node:assert/strict';
import {it} from 'node:test';
import {readBrowserLayerCatalog,writeBrowserLayerCatalog,clearBrowserLayerCatalog} from '../src/lib/browserLayerCatalogStore.js';
const storage=()=>{const values=new Map();return {values,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};};
it('retains independent registration metadata and data, resets daily and preserves stored records on quota failure',()=>{
 const local=storage(),entry={layer:{datasetId:'registered',title:'Review',metadata:{curated:{license:null},source:{nested:{value:1}}}},geojson:{type:'FeatureCollection',features:[]}};
 const records=new Map([['registered',entry]]);assert.equal(writeBrowserLayerCatalog(local,records),true);
 assert.deepEqual(readBrowserLayerCatalog(local),records);
 assert.equal(writeBrowserLayerCatalog(local,new Map([['wrong',entry]])),false);
 assert.deepEqual(readBrowserLayerCatalog(local),records);
 const [key,raw]=[...local.values][0];local.setItem(key,JSON.stringify({...JSON.parse(raw),day:'2000-1-1'}));assert.equal(readBrowserLayerCatalog(local).size,0);
 writeBrowserLayerCatalog(local,records);local.setItem=()=>{throw Error('quota');};assert.equal(writeBrowserLayerCatalog(local,records),false);assert.deepEqual(readBrowserLayerCatalog(local),records);
 clearBrowserLayerCatalog(local);assert.equal(readBrowserLayerCatalog(local).size,0);
});
