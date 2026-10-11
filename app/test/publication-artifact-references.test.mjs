import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {ApiContractError, OpenGeoApiClient, parsePublicationArtifactReferences, parsePublicationArtifactBackupInputs} from '../src/lib/apiClient.js';
import {PublicationArtifactReferences} from '../src/components/PublicationArtifactReferences.js';
const id='11111111-1111-4111-8111-111111111111';
const reference={path:'maps/survey.html',artifact_id:id,mode:'current',version:null};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('proxy clients reuse canonical public release URLs returned by the API',async()=>{
 const url=`https://api.example.test/public/organizations/${id}/artifact-releases/${id}/view`;
 const client=new OpenGeoApiClient({baseUrl:'/api',organizationProvider:()=>id});
 client.request=async()=>({id,public_view_url:url});
 await client.createArtifactRelease(id,{});
 assert.equal(await client.publicArtifactReleaseUrl(id),url);
 assert.throws(()=>client.rememberPublicArtifactUrl(id,url+'?token=private'));
});
test('reference client retains optimistic revision and rejects paths and ambiguous edition selections',async()=>{
 const client=Object.create(OpenGeoApiClient.prototype), calls=[];
 client.request=async(...args)=>{calls.push(args);return {revision:2,references:[reference]};};
 await client.savePublicationArtifactReferences(id,id,1,[reference]);
 assert.deepEqual(calls[0][1].body,{expected_revision:1,references:[reference]});
 for(const references of [[{...reference,path:'../map.html'}],[{...reference,version:1}],[{...reference,mode:'pinned'}],[reference,{...reference,path:'MAPS/survey.html'}]]) {
  assert.throws(()=>parsePublicationArtifactReferences({revision:1,references}));
 }
});
test('reference editor preserves a conflicting draft, saves removal, and never builds on navigation',async()=>{
 const dom=new JSDOM('<body></body>'), previous=globalThis.document; globalThis.document=dom.window.document;
 let reads=0, writes=0, fail=true;
 const adapter={readPublicationArtifactReferences:async()=>{reads++;return {revision:4,references:[reference]};},
 savePublicationArtifactReferences:async(p,s,revision,references)=>{writes++;assert.equal(revision,4); if(fail) throw {code:'publication_artifact_revision_conflict'};return {revision:5,references};}};
 try {
  const root=PublicationArtifactReferences({adapter,projectId:id,sourceProjectId:id,canManage:true});document.body.append(root);
  const click=async label=>{[...root.querySelectorAll('button')].find(n=>n.textContent===label).click();await settle();};
  assert.equal(reads,0);await click('Load saved references');assert.equal(reads,1);
  const input=root.querySelector('input');input.value='maps/edited.html';input.dispatchEvent(new dom.window.Event('input'));
  await click('Save Artifact references');assert.equal(input.value,'maps/edited.html');assert.match(root.textContent,/revision_conflict/);
  assert.equal([...root.querySelectorAll('button')].find(n=>n.textContent==='Load saved references').disabled,true);
  fail=false;await click('Remove reference');await click('Save Artifact references');assert.equal(writes,2);assert.match(root.textContent,/revision 5/);
 } finally {dom.window.close();globalThis.document=previous;}
});

test('preparation verifies the returned source, revision and reference identity',async()=>{
 const client=Object.create(OpenGeoApiClient.prototype), calls=[];
 const manifest={schemaVersion:'opengeo.publication-artifact-inputs.1.0.0',sourceProjectId:id,sourceRevisionId:id,referenceRevision:4,artifacts:[{}]};
 client.request=async(...args)=>{calls.push(args);return {id,manifest,manifest_checksum_sha256:'a'.repeat(64),reused:true};};
 const result=await client.preparePublicationArtifactInputs(id,id,id,4);
 assert.equal(result.checksum,'a'.repeat(64));assert.equal(calls[0][1].body.expected_reference_revision,4);
 manifest.referenceRevision=5;await assert.rejects(client.preparePublicationArtifactInputs(id,id,id,4));
});

const backupSourceId='22222222-2222-4222-8222-222222222222';
const backupOriginProjectId='33333333-3333-4333-8333-333333333333';
const backupResourceId='44444444-4444-4444-8444-444444444444';
const backupOutputId='55555555-5555-4555-8555-555555555555';
const backupInputs=()=>({schema_version:'opengeo.publication-artifact-backup-inputs.1.0.0',
 project_id:id,source_project_id:backupSourceId,reference_revision:4,pins:[{
  ...reference,resolved_version:7,manifest_checksum_sha256:'a'.repeat(64),
  project_id:backupOriginProjectId,resource_id:backupResourceId,
  output:{objectId:backupOutputId,mediaType:'text/html',sizeBytes:123,checksumSha256:'b'.repeat(64)}
 }]});

test('backup inputs client reads exact references with account authentication and cancellation',async()=>{
 const calls=[],controller=new AbortController();
 const client=new OpenGeoApiClient({baseUrl:'/api',tokenProvider:()=> 'test-session',organizationProvider:()=>id,
  fetchImplementation:async(...args)=>{calls.push(args);return new Response(JSON.stringify(backupInputs()),{status:200,headers:{'content-type':'application/json'}});}});
 const result=await client.readPublicationArtifactBackupInputs(id,backupSourceId,{expectedReferenceRevision:4,signal:controller.signal});
 assert.equal(calls.length,1);
 const [url,request]=calls[0];
 assert.equal(url,`/api/projects/${id}/source-projects/${backupSourceId}/artifact-backup-inputs?expected_reference_revision=4`);
 assert.equal(request.method,'GET');assert.equal(request.body,undefined);assert.equal(request.signal,controller.signal);
 assert.equal(request.headers.get('authorization'),'Bearer test-session');
 assert.equal(request.headers.get('X-OpenGeo-Organization'),id);
 assert.equal(result.referenceRevision,4);
 assert.deepEqual(result.pins[0],{path:reference.path,artifactId:id,mode:'current',version:null,resolvedVersion:7,
  manifestChecksumSha256:'a'.repeat(64),projectId:backupOriginProjectId,resourceId:backupResourceId,
  output:{objectId:backupOutputId,mediaType:'text/html',sizeBytes:123,checksumSha256:'b'.repeat(64)}});
});

test('backup inputs client bounds expected revisions and rejects changed response identities',async()=>{
 const client=Object.create(OpenGeoApiClient.prototype),calls=[];let response=backupInputs();
 client.request=async(...args)=>{calls.push(args);return response;};
 await client.readPublicationArtifactBackupInputs(id,backupSourceId);
 assert.equal(calls[0][0],`/projects/${id}/source-projects/${backupSourceId}/artifact-backup-inputs`);
 for(const revision of [-1,0.5,2147483648,null]) {
  await assert.rejects(client.readPublicationArtifactBackupInputs(id,backupSourceId,{expectedReferenceRevision:revision}));
 }
 assert.equal(calls.length,1,'invalid revisions must not issue requests');
 await assert.rejects(client.readPublicationArtifactBackupInputs(id,backupSourceId,{expectedReferenceRevision:5}),ApiContractError);
 response={...backupInputs(),project_id:backupOriginProjectId};
 await assert.rejects(client.readPublicationArtifactBackupInputs(id,backupSourceId),ApiContractError);
 response={...backupInputs(),source_project_id:backupResourceId};
 await assert.rejects(client.readPublicationArtifactBackupInputs(id,backupSourceId),ApiContractError);
 response={...backupInputs(),reference_revision:0,pins:[]};
 assert.deepEqual((await client.readPublicationArtifactBackupInputs(id,backupSourceId,{expectedReferenceRevision:0})).pins,[]);
 assert.match(calls.at(-1)[0],/expected_reference_revision=0$/);
});

test('backup inputs parser preserves pinned editions and rejects unsafe or ambiguous references',()=>{
 const parse=value=>parsePublicationArtifactBackupInputs(value,id,backupSourceId,4);
 const pinned=backupInputs();pinned.pins[0].mode='pinned';pinned.pins[0].version=7;
 assert.equal(parse(pinned).pins[0].resolvedVersion,7);
 for(const [label,change] of [
  ['unsupported schema',value=>{value.schema_version='future';}],
  ['extra top field',value=>{value.url='https://example.test';}],
  ['missing top field',value=>{delete value.project_id;}],
  ['extra pin field',value=>{value.pins[0].storage_key='secret';}],
  ['missing pin field',value=>{delete value.pins[0].resource_id;}],
  ['too many pins',value=>{value.pins=Array(33).fill(value.pins[0]);}],
  ['invalid revision',value=>{value.reference_revision=0.5;}],
  ['unsafe path',value=>{value.pins[0].path='../survey.html';}],
  ['duplicate path',value=>{value.pins.push({...value.pins[0],path:'MAPS/survey.html'});}],
  ['overlapping path',value=>{value.pins.push({...value.pins[0],path:'maps/survey.html/nested.html'});}],
  ['current has a version',value=>{value.pins[0].version=7;}],
  ['pin has no version',value=>{value.pins[0].mode='pinned';}],
  ['pin resolved wrong edition',value=>{value.pins[0].mode='pinned';value.pins[0].version=6;}],
  ['unresolved edition',value=>{value.pins[0].resolved_version=0;}],
  ['edition exceeds bound',value=>{value.pins[0].resolved_version=2147483648;}],
  ['invalid artifact identity',value=>{value.pins[0].artifact_id='unknown';}],
  ['invalid project identity',value=>{value.pins[0].project_id='unknown';}],
  ['invalid resource identity',value=>{value.pins[0].resource_id='unknown';}],
  ['invalid manifest checksum',value=>{value.pins[0].manifest_checksum_sha256='A'.repeat(64);}]
 ]) {
  const value=backupInputs();change(value);assert.throws(()=>parse(value),ApiContractError,label);
 }
 assert.throws(()=>parsePublicationArtifactBackupInputs({...backupInputs(),reference_revision:0},id,backupSourceId,0),ApiContractError);
});

test('backup inputs parser requires bounded retained HTML output facts',()=>{
 for(const [label,change] of [
  ['missing output',pin=>{pin.output=null;}],
  ['extra output field',pin=>{pin.output.url='https://example.test';}],
  ['missing output field',pin=>{delete pin.output.checksumSha256;}],
  ['invalid output identity',pin=>{pin.output.objectId='unknown';}],
  ['wrong media type',pin=>{pin.output.mediaType='application/octet-stream';}],
  ['empty output',pin=>{pin.output.sizeBytes=0;}],
  ['oversized output',pin=>{pin.output.sizeBytes=4_194_305;}],
  ['fractional output size',pin=>{pin.output.sizeBytes=1.5;}],
  ['invalid output checksum',pin=>{pin.output.checksumSha256='invalid';}]
 ]) {
  const value=backupInputs();change(value.pins[0]);
  assert.throws(()=>parsePublicationArtifactBackupInputs(value,id,backupSourceId,4),ApiContractError,label);
 }
 const maximum=backupInputs();maximum.pins[0].output.sizeBytes=4_194_304;
 assert.equal(parsePublicationArtifactBackupInputs(maximum,id,backupSourceId,4).pins[0].output.sizeBytes,4_194_304);
});

test('cross-workspace choices preserve draft identity and reset map pagination',async()=>{
 const dom=new JSDOM('<body></body>'), previous=globalThis.document;globalThis.document=dom.window.document;
 const calls=[];
 const adapter={readPublicationArtifactReferences:async()=>({revision:2,references:[reference]}),
 listProjects:async page=>{calls.push(['workspaces',page]);return [{id,name:'Home'},{id:'second',name:'Other workspace'}];},
 listResources:async(workspace,page)=>{calls.push(['maps',workspace,page]);return [{id:'resource',title:'Survey'}];},
 readArtifactEdition:async(...args)=>{calls.push(['edition',...args]);return {id,current_version_number:7,editions:[{version_number:7},{version_number:3}]};},
 savePublicationArtifactReferences:async(...args)=>{calls.push(['save',...args]);return {revision:3,references:args[3]};}};
 try {
  const root=PublicationArtifactReferences({adapter,projectId:id,sourceProjectId:id,canManage:true});document.body.append(root);
  const click=async label=>{[...root.querySelectorAll('button')].find(n=>n.textContent===label).click();await settle();};
  await click('Load saved references');await click('Load accessible workspaces');await click('Load map resources');await click('Load retained editions');await click('Add retained Artifact');
  const workspace=root.querySelector('[aria-label="Artifact workspace"]');workspace.value='second';workspace.dispatchEvent(new dom.window.Event('change'));
  assert.equal(root.querySelector('[aria-label="Map resource in this workspace"]').options.length,0);
  assert.equal(root.querySelectorAll('[aria-label="Artifact asset path"]').length,2);
  await click('Load map resources');await click('Load retained editions');await click('Add retained Artifact');await click('Save Artifact references');
  assert.deepEqual(calls.filter(row=>row[0]==='maps').map(row=>[row[1],row[2].offset]),[[id,0],['second',0]]);
  assert.equal(calls.filter(row=>row[0]==='edition')[1][1],'second');
  const save=calls.find(row=>row[0]==='save');assert.equal(save[1],id);assert.equal(save[2],id);assert.equal(save[4].length,3);
  assert.equal(new Set(save[4].map(item=>item.path)).size,3);
 } finally {dom.window.close();globalThis.document=previous;}
});

test('retained edition selection pins an observed version and clears on source changes without rebuilding', async () => {
 const dom=new JSDOM('<body></body>'), previous=globalThis.document;globalThis.document=dom.window.document;
 let reads=0, written;
 const adapter={readPublicationArtifactReferences:async()=>({revision:0,references:[]}),
  listResources:async()=>[{id:'first',title:'First map'},{id:'second',title:'Second map'}],
  readArtifactEdition:async(...args)=>{reads++;assert.deepEqual(args,[id,'first',null,true,'portable-map-html']);return {id,current_version_number:null,editions:[{version_number:9},{version_number:4}]};},
  savePublicationArtifactReferences:async(_p,_s,revision,references)=>{assert.equal(revision,0);written=structuredClone(references);return {revision:1,references};}};
 try {
  const root=PublicationArtifactReferences({adapter,projectId:id,sourceProjectId:id,canManage:true});document.body.append(root);
  const click=async label=>{[...root.querySelectorAll('button')].find(n=>n.textContent===label).click();await settle();};
  const button=label=>[...root.querySelectorAll('button')].find(n=>n.textContent===label);
  await click('Load saved references');await click('Load map resources');
  assert.equal(button('Add retained Artifact').disabled,true);
  assert.equal(reads,0);
  await click('Load retained editions');
  const editions=root.querySelector('[aria-label="Retained Artifact edition to add"]');
  assert.deepEqual([...editions.options].map(option=>option.value),['9','4'],'an unset current pointer cannot be selected');
  editions.value='4';await click('Add retained Artifact');
  assert.equal(root.querySelector('[aria-label="Pinned Artifact version"]').value,'4');
  const maps=root.querySelector('[aria-label="Map resource in this workspace"]');maps.value='second';maps.dispatchEvent(new dom.window.Event('change'));
  assert.equal(button('Add retained Artifact').disabled,true);
  assert.equal(editions.options.length,0);
  await click('Save Artifact references');
  assert.equal(reads,1,'selection and save reuse inspected metadata without output reads or builds');
  assert.deepEqual(written,[{path:'maps/artifact-1.html',artifact_id:id,mode:'pinned',version:4}]);
 }finally{dom.window.close();globalThis.document=previous;}
});


test('imported map paths preserve aliases while saving freshly selected destination identities and editions', async () => {
 const dom=new JSDOM('<body></body>'), previous=globalThis.document;globalThis.document=dom.window.document;
 const foreign='99999999-9999-4999-8999-999999999999', destination='22222222-2222-4222-8222-222222222222';
 const original={path:'src/maps/survey.html',artifact_id:foreign,mode:'pinned',version:99};
 let stored={revision:4,references:[{...reference,path:original.path},{...reference,path:'src/maps/other.html'}]}, reads=0;
 const writes=[];
 const adapter={readPublicationArtifactReferences:async()=>{reads++;return structuredClone(stored);},
  listResources:async()=>[{id:'map',title:'Destination map'}],
  readArtifactEdition:async()=>({id:destination,current_version_number:7,editions:[{version_number:7},{version_number:3}]}),
  savePublicationArtifactReferences:async(_p,_s,revision,references)=>{
   assert.equal(revision,4); stored={revision:5,references:structuredClone(references)};writes.push(stored);return structuredClone(stored);
  }};
 try {
  const root=PublicationArtifactReferences({adapter,projectId:id,sourceProjectId:id,canManage:true,
   importedSource:{references:{revision:99,references:[original]},getLayout:()=>({entryPath:'src/index.md',files:[{relativePath:'src/index.md'}]})}});
  document.body.append(root);
  const click=async label=>{[...root.querySelectorAll('button')].find(n=>n.textContent===label).click();await settle();};
  assert.equal(reads,0);assert.equal(writes.length,0);
  await click('Load saved references');
  const paths=root.querySelector('[aria-label="Imported map path to reconnect"]');paths.value=original.path;paths.dispatchEvent(new dom.window.Event('change'));
  assert.equal(root.querySelector('[aria-label="Retained Artifact edition to add"]').options.length,0,'Original pinned edition must not be selected');
  await click('Load map resources');await click('Load retained editions');
  root.querySelector('[aria-label="Retained Artifact edition to add"]').value='3';
  await click('Reconnect imported map');
  assert.equal(writes.length,0);assert.equal(root.querySelectorAll('[aria-label="Artifact asset path"]').length,2);
  assert.throws(()=>root.assertImportReady(),/Save or discard/);
  await click('Save Artifact references');root.assertImportReady();
  assert.deepEqual(stored.references,[{...reference,path:'src/maps/other.html'}, {path:original.path,artifact_id:destination,mode:'pinned',version:3}]);
  assert.equal(JSON.stringify(stored).includes(foreign),false);
  await click('Load saved references');assert.equal(reads,2);
  assert.deepEqual([...root.querySelectorAll('[aria-label="Artifact asset path"]')].map(input=>input.value),['src/maps/other.html',original.path]);
 }finally{dom.window.close();globalThis.document=previous;}
});

test('imported map reconnection rejects source collisions, follows current deliberately and rechecks changing source layout', async () => {
 const dom=new JSDOM('<body></body>'),previous=globalThis.document;globalThis.document=dom.window.document;
 const path='src/maps/survey.html';let sourceFiles=[{relativePath:'src/index.md'},{relativePath:path}],writes=0;
 const adapter={readPublicationArtifactReferences:async()=>({revision:0,references:[]}),listResources:async()=>[{id:'map'}],
  readArtifactEdition:async()=>({id,current_version_number:7,editions:[{version_number:7}]}),
  savePublicationArtifactReferences:async(_p,_s,_revision,references)=>{writes++;return {revision:1,references};}};
 try {
  const root=PublicationArtifactReferences({adapter,projectId:id,sourceProjectId:id,canManage:true,importedSource:{
   references:{revision:99,references:[{...reference,path,mode:'pinned',version:99}]},getLayout:()=>({entryPath:'src/index.md',files:sourceFiles})}});document.body.append(root);
  const click=async label=>{[...root.querySelectorAll('button')].find(n=>n.textContent===label).click();await settle();};
  await click('Load saved references');
  const paths=root.querySelector('[aria-label="Imported map path to reconnect"]');paths.value=path;paths.dispatchEvent(new dom.window.Event('change'));
  await click('Load map resources');await click('Load retained editions');await click('Reconnect imported map');
  assert.match(root.textContent,/collides/);assert.equal(root.querySelectorAll('[aria-label="Artifact asset path"]').length,0);assert.equal(writes,0);
  sourceFiles=[{relativePath:'src/index.md'}];await click('Reconnect imported map');
  assert.equal(root.querySelector('[aria-label="Artifact edition selection"]').value,'current','Original pin is never automatically applied');
  await click('Save Artifact references');root.assertImportReady();
  sourceFiles.push({relativePath:path});assert.throws(()=>root.assertImportReady(),/collides/);
  assert.doesNotThrow(()=>root.assertImportReady({checkLayout:false}),'Replacing a source tree can recover a collision');
  assert.equal(writes,1);
 }finally{dom.window.close();globalThis.document=previous;}
});

test('imported map references retain read-only access and reject unsupported original formats', async () => {
 const dom=new JSDOM('<body></body>'),previous=globalThis.document;globalThis.document=dom.window.document;
 let reads=0;const adapter={readPublicationArtifactReferences:async()=>{reads++;return {revision:0,references:[]};}};
 try {
  const root=PublicationArtifactReferences({adapter,projectId:id,sourceProjectId:id,canManage:false,
   importedSource:{references:{revision:1,references:[reference]},getLayout:()=>({entryPath:'index.md',files:[{relativePath:'index.md'}]})}});
  document.body.append(root);assert.equal(root.querySelector('[aria-label="Imported map path to reconnect"]').disabled,true);
  assert.equal([...root.querySelectorAll('button')].find(button=>button.textContent==='Reconnect imported map').hidden,true);
  const unsupported=PublicationArtifactReferences({adapter,projectId:id,sourceProjectId:id,canManage:true,
   importedSource:{references:{revision:1,references:[{...reference,path:'../private.html'}]}}});
  assert.match(unsupported.textContent,/unsupported format/);assert.equal(reads,0);
 }finally{dom.window.close();globalThis.document=previous;}
});
