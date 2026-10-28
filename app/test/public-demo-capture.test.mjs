import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {createPublicDemoCaptureSession} from '../src/components/PublicDemoCapture.js';

test('public capture reuses shared forms with isolated memory and local review', async()=>{
  const prior=globalThis.document,priorFetch=globalThis.fetch;
  const dom=new JSDOM('<!doctype html><body><main></main></body>');globalThis.document=dom.window.document;
  globalThis.fetch=()=>{throw Error('Demo must not contact a service');};
  try {
    const session=await createPublicDemoCaptureSession();
    const other=await createPublicDemoCaptureSession();
    const details=document.querySelector('main');await session.render(details);
    assert.ok(details.querySelector('.project-field-observation-form'));
    assert.match(details.textContent,/Temporary tab storage/);
    const scope={organizationId:session.state.organization.id,userId:session.state.session.userId};
    const file=new File(['{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[85,27]}}]}'],'demo.geojson',{type:'application/geo+json'});
    const kept=await session.state.captureStorage.files.save(scope,{projectId:session.state.project.id,classification:'internal',file});
    assert.equal((await other.state.captureStorage.files.list(scope)).length,0);
    const click=async label=>{
      const button=[...details.querySelectorAll('button')].find(item=>item.textContent===label);assert.ok(button,label);
      button.click();await new Promise(resolve=>setTimeout(resolve,10));
    };
    await click('Show device files');await click('Use device file in offline observation: demo.geojson');
    details.querySelector('[aria-label="Field observation GeoJSON geometry"]').value=JSON.stringify({type:'Point',coordinates:[85,27]});
    await click('Confirm observation location');
    details.querySelector('[aria-label="Feature property observation"]').value='Demo inspection';
    await click('Save to device queue');
    assert.equal((await session.state.captureStorage.queue.list(scope)).length,1);
    await click('Choose device file: demo.geojson');await click('Register attachment file');
    const registrationDeadline=Date.now()+500;
    let records=await session.state.captureStorage.files.list(scope);
    while (!records.find(record=>record.id===kept.id)?.registeredVersionId && Date.now()<registrationDeadline) {
      await new Promise(resolve=>setTimeout(resolve,5));
      records=await session.state.captureStorage.files.list(scope);
    }
    assert.equal(records[0].id,kept.id);assert.ok(records[0].registeredVersionId);
    await click('Sync device queue');
    assert.equal((await session.state.captureStorage.queue.list(scope)).length,0);
    await click('Start review');await click('Accept and promote');
    const features=await session.state.adapter.listFeatures(session.state.project.id,session.dataset.id);
    assert.equal(features.features.length,1);
    assert.deepEqual(features.features[0].geometry,{type:'Point',coordinates:[85,27]});
    assert.equal(features.features[0].properties.observation,'Demo inspection');
    assert.equal(features.features[0].properties.file,records[0].registeredVersionId);
    await assert.rejects(session.state.adapter.requestUpload(session.state.project.id,{format:'pdf',sizeBytes:1}),/Demo file limit/);
  } finally {globalThis.document=prior;globalThis.fetch=priorFetch;dom.window.close();}
});

test('capture refuses untouched and unconfirmed locations and requires a real observation', async()=>{
  await withCapture(async({session,details,scope,click,submit})=>{
    const geometry=details.querySelector('[aria-label="Field observation GeoJSON geometry"]');
    const observation=details.querySelector('[aria-label="Feature property observation"]');
    let submitted=0;
    const original=session.state.adapter.createFieldSubmission.bind(session.state.adapter);
    session.state.adapter.createFieldSubmission=(...args)=>{submitted++;return original(...args);};
    assert.equal(geometry.value,'');
    assert.equal(observation.value,'');
    await click('Save to device queue');await submit();
    assert.equal((await session.state.captureStorage.queue.list(scope)).length,0);
    assert.equal(submitted,0);
    assert.match(details.textContent,/Set the location using GPS or the map/);

    observation.value='Observed in the field';
    await click('Save to device queue');await submit();
    assert.equal(submitted,0);
    geometry.value=JSON.stringify({type:'Point',coordinates:[0,0]});
    geometry.dispatchEvent(new details.ownerDocument.defaultView.Event('input'));
    await click('Save to device queue');await submit();
    assert.equal(submitted,0);
    assert.equal((await session.state.captureStorage.queue.list(scope)).length,0);

    geometry.value=JSON.stringify({type:'Point',coordinates:[181,0]});
    await click('Confirm observation location');await click('Save to device queue');
    assert.equal((await session.state.captureStorage.queue.list(scope)).length,0);
    geometry.value=JSON.stringify({type:'Point',coordinates:[0,0]});
    await click('Confirm observation location');
    observation.value='';
    await click('Save to device queue');await submit();
    assert.equal((await session.state.captureStorage.queue.list(scope)).length,0);
    assert.equal(submitted,0);
    assert.match(details.textContent,/feature_properties_invalid/);

    observation.value='Confirmed equator observation';
    await submit();
    assert.equal(submitted,1);
    const featurePage=await session.state.adapter.listFeatures(session.state.project.id,session.dataset.id);
    assert.equal(featurePage.features.length,0);
    const review=details.querySelector('.project-field-submission');
    assert.equal(review.querySelector('strong').textContent,'New observation · submitted');
    assert.match(review.textContent,/Location: longitude 0, latitude 0/);
    assert.equal(review.querySelector('dd').textContent,'Confirmed equator observation');
    assert.equal(review.querySelector('details').open,false);
    assert.equal(details.querySelector('[aria-label="Feature property observation"]').value,'');
  });
});

test('changing confirmed coordinates requires confirmation again before device saving', async()=>{
  await withCapture(async({session,details,scope,click})=>{
    const geometry=details.querySelector('[aria-label="Field observation GeoJSON geometry"]');
    details.querySelector('[aria-label="Feature property observation"]').value='Actual observation';
    geometry.value=JSON.stringify({type:'Point',coordinates:[0,0]});
    await click('Confirm observation location');
    geometry.value=JSON.stringify({type:'Point',coordinates:[1,2]});
    await click('Save to device queue');
    assert.equal((await session.state.captureStorage.queue.list(scope)).length,0);
    geometry.dispatchEvent(new details.ownerDocument.defaultView.Event('change'));
    await click('Save to device queue');
    assert.equal((await session.state.captureStorage.queue.list(scope)).length,0);
    await click('Confirm observation location');
    geometry.dispatchEvent(new details.ownerDocument.defaultView.Event('input'));
    await click('Save to device queue');
    assert.equal((await session.state.captureStorage.queue.list(scope)).length,0);
    await click('Confirm observation location');await click('Save to device queue');
    const records=await session.state.captureStorage.queue.list(scope);
    assert.equal(records.length,1);
    assert.deepEqual(records[0].request.feature.geometry,{type:'Point',coordinates:[1,2]});
    assert.deepEqual(records[0].request.feature.properties,{observation:'Actual observation'});
  });
});

test('GPS failure leaves capture blank and an acquired zero coordinate is valid', async()=>{
  await withCapture(async({session,details,scope,click})=>{
    const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');
    let acquired=false;
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:{geolocation:{
      getCurrentPosition(success,failure){
        if(acquired)success({coords:{longitude:0,latitude:0,accuracy:0}});
        else failure({code:1});
      }
    }}});
    try {
      details.querySelector('[aria-label="Feature property observation"]').value='GPS observation';
      await click('Use current GPS');
      assert.equal(details.querySelector('[aria-label="Field observation GeoJSON geometry"]').value,'');
      assert.match(details.textContent,/GPS position was not captured/);
      await click('Save to device queue');
      assert.equal((await session.state.captureStorage.queue.list(scope)).length,0);
      acquired=true;
      await click('Use current GPS');await click('Save to device queue');
      const records=await session.state.captureStorage.queue.list(scope);
      assert.equal(records.length,1);
      assert.deepEqual(records[0].request.feature.geometry,{type:'Point',coordinates:[0,0]});
    } finally {
      if(previous)Object.defineProperty(globalThis,'navigator',previous);
      else delete globalThis.navigator;
    }
  });
});

async function withCapture(run) {
  const previousDocument=globalThis.document,previousFetch=globalThis.fetch;
  const dom=new JSDOM('<!doctype html><body><main></main></body>');
  globalThis.document=dom.window.document;
  globalThis.fetch=()=>{throw Error('Demo must not contact a service');};
  try {
    const session=await createPublicDemoCaptureSession();
    const details=document.querySelector('main');await session.render(details);
    const scope={organizationId:session.state.organization.id,userId:session.state.session.userId};
    const settle=()=>new Promise(resolve=>setTimeout(resolve,10));
    const click=async label=>{
      const button=[...details.querySelectorAll('button')].find(item=>item.textContent===label);
      assert.ok(button,label);button.click();await settle();
    };
    const submit=async()=>{
      details.querySelector('.project-field-observation-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
      await settle();
    };
    await run({session,details,scope,click,submit});
  } finally {
    globalThis.document=previousDocument;globalThis.fetch=previousFetch;dom.window.close();
  }
}
