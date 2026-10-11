// Shared by the Studio editor bundle and isolated publication builder.
// Native nbformat 4 source stays intact. Rendering never evaluates a kernel or
// changes cells, metadata, attachments, or saved outputs.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
export function notebookText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(line => typeof line === 'string')) return value.join('');
  throw new TypeError('Notebook text must be a string or an array of strings.');
}

export function parseJupyterNotebook(source) {
  if (typeof source !== 'string' || new TextEncoder().encode(source).length > 4_194_304) throw new TypeError('Notebook source must be at most 4 MiB.');
  const notebook = JSON.parse(source);
  if (!object(notebook) || notebook.nbformat !== 4 || !Number.isInteger(notebook.nbformat_minor) || notebook.nbformat_minor < 0
    || !object(notebook.metadata) || !Array.isArray(notebook.cells)) throw new TypeError('Choose a Jupyter notebook in nbformat 4.');
  if (notebook.cells.length > 10_000) throw new TypeError('Notebook exceeds 10,000 cells.');
  const ids = new Set();
  for (const [index, cell] of notebook.cells.entries()) {
    if (!object(cell) || !['code', 'markdown', 'raw'].includes(cell.cell_type) || !object(cell.metadata)) throw new TypeError(`Invalid cell ${index + 1}.`);
    notebookText(cell.source);
    if (cell.id !== undefined) {
      if (typeof cell.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(cell.id) || ids.has(cell.id)) throw new TypeError(`Invalid or duplicate cell id at cell ${index + 1}.`);
      ids.add(cell.id);
    }
    if (cell.cell_type === 'code' && (!Array.isArray(cell.outputs) || cell.execution_count !== null
      && (!Number.isInteger(cell.execution_count) || cell.execution_count < 0))) throw new TypeError(`Invalid outputs or execution count at cell ${index + 1}.`);
    if (cell.attachments !== undefined && !object(cell.attachments)) throw new TypeError(`Invalid attachments at cell ${index + 1}.`);
  }
  return notebook;
}

/** Describe a native import without executing code, rendering HTML or opening files. */
export function inspectJupyterNotebookImport(source, {path = 'index.ipynb', availablePaths = []} = {}) {
  const notebook = parseJupyterNotebook(source);
  if (!Array.isArray(availablePaths) || availablePaths.length > 128 || availablePaths.some(value => typeof value !== 'string')) {
    throw new TypeError('Notebook import inspection accepts at most 128 source paths.');
  }
  const available = new Set(availablePaths), attachments = new Map(), externalReferences = new Map();
  const unsupported = [], manualWork = new Set();
  const savedOutputs = {total: 0, supported: 0, unsupported: 0, codeCellsWithoutOutput: 0, malformed: 0, widgets: 0};
  const language = String(notebook.metadata.language_info?.name ?? notebook.metadata.kernelspec?.language ?? 'python').slice(0, 100);
  let truncated = notebook.cells.length > 100;
  const visible = value => String(value).replace(/(?:https?|wss?):\/\/[^\s<>"'`]+/gi, raw => {
    try {const url = new URL(raw); return url.origin + url.pathname + (url.search || url.hash ? ' [parameters omitted]' : '');}
    catch {return '[invalid external reference]';}
  }).slice(0, 512);
  function record(collection, key, value, cellId) {
    let item = collection.get(key);
    if (!item) {
      if (collection.size >= 100) {truncated = true; return;}
      item = {...value, cellIds: []}; collection.set(key, item);
    }
    if (!item.cellIds.includes(cellId)) {
      if (item.cellIds.length < 100) item.cellIds.push(cellId); else truncated = true;
    }
    return item;
  }
  function loss(cellId, message) {
    if (unsupported.length < 100) unsupported.push({cellId, message}); else truncated = true;
  }
  function references(text, cell, cellId, images = false) {
    for (const match of text.matchAll(/(?:https?:|wss?:)?\/\/[^\s<>"'`]+/gi)) {
      const value = visible(match[0].startsWith('//') ? 'https:' + match[0] : match[0]);
      record(externalReferences, value, {kind: 'literal-url', value}, cellId);
    }
    if (!images) return;
    // Candidates only: not a Markdown/HTML parser. Reference-style images,
    // escaped destinations and computed code references require manual review.
    const candidates = [...text.matchAll(/!\[[^\]\n]*\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g)].map(match => match[1]);
    for (const match of text.matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) candidates.push(match[1] ?? match[2] ?? match[3]);
    for (const reference of candidates) {
      if (reference.startsWith('attachment:')) {
        let name = reference.slice(11); try {name = decodeURIComponent(name);} catch {}
        const exists = object(cell.attachments) && Object.hasOwn(cell.attachments, name);
        let supported = false; try {supported = exists && Boolean(imageData(cell.attachments[name]));} catch {}
        record(attachments, `${cellId}:embedded:${name}`, {name: visible(name), path: null, storage: 'embedded', available: exists, referenced: true, supported}, cellId);
        if (!exists || !supported) manualWork.add('Restore missing or unsupported embedded images in the original notebook.');
      } else if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference)) {
        const file = jupyterImagePath(path, reference);
        record(attachments, `project:${reference}`, {name: visible(reference), path: file?.path ?? null, storage: 'project',
          available: file ? available.has(file.path) : null, referenced: true, supported: Boolean(file)}, cellId);
        if (!file) manualWork.add('Review unsupported or invalid local image references; only project-relative raster images can be embedded.');
        else if (!available.has(file.path)) manualWork.add('Include the missing referenced image files before previewing or publishing.');
      }
    }
  }
  for (const [index, cell] of notebook.cells.entries()) {
    const cellId = cell.id ?? index + 1;
    references(notebookText(cell.source), cell, cellId, cell.cell_type === 'markdown');
    for (const [name, bundle] of Object.entries(cell.attachments ?? {})) {
      const key = `${cellId}:embedded:${name}`;
      let supported = false; try {supported = Boolean(imageData(bundle));} catch {}
      if (!attachments.has(key)) record(attachments, key, {name: visible(name), path: null, storage: 'embedded', available: true, referenced: false, supported}, cellId);
      if (!supported) loss(cellId, 'An embedded attachment needs its original renderer or has malformed image data.');
    }
    if (cell.cell_type !== 'code') continue;
    if (!cell.outputs.length) savedOutputs.codeCellsWithoutOutput++;
    for (const item of cell.outputs) {
      savedOutputs.total++;
      try {
        if (!object(item)) throw new TypeError('Invalid output');
        let supported = false;
        if (item.output_type === 'stream') {references(notebookText(item.text), cell, cellId); supported = true;}
        else if (item.output_type === 'error') {
          if (Array.isArray(item.traceback)) item.traceback.forEach(notebookText);
          supported = true;
        } else if (['display_data', 'execute_result'].includes(item.output_type) && object(item.data)) {
          const data = item.data;
          if (Object.hasOwn(data, 'application/vnd.jupyter.widget-view+json')) {
            savedOutputs.widgets++; loss(cellId, 'Interactive widgets require the original Jupyter runtime; any supported fallback is static.');
          }
          // Inspect other valid text without letting an unused malformed fallback
          // change whether the renderer can display its preferred representation.
          for (const type of ['text/html', 'text/markdown', 'text/plain']) {
            if (!Object.hasOwn(data, type)) continue;
            try {references(notebookText(data[type]), cell, cellId, type !== 'text/plain');} catch {}
          }
          supported = Boolean(imageData(data));
          if (!supported) {
            for (const type of ['text/html', 'text/markdown', 'text/plain']) {
              if (!Object.hasOwn(data, type)) continue;
              notebookText(data[type]); supported = true; break;
            }
            if (!supported && Object.hasOwn(data, 'application/json')) supported = true;
          }
        }
        if (supported) savedOutputs.supported++;
        else {savedOutputs.unsupported++; loss(cellId, 'A saved output needs its original renderer or uses an unsupported output type.');}
      } catch {
        savedOutputs.unsupported++; savedOutputs.malformed++;
        loss(cellId, 'A saved output is malformed; later outputs and original source remain available.');
      }
    }
  }
  if (unsupported.length) manualWork.add('Review the reported output and attachment losses in the original notebook.');
  if (externalReferences.size) manualWork.add('Review external-reference candidates; links, prose and inactive code do not prove that a request occurs.');
  manualWork.add('Run changed code in its original kernel and save the results before importing; Studio previews saved outputs and does not execute a kernel.');
  manualWork.add('Preview the source, then save and build an exact revision when Jupyter publishing is enabled; review rights and output separately before publishing.');
  return {kind: 'jupyter-notebook', title: visible(path), language, cellCount: notebook.cells.length,
    cells: notebook.cells.slice(0, 100).map((cell, index) => ({id: cell.id ?? index + 1, mode: cell.cell_type === 'code' ? language : cell.cell_type})),
    modules: [], moduleInspection: 'Code dependency discovery is not performed; review imports, magics and kernel requirements in the original environment.',
    attachments: [...attachments.values()], externalReferences: [...externalReferences.values()], unsupported, savedOutputs,
    manualWork: [...manualWork], truncated,
    limitations: ['Native Jupyter nbformat 4 only; legacy Notebook conversion is not covered. Original source and metadata remain unchanged.',
      'Static inspection only: no kernel, HTML rendering, file reads or network requests. Saved outputs may be stale; source presence does not verify image bytes.',
      'Image references are candidates from simple Markdown and HTML syntax. Reference-style images, escaped paths and computed destinations may be missed.',
      'External references include prose and inactive code; computed requests, aliases and dependencies may be missed. This is not a security or publication approval.',
      'Reports show at most 100 entries per list and 100 cell references per entry. Output counts include all saved outputs.']};
}

function imageData(bundle) {
  if (!object(bundle)) return null;
  for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    if (!Object.hasOwn(bundle, type)) continue;
    const encoded = notebookText(bundle[type]).replace(/\s/g, '');
    if (encoded && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return `data:${type};base64,${encoded}`;
  }
  return null;
}

const safeTags = new Set('p div span pre code table thead tbody tfoot tr th td caption colgroup col br hr strong b em i u s small sub sup h1 h2 h3 h4 h5 h6 ul ol li dl dt dd blockquote img a'.split(' '));
function cleanHtml(html, document, resolveImage) {
  const template = document.createElement('template'); template.innerHTML = html;
  for (const image of template.content.querySelectorAll('img')) {
    const data = resolveImage?.(image.getAttribute('src') ?? '');
    if (data) image.setAttribute('src', data);
  }
  for (const node of template.content.querySelectorAll('*')) {
    if (!safeTags.has(node.localName)) {node.remove(); continue;}
    for (const {name, value} of [...node.attributes]) {
      if (['alt', 'title'].includes(name) || ['colspan', 'rowspan'].includes(name) && /^[1-9][0-9]{0,2}$/.test(value)) continue;
      if (name === 'src' && node.localName === 'img' && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) continue;
      if (name === 'href' && /^#[A-Za-z0-9_-]+$/.test(value)) continue;
      node.removeAttribute(name);
    }
  }
  return template.innerHTML;
}

/** Render preserved outputs, not a replacement for executing changed code. */
export function renderJupyterNotebook(source, {document, renderMarkdown, dark = false, resolveImage} = {}) {
  const notebook = parseJupyterNotebook(source);
  if (!document?.createElement || typeof renderMarkdown !== 'function') throw new TypeError('Notebook renderer dependencies are unavailable.');
  const markdown = (value, attachments) => {
    const template = document.createElement('template'); template.innerHTML = renderMarkdown(value);
    for (const image of template.content.querySelectorAll('img')) {
      const path = image.getAttribute('src') ?? '';
      let name = path.slice('attachment:'.length);
      try {name = decodeURIComponent(name);} catch {}
      const data = path.startsWith('attachment:') && object(attachments) && Object.hasOwn(attachments, name) ? imageData(attachments[name]) : resolveImage?.(path);
      if (data) image.setAttribute('src', data); else image.removeAttribute('src');
    }
    return cleanHtml(template.innerHTML, document);
  };
  const output = item => {
    if (!object(item)) throw new TypeError('Invalid output');
    if (item.output_type === 'stream') return `<pre>${escape(notebookText(item.text))}</pre>`;
    if (item.output_type === 'error') return `<pre class="error">${escape(Array.isArray(item.traceback) ? item.traceback.map(notebookText).join('\n').replace(/\x1b\[[0-9;]*m/g, '') : `${item.ename}: ${item.evalue}`)}</pre>`;
    if (!['display_data', 'execute_result'].includes(item.output_type) || !object(item.data)) return '<p>Unsupported saved output. The original data is retained.</p>';
    const data = item.data, image = imageData(data);
    if (image) return `<img alt="Saved notebook output" src="${image}">`;
    if (Object.hasOwn(data, 'text/html')) return cleanHtml(notebookText(data['text/html']), document, resolveImage);
    if (Object.hasOwn(data, 'text/markdown')) return markdown(notebookText(data['text/markdown']));
    if (Object.hasOwn(data, 'text/plain')) return `<pre>${escape(notebookText(data['text/plain']))}</pre>`;
    if (Object.hasOwn(data, 'application/json')) return `<pre>${escape(JSON.stringify(data['application/json'], null, 2))}</pre>`;
    return '<p>This output needs its original Jupyter renderer. The original data is retained.</p>';
  };
  const language = notebook.metadata.language_info?.name ?? notebook.metadata.kernelspec?.language ?? 'python';
  const body = notebook.cells.map((cell, index) => {
    const source = notebookText(cell.source);
    if (cell.cell_type === 'markdown') return `<section>${markdown(source, cell.attachments)}</section>`;
    if (cell.cell_type === 'raw') return `<section><pre>${escape(source)}</pre></section>`;
    const outputs = cell.outputs.map(item => {try {return output(item);} catch {return '<p>Cannot display this saved output. The original data is retained.</p>';}}).join('');
    return `<section><details><summary>Cell ${index + 1} · ${escape(language)}${cell.execution_count === null ? '' : ` · In [${cell.execution_count}]`}</summary><pre>${escape(source)}</pre></details>${outputs || '<p>No saved output.</p>'}</section>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jupyter notebook preview</title><style>body{font:15px/1.6 system-ui;margin:0;padding:20px;color:${dark ? '#ddd' : '#222'};background:${dark ? '#1e1e1e' : '#fff'};overflow-wrap:anywhere}section{padding:12px 0;border-bottom:1px solid ${dark ? '#444' : '#ddd'}}pre{white-space:pre-wrap;overflow:auto;font-size:13px}img{max-width:100%;height:auto}table{border-collapse:collapse;display:block;overflow:auto}td,th{border:1px solid #888;padding:5px 9px}summary,aside{font-size:13px}.error{color:${dark ? '#ffb4ab' : '#a00'}}</style></head><body><aside>Saved outputs · ${escape(language)}. Editing does not run a kernel.</aside>${body}</body></html>`;
}

const imageTypes = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp'};
/** Resolve only local raster images inside this publication's source directory. */
export function jupyterImagePath(page, reference, sourceRoot = '') {
  if (!reference || /^[\/\\]|^[a-z][a-z0-9+.-]*:/i.test(reference) || /[?#\\\x00-\x1f\x7f]/.test(reference)) return null;
  let decoded;
  try {decoded = decodeURIComponent(reference);} catch {return null;}
  if (/^[\/\\]|^[a-z][a-z0-9+.-]*:|[?#\\\x00-\x1f\x7f]/i.test(decoded)) return null;
  const parts = page.split('/').slice(0,-1);
  for (const part of decoded.split('/')) {
    if (part === '.') continue;
    if (part === '..') {if (!parts.length) return null; parts.pop();}
    else if (part) parts.push(part); else return null;
  }
  const path = parts.join('/');
  if (sourceRoot && !path.startsWith(sourceRoot.replace(/\/$/,'') + '/')) return null;
  const type = imageTypes[path.split('.').at(-1)?.toLowerCase()];
  return type ? {path,type} : null;
}

/** Embed referenced image bytes only; unrelated source files remain private. */
export async function renderJupyterNotebookWithFiles(source, options) {
  const files = new Map(), references = new Map(), uses = new Map();
  const initial = renderJupyterNotebook(source, {...options, resolveImage: reference => {
    const file = jupyterImagePath(options.path, reference, options.sourceRoot);
    if (file) {
      references.set(reference,file.path); files.set(file.path,file);
      uses.set(file.path,(uses.get(file.path) ?? 0) + 1);
    }
    return null;
  }});
  if (!files.size) return initial;
  if (files.size > 128) throw Error('Notebook exceeds 128 referenced images.');
  let total = 0;
  const images = new Map();
  for (const file of files.values()) {
    if (typeof options.readFile !== 'function') throw Error('Open the notebook images with its source files.');
    const blob = await options.readFile(file.path);
    if (!(blob instanceof Blob) || !blob.size || blob.size > 4_194_304 || (total += blob.size * uses.get(file.path)) > 16_777_216) throw Error('Notebook images must be non-empty, at most 4 MiB each and 16 MiB total including repeated images.');
    if (blob.type && blob.type !== file.type) throw Error(`Notebook image media type does not match: ${file.path}`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset=0; offset<bytes.length; offset+=8192) binary += String.fromCharCode(...bytes.subarray(offset,offset+8192));
    images.set(file.path,`data:${file.type};base64,${btoa(binary)}`);
  }
  return renderJupyterNotebook(source, {...options, resolveImage: reference => images.get(references.get(reference))});
}
