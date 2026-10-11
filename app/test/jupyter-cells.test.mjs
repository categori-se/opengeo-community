import assert from 'node:assert/strict';
import {it} from 'node:test';
import {parseJupyterCells, changeJupyterCell} from '../src/lib/jupyterCells.js';

const code = (source = 'x = 1', extra = {}) => ({id: 'original-id', cell_type: 'code', metadata: {}, source,
  execution_count: 4, outputs: [{output_type: 'stream', name: 'stdout', text: 'saved output\n'}], ...extra});
const notebook = (cells, metadata = {}) => JSON.stringify({nbformat: 4, nbformat_minor: 5, metadata, cells});
const edit = (source, id, value) => changeJupyterCell(source, {action: 'edit', id, value});

it('edits only a string source token, preserving BOM, CRLF, escaped keys and all surrounding JSON bytes', () => {
  const token = '"x = \\u0031\\n"';
  const source = '\uFEFF{\r\n "nbformat":4,"nbformat_minor":5, "metadata":{"custom":1e+02,"untouched":"\\u0041"},\r\n'
    + ' "cells":[{"id":"original-id","cell_type":"code","metadata":{"tag":"keep"},"sour\\u0063e":'
    + token + ',"execution_count":4,"outputs":[{"output_type":"stream","name":"stdout","text":"saved\\n"}],'
    + '"attachments":{"image.png":{"image/png":"AA=="}},"unknown":{"preserve":true}},'
    + '{"id":"narrative","cell_type":"markdown","metadata":{},"source":"# Untouched"}]\r\n}\r\n';
  assert.deepEqual(parseJupyterCells(source), {readOnly: false, cells: [
    {id: 0, mode: 'code', value: 'x = 1\n', readOnly: false, deletable: true, movable: true},
    {id: 1, mode: 'markdown', value: '# Untouched', readOnly: false, deletable: true, movable: true}
  ]});
  assert.equal(edit(source, 0, 'x = 1\n'), source, 'An unchanged value retains the original escape spelling');
  const value = 'x = "2"\n# } ] \\ nested-looking text';
  const expected = source.replace(token, JSON.stringify(value));
  assert.equal(edit(source, 0, value), expected);
  assert.equal(parseJupyterCells(expected).cells[0].value, value);
});

it('retains source-array representation and saved outputs while editing existing Markdown and raw cells', () => {
  const source = notebook([
    code(['x = ', '1\r\n', '\r\n']),
    {id: 'markdown-id', cell_type: 'markdown', metadata: {}, source: ['# Heading\n'], attachments: {'image.png': {'image/png': 'AA=='}}},
    {id: 'raw-id', cell_type: 'raw', metadata: {format: 'text/plain'}, source: ''}
  ]);
  assert.equal(edit(source, 0, 'x = 1\r\n\r\n'), source, 'No-op retains original array segments');
  const changed = edit(source, 0, 'x = 2\r\n\r\nfinal');
  assert.deepEqual(JSON.parse(changed).cells[0].source, ['x = 2\r\n', '\r\n', 'final']);
  assert.deepEqual(JSON.parse(changed).cells[0].outputs, JSON.parse(source).cells[0].outputs);
  assert.equal(JSON.parse(changed).cells[0].execution_count, 4);
  const markdown = edit(changed, 1, '![Kept](attachment:image.png)\n');
  assert.deepEqual(JSON.parse(markdown).cells[1].attachments, {'image.png': {'image/png': 'AA=='}});
  const raw = edit(markdown, 2, 'Raw text');
  assert.equal(JSON.parse(raw).cells[2].source, 'Raw text');
  assert.deepEqual(JSON.parse(edit(raw, 0, '')).cells[0].source, []);
  assert.deepEqual(JSON.parse(raw).cells.map(cell => cell.id), ['original-id', 'markdown-id', 'raw-id']);
});

it('respects separate editing, deletion and movement restrictions, including adjacent locked cells', () => {
  const source = notebook([code('locked', {metadata: {editable: false}}),
    {cell_type: 'markdown', metadata: {}, source: 'editable'},
    {cell_type: 'raw', metadata: {deletable: false}, source: 'retained'}]);
  assert.equal(parseJupyterCells(source).readOnly, false);
  assert.deepEqual(parseJupyterCells(source).cells.map(({readOnly, deletable, movable}) => ({readOnly, deletable, movable})), [
    {readOnly: true, deletable: true, movable: false},
    {readOnly: false, deletable: true, movable: true},
    {readOnly: false, deletable: false, movable: false}
  ]);
  assert.throws(() => edit(source, 0, 'changed'), /read-only.*Open Source/);
  assert.equal(parseJupyterCells(edit(source, 1, 'changed')).cells[1].value, 'changed');
  assert.equal(parseJupyterCells(edit(source, 2, 'changed')).cells[2].value, 'changed');
  assert.throws(() => changeJupyterCell(source, {action: 'remove', id: 2}), /deletion.*Open Source/);
  assert.equal(parseJupyterCells(changeJupyterCell(source, {action: 'remove', id: 0})).cells.length, 2);
  const duplicate = JSON.parse(changeJupyterCell(source, {action: 'duplicate', id: 0})).cells[1];
  assert.equal(duplicate.metadata.editable, false);
  assert.deepEqual(duplicate.outputs, JSON.parse(source).cells[0].outputs);
  for (const [id, direction] of [[0, 'down'], [1, 'up'], [1, 'down'], [2, 'up']]) {
    assert.throws(() => changeJupyterCell(source, {action: 'move', id, direction}), /read-only or nondeletable.*Open Source/);
  }
  const locked = notebook([code()], {editable: false});
  assert.equal(parseJupyterCells(locked).readOnly, true);
  assert.deepEqual(parseJupyterCells(locked).cells.map(cell => [cell.readOnly, cell.deletable, cell.movable]), [[true, false, false]]);
  for (const change of [{action: 'edit', id: 0, value: 'changed'}, {action: 'insert', value: ''},
    {action: 'duplicate', id: 0}, {action: 'remove', id: 0}, {action: 'move', id: 0, direction: 'up'}]) {
    assert.throws(() => changeJupyterCell(locked, change), /read-only.*Open Source/);
  }
});

it('rejects duplicate JSON keys at any level, malformed source, invalid actions and existing cell type edits', () => {
  const valid = notebook([code()]);
  for (const source of [
    valid.replace('"nbformat":4', '"nbformat":3,"nbformat":4'),
    valid.replace('"source":"x = 1"', '"source":"first","sour\\u0063e":"x = 1"'),
    valid.replace('"metadata":{}', '"metadata":{"unknown":{"keep":1,"keep":2}}'),
    valid.replace('"name":"stdout"', '"name":"stderr","name":"stdout"'),
    valid.slice(0, -1), notebook([{...code(), source: [1]}]), notebook([code(), code()])
  ]) assert.throws(() => parseJupyterCells(source), /Open Source/);
  for (const change of [
    {action: 'insert', value: null}, {action: 'insert', mode: 'python'}, {action: 'insert', mode: null},
    {action: 'insert', id: 3}, {action: 'remove', id: 0, value: ''}, {action: 'duplicate', id: 3},
    {action: 'move', id: 0, direction: 'left'}, {action: 'edit', id: 0, value: '', mode: 'markdown'},
    {action: 'edit', id: -1, value: ''}, {action: 'edit', id: 'original-id', value: ''},
    {action: 'edit', id: 3, value: ''}, {action: 'edit', id: 0, value: null}, {action: '__proto__'}, null
  ]) assert.throws(() => changeJupyterCell(valid, change), /Open Source/);
  assert.deepEqual(parseJupyterCells(notebook([])), {cells: [], readOnly: false});
});

it('inserts each valid cell type, including empty and older notebooks, without changing existing cell records', () => {
  const source = notebook([code(), {id: 'tail', cell_type: 'raw', metadata: {}, source: 'tail'}]);
  for (const mode of ['code', 'markdown', 'raw']) {
    const changed = changeJupyterCell(source, {action: 'insert', id: 0, mode, value: 'new\r\ntext'});
    const cells = JSON.parse(changed).cells, added = cells[1];
    assert.equal(added.cell_type, mode);
    assert.equal(added.source, 'new\r\ntext');
    assert.match(added.id, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal(new Set(cells.map(cell => cell.id)).size, 3);
    assert.deepEqual(added.metadata, {});
    assert.deepEqual([cells[0], cells[2]], JSON.parse(source).cells);
    if (mode === 'code') {
      assert.equal(added.execution_count, null);
      assert.deepEqual(added.outputs, []);
    } else {
      assert.equal(Object.hasOwn(added, 'outputs'), false);
      assert.equal(Object.hasOwn(added, 'execution_count'), false);
    }
    assert.equal(changeJupyterCell(changed, {action: 'remove', id: 1}), source);
  }
  const appended = JSON.parse(changeJupyterCell(source, {action: 'insert'})).cells;
  assert.equal(appended[2].cell_type, 'code');
  assert.equal(appended[2].source, '');
  for (const minor of [0, 4, 5]) {
    const empty = '\uFEFF{\r\n "nbformat":4,"nbformat_minor":' + minor + ',"cells":[ \r\n ],"metadata":{}}\r\n';
    const inserted = changeJupyterCell(empty, {action: 'insert', mode: 'raw', value: 'first'});
    const added = JSON.parse(inserted.slice(1)).cells[0];
    assert.equal(added.source, 'first');
    assert.match(added.id, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal(changeJupyterCell(inserted, {action: 'remove', id: 0}), empty);
  }
});

it('duplicates only a cell record with a fresh ID, preserving escapes, outputs, attachments and unknown fields byte-for-byte', () => {
  const originalId = '"\\u0061"';
  const raw = '{ "i\\u0064":' + originalId + ',"cell_type":"code", "metadata":{"unknown":1e+02},\r\n'
    + ' "source":["x = 1\\n"],"execution_count":4,"outputs":[{"name":"stdout","output_type":"stream","text":"\\u0041"}],'
    + '"attachments":{"file.png":{"image/png":"AA=="}},"custom":{"source":true}}';
  const before = '\uFEFF{\r\n "nbformat":4,"nbformat_minor":5,"metadata":{"keep":1e-01},"cells":[\r\n  ';
  const after = '\r\n ]}\r\n';
  const source = before + raw + after;
  const changed = changeJupyterCell(source, {action: 'duplicate', id: 0});
  const cells = JSON.parse(changed.slice(1)).cells;
  assert.notEqual(cells[1].id, cells[0].id);
  assert.equal(changed, before + raw + ',\r\n  ' + raw.replace(originalId, JSON.stringify(cells[1].id)) + after);
  assert.deepEqual({...cells[1], id: cells[0].id}, cells[0]);
  const again = changeJupyterCell(changed, {action: 'duplicate', id: 1});
  assert.equal(new Set(JSON.parse(again.slice(1)).cells.map(cell => cell.id)).size, 3);
  for (const minor of [4, 5]) {
    const legacy = '{"nbformat":4,"nbformat_minor":' + minor + ',"metadata":{},"cells":[{"cell_type":"raw", "metadata":{}, "source":"old"}]}';
    const copy = JSON.parse(changeJupyterCell(legacy, {action: 'duplicate', id: 0}));
    assert.match(copy.cells[1].id, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal(copy.nbformat_minor, minor);
    assert.equal(copy.cells[0].id, undefined);
    assert.deepEqual({...copy.cells[1], id: undefined}, {...copy.cells[0], id: undefined});
  }
});

it('moves exact cell objects and removes only the chosen object and one comma, retaining BOM and mixed spacing', () => {
  const cells = [
    '{"id":"a","cell_type":"raw","metadata":{"n":1e+02},"source":"\\u0041"}',
    '{ "id":"b", "cell_type":"markdown", "metadata":{}, "source":["B"],"attachments":{"x":{"image/png":"AA=="}}}',
    JSON.stringify(code('C', {id: 'c'}))
  ];
  const before = '\uFEFF{\r\n "nbformat":4,"nbformat_minor":5,"metadata":{"untouched":1e-02},"cells":[\r\n  ';
  const between = [' \t,\r\n   ', '\r\n,\t'];
  const after = ' \r\n ]}\r\n';
  const source = before + cells[0] + between[0] + cells[1] + between[1] + cells[2] + after;
  const moved = changeJupyterCell(source, {action: 'move', id: 0, direction: 'down'});
  assert.equal(moved, before + cells[1] + between[0] + cells[0] + between[1] + cells[2] + after);
  assert.equal(changeJupyterCell(moved, {action: 'move', id: 1, direction: 'up'}), source);
  assert.equal(changeJupyterCell(source, {action: 'move', id: 0, direction: 'up'}), source);
  assert.equal(changeJupyterCell(source, {action: 'move', id: 2, direction: 'down'}), source);
  assert.equal(changeJupyterCell(source, {action: 'remove', id: 0}),
    before + between[0].replace(',', '') + cells[1] + between[1] + cells[2] + after);
  assert.equal(changeJupyterCell(source, {action: 'remove', id: 1}),
    before + cells[0] + between[0] + between[1].replace(',', '') + cells[2] + after);
  assert.equal(changeJupyterCell(source, {action: 'remove', id: 2}),
    before + cells[0] + between[0] + cells[1] + between[1].replace(',', '') + after);
});

it('bounds cell editing, input/output bytes and nested JSON while leaving larger notebooks to Source', () => {
  const cells = Array.from({length: 1000}, (_, index) => ({cell_type: 'raw', metadata: {}, source: `Cell ${index}`}));
  const accepted = notebook(cells);
  assert.equal(parseJupyterCells(accepted).cells.length, 1000);
  assert.equal(parseJupyterCells(edit(accepted, 999, 'last')).cells[999].value, 'last');
  for (const change of [{action: 'insert'}, {action: 'duplicate', id: 999}]) {
    assert.throws(() => changeJupyterCell(accepted, change), /1,000 cells.*Open Source/);
  }
  assert.equal(parseJupyterCells(changeJupyterCell(notebook(cells.slice(0, -1)), {action: 'insert'})).cells.length, 1000);
  assert.throws(() => parseJupyterCells(notebook([...cells, cells[0]])), /1,000 cells.*Open Source/);
  assert.throws(() => parseJupyterCells(notebook([code('x'.repeat(4_194_304))])), /4 MiB.*Open Source/);
  assert.throws(() => edit(notebook([code()]), 0, '\\'.repeat(2_097_152)), /4 MiB.*Open Source/);
  assert.throws(() => changeJupyterCell(notebook([]), {action: 'insert', value: '\\'.repeat(2_097_152)}), /4 MiB.*Open Source/);
  assert.throws(() => changeJupyterCell(notebook([code('x'.repeat(2_097_152))]), {action: 'duplicate', id: 0}), /4 MiB.*Open Source/);
  const nested = '{"nbformat":4,"nbformat_minor":5,"cells":[],"metadata":{"unknown":' + '['.repeat(130) + '0' + ']'.repeat(130) + '}}';
  assert.throws(() => parseJupyterCells(nested), /deeply nested.*Open Source/);
});
