import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {ArtifactReleases} from '../src/components/ArtifactReleases.js';
import {OpenGeoApiClient} from '../src/lib/apiClient.js';
it('retains the API network requirement so live editions cannot be offered as offline downloads', async () => {
 const id='11111111-1111-4111-8111-111111111111';let requirement=true;
 const adapter=new OpenGeoApiClient({baseUrl:'https://api.example.test',tokenProvider:()=> 'fixture',
  organizationProvider:()=>id,fetchImplementation:async()=>new Response(JSON.stringify({
   can_publish:false,has_more:false,records:[{id,representation:'portable-map-html',network_required:requirement,
    version_number:1,title:'NOAA',license:'CC-BY-4.0',attribution:'NOAA',created_at:'2026-10-06T00:00:00Z',revoked_at:null}]}),
   {status:200,headers:{'content-type':'application/json'}})});
 assert.equal((await adapter.listArtifactReleases(id)).records[0].network_required,true);
 requirement='true';await assert.rejects(adapter.listArtifactReleases(id),/network requirement/);
});
it('keeps confirmed mutations distinct from failed history refreshes', async () => {
 const dom=new JSDOM('<main></main>',{url:'https://studio.example/workspaces'}), prior=globalThis.document;
 globalThis.document=dom.window.document;
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
 let fail=false,published=0,revoked=0;
 const release={id:'release-1',title:'Image',version_number:1,license:'CC0-1.0'};
 const adapter={
  listArtifactReleases:async()=>{if(fail)throw Error('History unavailable');return {can_publish:true,has_more:false,records:published?[{...release,revoked_at:revoked?'now':null}]:[]};},
  publicArtifactReleaseUrl:async()=> 'https://public.example/image',
  createArtifactRelease:async()=>{published++;fail=true;return release;},
  revokeArtifactRelease:async()=>{revoked++;fail=true;}
 };
 const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setTimeout(resolve,0));};
 try{
  const root=ArtifactReleases({adapter});document.querySelector('main').append(root);root.setTarget({id:'artifact-1',version_number:1});
  const button=text=>[...root.querySelectorAll('button')].find(node=>node.textContent===text);
  button('Load public releases').click();await settle();button('Publish inspected edition').click();await settle();
  for(const [label,value] of [['Release title','Image'],['Output attribution','Author'],['Output license','CC0-1.0']])root.querySelector(`[aria-label="${label}"]`).value=value;
  root.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await settle();
  assert.equal(published,1);assert.equal(root.querySelector('dialog').open,false);
  assert.match(root.textContent,/Public release created: release-1\. Release history could not refresh/);
  button('Load public releases').click();await settle();assert.equal(published,1);
  fail=false;button('Load public releases').click();await settle();assert.ok(root.querySelector('a'));
  const embed=root.querySelector('textarea[readonly]'); assert.ok(embed);
  assert.match(embed.value,/src="https:\/\/public.example\/image"/);
  assert.equal(root.querySelector('iframe'),null); // Showing embed code never loads public data.
  button('Revoke public release').click();await settle();
  assert.equal(revoked,1);assert.equal(root.querySelector('a'),null);assert.equal(button('Revoke public release'),undefined);assert.equal(root.querySelector('details'),null);
  assert.match(root.textContent,/Public release revoked\. Release history could not refresh/);
  fail=false;button('Load public releases').click();await settle();assert.equal(revoked,1);assert.match(root.querySelector('li').textContent,/Revoked/);
  root.remove();await settle();
 }finally{globalThis.document=prior;dom.window.close();}
});
it('offers notebook imports and exact offline downloads only for portable releases without opening them', async () => {
 const dom=new JSDOM('<main></main>',{url:'https://studio.example/workspaces'}), prior=globalThis.document;
 globalThis.document=dom.window.document;
 try {
  const view='https://api.example/public/organizations/account/artifact-releases/release/view';
  let requests=0;
  const adapter={listArtifactReleases:async()=>{requests++;return {can_publish:false,has_more:false,records:[
   {id:'release',title:'Survey',version_number:1,license:'CC0-1.0',revoked_at:null,representation:'portable-map-html'},
   {id:'image',title:'Image',version_number:2,license:'CC0-1.0',revoked_at:null,representation:'saved-map-image'},
   {id:'live',title:'Live NOAA',version_number:1,license:'CC-BY-4.0',revoked_at:null,
    representation:'portable-map-html',network_required:true}]};},
   publicArtifactReleaseUrl:async()=>view};
  const root=ArtifactReleases({adapter});document.querySelector('main').append(root);root.setTarget({id:'artifact',version_number:1});
  [...root.querySelectorAll('button')].find(node=>node.textContent==='Load public releases').click();
  for(let i=0;i<5;i++)await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(requests,1);assert.equal(root.querySelector('iframe'),null);
  const example=root.querySelector('[aria-label="JavaScript import for Survey"]');
  assert.match(example.value,/import \{createView\} from "https:\/\/studio.example\/api\/public\/organizations\/account\/artifact-releases\/release\/module.mjs"/);
  assert.match(example.value,/invalidation/);
  const links=[...root.querySelectorAll('a')];
  assert.equal(links.filter(link=>link.textContent==='Open static viewer').length,2);
  assert.equal(links.find(link=>link.textContent==='Open static viewer').href,view.replace(/\/view$/, '/static'));
  assert.match(root.textContent,/S3 delivery; issued links expire within 15 minutes/);
  assert.equal(links.filter(link=>link.textContent==='Download offline HTML').length,1);
  assert.equal(links.filter(link=>link.textContent==='Download live HTML').length,1);
  assert.match(root.textContent,/requires an internet connection/);
  assert.match(root.textContent,/does not automatically read captured backups/);
  assert.equal(links.find(link=>link.textContent==='Download JavaScript module').href,'https://studio.example/api/public/organizations/account/artifact-releases/release/module.mjs?download=true');
  assert.match(root.textContent,/downloaded copies remain available/);
  root.remove();
 } finally {globalThis.document=prior;dom.window.close();}
});

function passwordShareFixture(overrides={}) {
 const dom=new JSDOM('<main></main>',{url:'https://studio.example/workspaces'}),prior=globalThis.document;
 globalThis.document=dom.window.document;
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
 const record={id:'share-1',artifact_id:'artifact-1',version_number:2,title:'Compiled field map',created_at:'2026-10-07T00:00:00Z',revoked_at:null};
 const adapter={
  listArtifactReleases:async()=>({can_publish:true,records:[],has_more:false}),
  listArtifactShares:async()=>({can_publish:true,records:[],has_more:false}),
  createArtifactShare:async()=>({id:record.id}),revokeArtifactShare:async()=>({id:record.id,revoked:true}),
  protectedArtifactShareUrl:async()=> 'https://api.example/shared/organizations/account/artifact-shares/share-1/view',...overrides
 };
 const root=ArtifactReleases({adapter});document.querySelector('main').append(root);
 root.setTarget({id:'artifact-1',version_number:2,manifest:{representation:'portable-map-html'}});
 const button=text=>[...root.querySelectorAll('button')].find(node=>node.textContent===text);
 const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setTimeout(resolve,0));};
 const shareDialog=root.querySelector('.artifact-password-share-draft'),form=shareDialog.querySelector('form');
 return {dom,root,record,adapter,button,settle,shareDialog,form,
  async open(){button('Load public releases').click();await settle();button('Share with a password').click();await settle();},
  fill(password='a literal share password'){root.querySelector('[aria-label="Share title"]').value='Compiled field map';root.querySelector('[aria-label="Share password"]').value=password;},
  submit(){form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));},
  close(){root.remove();globalThis.document=prior;dom.window.close();}
 };
}

it('keeps password-share retries frozen and transient, clearing secrets after confirmed creation even if history fails',async()=>{
 const drafts=[];let failHistory=false;
 const fixture=passwordShareFixture({
  listArtifactReleases:async()=>{if(failHistory)throw Error('history failed');return {can_publish:true,records:[],has_more:false};},
  createArtifactShare:async(id,draft)=>{drafts.push({id,draft});if(drafts.length===1)throw Error('lost response a literal share password');failHistory=true;return {id:'share-1'};}
 });
 try{
  await fixture.open();fixture.fill();fixture.submit();await fixture.settle();
  assert.equal(drafts.length,1);assert.equal(drafts[0].id,'artifact-1');assert.equal(drafts[0].draft.version_number,2);
  assert.match(drafts[0].draft.creation_key,/^[0-9a-f-]{36}$/);assert.equal(Object.isFrozen(drafts[0].draft),true);
  assert.equal(fixture.root.querySelector('[aria-label="Share password"]').disabled,true);
  assert.ok(fixture.button('Retry password share'));assert.doesNotMatch(fixture.root.textContent,/a literal share password/);
  fixture.root.querySelector('[aria-label="Share title"]').value='Unreviewed title';
  fixture.root.querySelector('[aria-label="Share password"]').value='unreviewed other password';
  fixture.submit();await fixture.settle();
  assert.equal(drafts.length,2);assert.deepEqual(drafts[1],drafts[0]);
  assert.equal(fixture.shareDialog.open,false);assert.equal(fixture.root.querySelector('[aria-label="Share password"]').value,'');
  assert.match(fixture.root.textContent,/Password share created: share-1\. Release history could not refresh/);
  assert.equal(fixture.dom.window.sessionStorage.length,0);assert.equal(fixture.dom.window.localStorage.length,0);
 }finally{fixture.close();}
});

it('limits password shares to inspected portable editions and shows only links and revocation in share history',async()=>{
 let revoked=0;const fixture=passwordShareFixture({
  listArtifactShares:async()=>({can_publish:true,has_more:false,records:[{id:'share-1',artifact_id:'artifact-1',version_number:2,title:'Compiled field map',created_at:'now',revoked_at:revoked?'now':null}]}),
  revokeArtifactShare:async()=>{revoked++;return {id:'share-1',revoked:true};}
 });
 try{
  fixture.root.setTarget({id:'artifact-1',version_number:2,manifest:{representation:'saved-map-image'}});
  assert.equal(fixture.button('Share with a password').hidden,true);
  fixture.root.setTarget({id:'artifact-1',version_number:2,manifest:{representation:'portable-map-html'}});
  fixture.button('Load public releases').click();await fixture.settle();
  assert.equal(fixture.button('Share with a password').disabled,false);
  const history=fixture.root.querySelector('.artifact-password-shares');
  assert.equal(history.querySelectorAll('a').length,1);assert.equal(history.querySelector('iframe,details,textarea'),null);
  assert.match(history.textContent,/up to five access attempts/);assert.match(history.textContent,/up to 15 minutes/);
  fixture.button('Revoke password share').click();await fixture.settle();
  assert.equal(revoked,1);assert.equal(history.querySelector('a'),null);assert.match(history.textContent,/Revoked/);
  assert.match(fixture.root.textContent,/Password share revoked/);
 }finally{fixture.close();}
});

it('clears password drafts on discard, target replacement, removal and a changed account before an uncertain retry',async()=>{
 let account='account-a',writes=0;
 const fixture=passwordShareFixture({tokenProvider:()=> 'fixture',organizationProvider:()=>account,baseUrl:'https://api.example',
  assertCollectionContext:async context=>{if(context.organization!==account)throw Object.assign(Error('changed'),{code:'collection_context_changed'});},
  createArtifactShare:async()=>{writes++;throw Error('lost response');}
 });
 try{
  await fixture.open();fixture.fill();fixture.button('Discard password share').click();
  assert.equal(fixture.root.querySelector('[aria-label="Share password"]').value,'');assert.equal(fixture.shareDialog.open,false);
  fixture.button('Share with a password').click();await fixture.settle();fixture.fill();
  fixture.root.setTarget({id:'artifact-2',version_number:1,manifest:{representation:'portable-map-html'}});
  assert.equal(fixture.root.querySelector('[aria-label="Share password"]').value,'');assert.equal(fixture.shareDialog.open,false);
  fixture.root.setTarget({id:'artifact-1',version_number:2,manifest:{representation:'portable-map-html'}});
  await fixture.open();fixture.fill();fixture.submit();await fixture.settle();assert.equal(writes,1);
  account='account-b';fixture.submit();await fixture.settle();
  assert.equal(writes,1);assert.equal(fixture.root.querySelector('[aria-label="Share password"]').value,'');assert.equal(fixture.shareDialog.open,false);
  assert.match(fixture.root.textContent,/password draft was cleared/);
  account='account-a';await fixture.open();fixture.fill();fixture.root.remove();await fixture.settle();
  assert.equal(fixture.root.querySelector('[aria-label="Share password"]').value,'');
  assert.equal(fixture.dom.window.sessionStorage.length,0);
 }finally{fixture.close();}
});


it('offers a native website example without loading the release or its descriptor', async () => {
 const dom=new JSDOM('<main></main>',{url:'https://studio.example/workspaces'}), prior=globalThis.document;
 globalThis.document=dom.window.document;
 try {
  let lists=0,links=0;
  const adapter={listArtifactReleases:async()=>{lists++;return{can_publish:false,has_more:false,records:[
   {id:'release',title:'Survey',version_number:1,license:'CC0',revoked_at:null,representation:'portable-map-html'},
   {id:'image',title:'Image',version_number:1,license:'CC0',revoked_at:null,representation:'saved-map-image'},
   {id:'old',title:'Revoked',version_number:1,license:'CC0',revoked_at:'2026-10-15',representation:'portable-map-html'}]};},
   publicArtifactReleaseUrl:async id=>{links++;return `https://api.example/public/organizations/account/artifact-releases/${id}/view`;}};
  const root=ArtifactReleases({adapter});document.querySelector('main').append(root);root.setTarget({id:'artifact',version_number:1});
  assert.equal(lists,0);assert.equal(root.querySelector('textarea[aria-label^="Native map import"]'),null);
  [...root.querySelectorAll('button')].find(node=>node.textContent==='Load public releases').click();
  for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(lists,1);assert.equal(links,2);assert.equal(root.querySelector('iframe'),null);
  assert.equal(root.querySelectorAll('textarea[aria-label^="Native map import"]').length,1);
  const example=root.querySelector('[aria-label="Native map import for Survey"]');
  assert.equal(example.readOnly,true);assert.match(example.value,/module\.mjs\?mode=native/);
  assert.match(example.value,/createView\(\{maplibre, height: 600, signal: lifetime.signal\}\)/);
  assert.match(example.value,/selectionchange/);assert.match(example.value,/lifetime.abort\(\)/);assert.match(example.value,/view.dispose\(\)/);
  assert.match(root.textContent,/MapLibre runtime and CSS/);assert.match(root.textContent,/Native Notebook HTML and PMTiles are not currently supported/);
  assert.equal([...root.querySelectorAll('a')].find(link=>link.textContent==='Open release descriptor').href,
   'https://studio.example/api/public/organizations/account/artifact-releases/release/descriptor');
  assert.match(root.querySelector('[aria-label="JavaScript import for Survey"]').value,
   /module\.mjs";\n\ndisplay\(createView\(\{height: 600, invalidation\}\)\);/);
  root.remove();
 }finally{globalThis.document=prior;dom.window.close();}
});
