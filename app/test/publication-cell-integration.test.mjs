import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {PublicationCodeEditor} from '../src/components/PublicationCodeEditor.js';
import {parseNotebookCells, changeNotebookCell} from '../src/lib/notebookCells.js';
import {parseJupyterCells, changeJupyterCell} from '../src/lib/jupyterCells.js';

const source = '<!doctype html>\n<notebook data-owner="retained"><script id="1" type="module" pinned>const count = 1;</script><script id="7" type="text/markdown"></script></notebook>\n';
const tools = {parseNotebookCells, changeNotebookCell, parseJupyterCells, changeJupyterCell};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function monacoDouble() {
  let current = null, changed = () => {};
  const view = {
    options: {}, addCommand() {}, onDidChangeCursorPosition() {},
    onDidChangeModelContent(callback) {changed = callback;},
    getModel: () => current, getValue: () => current?.getValue() ?? '',
    setModel(model) {current = model;},
    executeEdits(_origin, edits) {assert.equal(edits.length, 1); current.setValue(edits[0].text);},
    updateOptions(options) {Object.assign(this.options, options);},
    saveViewState() {return {};}, restoreViewState() {}, dispose() {current = null;}
  };
  const kit = {monaco: {
    KeyMod: {CtrlCmd: 1}, KeyCode: {KeyS: 2}, Uri: {from: value => value},
    editor: {create: () => view, setTheme() {}, createModel(value, _language, uri) {
      const model = {uri, getValue: () => value,
        setValue(next) {value = next; if (current === model) changed();},
        getFullModelRange: () => ({}), dispose() {}};
      return model;
    }}
  }};
  return {kit, view};
}

function fixture(t, {value = source, loadEditor, loadCellTools = () => tools, preview, getSourceContext, loadFramework} = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', {url: 'https://studio.example.test/'});
  const globals = {document: dom.window.document, MutationObserver: dom.window.MutationObserver,
    DOMParser: dom.window.DOMParser, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), Worker: class {}};
  const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
  t.mock.method(globalThis, 'fetch', async () => ({ok: false})); // Preview assets stay offline; this tests source editing.
  const textarea = dom.window.document.createElement('textarea'); textarea.value = value;
  const fake = monacoDouble();
  const editor = PublicationCodeEditor({textarea, onSave() {}, draftPreviewEnabled: false,
    loadEditor: loadEditor ?? (() => fake.kit), loadCellTools, preview, getSourceContext, loadFramework});
  dom.window.document.body.append(textarea, editor.element, editor.cells, editor.tabs, editor.status, editor.preview);
  t.after(() => {
    editor.dispose(); dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  const button = name => [...editor.cells.querySelectorAll('button')].find(item => item.textContent === name);
  const body = editor.cells.querySelector('[aria-label="Cell source"]');
  const editCell = value => {body.value = value; body.dispatchEvent(new dom.window.Event('input', {bubbles: true}));};
  return {dom, textarea, editor, fake, button, body, editCell};
}

it('defaults to the current draft and refreshes fallback edits without loading saved-build controls', async t => {
  let savedLoads = 0, closed = 0;
  const f = fixture(t, {value: '<h1>Current draft</h1>', loadEditor: async () => {throw Error('Offline editor');},
    preview: () => {
      savedLoads++;
      const saved = document.createElement('section'); saved.textContent = 'Saved build';
      saved.closePreview = () => {closed++;}; return saved;
    }});
  await f.editor.open('index.html', f.textarea.value);
  const mode = f.editor.preview.querySelector('[aria-label="Preview mode"]');
  const frame = f.editor.preview.querySelector('iframe');
  assert.equal(mode.value, 'draft'); assert.equal(savedLoads, 0);
  assert.match(frame.srcdoc, /Current draft/);
  f.textarea.value = '<h1>Unsaved change</h1>';
  f.textarea.dispatchEvent(new f.dom.window.Event('input'));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.match(frame.srcdoc, /Unsaved change/); assert.equal(savedLoads, 0);
  mode.value = 'saved'; mode.dispatchEvent(new f.dom.window.Event('change'));
  assert.equal(savedLoads, 1); assert.equal(frame.getAttribute('srcdoc'), null);
  f.editor.showDraft(); assert.equal(closed, 1);
  assert.equal(mode.value, 'draft'); assert.match(frame.srcdoc, /Unsaved change/);
  mode.value = 'saved'; mode.dispatchEvent(new f.dom.window.Event('change'));
  assert.equal(savedLoads, 1, 'Saved controls are retained for deliberate reuse');
});

it('keeps Jupyter Cells and the JSON source model on the same unsaved buffer', async t => {
  const notebook = JSON.stringify({nbformat: 4, nbformat_minor: 5, metadata: {custom: 'retained'}, cells: [
    {id: 'code', cell_type: 'code', metadata: {}, source: 'x = 1', execution_count: 1,
      outputs: [{output_type: 'stream', name: 'stdout', text: '1'}]}
  ]}, null, 2);
  const f = fixture(t, {value: notebook});
  await f.editor.open('analysis.ipynb', notebook); await tick();
  assert.equal(f.button('Cells').getAttribute('aria-pressed'), 'true');
  f.editCell('x = 2');
  const changed = f.textarea.value;
  f.button('Source').click();
  assert.equal(f.fake.view.getValue(), changed);
  assert.equal(JSON.parse(changed).cells[0].outputs[0].text, '1');
  f.fake.view.executeEdits('source-edit', [{text: changed.replace('x = 2', 'x = 3')}]);
  f.button('Cells').click(); await tick();
  assert.equal(f.body.value, 'x = 3');
  assert.equal(JSON.parse(f.textarea.value).metadata.custom, 'retained');
});

it('retains a cell edit made before Monaco loads and synchronizes later Cells and Source edits', async t => {
  let resolve;
  const pending = new Promise(done => {resolve = done;});
  const f = fixture(t, {loadEditor: () => pending});
  const opening = f.editor.open('index.html', source);
  await tick();
  assert.equal(f.button('Cells').getAttribute('aria-pressed'), 'true');
  f.editCell('const count = 2;');
  const earlyDraft = f.textarea.value;
  assert.equal(parseNotebookCells(earlyDraft).cells[0].value, 'const count = 2;');
  resolve(f.fake.kit); await opening;
  f.button('Source').click();
  assert.equal(f.fake.view.getValue(), earlyDraft);
  assert.equal(f.editor.element.hidden, false);

  const sourceDraft = earlyDraft.replace('const count = 2;', 'const count = 3;');
  f.fake.view.executeEdits('typing', [{text: sourceDraft}]);
  assert.equal(f.textarea.value, sourceDraft);
  f.button('Cells').click(); await tick();
  assert.equal(f.body.value, 'const count = 3;');
  f.editCell('const count = 4;');
  assert.equal(f.fake.view.getValue(), f.textarea.value);
  assert.equal(f.button('Cells').getAttribute('aria-pressed'), 'true');
  assert.match(f.textarea.value, /data-owner="retained"/);
  assert.match(f.textarea.value, /type="module" pinned/);
  assert.match(f.textarea.value, /<script id="7" type="text\/markdown"><\/script>/);

  f.textarea.readOnly = true; await tick();
  assert.equal(f.body.disabled, true);
  f.button('Source').click();
  assert.equal(f.fake.view.options.readOnly, true);
});

it('uses the canonical draft when reopening an existing model and after resetting a file', async t => {
  const f = fixture(t);
  await f.editor.open('index.html', source); await tick();
  f.editCell('const count = 2;');
  const firstDraft = f.textarea.value;
  const otherSource = source.replace('const count = 1;', 'const other = 9;');
  f.textarea.value = otherSource;
  await f.editor.open('other.html', otherSource); await tick();
  assert.equal(f.body.value, 'const other = 9;');

  const restoredDraft = firstDraft.replace('const count = 2;', 'const count = 5;');
  f.textarea.value = restoredDraft;
  await f.editor.open('index.html', restoredDraft); await tick();
  assert.equal(f.fake.view.getValue(), restoredDraft, 'An older retained model must not restore its buffer over the canonical draft');
  assert.equal(f.body.value, 'const count = 5;');
  f.editor.reset();
  assert.equal(f.editor.cells.hidden, true);
  f.textarea.value = source;
  f.textarea.dispatchEvent(new f.dom.window.Event('input'));
  await f.editor.open('index.html', source); await tick();
  assert.equal(f.fake.view.getValue(), source);
  assert.equal(f.body.value, 'const count = 1;');
  assert.equal(f.button('Undo cell change').disabled, true);
});

it('preserves Cells and plain source fallback when Monaco fails, without activating cells for ordinary HTML', async t => {
  let reject, loads = 0;
  const pending = new Promise((_resolve, fail) => {reject = fail;});
  const f = fixture(t, {loadEditor: () => pending, loadCellTools: () => {loads++; return tools;}});
  const opening = f.editor.open('index.html', source);
  await tick();
  f.editCell('const count = 2;');
  reject(Error('Editor unavailable')); await opening;
  assert.equal(f.button('Cells').getAttribute('aria-pressed'), 'true');
  assert.equal(f.textarea.style.display, 'none');
  assert.equal(f.editor.element.hidden, true);
  f.button('Source').click();
  assert.equal(f.textarea.style.display, '');
  assert.equal(parseNotebookCells(f.textarea.value).cells[0].value, 'const count = 2;');
  f.textarea.value = f.textarea.value.replace('const count = 2;', 'const count = 3;');
  f.textarea.dispatchEvent(new f.dom.window.Event('input'));
  f.button('Cells').click(); await tick();
  assert.equal(f.body.value, 'const count = 3;');

  const ordinary = '<!doctype html><html><body><h1>Ordinary HTML</h1></body></html>';
  f.textarea.value = ordinary;
  await f.editor.open('ordinary.html', ordinary);
  assert.equal(f.editor.cells.hidden, true);
  assert.equal(f.textarea.style.display, '');
  assert.equal(f.textarea.value, ordinary);
  assert.equal(loads, 1, 'Ordinary HTML must not load Notebook tools');
});

it('downloads Framework HTML deliberately with a default limit and explicit larger-file consent', async t => {
  const exports = [], downloads = [];
  const context = {sourceRoot: 'src', readFile: async () => new Blob(['file']), readFileMetadata: async () => null};
  const f = fixture(t, {value: '# Current draft', loadEditor: async () => {throw Error('Plain source editor');},
    getSourceContext: () => context, loadFramework: async () => ({exportFrameworkStandalone: async options => {
      exports.push(options); return '<!doctype html><h1>Offline</h1>';
    }})});
  t.mock.method(f.dom.window.HTMLAnchorElement.prototype, 'click', function () {downloads.push(this.download);});
  await f.editor.open('src/index.md', f.textarea.value);
  const download = [...f.editor.preview.querySelectorAll('button')].find(node => node.textContent === 'Download HTML');
  const consent = f.editor.preview.querySelector('[name="allow-up-to-96-mib-standalone-html"]');
  assert.equal(download.hidden, false); assert.equal(consent.checked, false); assert.equal(exports.length, 0);
  await download.onclick();
  assert.equal(exports[0].outputProfile, 'default-32m'); assert.equal(exports[0].sizeAcknowledgment, null);
  assert.equal(exports[0].readFileMetadata, context.readFileMetadata);
  assert.deepEqual(downloads, ['index.html']);
  consent.checked = true;
  await download.onclick();
  assert.equal(exports[1].outputProfile, 'archive-96m');
  assert.equal(exports[1].sizeAcknowledgment, 'allow-up-to-96-mib-output');
  assert.match(f.editor.preview.textContent, /nothing was published/);
  f.textarea.value = '# Changed draft'; f.editor.refreshPreview();
  assert.equal(consent.checked, false, 'A changed draft does not inherit size consent');
  assert.equal(exports.length, 2, 'Refreshing the editor does not export anything');
});

it('discards a Framework export if the source or account changes while it is being prepared', async t => {
  let finish, validAccount = true, pendingOptions;
  const pending = new Promise(resolve => {finish = resolve;});
  const f = fixture(t, {value: '# Private draft', loadEditor: async () => {throw Error('Plain source editor');},
    getSourceContext: () => ({readFile: async () => new Blob(['file']), isCurrent: () => validAccount}),
    loadFramework: async () => ({exportFrameworkStandalone: options => {pendingOptions = options; return pending;}})});
  const downloads = [];
  t.mock.method(f.dom.window.HTMLAnchorElement.prototype, 'click', function () {downloads.push(this.download);});
  await f.editor.open('index.md', f.textarea.value);
  const download = [...f.editor.preview.querySelectorAll('button')].find(node => node.textContent === 'Download HTML');
  const exporting = download.onclick(); await tick();
  assert.equal(download.disabled, true); assert.equal(pendingOptions.isCurrent(), true);
  validAccount = false;
  assert.equal(pendingOptions.isCurrent(), false);
  finish('<h1>Private</h1>'); await exporting;
  assert.deepEqual(downloads, []); assert.equal(download.disabled, false);
});
