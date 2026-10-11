import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compilePortableMapArtifact, verifyPortableMapArtifact, readPortableMapManifest} from '../src/lib/portableMapArtifact.js';
import {inspectStaticMapLayers} from '../src/lib/staticMapExport.js';
import {publicationMapInsert} from '../src/lib/publicationMapInsert.js';
const options = () => ({title:'Survey · 地図', runtimeJs:'window.ready=true;', runtimeCss:'body{margin:0}', runtimeLicense:'BSD',
  selectedIds:['sites'], candidates:inspectStaticMapLayers({style:{sources:{sites:{type:'geojson',data:{type:'FeatureCollection',features:[]}}},layers:[{id:'sites',source:'sites',type:'circle'}]},layers:[{layerId:'sites',title:'Sites'}],handles:new Map([['sites',{sourceId:'sites',layerIds:['sites']}]])})});
test('portable manifests bind exact bytes and inputs without inventing a saved Project or rights',async()=>{
  const first=await compilePortableMapArtifact(options()), second=await compilePortableMapArtifact(options());
  assert.deepEqual(first,second);
  assert.equal(first.manifest.output.sizeBytes,new TextEncoder().encode(first.html).length);
  assert.equal(first.manifest.project,null);
  assert.equal(first.manifest.rights.redistributionAllowed,null);
  assert.equal(first.manifest.dependencies[0].coverage,'loaded-feature-snapshot');
  assert.deepEqual(first.manifest.networkDependencies,[]);
  await verifyPortableMapArtifact(new Blob([first.html]),first.manifest);
  for(const change of [{runtimeJs:'window.ready=false;'}, {view:{center:[3,4],zoom:5}}, {title:'Changed'}]){
    const next=await compilePortableMapArtifact({...options(),...change});
    assert.notEqual(next.manifest.output.checksumSha256,first.manifest.output.checksumSha256);
    assert.notEqual(next.manifest.build.inputChecksumSha256,first.manifest.build.inputChecksumSha256);
  }
  await assert.rejects(verifyPortableMapArtifact(new Blob([first.html.replace('Survey','survey')]),first.manifest),/checksum/);
  await assert.rejects(verifyPortableMapArtifact(new Blob([first.html]),{...first.manifest,rights:{license:'invented'}}),/checksum/);
});
test('Publication insertion retains an unchanged manifest and rejects sidecar path collisions',async()=>{
  const {html,manifest}=await compilePortableMapArtifact(options());
  const input={entryPath:'src/index.md',name:'Survey.html',blob:new Blob([html]),manifest};
  const inserted=publicationMapInsert(input);
  assert.deepEqual(inserted.files.map(f=>f.relativePath),['src/maps/Survey.html','src/maps/Survey.html.artifact.json','src/maps/Survey.js']);
  assert.deepEqual(JSON.parse(await inserted.files[1].blob.text()),manifest);
  assert.throws(()=>publicationMapInsert({...input,existingPaths:['src/maps/survey.html.artifact.json']}),/manifest path/);
});

test('downloaded sidecars are bounded and verified before reuse',async()=>{
  const {html,manifest}=await compilePortableMapArtifact(options());
  const restored=await readPortableMapManifest(new Blob([JSON.stringify(manifest)]));
  await verifyPortableMapArtifact(new Blob([html]),restored);
  await assert.rejects(readPortableMapManifest(new Blob(['x'.repeat(49153)])),/48 KiB/);
  await assert.rejects(readPortableMapManifest(new Blob(['invalid'])),/valid JSON/);
  await assert.rejects(verifyPortableMapArtifact(new Blob([html]),await readPortableMapManifest(new Blob(['null']))),/identity/);
});

test('saved origin is pinned provenance while browser edits remain a separate snapshot',async()=>{
  const origin={id:'composition',version:3,definition:{layers:[],mapViews:[]}};
  const pending=compilePortableMapArtifact({...options(),savedProjectOrigin:origin});
  origin.version=4;
  const first=await pending;
  assert.equal(first.manifest.provenance.originatingProject.version,3);
  assert.equal(first.manifest.provenance.authoritativeBuild,false);
  assert.equal(first.manifest.project,null);
  const next=await compilePortableMapArtifact({...options(),savedProjectOrigin:origin});
  assert.equal(next.manifest.output.checksumSha256,first.manifest.output.checksumSha256);
  assert.notEqual(next.manifest.manifestChecksumSha256,first.manifest.manifestChecksumSha256);
  await verifyPortableMapArtifact(new Blob([first.html]),first.manifest);
  await assert.rejects(compilePortableMapArtifact({...options(),savedProjectOrigin:{...origin,version:0}}),/originating/);
});
test('legacy downloaded manifests remain verifiable and unknown encodings fail closed',async()=>{
  const {canonicalJson}=await import('../src/lib/geolibreImport.js');
  const {createHash}=await import('node:crypto');
  const {html,manifest}=await compilePortableMapArtifact(options());
  const legacy=structuredClone(manifest);
  delete legacy.canonicalization; delete legacy.manifestChecksumSha256;
  legacy.manifestChecksumSha256=createHash('sha256').update(canonicalJson(legacy)).digest('hex');
  await verifyPortableMapArtifact(new Blob([html]),legacy);
  await assert.rejects(verifyPortableMapArtifact(new Blob([html]),{...manifest,canonicalization:'unknown'}),/unsupported/);
});

test('registration conflict retries reuse retained bytes without issuing another ticket or upload',async()=>{
  const {portableArtifactUpload}=await import('../src/lib/portableArtifactUpload.js');
  const {html,manifest}=await compilePortableMapArtifact({...options(),savedProjectOrigin:{id:'map',version:1,definition:{layers:[]}}});
  const calls=[];
  let fail=true;
  const adapter={
    async requestPortableArtifactUpload(){calls.push('ticket');return {upload_id:'upload',expires_at:new Date(Date.now()+60000).toISOString()};},
    async uploadFile(){calls.push('upload');},
    async completePortableArtifactUpload(){calls.push('complete');return {output_object_id:'output'};},
    async registerPortableArtifactEdition(...args){calls.push(['register',args.at(-1)]);if(fail){fail=false;throw Object.assign(Error('conflict'),{code:'artifact_revision_conflict'});}return {version_number:1};}
  };
  const session=portableArtifactUpload({adapter,projectId:'workspace',resourceId:'resource',blob:new Blob([html]),manifest});
  await assert.rejects(session.register(0),/conflict/);
  assert.deepEqual(await session.register(1),{version_number:1});
  assert.deepEqual(calls,['ticket','upload','complete',['register',0],['register',1]]);
});

test('an uncertain upload is checked for completion before sending its bytes again',async()=>{
  const {portableArtifactUpload}=await import('../src/lib/portableArtifactUpload.js');
  const {html,manifest}=await compilePortableMapArtifact({...options(),savedProjectOrigin:{id:'map',version:1,definition:{layers:[]}}});
  const calls=[];
  const adapter={
    async requestPortableArtifactUpload(){return {upload_id:'upload',expires_at:new Date(Date.now()+60000).toISOString()};},
    async uploadFile(){calls.push('upload');throw Error('connection lost');},
    async completePortableArtifactUpload(){calls.push('complete');return {output_object_id:'output'};},
    async registerPortableArtifactEdition(){calls.push('register');return {version_number:1};}
  };
  const session=portableArtifactUpload({adapter,projectId:'workspace',resourceId:'resource',blob:new Blob([html]),manifest});
  await assert.rejects(session.register(0),/connection lost/);
  await session.register(0);
  assert.deepEqual(calls,['upload','complete','register']);
});

test('pinned Style exports retain selected revision provenance and refuse mismatched displayed paints',async()=>{
 const {resolveLayerStyle,referencedStylePaint}=await import('../src/lib/layerStyleReference.js');
 const id='d0000000-0000-4000-8000-000000000002';
 const definition=JSON.stringify({version:8,sources:{},layers:[{id:'fill',type:'fill',paint:{'fill-color':'#123456','fill-outline-color':'#654321'}}]});
 const checksumSha256=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(definition))).toString('hex');
 const reference={projectId:id,resourceId:id,styleId:id,versionNumber:1,checksumSha256,format:'maplibre'};
 const layer={layerId:'area',datasetId:id,title:'Area',geometryType:'Polygon',opacity:.5,styleReference:reference};
 const resolved=await resolveLayerStyle({getResource:async()=>({id,projectId:id,datasetId:id}),getResourceStyleVersion:async()=>({id,resourceId:id,versionNumber:1,checksumSha256,format:'maplibre',definition})},layer);
 const style={sources:{area:{type:'geojson',data:{type:'FeatureCollection',features:[]}}},layers:referencedStylePaint(resolved,layer).map(p=>({...p,source:'area'}))};
 const handle={sourceId:'area',layerIds:style.layers.map(p=>p.id),boundStyle:resolved};
 const input={style,layers:[layer],handles:new Map([['area',handle]])};
 const candidates=inspectStaticMapLayers(input);assert.equal(candidates[0].reason,null);
 const artifact=await compilePortableMapArtifact({...options(),candidates,selectedIds:['area']});
 assert.deepEqual(artifact.manifest.styleDependencies[0].reference,reference);
 assert.equal(artifact.manifest.styleDependencies[0].recordedRights.license,null);
 await verifyPortableMapArtifact(new Blob([artifact.html]),artifact.manifest);
 const changed=structuredClone(candidates);changed[0].styleReference.versionNumber=2;
 const next=await compilePortableMapArtifact({...options(),candidates:changed,selectedIds:['area']});
 assert.equal(next.html,artifact.html);assert.notEqual(next.manifest.build.inputChecksumSha256,artifact.manifest.build.inputChecksumSha256);
 handle.boundStyle=null;assert.match(inspectStaticMapLayers(input)[0].reason,/not resolved/);
 handle.boundStyle=resolved;style.layers[0].paint['fill-color']='#ffffff';
 const invalid=inspectStaticMapLayers(input);assert.match(invalid[0].reason,/differs/);
 await assert.rejects(compilePortableMapArtifact({...options(),candidates:invalid,selectedIds:['area']}),/supported/);
 const unselected=await compilePortableMapArtifact({...options(),candidates:[...options().candidates,...candidates]});
 assert.equal(unselected.manifest.styleDependencies,undefined);
});

test('display filters change artifact identity without rewriting embedded source data',async()=>{
  const base=options();
  const first=await compilePortableMapArtifact(base);
  base.candidates[0].paints[0].filter=['==',['get','status'],'reviewed'];
  const filtered=await compilePortableMapArtifact(base);
  assert.notEqual(filtered.manifest.output.checksumSha256,first.manifest.output.checksumSha256);
  assert.notEqual(filtered.manifest.build.inputChecksumSha256,first.manifest.build.inputChecksumSha256);
  assert.deepEqual(filtered.manifest.dependencies,first.manifest.dependencies);
  await verifyPortableMapArtifact(new Blob([filtered.html]),filtered.manifest);
});
