import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import MarkdownIt from 'markdown-it';
import {parseJupyterNotebook, inspectJupyterNotebookImport, renderJupyterNotebook, renderJupyterNotebookWithFiles, jupyterImagePath} from '../src/lib/jupyterNotebook.js';
import {publicationLanguage} from '../src/components/PublicationCodeEditor.js';
import {publicationStarter, publicationFormatEnabled} from '../src/lib/publicationDrafts.js';
import {OpenGeoApiClient, normalizeObservableSourceFiles, validateJupyterPublicationTree} from '../src/lib/apiClient.js';

const markdown = new MarkdownIt({html: false});
const code = outputs => ({cell_type: 'code', metadata: {}, source: ['x = 1\n', 'x'], execution_count: 1, outputs});
const notebook = cells => JSON.stringify({nbformat: 4, nbformat_minor: 5, metadata: {language_info: {name: 'python'}, custom: {retained: true}}, cells});
it('retains native Jupyter admission in ordinary source builds without approving rights or changing source', async () => {
  const draft = publicationStarter({format: 'jupyter', title: 'Analysis', sourceProject: {currentRevisionNumber: 0}});
  assert.equal(publicationFormatEnabled('jupyter'), true);
  assert.equal(draft.entryPath, 'index.ipynb');
  assert.equal(parseJupyterNotebook(await draft.files[0].blob.text()).cells[1].execution_count, null);
  assert.equal(normalizeObservableSourceFiles(draft.files)[0].contentType, 'application/x-ipynb+json');
  const client = new OpenGeoApiClient({tokenProvider: () => 'token', fetchImplementation: () => {throw Error('No network in this check');}});
  const uploads = [], bodies = [];
  client.requestObservableSourceFileUpload = async (project, source, file) => {
    assert.equal(project, 'project'); assert.equal(source, 'source'); uploads.push(file);
    return {uploadId: `upload-${uploads.length}`, expiresAt: '2099-01-01T00:00:00Z', upload: {}};
  };
  client.uploadFile = async (_ticket, blob) => {bodies.push(await blob.text());};
  client.createObservableSourceRevision = async (_project, _source, revision) => revision;
  const revision = await client.saveObservableSourceRevision('project', 'source', draft);
  assert.deepEqual(uploads.map(file => file.relativePath), ['index.ipynb', 'opengeo.publication.json']);
  assert.deepEqual(bodies, await Promise.all(draft.files.map(file => file.blob.text())));
  assert.equal(revision.rightsStatus, 'unreviewed');
  assert.equal(revision.expectedRevision, 0);
  assert.deepEqual(revision.files, uploads.map((file, index) => ({uploadId: `upload-${index + 1}`, relativePath: file.relativePath})));
  assert.throws(() => validateJupyterPublicationTree('src/index.ipynb', 'package-lock.json', []), /lockfile-free/);
  assert.throws(() => validateJupyterPublicationTree('src/index.ipynb', null, [{relativePath: 'private.txt'}]), /entry directory/);
});
function render(source, options = {}) {
  const dom = new JSDOM('');
  try {return renderJupyterNotebook(source, {document: dom.window.document, renderMarkdown: value => markdown.render(value), ...options});}
  finally {dom.window.close();}
}

it('preserves native source, unknown metadata, and saved outputs; uses JSON highlighting', () => {
  const source = notebook([code([{output_type: 'execute_result', data: {'text/plain': ['1']}, metadata: {custom: 2}}])]);
  assert.deepEqual(parseJupyterNotebook(source), JSON.parse(source));
  const html = render(source);
  assert.match(html, /<pre>1<\/pre>/);
  assert.match(html, /editing does not run a kernel/i);
  assert.deepEqual(parseJupyterNotebook(source), JSON.parse(source));
  assert.equal(publicationLanguage('src/analysis.IPYNB'), 'json');
});

it('renders Markdown, attachments, tables, stream text, errors and raw cells', () => {
  const html = render(notebook([
    {cell_type: 'markdown', source: '# Results\n![plot](attachment:plot%20one.png)', metadata: {}, attachments: {'plot one.png': {'image/png': 'YWJj'}}},
    code([{output_type: 'display_data', data: {'text/html': '<table><tr><th>A</th><td>2</td></tr></table>'}},
      {output_type: 'stream', text: ['hello\n', '<script>evil</script>']},
      {output_type: 'error', traceback: ['\u001b[31mValueError: missing']}]),
    {cell_type: 'raw', metadata: {}, source: '<raw>'}
  ]));
  assert.match(html, /<h1>Results<\/h1>/);
  assert.match(html, /src="data:image\/png;base64,YWJj"/);
  assert.match(html, /<th>A<\/th>/);
  assert.match(html, /hello\n&lt;script&gt;/);
  assert.match(html, /ValueError: missing/);
  assert.match(html, /&lt;raw&gt;/);
  assert.doesNotMatch(html, /\u001b/);
});

it('removes active output content and network references, retaining safe table values', () => {
  const html = render(notebook([code([{output_type: 'display_data', data: {'text/html': '<script>alert(1)</script><iframe src="https://evil.test"></iframe><style>@import "https://evil.test";</style><table onclick="evil()"><tr><td style="background:url(https://evil.test)">safe</td></tr></table><img src="https://evil.test" onerror="evil()"><a href="javascript:evil()">link</a><svg><script>evil()</script></svg>'}}]) ]));
  assert.match(html, /<td>safe<\/td>/);
  assert.doesNotMatch(html, /evil|onclick|onerror|<script|<iframe|<svg/);
  assert.match(html, /script-src 'none'/);
  assert.match(html, /default-src 'none'/);
});

it('does not fetch Markdown images or accept SVG attachments', () => {
  const html = render(notebook([{cell_type: 'markdown', metadata: {}, source: '![external](https://evil.test/image.png)\n![svg](attachment:plot.svg)', attachments: {'plot.svg': {'image/svg+xml': '<svg onload="evil()"/>'}}}]));
  assert.doesNotMatch(html, /evil|onload|src="/);
});

it('isolates unsupported and malformed saved outputs without losing other cells', () => {
  const html = render(notebook([code([{output_type: 'display_data', data: {'application/vnd.jupyter.widget-view+json': {model_id: 'x'}}}, {output_type: 'stream', text: 4}, {output_type: 'stream', text: 'later output'}])]));
  assert.match(html, /original Jupyter renderer/);
  assert.match(html, /Cannot display this saved output/);
  assert.match(html, /later output/);
});

it('rejects invalid formats, duplicate ids, invalid execution counts and oversized source', () => {
  assert.throws(() => parseJupyterNotebook('{'), SyntaxError);
  assert.throws(() => parseJupyterNotebook('{"nbformat":3}'), /nbformat 4/);
  assert.throws(() => parseJupyterNotebook(notebook([{...code([]), id: 'same'}, {...code([]), id: 'same'}])), /duplicate/);
  assert.throws(() => parseJupyterNotebook(notebook([{...code([]), execution_count: -1}])), /execution count/);
  assert.throws(() => parseJupyterNotebook(' '.repeat(4_194_305)), /4 MiB/);
});

it('supports the light and dark editor palette without interpolating metadata as HTML', () => {
  const source = JSON.parse(notebook([code([])])); source.metadata.language_info.name = '<img src=x onerror=evil()>';
  const html = render(JSON.stringify(source), {dark: true});
  assert.match(html, /background:#1e1e1e/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img src=x/);
});

it('embeds only referenced local raster images from Markdown and saved HTML output', async () => {
  const dom = new JSDOM(''), reads=[];
  const source = notebook([
    {cell_type:'markdown',metadata:{},source:'![Survey](../images/survey%20plot.png)\n![blocked](https://remote.invalid/x.png)'},
    code([{output_type:'display_data',data:{'text/html':'<img alt="Saved figure" src="../images/survey%20plot.png" onerror="evil()">'}}])
  ]);
  try {
    const html = await renderJupyterNotebookWithFiles(source,{document:dom.window.document,renderMarkdown:value=>markdown.render(value),
      path:'src/notebooks/index.ipynb',sourceRoot:'src',readFile:async path=>{reads.push(path);return new Blob(['image bytes'],{type:'image/png'});}});
    assert.deepEqual(reads,['src/images/survey plot.png']);
    assert.equal((html.match(/src="data:image\/png;base64,/g)??[]).length,2);
    assert.doesNotMatch(html,/remote.invalid|onerror|evil\(\)/);
    assert.equal(parseJupyterNotebook(source).cells.length,2);
    const broken={document:dom.window.document,renderMarkdown:value=>markdown.render(value),path:'src/index.ipynb',sourceRoot:'src'};
    const imageNotebook=notebook([{cell_type:'markdown',metadata:{},source:'![Plot](plot.png)'}]);
    await assert.rejects(renderJupyterNotebookWithFiles(imageNotebook,broken),/Open the notebook images/);
    await assert.rejects(renderJupyterNotebookWithFiles(imageNotebook,{...broken,readFile:async()=>new Blob(['svg'],{type:'image/svg+xml'})}),/media type/);
    const repeated=notebook([{cell_type:'markdown',metadata:{},source:'![Plot](plot.png)\n'.repeat(6)}]);
    await assert.rejects(renderJupyterNotebookWithFiles(repeated,{...broken,readFile:async()=>new Blob([new Uint8Array(3_000_000)],{type:'image/png'})}),/including repeated/);
  } finally {dom.window.close();}
});

it('confines notebook image paths to source files and never resolves URLs or active formats', () => {
  assert.deepEqual(jupyterImagePath('src/pages/index.ipynb','../figures/a%20b.PNG','src'),{path:'src/figures/a b.PNG',type:'image/png'});
  for (const name of ['https://remote.invalid/a.png','//remote.invalid/a.png','/private.png','../../../secret.png',
    '../../secret.png','%2fprivate.png','%68ttps%3Aremote.png','plot.svg','plot.png?token=secret','plot.png#x','..%5csecret.png']) {
    assert.equal(jupyterImagePath('src/pages/index.ipynb',name,'src'),null,name);
  }
});

it('inspects native cells, embedded and local images without executing code or changing source', () => {
  const source = notebook([
    {cell_type: 'markdown', metadata: {}, source: '![embedded](attachment:plot%20one.png)\n![local](../images/map.png)\n![missing](missing.jpg)\n![svg](plot.svg)',
      attachments: {'plot one.png': {'image/png': 'YWJj'}, unused: {'image/jpeg': 'YWJj'}}},
    {...code([]), id: 'analysis', source: 'globalThis.jupyterInspectionExecuted = true;\nimport pandas as pd'}
  ]);
  const before = JSON.parse(source);
  const report = inspectJupyterNotebookImport(source, {path: 'pages/index.ipynb', availablePaths: ['images/map.png', 'pages/plot.svg']});
  assert.equal(globalThis.jupyterInspectionExecuted, undefined);
  assert.deepEqual(JSON.parse(source), before);
  assert.equal(report.kind, 'jupyter-notebook'); assert.equal(report.language, 'python');
  assert.deepEqual(report.cells, [{id: 1, mode: 'markdown'}, {id: 'analysis', mode: 'python'}]);
  assert.deepEqual(report.attachments.map(({name, storage, available, referenced, supported}) => ({name, storage, available, referenced, supported})), [
    {name: 'plot one.png', storage: 'embedded', available: true, referenced: true, supported: true},
    {name: '../images/map.png', storage: 'project', available: true, referenced: true, supported: true},
    {name: 'missing.jpg', storage: 'project', available: false, referenced: true, supported: true},
    {name: 'plot.svg', storage: 'project', available: null, referenced: true, supported: false},
    {name: 'unused', storage: 'embedded', available: true, referenced: false, supported: true}
  ]);
  assert.deepEqual(report.modules, []); assert.match(report.moduleInspection, /not performed/);
  assert.equal(report.savedOutputs.codeCellsWithoutOutput, 1);
  assert(report.manualWork.some(message => /does not execute a kernel/.test(message)));
  assert(report.limitations.some(message => /Reference-style images/.test(message)));
});

it('reports saved output losses, malformed outputs and external candidates while retaining later results', () => {
  const source = notebook([code([
    {output_type: 'display_data', data: {'application/vnd.jupyter.widget-view+json': {model_id: 'private'}}},
    {output_type: 'stream', text: 4},
    {output_type: 'stream', text: 'later output'},
    {output_type: 'display_data', data: {'text/html': '<img src="https://user:secret@example.test/plot.png?token=hidden#private">'}},
    {output_type: 'display_data', data: {'application/vnd.jupyter.widget-view+json': {}, 'text/plain': 'Static fallback'}}
  ]), {cell_type: 'markdown', metadata: {}, source: '![missing](attachment:lost.png)\nhttps://example.test/citation'}]);
  const report = inspectJupyterNotebookImport(source);
  assert.deepEqual(report.savedOutputs, {total: 5, supported: 3, unsupported: 2, codeCellsWithoutOutput: 0, malformed: 1, widgets: 2});
  assert.equal(report.unsupported.filter(item => /widgets/.test(item.message)).length, 2);
  assert(report.unsupported.some(item => /malformed/.test(item.message)));
  assert(report.attachments.some(item => item.storage === 'embedded' && item.available === false));
  assert(report.externalReferences.some(item => item.value.includes('example.test/plot.png')));
  assert.doesNotMatch(JSON.stringify(report), /user:secret|token=hidden|#private/);
  assert(report.limitations.some(message => /computed requests, aliases/.test(message)));
});

it('bounds Jupyter inspection reports and reuses source and cell-count admission limits', () => {
  const report = inspectJupyterNotebookImport(notebook(Array.from({length: 105}, (_, index) => ({cell_type: 'markdown', metadata: {}, source: `![plot](plot-${index}.png)`}))));
  assert.equal(report.cellCount, 105); assert.equal(report.cells.length, 100); assert.equal(report.attachments.length, 100);
  assert.equal(report.truncated, true);
  assert.throws(() => inspectJupyterNotebookImport(' '.repeat(4_194_305)), /4 MiB/);
  assert.throws(() => inspectJupyterNotebookImport(notebook(Array.from({length: 10_001}, () => code([])))), /10,000 cells/);
  assert.throws(() => inspectJupyterNotebookImport(notebook([]), {availablePaths: Array(129).fill('path')}), /128 source paths/);
  assert.throws(() => inspectJupyterNotebookImport('{"nbformat":3}'), /nbformat 4/);
});

it('counts the renderer-selected MIME representation while safely inspecting unused valid text', () => {
  const source = notebook([code([
    {output_type: 'display_data', data: {'image/png': 'YWJj', 'text/html': 4, 'text/plain': 'https://example.test/image-fallback'}},
    {output_type: 'display_data', data: {'text/html': '<p>Preferred HTML</p>', 'text/markdown': 4}},
    {output_type: 'display_data', data: {'text/html': 4, 'text/plain': 'https://example.test/unused-fallback'}}
  ])]);
  const report = inspectJupyterNotebookImport(source);
  assert.deepEqual(report.savedOutputs, {total: 3, supported: 2, unsupported: 1, codeCellsWithoutOutput: 0, malformed: 1, widgets: 0});
  assert.equal(report.unsupported.length, 1);
  assert.deepEqual(report.externalReferences.map(item => item.value), ['https://example.test/image-fallback', 'https://example.test/unused-fallback']);
  const html = render(source);
  assert.match(html, /src="data:image\/png;base64,YWJj"/);
  assert.match(html, /Preferred HTML/);
  assert.equal((html.match(/Cannot display this saved output/g) ?? []).length, 1);
  assert.doesNotMatch(html, /unused-fallback/);
});
