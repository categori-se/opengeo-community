import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {CollectionDirectory} from '../src/components/CollectionDirectory.js';
import {OpenGeoApiClient} from '../src/lib/apiClient.js';
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const settle = async fn => {for(let i=0;i<60;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('UI did not settle');};
it('allows leaving clean Collection reads, ignores disposed results, and retains draft and write guards', async () => {
  const dom = new JSDOM('<body></body>', {url:'https://studio.example/workspaces?view=collections'});
  const previous = globalThis.document; globalThis.document = dom.window.document;
  const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
  const list = deferred(), opening = deferred(), owners = deferred(), members = deferred(), creation = deferred();
  const record = {id:id(1), title:'Saved Collection', description:'', revision:1, role:'owner', members:[]};
  const created = {...record, id:id(2), title:'New grouping'};
  let listStarted = false, openReads = 0, ownerStarted = false, memberStarted = false, writeStarted = false;
  const abandoned = CollectionDirectory({adapter:{kind:'api', listCollections:() => {listStarted = true; return list.promise;}}});
  document.body.append(abandoned);
  let root;
  const unload = () => {const event = new dom.window.Event('beforeunload', {cancelable:true}); dom.window.dispatchEvent(event); return event.defaultPrevented;};
  try {
    await settle(() => listStarted);
    assert.equal(abandoned.querySelector('fieldset').disabled, true);
    assert.equal(abandoned.shouldBlockNavigation(), false);
    assert.equal(unload(), false);
    const oldContent = abandoned.textContent, oldHref = dom.window.location.href;
    abandoned.dispose(); abandoned.remove();
    list.resolve([record]); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(abandoned.textContent, oldContent);
    assert.equal(abandoned.querySelector('.collection-card'), null);
    assert.equal(dom.window.location.href, oldHref);

    root = CollectionDirectory({adapter:{kind:'api', listCollections:async() => [record],
      getCollection:identity => ++openReads === 1 ? opening.promise : Promise.resolve(identity === created.id ? created : record),
      listCollectionOwnerCandidates:() => {ownerStarted = true; return owners.promise;},
      listCollectionCandidates:() => {memberStarted = true; return members.promise;},
      createCollection:() => {writeStarted = true; return creation.promise;}}});
    document.body.append(root);
    const click = label => {const button = [...root.querySelectorAll('button')].find(item => item.textContent === label); assert.ok(button, label); button.click();};
    await settle(() => root.querySelector('.collection-card') && !root.querySelector('fieldset').disabled);
    click('Load eligible owners'); await settle(() => ownerStarted);
    assert.equal(root.shouldBlockNavigation(), false); assert.equal(unload(), false);
    owners.resolve([]); await settle(() => !root.querySelector('fieldset').disabled);
    click('Saved Collection'); await settle(() => openReads === 1);
    assert.equal(root.shouldBlockNavigation(), false); assert.equal(unload(), false);
    opening.resolve(record); await settle(() => root.querySelector('[aria-label="Collection title"]'));
    const title = root.querySelector('[aria-label="Collection title"]');
    title.value = 'Unsaved grouping'; title.dispatchEvent(new dom.window.Event('input'));
    click('Browse members'); await settle(() => memberStarted);
    assert.equal(root.shouldBlockNavigation(), true); assert.equal(unload(), true);
    members.resolve([]); await settle(() => root.querySelector('[role=status]').textContent === '');
    assert.equal(root.hasUnsavedChanges(), true);
    click('Discard draft and reload'); await settle(() => !root.shouldBlockNavigation());
    root.querySelector('[aria-label="New Collection title"]').value = created.title;
    click('Create Collection'); await settle(() => writeStarted);
    assert.equal(root.hasUnsavedChanges(), false);
    assert.equal(root.shouldBlockNavigation(), true); assert.equal(unload(), true);
    creation.resolve({id:created.id}); await settle(() => root.querySelector('[role=status]').textContent.startsWith('Collection created.'));
    assert.equal(root.shouldBlockNavigation(), false); assert.equal(unload(), false);
  } finally {abandoned.dispose(); root?.dispose(); globalThis.document = previous; dom.window.close();}
});
it('preserves a conflicting draft and unavailable references while adding, ordering, saving and reopening', async () => {
  const dom = new JSDOM('<body></body>', {url:'https://studio.example/workspaces?view=collections'});
  const previous = globalThis.document; globalThis.document = dom.window.document;
  let record = {id:id(1), title:'Watershed', description:'', revision:1, role:'owner', members:[{entry_id:id(2), available:false}]};
  let conflict = true, submitted;
  const adapter = {kind:'api', listCollections:async()=>[record], getCollection:async()=>structuredClone(record),
    listCollectionCandidates:async kind=>kind==='project'?[{id:id(3),title:'Survey'}]:[{id:id(4),title:'Report'}],
    updateCollection:async(_, draft)=>{submitted=structuredClone(draft);if(conflict)throw Object.assign(Error(),{status:409});record={...structuredClone(draft),revision:2};}};
  const root = CollectionDirectory({adapter}); document.body.append(root);
  const click = label => {const button=[...root.querySelectorAll('button')].find(b=>b.textContent===label);assert.ok(button,label);button.click();};
  const status = ()=>root.querySelector('[role=status]').textContent;
  try {
    await settle(()=>root.textContent.includes('Watershed'));click('Watershed');
    await settle(()=>root.textContent.includes('Unavailable member'));
    click('Browse members');await settle(()=>root.textContent.includes('Survey'));click('Survey');
    const kind=root.querySelector('[aria-label="Member type"]');kind.value='publication';kind.dispatchEvent(new dom.window.Event('change'));
    click('Browse members');await settle(()=>root.textContent.includes('Report'));click('Report');
    assert.equal(root.querySelectorAll('ol li').length,3);click('Save Collection');
    await settle(()=>status().includes('draft is retained'));assert.equal(root.hasUnsavedChanges(),true);
    assert.equal(submitted.members[0].entry_id,id(2));assert.equal(submitted.members[0].target_id,undefined);
    conflict=false;click('Save Collection');await settle(()=>status()==='Collection saved.');
    assert.equal(root.hasUnsavedChanges(),false);assert.equal(root.querySelectorAll('ol a').length,2);
    root.querySelectorAll('ol li')[2].querySelector('button').click();
    click('Save Collection');await settle(()=>status()==='Collection saved.');
    assert.equal(record.members[1].kind,'publication');
    click('Discard draft and reload');await settle(()=>status()==='');
    assert.equal(root.querySelectorAll('ol li')[1].textContent.startsWith('Publication: Report'),true);
  } finally {root.dispose();globalThis.document=previous;dom.window.close();}
});
it('searches loaded candidate pages without changing saved members or issuing requests on input', async () => {
  const dom = new JSDOM('<body></body>', {url:'https://studio.example/workspaces?view=collections'});
  const previous = globalThis.document; globalThis.document = dom.window.document;
  const record = {id:id(1), title:'Ordered collection', description:'', revision:1, role:'owner', members:[
    {entry_id:id(2), available:false},
    {entry_id:id(3), available:true, kind:'project', target_id:id(4), title:'Existing'}]};
  const firstPage = Array.from({length:50}, (_, index) => ({id:id(index+10), title:`Study ${index+1}`}));
  const reads=[]; let saved;
  const adapter = {kind:'api', listCollections:async()=>[record], getCollection:async()=>structuredClone(record),
    listCollectionCandidates:async(kind, page)=>{reads.push({kind,...page});return kind==='publication'
      ? [{id:id(101), title:'Needle publication'}]
      : page.offset===0 ? firstPage : [{id:id(100), title:'Needle project'}];},
    updateCollection:async(_,draft)=>{saved=structuredClone(draft);}};
  const root=CollectionDirectory({adapter});document.body.append(root);
  const click=label=>{const target=[...root.querySelectorAll('button')].find(button=>button.textContent===label);assert.ok(target,label);target.click();};
  try {
    await settle(()=>root.textContent.includes('Ordered collection'));click('Ordered collection');
    await settle(()=>root.querySelector('[aria-label="Find loaded member candidates"]'));
    const query=root.querySelector('[aria-label="Find loaded member candidates"]');
    query.value='Needle';query.dispatchEvent(new dom.window.Event('input'));
    assert.equal(reads.length,0);assert.equal(root.hasUnsavedChanges(),false);
    click('Browse members');await settle(()=>reads.length===1&&root.textContent.includes('0 of 50 loaded candidates'));
    assert.equal(root.hasUnsavedChanges(),false);
    click('Browse members');await settle(()=>root.textContent.includes('Needle project'));
    assert.deepEqual(reads.map(({kind,offset})=>[kind,offset]),[['project',0],['project',50]]);
    assert.equal(root.hasUnsavedChanges(),false);
    click('Needle project');
    const kind=root.querySelector('[aria-label="Member type"]');kind.value='publication';kind.dispatchEvent(new dom.window.Event('change'));
    assert.match(root.textContent,/Browse members to load accessible candidates/);
    click('Browse members');await settle(()=>root.textContent.includes('Needle publication'));
    assert.deepEqual(reads.at(-1),{kind:'publication',limit:50,offset:0});
    click('Needle publication');click('Save Collection');await settle(()=>root.querySelector('[role=status]').textContent==='Collection saved.');
    assert.deepEqual(saved.members.map(member=>member.entry_id ?? member.target_id),[id(2),id(3),id(100),id(101)]);
  } finally {root.dispose();globalThis.document=previous;dom.window.close();}
});
it('serializes retained member identities without leaking resolved titles into writes',async()=>{
  const client=new OpenGeoApiClient({baseUrl:'https://example.invalid'});let call;
  client.request=async(path,options)=>{call={path,...options};return {id:id(1),revision:2};};
  await client.updateCollection(id(1),{revision:1,title:'Group',description:'',members:[{entry_id:id(2),available:false},{kind:'project',target_id:id(3),title:'Survey'}]});
  assert.deepEqual(call.body.members,[{entry_id:id(2)},{kind:'project',target_id:id(3)}]);
  assert.equal(call.body.expected_revision,1);
});
it('inspects, grants and revokes Collection access using the latest revision, and blocks sharing over a draft',async()=>{
  const dom = new JSDOM('<body></body>',{url:'https://studio.example/workspaces'});
  const previous=globalThis.document;globalThis.document=dom.window.document;
  const calls=[];let grants=[], revision=1;
  const adapter={kind:'api',listCollections:async()=>[{id:id(1),title:'Shared studies'}],
    getCollection:async()=>({id:id(1),title:'Shared studies',description:'',revision,role:'owner',members:[]}),
    listCollectionGrants:async()=>({revision,grants}),
    listOrganizationMembers:async()=>[{userId:id(4),displayName:'Researcher',email:'researcher@example.invalid'}],
    grantCollection:async(_,userId,body)=>{calls.push({userId,...body});assert.equal(body.revision,revision);revision++;
      grants=body.role?[{userId,role:body.role,displayName:'Researcher',email:'researcher@example.invalid'}]:[];return {id:id(1),revision};}};
  const root=CollectionDirectory({adapter});document.body.append(root);
  const click=label=>{const item=[...root.querySelectorAll('button')].find(b=>b.textContent===label);assert.ok(item,label);item.click();};
  const status=()=>root.querySelector('[role=status]').textContent;
  try{
    await settle(()=>root.textContent.includes('Shared studies'));click('Shared studies');
    await settle(()=>root.textContent.includes('Inspect sharing'));click('Load account members');
    await settle(()=>root.querySelector('[aria-label="Account member"]').options.length===2&&status()==='');
    root.querySelector('[aria-label="Account member"]').value=id(4);click('Apply Collection access');
    await settle(()=>calls.length===1&&status()==='');assert.equal(calls[0].role,'reader');
    click('Inspect sharing');await settle(()=>root.textContent.includes('Revoke Collection access')&&status()==='');
    click('Revoke Collection access');await settle(()=>calls.length===2&&status()==='');
    assert.equal(calls[1].revision,2);assert.equal(calls[1].role,null);
    const title=root.querySelector('[aria-label="Collection title"]');title.value='Draft title';title.dispatchEvent(new dom.window.Event('input'));
    click('Apply Collection access');assert.equal(calls.length,2);assert.match(status(),/Save or discard/);
  }finally{root.dispose();globalThis.document=previous;dom.window.close();}
});
it('accepts an empty optional description when listing and reopening a new Collection',async()=>{
 const client=new OpenGeoApiClient({baseUrl:'https://example.invalid'});
 const item={id:id(1),revision:1,title:'New collection',description:'',role:'owner',members:[]};
 client.request=async path=>path.includes('?')?[item]:item;
 assert.equal((await client.getCollection(id(1))).description,'');
 assert.equal((await client.listCollections({limit:50}))[0].description,'');
});
it('reopens a Collection URL directly without scanning the directory and warns before losing a draft',async()=>{
 const dom=new JSDOM('<body></body>',{url:`https://studio.example/workspaces?view=collections&collection=${id(1)}`});
 const previous=globalThis.document;globalThis.document=dom.window.document;let reads=0;
 const adapter={kind:'api',listCollections:async()=>{assert.fail('deep link should not scan directory');},getCollection:async identity=>{reads++;assert.equal(identity,id(1));return {id:identity,revision:1,title:'Linked collection',description:'',role:'owner',members:[]};}};
 const root=CollectionDirectory({adapter});document.body.append(root);
 try{
  await settle(()=>root.querySelector('h3'));
  assert.equal(reads,1);assert.equal(root.querySelector('a').href,dom.window.location.href);
  const input=root.querySelector('[aria-label="Collection title"]');input.value='Draft';input.dispatchEvent(new dom.window.Event('input'));
  const event=new dom.window.Event('beforeunload',{cancelable:true});dom.window.dispatchEvent(event);
  assert.equal(event.defaultPrevented,true);assert.equal(root.shouldBlockNavigation(),true);
  [...root.querySelectorAll('button')].find(b=>b.textContent==='Discard draft and reload').click();
  await settle(()=>reads===2&&!root.shouldBlockNavigation());
  const savedEvent=new dom.window.Event('beforeunload',{cancelable:true});dom.window.dispatchEvent(savedEvent);assert.equal(savedEvent.defaultPrevented,false);
 }finally{root.dispose();globalThis.document=previous;dom.window.close();}
});
it('applies account visibility with the current revision and reopens the saved scope',async()=>{
  const dom=new JSDOM('<body></body>',{url:'https://studio.example/workspaces'});
  const previous=globalThis.document;globalThis.document=dom.window.document;
  let record={id:id(1),title:'Studies',description:'',revision:1,role:'owner',visibility:'private',members:[]};
  const adapter={kind:'api',listCollections:async()=>[record],getCollection:async()=>structuredClone(record),
    setCollectionVisibility:async(_,body)=>{assert.equal(body.revision,1);assert.equal(body.visibility,'account');record={...record,visibility:body.visibility,revision:2};return {id:id(1),revision:2};}};
  const root=CollectionDirectory({adapter});document.body.append(root);
  const click=text=>[...root.querySelectorAll('button')].find(b=>b.textContent===text).click();
  try {
    await settle(()=>root.textContent.includes('Studies'));click('Studies');
    await settle(()=>root.querySelector('[aria-label="Collection visibility"]'));
    root.querySelector('[aria-label="Collection visibility"]').value='account';click('Apply visibility');
    await settle(()=>root.textContent.includes('Collection visibility saved.'));
    assert.equal(root.querySelector('[aria-label="Collection visibility"]').value,'account');
    assert.match(root.textContent,/Visible to account members/);
  } finally {root.dispose();globalThis.document=previous;dom.window.close();}
});
it('filters and sorts a complete member inventory without changing saved order or hidden references',async()=>{
 const dom=new JSDOM('<body></body>',{url:'https://studio.example/workspaces'}), previous=globalThis.document;
 globalThis.document=dom.window.document;
 const record={id:id(1),title:'Member browsing',description:'',revision:1,role:'owner',members:[
  {entry_id:id(2),available:false},
  {entry_id:id(3),available:true,kind:'project',target_id:id(5),title:'Zebra'},
  {entry_id:id(4),available:true,kind:'publication',target_id:id(6),title:'Alpha'}]};
 let saved;
 const root=CollectionDirectory({adapter:{kind:'api',listCollections:async()=>[record],getCollection:async()=>structuredClone(record),updateCollection:async(_,draft)=>{saved=structuredClone(draft);record.members=draft.members;}}});document.body.append(root);
 const click=label=>[...root.querySelectorAll('button')].find(button=>button.textContent===label).click();
 const change=(label,value)=>{const element=root.querySelector(`[aria-label="${label}"]`);element.value=value;element.dispatchEvent(new dom.window.Event(element.tagName==='INPUT'?'input':'change'));};
 try {
  await settle(()=>root.textContent.includes('Member browsing'));click('Member browsing');await settle(()=>root.querySelector('ol li'));
  change('Sort Collection members','title');
  assert.equal(root.querySelector('ol a').textContent,'Publication: Alpha');assert.equal(root.hasUnsavedChanges(),false);
  assert.equal(root.querySelector('ol button').disabled,true);
  change('Filter Collection member type','project');assert.equal(root.querySelectorAll('ol li').length,1);
  change('Find Collection members','missing');assert.equal(root.querySelectorAll('ol li').length,0);
  change('Find Collection members','zeb');click('Remove reference');
  click('Save Collection');await settle(()=>root.querySelector('[role=status]').textContent==='Collection saved.');
  assert.deepEqual(saved.members.map(member=>member.entry_id),[id(2),id(4)]);
  click('Reset member view');assert.equal(root.querySelectorAll('ol li').length,2);
 }finally{root.dispose();globalThis.document=previous;dom.window.close();}
});
it('loads member images deliberately by entry identity and preserves links after image failure',async()=>{
 const dom=new JSDOM('<body></body>',{url:'https://studio.example/workspaces'}),previous=globalThis.document;globalThis.document=dom.window.document;
 let reads=0;
 const record={id:id(1),title:'Preview members',description:'',revision:1,role:'reader',members:[
  {entry_id:id(2),available:true,kind:'project',target_id:id(5),title:'Repeated title'},
  {entry_id:id(3),available:true,kind:'project',target_id:id(6),title:'Repeated title'},
  {entry_id:id(4),available:false}]};
 const root=CollectionDirectory({adapter:{kind:'api',listCollections:async()=>[record],getCollection:async()=>structuredClone(record),collectionImagePreviews:async()=>{reads++;return [
  {entryId:id(3),title:'Repeated title',url:'https://studio.example/public/preview',license:'CC0',attribution:'Fixture'},
  {entryId:id(4),title:'Unavailable',url:'https://studio.example/must-not-load',license:'CC0',attribution:'Fixture'}];}}});document.body.append(root);
 try{
  await settle(()=>root.textContent.includes('Preview members'));
  [...root.querySelectorAll('button')].find(b=>b.textContent==='Preview members').click();await settle(()=>root.querySelector('ol li'));
  assert.equal(reads,0);assert.equal(root.querySelectorAll('ol img').length,0);
  [...root.querySelectorAll('button')].find(b=>b.textContent==='Load member previews').click();await settle(()=>root.querySelector('ol img'));
  const rows=root.querySelectorAll('ol li');assert.equal(rows[0].querySelector('img'),null);assert.ok(rows[1].querySelector('img'));assert.equal(rows[2].querySelector('img'),null);
  assert.match(rows[1].textContent,/Fixture · CC0/);assert.equal(root.hasUnsavedChanges(),false);
  const filter=root.querySelector('[aria-label="Find Collection members"]');filter.value='Repeated';filter.dispatchEvent(new dom.window.Event('input'));assert.equal(reads,1);assert.equal(root.querySelectorAll('ol img').length,1);
  root.querySelector('ol img').dispatchEvent(new dom.window.Event('error'));assert.equal(root.querySelectorAll('ol img').length,0);assert.equal(root.querySelectorAll('ol a').length,2);assert.equal(root.hasUnsavedChanges(),false);
  const retry=[...root.querySelectorAll('button')].find(b=>b.textContent==='Load member previews');assert.equal(retry.disabled,false);
  retry.click();await settle(()=>root.querySelector('ol img'));assert.equal(reads,2);assert.equal(root.querySelectorAll('ol img').length,1);

 }finally{root.dispose();globalThis.document=previous;dom.window.close();}
});
it('preserves validated entry identity in the preview API projection',async()=>{
 const client=new OpenGeoApiClient({tokenProvider:()=> 'fixture',organizationProvider:()=>id(1),fetchImplementation:async()=>new Response(JSON.stringify([{entry_id:id(2),title:'Preview',license:'CC0',attribution:'Fixture',preview_path:`/public/organizations/${id(1)}/artifact-releases/${id(3)}/preview`}]),{headers:{'content-type':'application/json'}})});
 const [preview]=await client.collectionImagePreviews(id(4));assert.equal(preview.entryId,id(2));
});
it('accepts exact Publication preview routes and rejects other asset URLs',async()=>{
 let previewPath=`/public/organizations/${id(1)}/projects/${id(3)}/site-editions/${id(4)}/previews/${id(5)}.png`;
 const client=new OpenGeoApiClient({tokenProvider:()=> 'fixture',organizationProvider:()=>id(1),fetchImplementation:async()=>new Response(JSON.stringify([{entry_id:id(2),title:'Publication',license:'CC0',attribution:'Map author',preview_path:previewPath}]),{headers:{'content-type':'application/json'}})});
 assert.match((await client.collectionImagePreviews(id(6)))[0].url,/\/previews\//);
 previewPath=previewPath.replace('/previews/','/assets/');
 await assert.rejects(client.collectionImagePreviews(id(6)));
});
it('retries failed previews without losing an unsaved Collection draft', async()=>{
 const dom=new JSDOM('<body></body>',{url:'https://studio.example/workspaces'}),previous=globalThis.document;globalThis.document=dom.window.document;
 let calls=0,fail=true;
 const record={id:id(1),title:'Retry collection',description:'',revision:1,role:'owner',members:[{entry_id:id(2),kind:'project',target_id:id(3),title:'Survey',available:true}]};
 const adapter={kind:'api',listCollections:async()=>[record],getCollection:async()=>structuredClone(record),collectionImagePreviews:async()=>{calls++;if(fail)throw Error('temporary');return [];}};
 const root=CollectionDirectory({adapter});document.body.append(root);
 const button=text=>[...root.querySelectorAll('button')].find(b=>b.textContent===text);
 try{
  await settle(()=>button('Load image previews'));
  button('Load image previews').click();await settle(()=>root.textContent.includes('Use Load image previews to retry'));
  assert.equal(button('Load image previews').disabled,false);assert.equal(calls,1);
  fail=false;button('Load image previews').click();await settle(()=>root.textContent.includes('No eligible image previews'));assert.equal(calls,2);
  button('Retry collection').click();await settle(()=>button('Load member previews'));
  const title=root.querySelector('[aria-label="Collection title"]');title.value='Unsaved title';title.dispatchEvent(new dom.window.Event('input'));
  fail=true;button('Load member previews').click();await settle(()=>root.textContent.includes('Use Load member previews to retry'));
  assert.equal(button('Load member previews').disabled,false);assert.equal(root.hasUnsavedChanges(),true);assert.equal(title.value,'Unsaved title');
  fail=false;button('Load member previews').click();await settle(()=>root.textContent.includes('No eligible image previews. Member links remain available.'));
  assert.equal(calls,4);assert.equal(title.value,'Unsaved title');assert.equal(root.hasUnsavedChanges(),true);assert.match(root.querySelector('ol').textContent,/Survey/);
 }finally{root.dispose();globalThis.document=previous;dom.window.close();}
});

it('creates a Team or Organization owned Collection through deliberate owner selection and fresh reopen', async()=>{
 const dom=new JSDOM('<body></body>',{url:'https://studio.example/workspaces?view=collections'}),previous=globalThis.document;
 globalThis.document=dom.window.document;let record=null;const calls=[];
 const adapter={kind:'api',listCollections:async()=>record?[record]:[],getCollection:async()=>structuredClone(record),
  listCollectionOwnerCandidates:async(kind,page)=>{calls.push({kind,...page});return [{principal_type:kind,principal_id:id(kind==='team'?4:5),name:kind==='team'?'Research team':'Agency account'}];},
  createCollection:async body=>{calls.push(body);record={id:id(1),revision:1,title:body.title,description:'',role:'owner',members:[],owner:body.owner,owner_user_id:null,owner_name:body.owner.principal_type==='team'?'Research team':'Agency account'};return {id:record.id,revision:1};}};
 const root=CollectionDirectory({adapter});document.body.append(root);
 const click=text=>{const button=[...root.querySelectorAll('button')].find(button=>button.textContent===text);assert.ok(button,text);button.click();};
 const change=(label,value)=>{const select=root.querySelector(`[aria-label="${label}"]`);select.value=value;select.dispatchEvent(new dom.window.Event('change'));};
 try{
  await settle(()=>root.textContent.includes('No Collections yet'));
  for(const type of ['team','organization']){
   change('Collection owner type',type);root.querySelector('[aria-label="New Collection title"]').value=`${type} work`;
   click('Create Collection');assert.equal(calls.filter(call=>call.title).length,type==='team'?0:1);
   click('Load eligible owners');await settle(()=>root.querySelector('[aria-label="Collection owner"]').options.length===2);
   root.querySelector('[aria-label="Collection owner"]').value=`${type}:${id(type==='team'?4:5)}`;
   click('Create Collection');await settle(()=>root.querySelector('h3')?.textContent===`${type} work`);
   assert.deepEqual(calls.at(-1).owner,{principal_type:type,principal_id:id(type==='team'?4:5)});
   assert.match(root.textContent,new RegExp(`Owner: ${type==='team'?'Team · Research team':'Organization · Agency account'}`));
  }
  assert.deepEqual(calls.filter(call=>call.kind).map(call=>call.offset),[0,0]);
 }finally{root.dispose();globalThis.document=previous;dom.window.close();}
});

it('keeps User-self creation usable when the connected legacy API has no owner candidate route', async()=>{
 const dom=new JSDOM('<body></body>',{url:'https://studio.example/workspaces'}),previous=globalThis.document;globalThis.document=dom.window.document;
 let submitted,record=null,reads=0;
 const root=CollectionDirectory({adapter:{kind:'api',listCollections:async()=>record?[record]:[],getCollection:async()=>record,
  listCollectionOwnerCandidates:async()=>{reads++;throw Object.assign(Error('legacy'),{status:404});},
  createCollection:async body=>{submitted=body;record={id:id(1),revision:1,title:body.title,description:'',role:'owner',members:[]};return {id:id(1),revision:1};}}});document.body.append(root);
 const click=text=>[...root.querySelectorAll('button')].find(button=>button.textContent===text).click();
 try{
  await settle(()=>root.textContent.includes('No Collections yet'));assert.equal(reads,0);
  click('Load eligible owners');await settle(()=>root.querySelector('[role=status]').textContent.includes('could not be completed'));
  root.querySelector('[aria-label="New Collection title"]').value='My grouping';click('Create Collection');
  await settle(()=>root.querySelector('h3')?.textContent==='My grouping');
  assert.deepEqual(submitted,{title:'My grouping'});assert.equal(root.querySelector('[aria-label="New owner"]'),null);
 }finally{root.dispose();globalThis.document=previous;dom.window.close();}
});

it('transfers ownership using the saved revision, retains conflicting drafts and reopens the actual new owner', async()=>{
 const dom=new JSDOM('<body></body>',{url:'https://studio.example/workspaces'}),previous=globalThis.document;globalThis.document=dom.window.document;
 let record={id:id(1),revision:2,title:'Saved grouping',description:'',role:'owner',visibility:'account',members:[{entry_id:id(2),available:false}],
  owner:{principal_type:'user',principal_id:id(3)},owner_name:'Creator'},conflict=true;const calls=[];
 const root=CollectionDirectory({adapter:{kind:'api',listCollections:async()=>[record],getCollection:async()=>structuredClone(record),
  listCollectionOwnerCandidates:async(kind,page)=>{assert.equal(page.collectionId,id(1));return [{principal_type:kind,principal_id:id(4),name:'Field team'}];},
  transferCollectionOwner:async(identity,body)=>{calls.push({identity,...body});if(conflict)throw Object.assign(Error(),{status:409});
   record={...record,revision:3,owner:body.owner,owner_user_id:null,owner_name:'Field team'};return {id:identity,revision:3};}}});document.body.append(root);
 const click=text=>{const button=[...root.querySelectorAll('button')].find(button=>button.textContent===text);assert.ok(button,text);button.click();};
 try{
  await settle(()=>root.textContent.includes('Saved grouping'));click('Saved grouping');await settle(()=>root.querySelector('[aria-label="New owner type"]'));
  const type=root.querySelector('[aria-label="New owner type"]');type.value='team';type.dispatchEvent(new dom.window.Event('change'));
  click('Load transfer owners');await settle(()=>root.querySelector('[aria-label="New owner"]').options.length===2);
  root.querySelector('[aria-label="New owner"]').value=`team:${id(4)}`;
  const title=root.querySelector('[aria-label="Collection title"]');title.value='Unsaved title';title.dispatchEvent(new dom.window.Event('input'));
  click('Transfer Collection ownership');assert.equal(calls.length,0);
  assert.equal(root.querySelector('[aria-label="New owner"]').closest('fieldset').disabled,true);
  assert.match(root.querySelector('[role=status]').textContent,/Unsaved Collection changes/);
  click('Discard draft and reload');await settle(()=>root.querySelector('[aria-label="Collection title"]').value==='Saved grouping');
  const nextType=root.querySelector('[aria-label="New owner type"]');nextType.value='team';nextType.dispatchEvent(new dom.window.Event('change'));
  click('Load transfer owners');await settle(()=>root.querySelector('[aria-label="New owner"]').options.length===2);
  root.querySelector('[aria-label="New owner"]').value=`team:${id(4)}`;click('Transfer Collection ownership');
  await settle(()=>calls.length===1&&root.querySelector('[role=status]').textContent.includes('draft is retained'));
  assert.equal(root.querySelector('h3').textContent,'Saved grouping');assert.equal(calls[0].expected_revision,2);
  conflict=false;
  const retryType=root.querySelector('[aria-label="New owner type"]');retryType.value='team';retryType.dispatchEvent(new dom.window.Event('change'));
  click('Load transfer owners');await settle(()=>root.querySelector('[aria-label="New owner"]').options.length===2);
  root.querySelector('[aria-label="New owner"]').value=`team:${id(4)}`;click('Transfer Collection ownership');
  await settle(()=>root.querySelector('[role=status]').textContent==='Collection ownership transferred.');
  assert.match(root.textContent,/Owner: Team · Field team/);assert.match(root.textContent,/Unavailable member/);
  assert.equal(record.visibility,'account');assert.equal(record.members[0].entry_id,id(2));assert.equal(calls[1].expected_revision,2);
 }finally{root.dispose();globalThis.document=previous;dom.window.close();}
});

it('rejects ownership selection from a changed sign-in and removes the old view after a successful transfer removes access', async()=>{
 const dom=new JSDOM('<body></body>',{url:'https://studio.example/workspaces'}),previous=globalThis.document;globalThis.document=dom.window.document;
 let token='original',transferred=false;const writes=[];
 const record={id:id(1),revision:1,title:'Private grouping',description:'',role:'owner',members:[],owner:{principal_type:'user',principal_id:id(3)},owner_name:'Original owner'};
 const root=CollectionDirectory({adapter:{kind:'api',baseUrl:'https://api.example/api',tokenProvider:()=>token,organizationProvider:()=>id(5),
  listCollections:async()=>transferred?[]:[record],getCollection:async()=>{if(transferred)throw Object.assign(Error(),{status:403});return structuredClone(record);},
  listCollectionOwnerCandidates:async()=>[{principal_type:'user',principal_id:id(4),name:'New owner'}],
  transferCollectionOwner:async(_,body)=>{writes.push(body);transferred=true;return {id:id(1),revision:2};}}});document.body.append(root);
 const click=text=>[...root.querySelectorAll('button')].find(button=>button.textContent===text).click();
 try{
  await settle(()=>root.textContent.includes('Private grouping'));click('Private grouping');await settle(()=>root.querySelector('[aria-label="New owner"]'));
  click('Load transfer owners');await settle(()=>root.querySelector('[aria-label="New owner"]').options.length===2);
  root.querySelector('[aria-label="New owner"]').value=`user:${id(4)}`;token='changed';click('Transfer Collection ownership');
  await settle(()=>root.querySelector('[role=status]').textContent.includes('sign-in, account'));assert.equal(writes.length,0);
  token='original';click('Transfer Collection ownership');await settle(()=>root.textContent.includes('no longer available to you'));
  assert.equal(writes.length,1);assert.equal(root.querySelector('h3'),null);assert.equal(root.textContent.includes('Original owner'),false);
 }finally{root.dispose();globalThis.document=previous;dom.window.close();}
});

it('keeps a former owner view hidden when sign-in or account changes during a committed transfer response', async()=>{
 for(const changed of ['token','account']){
  const dom=new JSDOM('<body></body>',{url:'https://studio.example/workspaces'}),previous=globalThis.document;globalThis.document=dom.window.document;
  let token='original',account=id(5),reads=0,writes=0,release;
  const held=new Promise(resolve=>{release=resolve;});
  const record={id:id(1),revision:1,title:'Private grouping',description:'Private owner body',role:'owner',members:[],
   owner:{principal_type:'user',principal_id:id(3)},owner_name:'Former owner'};
  const root=CollectionDirectory({adapter:{kind:'api',baseUrl:'https://api.example/api',tokenProvider:()=>token,organizationProvider:()=>account,
   listCollections:async()=>[record],getCollection:async()=>{reads++;return structuredClone(record);},
   listCollectionOwnerCandidates:async()=>[{principal_type:'user',principal_id:id(4),name:'New owner'}],
   transferCollectionOwner:async()=>{writes++;await held;return {id:id(1),revision:2};}}});document.body.append(root);
  const click=text=>[...root.querySelectorAll('button')].find(button=>button.textContent===text).click();
  try{
   await settle(()=>root.textContent.includes('Private grouping'));click('Private grouping');await settle(()=>root.querySelector('[aria-label="New owner"]'));
   click('Load transfer owners');await settle(()=>root.querySelector('[aria-label="New owner"]').options.length===2);
   root.querySelector('[aria-label="New owner"]').value=`user:${id(4)}`;click('Transfer Collection ownership');await settle(()=>writes===1);
   assert.equal(root.querySelector('h3'),null);assert.equal(root.textContent.includes('Former owner'),false);
   if(changed==='token')token='replacement';else account=id(6);
   release();await settle(()=>root.querySelector('[role=status]').textContent.includes('sign-in, account'));
   assert.equal(reads,1,changed);assert.equal(root.querySelector('h3'),null);assert.equal(root.textContent.includes('Private owner body'),false);
   assert.equal(root.querySelector('[aria-label="New owner"]'),null);
  }finally{release();root.dispose();globalThis.document=previous;dom.window.close();}
 }
});


it('offers a public Collection gallery example without loading member content', async()=>{
 const dom=new JSDOM('<body></body>',{url:'https://studio.example/workspaces?view=collections'}),prior=globalThis.document;
 globalThis.document=dom.window.document;
 const record={id:id(1),title:'Public studies',description:'Saved grouping',revision:2,role:'viewer',visibility:'public',members:[]};
 const privateRecord={...record,id:id(2),title:'Private studies',visibility:'private'};
 let lists=0,reads=0,urls=0;
 const adapter={kind:'api',listCollections:async()=>{lists++;return[record,privateRecord];},
  getCollection:async key=>{reads++;return key===record.id?record:privateRecord;},
  publicCollectionUrl:async key=>{urls++;return `/api/public/organizations/${id(3)}/collections/${key}/view`;}};
 const root=CollectionDirectory({adapter});document.body.append(root);
 const click=label=>{const button=[...root.querySelectorAll('button')].find(node=>node.textContent===label);assert.ok(button,label);button.click();};
 try{
  await settle(()=>root.querySelector('.collection-card')&&!root.querySelector('fieldset').disabled);
  assert.equal(root.querySelector('[aria-label="JavaScript gallery import for this Collection"]'),null);
  click('Public studies');await settle(()=>root.querySelector('[aria-label="JavaScript gallery import for this Collection"]'));
  const example=root.querySelector('[aria-label="JavaScript gallery import for this Collection"]');
  assert.equal(example.readOnly,true);assert.match(example.value,new RegExp(`https://studio.example/api/public/organizations/${id(3)}/collections/${id(1)}/module\\.mjs`));
  assert.match(example.value,/import \{createGallery\}/);assert.match(example.value,/gallery.dispose\(\)/);
  assert.match(root.textContent,/without loading their maps or images/);assert.match(root.textContent,/Each member keeps its own access/);
  assert.equal(root.querySelector('iframe,img'),null);assert.deepEqual([lists,reads,urls],[1,1,1]);
  click('Private studies');await settle(()=>root.querySelector('[aria-label="Collection title"]')?.value==='Private studies');
  assert.equal(root.querySelector('[aria-label="JavaScript gallery import for this Collection"]'),null);
  assert.deepEqual([lists,reads,urls],[1,2,1]);
 }finally{root.dispose();root.remove();globalThis.document=prior;dom.window.close();}
});
