import {parser} from '@lezer/html';

const MAX_BYTES = 4_194_304;
const MAX_CELLS = 1000;
const TYPES = Object.freeze({js: 'module', ts: 'text/x-typescript',
  ojs: 'application/vnd.observable.javascript', md: 'text/markdown', html: 'text/html',
  tex: 'application/x-tex', dot: 'text/vnd.graphviz', sql: 'application/sql',
  'sql.view': 'application/sql+view', node: 'application/vnd.node.javascript',
  python: 'text/x-python', r: 'text/x-r'});
const MODES = new Map(Object.entries(TYPES).map(([mode, type]) => [type, mode]));
const recovery = message => new TypeError(`${message} Open Source view to edit the original notebook.`);
const slice = (source, node) => source.slice(node.from, node.to);
const tagName = (source, node) => {
  const name = node?.getChild('TagName');
  return name ? slice(source, name).toLowerCase() : null;
};

function attributes(source, tag) {
  const values = new Map();
  for (const attribute of tag.getChildren('Attribute')) {
    const nameNode = attribute.getChild('AttributeName');
    if (!nameNode) throw recovery('A cell attribute is malformed.');
    const name = slice(source, nameNode).toLowerCase();
    if (values.has(name)) throw recovery(`Duplicate ${name} attributes are ambiguous.`);
    const valueNode = attribute.getChild('AttributeValue') ?? attribute.getChild('UnquotedAttributeValue');
    const quoted = valueNode?.name === 'AttributeValue';
    if (quoted && source[valueNode.from] !== source[valueNode.to - 1]) throw recovery('An attribute quote is incomplete.');
    values.set(name, {value: valueNode ? source.slice(valueNode.from + Number(quoted), valueNode.to - Number(quoted)) : '',
      from: valueNode ? valueNode.from + Number(quoted) : tag.to - 1,
      to: valueNode ? valueNode.to - Number(quoted) : tag.to - 1,
      hasValue: Boolean(valueNode)});
  }
  return values;
}

// Match Notebook Kit's raw-text escape and dedent rules without serializing the
// containing document. Untouched cells and unknown metadata keep their bytes.
function decodeValue(body) {
  const lines = body.replace(/<\\(?=\\*\/script(\s|>))/gi, '<').split(/\r\n?|\n/);
  if (/^\s*$/.test(lines.at(-1))) lines.pop();
  if (/^\s*$/.test(lines[0])) lines.shift();
  return lines.map(line => line.replace(/^ {4}/, '')).join('\n');
}

function encodedBody(value, newline) {
  if (typeof value !== 'string') throw recovery('Cell source must be text.');
  const escaped = value.replace(/<(?=\\*\/script(\s|>))/gi, '<\\');
  return newline + escaped.split(/\r\n?|\n/).map(line => `    ${line}`).join(newline) + newline + '  ';
}

function inspect(source) {
  if (typeof source !== 'string' || new TextEncoder().encode(source).length > MAX_BYTES) {
    throw recovery('Notebook source must be at most 4 MiB.');
  }
  const tree = parser.parse(source);
  const notebooks = [], scripts = [];
  const cursor = tree.cursor();
  do {
    if (cursor.type.isError || ['MismatchedCloseTag', 'IncompleteTag', 'IncompleteCloseTag', 'InvalidEntity'].includes(cursor.name)) {
      throw recovery('Notebook markup needs repair before editing cells.');
    }
    if (cursor.name !== 'Element') continue;
    const node = cursor.node, open = node.firstChild;
    const name = tagName(source, open);
    if (name === 'notebook') notebooks.push(node);
    if (name === 'script') scripts.push(node);
  } while (cursor.next());
  if (notebooks.length !== 1) throw recovery('Choose a document containing exactly one notebook.');
  const notebook = notebooks[0], open = notebook.firstChild, close = notebook.lastChild;
  if (open?.name !== 'OpenTag' || open.lastChild?.name !== 'EndTag' || slice(source, open.lastChild) !== '>'
    || close?.name !== 'CloseTag' || tagName(source, close) !== 'notebook') {
    throw recovery('The notebook needs explicit opening and closing tags.');
  }
  for (let ancestor = notebook.parent; ancestor; ancestor = ancestor.parent) {
    if (['template', 'svg', 'math', 'noscript', 'textarea', 'title', 'script', 'style'].includes(tagName(source, ancestor.firstChild))) {
      throw recovery('This notebook is inside an unsupported HTML container.');
    }
  }
  const notebookAttributes = attributes(source, open);
  const ids = new Set(), cells = [];
  for (const node of scripts) {
    if (node.from < open.to || node.to > close.from) continue;
    if (node.parent?.name !== 'Element' || node.parent.from !== notebook.from || node.parent.to !== notebook.to) {
      throw recovery('Nested script cells must be edited in Source view.');
    }
    const start = node.firstChild, end = node.lastChild;
    if (start?.name !== 'OpenTag' || start.lastChild?.name !== 'EndTag' || slice(source, start.lastChild) !== '>'
      || end?.name !== 'CloseTag' || tagName(source, end) !== 'script') {
      throw recovery('Each cell needs explicit script opening and closing tags.');
    }
    const attrs = attributes(source, start), rawId = attrs.get('id')?.value;
    const id = Number(rawId);
    if (!/^[1-9][0-9]*$/.test(rawId ?? '') || !Number.isSafeInteger(id) || ids.has(id)) {
      throw recovery('Cell IDs must be unique positive safe integers.');
    }
    ids.add(id);
    const type = attrs.get('type')?.value ?? 'module';
    const mode = MODES.get(type || 'module');
    if (!mode) throw recovery(`Cell ${id} has an unsupported source type.`);
    cells.push({id, mode, value: decodeValue(source.slice(start.to, end.from)),
      from: node.from, to: node.to, bodyFrom: start.to, bodyTo: end.from, attrs});
    if (cells.length > MAX_CELLS) throw recovery('Notebook exceeds 1,000 cells.');
  }
  return {cells, insertOffset: close.from, readOnly: notebookAttributes.has('readonly')};
}

export function parseNotebookCells(source) {
  const result = inspect(source);
  return {...result, cells: result.cells.map(({attrs, ...cell}) => cell)};
}

function replace(source, edits) {
  let result = source;
  for (const {from, to, text} of edits.sort((a, b) => b.from - a.from)) result = result.slice(0, from) + text + result.slice(to);
  return result;
}

/** Change one native cell operation; original source remains the storage model. */
export function changeNotebookCell(source, {action, id, value, mode, direction} = {}) {
  const notebook = inspect(source);
  if (notebook.readOnly) throw recovery('This notebook is marked read-only.');
  const index = notebook.cells.findIndex(cell => cell.id === id);
  const cell = notebook.cells[index];
  if ((action !== 'insert' && !cell) || (action === 'insert' && id !== undefined && !cell)) {
    throw recovery('The selected cell is no longer in this source.');
  }
  if (mode !== undefined && !Object.hasOwn(TYPES, mode)) throw recovery('Choose a supported cell source type.');
  const newline = source.includes('\r\n') && !/(^|[^\r])\n/.test(source) ? '\r\n' : '\n';
  const nextId = () => {
    const next = Math.max(0, ...notebook.cells.map(item => item.id)) + 1;
    if (!Number.isSafeInteger(next)) throw recovery('No safe sequential cell ID is available.');
    return next;
  };
  let result;
  if (action === 'edit') {
    const edits = [];
    if (value !== undefined && value !== cell.value) edits.push({from: cell.bodyFrom, to: cell.bodyTo, text: encodedBody(value, newline)});
    if (mode !== undefined && mode !== cell.mode) {
      const type = cell.attrs.get('type');
      if (type?.hasValue) edits.push({from: type.from, to: type.to, text: TYPES[mode]});
      else if (type) throw recovery('The cell type attribute needs a value.');
      else edits.push({from: cell.bodyFrom - 1, to: cell.bodyFrom - 1, text: ` type="${TYPES[mode]}"`});
    }
    result = replace(source, edits);
  } else if (action === 'insert' || action === 'duplicate') {
    if (notebook.cells.length >= MAX_CELLS) throw recovery('Notebook exceeds 1,000 cells.');
    const newId = nextId();
    const content = action === 'duplicate'
      ? replace(source.slice(cell.from, cell.to), [{from: cell.attrs.get('id').from - cell.from,
          to: cell.attrs.get('id').to - cell.from, text: String(newId)}])
      : `<script id="${newId}" type="${TYPES[mode ?? 'js']}">${encodedBody(value ?? '', newline)}</script>`;
    const at = cell?.to ?? notebook.insertOffset;
    result = replace(source, [{from: at, to: at, text: newline + '  ' + content + (cell ? '' : newline)}]);
  } else if (action === 'remove') {
    result = replace(source, [{from: cell.from, to: cell.to, text: ''}]);
  } else if (action === 'move') {
    if (!['up', 'down'].includes(direction)) throw recovery('Choose an up or down cell move.');
    const target = notebook.cells[index + (direction === 'up' ? -1 : 1)];
    if (!target) return source;
    result = replace(source, [{from: cell.from, to: cell.to, text: source.slice(target.from, target.to)},
      {from: target.from, to: target.to, text: source.slice(cell.from, cell.to)}]);
  } else throw recovery('Unknown cell action.');
  // Recheck size, count and structure before handing a draft back to the editor.
  inspect(result);
  return result;
}
