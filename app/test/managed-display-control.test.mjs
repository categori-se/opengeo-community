import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {LayerArchiveControl} from '../src/components/LayerArchiveControl.js';
import {renderLayerResource} from '../src/components/LayerResourcePage.js';
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
async function domTest(run){
 const dom=new JSDOM('<!doctype html>'),before={document:globalThis.document,Option:globalThis.Option};
 globalThis.document=dom.window.document;globalThis.Option=dom.window.Option;
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
 try{await run(dom.window.document);}finally{Object.assign(globalThis,before);dom.window.close();}
}
const layer={title:'Saved land use',datasetId:'dataset',datasetVersionId:'exact-v1',sourceType:'governed-dataset'};
const display={id:'display',title:'Tiled version',format:'pmtiles',download_bytes:1234,feature_count:123,tile_layers:[]};
test('managed display control is explicit and rejects a different version before offering a read',()=>domTest(async document=>{
 let lists=0,reads=0;
 const control=LayerArchiveControl({layer,access:{assertScope:async()=>{},authorize:async()=>{},list:async()=>{lists++;return {dataset_id:'dataset',dataset_version_id:'other',archives:[display]};},read:async()=>reads++},onStart(){},onLoaded(){},onReturn(){},onError(){}});
 document.body.append(control);const buttons=()=>[...document.querySelectorAll('button')];
 assert.equal(lists+reads,0);assert.equal(control.textContent,'Map display');
 control.querySelector('button').click();buttons().find(b=>b.textContent==='Review tiled displays').click();await flush();
 assert.equal(lists,1);assert.equal(reads,0);assert.match(document.body.textContent,/revision changed/);
 assert.ok(buttons().find(b=>b.textContent==='Use selected tiled display').disabled);control.dispose();
}));
test('catalog lists managed tiled metadata only after opening its section',()=>domTest(async document=>{
 let calls=0;
 const dataset={id:'dataset',projectId:'workspace',currentVersionId:'exact-v1',sourceType:'upload',format:'geojson',name:'Saved land use',status:'active',capabilities:{read:true}};
 const root=renderLayerResource({dataset,adapter:{listManagedDisplays:async(...args)=>{calls++;assert.deepEqual(args,['workspace','dataset','exact-v1']);return {dataset_id:'dataset',dataset_version_id:'exact-v1',archives:[display]};}}});
 document.body.append(root);assert.equal(calls,0);
 const toggle=[...root.querySelectorAll('button')].find(p=>p.textContent==='Tiled map displays');
 assert.ok(toggle);const panel=toggle.parentElement;toggle.click();await flush();
 assert.equal(calls,1);assert.match(panel.textContent,/Tiled version/);assert.match(panel.textContent,/does not read S3/);
}));
