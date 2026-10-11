import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {deserialize} from '@observablehq/notebook-kit';
import {parseNotebookCells, changeNotebookCell} from '../src/lib/notebookCells.js';

const wrap = cells => `<!doctype html>\n<!-- original header -->\n<notebook theme="light-dark(air,midnight)" data-owner='retained'>\n<title>Original title</title>\n${cells}\n<!-- original footer -->\n</notebook>\n<meta data-custom="outside notebook">`;
const original = wrap(`<script id='7' type="module" pinned hidden output="answer" data-custom='untouched'>\n    const answer = 2;\n  </script>\n<!-- between cells -->\n<script id="19" type="text/markdown">\n    Value: \${answer}\n  </script>`);
const ids = source => parseNotebookCells(source).cells.map(cell => cell.id);
const unsafe = source => assert.throws(() => parseNotebookCells(source), /Source view/);

it('reads native source ranges and Kit values without changing unknown metadata or executing cells', () => {
  const source = original.replace('const answer = 2;', 'globalThis.notebookCellExecuted = true;');
  const parsed = parseNotebookCells(source);
  assert.deepEqual(parsed.cells.map(({id, mode}) => ({id, mode})), [{id: 7, mode: 'js'}, {id: 19, mode: 'md'}]);
  assert.equal(parsed.cells[0].value, 'globalThis.notebookCellExecuted = true;');
  assert.equal(source.slice(parsed.cells[0].from, parsed.cells[0].bodyFrom), `<script id='7' type="module" pinned hidden output="answer" data-custom='untouched'>`);
  assert.equal(source.slice(parsed.cells[0].bodyTo, parsed.cells[0].to), '</script>');
  assert.equal(source.slice(parsed.insertOffset, parsed.insertOffset + 11), '</notebook>');
  assert.equal(parsed.readOnly, false);
  assert.equal(globalThis.notebookCellExecuted, undefined);
});

it('edits only the selected body and keeps a no-op byte-identical', () => {
  const before = parseNotebookCells(original).cells[0];
  assert.equal(changeNotebookCell(original, {action: 'edit', id: 7, value: before.value}), original);
  const changed = changeNotebookCell(original, {action: 'edit', id: 7, value: 'const answer = 42;'});
  const after = parseNotebookCells(changed).cells[0];
  assert.equal(changed.slice(0, after.bodyFrom), original.slice(0, before.bodyFrom));
  assert.equal(changed.slice(after.bodyTo), original.slice(before.bodyTo));
  assert.equal(after.value, 'const answer = 42;');
});

it('changes a known type without rewriting attributes or unrelated cell bytes', () => {
  const changed = changeNotebookCell(original, {action: 'edit', id: 7, mode: 'ts'});
  assert.equal(changed, original.replace('type="module"', 'type="text/x-typescript"'));
  const withoutType = wrap('<script id="1" data-extra="x">const x=1;</script>');
  assert.equal(changeNotebookCell(withoutType, {action: 'edit', id: 1, mode: 'md'}),
    withoutType.replace('data-extra="x">', 'data-extra="x" type="text/markdown">'));
});

it('inserts and duplicates stable unique IDs while preserving original cells and copy metadata', () => {
  const inserted = changeNotebookCell(original, {action: 'insert', id: 7, mode: 'md', value: '# New section'});
  assert.deepEqual(ids(inserted), [7, 20, 19]);
  assert.equal(parseNotebookCells(inserted).cells[1].value, '# New section');
  for (const cell of parseNotebookCells(original).cells) assert(inserted.includes(original.slice(cell.from, cell.to)));
  const duplicate = changeNotebookCell(original, {action: 'duplicate', id: 7});
  const copy = parseNotebookCells(duplicate).cells[1], source = parseNotebookCells(original).cells[0];
  assert.deepEqual(ids(duplicate), [7, 20, 19]);
  assert.equal(duplicate.slice(copy.from, copy.to), original.slice(source.from, source.to).replace("id='7'", "id='20'"));
  assert.deepEqual(ids(changeNotebookCell(original, {action: 'insert'})), [7, 19, 20]);
});

it('moves exact cell blocks while retaining intervening content and removes only the selected block', () => {
  const [a, b] = parseNotebookCells(original).cells;
  const moved = changeNotebookCell(original, {action: 'move', id: 19, direction: 'up'});
  assert.equal(moved, original.slice(0, a.from) + original.slice(b.from, b.to)
    + original.slice(a.to, b.from) + original.slice(a.from, a.to) + original.slice(b.to));
  assert.deepEqual(ids(moved), [19, 7]);
  assert.equal(changeNotebookCell(moved, {action: 'move', id: 19, direction: 'down'}), original);
  assert.equal(changeNotebookCell(original, {action: 'move', id: 7, direction: 'up'}), original);
  assert.equal(changeNotebookCell(original, {action: 'remove', id: 7}), original.slice(0, a.from) + original.slice(a.to));
});

it('does not prune empty cells and permits adding after removing the last cell', () => {
  const empty = wrap('<script id="1" type="module"></script>');
  assert.equal(parseNotebookCells(empty).cells[0].value, '');
  assert.equal(changeNotebookCell(empty, {action: 'edit', id: 1, value: ''}), empty);
  const removed = changeNotebookCell(empty, {action: 'remove', id: 1});
  assert.equal(parseNotebookCells(removed).cells.length, 0);
  assert.deepEqual(ids(changeNotebookCell(removed, {action: 'insert', value: ''})), [1]);
});

it('round-trips closing-script text using Notebook Kit escapes, including existing backslashes', () => {
  const dom = new JSDOM('');
  try {
    for (const value of ['const a = "</script>";', 'const a = "<\\/script>";', 'const a = "<\\\\/SCRIPT >";',
      '\nconst a=1;\n  \n\t\n']) {
      const changed = changeNotebookCell(original, {action: 'edit', id: 7, value});
      assert.equal(parseNotebookCells(changed).cells[0].value, value);
      assert.equal(deserialize(changed, {parser: new dom.window.DOMParser()}).cells[0].value, value);
      assert.equal(parseNotebookCells(changed).cells.length, 2);
    }
  } finally {dom.window.close();}
});

it('preserves CRLF framing and arbitrary unknown attributes around edited source', () => {
  const source = original.replace(/\n/g, '\r\n');
  const changed = changeNotebookCell(source, {action: 'edit', id: 19, value: '# Edited\nNext line'});
  assert.doesNotMatch(changed, /(^|[^\r])\n/);
  const before = parseNotebookCells(source).cells[1], after = parseNotebookCells(changed).cells[1];
  assert.equal(source.slice(0, before.bodyFrom), changed.slice(0, after.bodyFrom));
  assert.equal(source.slice(before.bodyTo), changed.slice(after.bodyTo));
});

it('refuses duplicate, missing, encoded, fractional and unsafe IDs without silently renumbering', () => {
  for (const id of ['', '0', '-1', '01', '1.5', 'NaN', '&#49;', '9007199254740992']) unsafe(wrap(`<script id="${id}" type="module">x</script>`));
  unsafe(wrap('<script>x</script>'));
  unsafe(wrap('<script id="1">x</script><script id="1">y</script>'));
  unsafe(wrap('<script id="1" id="2">x</script>'));
});

it('refuses nested or recovered structures and unsupported raw contexts with Source-view recovery', () => {
  for (const source of ['<notebook><script id="1">x</script>', '<notebook><script id="1">x</notebook>',
    '<notebook><script id="1" type="module>x</script></notebook>',
    wrap('<div><script id="1">x</script></div>'),
    '<template>' + original + '</template>', '<svg>' + original + '</svg>',
    '<notebook/><script id="1">x</script></notebook>', '<notebook><script id="1"/>x</script></notebook>',
    original + '<notebook></notebook>', wrap('<script id="1" type="application/json">{}</script>'),
    '<notebook><script id="1">x</script></div></notebook>']) unsafe(source);
});

it('honors readonly, unknown action, missing selection and supported-mode boundaries', () => {
  const readonly = original.replace('<notebook ', '<notebook readonly ');
  assert.equal(parseNotebookCells(readonly).readOnly, true);
  assert.throws(() => changeNotebookCell(readonly, {action: 'edit', id: 7, value: 'x'}), /read-only.*Source view/);
  for (const action of [{action: 'edit', id: 99}, {action: 'insert', id: 99}, {action: 'edit', id: 7, mode: 'unknown'},
    {action: 'move', id: 7, direction: 'left'}, {action: 'run', id: 7}, {action: 'edit', id: 7, value: 42}]) {
    assert.throws(() => changeNotebookCell(original, action), /Source view/);
  }
  const interpreter = wrap('<script id="1" type="text/x-python" format="json" database="retained" data-extra="yes">print(1)</script>');
  assert.equal(parseNotebookCells(interpreter).cells[0].mode, 'python');
  assert.match(changeNotebookCell(interpreter, {action: 'edit', id: 1, value: 'print(2)'}), /format="json" database="retained" data-extra="yes"/);
});

it('enforces the existing byte and cell limits before and after changes', () => {
  assert.throws(() => parseNotebookCells('é'.repeat(2_097_153)), /4 MiB/);
  assert.throws(() => changeNotebookCell(original, {action: 'edit', id: 7, value: 'x'.repeat(4_194_304)}), /4 MiB/);
  const maximum = wrap(Array.from({length: 1000}, (_, index) => `<script id="${index + 1}"></script>`).join('\n'));
  assert.equal(parseNotebookCells(maximum).cells.length, 1000);
  assert.throws(() => changeNotebookCell(maximum, {action: 'insert'}), /1,000 cells/);
  assert.throws(() => changeNotebookCell(maximum, {action: 'duplicate', id: 1}), /1,000 cells/);
  unsafe(maximum.replace('</notebook>', '<script id="1001"></script></notebook>'));
  assert.throws(() => changeNotebookCell(wrap('<script id="9007199254740991"></script>'), {action: 'insert'}), /safe sequential/);
});
