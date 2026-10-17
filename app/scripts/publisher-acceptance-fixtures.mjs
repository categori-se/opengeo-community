import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {buildMaplibre6Bundle} from './build-maplibre-render-bundle.mjs';
import {staticMapDocument} from '../src/lib/staticMapExport.js';

export async function acceptanceFixture(format, {version=1}={}) {
  const files = {};
  let entryPath = 'index.html';
  if (format === 'framework') {
    entryPath = 'src/index.md';
    files[entryPath] = ['---', 'title: Publisher acceptance Framework', '---',
      '# Publisher acceptance Framework', '', '```js',
      'import {sum} from "./components/analysis.js";',
      'const rows = await FileAttachment("./data/observations.json").json();',
      'const multiplier = view(Inputs.range([1, 5], {label: "Multiplier", value: 2, step: 1}));',
      'const total = sum(rows) * multiplier;', '```', '',
      '<p id="computed-total">Computed total: ${total}</p>', '',
      '[Methods](./methods) · [Independent page](./independent)', ''].join('\n');
    if (version===2) files[entryPath]=files[entryPath].replace(
      'const total = sum(rows) * multiplier;',
      '```\n\n```js\nconst total = sum(rows) * multiplier;');
    files['package.json'] = JSON.stringify({name:'publisher-acceptance-framework',private:true,type:'module'});
    files['package-lock.json'] = JSON.stringify({name:'publisher-acceptance-framework',lockfileVersion:3,requires:true,packages:{'':{name:'publisher-acceptance-framework'}}});
    files['src/methods.md'] = '# Methods\n\nSynthetic observations only. Sum the values, then apply the chosen multiplier.\n\n[Home](./)\n';
    files['src/independent.md'] = '# Independent page\n\nThis page has no data attachment dependency.\n';
    files['src/components/analysis.js'] = 'export const sum = rows => rows.reduce((total, row) => total + row.value, 0);\n';
    files['src/data/observations.json'] = JSON.stringify([{site:'A',value:7},{site:'B',value:14}]);
    files['opengeo.observable.json'] = JSON.stringify({schemaVersion:'opengeo.observable-presentation.1.0.0',title:'Publisher acceptance Framework',theme:['light','dark'],pages:[{name:'Analysis',path:'/'},{name:'Methods',path:'/methods'},{name:'Independent',path:'/independent'}]});
  } else if (format === 'notebook') {
    files[entryPath] = '<!doctype html><notebook><title>Publisher acceptance Notebook</title><script id="1" type="text/markdown"># Publisher acceptance Notebook</script><script id="2" type="module">const rows = await FileAttachment("data/observations.json").json();</script><script id="3" type="module">const multiplier = view(Inputs.range([1, 5], {label: "Multiplier", value: 2, step: 1}));</script><script id="4" type="module">const total = rows.reduce((sum, row) => sum + row.value, 0) * multiplier;</script><script id="5" type="text/markdown">Computed total: ${total}</script></notebook>';
    files['data/observations.json'] = JSON.stringify([{value:7},{value:14}]);
  } else if (format === 'jupyter') {
    entryPath = 'index.ipynb';
    files[entryPath] = JSON.stringify({nbformat:4,nbformat_minor:5,metadata:{language_info:{name:'python'}},cells:[
      {id:'intro',cell_type:'markdown',metadata:{},source:'# Publisher acceptance Jupyter\n\nSaved analysis outputs. No kernel execution is required.'},
      {id:'analysis',cell_type:'code',metadata:{},execution_count:1,source:'values = [7, 14]\nprint(sum(values))',outputs:[{output_type:'stream',name:'stdout',text:'21\n'},{output_type:'display_data',metadata:{},data:{'text/html':'<table><caption>Saved observations</caption><tr><th>Site</th><th>Value</th></tr><tr><td>A</td><td>7</td></tr><tr><td>B</td><td>14</td></tr></table>','text/plain':'A: 7; B: 14'}}]}
    ]});
  } else if (format === 'map') {
    const runtime = new URL('../node_modules/maplibre-gl/', import.meta.url);
    const {version} = JSON.parse(await readFile(new URL('package.json',runtime),'utf8'));
    if (!['5.24.0','6.4.1'].includes(version)) throw new Error('Unreviewed MapLibre acceptance runtime');
    const [runtimeBytes,runtimeCss,runtimeLicense] = await Promise.all([
      version === '6.4.1' ? buildMaplibre6Bundle({packageRoot:fileURLToPath(runtime),globalName:'maplibregl'})
        : readFile(new URL('dist/maplibre-gl.js',runtime)),
      ...['dist/maplibre-gl.css','LICENSE.txt'].map(path=>readFile(new URL(path,runtime),'utf8'))
    ]);
    const runtimeJs = Buffer.from(runtimeBytes).toString('utf8');
    files[entryPath] = staticMapDocument({title:'Publisher acceptance map',mode:'offline',view:{center:[0,0],zoom:3},runtimeJs,runtimeCss,runtimeLicense,selectedIds:['synthetic'],candidates:[{
      id:'synthetic',title:'Synthetic observations',visible:true,reason:null,sourceId:'observations',attribution:'Synthetic publisher acceptance data',
      source:{type:'geojson',data:{type:'FeatureCollection',features:[[-2,0],[2,1],[0,-2]].map((coordinates,index)=>({type:'Feature',properties:{site:index+1},geometry:{type:'Point',coordinates}}))}},
      paints:[{id:'observations',source:'observations',type:'circle',paint:{'circle-radius':10,'circle-color':'#346cff'}}],paintOrder:{observations:1}
    }]});
  } else throw new Error('Unsupported acceptance fixture');
  const prefix = entryPath.includes('/') ? entryPath.slice(0,entryPath.lastIndexOf('/')+1) : '';
  files[prefix+'opengeo.publication.json'] = JSON.stringify({schema:'opengeo.publication.1',format,entry:entryPath.slice(prefix.length)});
  return {entryPath,lockfilePath:format==='framework'?'package-lock.json':null,files:Object.entries(files).map(([relativePath,text])=>({relativePath,text,contentType:relativePath.endsWith('.ipynb')?'application/x-ipynb+json':relativePath.endsWith('.md')?'text/markdown':relativePath.endsWith('.js')?'text/javascript':relativePath.endsWith('.json')?'application/json':'text/html'}))};
}
