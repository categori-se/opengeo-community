import {parseJupyterNotebook, notebookText} from './jupyterNotebook.js';

const MAX_BYTES = 4_194_304;
const MAX_CELLS = 1000;
const recovery = message => new TypeError(`${message} Open Source view to edit the original notebook.`);
const byteLength = value => new TextEncoder().encode(value).length;

// JSON.parse validates the document. This scanner records cell/token offsets and
// rejects duplicate keys, whose last-value semantics are ambiguous for editing.
// It never reconstructs the containing notebook, existing cells or their metadata.
function sourceRanges(source, start) {
  let position = start;
  let cellsRange;
  const ranges = [];
  const whitespace = () => {while (/[\t\n\r ]/.test(source[position] ?? '') && position < source.length) position++;};
  function string() {
    const from = position++;
    while (position < source.length) {
      const char = source[position++];
      if (char === '\\') position++;
      else if (char === '"') return {from, to: position};
    }
    throw recovery('A JSON string is incomplete.');
  }
  function value(depth, context) {
    if (depth > 128) throw recovery('Notebook JSON is too deeply nested for cell editing.');
    whitespace();
    const from = position, type = source[position];
    const range = {from, to: undefined, array: type === '['};
    if (typeof context === 'number') ranges[context] = range;
    if (context === 'cells') cellsRange = range;
    if (type === '"') string();
    else if (type === '{') {
      position++; whitespace();
      const keys = new Set();
      while (source[position] !== '}') {
        const keyRange = string();
        const key = JSON.parse(source.slice(keyRange.from, keyRange.to));
        if (keys.has(key)) throw recovery('Duplicate JSON keys make cell editing ambiguous.');
        keys.add(key); whitespace(); position++; // Validated colon.
        const child = value(depth + 1, context === 'notebook' && key === 'cells' ? 'cells' : null);
        if (typeof context === 'number' && ['source', 'id'].includes(key)) range[key] = child;
        whitespace();
        if (source[position] !== ',') break;
        position++; whitespace();
      }
      position++; // Validated closing brace.
    } else if (type === '[') {
      position++; whitespace();
      let index = 0;
      while (source[position] !== ']') {
        const child = value(depth + 1, context === 'cells' ? index : null); index++;
        whitespace();
        if (source[position] !== ',') break;
        if (context === 'cells') child.commaAfter = position;
        position++; whitespace();
      }
      position++; // Validated closing bracket.
    } else {
      while (position < source.length && !/[\t\n\r ,}\]]/.test(source[position])) position++;
    }
    range.to = position;
    return range;
  }
  value(0, 'notebook');
  return {ranges, cellsRange};
}

function inspect(source) {
  if (typeof source !== 'string' || byteLength(source) > MAX_BYTES) {
    throw recovery('Notebook source must be at most 4 MiB.');
  }
  // The file workspace normally retains the BOM outside its textarea; accepting
  // one here also preserves exact source for direct helper callers.
  const start = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let notebook;
  try {notebook = parseJupyterNotebook(source.slice(start));}
  catch {throw recovery('Choose valid Jupyter nbformat 4 source with supported cell records.');}
  if (notebook.cells.length > MAX_CELLS) throw recovery('Cell editing supports at most 1,000 cells.');
  const {ranges, cellsRange} = sourceRanges(source, start);
  if (!cellsRange || ranges.length !== notebook.cells.length || ranges.some(range => !range?.source)) {
    throw recovery('A cell source could not be located without changing the notebook.');
  }
  const readOnly = notebook.metadata.editable === false;
  return {ranges, cellsRange, notebook, readOnly, cells: notebook.cells.map((cell, id) => {
    const cellReadOnly = readOnly || cell.metadata.editable === false;
    const deletable = !readOnly && cell.metadata.deletable !== false;
    return {id, mode: cell.cell_type, value: notebookText(cell.source), readOnly: cellReadOnly,
      deletable, movable: !cellReadOnly && deletable};
  })};
}

/** No kernel, output mutation, attachment or network reads. */
export function parseJupyterCells(source) {
  const {cells, readOnly} = inspect(source);
  return {cells, readOnly};
}

function replace(source, edits) {
  let result = source;
  for (const {from, to, text} of edits.sort((a, b) => b.from - a.from)) {
    result = result.slice(0, from) + text + result.slice(to);
  }
  return result;
}

function newCellId(notebook) {
  const base = globalThis.crypto?.randomUUID?.();
  if (!base) throw recovery('A new cell ID could not be generated.');
  const existing = new Set(notebook.cells.map(cell => cell.id));
  let candidate = base, suffix = 1;
  while (existing.has(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

/** Apply one cell operation to the existing source buffer, retaining other bytes. */
export function changeJupyterCell(source, change) {
  const fields = {edit: ['action', 'id', 'value'], insert: ['action', 'id', 'mode', 'value'],
    duplicate: ['action', 'id'], move: ['action', 'id', 'direction'], remove: ['action', 'id']};
  if (!change || typeof change !== 'object' || Array.isArray(change)
    || !Object.hasOwn(fields, change.action) || Object.keys(change).some(key => !fields[change.action].includes(key))) {
    throw recovery('Choose a supported Jupyter cell action; change existing cell types in Source.');
  }
  const {action, id, direction} = change;
  const mode = change.mode ?? 'code', value = action === 'insert' && change.value === undefined ? '' : change.value;
  if (!(action === 'insert' && id === undefined) && (!Number.isSafeInteger(id) || id < 0)) {
    throw recovery('Choose an existing Jupyter cell.');
  }
  if (action === 'insert' && (!['code', 'markdown', 'raw'].includes(mode) || change.mode === null)) {
    throw recovery('Choose a code, Markdown or raw cell type.');
  }
  if (['edit', 'insert'].includes(action) && typeof value !== 'string') {
    throw recovery('Cell source must be text.');
  }
  if (typeof value === 'string' && (value.length > MAX_BYTES || byteLength(value) > MAX_BYTES)) {
    throw recovery('Cell source must fit within the 4 MiB notebook limit.');
  }
  if (action === 'move' && !['up', 'down'].includes(direction)) throw recovery('Choose an up or down cell move.');
  const inspected = inspect(source), cell = inspected.cells[id], range = inspected.ranges[id];
  if (inspected.readOnly) throw recovery('This Jupyter notebook is marked read-only.');
  if (!cell && (action !== 'insert' || id !== undefined)) throw recovery('The selected Jupyter cell no longer exists.');
  let result;
  if (action === 'edit') {
    if (cell.readOnly) throw recovery('This Jupyter cell is marked read-only.');
    if (cell.value === value) return source;
    const token = range.source;
    result = replace(source, [{...token, text: JSON.stringify(token.array ? value.match(/[^\n]*\n|[^\n]+$/g) ?? [] : value)}]);
  } else if (action === 'insert' || action === 'duplicate') {
    if (inspected.cells.length >= MAX_CELLS) throw recovery('Cell editing supports at most 1,000 cells.');
    const freshId = newCellId(inspected.notebook);
    let content;
    if (action === 'duplicate') {
      const idEdit = range.id
        ? {from: range.id.from - range.from, to: range.id.to - range.from, text: JSON.stringify(freshId)}
        : {from: 1, to: 1, text: `"id":${JSON.stringify(freshId)},`};
      content = replace(source.slice(range.from, range.to), [idEdit]);
    } else {
      const created = {id: freshId, cell_type: mode, metadata: {}, source: value};
      if (mode === 'code') Object.assign(created, {execution_count: null, outputs: []});
      content = JSON.stringify(created);
    }
    const after = id ?? inspected.cells.length - 1;
    const previous = inspected.ranges[after];
    // Reuse the selected cell's leading whitespace, including CRLF, while all
    // original separators and surrounding whitespace retain their exact bytes.
    const spacing = previous ? source.slice(after > 0 ? inspected.ranges[after - 1].commaAfter + 1
      : inspected.cellsRange.from + 1, previous.from) : '';
    const at = previous?.to ?? inspected.cellsRange.to - 1;
    result = replace(source, [{from: at, to: at, text: `${previous ? ',' + spacing : ''}${content}`}]);
  } else if (action === 'remove') {
    if (!cell.deletable) throw recovery('This Jupyter cell does not allow deletion.');
    const comma = range.commaAfter ?? inspected.ranges[id - 1]?.commaAfter;
    const edits = [{from: range.from, to: range.to, text: ''}];
    if (comma !== undefined) edits.push({from: comma, to: comma + 1, text: ''});
    result = replace(source, edits);
  } else {
    const adjacent = id + (direction === 'up' ? -1 : 1), target = inspected.cells[adjacent];
    // Moving past a locked cell changes its order too, so both must be movable.
    if (!cell.movable || target && !target.movable) throw recovery('Cells cannot move across read-only or nondeletable cells.');
    if (!target) return source;
    const targetRange = inspected.ranges[adjacent];
    result = replace(source, [{from: range.from, to: range.to, text: source.slice(targetRange.from, targetRange.to)},
      {from: targetRange.from, to: targetRange.to, text: source.slice(range.from, range.to)}]);
  }
  // Recheck limits and structure before handing a changed draft to the editor.
  inspect(result);
  return result;
}
