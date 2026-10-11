import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {NotebookCellEditor} from '../src/components/NotebookCellEditor.js';
import {parseNotebookCells, changeNotebookCell} from '../src/lib/notebookCells.js';
import {parseJupyterCells, changeJupyterCell} from '../src/lib/jupyterCells.js';

const tools = {parseNotebookCells, changeNotebookCell, parseJupyterCells, changeJupyterCell};
const source = '<!doctype html>\n<notebook data-owner="retained">\n<title>Research</title>\n<script id="1" type="module" pinned>const count = 1;</script>\n<script id="7" type="text/markdown"></script>\n</notebook>\n';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(t, {value = source, loadTools = () => tools} = {}) {
  const dom = new JSDOM('<!doctype html><body></body>');
  const textarea = dom.window.document.createElement('textarea'); textarea.value = value;
  const views = [], inputs = [];
  textarea.addEventListener('input', () => inputs.push(textarea.value));
  const editor = NotebookCellEditor({textarea, loadTools, onViewChange: cells => views.push(cells)});
  dom.window.document.body.append(textarea, editor.element);
  t.after(() => {editor.dispose(); dom.window.close();});
  const control = name => editor.element.querySelector(`[aria-label="${name}"]`);
  const button = name => [...editor.element.querySelectorAll('button')].find(item => item.textContent === name);
  const input = (name, value) => {const item = control(name); item.value = value; item.dispatchEvent(new dom.window.Event(item.tagName === 'SELECT' ? 'change' : 'input', {bubbles: true})); return item;};
  return {editor, textarea, views, inputs, control, button, input, dom};
}

it('opens native cells lazily without changing source and retains empty cells', async t => {
  let loads = 0;
  const f = fixture(t, {loadTools: () => {loads++; return tools;}});
  assert.equal(loads, 0);
  await f.editor.open('index.html');
  assert.equal(loads, 1); assert.equal(f.views.at(-1), true);
  assert.equal(f.control('Notebook cell').options.length, 2);
  assert.match(f.control('Notebook cell').options[1].textContent, /Empty cell/);
  assert.equal(f.control('Cell source').value, 'const count = 1;');
  assert.equal(f.button('Add cell').closest('details'), null);
  assert.equal(f.button('Undo cell change').closest('details'), null);
  const cellActions = f.button('Duplicate cell').closest('details');
  assert.equal(cellActions.open, false);
  assert.equal(cellActions.querySelector('summary').textContent, 'Cell actions');
  assert.equal(f.textarea.value, source); assert.equal(f.inputs.length, 0);
  f.button('Source').click(); assert.equal(f.views.at(-1), false);
  f.button('Cells').click(); await tick();
  assert.equal(loads, 1); assert.equal(f.views.at(-1), true);
  assert.equal(f.inputs.length, 0);
});

it('updates the canonical draft synchronously while retaining cell focus, caret and unrelated source', async t => {
  const f = fixture(t); await f.editor.open('index.html');
  const body = f.control('Cell source'); body.focus(); body.value = 'const count = 12;'; body.setSelectionRange(16, 16);
  body.dispatchEvent(new f.dom.window.Event('input', {bubbles: true}));
  assert.equal(f.inputs.length, 1);
  assert.equal(parseNotebookCells(f.textarea.value).cells[0].value, 'const count = 12;');
  assert.equal(f.dom.window.document.activeElement, body); assert.equal(body.selectionStart, 16);
  assert.match(f.textarea.value, /data-owner="retained"/); assert.match(f.textarea.value, /type="module" pinned/);
  assert.match(f.textarea.value, /<script id="7" type="text\/markdown"><\/script>/);
  assert.equal(f.views.at(-1), true, 'Its own input must not invalidate the structured editor');
  f.button('Undo cell change').click(); assert.equal(f.textarea.value, source);
});

it('changes language, adds, duplicates, moves and removes cells with Undo and stable identities', async t => {
  const f = fixture(t); await f.editor.open('index.html');
  f.input('Cell language', 'ts');
  assert.equal(parseNotebookCells(f.textarea.value).cells[0].mode, 'ts');
  f.button('Add cell').click();
  let cells = parseNotebookCells(f.textarea.value).cells;
  assert.deepEqual(cells.map(cell => cell.id), [1, 8, 7]); assert.equal(cells[1].value, '');
  assert.equal(f.control('Notebook cell').value, '8');
  f.input('Cell source', 'const value: number = 2;');
  f.button('Duplicate cell').click();
  assert.deepEqual(parseNotebookCells(f.textarea.value).cells.map(cell => cell.id), [1, 8, 9, 7]);
  assert.equal(f.control('Notebook cell').value, '9');
  f.button('Move cell up').click();
  assert.deepEqual(parseNotebookCells(f.textarea.value).cells.map(cell => cell.id), [1, 9, 8, 7]);
  f.button('Remove cell').click();
  assert.deepEqual(parseNotebookCells(f.textarea.value).cells.map(cell => cell.id), [1, 8, 7]);
  f.button('Undo cell change').click();
  assert.deepEqual(parseNotebookCells(f.textarea.value).cells.map(cell => cell.id), [1, 9, 8, 7]);
  assert.equal(f.control('Notebook cell').value, '9');
});

it('permits an empty notebook and bounds Undo without creating replacement cells', async t => {
  const f = fixture(t, {value: '<notebook><script id="1" type="module">0</script></notebook>'});
  await f.editor.open('index.html');
  for (let value = 1; value <= 12; value++) f.input('Cell source', String(value));
  for (let count = 0; count < 10; count++) f.button('Undo cell change').click();
  assert.equal(parseNotebookCells(f.textarea.value).cells[0].value, '2');
  assert.equal(f.button('Undo cell change').disabled, true);
  f.button('Remove cell').click();
  assert.equal(parseNotebookCells(f.textarea.value).cells.length, 0);
  assert.equal(f.control('Cell source').disabled, true);
  assert.equal(f.button('Add cell').disabled, false);
  f.button('Add cell').click();
  assert.equal(parseNotebookCells(f.textarea.value).cells.length, 1);
  assert.equal(parseNotebookCells(f.textarea.value).cells[0].value, '');
});

it('external source edits clear the structured snapshot and Undo while Source recovery stays available', async t => {
  const f = fixture(t); await f.editor.open('index.html'); f.input('Cell source', 'const edited = 2;');
  f.button('Source').click();
  f.textarea.value = source.replace('const count = 1;', 'const external = 3;');
  f.textarea.dispatchEvent(new f.dom.window.Event('input'));
  assert.equal(f.views.at(-1), false);
  assert.equal(f.button('Undo cell change').disabled, true);
  f.button('Cells').click(); await tick();
  assert.equal(f.control('Cell source').value, 'const external = 3;');
  assert.equal(f.button('Undo cell change').disabled, true);
  f.textarea.value = '<notebook><script id="bad">';
  f.textarea.dispatchEvent(new f.dom.window.Event('input'));
  f.button('Cells').click(); await tick();
  assert.equal(f.views.at(-1), false);
  assert.match(f.editor.element.textContent, /original source is preserved/);
  assert.equal(f.button('Source').disabled, false);
  assert.equal(f.textarea.value, '<notebook><script id="bad">');
});

it('blocks mutations for a disabled source or readonly native notebook', async t => {
  const f = fixture(t); await f.editor.open('index.html');
  f.textarea.disabled = true; await tick();
  assert.equal(f.button('Add cell').disabled, true); assert.equal(f.control('Cell source').disabled, true);
  f.input('Cell source', 'not applied'); assert.equal(f.textarea.value, source);
  f.textarea.disabled = false; await tick();
  assert.equal(f.button('Add cell').disabled, false);
  f.textarea.value = source.replace('<notebook ', '<notebook readonly ');
  f.textarea.dispatchEvent(new f.dom.window.Event('input'));
  await f.editor.open('readonly.html');
  assert.equal(f.control('Cell source').disabled, true); assert.equal(f.button('Remove cell').disabled, true);
  assert.match(f.editor.element.textContent, /marked read-only/);
  assert.equal(f.button('Source').disabled, false);
});

it('ignores lazy results after source changes, hiding or disposal without losing the source', async t => {
  for (const action of ['hide', 'dispose']) {
    const f = fixture(t); await f.editor.open('index.html');
    f.input('Cell source', 'const abandoned = 5;');
    const retained = f.textarea.value;
    assert.match(f.control('Notebook cell').textContent, /abandoned/);
    f.editor[action]();
    assert.equal(f.control('Cell source').value, '', action);
    assert.equal(f.control('Notebook cell').options.length, 0, action);
    assert.equal(f.button('Undo cell change').disabled, true, action);
    assert.equal(f.textarea.value, retained, 'Hiding abandons cell controls without changing canonical source');
  }
  for (const action of ['input', 'hide', 'dispose']) {
    let resolve;
    const f = fixture(t, {loadTools: () => new Promise(done => {resolve = done;})});
    const opening = f.editor.open('index.html'); await tick();
    const newer = source.replace('const count = 1;', 'const newer = 4;');
    if (action === 'input') {f.textarea.value = newer; f.textarea.dispatchEvent(new f.dom.window.Event('input'));}
    else f.editor[action]();
    resolve(tools); await opening;
    assert.equal(f.views.at(-1), false, action);
    assert.equal(f.inputs.length, action === 'input' ? 1 : 0);
    assert.equal(f.textarea.value, action === 'input' ? newer : source);
  }
});

it('edits Jupyter cell bodies, preserves saved outputs and exact Undo, and discloses the execution boundary', async t => {
  const notebook = JSON.stringify({nbformat: 4, nbformat_minor: 5, metadata: {language_info: {name: 'python'}}, cells: [
    {id: 'calculation', cell_type: 'code', metadata: {tags: ['retained']}, source: ['x = 1\n', 'x'], execution_count: 7,
      outputs: [{output_type: 'stream', name: 'stdout', text: '1\n'}]},
    {id: 'narrative', cell_type: 'markdown', metadata: {}, source: '# Original'}
  ]}, null, 2);
  const f = fixture(t, {value: notebook}); await f.editor.open('analysis.ipynb');
  assert.equal(f.editor.element.hidden, false); assert.equal(f.inputs.length, 0);
  assert.equal(f.control('Cell source').value, 'x = 1\nx');
  assert.equal(f.button('Add cell').hidden, false);
  assert.deepEqual([...f.control('New cell type').options].map(option => option.value), ['code', 'markdown', 'raw']);
  assert.match(f.editor.element.textContent, /Saved outputs are retained and may be stale/);
  f.input('Cell source', 'x = 2\nx');
  const edited = JSON.parse(f.textarea.value), original = JSON.parse(notebook);
  assert.equal(edited.cells[0].source.join(''), 'x = 2\nx');
  assert.deepEqual(edited.cells[0].outputs, original.cells[0].outputs);
  assert.deepEqual(edited.cells[0].metadata, original.cells[0].metadata);
  assert.equal(edited.cells[0].execution_count, 7);
  f.button('Source').click(); f.button('Cells').click(); await tick();
  assert.equal(f.control('Cell source').value, 'x = 2\nx');
  f.input('Notebook cell', '1'); f.input('Cell source', '# Edited');
  assert.equal(JSON.parse(f.textarea.value).cells[1].source, '# Edited');
  f.button('Undo cell change').click(); f.button('Undo cell change').click();
  assert.equal(f.textarea.value, notebook);
  f.textarea.value = source; f.textarea.dispatchEvent(new f.dom.window.Event('input'));
  await f.editor.open('native.html');
  assert.equal(f.button('Add cell').hidden, false);
  assert.equal(f.control('Cell language').parentElement.hidden, false);
});

it('honors Jupyter per-cell readonly metadata and preserves malformed source for recovery', async t => {
  const notebook = JSON.stringify({nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
    {id: 'locked', cell_type: 'raw', metadata: {editable: false}, source: 'Retained raw source'},
    {id: 'open', cell_type: 'markdown', metadata: {}, source: 'Editable source'}
  ]});
  const f = fixture(t, {value: notebook}); await f.editor.open('analysis.ipynb');
  assert.equal(f.control('Cell source').disabled, true);
  f.input('Cell source', 'not applied'); assert.equal(f.textarea.value, notebook);
  f.input('Notebook cell', '1'); assert.equal(f.control('Cell source').disabled, false);
  f.textarea.readOnly = true; await tick();
  assert.equal(f.control('Cell source').disabled, true);
  f.textarea.readOnly = false;
  f.textarea.value = '{"cells":['; f.textarea.dispatchEvent(new f.dom.window.Event('input'));
  f.button('Cells').click(); await tick();
  assert.equal(f.views.at(-1), false);
  assert.match(f.editor.element.textContent, /original source is preserved/);
  assert.equal(f.textarea.value, '{"cells":[');
  assert.equal(f.button('Source').disabled, false);
});

it('adds, duplicates, moves and removes Jupyter cells with selected-cell continuity and exact Undo', async t => {
  const notebook = JSON.stringify({nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
    {id: 'calculation', cell_type: 'code', metadata: {custom: true}, source: ['x = 1'], execution_count: 3,
      outputs: [{output_type: 'stream', name: 'stdout', text: 'saved'}]},
    {id: 'narrative', cell_type: 'markdown', metadata: {}, source: '# Retained'}
  ]});
  const f = fixture(t, {value: notebook}); await f.editor.open('analysis.ipynb');
  f.button('Duplicate cell').click();
  let cells = JSON.parse(f.textarea.value).cells;
  const duplicateId = cells[1].id;
  assert.notEqual(duplicateId, cells[0].id);
  assert.deepEqual({...cells[1], id: cells[0].id}, cells[0]);
  assert.equal(f.control('Notebook cell').value, '1');
  f.button('Move cell down').click();
  assert.equal(JSON.parse(f.textarea.value).cells[2].id, duplicateId);
  assert.equal(f.control('Notebook cell').value, '2');
  f.input('New cell type', 'raw');
  assert.equal(JSON.parse(f.textarea.value).cells[2].cell_type, 'code', 'Type selector only chooses a new cell type');
  f.button('Add cell').click(); f.input('Cell source', 'New raw note');
  cells = JSON.parse(f.textarea.value).cells;
  assert.equal(cells[3].cell_type, 'raw'); assert.equal(parseJupyterCells(f.textarea.value).cells[3].value, 'New raw note');
  assert.equal(f.control('Notebook cell').value, '3');
  const beforeRemoval = f.textarea.value;
  f.button('Remove cell').click();
  assert.equal(f.control('Notebook cell').value, '2');
  f.button('Undo cell change').click();
  assert.equal(f.textarea.value, beforeRemoval); assert.equal(f.control('Notebook cell').value, '3');
  for (let count = 0; count < 5; count++) f.button('Undo cell change').click();
  assert.equal(f.textarea.value, notebook, 'Every operation restores the exact original source');
  f.textarea.value = JSON.stringify({nbformat: 4, nbformat_minor: 5, metadata: {}, cells: []});
  f.textarea.dispatchEvent(new f.dom.window.Event('input')); await f.editor.open('empty.ipynb');
  f.button('Add cell').click();
  assert.equal(f.control('Notebook cell').value, '0');
  assert.equal(JSON.parse(f.textarea.value).cells[0].cell_type, 'code');
  f.button('Remove cell').click(); assert.equal(JSON.parse(f.textarea.value).cells.length, 0);
});

it('honors Jupyter deletion and movement locks while allowing a preserved readonly duplicate', async t => {
  const notebook = JSON.stringify({nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
    {id: 'left', cell_type: 'raw', metadata: {}, source: 'left'},
    {id: 'fixed', cell_type: 'markdown', metadata: {editable: false, deletable: false}, source: '# Fixed'},
    {id: 'right', cell_type: 'raw', metadata: {}, source: 'right'}
  ]});
  const f = fixture(t, {value: notebook}); await f.editor.open('locked.ipynb');
  assert.equal(f.button('Move cell down').disabled, true, 'Cannot move across a locked cell');
  f.input('Notebook cell', '1');
  assert.equal(f.button('Remove cell').disabled, true);
  assert.equal(f.button('Move cell up').disabled, true); assert.equal(f.button('Move cell down').disabled, true);
  assert.equal(f.control('Cell source').disabled, true);
  f.button('Duplicate cell').click();
  assert.equal(JSON.parse(f.textarea.value).cells[2].metadata.deletable, false);
  assert.equal(f.control('Notebook cell').value, '2');
  assert.equal(f.control('Cell source').disabled, true);
  f.button('Undo cell change').click(); assert.equal(f.textarea.value, notebook);
  f.input('Notebook cell', '2'); assert.equal(f.button('Move cell up').disabled, true);
});
