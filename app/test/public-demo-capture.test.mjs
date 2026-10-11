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
    assert.equal(features.features[0].properties.file,records[0].registeredVersionId);
    await assert.rejects(session.state.adapter.requestUpload(session.state.project.id,{format:'pdf',sizeBytes:1}),/Demo file limit/);
  } finally {globalThis.document=prior;globalThis.fetch=priorFetch;dom.window.close();}
});
