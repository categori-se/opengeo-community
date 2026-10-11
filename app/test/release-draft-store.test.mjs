import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {openReleaseDraftStore} from '../src/lib/releaseDraftStore.js';
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
it('recovers exact intent only in its verified user/account/API/Artifact scope and expires it',async()=>{
 const dom=new JSDOM('',{url:'https://studio.example/'});let user=id(1),account=id(2);
 const adapter={baseUrl:'/api',getSession:async()=>({userId:user,memberships:[{organizationId:account}]}),organizationProvider:()=>account};
 const draft={creation_key:id(4),version_number:3,title:'Private draft',license:'CC0-1.0',attribution:'Team'};
 try{
  const store=await openReleaseDraftStore(adapter,dom.window,id(3));assert.equal(store.write(draft,true),true);
  assert.deepEqual((await openReleaseDraftStore(adapter,dom.window,id(3))).read().draft,draft);
  assert.equal((await openReleaseDraftStore(adapter,dom.window,id(9))).read(),null);
  user=id(5);assert.equal((await openReleaseDraftStore(adapter,dom.window,id(3))).read(),null);assert.equal(await store.verify(),false);
  user=id(1);account=id(6);assert.equal((await openReleaseDraftStore(adapter,dom.window,id(3))).read(),null);
  account=id(2);adapter.baseUrl='/other-api';assert.equal((await openReleaseDraftStore(adapter,dom.window,id(3))).read(),null);
  adapter.baseUrl='/api';const key=dom.window.sessionStorage.key(0);const expired=JSON.parse(dom.window.sessionStorage.getItem(key));expired.expiresAt=0;dom.window.sessionStorage.setItem(key,JSON.stringify(expired));
  assert.equal(store.read(),null);assert.equal(dom.window.sessionStorage.length,0);
  store.write(draft,false);store.clear();assert.equal(store.read(),null);
 }finally{dom.window.close();}
});
it('bounds stored drafts and falls back without erasing another draft when storage fills',async()=>{
 const dom=new JSDOM('',{url:'https://studio.example/'});
 const adapter={baseUrl:'/api',organizationProvider:()=>id(2),getSession:async()=>({userId:id(1),memberships:[{organizationId:id(2)}]})};
 const draft={creation_key:id(4),version_number:1,title:'Draft',license:'',attribution:''};
 try{
  for(let n=10;n<26;n++)assert.equal((await openReleaseDraftStore(adapter,dom.window,id(n))).write(draft,false),true);
  assert.equal((await openReleaseDraftStore(adapter,dom.window,id(26))).write(draft,false),false);
  assert.equal(dom.window.sessionStorage.length,16);
  const store=await openReleaseDraftStore(adapter,dom.window,id(10));assert.equal(store.read().draft.title,'Draft');
  dom.window.Storage.prototype.setItem=()=>{throw Error('quota');};assert.equal(store.write(draft,true),false);
 }finally{dom.window.close();}
});
