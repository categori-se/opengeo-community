import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {FeatureAttachmentPicker} from '../src/components/FeatureAttachmentPicker.js';
import {FixturePlatformAdapter} from '../src/lib/fixturePlatform.js';
import {readFile} from 'node:fs/promises';
import {geometryPaint} from '../src/lib/mapLayers.js';
import {featurePropertyFields} from '../src/components/ProjectDatasets.js';

test('download rejects invalid tickets and abandons a request after record reset', async()=>{
  const previous=globalThis.document;
  const dom=new JSDOM('<!doctype html><body></body>');globalThis.document=dom.window.document;
  try {
    let clicked=0,pending,ticket={url:'https://storage.example/file',expiresAt:'invalid'};
    dom.window.HTMLAnchorElement.prototype.click=()=>{clicked++;};
    const control=document.createElement('input');control.value='pinned';
    const picker=FeatureAttachmentPicker({control,adapter:{
      resolveFeatureAttachment:async()=>({projectId:'project',datasetId:'file',objectId:'original',name:'File',versionNumber:1}),
      requestDatasetDownload:async()=>ticket??new Promise(resolve=>{pending=resolve;})
    }});
    const button=[...picker.querySelectorAll('button')].find(b=>b.textContent==='Download selected file');
    const click=async()=>{button.click();await new Promise(resolve=>setTimeout(resolve,0));};
    await click();assert.equal(clicked,0);
    ticket={url:'javascript:alert(1)',expiresAt:'2099-01-01T00:00:00Z'};await click();assert.equal(clicked,0);
    ticket={url:'https://storage.example/file',expiresAt:'2000-01-01T00:00:00Z'};await click();assert.equal(clicked,0);
    ticket=null;await click();control.dispatchEvent(new dom.window.Event('attachmentreset'));
    pending({url:'https://storage.example/file',expiresAt:'2099-01-01T00:00:00Z'});
    await new Promise(resolve=>setTimeout(resolve,0));assert.equal(clicked,0);assert.match(picker.textContent,/Saved attachment reference loaded/);
    ticket={url:'https://storage.example/file',expiresAt:'2099-01-01T00:00:00Z'};await click();assert.equal(clicked,1);
    assert.equal(control.value,'pinned');
  } finally {globalThis.document=previous;dom.window.close();}
});

test('switching feature records clears rendered and pending attachment previews', async()=>{
  const previous=globalThis.document;
  const dom=new JSDOM('<!doctype html><body></body>');globalThis.document=dom.window.document;
  try {
    let complete;
    const editor=featurePropertyFields([{name:'file',type:'string',attachment:true}],{adapter:{
      resolveFeatureAttachment:async()=>({format:'pdf',projectId:'project',datasetId:'file'}),
      getDatasetDocumentPreview:async()=>new Promise(resolve=>{complete=resolve;})
    }});
    const saved='81000000-0000-4000-8000-000000000001';editor.write({file:saved});
    const preview=[...editor.element.querySelectorAll('button')].find(b=>b.textContent==='Preview selected file');
    const region=editor.element.querySelector('[aria-label="Selected attachment preview"]');
    const value={sourceFormat:'pdf',title:'Previous record file',pdfVersion:'1.7',extraction:{ocrPerformed:false},pages:[]};
    preview.click();await new Promise(resolve=>setTimeout(resolve,0));complete(value);await new Promise(resolve=>setTimeout(resolve,0));
    assert.match(region.textContent,/Previous record file/);
    editor.write({});assert.equal(region.textContent,'');assert.deepEqual(editor.read(),{});
    editor.write({file:saved});preview.click();await new Promise(resolve=>setTimeout(resolve,0));
    editor.write({file:saved});complete(value);await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(region.textContent,'');assert.deepEqual(editor.read(),{file:saved});
  } finally {globalThis.document=previous;dom.window.close();}
});

test('image preview checks exact original size and independent download permission', async()=>{
  const previous=globalThis.document;
  const dom=new JSDOM('<!doctype html><body></body>');globalThis.document=dom.window.document;
  try {
    const control=document.createElement('input');control.value='pinned';
    let sizeBytes=100,denied=false,downloads=0;
    const picker=FeatureAttachmentPicker({control,adapter:{
      resolveFeatureAttachment:async()=>({format:'png',projectId:'project',datasetId:'file',objectId:'original',name:'Photo',versionNumber:1}),
      listDatasetVersions:async()=>[{id:'pinned',state:'active',objects:[{id:'original',role:'original',contentType:'image/png',sizeBytes}]}],
      requestDatasetDownload:async(...args)=>{downloads++;assert.deepEqual(args,['project','file','pinned','original']);if(denied)throw Error('denied');return {url:'https://storage.example/exact-original',expiresAt:'2099-01-01T00:00:00Z'};}
    }});
    const click=async()=>{[...picker.querySelectorAll('button')].find(b=>b.textContent==='Preview selected file').click();await new Promise(resolve=>setTimeout(resolve,0));};
    await click();assert.equal(picker.querySelector('img').alt,'Photo · version 1');assert.equal(picker.querySelector('img').referrerPolicy,'no-referrer');
    sizeBytes=11*1024*1024;await click();assert.equal(picker.querySelector('img'),null);assert.equal(downloads,1);assert.match(picker.textContent,/10 MB preview limit/);
    sizeBytes=100;denied=true;await click();assert.equal(picker.querySelector('img'),null);assert.match(picker.textContent,/access has changed/);assert.equal(control.value,'pinned');
  } finally {globalThis.document=previous;dom.window.close();}
});

test('vector attachment preview uses exact version and labels partial data', async()=>{
  const previous=globalThis.document;
  const dom=new JSDOM('<!doctype html><body></body>');globalThis.document=dom.window.document;
  try {
    const control=document.createElement('input');control.value='pinned';let wrong=false;
    const picker=FeatureAttachmentPicker({control,adapter:{
      resolveFeatureAttachment:async()=>({format:'geojson',projectId:'project',datasetId:'file'}),
      getDatasetSpatialPreview:async(...args)=>{
        assert.deepEqual(args,['project','file','pinned']);
        return {datasetVersionId:wrong?'latest':'pinned',numberReturned:1,numberMatched:10,mayBeTruncated:true,
          geojson:{type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:{type:'Point',coordinates:[85,27]}}]}};
      }
    }});
    const button=[...picker.querySelectorAll('button')].find(b=>b.textContent==='Preview selected file');
    button.click();await new Promise(resolve=>setTimeout(resolve,5));
    const region=picker.querySelector('[aria-label="Selected attachment preview"]');
    assert.match(region.textContent,/1 features shown of 10 · partial preview/);
    assert.ok(region.querySelector('.map-frame'));
    wrong=true;button.click();await new Promise(resolve=>setTimeout(resolve,5));
    assert.match(region.textContent,/Preview unavailable/);assert.equal(region.querySelector('.map-frame'),null);
    assert.equal(control.value,'pinned');
    const layers=geometryPaint('GeometryCollection');
    assert.deepEqual(new Set(layers.map(layer=>layer.filter[2])),new Set(['Polygon','LineString','Point']));
    assert.equal(new Set(layers.map(layer=>layer.id)).size,layers.length);
  } finally {globalThis.document=previous;dom.window.close();}
});

test('uploaded attachment is checked deliberately and selected without repeating upload', async()=>{
  const previous=globalThis.document;
  const dom=new JSDOM('<!doctype html><body></body>');globalThis.document=dom.window.document;
  try {
    const control=document.createElement('input');control.value='existing-version';
    let uploads=0,requests=0,checks=0,ready=false;
    const adapter={
      requestUpload:async(_project,metadata)=>{requests++;assert.equal(metadata.classification,'restricted');return {uploadId:'upload',expiresAt:'2099-01-01T00:00:00Z',upload:{}};},
      uploadFile:async()=>{uploads++;},
      completeUpload:async()=>({dataset:{id:'file',name:'Notes'},datasetVersionId:'registered-version',versionNumber:1}),
      resolveFeatureAttachment:async version=>{checks++;assert.equal(version,'registered-version');if(!ready)throw Error('pending');return {versionId:version,name:'Notes',versionNumber:1};}
    };
    const picker=FeatureAttachmentPicker({control,adapter,projectId:'project',classification:'restricted'});
    const file=new Blob(['sample'],{type:'application/pdf'});Object.defineProperty(file,'name',{value:'notes.pdf'});
    Object.defineProperty(picker.querySelector('input[type=file]'),'files',{value:[file]});
    const click=async label=>{
      const button=[...picker.querySelectorAll('button')].find(b=>b.textContent===label);assert.ok(button,label);button.click();
      for(let i=0;i<100;i++){await new Promise(resolve=>setTimeout(resolve,2));if(!button.disabled)return;}
      assert.fail('Action did not finish');
    };
    await click('Register attachment file');assert.equal(checks,0);assert.equal(control.value,'existing-version');
    await click('Check registered file');assert.match(picker.textContent,/not available yet/);assert.equal(control.value,'existing-version');
    ready=true;await click('Check registered file');assert.equal(control.value,'existing-version');
    await click('Use Notes · v1');assert.equal(control.value,'registered-version');
    await click('Register attachment file');assert.equal(requests,1);assert.equal(uploads,1);assert.equal(checks,2);
  } finally {globalThis.document=previous;dom.window.close();}
});

test('attachment preview pins the selected version and discards hidden or changed results', async()=>{
  const previous=globalThis.document;
  const dom=new JSDOM('<!doctype html><body></body>');globalThis.document=dom.window.document;
  try {
    const control=document.createElement('input');control.value='chosen-version';
    let pending,denied=false;const calls=[];
    const adapter={
      resolveFeatureAttachment:async()=>{if(denied)throw Error('revoked');return {format:'pdf',projectId:'project',datasetId:'file'};},
      getDatasetDocumentPreview:async(...args)=>{calls.push(args);return new Promise(resolve=>{pending=resolve;});}
    };
    const picker=FeatureAttachmentPicker({control,adapter});
    const region=picker.querySelector('[aria-label="Selected attachment preview"]');
    const click=async label=>{
      [...picker.querySelectorAll('button')].find(b=>b.textContent===label).click();
      await new Promise(resolve=>setTimeout(resolve,0));
    };
    const preview={sourceFormat:'pdf',title:'<script>not executable</script>',pdfVersion:'1.7',extraction:{ocrPerformed:false},pages:[{number:1,blocks:[{type:'paragraph',text:'Retained text'}]}]};
    assert.equal(calls.length,0);
    await click('Preview selected file');assert.deepEqual(calls,[['project','file','chosen-version']]);
    pending(preview);await new Promise(resolve=>setTimeout(resolve,0));
    assert.match(region.textContent,/Retained text/);assert.equal(region.querySelector('script'),null);
    await click('Preview selected file');await click('Hide preview');
    pending(preview);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(region.textContent,'');
    await click('Preview selected file');control.value='another-version';control.dispatchEvent(new dom.window.Event('change'));
    pending(preview);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(region.textContent,'');
    denied=true;await click('Preview selected file');assert.match(region.textContent,/access has changed/);
    assert.equal(control.value,'another-version');assert.equal(calls.length,3);
  } finally {globalThis.document=previous;dom.window.close();}
});

test('fixture catalog picker resolves exact files and respects separate download access', async()=>{
  const catalog=JSON.parse(await readFile(new URL('../src/data/catalog.json',import.meta.url),'utf8'));
  const adapter=new FixturePlatformAdapter(catalog);
  const dataset=(await adapter.searchDatasets()).find(d=>d.status==='active' && d.currentVersionState==='active' && d.capabilities?.download);
  assert.ok(dataset);
  const previous=globalThis.document;
  const dom=new JSDOM('<!doctype html><body></body>');globalThis.document=dom.window.document;
  try {
    const control=document.createElement('input');
    const picker=FeatureAttachmentPicker({control,adapter,projectId:dataset.projectId});
    const click=async label=>{
      const button=[...picker.querySelectorAll('button')].find(b=>b.textContent===label);
      assert.ok(button,label);button.click();await new Promise(resolve=>setTimeout(resolve,0));
    };
    picker.querySelector('input[type=search]').value=dataset.name;
    await click('Search catalog');await click(dataset.name);
    await click(`${dataset.name} · v${dataset.currentVersionNumber}`);
    assert.equal(control.value,dataset.currentVersionId);
    await click('File details');assert.match(picker.textContent,/File access is checked separately/);
    await click('Download selected file');assert.match(picker.textContent,/authorized in memory only/);
    const stored=adapter.datasets.find(d=>d.id===dataset.id);
    stored.capabilities.download=false;
    await click('File details');assert.match(picker.textContent,/File access is checked separately/);
    await click('Download selected file');assert.match(picker.textContent,/download permission has changed/);
    assert.equal(control.value,dataset.currentVersionId);
    stored.capabilities.read=false;
    await assert.rejects(adapter.resolveFeatureAttachment(control.value),{code:'attachment_not_found'});
    stored.capabilities.read=true;stored.currentVersionState='pending';
    await assert.rejects(adapter.resolveFeatureAttachment(control.value),{code:'attachment_not_found'});
    stored.currentVersionState='active';stored.currentVersionId='11111111-1111-4111-8111-111111111111';
    await assert.rejects(adapter.resolveFeatureAttachment(control.value),{code:'attachment_not_found'});
    assert.equal(control.value,dataset.currentVersionId);
  } finally {globalThis.document=previous;dom.window.close();}
});

test('catalog picker pins chosen version and preserves it when access is withdrawn', async()=>{
  const previous=globalThis.document;
  const dom=new JSDOM('<!doctype html><body></body>');globalThis.document=dom.window.document;
  try {
    const control=document.createElement('input');
    let searches=0,downloads=0;
    const adapter={
      searchDatasets:async()=>{searches++;return [{id:'dataset',projectId:'project',name:'Field photo',status:'active',currentVersionState:'active'}];},
      listDatasetVersions:async()=>[{id:'old-version',versionNumber:1,state:'active'},{id:'new-version',versionNumber:2,state:'active'}],
      resolveFeatureAttachment:async()=>{throw new Error('revoked');},
      requestDatasetDownload:async()=>{downloads++;throw new Error('must not run');}
    };
    const picker=FeatureAttachmentPicker({control,adapter,projectId:'project'});
    const click=async label=>{
      const button=[...picker.querySelectorAll('button')].find(b=>b.textContent===label);
      assert.ok(button,label);button.click();await new Promise(resolve=>setTimeout(resolve,0));
    };
    assert.equal(searches,0);
    await click('Search catalog');await click('Field photo');await click('Field photo · v1');
    assert.equal(control.value,'old-version');
    await click('Download selected file');
    assert.equal(downloads,0);assert.equal(control.value,'old-version');
    assert.match(picker.textContent,/reference is preserved/);
    await click('Clear attachment');assert.equal(control.value,'');
  } finally {globalThis.document=previous;dom.window.close();}
});
