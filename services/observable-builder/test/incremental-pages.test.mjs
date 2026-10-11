import assert from 'node:assert/strict';
import {test} from 'node:test';
import {incrementalPageRenderer, installIncrementalPageHook} from '../src/incremental-pages.mjs';

const options = (aliases = {}, info = {}) => ({path:'/index', title:'Site', preview:false,
  resolvers:Object.fromEntries(['resolveFile','resolveImport','resolveStylesheet','resolveScript','resolveLink']
    .map(name=>[name, value=>aliases[value]??`${name}:${value}`])),
  loaders:{getOutputInfo:()=>info}});
test('reuses unchanged pages and invalidates only observed dependencies', async()=>{
  const renderer=incrementalPageRenderer({scope:'project:compiler',renderPage:async(page,o)=>
    `<p>${page.body}:${o.resolvers.resolveImport(page.module)}</p>`});
  const a={body:'A',module:'a.js'}, b={body:'B',module:'b.js'};
  await renderer.render(a,options());await renderer.render(b,options());
  await renderer.render(a,options());await renderer.render(b,options());
  assert.deepEqual(renderer.stats,{rendered:2,reused:2});
  assert.match(await renderer.render(a,options({'a.js':'a.new.js'})),/a.new.js/);
  await renderer.render(b,options({'a.js':'a.new.js'}));
  assert.deepEqual(renderer.stats,{rendered:3,reused:3});
});
test('page, site navigation, stylesheet and attachment metadata changes invalidate', async()=>{
  const renderer=incrementalPageRenderer({scope:'project:compiler',renderPage:async(page,o)=>JSON.stringify([
    page,o.title,o.pages,o.resolvers.resolveStylesheet('theme.css'),o.loaders.getOutputInfo('rows.json')])});
  const page={body:'A'};
  await renderer.render(page,options());
  await renderer.render({...page,body:'Changed'},options());
  await renderer.render(page,{...options(),title:'Renamed'});
  await renderer.render(page,{...options(),pages:[{name:'New page',path:'/new'}]});
  await renderer.render(page,options({'theme.css':'theme.new.css'}));
  await renderer.render(page,options({}, {size:20,mtimeMs:123}));
  assert.equal(renderer.stats.rendered,6);assert.equal(renderer.stats.reused,0);
});
test('exact-file link normalization invalidates a cached extensionless page',async()=>{
  const renderPage=async(page,o)=>`<a href="${o.resolvers.resolveLink('/methods')}">${page.body}</a>`;
  const first=incrementalPageRenderer({scope:'project:compiler',renderPage});
  await first.render({body:'Methods'},options({'/methods':'./methods'}));
  const snapshot=first.snapshot();
  const next=incrementalPageRenderer({scope:'project:compiler',renderPage});
  assert.equal(next.restore(snapshot.body,snapshot.checksumSha256),true);
  assert.equal(await next.render({body:'Methods'},options({'/methods':'./methods.html'})),
    '<a href="./methods.html">Methods</a>');
  assert.deepEqual(next.stats,{rendered:1,reused:0});
});
test('failed renders are never cached and cache memory is bounded',async()=>{
  let fail=true;
  const renderer=incrementalPageRenderer({scope:'project:compiler',maximumEntries:1,renderPage:async page=>{
    if(fail)throw Error('failed');return page.body;
  }});
  await assert.rejects(renderer.render({body:'A'},options()),/failed/);fail=false;
  await renderer.render({body:'A'},options());await renderer.render({body:'B'},options());await renderer.render({body:'A'},options());
  assert.deepEqual(renderer.stats,{rendered:3,reused:0});
  renderer.clear();await renderer.render({body:'A'},options());assert.equal(renderer.stats.rendered,4);
});
test('fingerprints preserve value types and reject live previews',async()=>{
  const renderer=incrementalPageRenderer({scope:'project:compiler',renderPage:async page=>String(page.value)});
  for(const value of [undefined,{$undefined:true},new Set([1]),{$set:[1]},1n,'1'])await renderer.render({value},options());
  assert.equal(renderer.stats.rendered,6);
  await assert.rejects(renderer.render({}, {...options(),preview:true}),/Live reactive/);
  assert.throws(()=>installIncrementalPageHook(new URL('https://example.org/build.js')),/pinned/);
});

test('restores only a bounded, checksum-verified snapshot from the same scope',async()=>{
  const renderPage=async(page,o)=>page.body+o.resolvers.resolveImport('a.js');
  const first=incrementalPageRenderer({scope:'project:compiler',renderPage});
  await first.render({body:'A'},options());
  const snapshot=first.snapshot();
  const next=incrementalPageRenderer({scope:'project:compiler',renderPage});
  assert.equal(next.restore(snapshot.body,snapshot.checksumSha256),true);
  assert.equal(await next.render({body:'A'},options()),'AresolveImport:a.js');
  assert.deepEqual(next.stats,{rendered:0,reused:1});
  assert.equal(next.restore(snapshot.body,'0'.repeat(64)),false);
  assert.equal(next.restore(Buffer.from('broken'),snapshot.checksumSha256),false);
  const other=incrementalPageRenderer({scope:'other-project:compiler',renderPage});
  assert.equal(other.restore(snapshot.body,snapshot.checksumSha256),false);
  const smaller=incrementalPageRenderer({scope:'project:compiler',renderPage,maximumBytes:1});
  assert.equal(smaller.restore(snapshot.body,snapshot.checksumSha256),false);
});
