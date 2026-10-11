import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp, mkdir, mkdtemp, readFile, readdir, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {incrementalPageRenderer, installIncrementalPageHook} from '../../services/observable-builder/src/incremental-pages.mjs';

process.env.OBSERVABLE_TELEMETRY_DISABLE='true';
const app=resolve(new URL('..',import.meta.url).pathname);
const work=await mkdtemp(join(tmpdir(),'opengeo-incremental-framework-'));
const source=join(work,'src');await mkdir(source);
await cp(join(app,'src/.observablehq/cache'),join(source,'.observablehq/cache'),{recursive:true});
const fixture={
  'index.md':'# Analysis\n\n```js\nimport {value} from "./shared.js";\nconst rows = await FileAttachment("./rows.json").json();\n```\nResult: ${value + rows[0]}\n',
  'other.md':'# Independent\n\n```js\nconst answer = 42;\n```\nAnswer: ${answer}\n',
  'about.md':'# About\n\nAn independent page.\n',
  'shared.js':'export {value} from "./nested.js";\n',
  'nested.js':'export const value = 7;\n',
  'rows.json':'[3]\n'
};
for(const [path,body] of Object.entries(fixture))await writeFile(join(source,path),body);
const buildUrl=pathToFileURL(join(app,'node_modules/@observablehq/framework/dist/build.js'));
const hook=installIncrementalPageHook(buildUrl);
const {build,FileBuildEffects}=await import(buildUrl.href);
hook.deregister();
const {normalizeConfig}=await import(pathToFileURL(join(app,'node_modules/@observablehq/framework/dist/config.js')).href);
const {renderPage}=await import(pathToFileURL(join(app,'node_modules/@observablehq/framework/dist/render.js')).href);
const renderer=incrementalPageRenderer({scope:'local-project:framework-1.13.4:pinned-renderer',renderPage});
let sequence=0;
const sha=body=>createHash('sha256').update(body).digest('hex');
async function tree(directory,prefix=''){
  const files=[];
  for(const entry of await readdir(join(directory,prefix),{withFileTypes:true})){
    const path=prefix?`${prefix}/${entry.name}`:entry.name;
    if(entry.isDirectory())files.push(...await tree(directory,path));
    else files.push([path,sha(await readFile(join(directory,path)))]);
  }
  return files.sort(([a],[b])=>a.localeCompare(b));
}
async function compile(incremental,title='Project'){
  const output=join(work,`output-${++sequence}`);
  const config=normalizeConfig({root:source,output,title,theme:'near-midnight',pages:[],sidebar:false,pager:false,search:false,footer:null});
  const effects=new FileBuildEffects(output,join(source,'.observablehq/cache'));
  effects.output={write(){}};effects.logger={log(){},warn(){},error(){}};
  if(incremental)effects.renderPage=renderer.render;
  await build({config},effects);
  return tree(output);
}
const results=[];
async function compare(name,expected,title){
  const before={...renderer.stats};
  const actual=await compile(true,title);
  const delta={rendered:renderer.stats.rendered-before.rendered,reused:renderer.stats.reused-before.reused};
  assert.deepEqual(delta,expected,name);
  assert.deepEqual(actual,await compile(false,title),`${name}: incremental output differs from clean Framework build`);
  results.push({name,...delta,files:actual.length,byteIdenticalToClean:true});
  return actual;
}
await compare('initial build',{rendered:3,reused:0});
await compare('unchanged revision',{rendered:0,reused:3});
await writeFile(join(source,'index.md'),fixture['index.md']+'\nUpdated discussion.\n');
await compare('one page edited',{rendered:1,reused:2});
await writeFile(join(source,'nested.js'),'export const value = 11;\n');
await compare('transitive module edited',{rendered:1,reused:2});
await writeFile(join(source,'rows.json'),'[9,10]\n');
await compare('attachment changed',{rendered:1,reused:2});
await compare('site title changed',{rendered:3,reused:0},'Renamed project');
await unlink(join(source,'about.md'));
const final=await compare('page removed',{rendered:0,reused:2},'Renamed project');
assert(!final.some(([path])=>path==='about.html'));
console.log(JSON.stringify({status:'passed',results,artifactDirectory:work,
  productionCompilerChanged:false,persistentCache:false,awsRequests:0},null,2));
