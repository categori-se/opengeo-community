// Pure Notebook Kit compilation. No submitted cell executes in the editor or
// build host; compiled definitions run in the publication's browser runtime.
import {compileLegacyModuleBundle} from './legacy-observable.mjs';
import {resolveLegacyLibrary} from './legacy-notebook-runtime.mjs';

export const NOTEBOOK_KIT_VERSION = '2.5.6';
export const NOTEBOOK_MODULES = Object.freeze(['d3', 'htl', '@observablehq/inputs', '@observablehq/plot']);
function readObservableNotebook(source, {kit, parser}) {
  if (typeof source !== 'string' || new TextEncoder().encode(source).length > 4_194_304) throw Error('Notebook source must be at most 4 MiB.');
  const document = parser.parseFromString(source, 'text/html');
  if (document.querySelectorAll('notebook').length !== 1) throw Error('Choose an Observable Notebook HTML file containing one notebook element.');
  const notebook = kit.deserialize(source, {parser});
  if (notebook.cells.length > 1000) throw Error('Notebook exceeds 1,000 cells.');
  const descriptors = document.querySelectorAll('#opengeo-legacy-modules');
  let legacyModules;
  if (descriptors.length) {
    if (descriptors.length !== 1 || descriptors[0].tagName.toLowerCase() !== 'script'
      || descriptors[0].getAttribute('type') !== 'application/json' || descriptors[0].closest('notebook')) throw Error('Invalid local Notebook module descriptor.');
    let descriptor;
    try {descriptor = JSON.parse(descriptors[0].textContent);} catch {throw Error('Invalid local Notebook module JSON.');}
    legacyModules = compileLegacyModuleBundle(descriptor, {kit});
    if (notebook.cells.length + legacyModules.cellCount > 1000) throw Error('Notebook and imported modules exceed 1,000 cells.');
  }
  return {notebook, legacyModules};
}

export function compileObservableNotebook(source, {kit, parser}) {
  const {notebook, legacyModules} = readObservableNotebook(source, {kit, parser});
  const cells = notebook.cells.map(cell => compileObservableCell(cell, kit, legacyModules));
  return {title: notebook.title, cells, files: [...new Set([...cells.flatMap(cell => cell.files),
    ...(legacyModules?.attachments ?? []).map(file => file.name)])], ...(legacyModules ? {legacyModules} : {})};
}

function localModulePath(name, legacyModules) {
  return legacyModules?.modules.find(module => name === `observable:opengeo-legacy/${encodeURIComponent(module.path)}`)?.path;
}

function localModuleDerivations(call) {
  const [array, parent] = call.arguments;
  if (call.arguments.length !== 2 || array?.type !== 'ArrayExpression' || array.elements.length > 128
    || parent?.type !== 'MemberExpression' || parent.computed || parent.object?.name !== '__variable'
    || parent.property?.name !== '_module') throw Error('Notebook parameters require a literal substitution list.');
  const aliases = new Set();
  const valid = value => typeof value === 'string' && /^(?:(?:viewof|mutable) )?[A-Za-z_$][\w$]*$/.test(value);
  return array.elements.map(item => {
    let name, alias;
    if (item?.type === 'Literal') name = alias = item.value;
    else if (item?.type === 'ObjectExpression') {
      const properties = new Map();
      for (const property of item.properties) {
        const key = property.key?.name ?? property.key?.value;
        if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init'
          || !['name', 'alias'].includes(key) || properties.has(key) || property.value?.type !== 'Literal') throw Error('Invalid notebook parameter substitution.');
        properties.set(key, property.value.value);
      }
      name = properties.get('name'); alias = properties.get('alias') ?? name;
    }
    if (!valid(name) || !valid(alias) || aliases.has(alias)) throw Error('Notebook parameter bindings must be unique names.');
    aliases.add(alias);
    // The native parent and retained legacy child use different special names.
    return {name: name.replace(/^(viewof|mutable) /, '$1$'), alias};
  });
}

function compileObservableCell(cell, kit, legacyModules) {
    try {
      if (['python', 'node', 'r', 'sql', 'sql.view'].includes(cell.mode)) throw Error('This cell requires a separately configured interpreter or database.');
      const compiled = kit.transpile(cell, {resolveImport(name) {
        const local = localModulePath(name, legacyModules);
        if (local !== undefined) return `opengeo:legacy/${encodeURIComponent(local)}`;
        if (name === 'opengeo:map') return 'opengeo:notebook-map';
        const module = name.replace(/^npm:/, '');
        if (!NOTEBOOK_MODULES.includes(module)) throw Error(`Import ${name} is not bundled. Add its local module before publishing offline.`);
        return `opengeo:notebook/${module}`;
      }});
      if (compiled.databases.size || compiled.secrets.size) throw Error('Notebook previews cannot read databases or account secrets.');
      // Resolve bundled imports without a CDN, blob-module loader or eval in the
      // host. Replacements use actual AST ranges, never matching source strings.
      const edits = [];
      const localImports = new Set(), bindings = [];
      const derivations = [];
      function visit(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression') {
          const callee = node.callee;
          if (!callee.computed && callee.property.name === 'derive') derivations.push(node);
          const getter = callee.object;
          if (!callee.computed && callee.property.name === 'import' && getter?.type === 'CallExpression'
            && getter.callee?.type === 'MemberExpression' && getter.callee.object?.name === 'outputs'
            && getter.callee.property?.name === 'get' && getter.arguments.length === 1
            && typeof getter.arguments[0]?.value === 'string' && node.arguments.at(-1)?.name === 'module') {
            const local = getter.arguments[0].value, imported = node.arguments[0]?.value;
            if (typeof imported === 'string' && (node.arguments.length === 2
              || node.arguments.length === 3 && node.arguments[1]?.value === local)) bindings.push({local, imported});
          }
        }
        if (node.type === 'ImportExpression') {
          const name = node.source?.value;
          if (node.source?.type !== 'Literal' || typeof name !== 'string') throw Error('Dynamic module imports need a bundled local module.');
          let expression;
          if (name.startsWith('opengeo:notebook/') && NOTEBOOK_MODULES.includes(name.slice(17))) {
            expression = `globalThis.__opengeoNotebookModules[${JSON.stringify(name.slice(17))}]`;
          } else if (name === 'opengeo:notebook-map') {
            expression = 'globalThis.__opengeoNotebookModules["opengeo:map"]';
          } else if (name.startsWith('opengeo:legacy/')) {
            const path = decodeURIComponent(name.slice(15));
            if (legacyModules?.modules.some(module => module.path === path)) {
              expression = `globalThis.__opengeoLegacyModules[${JSON.stringify(path)}]`; localImports.add(path);
            }
          }
          if (!expression) throw Error('Dynamic module imports need a bundled local module.');
          edits.push({start: node.start, end: node.end, text: `Promise.resolve(${expression})`});
        }
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) value.forEach(visit);
          else if (value && typeof value === 'object') visit(value);
        }
      }
      visit(kit.parseJavaScript(compiled.body).body);
      let body = compiled.body;
      for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
      let legacyImports, legacyDerivations;
      if (cell.mode === 'ojs' && localImports.size) {
        if (derivations.length > 1 || localImports.size !== 1 || compiled.inputs.length !== 1 || compiled.inputs[0] !== '@variable'
          || !compiled.outputs?.length || bindings.length !== compiled.outputs.length
          || new Set(bindings.map(binding => binding.local)).size !== bindings.length
          || bindings.some(binding => !compiled.outputs.includes(binding.local))) throw Error('Local notebook imports require named bindings and literal parameter substitutions.');
        legacyImports = bindings.map(binding => ({path: [...localImports][0], ...binding}));
        const module = legacyModules.modules.find(module => module.path === legacyImports[0].path);
        if (legacyImports.some(binding => !module.exports.includes(binding.imported))) throw Error('An imported cell is not exported by its local notebook.');
        if (derivations.length) {
          legacyDerivations = localModuleDerivations(derivations[0]);
          if (legacyDerivations.some(binding => !module.injectableNames.includes(binding.alias))) throw Error('A notebook parameter does not name a child binding.');
        }
      }
      const {databases, secrets, ...definition} = compiled;
      return {...definition, body, id: cell.id, files: [...compiled.files], source: cell.value, pinned: cell.pinned,
        ...(legacyImports ? {legacyImports} : {}), ...(legacyDerivations ? {legacyDerivations} : {})};
    } catch (error) {throw Error(`Cell ${cell.id}: ${error.message}`);}
}

// Import inspection never evaluates a cell, opens an attachment or resolves a
// dependency. Keep compiler rejection behavior separate from this partial report.
export function inspectObservableNotebookImport(source, {kit, parser, path = 'index.html', availablePaths = []}) {
  const {notebook, legacyModules} = readObservableNotebook(source, {kit, parser});
  if (!Array.isArray(availablePaths) || availablePaths.length > 128 || availablePaths.some(value => typeof value !== 'string')) {
    throw Error('Notebook import inspection accepts at most 128 source paths.');
  }
  const available = new Set(availablePaths);
  const modules = new Map(), attachments = new Map(), externalReferences = new Map();
  const unsupported = [], manualWork = new Set();
  let truncated = notebook.cells.length > 100;
  const visible = value => String(value).replace(/https?:\/\/[^\s<>"'`]+/gi, url => {
    try {const parsed = new URL(url); return parsed.origin + parsed.pathname + (parsed.search || parsed.hash ? ' [parameters omitted]' : '');}
    catch {return '[invalid external reference]';}
  }).slice(0, 512);
  function record(collection, key, value, cellId) {
    let item = collection.get(key);
    if (!item) {
      if (collection.size >= 100) {truncated = true; return;}
      item = {...value, cellIds: []}; collection.set(key, item);
    }
    if (cellId !== null && !item.cellIds.includes(cellId)) {
      if (item.cellIds.length < 100) item.cellIds.push(cellId);
      else truncated = true;
    }
  }
  let customRequire = false;
  for (const cell of notebook.cells) {
    // Literal URL candidates can occur in prose, HTML or inactive code. They do
    // not establish that a request executes, or enumerate computed destinations.
    for (const match of cell.value.matchAll(/(?:https?:)?\/\/[^\s<>"'`]+/gi)) {
      const value = visible(match[0].startsWith('//') ? 'https:' + match[0] : match[0]);
      record(externalReferences, value, {kind: 'literal-url', value}, cell.id);
    }
    if (!['python', 'node', 'r', 'sql', 'sql.view'].includes(cell.mode)) {
      try {
        const compiled = kit.transpile(cell, {resolveImport(name) {
          const local = localModulePath(name, legacyModules);
          const bundled = name === 'opengeo:map' || NOTEBOOK_MODULES.includes(name.replace(/^npm:/, '')) || local !== undefined;
          record(modules, name, {name: visible(name), bundled,
            ...(local !== undefined ? {supportNote: 'Included local notebook; retained module scope and lazy imports.'} : {})}, cell.id);
          // Return an inert specifier for parsing only; never load the module.
          return name;
        }});
        if (compiled.output === 'require' || compiled.outputs?.includes('require')) customRequire = true;
        for (const name of compiled.files ?? []) {
          let resolved = null;
          try {resolved = notebookAttachmentPath(path, name);} catch { /* Report the invalid reference below. */ }
          record(attachments, name, {name: visible(name), path: resolved, available: resolved !== null && available.has(resolved)}, cell.id);
          if (!resolved) manualWork.add('Replace invalid attachment paths with project-relative paths.');
          else if (!available.has(resolved)) manualWork.add('Include the missing referenced attachments before previewing or publishing.');
        }
        const pending = [kit.parseJavaScript(compiled.body).body];
        while (pending.length) {
          const node = pending.pop();
          if (!node || typeof node !== 'object') continue;
          if (node.type === 'ImportExpression' && node.source?.type !== 'Literal') {
            manualWork.add('Replace computed module imports with supported bundled imports.');
          }
          if (['CallExpression', 'NewExpression'].includes(node.type)) {
            const name = node.callee?.type === 'Identifier' ? node.callee.name : node.callee?.property?.name;
            if (['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'sendBeacon'].includes(name)) {
              record(externalReferences, `request:${name}`, {kind: 'request-expression', value: `${name}(…)`}, cell.id);
            }
            if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && name === 'require') {
              const requested = node.arguments.length === 1 && node.arguments[0]?.type === 'Literal' ? node.arguments[0].value : null;
              const resolved = resolveLegacyLibrary(requested);
              record(modules, `require:${requested ?? '[computed]'}`, {kind: 'legacy-require', name: visible(requested ?? '[computed require request]'),
                bundled: Boolean(resolved), ...(resolved ? {resolvedVersion: resolved.version, supportNote: `Bundled ${resolved.name} ${resolved.version}; no network loader.`} : {})}, cell.id);
            }
          }
          for (const value of Object.values(node)) {
            if (Array.isArray(value)) pending.push(...value);
            else if (value && typeof value === 'object') pending.push(value);
          }
        }
      } catch { /* The same strict compiler below supplies the actionable cell error. */ }
    }
    try {compileObservableCell(cell, kit, legacyModules);}
    catch (error) {
      if (unsupported.length < 100) unsupported.push({cellId: cell.id, message: visible(error.message)});
      else truncated = true;
    }
  }
  for (const attachment of legacyModules?.attachments ?? []) {
    const resolved = notebookAttachmentPath(path, attachment.name);
    record(attachments, attachment.name, {name: visible(attachment.name), path: resolved, available: available.has(resolved)}, null);
    if (!available.has(resolved)) manualWork.add('Include the missing referenced attachments before previewing or publishing.');
  }
  for (const finding of legacyModules?.findings ?? []) {
    const context = `Imported notebook ${visible(finding.modulePath)}`;
    if (finding.kind === 'external-reference' || finding.kind === 'request-expression') {
      record(externalReferences, JSON.stringify([finding.modulePath, finding.kind, finding.value]), {
        kind: finding.kind, value: `${context}: ${visible(finding.value)}`, modulePath: finding.modulePath
      }, null);
    } else if (finding.kind === 'bundled-library') {
      record(modules, `child-require:${finding.modulePath}:${finding.request}`, {kind: 'legacy-require', name: visible(finding.request),
        bundled: true, modulePath: finding.modulePath, resolvedVersion: finding.version, supportNote: `${context}: ${visible(finding.message)}`}, null);
    } else if (finding.kind === 'unsupported') {
      if (unsupported.length < 100) unsupported.push({cellId: `${visible(finding.modulePath)} / ${finding.cell ?? '?'}`, message: visible(finding.message)});
      else truncated = true;
    } else if (finding.message) manualWork.add(`${context}: ${visible(finding.message)}`);
  }
  if (legacyModules?.findingsTruncated) truncated = true;
  if (customRequire) for (const item of modules.values()) {
    if (item.kind !== 'legacy-require' || item.modulePath) continue;
    item.bundled = false;
    delete item.resolvedVersion;
    item.supportNote = 'User-defined require loader; review its dependencies and behavior separately.';
  }
  if ([...modules.values()].some(item => !item.bundled)) manualWork.add('Review unavailable library requests and imports; choose pinned bundled libraries or supplied local notebooks.');
  if (unsupported.length) manualWork.add('Resolve the listed cell errors or preserve those cells for work in their original environment.');
  if (externalReferences.size) manualWork.add('Review external references manually. Network access is denied in the offline preview and compiler.');
  manualWork.add('Preview the source, then save and build an exact revision when Notebook publishing is enabled; review rights and output separately before publishing.');
  return {kind: 'observable-notebook', title: visible(notebook.title), cellCount: notebook.cells.length,
    cells: notebook.cells.slice(0, 100).map(({id, mode}) => ({id, mode})), modules: [...modules.values()],
    attachments: [...attachments.values()], externalReferences: [...externalReferences.values()], unsupported,
    manualWork: [...manualWork], truncated,
    limitations: ['Native Observable Notebook HTML only; legacy hosted notebook conversion and Jupyter are not covered.',
      'Static inspection only: no cells ran, attachments were opened or network requests were made. File presence does not verify attachment contents.',
      'External references are candidates, including prose and inactive code; computed requests, aliases and dependencies may be missed. This is not a security or publication approval.',
      'Reports show at most 100 entries per list and 100 cell references per entry. Source files remain unchanged.']};
}

export function notebookAttachmentPath(page, name) {
  if (typeof name !== 'string' || !name || /^[\/\\]|^[a-z][a-z0-9+.-]*:/i.test(name) || /[\\\x00-\x1f\x7f]/.test(name)) throw Error('Use a project-relative notebook attachment path.');
  const url = new URL(name, 'https://notebook.invalid/' + page);
  const path = decodeURIComponent(url.pathname).slice(1);
  if (url.origin !== 'https://notebook.invalid' || url.search || url.hash || !path || /[\\\x00-\x1f\x7f]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Invalid notebook attachment path.');
  return path;
}

export function notebookNoticeFiles(entryPath, files) {
  const prefix = (entryPath.includes('/') ? entryPath.slice(0, entryPath.lastIndexOf('/') + 1) : '') + 'original/notices/';
  let total = 0;
  return files.flatMap(file => {
    if (!file.path.startsWith(prefix)) return [];
    const name = /^(LICENSE|NOTICE|COPYING)-[a-f0-9]{64}\.txt$/i.exec(file.path.slice(prefix.length))?.[1];
    if (!name) return [];
    if (file.contentType !== 'text/plain' || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1
      || file.sizeBytes > 4_194_304 || (total += file.sizeBytes) > 16_777_216) throw Error('Notebook notices exceed source text limits.');
    return [{...file, noticeName: name}];
  });
}

export function observableNotebookDocument({runtime, styles, title = 'Observable notebook', payload = null, notices = []}) {
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  if (!Array.isArray(notices) || notices.length > 128 || notices.some(notice => typeof notice?.name !== 'string' || typeof notice.text !== 'string')) throw Error('Invalid Notebook notices.');
  const credits = notices.length ? `<details class="notebook-notices"><summary>Licenses and attribution</summary>${notices.map(notice => `<section><h2>${escape(notice.name)}</h2><pre>${escape(notice.text)}</pre></section>`).join('')}</details>` : '';
  const data = payload === null ? '' : `<script type="application/json" id="notebook-payload">${JSON.stringify(payload).replace(/</g, '\\u003c')}</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; script-src-attr 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; frame-src 'self' blob:; worker-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>${escape(title)}</title><style>${styles.replace(/<\/style/gi, '')}\nbody{margin:24px;overflow-wrap:anywhere}main{max-width:100%}.notebook-cell:empty{display:none}.notebook-cell{margin-bottom:16px}pre{white-space:pre-wrap}img,svg,canvas{max-width:100%}.notebook-error{color:#d45}</style></head><body><main></main>${credits}${data}<script type="module">${runtime.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}
