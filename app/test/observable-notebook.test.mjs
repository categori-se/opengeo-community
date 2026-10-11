import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import * as kit from '@observablehq/notebook-kit';
import {compileObservableNotebook, inspectObservableNotebookImport, notebookAttachmentPath, notebookNoticeFiles, observableNotebookDocument} from '../../services/observable-builder/src/observable-notebook.mjs';
import {convertLegacyObservable} from '../../services/observable-builder/src/legacy-observable.mjs';
import {publicationStarter, publicationFormats, publicationFormatEnabled} from '../src/lib/publicationDrafts.js';
import {OpenGeoApiClient} from '../src/lib/apiClient.js';
import {publicationFormat} from '../../services/observable-builder/src/publication-format.mjs';
import {fileURLToPath} from 'node:url';
import {buildNotebookAssets} from '../../services/observable-builder/scripts/notebook-assets.mjs';
import {createView} from '../../services/observable-builder/src/portable-map-view.mjs';

const source = cells => '<!doctype html><notebook><title>Analysis</title>' + cells.map(([type, value], index) => `<script id="${index + 1}" type="${type}">${value}</script>`).join('') + '</notebook>';
function compile(value) {
  const dom = new JSDOM('');
  try {return compileObservableNotebook(value, {kit, parser: new dom.window.DOMParser()});}
  finally {dom.window.close();}
}

it('selects only retained notice text from the current Notebook prefix with existing source limits', () => {
 const file=(path,overrides={})=>({path,contentType:'text/plain',sizeBytes:3,...overrides});
 const retained=file(`src/original/notices/LICENSE-${'a'.repeat(64)}.txt`);
 assert.deepEqual(notebookNoticeFiles('src/index.html',[retained,file('src/original/notices/private.txt'),
   file(`other/original/notices/LICENSE-${'b'.repeat(64)}.txt`),file('src/private.txt')]),[{...retained,noticeName:'LICENSE'}]);
 for(const invalid of [{contentType:'text/html'},{sizeBytes:0},{sizeBytes:4_194_305}]) {
   assert.throws(()=>notebookNoticeFiles('src/index.html',[{...retained,...invalid}]),/source text limits/);
 }
 assert.throws(()=>notebookNoticeFiles('src/index.html',Array.from({length:5},(_,i)=>({...retained,path:retained.path.replace('a'.repeat(64),String(i).repeat(64)),sizeBytes:4_194_304}))),/source text limits/);
});

it('renders supplied notice text without admitting its markup or changing offline document policy', () => {
 const text='\uFEFFCopyright retained\r\n</pre><script>globalThis.noticeExecuted=true</script><img src="https://example.test/a">';
 const html=observableNotebookDocument({runtime:'',styles:'',notices:[{name:'LICENSE <unsafe>',text}]});
 const dom=new JSDOM(html);
 try {
   assert.equal(dom.window.document.querySelector('.notebook-notices summary').textContent,'Licenses and attribution');
   assert.equal(dom.window.document.querySelector('.notebook-notices h2').textContent,'LICENSE <unsafe>');
   assert.equal(dom.window.document.querySelector('.notebook-notices pre').textContent,text.replaceAll('\r\n','\n'));
   assert.equal(dom.window.document.querySelectorAll('script').length,1);
   assert.equal(dom.window.document.querySelectorAll('img').length,0);
   assert.match(dom.window.document.querySelector('[http-equiv="Content-Security-Policy"]').content,/connect-src 'none'/);
   assert.equal(globalThis.noticeExecuted,undefined);
 }finally{dom.window.close();}
});
function inspect(value, options = {}) {
  const dom = new JSDOM('');
  try {return inspectObservableNotebookImport(value, {kit, parser: new dom.window.DOMParser(), ...options});}
  finally {dom.window.close();}
}
it('retains native Notebook admission in ordinary source builds without approving rights or changing source', async () => {
  assert.deepEqual(publicationFormats.map(([format]) => format), ['framework', 'html', 'map', 'notebook', 'jupyter']);
  assert.equal(publicationFormatEnabled('notebook'), true);
  const title = 'Analysis </script><script>bad()</script>';
  const draft = publicationStarter({format: 'notebook', title, sourceProject: {currentRevisionNumber: 0}});
  assert.equal(draft.entryPath, 'index.html');
  const compiled = compile(await draft.files[0].blob.text());
  assert.equal(compiled.title, title);
  assert.equal(compiled.cells.length, 3);
  assert(compiled.cells[2].inputs.includes('value'));
  const marker = draft.files.find(file => file.relativePath === 'opengeo.publication.json');
  const bytes = Buffer.from(await marker.blob.arrayBuffer());
  assert.equal(publicationFormat(draft.entryPath, [{path: marker.relativePath, contentType: marker.contentType, sizeBytes: bytes.length}], () => bytes), 'notebook');
  const client = new OpenGeoApiClient({tokenProvider: () => 'token', fetchImplementation: () => {throw Error('No network in this check');}});
  const uploads = [], bodies = [];
  client.requestObservableSourceFileUpload = async (project, source, file) => {
    assert.equal(project, 'project'); assert.equal(source, 'source'); uploads.push(file);
    return {uploadId: `upload-${uploads.length}`, expiresAt: '2099-01-01T00:00:00Z', upload: {}};
  };
  client.uploadFile = async (_ticket, blob) => {bodies.push(await blob.text());};
  client.createObservableSourceRevision = async (_project, _source, revision) => revision;
  const revision = await client.saveObservableSourceRevision('project', 'source', draft);
  assert.deepEqual(uploads.map(file => file.relativePath), ['index.html', 'opengeo.publication.json']);
  assert.deepEqual(bodies, await Promise.all(draft.files.map(file => file.blob.text())));
  assert.equal(revision.rightsStatus, 'unreviewed');
  assert.equal(revision.expectedRevision, 0);
  assert.deepEqual(revision.files, uploads.map((file, index) => ({uploadId: `upload-${index + 1}`, relativePath: file.relativePath})));
});
it('compiles reactive JavaScript, Observable syntax, Markdown and TypeScript without running cells', () => {
  const result = compile(source([['module', 'globalThis.notebookExecuted = true; const x = 2;'],
    ['text/markdown', '# Value ${x}'], ['application/vnd.observable.javascript', 'y = x * 3'], ['text/x-typescript', 'const z: number = y + 1;']]));
  assert.equal(globalThis.notebookExecuted, undefined);
  assert.equal(result.title, 'Analysis'); assert.equal(result.cells.length, 4);
  assert(result.cells[1].inputs.includes('x'));
  assert(result.cells[2].inputs.includes('x'));
  assert(result.cells[3].inputs.includes('y'));
  assert.doesNotMatch(result.cells[3].body, /: number/);
});
it('resolves bundled imports by AST while preserving similarly spelled source strings', () => {
  const result = compile(source([['module', 'import * as d3 from "npm:d3"; const example = \'import("opengeo:notebook/d3")\'; display(d3.sum([1, 2]));']]));
  assert.match(result.cells[0].body, /Promise.resolve\(globalThis.__opengeoNotebookModules\["d3"\]\)/);
  assert.match(result.cells[0].body, /const example = 'import\("opengeo:notebook\/d3"\)'/);
});
it('bundles only the exact OpenGeo map helper with retained HTML attachments', () => {
  const original = source([['module', 'import {createView} from "opengeo:map"; display(createView({html: await FileAttachment("./maps/source.html").text(), invalidation}));']]);
  const result = compile(original);
  assert.match(result.cells[0].body, /Promise.resolve\(globalThis.__opengeoNotebookModules\["opengeo:map"\]\)/);
  assert.deepEqual(result.files, ['./maps/source.html']);
  assert(result.cells[0].inputs.includes('invalidation'));
  const report = inspect(original, {availablePaths: ['maps/source.html']});
  assert.deepEqual(report.modules.map(({name, bundled}) => ({name, bundled})), [{name: 'opengeo:map', bundled: true}]);
  assert.equal(report.unsupported.length, 0);
  for (const name of ['npm:opengeo:map', './maps/source.js', 'opengeo:notebook-map', 'https://example.test/map.js']) {
    assert.throws(() => compile(source([['module', `import {createView} from ${JSON.stringify(name)};`]])), /is not bundled/);
  }
});
it('disposes isolated map views on notebook invalidation and abort', async () => {
  const dom = new JSDOM('');
  try {
    const document = dom.window.document;
    let invalidate;
    const invalidation = new Promise(resolve => {invalidate = resolve;});
    const html = '<script>parent.mapExecuted = true;</script><div id="retained-map">Map</div>';
    const view = createView({html, title: 'Retained map', width: 320, height: 240, invalidation, document});
    document.body.append(view);
    const frame = view.querySelector('iframe');
    assert.equal(frame.srcdoc, html);
    assert.equal(frame.title, 'Retained map');
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
    assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(frame.style.width, '320px');
    assert.equal(frame.style.height, '240px');
    assert.equal(document.querySelector('#retained-map'), null);
    invalidate(); await invalidation;
    assert.equal(frame.srcdoc, '');
    assert.equal(view.isConnected, false);
    view.dispose();
    const controller = new AbortController();
    const aborted = createView({html, signal: controller.signal, document});
    document.body.append(aborted);
    controller.abort();
    assert.equal(aborted.querySelector('iframe').srcdoc, '');
    assert.equal(aborted.isConnected, false);
  } finally {dom.window.close();}
});
it('extracts file attachments and refuses unsupported imports and privileged cells', () => {
  assert.deepEqual(compile(source([['module', 'const data = await FileAttachment("data/rows.json").json();']])).files, ['data/rows.json']);
  for (const value of [source([['module', 'import * as lib from "unknown-library";']]),
    source([['module', 'const url="https://example.test/x.js"; await import(url);']]),
    source([['text/x-python', 'print(1)']]), source([['application/sql', 'select 1']])]) {
    assert.throws(() => compile(value), /Cell 1:/);
  }
  assert.throws(() => compile('<h1>Plain HTML</h1>'), /one notebook/);
});
it('resolves only project-relative attachment paths and protects document boundaries', () => {
  assert.equal(notebookAttachmentPath('src/pages/index.html', '../data/rows.json'), 'src/data/rows.json');
  for (const path of ['https://example.test/a', '//example.test/a', '/a', 'a?token=x', 'a#x', 'a\\b', 'a/%2e%2e/%2f../b']) {
    assert.throws(() => notebookAttachmentPath('src/index.html', path));
  }
  const html = observableNotebookDocument({title: '</title><script>evil</script>', runtime: 'const value="</script>";', styles: 'body{}', payload: {cells: ['</script><script>evil</script>']}});
  assert.doesNotMatch(html, /<script>evil/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /\\u003c\/script/);
});

it('inspects native imports without execution or attachment reads and continues after unsupported cells', () => {
  const original = source([
    ['module', 'globalThis.notebookInspectionExecuted = true; import * as d3 from "npm:d3"; const data = FileAttachment("../data/rows.json");'],
    ['text/x-python', 'print("requires interpreter")'],
    ['module', 'import other from "unbundled-library"; import more from "./local.js";'],
    ['module', 'const missing = FileAttachment("missing.csv"); fetch("https://user:pass@example.test/data?token=secret#fragment");'],
    ['module', 'const kept = FileAttachment("../data/rows.json");']
  ]);
  const report = inspect(original, {path: 'pages/index.html', availablePaths: ['data/rows.json', 'pages/local.js']});
  assert.equal(globalThis.notebookInspectionExecuted, undefined);
  assert.equal(report.cellCount, 5);
  assert.deepEqual(report.cells.map(cell => cell.mode), ['js', 'python', 'js', 'js', 'js']);
  assert.deepEqual(report.modules.map(({name, bundled}) => ({name, bundled})), [
    {name: 'npm:d3', bundled: true}, {name: 'unbundled-library', bundled: false}, {name: './local.js', bundled: false}
  ]);
  assert.deepEqual(report.attachments, [
    {name: '../data/rows.json', path: 'data/rows.json', available: true, cellIds: [1, 5]},
    {name: 'missing.csv', path: 'pages/missing.csv', available: false, cellIds: [4]}
  ]);
  assert.deepEqual(report.unsupported.map(item => item.cellId), [2, 3]);
  assert(report.externalReferences.some(item => item.kind === 'request-expression' && item.value === 'fetch(…)'));
  assert.match(JSON.stringify(report.externalReferences), /example.test\/data/);
  assert.doesNotMatch(JSON.stringify(report), /user:pass|token=secret|#fragment/);
  assert(report.manualWork.some(message => /missing referenced attachments/.test(message)));
  assert(report.manualWork.some(message => /local modules and arbitrary packages/.test(message)));
  assert(report.limitations.some(message => /legacy hosted notebook conversion and Jupyter/.test(message)));
  assert.equal(report.truncated, false);
});

it('discloses computed requests, invalid attachments and later syntax errors without claiming conversion', () => {
  const report = inspect(source([
    ['module', 'const remote = "https://example.test"; fetch(remote); await import(remote);'],
    ['module', 'FileAttachment("https://example.test/private.json?key=hidden")'],
    ['module', 'const broken = ;'],
    ['text/markdown', 'A citation: https://example.test/methods']
  ]));
  assert(report.manualWork.some(message => /computed module imports/.test(message)));
  assert.deepEqual(report.attachments.map(({path, available}) => ({path, available})), [{path: null, available: false}]);
  assert.deepEqual(report.unsupported.map(item => item.cellId), [1, 3]);
  assert(report.externalReferences.some(item => item.cellIds.includes(4)));
  assert(report.limitations.some(message => /computed requests, aliases and dependencies may be missed/.test(message)));
  assert.doesNotMatch(JSON.stringify(report), /key=hidden/);
});

it('bounds import reports and rejects oversized or non-native input before compilation', () => {
  const report = inspect(source(Array.from({length: 105}, (_, i) => ['module', `FileAttachment("data/${i}.json")`])));
  assert.equal(report.cellCount, 105); assert.equal(report.cells.length, 100);
  assert.equal(report.attachments.length, 100); assert.equal(report.truncated, true);
  assert.throws(() => inspect('x'.repeat(4_194_305)), /4 MiB/);
  assert.throws(() => inspect(source(Array.from({length: 1001}, () => ['module', '1']))), /1,000 cells/);
  assert.throws(() => inspect('<html>A compiled site</html>'), /one notebook/);
  assert.throws(() => inspect(source([['module', '1']]), {availablePaths: Array(129).fill('x')}), /128 source paths/);
});

const legacyFactory = (functions, definitions, setup = '') => `${functions}
export default function define(runtime, observer) {
  const main = runtime.module();
  ${setup}
  ${definitions}
  return main;
}`;
const localNotebook = (cells, modules) => source(cells) + '<script type="application/json" id="opengeo-legacy-modules">'
  + JSON.stringify({version: 1, modules}).replace(/</g, '\\u003c') + '</script>';
let runtimeAssets;
const sharedRuntimeAssets = () => runtimeAssets ??= buildNotebookAssets(fileURLToPath(new URL('..', import.meta.url)));

it('compiles reviewed local imports into lazy bindings and revalidates edited descriptors', () => {
  const child = legacyFactory('function _x() { return 5; }', 'main.variable(observer("x")).define("x", _x);');
  const html = localNotebook([['application/vnd.observable.javascript',
    'import {x as imported} from "observable:opengeo-legacy/child.js"']], [{path: 'child.js', source: child}]);
  const compiled = compile(html);
  assert.deepEqual(compiled.cells[0].legacyImports, [{path: 'child.js', imported: 'x', local: 'imported'}]);
  assert.equal(compiled.legacyModules.modules.length, 1);
  assert.equal(inspect(html).modules[0].bundled, true);
  for (const bad of [html.replace('function _x()', 'globalThis.neverExecute = true; function _x()'),
    html.replace('"version":1', '"version":2'), html.replace('"path":"child.js"', '"path":"../child.js"'),
    html + '<script type="application/json" id="opengeo-legacy-modules">{}</script>']) {
    assert.throws(() => compile(bad));
  }
  assert.equal(globalThis.neverExecute, undefined);
});

it('keeps imported values lazy and resets the actual isolated runtime for changed modules or child bytes', async () => {
  const child = value => legacyFactory(`function _value(FileAttachment, invalidation, globalThis) {
    globalThis.moduleStarts = (globalThis.moduleStarts || 0) + 1;
    invalidation.then(() => {globalThis.moduleStops = (globalThis.moduleStops || 0) + 1;});
    return FileAttachment("data.txt").text().then(text => Number(text) + ${value});
  }
  function _unused(globalThis) { globalThis.unusedChildRan = true; return 99; }`,
  'main.variable(observer("value")).define("value", ["FileAttachment", "invalidation", "globalThis"], _value);\n'
    + 'main.variable(observer("unused")).define("unused", ["globalThis"], _unused);',
  'const fileAttachments = new Map([["data.txt", "./files/data.txt"]]);\n'
    + 'main.builtin("FileAttachment", runtime.fileAttachments(name => fileAttachments.get(name)));');
  const compileVersion = value => compile(localNotebook([
    ['application/vnd.observable.javascript', 'import {value, unused} from "observable:opengeo-legacy/child.js"'],
    ['application/vnd.observable.javascript', 'value']
  ], [{path: 'child.js', source: child(value)}]));
  const first = compileVersion(1), second = compileVersion(2);
  const {runtime} = await sharedRuntimeAssets();
  const dom = new JSDOM('<!doctype html><main></main>', {runScripts: 'outside-only', url: 'https://notebook.invalid/'});
  let objectId = 0, revoked = 0, networkRequests = 0;
  Object.assign(dom.window, {Blob, Response, TextDecoder, TextEncoder, fetch: async () => {networkRequests++; throw Error('External network is forbidden');}});
  dom.window.URL.createObjectURL = () => `blob:https://notebook.invalid/${++objectId}`;
  dom.window.URL.revokeObjectURL = () => {revoked++;};
  const port = {postMessage() {}, close() {}};
  const waitFor = async predicate => {
    for (let i = 0; i < 100; i++) {if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10));}
    throw Error(`Notebook runtime did not settle: ${dom.window.document.querySelector('main').textContent}`);
  };
  try {
    dom.window.eval(runtime);
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {source: dom.window, data: 'opengeo-notebook-connect', ports: [port]}));
    const send = (compiled, revision, text) => port.onmessage({data: {...compiled, revision, attachments: [{
      name: compiled.legacyModules.attachments[0].name, type: 'text/plain', checksum: text, bytes: new TextEncoder().encode(text)
    }]}});
    send(first, 1, '6');
    await waitFor(() => dom.window.document.querySelector('[data-cell-id="2"]')?.textContent === '7');
    assert.equal(dom.window.moduleStarts, 1); assert.equal(dom.window.unusedChildRan, undefined);
    send(first, 2, '6'); await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(dom.window.moduleStarts, 1, 'Unchanged graph preserves child identity');
    send(first, 3, '9'); await waitFor(() => dom.window.moduleStarts === 2 && dom.window.moduleStops === 1);
    await waitFor(() => dom.window.document.querySelector('[data-cell-id="2"]')?.textContent === '10');
    send(second, 4, '9'); await waitFor(() => dom.window.moduleStarts === 3 && dom.window.moduleStops === 2);
    await waitFor(() => dom.window.document.querySelector('[data-cell-id="2"]')?.textContent === '11');
    assert.equal(dom.window.unusedChildRan, undefined, 'Unused import and child cells stay unobserved');
    assert.equal(networkRequests, 0);
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    await waitFor(() => dom.window.moduleStops === 3);
    assert.equal(revoked, 2);
  } finally {dom.window.close();}
});

it('keeps parameterized notebook instances distinct while native values, views and mutable bindings remain reactive', async () => {
  const child = legacyFactory(`const sharedModuleToken = {kind: "module"};
function _shared() { return sharedModuleToken; }
function _param() { throw Error("default parameter must remain unused"); }
function _amount() { throw Error("default view must remain unused"); }
function _count() { return 0; }
function _sum(param, amount, count) { return param * 2 + amount + count; }
function _increment(alias) { return () => ++alias.value; }
function _token(globalThis, invalidation) {
  globalThis.tokenStarts = (globalThis.tokenStarts || 0) + 1;
  invalidation.then(() => {globalThis.tokenStops = (globalThis.tokenStops || 0) + 1;});
  return {};
}
function _note(md, param) { return md\`# Parameter \${param}\`; }`,
  `main.variable(observer("param")).define("param", _param);
main.variable(observer("viewof amount")).define("viewof amount", _amount);
main.variable(observer("amount")).define("amount", ["Generators", "viewof amount"], (G, control) => G.input(control));
main.define("initial count", _count);
main.variable(observer("mutable count")).define("mutable count", ["Mutable", "initial count"], (M, value) => new M(value));
main.variable(observer("count")).define("count", ["mutable count"], value => value.generator);
main.variable(observer("sum")).define("sum", ["param", "amount", "count"], _sum);
main.variable(observer("increment")).define("increment", ["mutable count"], _increment);
main.variable(observer("token")).define("token", ["globalThis", "invalidation"], _token);
main.variable(observer("shared")).define("shared", _shared);
main.variable(observer("note")).define("note", ["md", "param"], _note);`);
  const document = (input, other = false) => localNotebook([
    ['application/vnd.observable.javascript', 'import {sum as first, token as firstToken, token as firstAlias, shared as firstShared, increment, note} with {input as param, viewof amount, mutable count} from "observable:opengeo-legacy/child.js"'],
    ['application/vnd.observable.javascript', `import {sum as second, token as secondToken, shared as secondShared} with {${other ? 'other' : 'input'} as param, viewof amount, mutable count} from "observable:opengeo-legacy/child.js"`],
    ['application/vnd.observable.javascript', `input = ${input}`],
    ['application/vnd.observable.javascript', 'other = 9'],
    ['application/vnd.observable.javascript', 'viewof amount = { const value = document.createElement("input"); value.type = "number"; value.valueAsNumber = 2; globalThis.parameterInput = value; return value; }'],
    ['application/vnd.observable.javascript', 'mutable count = 4'],
    ['application/vnd.observable.javascript', '{ globalThis.parameterTotal = first + second; globalThis.sameInstance = firstToken === firstAlias; globalThis.distinctInstances = firstToken !== secondToken; globalThis.sharedModuleScope = firstShared === secondShared; globalThis.bumpParameter = increment; }'],
    ['application/vnd.observable.javascript', 'note']
  ], [{path: 'child.js', source: child}]);
  const first = compile(document(5));
  assert.deepEqual(first.cells[0].legacyDerivations, [
    {name: 'input', alias: 'param'}, {name: 'amount', alias: 'amount'},
    {name: 'viewof$amount', alias: 'viewof amount'}, {name: 'count', alias: 'count'},
    {name: 'mutable$count', alias: 'mutable count'}
  ]);
  assert(!inspect(document(5)).manualWork.some(value => /depends on md/.test(value)));
  assert.throws(() => compile(document(5).replace('input as param', 'input as missing')), /child binding/);
  const {runtime} = await sharedRuntimeAssets();
  const dom = new JSDOM('<!doctype html><main></main>', {runScripts: 'outside-only', url: 'https://notebook.invalid/'});
  let requests = 0;
  Object.assign(dom.window, {TextDecoder, TextEncoder, fetch: async () => {requests++; throw Error('External network is forbidden');}});
  const port = {postMessage() {}, close() {}};
  const waitFor = async predicate => {
    for (let i = 0; i < 150; i++) {if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10));}
    throw Error(`Parameterized notebook did not settle: ${dom.window.document.querySelector('main').textContent}`);
  };
  try {
    dom.window.eval(runtime);
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {source: dom.window, data: 'opengeo-notebook-connect', ports: [port]}));
    port.onmessage({data: {...first, revision: 1}});
    await waitFor(() => dom.window.parameterTotal === 32 && dom.window.document.querySelector('h1')?.textContent === 'Parameter 5');
    assert.equal(dom.window.sameInstance, true); assert.equal(dom.window.distinctInstances, true); assert.equal(dom.window.tokenStarts, 2);
    assert.equal(dom.window.sharedModuleScope, true, 'Derived notebook instances share the original module constants.');
    port.onmessage({data: {...compile(document(8)), revision: 2}});
    await waitFor(() => dom.window.parameterTotal === 44 && dom.window.document.querySelector('h1')?.textContent === 'Parameter 8');
    assert.equal(dom.window.tokenStarts, 2, 'Changing a parent value retains both derived module identities');
    assert.equal(dom.window.sharedModuleScope, true);
    const presentation = compile(document(8).replace('import {sum as first', 'import  {sum as first').replace('id="1"', 'id="1" pinned'));
    port.onmessage({data: {...presentation, revision: 3}});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(dom.window.tokenStarts, 2, 'Whitespace and source pinning retain the derived instance');
    assert.equal(dom.window.tokenStops, undefined);
    dom.window.bumpParameter(); await waitFor(() => dom.window.parameterTotal === 46);
    dom.window.parameterInput.valueAsNumber = 3;
    dom.window.parameterInput.dispatchEvent(new dom.window.Event('input'));
    await waitFor(() => dom.window.parameterTotal === 48);
    port.onmessage({data: {...compile(document(8, true)), revision: 4}});
    // Import topology changed: both old scopes are disposed and native source
    // restarts with its saved view/mutable initial values (2 and 4).
    await waitFor(() => dom.window.parameterTotal === 46 && dom.window.tokenStops === 2);
    assert.equal(dom.window.tokenStarts, 4);
    assert.equal(dom.window.sameInstance, true); assert.equal(dom.window.distinctInstances, true); assert.equal(requests, 0);
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    await waitFor(() => dom.window.tokenStops === 4);
  } finally {dom.window.close();}
});


it('renders converted root helpers with shared identity and native mutable updates without parent execution', async () => {
  const original = legacyFactory(`const settings = {step: 2}; const token = {};
function adjust(value) { return value + settings.step; }
function _count() { return 1; }
function _first() { return token; }
function _second() { return token; }
function _same(first, second) { return first === second; }
function _shown(count) { return adjust(count); }
function _bump(alias) { return () => alias.value += settings.step; }
function _observe(shown, same, bump, globalThis, invalidation) {
  globalThis.lexicalOutcome = {shown, same}; globalThis.bumpLexical = bump;
  invalidation.then(() => {globalThis.lexicalStopped = true;}); return shown;
}`, `main.define("initial count", _count);
main.variable(observer("mutable count")).define("mutable count", ["Mutable", "initial count"], (M, value) => new M(value));
main.variable(observer("count")).define("count", ["mutable count"], value => value.generator);
main.variable(observer("first")).define("first", _first);
main.variable(observer("second")).define("second", _second);
main.variable(observer("same")).define("same", ["first", "second"], _same);
main.variable(observer("shown")).define("shown", ["count"], _shown);
main.variable(observer("bump")).define("bump", ["mutable count"], _bump);
main.variable(observer("result")).define("result", ["shown", "same", "bump", "globalThis", "invalidation"], _observe);`);
  const parser = new JSDOM('');
  let converted;
  try {converted = convertLegacyObservable(original, {kit, document: parser.window.document, path: 'root.js'});}
  finally {parser.window.close();}
  assert.equal(globalThis.lexicalOutcome, undefined, 'Conversion and compilation do not run supplied functions.');
  const compiled = compile(converted.html), {runtime} = await sharedRuntimeAssets();
  assert.equal(globalThis.lexicalOutcome, undefined);
  const dom = new JSDOM('<!doctype html><main></main>', {runScripts: 'outside-only', url: 'https://notebook.invalid/'});
  let requests = 0;
  Object.assign(dom.window, {TextDecoder, TextEncoder, fetch: async () => {requests++; throw Error('External network is forbidden');}});
  const port = {postMessage() {}, close() {}};
  const waitFor = async predicate => {
    for (let i = 0; i < 150; i++) {if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10));}
    throw Error(`Root lexical notebook did not settle: ${dom.window.document.querySelector('main').textContent}`);
  };
  try {
    dom.window.eval(runtime);
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {source: dom.window, data: 'opengeo-notebook-connect', ports: [port]}));
    port.onmessage({data: {...compiled, revision: 1}});
    await waitFor(() => dom.window.lexicalOutcome?.shown === 3);
    assert.equal(dom.window.lexicalOutcome.same, true);
    dom.window.bumpLexical(); await waitFor(() => dom.window.lexicalOutcome?.shown === 5);
    assert.equal(dom.window.lexicalOutcome.same, true); assert.equal(requests, 0);
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    await waitFor(() => dom.window.lexicalStopped);
    assert.equal(globalThis.lexicalOutcome, undefined);
  } finally {dom.window.close();}
});

it('renders imported legacy Plot charts with pinned offline require and reports unsupported versions without network', async () => {
 const {runtime} = await sharedRuntimeAssets();
 const child = legacyFactory('function _Plot(loader) { return loader("@observablehq/plot@0.6"); }\nfunction _d3(require) { return require("d3@7"); }\nfunction _chart(Plot,d3,htl) { const chart=Plot.plot({width:260,height:160,marks:[Plot.barY([{label:"A",value:d3.sum([1,2])},{label:"B",value:4}],{x:"label",y:"value"})]}); chart.dataset.offlineHtl=htl.html`<span>Bundled HTL</span>`.textContent; return chart; }',
  'main.variable(observer("Plot")).define("Plot",["require"],_Plot);\nmain.variable(observer("d3")).define("d3",["require"],_d3);\nmain.variable(observer("chart")).define("chart",["Plot","d3","htl"],_chart);');
 const html = localNotebook([
  ['application/vnd.observable.javascript','import {chart} from "observable:opengeo-legacy/child.js"'],
  ['application/vnd.observable.javascript','chart'],
  ['application/vnd.observable.javascript','d3 = require("d3@7.9.0")'],
  ['application/vnd.observable.javascript','d3.sum([1,2,3])'],
  ['application/vnd.observable.javascript','bad = require("d3@5")']
 ],[{path:'child.js',source:child}]);
 const compiled = compile(html), findings = inspect(html);
 assert(findings.modules.some(module=>module.kind==='legacy-require'&&module.resolvedVersion==='0.6.17'&&module.bundled));
 assert(findings.modules.some(module=>module.name==='d3@5'&&!module.bundled));
 const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>',{url:'https://notebook.invalid/',runScripts:'outside-only'});
 let networkRequests=0;
 Object.assign(dom.window,{Blob,Response,TextDecoder,TextEncoder,fetch:async()=>{networkRequests++;throw Error('External request forbidden');}});
 const port={postMessage(){},close(){}};
 try {
  dom.window.eval(runtime);
  dom.window.dispatchEvent(new dom.window.MessageEvent('message',{source:dom.window,data:'opengeo-notebook-connect',ports:[port]}));
  port.onmessage({data:{...compiled,revision:1,attachments:[]}});
  for(let i=0;i<100;i++) {
   if(dom.window.document.querySelector('[data-cell-id="2"] svg')&&dom.window.document.querySelector('[data-cell-id="4"]')?.textContent==='6'
    &&/unavailable offline/.test(dom.window.document.querySelector('[data-cell-id="5"]')?.textContent??''))break;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  const chart=dom.window.document.querySelector('[data-cell-id="2"] svg');
  assert(chart,dom.window.document.querySelector('main').textContent);
  assert.equal(chart.querySelectorAll('[aria-label="bar"] rect').length,2);
  assert.equal(chart.dataset.offlineHtl,'Bundled HTL');
  assert.equal(dom.window.document.querySelector('[data-cell-id="4"]').textContent,'6');
  assert.match(dom.window.document.querySelector('[data-cell-id="5"]').textContent,/unavailable offline/);
  assert.equal(networkRequests,0);
 }finally{dom.window.dispatchEvent(new dom.window.Event('pagehide'));dom.window.close();}
});


it('discloses user-defined require loaders instead of assigning bundled version claims', () => {
 const findings=inspect(source([
  ['application/vnd.observable.javascript','require = name => ({custom: name})'],
  ['application/vnd.observable.javascript','result = require("d3@7")']
 ]));
 const request=findings.modules.find(item=>item.kind==='legacy-require');
 assert.equal(request.bundled,false);assert.equal(request.resolvedVersion,undefined);
 assert.match(request.supportNote,/User-defined require loader/);
});
