import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {FrameworkProjectPreview, previewCapabilityUrl} from '../src/components/FrameworkProjectPreview.js';

const sourceProject={id:'source',currentRevisionId:'revision',currentRevisionNumber:6};
const job={id:'build',sourceProjectId:'source',sourceRevisionId:'revision',sourceRevisionNumber:6,purpose:'preview',state:'succeeded'};
const frameworkRevision={id:'revision',sourceProjectId:'source',revisionNumber:6,entryPath:'src/index.md'};
const capability={authorizeUrl:'https://preview.studio.opengeo.tools/authorize/#cap='+'a'.repeat(128),expiresAt:'2099-01-01T00:00:00Z',publicationAuthorized:false};
const publicCapability={...capability,authorizeUrl:capability.authorizeUrl.replace('preview.studio','maps-preview.studio')};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(adapter, options={}) {
  const dom=new JSDOM('<!doctype html><body></body>',{url:'https://studio.opengeo.tools'});
  const saved={document:globalThis.document,MutationObserver:globalThis.MutationObserver,open:globalThis.open};
  globalThis.document=dom.window.document; globalThis.MutationObserver=dom.window.MutationObserver;
  const root=FrameworkProjectPreview({adapter,projectId:'project',sourceProject,canManage:true,...options});
  document.body.append(root);
  return {root,dom,button:label=>[...root.querySelectorAll('button')].find(n=>n.textContent===label),
    async close(){root.remove();await settle();dom.window.close();Object.assign(globalThis,saved);}};
}
function adapter(change={}) {return {listObservableBuildJobs:async()=>[job],getObservableBuildJob:async()=>job,
  createObservablePreviewCapability:async()=>capability,...change};}

test('capability validation rejects wider authority, wrong origins and expiry',()=>{
  assert.equal(previewCapabilityUrl(capability),capability.authorizeUrl);
  assert.equal(previewCapabilityUrl(publicCapability),publicCapability.authorizeUrl);
  for(const update of [{publicationAuthorized:true},{expiresAt:'nonsense'},{expiresAt:'2020-01-01T00:00:00Z'},
    {authorizeUrl:capability.authorizeUrl.replace('preview.studio.opengeo.tools','studio.opengeo.tools')},
    {authorizeUrl:publicCapability.authorizeUrl.replace('maps-preview.studio.opengeo.tools','maps-preview.studio.opengeo.tools.example.org')},
    {authorizeUrl:publicCapability.authorizeUrl.replace('https://','http://')},
    {authorizeUrl:publicCapability.authorizeUrl.replace('.tools/','.tools:443/')},
    {authorizeUrl:publicCapability.authorizeUrl.replace('.tools/','.tools:8443/')},
    {authorizeUrl:publicCapability.authorizeUrl.replace('https://','https://owner@')},
    {authorizeUrl:publicCapability.authorizeUrl.replace('/#','/?source=public#')},
    {authorizeUrl:publicCapability.authorizeUrl.replace('/#','/?#')},
    {authorizeUrl:capability.authorizeUrl.replace('/authorize/','/other/')}]) {
    assert.throws(()=>previewCapabilityUrl({...capability,...update}));
  }
});
test('public map sources require a managing owner and approved source rights',async()=>{
  for (const [canManage, rightsStatus] of [[false,'approved'],[true,'unreviewed']]) {
    const requests=[];
    const f=fixture(adapter({createObservablePreviewCapability:async(...args)=>{requests.push(args[2]);return capability;}}),
      {canManage,sourceProject:{...sourceProject,rightsStatus}});
    try {
      await settle();
      const checkbox=f.root.querySelector('input[type=checkbox]');
      assert.equal(checkbox.closest('.framework-preview-public-sources').hidden,true);
      assert.equal(checkbox.disabled,true);
      checkbox.checked=true;checkbox.dispatchEvent(new f.dom.window.Event('change'));
      assert.equal(checkbox.checked,false);
      f.button('Show preview').click();await settle();
      assert.deepEqual(requests,[{runtimeProfile:'local_only'}]);
    } finally {await f.close();}
  }
});
test('public source selection only changes deliberate preview authorization and resets on draft save',async()=>{
  const requests=[];let builds=0,reads=0,destination;
  const savedSource={...sourceProject,rightsStatus:'approved'};
  const f=fixture(adapter({listObservableBuildJobs:async()=>{reads++;return[job];},
    createObservableBuildJob:async()=>{builds++;return job;},
    createObservablePreviewCapability:async(...args)=>{requests.push(args[2]);return args[2].runtimeProfile==='public_maps_v1'?publicCapability:capability;}}),
    {sourceProject:savedSource});
  const popup={opener:{},location:{replace:url=>destination=url},close(){}};
  globalThis.open=()=>popup;
  try {
    await settle();const checkbox=f.root.querySelector('input[type=checkbox]'), frame=f.root.querySelector('iframe');
    assert.equal(checkbox.closest('.framework-preview-public-sources').hidden,false);
    assert.equal(checkbox.checked,false);assert.match(f.root.textContent,/supported public libraries and map tile requests/);
    f.button('Show preview').click();await settle();assert.equal(frame.src,capability.authorizeUrl);
    checkbox.checked=true;checkbox.dispatchEvent(new f.dom.window.Event('change'));
    assert.equal(frame.hidden,true);assert.equal(frame.hasAttribute('src'),false);
    assert.equal(requests.length,1);assert.equal(reads,1);assert.equal(builds,0);
    f.button('Show preview').click();await settle();assert.equal(frame.src,publicCapability.authorizeUrl);
    f.button('Open in new window').click();await settle();
    assert.equal(destination,publicCapability.authorizeUrl);assert.equal(popup.opener,null);
    assert.deepEqual(requests,[{runtimeProfile:'local_only'},{runtimeProfile:'public_maps_v1'},{runtimeProfile:'public_maps_v1'}]);
    savedSource.currentRevisionId='revision-7';savedSource.currentRevisionNumber=7;f.root.sourceDraftSaved();
    assert.equal(checkbox.checked,false);assert.equal(frame.hasAttribute('src'),false);
    assert.equal(requests.length,3);assert.equal(reads,1);assert.equal(builds,0);
  } finally {await f.close();}
});
test('changing preview sources discards a pending authorization',async()=>{
  let resolveCapability;
  const f=fixture(adapter({createObservablePreviewCapability:async()=>new Promise(resolve=>resolveCapability=resolve)}),
    {sourceProject:{...sourceProject,rightsStatus:'approved'}});
  try {
    await settle();const checkbox=f.root.querySelector('input[type=checkbox]');
    checkbox.checked=true;checkbox.dispatchEvent(new f.dom.window.Event('change'));
    f.button('Show preview').click();await settle();
    checkbox.checked=false;checkbox.dispatchEvent(new f.dom.window.Event('change'));
    resolveCapability(publicCapability);await settle();
    assert.equal(f.root.querySelector('iframe').hasAttribute('src'),false);
    assert.match(f.root.textContent,/Preview sources changed/);
  } finally {await f.close();}
});
test('the default preview rejects a public-source authorization without opt-in',async()=>{
  const f=fixture(adapter({createObservablePreviewCapability:async()=>publicCapability}));
  try {
    await settle();f.button('Show preview').click();await settle();
    assert.equal(f.root.querySelector('iframe').hasAttribute('src'),false);
    assert.match(f.root.textContent,/does not match the selected sources/);
  } finally {await f.close();}
});
test('reuses only an exact saved revision and never builds on mount or refresh',async()=>{
  let builds=0,grants=0;
  const f=fixture(adapter({createObservableBuildJob:async()=>{builds++;return job;},
    createObservablePreviewCapability:async()=>{grants++;return capability;}}));
  try {
    await settle(); assert.equal(builds,0); assert.equal(grants,0);
    f.button('Check saved preview').click(); await settle(); assert.equal(builds,0);
    f.button('Show preview').click(); await settle();
    assert.equal(grants,1); assert.equal(f.root.querySelector('iframe').src,capability.authorizeUrl);
    assert.equal(f.root.querySelector('iframe').getAttribute('sandbox'),'allow-scripts allow-same-origin');
    assert.equal(f.dom.window.location.href,'https://studio.opengeo.tools/');
  } finally {await f.close();}
});
test('does not silently show an older revision',async()=>{
  const f=fixture(adapter({listObservableBuildJobs:async()=>[{...job,sourceRevisionId:'older'}]}));
  try {await settle();assert.equal(f.button('Show preview').hidden,true);assert.match(f.root.textContent,/No completed preview/);}
  finally {await f.close();}
});
test('a saved draft resets an old preview locally and rejects its pending capability without requesting a build',async()=>{
  let resolveCapability, builds=0, reads=0;
  const f=fixture(adapter({listObservableBuildJobs:async()=>{reads++;return[job];},
    createObservableBuildJob:async()=>{builds++;return job;},
    createObservablePreviewCapability:async()=>new Promise(resolve=>{resolveCapability=resolve;})}));
  try {
    await settle();f.button('Show preview').click();await settle();
    sourceProject.currentRevisionId='revision-7';sourceProject.currentRevisionNumber=7;
    f.root.sourceDraftSaved();
    assert.equal(reads,1);assert.equal(builds,0);
    resolveCapability(capability);await settle();
    assert.equal(f.root.querySelector('iframe').hidden,true);
    assert.equal(f.root.querySelector('iframe').getAttribute('src'),null);
    assert.match(f.root.textContent,/Saved revision 7/);
    assert.equal(f.button('Show preview').hidden,true);
  } finally {
    sourceProject.currentRevisionId='revision';sourceProject.currentRevisionNumber=6;
    await f.close();
  }
});
test('lost build response retains request identity; checking is not a retry',async()=>{
  const requests=[];
  const f=fixture(adapter({listObservableBuildJobs:async()=>[],createObservableBuildJob:async(...args)=>{
    requests.push(args[3]); if(requests.length===1)throw Error('lost response'); return {...job,state:'pending'};
  }}));
  try {
    await settle(); f.button('Build saved revision').click(); await settle();
    assert.equal(requests.length,1);f.button('Check saved preview').click();await settle();assert.equal(requests.length,1);
    f.button('Retry same build request').click();await settle();
    assert.equal(requests[0].idempotencyKey,requests[1].idempotencyKey);
  } finally {await f.close();}
});
for (const code of ['github_build_connection_not_configured','github_build_connection_ambiguous']) test(`${code} directs the author to the deployment administrator without replaying a request`,async()=>{
  let requests=0;
  const f=fixture(adapter({listObservableBuildJobs:async()=>[],createObservableBuildJob:async()=>{
    requests++; throw Object.assign(Error('Conflict'),{code});
  }}));
  try {
    await settle(); f.button('Build saved revision').click(); await settle();
    assert.match(f.root.textContent,/Ask the deployment administrator to configure the build service/);
    assert.match(f.root.textContent,/Your private draft remains saved in OpenGeo/);
    assert.match(f.root.textContent,/No build was created/);
    assert.equal(requests,1);
    f.button('Check saved preview').click(); await settle();
    assert.equal(requests,1);
  } finally {await f.close();}
});
test('new-window preview severs opener and preserves the editor',async()=>{
  let destination,closed=false;
  const popup={opener:{},location:{replace:url=>destination=url},close:()=>closed=true};
  const f=fixture(adapter()); globalThis.open=()=>popup;
  try {
    await settle();f.button('Open in new window').click();await settle();
    assert.equal(popup.opener,null);assert.equal(destination,capability.authorizeUrl);assert.equal(closed,false);
    assert.equal(f.dom.window.location.href,'https://studio.opengeo.tools/');
  } finally {await f.close();}
});
test('blocked embedding offers a separate window instead of pretending to render',async()=>{
  const f=fixture(adapter());
  try {
    await settle();f.button('Show preview').click();await settle();
    const event=new f.dom.window.Event('securitypolicyviolation');
    Object.assign(event,{effectiveDirective:'frame-src',blockedURI:'https://preview.studio.opengeo.tools'});
    document.dispatchEvent(event);
    assert.equal(f.root.querySelector('iframe').hidden,true);
    assert.match(f.root.textContent,/currently blocks embedded previews/);
  } finally {await f.close();}
});

test('checks older history before rebuilding after a failed attempt',async()=>{
  const pages=[];let builds=0;
  const first=[{...job,id:'failed',state:'failed'},...Array.from({length:24},(_,i)=>({...job,id:`old-${i}`,sourceRevisionId:'older'}))];
  const f=fixture(adapter({listObservableBuildJobs:async(_project,_source,page)=>{
    pages.push(page.offset);return page.offset===0?first:[job];
  },createObservableBuildJob:async()=>{builds++;return job;}}));
  try {
    await settle();assert.equal(f.button('Build saved revision').disabled,true);
    assert.equal(f.button('Check older builds').hidden,false);
    f.button('Check older builds').click();await settle();
    assert.deepEqual(pages,[0,25]);assert.equal(builds,0);
    assert.equal(f.button('Show preview').hidden,false);
    assert.equal(f.button('Build saved revision').hidden,true);
  }finally{await f.close();}
});

test('failed history read neither enables building nor claims a submitted request',async()=>{
  const f=fixture(adapter({listObservableBuildJobs:async()=>{throw Error('history unavailable');},
    createObservableBuildJob:async()=>job}));
  try{
    await settle();assert.equal(f.button('Build saved revision').disabled,true);
    assert.equal(f.button('Retry same build request'),undefined);
  }finally{await f.close();}
});

test('explicit rebuild of a failed attempt preserves retry identity on response loss',async()=>{
  const requests=[];
  const f=fixture(adapter({listObservableBuildJobs:async()=>[{...job,state:'failed'}],
    createObservableBuildJob:async(...args)=>{
      requests.push(args[3]);if(requests.length===1)throw Error('lost response');return {...job,state:'pending'};
    }}));
  try{
    await settle();f.button('Build saved revision').click();await settle();
    // History may still show the preceding failure after a lost response.
    f.button('Check saved preview').click();await settle();
    f.button('Retry same build request').click();await settle();
    assert.equal(requests.length,2);assert.equal(requests[0].idempotencyKey,requests[1].idempotencyKey);
    assert.equal(f.button('Build saved revision').hidden,true);
  }finally{await f.close();}
});

test('closing the editor before authorization resolves never loads the abandoned frame',async()=>{
  let authorize;
  const f=fixture(adapter({createObservablePreviewCapability:()=>new Promise(resolve=>authorize=resolve)}));
  try{
    await settle();f.button('Show preview').click();await settle();
    f.root.remove();await settle();authorize(capability);await settle();
    assert.equal(f.root.querySelector('iframe').hasAttribute('src'),false);
  }finally{await f.close();}
});

test('Artifact selection is prepared explicitly and history matches its exact checksum',async()=>{
  let preparations=0, current='one'; const builds=[];
  const selected=()=>({...job,request:{artifactInputsChecksumSha256:current}});
  const f=fixture(adapter({readPublicationArtifactReferences:async()=>({revision:3,references:[{}]}),
    preparePublicationArtifactInputs:async()=>{preparations++;return {id:current,checksum:current};},
    listObservableBuildJobs:async()=>[{...job,request:{artifactInputsChecksumSha256:'older'}}, ...(current==='one'?[selected()]:[])],
    createObservableBuildJob:async(...args)=>{builds.push(args[3]);if(builds.length===1)throw Error('lost response');return {...selected(),state:'pending'};}}));
  try {
    await settle();assert.equal(preparations,0);assert.equal(f.button('Show preview').hidden,true);
    assert.equal(f.button('Build saved revision').disabled,true);
    f.button('Prepare current Artifact selection').click();await settle();
    assert.equal(preparations,1);assert.equal(f.button('Show preview').hidden,false);
    current='two';f.button('Prepare current Artifact selection').click();await settle();
    assert.equal(f.button('Show preview').hidden,true);assert.equal(f.button('Build saved revision').disabled,false);
    f.button('Build saved revision').click();await settle();
    assert.equal(f.button('Prepare current Artifact selection').disabled,true);
    current='three';f.button('Retry same build request').click();await settle();
    assert.equal(builds[0].artifactInputId,'two');assert.deepEqual(builds[0],builds[1]);assert.equal(preparations,2);
  } finally {await f.close();}
});

test('large saved output matches its profile and preserves the exact option on response loss', async () => {
  const requests = []; let largeJob = null;
  const f = fixture(adapter({listObservableBuildJobs: async () => largeJob ? [job, largeJob] : [job],
    createObservableBuildJob: async (...args) => {
      requests.push(args[3]);
      if (requests.length === 1) throw Error('response lost');
      largeJob = {...job, state: 'pending', request: {outputProfile: 'archive-96m'}}; return largeJob;
    }}));
  try {
    await settle(); assert.equal(f.button('Show preview').hidden, false);
    const profile = f.root.querySelector('[aria-label="Saved output size limit"]');
    profile.value = 'archive-96m'; profile.dispatchEvent(new f.dom.window.Event('change'));
    assert.equal(f.button('Show preview').hidden, true);
    f.button('Check saved preview').click(); await settle(); assert.equal(f.button('Build saved revision').disabled, true);
    const ack = f.root.querySelector('input[name="allow-up-to-96-mib-output"]');
    ack.checked = true; ack.dispatchEvent(new f.dom.window.Event('change'));
    assert.equal(f.button('Build saved revision').disabled, false);
    f.button('Build saved revision').click(); await settle(); assert.equal(requests.length, 1); assert.equal(profile.disabled, true);
    f.button('Check saved preview').click(); await settle(); assert.equal(requests.length, 1);
    f.button('Retry same build request').click(); await settle();
    assert.deepEqual(requests[0], requests[1]); assert.equal(requests[0].outputProfile, 'archive-96m');
    assert.equal(requests[0].sizeAcknowledgment, 'allow-up-to-96-mib-output');
  } finally {await f.close();}
});

test('single HTML saved preview keeps the legacy default request unchanged', async () => {
  const requests=[];
  const f=fixture(adapter({listObservableSourceRevisionsPage:async()=>[frameworkRevision],
    listObservableBuildJobs:async()=>[],createObservableBuildJob:async(...args)=>{
      requests.push(args[3]);return {...job,state:'pending'};
    }}));
  try {
    await settle(); const format=f.root.querySelector('[aria-label="Saved build format"]');
    assert.equal(format.value,'asset-tree');assert.equal(format.closest('label').hidden,false);
    assert.equal(requests.length,0);
    f.button('Build saved revision').click();await settle();
    assert.equal(requests.length,1);assert.equal(Object.hasOwn(requests[0],'outputRepresentation'),false);
    assert.equal(requests[0].purpose,'preview');assert.equal(format.disabled,true);
  } finally {await f.close();}
});

test('single HTML saved preview selects exact history without building on format changes', async () => {
  const metadata=[], previews=[];let builds=0;
  const native={...job,id:'native',request:{outputRepresentation:'single-html'}};
  const f=fixture(adapter({listObservableSourceRevisionsPage:async(...args)=>{metadata.push(args);return[frameworkRevision];},
    listObservableBuildJobs:async()=>[job,native],getObservableBuildJob:async()=>native,
    createObservableBuildJob:async()=>{builds++;return native;},
    createObservablePreviewCapability:async(_project,id)=>{previews.push(id);return capability;}}));
  try {
    await settle();assert.deepEqual(metadata,[['project','source',{limit:1,beforeRevision:7}]]);
    f.button('Show preview').click();await settle();assert.deepEqual(previews,['build']);
    const format=f.root.querySelector('[aria-label="Saved build format"]');
    format.value='single-html';format.dispatchEvent(new f.dom.window.Event('change'));
    assert.equal(builds,0);assert.equal(f.root.querySelector('iframe').hasAttribute('src'),false);
    assert.equal(f.button('Show preview').hidden,true);
    f.button('Check saved preview').click();await settle();
    f.button('Show preview').click();await settle();
    assert.deepEqual(previews,['build','native']);assert.equal(metadata.length,1);assert.equal(builds,0);
  } finally {await f.close();}
});

test('single HTML saved preview retains its format and key through busy and lost-response retries', async () => {
  const requests=[];let rejectRequest;
  const native={...job,state:'pending',request:{outputRepresentation:'single-html'}};
  const f=fixture(adapter({listObservableSourceRevisionsPage:async()=>[frameworkRevision],
    listObservableBuildJobs:async()=>[job],createObservableBuildJob:async(...args)=>{
      requests.push(args[3]);if(requests.length===1)return new Promise((_resolve,reject)=>rejectRequest=reject);
      return native;
    }}));
  try {
    await settle();const format=f.root.querySelector('[aria-label="Saved build format"]');
    format.value='single-html';format.dispatchEvent(new f.dom.window.Event('change'));
    f.button('Check saved preview').click();await settle();
    assert.equal(f.button('Show preview').hidden,true,'An asset-tree build cannot satisfy the selected format');
    f.button('Build saved revision').click();await settle();assert.equal(format.disabled,true);
    format.value='asset-tree';format.dispatchEvent(new f.dom.window.Event('change'));
    assert.equal(format.value,'single-html');rejectRequest(Error('response lost'));await settle();
    assert.equal(format.disabled,true);
    f.button('Check saved preview').click();await settle();assert.equal(requests.length,1);
    f.button('Retry same build request').click();await settle();
    assert.deepEqual(requests[0],requests[1]);assert.equal(requests[0].outputRepresentation,'single-html');
    assert.equal(format.disabled,true);assert.equal(f.button('Build saved revision').hidden,true);
  } finally {await f.close();}
});

test('single HTML saved preview rejects a created job with a different representation', async () => {
  const requests=[];
  const f=fixture(adapter({listObservableSourceRevisionsPage:async()=>[frameworkRevision],
    listObservableBuildJobs:async()=>[],createObservableBuildJob:async(...args)=>{requests.push(args[3]);return job;}}));
  try {
    await settle();const format=f.root.querySelector('[aria-label="Saved build format"]');
    format.value='single-html';format.dispatchEvent(new f.dom.window.Event('change'));
    f.button('Check saved preview').click();await settle();f.button('Build saved revision').click();await settle();
    assert.equal(requests[0].outputRepresentation,'single-html');
    assert.match(f.root.textContent,/does not match the saved source revision/);
    assert.equal(f.button('Show preview').hidden,true);assert.equal(format.disabled,true);
  } finally {await f.close();}
});

test('single HTML saved preview preserves the retained Artifact build path', async () => {
  const requests=[];let preparations=0;
  const f=fixture(adapter({listObservableSourceRevisionsPage:async()=>[frameworkRevision],
    readPublicationArtifactReferences:async()=>({revision:3,references:[{}]}),
    preparePublicationArtifactInputs:async()=>{preparations++;return{id:'inputs',checksum:'sealed'};},
    listObservableBuildJobs:async()=>[],createObservableBuildJob:async(...args)=>{
      requests.push(args[3]);return {...job,state:'pending',request:{artifactInputsChecksumSha256:'sealed'}};
    }}));
  try {
    await settle();const format=f.root.querySelector('[aria-label="Saved build format"]');
    assert.equal(format.querySelector('[value="single-html"]').disabled,true);
    format.value='single-html';format.dispatchEvent(new f.dom.window.Event('change'));
    assert.equal(format.value,'asset-tree');assert.equal(preparations,0);
    assert.equal(f.button('Prepare current Artifact selection').disabled,false);
    f.button('Prepare current Artifact selection').click();await settle();
    f.button('Build saved revision').click();await settle();
    assert.equal(preparations,1);assert.equal(requests.length,1);assert.equal(requests[0].artifactInputId,'inputs');
    assert.equal(Object.hasOwn(requests[0],'outputRepresentation'),false);
  } finally {await f.close();}
});

test('single HTML saved preview hides unknown and unsupported entries without blocking saved previews', async () => {
  for (const revision of [{...frameworkRevision,entryPath:'index.html'}, {...frameworkRevision,entryPath:'index.ipynb'},
    {...frameworkRevision,entryPath:'src/report.md'}, {...frameworkRevision,id:'older'},
    {...frameworkRevision,sourceProjectId:'other'}, {...frameworkRevision,revisionNumber:5}, null]) {
    let reads=0;
    const f=fixture(adapter({listObservableSourceRevisionsPage:async()=>{reads++;if(revision===null)throw Error('metadata unavailable');return[revision];}}));
    try {
      await settle();const format=f.root.querySelector('[aria-label="Saved build format"]');
      assert.equal(format.closest('label').hidden,true);assert.equal(f.button('Show preview').hidden,false);
      f.button('Check saved preview').click();await settle();assert.equal(reads,1);
    } finally {await f.close();}
  }
});

test('single HTML saved preview locks active builds and resets its selection on a source save', async () => {
  for (const state of ['pending','running']) {
    const saved={...sourceProject};let reads=0;
    const f=fixture(adapter({listObservableSourceRevisionsPage:async()=>{reads++;return[{...frameworkRevision,
      id:saved.currentRevisionId,revisionNumber:saved.currentRevisionNumber}];},
      listObservableBuildJobs:async()=>[{...job,state,request:{outputRepresentation:'single-html'}}]}),{sourceProject:saved});
    try {
      await settle();const format=f.root.querySelector('[aria-label="Saved build format"]');
      format.value='single-html';format.dispatchEvent(new f.dom.window.Event('change'));
      f.button('Check saved preview').click();await settle();assert.equal(format.disabled,true);
      saved.currentRevisionId='revision-7';saved.currentRevisionNumber=7;f.root.sourceDraftSaved();
      assert.equal(format.value,'asset-tree');assert.equal(format.closest('label').hidden,true);assert.equal(reads,1);
      f.button('Check saved preview').click();await settle();
      assert.equal(reads,2);assert.equal(format.value,'asset-tree');assert.equal(format.disabled,false);
    } finally {await f.close();}
  }
});

test('single HTML saved preview starts format metadata beside saved history', async () => {
  for (const withReferences of [false, true]) {
    let resolveMetadata, historyReads = 0, metadataReads = 0;
    const f = fixture(adapter({
      listObservableSourceRevisionsPage: () => {
        metadataReads++;
        return new Promise(resolve => {resolveMetadata = resolve;});
      },
      ...(withReferences ? {readPublicationArtifactReferences: async () => ({revision: 1, references: []})} : {}),
      listObservableBuildJobs: async () => {historyReads++; return [job];}
    }));
    try {
      await settle();
      assert.equal(metadataReads, 1);
      assert.equal(historyReads, 1, 'History starts while format-only metadata is pending');
      assert.equal(f.button('Show preview').disabled, true);
      resolveMetadata([frameworkRevision]); await settle();
      assert.equal(f.button('Show preview').disabled, false);
      const format = f.root.querySelector('[aria-label="Saved build format"]');
      assert.equal(format.closest('label').hidden, false);
      f.button('Check saved preview').click(); await settle();
      assert.equal(metadataReads, 1, 'Repeat checks reuse current-revision metadata');
    } finally {await f.close();}
  }
});

test('single HTML saved preview waits for stale metadata and history before accepting a new check', async () => {
  const saved = {...sourceProject};
  let resolveMetadata, resolveHistory, metadataReads = 0, historyReads = 0;
  const currentJob = {...job, id: 'new-build', sourceRevisionId: 'revision-7', sourceRevisionNumber: 7};
  const f = fixture(adapter({
    listObservableSourceRevisionsPage: () => {
      metadataReads++;
      return metadataReads === 1 ? new Promise(resolve => {resolveMetadata = resolve;})
        : Promise.resolve([{...frameworkRevision, id: 'revision-7', revisionNumber: 7}]);
    },
    listObservableBuildJobs: () => {
      historyReads++;
      return historyReads === 1 ? new Promise(resolve => {resolveHistory = resolve;})
        : Promise.resolve([currentJob]);
    }
  }), {sourceProject: saved});
  try {
    await settle();
    saved.currentRevisionId = 'revision-7'; saved.currentRevisionNumber = 7;
    f.root.sourceDraftSaved();
    resolveMetadata([frameworkRevision]); await settle();
    assert.equal(f.button('Check saved preview').disabled, true, 'Early stale metadata cannot release the pending history operation');
    f.button('Check saved preview').click(); await settle();
    assert.equal(historyReads, 1);
    resolveHistory([job]); await settle();
    assert.equal(f.button('Check saved preview').disabled, false);
    assert.equal(f.button('Show preview').hidden, true, 'The old response never becomes the new head preview');
    f.button('Check saved preview').click(); await settle();
    assert.equal(historyReads, 2); assert.equal(metadataReads, 2);
    assert.equal(f.button('Show preview').hidden, false);
    assert.match(f.root.textContent, /Saved revision 7 · succeeded/);
  } finally {await f.close();}
});
