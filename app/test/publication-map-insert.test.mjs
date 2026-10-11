import assert from 'node:assert/strict';
import {it} from 'node:test';
import {publicationMapInsert} from '../src/lib/publicationMapInsert.js';
import {publicationLanguage} from '../src/components/PublicationCodeEditor.js';
import {OpenGeoApiClient} from '../src/lib/apiClient.js';
import {JSDOM} from 'jsdom';
import * as kit from '@observablehq/notebook-kit';
import {compileObservableNotebook} from '../../services/observable-builder/src/observable-notebook.mjs';

it('inserts an import and render call with one retained HTML file and a small local viewer', async () => {
  const blob = new Blob(['<!doctype html><h1>Portable map</h1>'], {type: 'text/html'});
  const {file, files, snippet} = publicationMapInsert({entryPath: 'src/analysis.md', name: 'Survey map.html', blob});
  assert.equal(file.relativePath, 'src/maps/Survey-map.html');
  assert.equal(file.blob, blob);
  assert.match(snippet, /import \{createView as mapView\} from "\.\/maps\/Survey-map.js"/);
  assert.match(snippet, /display\(mapView\(\{html: await FileAttachment\("\.\/maps\/Survey-map.html"\).text/);
  const module = await files[1].blob.text();
  assert.match(module, /export function createView/);
  assert.match(module, /sandbox.*allow-scripts/);
  assert.equal(files[1].relativePath, 'src/maps/Survey-map.js');
  assert(module.length < 4096, 'The viewer must not duplicate the map runtime');
  assert.doesNotMatch(snippet, /studio.opengeo|allow-same-origin/);
  const staticPage = publicationMapInsert({entryPath: 'index.html', name: 'Survey map.html', blob});
  assert.match(staticPage.snippet, /src="\.\/maps\/Survey-map.html"/);
  assert.throws(() => publicationMapInsert({entryPath: 'src/app.js', name: 'map', blob}), /Markdown or HTML/);
  assert.throws(() => publicationMapInsert({entryPath: 'src/analysis.md', name: 'Survey map.html', blob, existingPaths: [file.relativePath]}), /already exists/);
  assert.throws(() => publicationMapInsert({entryPath: 'src/analysis.md', name: 'Survey map.html', blob, existingPaths: [files[1].relativePath]}), /module path/);
  const next = publicationMapInsert({entryPath: 'src/analysis.md', name: 'Second map', blob, source: snippet});
  assert.match(next.snippet, /createView as mapView2/);
});

it('recognizes publication languages including mixed Framework Markdown', () => {
  assert.equal(publicationLanguage('src/index.md'), 'markdown');
  assert.equal(publicationLanguage('index.html'), 'html');
  assert.equal(publicationLanguage('data.geojson'), 'json');
  assert.equal(publicationLanguage('component.mjs'), 'javascript');
});

it('inserts a native Observable map cell without rewriting source or existing cell identifiers', () => {
  const dom = new JSDOM(''); const parser = new dom.window.DOMParser();
  try {
    const source = '<!doctype html><notebook theme="near-midnight"><title>Survey</title>\n<script id="9" type="module">const amount = view(Inputs.range([0,10], {value:2}));</script>\n<script id="12" type="text/markdown"># Result ${amount}</script>\n</notebook>';
    const result = publicationMapInsert({entryPath: 'src/index.html', name: 'Survey map.html', source, parser,
      blob: new Blob(['<!doctype html><h1>Map</h1>'], {type: 'text/html'})});
    assert.equal(result.file.relativePath, 'src/maps/Survey-map.html');
    const updated = source.slice(0,result.insertOffset) + result.snippet + source.slice(result.insertOffset);
    assert.equal(updated.replace(result.snippet,''),source, 'Original source bytes are unchanged');
    const before = compileObservableNotebook(source,{kit,parser}), after = compileObservableNotebook(updated,{kit,parser});
    assert.deepEqual(after.cells.slice(0,2),before.cells);
    assert.equal(after.cells[2].id,13);
    assert.deepEqual(after.files,['./maps/Survey-map.html']);
    assert.match(result.snippet,/import \{html as mapView\} from "htl"/);
    assert.match(result.snippet,/srcdoc=\$\{await FileAttachment/);
    assert.equal(after.cells[2].error,undefined,'The map import must compile with the existing Notebook dependencies');
    const upgraded = publicationMapInsert({entryPath:'src/index.html',name:'Survey map.html',source,parser,blob:result.file.blob,notebookMapModule:true});
    assert.match(upgraded.snippet,/import \{createView as mapView\} from "opengeo:map"/);
    assert.doesNotMatch(result.snippet,/allow-same-origin|src="\.\/maps/);
    const suffix = '\n<!-- retain this </notebook> comment -->\n>';
    const suffixed = publicationMapInsert({entryPath:'src/index.html',name:'survey',source:source+suffix,parser,blob:result.file.blob});
    assert.equal(suffixed.insertOffset,source.lastIndexOf('</notebook>'));
    assert.throws(() => publicationMapInsert({entryPath:'index.html',source:source.replace('</notebook>',''),parser,name:'map',blob:result.file.blob}),/closing notebook/);
  } finally {dom.window.close();}
});

it('rejects static build configuration before any upload', async () => {
  const client = new OpenGeoApiClient({tokenProvider: () => 'token'});
  let requests = 0;
  client.requestObservableSourceFileUpload = async () => {requests++; throw Error('unexpected upload');};
  for (const extra of ['README.md', 'observablehq.config.js', 'PACKAGE.JSON']) {
    await assert.rejects(client.saveObservableSourceRevision('project', 'source', {
      entryPath: 'index.html', lockfilePath: null,
      files: [{relativePath: 'index.html', blob: new Blob(['<h1>Home</h1>'], {type: 'text/html'})},
        {relativePath: extra, blob: new Blob(['private configuration'])}]
    }), /Static HTML/);
  }
  assert.equal(requests, 0);
});
