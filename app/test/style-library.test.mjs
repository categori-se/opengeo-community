import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {StyleLibrary} from '../src/components/StyleLibrary.js';
import {PlatformDirectory} from '../src/components/PlatformDirectory.js';
import {patternSld,savedPattern,patternSvg,normalizePattern,createCartographicPatternLibrary,rasterizePattern} from '../src/lib/cartographicPatterns.js';
import {parseContinuousColorExpression} from '../src/lib/continuousStyle.js';
import {symbologyCatalog} from '../src/lib/symbologyCatalog.js';

it('authors unequal continuous palette stops and saves only the selected bound definition while MassGIS remains classed',async()=>{
  const dom=new JSDOM('<body/>'),previous=new Map(),stored=[];
  for(const name of ['document','DOMParser','Option']){previous.set(name,globalThis[name]);globalThis[name]=dom.window[name];}
  const adapter={kind:'fixture',listResources:async()=>[{id:'resource',title:'Amounts',kind:'dataset',state:'draft'}],
    getResourceCapabilities:async()=>({canUpdate:true}),listResourceStyles:async()=>stored,
    createResourceStyle:async(projectId,resourceId,value)=>{
      assert.equal(projectId,'container');assert.equal(resourceId,'resource');
      const style={...value,id:'continuous-palette',resourceId,versionNumber:1,checksumSha256:createHash('sha256').update(value.definition).digest('hex')};
      stored.push(style);return style;
    }};
  let root;
  const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
  const control=label=>root.querySelector(`[aria-label="${label}"]`);
  const change=async(label,value,event='change')=>{control(label).value=value;control(label).dispatchEvent(new dom.window.Event(event));await settle();};
  const button=text=>[...root.querySelectorAll('button')].find(item=>item.textContent===text);
  try{
    root=StyleLibrary({adapter,containers:[{id:'container',name:'Account data'}]});document.body.append(root);
    await change('Data library','container');await change('Style resource','resource');await change('Collections','OpenGeo palettes');
    root.querySelector('[data-entry-id="palette:risk"]').click();await settle();
    assert.equal(control('Palette scale').value,'classed');
    assert.equal(JSON.parse(root.querySelector('[aria-label="Preset Style definition"]').textContent).layers[0].paint['fill-color'][0],'step');
    await change('Palette scale','continuous');await change('Preset numeric field','loss_amount','input');
    await change('Preset Style name','Loss amounts','input');
    for(const [index,value] of [0,5,20,80,100].entries())await change(`Palette stop ${index+1}`,String(value),'input');
    assert.equal(stored.length,0);
    const preview=decodeURIComponent(root.querySelector('.symbology-gallery-preset-preview img').src.split(',')[1]);
    assert.match(preview,/<linearGradient[^>]+color-interpolation="sRGB"/);assert.match(preview,/<stop offset="0.05"/);
    const status=root.querySelector('#style-preset-designer [role="status"]');
    for(const invalid of ['0','']){
      await change('Palette stop 2',invalid,'input');assert.equal(button('Save as new Style').disabled,true);
      assert.match(status.textContent,/increasing finite stops/);assert.equal(status.closest('details'),null);
      assert.equal(status.closest('section').hidden,false);
      assert.equal(root.querySelector('.symbology-gallery-preset-preview img'),null);assert.equal(stored.length,0);
      button('Save as new Style').click();await settle();assert.equal(stored.length,0);
    }
    await change('Palette stop 2','5','input');assert.equal(button('Save as new Style').disabled,false);
    assert.equal(status.textContent,'');assert.equal(control('Preset numeric field').validity.valid,true);
    assert.ok(root.querySelector('.symbology-gallery-preset-preview img'));
    button('Save as new Style').click();await settle();assert.equal(stored.length,1);
    const definition=JSON.parse(stored[0].definition),scale=parseContinuousColorExpression(definition.layers[0].paint['fill-color']);
    assert.equal(definition.name,'Loss amounts');assert.equal(scale.field,'loss_amount');
    assert.deepEqual(scale.stops.map(stop=>stop.value),[0,5,20,80,100]);
    assert.deepEqual(scale.stops.map(stop=>stop.color),symbologyCatalog().find(entry=>entry.id==='palette:risk').recipe.colors);
    assert.equal(scale.noDataColor,'#9ca3af');assert.equal(definition.layers[0].paint['fill-opacity'],.75);
    assert.equal(button('Save as new Style').disabled,true);
    assert.match(status.textContent,/Saved Loss amounts · version 1/);
    await change('Palette stop 2','5','input');assert.match(status.textContent,/Saved Loss amounts · version 1/);
    button('Discard preset changes').click();await change('Collections','MassGIS · MassEnviroScreen');
    const example=symbologyCatalog().find(entry=>entry.id.startsWith('massgis:'));
    root.querySelector(`[data-entry-id="${example.id}"]`).click();await settle();
    assert.equal(control('Palette scale').parentElement.hidden,true);
    assert.deepEqual(JSON.parse(root.querySelector('[aria-label="Preset Style definition"]').textContent),JSON.parse(example.recipe.definition));
    await change('Preset numeric field','https://invalid.example','input');
    assert.match(status.textContent,/valid numeric field name/);assert.equal(root.querySelector('.symbology-gallery-preset-preview img'),null);
    assert.equal(button('Save as new Style').disabled,true);assert.equal(stored.length,1);
    await change('Preset numeric field',example.recipe.field,'input');
    assert.equal(status.textContent,'');assert.ok(root.querySelector('.symbology-gallery-preset-preview img'));
    assert.equal(stored.length,1);
  }finally{root?.dispose();for(const [name,value]of previous)globalThis[name]=value;dom.window.close();}
});
it('creates, stores and reopens a versioned pattern with a safe preview through the existing adapter', async()=>{
  const dom=new JSDOM('<body/>');const previous=new Map();
  for(const name of ['document','DOMParser','Option']){previous.set(name,globalThis[name]);globalThis[name]=dom.window[name];}
  const stored=[];let writes=0;
  const adapter={listResources:async()=>[{id:'resource',title:'Water',kind:'dataset',state:'draft'}],
    getResourceCapabilities:async()=>({canUpdate:true}),listResourceStyles:async()=>stored,
    createResourceStyle:async(projectId,resourceId,value)=>{writes++;assert.equal(projectId,'container');assert.equal(resourceId,'resource');
      const style={...value,id:'style',resourceId,versionNumber:1,checksumSha256:'a'.repeat(64)};stored.push(style);return style;}};
  const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
  const choose=async(root,label,value)=>{const control=root.querySelector(`[aria-label="${label}"]`);control.value=value;control.dispatchEvent(new dom.window.Event('change'));await settle();};
  let root;
  try{
    root=StyleLibrary({adapter,containers:[{id:'container',name:'Account data'}]});document.body.append(root);
    assert.equal(writes,0);await choose(root,'Data library','container');await choose(root,'Style resource','resource');
    await choose(root,'Pattern','waves');
    root.querySelector('[aria-label="Transparent background"]').checked=true;
    [...root.querySelectorAll('button')].find(b=>b.textContent==='Save new Style').click();await settle();
    assert.equal(writes,1);assert.ok(root.querySelector('article img'));assert.equal(savedPattern(stored[0]).transparent,true);
    root.dispose();root.remove();root=StyleLibrary({adapter,containers:[{id:'container',name:'Account data'}]});document.body.append(root);
    await choose(root,'Data library','container');await choose(root,'Style resource','resource');assert.ok(root.querySelector('article img'));assert.equal(writes,1);
    const modified={...stored[0],definition:stored[0].definition.replace('image/svg+xml','image/png')};assert.equal(savedPattern(modified),null);
    assert.match(root.textContent,/select its version in a polygon Layer/);
  }finally{root?.dispose();for(const [name,value]of previous)globalThis[name]=value;dom.window.close();}
});
it('escapes titles, embeds the tile and refuses external pattern content',()=>{
  const value={id:'waves',foreground:'#102030',background:'#abcdef',size:32};
  const sld=patternSld(value,'<script>&');assert.match(sld,/&lt;script&gt;&amp;/);assert.match(sld,/InlineContent encoding="base64"/);
  assert.doesNotMatch(patternSvg(value),/https?:\/\/(?!www.w3.org)/);
  assert.throws(()=>patternSvg({...value,id:'https://untrusted.test'}));
});

it('preserves exact v1 pattern bytes and recognizes all saved legacy motifs',()=>{
  const dom=new JSDOM('<body/>'), previous=globalThis.DOMParser;
  globalThis.DOMParser=dom.window.DOMParser;
  const hashes={hatch:'e24ac54e1a73520aa5c4688b217a32b44f176ccef38d75233b45aebfd6acb63d',
    dots:'f9feed951e445293abc8b287208613cfcec6782f0c9b71dbc363b3e05c3e4cb4',
    waves:'11739877389105baa138a312b1c43e30a0fe8341ee383447d9f86c528002d12e',
    ripples:'76a6c5e0b79df83717f850b2fbcb4c536f8755adb0363da277d262b7ff57ad6f',
    forest:'1697a55d1bf8436b5b94f9bf43339c84288300452d835369b6fb93730ebc5e70',
    grass:'02eca981a4fb78e1154e15303bd807a9124acce82a788084add96fb051b2176f',
    wetland:'4c30d2b2f7bce80d64f930018b0a45a5f97c806f3dbe2a0247b15b9e084bc715'};
  try {
    for(const [id,hash] of Object.entries(hashes)) {
      const value={id,foreground:'#123456',background:'#abcdef',size:24,width:1.2,transparent:true};
      const definition=patternSld(value,`Legacy ${id}`);
      assert.equal(createHash('sha256').update(definition).digest('hex'),hash);
      assert.deepEqual(savedPattern({format:'sld_1_1',definition}),value);
    }
  } finally {globalThis.DOMParser=previous;dom.window.close();}
});

it('round-trips v2 primitive controls with strict regeneration and a standalone factory',()=>{
  const dom=new JSDOM('<body/>'),previous=globalThis.DOMParser;
  globalThis.DOMParser=dom.window.DOMParser;
  const value={version:2,id:'waves',foreground:'#123456',background:'#abcdef',size:8,width:2.5,
    transparent:true,density:2.25,angle:37,amplitude:12,curve:.7,opacity:.35};
  try {
    const definition=patternSld(value,'River flow');
    assert.deepEqual(savedPattern({format:'sld_1_1',definition}),value);
    assert.match(definition,/OpenGeo procedural pattern v2/);
    assert.equal(patternSld(savedPattern({format:'sld_1_1',definition}),'River flow'),definition);
    const standalone=Function(`return (${createCartographicPatternLibrary.toString()})()`)();
    assert.equal(standalone.patternSvg(value),patternSvg(value));
    for(const key of ['density','angle','amplitude','curve','opacity']) {
      const alternatives={density:1,angle:0,amplitude:4,curve:.2,opacity:1};
      assert.notEqual(patternSvg({...value,[key]:alternatives[key]}),patternSvg(value),key);
    }
    for(const id of ['crosshatch','lines','dashes','dots','forest','grass','wetland']) {
      const recipe=normalizePattern({...value,id});
      const sld=patternSld(recipe,id);
      assert.deepEqual(savedPattern({format:'sld_1_1',definition:sld}),recipe);
      assert.doesNotMatch(patternSvg(recipe),/https?:\/\/(?!www.w3.org)|<script|href="(?!#motif")/);
    }
    for(const patch of [{density:0},{density:5},{angle:181},{amplitude:17},{curve:-1},{opacity:2},
      {size:7},{width:5},{foreground:'red'},{href:'https://untrusted.test'},{angle:'45'}]) {
      assert.throws(()=>normalizePattern({...value,...patch}));
    }
    const mutated=definition.replace('image/svg+xml','image/png');
    assert.equal(savedPattern({format:'sld_1_1',definition:mutated}),null);
    assert.equal(savedPattern({format:'sld_1_1',definition:'<!DOCTYPE x [<!ENTITY y SYSTEM "https://untrusted.test">]>'+definition}),null);
  } finally {globalThis.DOMParser=previous;dom.window.close();}
});

it('rasterizes an advanced pattern into the existing bounded 64 pixel map tile',async()=>{
  const previous=new Map(['document','Image'].map(key=>[key,globalThis[key]]));
  const pixels={width:64,height:64,data:new Uint8ClampedArray(64*64*4)};
  let canvas;
  globalThis.Image=class {async decode(){assert.match(this.src,/^data:image\/svg\+xml,/);}};
  globalThis.document={createElement:()=>canvas={getContext:()=>({drawImage(){},getImageData:()=>pixels})}};
  try {
    const result=await rasterizePattern({id:'crosshatch',foreground:'#123456',background:'#abcdef',size:8,density:4});
    assert.equal(canvas.width,64);assert.equal(canvas.height,64);assert.equal(result.pixels,pixels);assert.equal(result.pixelRatio,8);
  } finally {for(const [key,value] of previous)globalThis[key]=value;}
});

function styleRecord(overrides={}) {
  const style={id:'style',resourceId:'resource',slug:'roads',title:'Roads',format:'maplibre',versionNumber:1,
    definition:'{"version":8,"sources":{},"layers":[]}',...overrides};
  style.checksumSha256=createHash('sha256').update(style.definition).digest('hex');return style;
}
async function withLibrary(overrides,check) {
  const dom=new JSDOM('<body/>',{url:'https://studio.opengeo.tools/workspaces?view=styles&adapter=fixture'}), previous=new Map(), calls=[];
  for(const name of ['document','DOMParser','Option','location','HTMLElement']){
    previous.set(name,Object.getOwnPropertyDescriptor(globalThis,name));
    Object.defineProperty(globalThis,name,{configurable:true,writable:true,value:dom.window[name]});
  }
  const adapter={kind:'fixture',
    listResources:async projectId=>{calls.push(['resources',projectId]);return [
      {id:'resource',title:'Roads',kind:'dataset',state:'draft'},
      {id:'other-resource',title:'Water',kind:'dataset',state:'draft'}];},
    getResourceCapabilities:async()=>({canUpdate:true}),
    listResourceStyles:async(projectId,resourceId)=>{calls.push(['styles',projectId,resourceId]);return [styleRecord({resourceId})];},
    updateResourceStyle:async()=>assert.fail('Switching or navigation must not save a Style'),...overrides};
  const root=StyleLibrary({adapter,containers:[{id:'container',name:'Account data'},{id:'other-container',name:'Other data'}]});
  const field=label=>root.querySelector(`[aria-label="${label}"]`);
  const button=name=>[...root.querySelectorAll('button')].find(control=>control.textContent===name);
  const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
  const choose=async(label,value)=>{const control=field(label);control.value=value;control.dispatchEvent(new dom.window.Event('change'));await settle();};
  try{
    document.body.append(root);await choose('Data library','container');await choose('Style resource','resource');
    await check({root,adapter,dom,field,button,choose,settle,calls});
  }finally{
    root.dispose();for(const [name,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}
    dom.window.close();
  }
}
async function until(predicate) {
  for(let attempt=0;attempt<100;attempt++){
    if(predicate())return;
    await new Promise(resolve=>setTimeout(resolve,0));
  }
  assert.fail('Style library did not settle');
}
it('preserves an edited Style and pattern controls across blocked switches and directory history navigation',async()=>{
  await withLibrary({},async({root,dom,field,choose,settle,calls})=>{
    const editor=root.querySelector('.resource-style-version-editor'), definition=field('Saved style definition'), original=definition.value;
    assert.equal(root.shouldBlockNavigation(),false);
    definition.value='{"version":8,"sources":{},"layers":[],"name":"Draft"}';
    field('Style title').value='Unsaved pattern';field('Pattern color').value='#123456';
    assert.equal(root.shouldBlockNavigation(),true);
    const reads=calls.length;
    await choose('Style resource','other-resource');await choose('Data library','other-container');
    assert.equal(field('Data library').value,'container');assert.equal(field('Style resource').value,'resource');
    assert.equal(root.querySelector('.resource-style-version-editor'),editor);assert.match(definition.value,/Draft/);
    assert.equal(field('Style title').value,'Unsaved pattern');assert.equal(field('Pattern color').value,'#123456');
    assert.equal(calls.length,reads);assert.match(root.textContent,/Finish reviewing or saving your Style draft/);
    const directory=PlatformDirectory({adapter:{kind:'fixture',getSession:async()=>{throw Object.assign(Error('signed out'),{status:401});}},view:'styles'});
    document.body.append(directory);await settle();directory.replaceChildren(root);directory.resourceDirectory=root;
    try{
      dom.window.history.replaceState(null,'','/workspaces?view=data&adapter=fixture');
      dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
      assert.equal(dom.window.location.pathname+dom.window.location.search,'/workspaces?view=styles&adapter=fixture');
      assert.equal(directory.shouldBlockNavigation(),true);assert.equal(root.querySelector('.resource-style-version-editor'),editor);
      assert.match(definition.value,/Draft/);assert.equal(calls.length,reads);
      definition.value=original;assert.equal(root.shouldBlockNavigation(),true);
      [...root.querySelectorAll('button')].find(b=>b.textContent==='Discard changes').click();
      assert.equal(root.shouldBlockNavigation(),false);
      await choose('Style resource','other-resource');assert.equal(field('Style resource').value,'other-resource');
      await choose('Data library','other-container');assert.equal(field('Data library').value,'other-container');assert.equal(field('Style resource').value,'');
      assert.equal(field('Style title').value,'Untitled pattern');assert.equal(field('Pattern color').value,'#444444');
    }finally{directory.dispose();}
  });
});
it('blocks switching during a Style save and permits it after the confirmed version without replacing the editor',async()=>{
  let finish, submitted;
  await withLibrary({updateResourceStyle:(projectId,resourceId,styleId,value)=>{
    submitted={projectId,resourceId,styleId,value};return new Promise(resolve=>{finish=resolve;});
  }},async({root,field,button,choose})=>{
    const editor=root.querySelector('.resource-style-version-editor');
    button('Save style version').click();assert.equal(root.shouldBlockNavigation(),true);
    await choose('Style resource','other-resource');assert.equal(field('Style resource').value,'resource');
    finish(styleRecord({...submitted.value,resourceId:submitted.resourceId,versionNumber:2}));
    await until(()=>root.textContent.includes('Saved style version 2'));
    assert.equal(root.querySelector('.resource-style-version-editor'),editor);assert.equal(root.shouldBlockNavigation(),false);
    assert.equal(submitted.value.expectedVersion,1);assert.equal(submitted.styleId,'style');
    await choose('Style resource','other-resource');assert.equal(field('Style resource').value,'other-resource');
  });
});
it('keeps the same editor and draft when reviewing a conflict and choosing the latest edit base',async()=>{
  let reads=0;const writes=[];
  await withLibrary({listResourceStyles:async()=>[styleRecord(++reads===1?{}:{title:'Colleague style',definition:'{"version":8,"sources":{},"layers":[],"name":"Latest"}',versionNumber:2})],
    updateResourceStyle:async(projectId,resourceId,styleId,value)=>{
      writes.push(value);if(writes.length===1)throw Object.assign(Error('conflict'),{code:'resource_style_version_conflict'});
      return styleRecord({...value,resourceId,versionNumber:3});
    }},async({root,field,button,choose})=>{
    const editor=root.querySelector('.resource-style-version-editor');
    field('Saved style title').value='My Style';field('Saved style definition').value='{"version":8,"sources":{},"layers":[],"name":"My draft"}';
    field('Style change note').value='Keep my changes';button('Save style version').click();
    await until(()=>root.textContent.includes('Someone saved another version'));
    assert.equal(root.shouldBlockNavigation(),true);await choose('Data library','other-container');assert.equal(field('Data library').value,'container');
    button('Check latest version').click();await until(()=>!button('Use latest as edit base').hidden);
    button('Use latest as edit base').click();
    assert.equal(root.querySelector('.resource-style-version-editor'),editor);assert.equal(field('Saved style title').value,'My Style');
    assert.match(field('Saved style definition').value,/My draft/);assert.equal(field('Style change note').value,'Keep my changes');
    assert.equal(root.shouldBlockNavigation(),true);assert.equal(writes.length,1);
    button('Save style version').click();await until(()=>root.textContent.includes('Saved style version 3'));
    assert.equal(writes[1].expectedVersion,2);assert.match(writes[1].definition,/My draft/);
    assert.equal(root.shouldBlockNavigation(),false);assert.equal(root.querySelector('.resource-style-version-editor'),editor);
    assert.match(root.querySelector('article h3').textContent,/My Style.*v3/);
  });
});

it('shows eighteen cartographic presets before choosing a library and saves only on request with edit access',async()=>{
  const dom=new JSDOM('<body/>'),previous=new Map(),calls=[],stored=[];
  for(const name of ['document','DOMParser','Option']){previous.set(name,globalThis[name]);globalThis[name]=dom.window[name];}
  let canUpdate=false,root;
  const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
  const adapter={kind:'fixture',
    listResources:async()=>{calls.push('resources');return [{id:'resource',title:'Wetlands',kind:'dataset',state:'draft'}];},
    listResourceStyles:async()=>{calls.push('styles');return stored;},
    getResourceCapabilities:async()=>({canUpdate}),
    createResourceStyle:async(projectId,resourceId,value)=>{
      calls.push('save');assert.equal(projectId,'container');assert.equal(resourceId,'resource');
      const style={...value,id:'preset-style',resourceId,versionNumber:1,checksumSha256:createHash('sha256').update(value.definition).digest('hex')};
      stored.push(style);return style;
    }};
  try{
    root=StyleLibrary({adapter,containers:[{id:'container',name:'Account data'}]});document.body.append(root);
    const presets=[...root.querySelectorAll('[aria-label="Cartographic presets"] .style-preset-card')];
    assert.deepEqual(presets.map(item=>item.getAttribute('aria-label')),['Water preset','Lakes preset','Wetlands preset','Marshes preset','Forest preset',
      'Grassland preset','Built areas preset','Deciduous forest preset','Evergreen forest preset','Mixed forest preset','Shrubland preset','Cropland preset','Orchards preset','Bare ground preset','Rock preset','Sand preset','Snow preset','Ice preset']);
    assert.deepEqual(calls,[]);assert.ok(presets.every(item=>item.getAttribute('aria-pressed')==='false'));
    assert.equal(root.querySelector('[aria-label="Style title"]').value,'Untitled pattern');
    assert.equal(root.querySelector('.style-presets a').hostname,'www.usgs.gov');
    const guidance=root.querySelector('[aria-label="Cartographic presets"] details');assert.equal(guidance.open,false);
    assert.deepEqual([...guidance.querySelectorAll('a')].map(link=>link.hostname),['pubs.usgs.gov','www.nps.gov','felt.com','learn.arcgis.com']);
    assert.match(guidance.textContent,/sequential or diverging/);assert.match(guidance.textContent,/polygon rates/);
    const save=[...root.querySelectorAll('button')].find(item=>item.textContent==='Save new Style');assert.equal(save.disabled,true);
    for(const preset of presets){
      assert.ok(preset.querySelector('img').alt);assert.match(preset.querySelector('img').src,/^data:image\/svg\+xml,/);
      preset.click();assert.equal(preset.getAttribute('aria-pressed'),'true');
      assert.equal(presets.filter(item=>item.getAttribute('aria-pressed')==='true').length,1);
    }
    assert.equal(root.querySelector('[aria-label="Pattern"]').value,'hatch');assert.equal(root.querySelector('[aria-label="Pattern spacing"]').value,'40');assert.deepEqual(calls,[]);
    const choose=async(label,value)=>{const control=root.querySelector(`[aria-label="${label}"]`);control.value=value;control.dispatchEvent(new dom.window.Event('change'));await settle();};
    await choose('Data library','container');await choose('Style resource','resource');
    presets[3].click();save.click();await settle();assert.equal(stored.length,0);assert.equal(save.disabled,true);
    canUpdate=true;await choose('Style resource','resource');assert.equal(save.disabled,false);
    save.click();await settle();assert.equal(stored.length,1);assert.equal(stored[0].title,'Marshes');
    assert.equal(savedPattern(stored[0]).id,'wetland');assert.equal(savedPattern(stored[0]).foreground,'#3d85ad');assert.equal(stored[0].versionNumber,1);
    const color=root.querySelector('[aria-label="Pattern color"]');color.value='#123456';color.dispatchEvent(new dom.window.Event('input'));
    assert.ok(presets.every(item=>item.getAttribute('aria-pressed')==='false'));
    assert.equal(calls.filter(item=>item==='save').length,1);
  }finally{root?.dispose();for(const [name,value]of previous)globalThis[name]=value;dom.window.close();}
});

it('preserves a pattern draft through conflicting edits and archives without changing the pinned definition',async()=>{
  const original=styleRecord({format:'sld_1_1',definition:patternSld({id:'waves',foreground:'#123456',background:'#ffffff',size:32},'Water'),title:'Water'});
  let head=structuredClone(original);const writes=[];
  await withLibrary({
    listResourceStyles:async(_project,_resource,{includeArchived}={})=>head.archived&&!includeArchived?[]:[structuredClone(head)],
    updateResourceStyle:async(_project,_resource,_id,value)=>{
      writes.push(value);
      if(writes.length===1){head=styleRecord({...head,title:'Shared water',versionNumber:2});throw Object.assign(Error('conflict'),{code:'resource_style_version_conflict'});}
      assert.equal(value.expectedVersion,2);head=styleRecord({...head,...value,versionNumber:3});return structuredClone(head);
    },
    archiveResourceStyle:async(_project,_resource,_id,{expectedVersion})=>{assert.equal(expectedVersion,3);head={...head,archived:true};return structuredClone(head);},
    restoreResourceStyle:async(_project,_resource,_id,{expectedVersion})=>{assert.equal(expectedVersion,3);head={...head,archived:false};return structuredClone(head);}
  },async({root,field,button,dom,settle})=>{
    button('Edit pattern').click();field('Style title').value='My waves';field('Pattern density').value='2.25';
    field('Pattern density').dispatchEvent(new dom.window.Event('input'));
    button('Save changes').click();await until(()=>root.textContent.includes('Someone saved a newer version'));
    assert.equal(field('Style title').value,'My waves');assert.equal(field('Pattern density').value,'2.25');assert.equal(button('Save changes').disabled,true);
    button('Check latest pattern version').click();await until(()=>!button('Use latest pattern as edit base').hidden);
    button('Use latest pattern as edit base').click();button('Save changes').click();await until(()=>root.textContent.includes('Saved My waves'));
    assert.equal(head.versionNumber,3);assert.equal(savedPattern(head).density,2.25);assert.equal(original.versionNumber,1);assert.equal(savedPattern(original).id,'waves');
    const definition=head.definition;button('Delete').click();assert.equal(head.archived,undefined);
    button('Confirm delete').click();await until(()=>head.archived===true);await settle();assert.equal(root.querySelector('.style-saved-row'),null);
    assert.equal(head.definition,definition);assert.equal(head.versionNumber,3);assert.equal(root.shouldBlockNavigation(),false);
    field('Show deleted styles').checked=true;field('Show deleted styles').dispatchEvent(new dom.window.Event('change'));await settle();
    assert.equal(button('Edit pattern').hidden,true);assert.equal(button('Restore').hidden,false);
    button('Restore').click();await until(()=>head.archived===false);await settle();
    assert.equal(head.definition,definition);assert.equal(button('Edit pattern').hidden,false);assert.equal(head.versionNumber,3);
  });
});
