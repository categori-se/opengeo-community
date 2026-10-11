import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {LocationDirectory} from '../src/components/LocationDirectory.js';
const id='10000000-0000-4000-8000-000000000001';
it('retains draft, geometry and knowledge while inspecting history and rejecting a stale save',async()=>{
 const dom=new JSDOM('<body></body>',{url:`https://studio.example/workspaces?view=locations&location=${id}`});
 const previous=globalThis.document;globalThis.document=dom.window.document;
 const knowledge={schemaVersion:'1.0.0',distributions:[],metadata:{source:[{rawText:'  retained source\n'}],normalized:[],curated:[],inferred:[]},context:[]};
 const record={id,revision:2,currentRevision:2,document:{title:'Place',canonical_uri:null,aliases:['Name\nvariant'],identifiers:[],geometry:null,knowledge}};
 let submitted, conflict=true;
 const root=LocationDirectory({adapter:{kind:'api',listLocations:async()=>[],getLocation:async(_,version)=>({...structuredClone(record),revision:version??2}),saveLocation:async document=>{submitted=document;if(conflict)throw Object.assign(Error(),{status:409});return{id,revision:3};}}});document.body.append(root);
 const wait=async f=>{for(let i=0;i<60;i++){if(f())return;await new Promise(r=>setTimeout(r,5));}assert.fail('not settled');};
 const click=label=>[...root.querySelectorAll('button')].find(b=>b.textContent===label).click();
 try{
  await wait(()=>root.querySelector('h3'));
  const name=root.querySelector('[aria-label="Geographic tag name"]');name.value='Draft place';name.dispatchEvent(new dom.window.Event('input'));
  root.querySelector('[aria-label="Historical revision"]').value='1';click('Inspect revision');
  await wait(()=>root.textContent.includes('Historical revision 1'));assert.equal(name.value,'Draft place');
  click('Save Geographic tag');await wait(()=>root.querySelector('[role=status]').textContent.includes('Geographic tag changed'));
  assert.equal(root.hasUnsavedChanges(),true);assert.equal(name.value,'Draft place');
  assert.deepEqual(submitted.knowledge,knowledge);assert.deepEqual(submitted.aliases,['Name\nvariant']);assert.equal(submitted.geometry,null);
  click('Discard draft and reload');await wait(()=>!root.shouldBlockNavigation());assert.equal(root.querySelector('[aria-label="Geographic tag name"]').value,'Place');
 }finally{root.dispose();globalThis.document=previous;dom.window.close();}
});

it('opens compact saved identity, local boundary and related layers once, with guarded saved-search callbacks',async()=>{
 const dom=new JSDOM('<body></body>',{url:`https://studio.example/workspaces?view=locations&location=${id}`});
 const previous=globalThis.document;globalThis.document=dom.window.document;
 const geometry={type:'Polygon',coordinates:[[[88,26],[92,26],[92,29],[88,29],[88,26]]]};
 const documentRecord={title:'Bhutan',canonical_uri:'https://www.wikidata.org/entity/Q917',aliases:[],identifiers:[],geometry,
  knowledge:{schemaVersion:'1.0.0',distributions:[],metadata:{source:[],normalized:[],curated:[],inferred:[]},context:[]}};
 const saved={id,role:'reader',revision:2,currentRevision:2,document:documentRecord};
 let reads=0;const searches=[],areas=[];
 const root=LocationDirectory({adapter:{kind:'api',listLocations:async()=>[{id,title:'Bhutan',revision:2}],getLocation:async()=>structuredClone(saved),
  getLocationLinks:async()=>{reads++;return{revision:1,currentRevision:1,entries:[{entry_id:id,available:true,kind:'layer',target_id:id,title:'Land cover',relationship:'http://purl.org/dc/terms/relation',evidence:[],confidence:null}]};}},
  onSearchTaggedLayers:value=>searches.push(value),onUseSavedSearchArea:value=>areas.push(value)});
 document.body.append(root);
 const wait=async f=>{for(let i=0;i<60;i++){if(f())return;await new Promise(r=>setTimeout(r,5));}assert.fail('not settled');};
 const click=label=>[...root.querySelectorAll('button')].find(b=>b.textContent===label).click();
 try{
  await wait(()=>!root.shouldBlockNavigation());
  assert.equal(root.querySelectorAll('table tbody tr').length,1);
  assert.equal(root.querySelector('[data-location-id]').getAttribute('aria-pressed'),'true');
  const svg=root.querySelector('.location-boundary-preview svg');assert.ok(svg);assert.match(svg.querySelector('path').getAttribute('d'),/^M/);
  assert.equal(root.querySelector('iframe,img,canvas'),null);
  assert.equal(reads,1);assert.match(root.querySelector('.location-resource-links').textContent,/Land cover/);
  assert.equal(root.querySelector('[aria-label="Geographic tag name"]').closest('fieldset').disabled,true);
  assert.equal([...root.querySelectorAll('summary')].find(s=>s.textContent==='Edit Geographic tag').parentElement.open,false);
  click('Search tagged layers');click('Use saved search area');
  assert.equal(searches.length,1);assert.equal(areas.length,1);assert.deepEqual(areas[0].document.geometry,geometry);
  areas[0].document.geometry.coordinates[0][0][0]=0;assert.equal(saved.document.geometry.coordinates[0][0][0],88);
  assert.equal(reads,1);
 }finally{root.dispose();globalThis.document=previous;dom.window.close();}
});

it('states missing boundaries honestly and retains boundary source provenance in the draft revision',async()=>{
 const dom=new JSDOM('<body></body>',{url:`https://studio.example/workspaces?view=locations&location=${id}`});
 const previous=globalThis.document;globalThis.document=dom.window.document;
 const knowledge={schemaVersion:'1.0.0',distributions:[],metadata:{source:[],normalized:[],curated:[],inferred:[]},context:[]};
 let saved={id,role:'owner',revision:1,currentRevision:1,document:{title:'Place',canonical_uri:null,aliases:[],identifiers:[],geometry:null,knowledge}},submitted;
 const areas=[];
 const root=LocationDirectory({adapter:{kind:'api',listLocations:async()=>[{id,title:'Place',revision:1}],getLocation:async()=>structuredClone(saved),
  saveLocation:async(document,expected)=>{assert.deepEqual(expected,{id,revision:1});submitted=structuredClone(document);saved={...saved,revision:2,currentRevision:2,document:structuredClone(document)};}},
  onUseSavedSearchArea:value=>areas.push(value)});document.body.append(root);
 const wait=async f=>{for(let i=0;i<60;i++){if(f())return;await new Promise(r=>setTimeout(r,5));}assert.fail('not settled');};
 const button=label=>[...root.querySelectorAll('button')].find(b=>b.textContent===label);
 const set=(label,value)=>{const field=root.querySelector(`[aria-label="${label}"]`);field.value=value;field.dispatchEvent(new dom.window.Event('input'));};
 try{
  await wait(()=>!root.shouldBlockNavigation());assert.match(root.textContent,/No boundary selected/);assert.equal(root.querySelector('svg'),null);
  assert.equal(button('Use saved search area').disabled,true);assert.equal(button('Search tagged layers').disabled,true);
  const geometry={type:'Polygon',coordinates:[[[1,1],[2,1],[2,2],[1,2],[1,1]]]};
  set('Geometry GeoJSON',JSON.stringify(geometry));set('Boundary source URI','https://source.example/boundaries');set('Boundary source revision','2024-07-18');
  button('Use saved search area').click();assert.equal(areas.length,0);assert.equal(root.hasUnsavedChanges(),true);
  button('Save Geographic tag').click();await wait(()=>!root.shouldBlockNavigation());
  assert.deepEqual(submitted.geometry,geometry);assert.equal(submitted.knowledge.metadata.curated[0].property,'http://purl.org/dc/terms/source');
  assert.deepEqual(submitted.knowledge.metadata.curated[0].value,{'@id':'https://source.example/boundaries',revision:'2024-07-18'});
  assert.equal(knowledge.metadata.curated.length,0);assert.ok(root.querySelector('svg'));assert.equal(button('Use saved search area').disabled,false);
  button('Use saved search area').click();assert.equal(areas[0].revision,2);
 }finally{root.dispose();globalThis.document=previous;dom.window.close();}
});

it('selects an authorized exact Layer-version polygon without guessing a country or bypassing preview limits',async()=>{
 const dom=new JSDOM('<body></body>',{url:`https://studio.example/workspaces?view=locations&location=${id}`});
 const previous=globalThis.document;globalThis.document=dom.window.document;
 const versionId='20000000-0000-4000-8000-000000000002',datasetId='30000000-0000-4000-8000-000000000003',projectId='40000000-0000-4000-8000-000000000004';
 const geometry={type:'Polygon',coordinates:[[[88,26],[92,26],[92,29],[88,29],[88,26]]]};
 const knowledge={schemaVersion:'1.0.0',distributions:[],metadata:{source:[{rawText:'preserve source'}],normalized:[],curated:[],inferred:[]},context:[]};
 let saved={id,role:'owner',revision:1,currentRevision:1,document:{title:'Bhutan',canonical_uri:'https://www.wikidata.org/entity/Q917',aliases:[],identifiers:[],geometry:null,knowledge}},submitted;
 let substituted=true;const reads=[],searches=[];
 const adapter={kind:'api',listLocations:async()=>[{id,title:'Bhutan',revision:1}],getLocation:async()=>structuredClone(saved),
  searchDatasets:async query=>{searches.push(query);return[{id:datasetId,projectId,name:'Country boundaries',currentVersionId:versionId,currentVersionNumber:3}];},
  getDatasetSpatialPreview:async(...args)=>{reads.push(args);return{datasetVersionId:substituted?id:versionId,numberReturned:2,numberMatched:6,mayBeTruncated:true,
   geojson:{type:'FeatureCollection',features:[{type:'Feature',id:'BTN',properties:{ADMIN:'Bhutan'},geometry},{type:'Feature',id:'NPL',properties:{NAME:'Nepal'},geometry}]}};},
  saveLocation:async(document,expected)=>{assert.deepEqual(expected,{id,revision:1});submitted=structuredClone(document);saved={...saved,revision:2,currentRevision:2,document:structuredClone(document)};}};
 const root=LocationDirectory({adapter});document.body.append(root);
 const wait=async f=>{for(let i=0;i<60;i++){if(f())return;await new Promise(r=>setTimeout(r,5));}assert.fail('not settled');};
 const button=label=>[...root.querySelectorAll('button')].find(b=>b.textContent===label);
 const choose=(label,value)=>{const control=root.querySelector(`[aria-label="${label}"]`);control.value=value;control.dispatchEvent(new dom.window.Event('change'));return control;};
 try{
  await wait(()=>!root.shouldBlockNavigation());assert.equal(searches.length,0);assert.equal(reads.length,0);
  button('Search boundary Layers').click();await wait(()=>!root.shouldBlockNavigation());
  assert.deepEqual(searches,[{query:'countries',limit:50,offset:0}]);assert.equal(button('Load boundary features').disabled,true);
  choose('Boundary Layer',datasetId);button('Load boundary features').click();await wait(()=>!root.shouldBlockNavigation());
  assert.equal(root.querySelector('[aria-label="Boundary feature"]').options.length,1);assert.equal(button('Use boundary in draft').disabled,true);
  substituted=false;button('Load boundary features').click();await wait(()=>!root.shouldBlockNavigation());
  assert.deepEqual(reads,[[projectId,datasetId,versionId],[projectId,datasetId,versionId]]);
  assert.match(root.querySelector('.location-boundary-picker').textContent,/sample preview; other source features may be absent/);
  assert.equal(root.querySelector('[aria-label="Boundary feature"]').value,'');assert.equal(button('Use boundary in draft').disabled,true);
  choose('Boundary feature','0');assert.ok(root.querySelector('.location-boundary-candidate svg'));button('Use boundary in draft').click();
  assert.equal(root.hasUnsavedChanges(),true);assert.equal(saved.document.geometry,null);assert.equal(submitted,undefined);
  button('Save Geographic tag').click();await wait(()=>!root.shouldBlockNavigation());assert.deepEqual(submitted.geometry,geometry);
  const claim=submitted.knowledge.metadata.curated[0];assert.equal(claim.property,'http://www.w3.org/ns/prov#wasDerivedFrom');
  assert.equal(claim.value.datasetId,datasetId);assert.equal(claim.value.datasetVersionId,versionId);assert.equal(claim.value.featureId,'BTN');assert.equal(claim.value.previewMayBeTruncated,true);
  assert.equal(claim.value.datasetName,'Country boundaries');assert.equal(claim.value.datasetVersionNumber,3);
  assert.match(root.querySelector('.location-boundary-source').textContent,/Country boundaries · v3 · Bhutan/);
  assert.ok(root.querySelector('.location-boundary-source a').href.includes(datasetId));
  assert.equal(claim.evidence[0],`urn:opengeo:dataset:${datasetId}:version:${versionId}`);assert.deepEqual(submitted.knowledge.metadata.source,knowledge.metadata.source);
 }finally{root.dispose();globalThis.document=previous;dom.window.close();}
});

it('requires source review for manual geometry edits and replaces exact-feature claims only in the new revision',async()=>{
 const dom=new JSDOM('<body></body>',{url:`https://studio.example/workspaces?view=locations&location=${id}`});
 const previous=globalThis.document;globalThis.document=dom.window.document;
 const datasetId='30000000-0000-4000-8000-000000000003',versionId='20000000-0000-4000-8000-000000000002';
 const origin={'@id':`urn:opengeo:dataset:${datasetId}:version:${versionId}`,datasetId,datasetName:'Country boundaries',datasetVersionId:versionId,datasetVersionNumber:3,
  revision:versionId,featureId:'BTN',featureIndex:0,label:'Bhutan · id BTN · #1',layerUri:`https://studio.example/layers/${datasetId}`};
 const knowledge={schemaVersion:'1.0.0',distributions:[],metadata:{source:[],normalized:[],curated:[{subject:'resource',property:'http://www.w3.org/ns/prov#wasDerivedFrom',value:origin,
  provenance:'curator_asserted',method:'Boundary source selected in Geographic tags'}],inferred:[]},context:[]};
 const geometry={type:'Polygon',coordinates:[[[88,26],[92,26],[92,29],[88,29],[88,26]]]};
 const historical={id,role:'owner',revision:2,currentRevision:2,document:{title:'Bhutan',canonical_uri:null,aliases:[],identifiers:[],geometry,knowledge}};
 let current=structuredClone(historical),writes=0;
 const root=LocationDirectory({adapter:{kind:'api',listLocations:async()=>[],getLocation:async()=>structuredClone(current),saveLocation:async(document)=>{writes++;current={...current,revision:3,currentRevision:3,document:structuredClone(document)};}}});document.body.append(root);
 const wait=async f=>{for(let i=0;i<60;i++){if(f())return;await new Promise(r=>setTimeout(r,5));}assert.fail('not settled');};
 const save=()=>[...root.querySelectorAll('button')].find(b=>b.textContent==='Save Geographic tag').click();
 try{
  await wait(()=>!root.shouldBlockNavigation());const input=root.querySelector('[aria-label="Geometry GeoJSON"]');
  const edited=structuredClone(geometry);edited.coordinates[0][1][0]=91;input.value=JSON.stringify(edited);input.dispatchEvent(new dom.window.Event('input'));
  save();await wait(()=>!root.shouldBlockNavigation()||root.querySelector('[role=status]').textContent.includes('Review the boundary source'));
  assert.equal(writes,0);assert.equal(root.hasUnsavedChanges(),true);
  const review=root.querySelector('[aria-label="I reviewed the boundary source for this edited geometry"]');assert.equal(review.parentElement.hidden,false);review.checked=true;
  save();await wait(()=>!root.shouldBlockNavigation());assert.equal(writes,1);
  const claim=current.document.knowledge.metadata.curated[0];assert.equal(claim.property,'http://www.w3.org/ns/prov#wasDerivedFrom');
  assert.equal(claim.value.geometryEdited,true);assert.equal(claim.value.featureId,undefined);assert.equal(claim.value.featureIndex,undefined);
  assert.equal(claim.value.datasetName,'Country boundaries');assert.equal(historical.document.knowledge.metadata.curated[0].value.featureId,'BTN');
  assert.deepEqual(historical.document.geometry,geometry);assert.deepEqual(current.document.geometry,edited);
  assert.match(root.querySelector('.location-boundary-source').textContent,/edited search area/);
 }finally{root.dispose();globalThis.document=previous;dom.window.close();}
});
