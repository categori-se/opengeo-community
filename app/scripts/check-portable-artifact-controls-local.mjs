import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {compilePortableMapArtifact} from '../src/lib/portableMapArtifact.js';
import {chromium} from 'playwright';
const bundled=await build({entryPoints:[fileURLToPath(new URL('../src/components/ProjectArtifactVersions.js',import.meta.url))],bundle:true,format:'esm',write:false});
const source=bundled.outputFiles[0].text;
const browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync)});
try {
  const page=await browser.newPage();
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><body></body>'}));
  await page.goto('https://local.invalid');
  await page.addScriptTag({type:'module',content:source+`
    window.calls=[];
    document.body.append(ProjectArtifactVersions({projectId:'workspace',resourceId:'resource',canEdit:true,adapter:{
      downloadPortableArtifact:async(...args)=>{calls.push(['download',...args]);return {url:'https://storage.invalid/map.html',expiresAt:'2026-09-19T20:00:00Z'};},
      requestPortableArtifactUpload:async()=>{calls.push(['ticket']);return {upload_id:'upload',expires_at:new Date(Date.now()+60000).toISOString()};},
      uploadFile:async()=>{calls.push(['upload']);},
      completePortableArtifactUpload:async()=>{calls.push(['complete']);return {output_object_id:'output'};},
      registerPortableArtifactEdition:async()=>{calls.push(['register']);return {id:'portable',revision:2,current_version_number:null,version_number:1};},
      readArtifactEdition:async(...args)=>{calls.push(args);return {id:'portable',revision:1,current_version_number:null,version_number:args[2],manifest:args[2]?{representation:'portable-map-html',output:{sizeBytes:100},build:{inputScope:'reviewed-browser-snapshot'}}:null};},
      selectArtifactCurrent:async(...args)=>{calls.push(args);return {id:'portable',revision:2,current_version_number:1,version_number:1};}
    }}));`});
  await page.getByLabel('Artifact representation').selectOption('portable-map-html');
  assert.deepEqual(await page.evaluate(()=>calls),[]);
  assert.equal(await page.getByRole('button',{name:'Find completed images'}).count(),0);
  await page.getByRole('button',{name:'Load Artifact state',exact:true}).click();
  await page.getByRole('button',{name:'Inspect Artifact version',exact:true}).click();
  await page.getByText(/reviewed browser snapshot, not an attested/).waitFor();
  await page.getByRole('button',{name:'Use inspected edition as current'}).click();
  await page.getByRole('status').filter({hasText:'current v1'}).waitFor();
  assert.equal((await page.evaluate(()=>calls)).length,3);
  await page.getByLabel('Artifact representation').selectOption('saved-map-image');
  assert.equal(await page.getByRole('button',{name:'Use inspected edition as current'}).isDisabled(),true);
  await page.getByLabel('Artifact representation').selectOption('portable-map-html');
  await page.getByRole('button',{name:'Load Artifact state',exact:true}).click();
  const artifact=await compilePortableMapArtifact({title:'Upload',runtimeJs:'/* synthetic */',runtimeCss:'body{}',runtimeLicense:'BSD',
    selectedIds:['sites'],candidates:[{id:'sites',sourceId:'sites',title:'Sites',visible:true,paintOrder:{sites:0},source:{type:'geojson',data:{type:'FeatureCollection',features:[]}},paints:[{id:'sites',source:'sites',type:'circle'}]}],
    savedProjectOrigin:{id:'map',version:1,definition:{layers:[]}}});
  await page.getByLabel('Portable Artifact HTML',{exact:true}).setInputFiles({name:'map.html',mimeType:'text/html',buffer:Buffer.from(artifact.html)});
  await page.getByLabel('Portable Artifact manifest',{exact:true}).setInputFiles({name:'map.html.artifact.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(artifact.manifest))});
  await page.getByRole('button',{name:'Upload and register portable edition',exact:true}).click();
  await page.getByRole('status').filter({hasText:'current not selected · inspected v1'}).waitFor();
  assert.deepEqual((await page.evaluate(()=>calls)).slice(-4),[['ticket'],['upload'],['complete'],['register']]);
  await page.getByRole('button',{name:'Authorize portable HTML download',exact:true}).click();
  await page.getByRole('link',{name:'Download portable edition v1'}).waitFor();
  assert.deepEqual((await page.evaluate(()=>calls)).at(-1),['download','workspace','resource',1]);
  await page.getByLabel('Artifact representation').selectOption('saved-map-image');
  assert.equal(await page.getByRole('link',{name:'Download portable edition v1'}).count(),0);
  console.log(JSON.stringify({pinnedDownload:true,portableControls:true,reviewedPairUpload:true,currentNotImplicit:true,providerRequests:0,syntheticAdapter:true}));
} finally {await browser.close();}
