import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync, existsSync} from 'node:fs';
import {createHash, webcrypto} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {parseHtml} from '@observablehq/framework/dist/html.js';
import {localizeFrameworkOutput} from '../src/framework-standalone.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const markup = `<!doctype html><html lang="en"><head><title>Native raster</title>
<link rel="preconnect" href="https://fonts.gstatic.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4">
<link rel="stylesheet" href="./theme.css"><link rel="modulepreload" href="./a.js">
<script type="module">import {registerFile} from './_observablehq/stdlib.00000000.js'; import './a.js';
registerFile('./data/image.png',{name:'./data/image.png',mimeType:'image/png',path:'./data/image.png',size:4});
const image = await import('./b.js');</script></head><body><main id="observablehq-main">
<h1 id="native"><a class="observablehq-header-anchor" href="#native">Native raster</a></h1>
<section data-owner="preserved"><!--:native-cell:--><img src="./data/image.png" alt="First"><img src="./data/image.png" alt="Second"></section>
<a href="https://example.com/source">Citation</a></main></body></html>`;
function fixture(t, changes = {}) {
  const data = {'index.html':markup, 'theme.css':'body{color:black}', '_observablehq/stdlib.00000000.js':`export function registerFile(name,info){return info;} export const lazy=()=>import('../not-retained.js');`,
    'a.js':`import './b.js'; export const source = import.meta.url;`, 'b.js':`import './a.js'; export const value=1;`,
    'data/image.png':Buffer.from([1,2,3,4]), ...changes};
  const files = [];
  for (const [path, value] of Object.entries(data)) {
    const bytes = Buffer.from(value);
    files.push({path:'dist/'+path, bytes, sizeBytes:bytes.length, checksumSha256:hash(bytes),
      contentType:path.endsWith('.html')?'text/html':path.endsWith('.css')?'text/css':path.endsWith('.png')?'image/png':'text/javascript'});
  }
  return {files};
}
function documentOf(html) {const window=parseHtml(''); window.document.open(); window.document.write(html); window.document.close(); return window.document;}

test('preserves native compiled markup, localizes cyclic modules and shares verified assets once', async t => {
  const options=fixture(t), result=localizeFrameworkOutput(options), document=documentOf(result.html);
  assert.equal(document.documentElement.lang,'en'); assert.equal(document.title,'Native raster');
  assert.equal(document.querySelectorAll('h1 > .observablehq-header-anchor').length,1);
  assert.equal(document.querySelector('section').getAttribute('data-owner'),'preserved');
  assert.ok(document.querySelector('section').innerHTML.includes('<!--:native-cell:-->'));
  assert.equal(document.querySelector('a[href="https://example.com/source"]').textContent,'Citation');
  assert.equal(result.manifest.fontFallback,'system-fonts'); assert.ok(!result.html.includes('fonts.googleapis.com'));
  assert.equal(result.manifest.assets.length,1); assert.equal(document.querySelectorAll('script[type="application/octet-stream"]').length,1);
  assert.deepEqual(result.manifest.unsupportedLazyImports,['dist/not-retained.js']);
  const map=JSON.parse(document.querySelector('script[type="importmap"]').textContent);
  const modules=Object.values(map.imports).map(url=>Buffer.from(url.split(',')[1],'base64').toString());
  assert.ok(modules.some(source=>source.includes('@opengeo-localized/') && source.includes('https://opengeo-localized.invalid/a.js')));
  assert.ok(modules.some(source=>source.includes('Unavailable in this retained Framework output')));
  const blobs=new Map(), context={document,Blob,Uint8Array,crypto:webcrypto,atob,btoa,Symbol,
    URL:{createObjectURL(blob){const url='blob:local/'+blobs.size;blobs.set(url,blob);return url;},revokeObjectURL(){}},addEventListener(){}};
  const bootstrap=document.querySelector('script:not([type])').textContent;
  await runInNewContext(bootstrap,context);
  assert.equal(blobs.size,1); assert.deepEqual(Buffer.from(await [...blobs.values()][0].arrayBuffer()),Buffer.from([1,2,3,4]));
  assert.deepEqual([...document.querySelectorAll('img')].map(image=>image.getAttribute('src')),['blob:local/0','blob:local/0']);
  assert.equal(result.manifest.publicationAuthorized,false);
  const payload=document.querySelector('script[type="application/octet-stream"]'); payload.textContent='AAAAAA==';
  const corrupt={...context}; delete corrupt[Symbol.for('opengeo.framework.localized-ready.1')];
  await assert.rejects(runInNewContext(bootstrap,corrupt),/checksum changed/);
});

test('rejects changed bytes, unsafe paths, external dependencies and missing required modules',t=>{
  const changed=fixture(t);changed.files.find(file=>file.path==='dist/a.js').bytes[0]^=1; assert.throws(()=>localizeFrameworkOutput(changed),/asset_changed/);
  for(const source of [`import 'https://example.com/runtime.js';`,`import './absent.js';`,`import(variable);`,`fetch('https://example.com/data');`]) {
    assert.throws(()=>localizeFrameworkOutput(fixture(t,{'a.js':source})),/external_asset|module_missing|computed_import|external_request/);
  }
  assert.throws(()=>localizeFrameworkOutput(fixture(t,{'theme.css':'body{background:url(https://example.com/image.png)}'})),/external_asset/);
  assert.throws(()=>localizeFrameworkOutput({...fixture(t),entryPath:'dist/../private.html'}),/manifest_invalid/);
  assert.throws(()=>localizeFrameworkOutput({...fixture(t),maximumOutputBytes:64*1024*1024}),/manifest_invalid/);
});

test('rejects unavailable authored lazy imports instead of treating them as optional stdlib parsers',t=>{
  assert.throws(()=>localizeFrameworkOutput(fixture(t,{'a.js':`export const requested=()=>import('./absent.js');`})),/module_missing/);
});

test('records unavailable pinned sample data declared by generated Framework client',t=>{
  const result=localizeFrameworkOutput(fixture(t,{
    'index.html':markup.replace("import './a.js';", "import './a.js'; import './_observablehq/client.00000000.js';"),
    '_observablehq/client.00000000.js':`export const sample = () => import.meta.resolve('../_npm/@observablehq/sample-datasets@1.0.1/aapl.csv');`
  }));
  assert.ok(result.manifest.unsupportedLazyImports.includes('dist/_npm/@observablehq/sample-datasets@1.0.1/aapl.csv'));
  const map=JSON.parse(documentOf(result.html).querySelector('script[type="importmap"]').textContent);
  const source=Object.values(map.imports).map(url=>Buffer.from(url.split(',')[1],'base64').toString())
    .find(source=>source.startsWith('export const sample ='));
  assert.ok(source);
  assert.throws(()=>runInNewContext(source.replace('export const sample =', 'globalThis.sample =')+'\nsample();'),
    /Unavailable lazy asset in this retained Framework output/);
});

test('localizes missing lazy imports declared by generated Framework client as throwing aliases',t=>{
  const result=localizeFrameworkOutput(fixture(t,{
    'index.html':markup.replace("import './a.js';", "import './a.js'; import './_observablehq/client.00000000.js';"),
    '_observablehq/client.00000000.js':`export const lazy = () => import('./stdlib/client-only-lazy.js');`
  }));
  assert.ok(result.manifest.unsupportedLazyImports.includes('dist/_observablehq/stdlib/client-only-lazy.js'));
  const imports=JSON.parse(documentOf(result.html).querySelector('script[type="importmap"]').textContent).imports;
  const source=Buffer.from(imports['@opengeo-unavailable/'+Buffer.from('dist/_observablehq/stdlib/client-only-lazy.js').toString('base64url')]
    .split(',')[1],'base64').toString();
  assert.throws(()=>runInNewContext(source),/Unavailable in this retained Framework output/);
});

test('rejects missing static imports declared by generated Framework client',t=>{
  for(const source of ["import './stdlib/client-only-lazy.js';",
    "import './stdlib/client-only-lazy.js'; export const lazy = () => import('./stdlib/client-only-lazy.js');"]) {
    assert.throws(()=>localizeFrameworkOutput(fixture(t,{
      'index.html':markup.replace("import './a.js';", "import './a.js'; import './_observablehq/client.00000000.js';"),
      '_observablehq/client.00000000.js':source
    })),/module_missing/);
  }
});

test('rejects missing authored sample assets and unpinned generated client assets',t=>{
  assert.throws(()=>localizeFrameworkOutput(fixture(t,{
    'a.js':`export const sample = () => import.meta.resolve('./_npm/@observablehq/sample-datasets@1.0.1/aapl.csv');`
  })),/asset_missing/);
  for(const path of ['@observablehq/sample-datasets@1.0.1/not-pinned.csv',
    '@observablehq/sample-datasets@1.0.2/aapl.csv', 'other-package@1.0.1/aapl.csv']) {
    assert.throws(()=>localizeFrameworkOutput(fixture(t,{
      'index.html':markup.replace("import './a.js';", "import './a.js'; import './_observablehq/client.00000000.js';"),
      '_observablehq/client.00000000.js':`export const sample = () => import.meta.resolve('../_npm/${path}');`
    })),/asset_missing/);
  }
});

test('rejects remote navigation and unhandled SVG asset attributes',t=>{
  assert.throws(()=>localizeFrameworkOutput(fixture(t,{'index.html':markup.replace('</head>','<meta http-equiv="refresh" content="0;url=https://example.com/escape"></head>')})),/unsupported_document/);
  for(const svg of ['<svg><image href="https://example.com/image.png"/></svg>',
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="https://example.com/icons.svg#icon"/></svg>']) {
    assert.throws(()=>localizeFrameworkOutput(fixture(t,{'index.html':markup.replace('</body>',svg+'</body>')})),/unsupported_document_asset/);
  }
});

test('localizes the retained native GeoTIFF graph when the acceptance artifact is available',t=>{
  const output=new URL('../../../.local-archives/studio-sharing/noaa-owner-workflow/framework-live-preview/geotiff-cache/native-output/',import.meta.url);
  if(!existsSync(new URL('compiler-report.json',output))){t.skip('Retained local acceptance output is unavailable');return;}
  const report=JSON.parse(readFileSync(new URL('compiler-report.json',output),'utf8'));
  const files=report.outputManifest.files.map(file=>({...file,bytes:readFileSync(new URL(file.path,output))}));
  const result=localizeFrameworkOutput({files});
  assert.equal(result.manifest.assets.length,1);assert.equal(result.manifest.assets[0].sizeBytes,290);
  assert.equal(result.manifest.fontFallback,'system-fonts');assert.ok(result.manifest.inputFiles.length>40);
  assert.ok(result.manifest.outputBytes<32*1024*1024);assert.ok(!result.html.includes('href="https://fonts.'));
});
