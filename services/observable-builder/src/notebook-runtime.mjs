// Shared by Studio's draft preview and the sealed publication compiler.
import {NotebookRuntime, library, registerFile, requireFileRegistration} from '@observablehq/notebook-kit/runtime';
import * as htl from 'htl';
import * as Inputs from '@observablehq/inputs';
import * as Plot from '@observablehq/plot';
import * as d3 from 'd3';
import * as map from './portable-map-view.mjs';
import {createLegacyModuleRegistry, createOfflineLegacyRequire} from './legacy-notebook-runtime.mjs';

Object.defineProperty(globalThis, '__opengeoNotebookModules', {value: Object.freeze({d3, htl, '@observablehq/inputs': Inputs, '@observablehq/plot': Plot, 'opengeo:map': map})});
const offlineRequire = createOfflineLegacyRequire(globalThis.__opengeoNotebookModules);
const builtins = {...library, htl: () => htl, html: () => htl.html, svg: () => htl.svg, Inputs: () => Inputs, Plot: () => Plot, d3: () => d3, require: () => offlineRequire};
let notebook = new NotebookRuntime(builtins), legacyModules = Object.freeze(Object.create(null)), moduleSignature = '';
Object.defineProperty(globalThis, '__opengeoLegacyModules', {get: () => legacyModules});
requireFileRegistration(true);
const states = new Map(), files = new Map(), fileBodies = new Map();
const main = document.querySelector('main');
const base = 'https://notebook.invalid/index.html';
let port, revision = 0;
let currentTheme;
let themeVariable = notebook.main.variable();
// Native FileAttachment parsers can read transferred bytes without issuing a
// fetch from the authenticated editor or relying on blob-origin CSP behavior.
const networkFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  const blob = fileBodies.get(url);
  if (blob) return Promise.resolve(new Response(blob, {headers: {'Content-Type': blob.type}}));
  return networkFetch(input, init); // The offline document policy denies network.
};
const nativeAttachment = library.FileAttachment();
notebook.main.define('FileAttachment', [], () => name => nativeAttachment(name, base));

function update({cells, attachments = [], legacyModules: moduleBundle, revision: nextRevision, theme = 'auto'}) {
  if (!Number.isSafeInteger(nextRevision) || nextRevision <= revision || !Array.isArray(cells) || cells.length > 1000) return;
  revision = nextRevision;
  const changedFiles = new Set();
  for (const file of attachments) {
    if (files.get(file.name)?.checksum === file.checksum) continue;
    const previous = files.get(file.name);
    if (previous) {fileBodies.delete(previous.url); URL.revokeObjectURL(previous.url);}
    const bytes = typeof file.bytes === 'string' ? Uint8Array.from(atob(file.bytes), c => c.charCodeAt(0)) : file.bytes;
    const blob = new Blob([bytes], {type: file.type}), url = URL.createObjectURL(blob);
    fileBodies.set(url, blob); files.set(file.name, {url, checksum: file.checksum});
    registerFile(file.name, {path: url, mimeType: blob.type, size: blob.size}, base);
    changedFiles.add(file.name);
  }
  const wanted = new Set(attachments.map(file => file.name));
  for (const [name, file] of files) if (!wanted.has(name)) {
    registerFile(name, null, base); files.delete(name); fileBodies.delete(file.url); URL.revokeObjectURL(file.url); changedFiles.add(name);
  }
  const signature = JSON.stringify([moduleBundle ?? null,
    cells.filter(cell => cell.legacyImports).map(cell => [cell.id, cell.legacyImports, cell.legacyDerivations ?? null])]);
  const resetModules = signature !== moduleSignature
    || (moduleBundle?.attachments ?? []).some(file => changedFiles.has(file.name));
  if (resetModules) {
    // Child modules are cached by factory identity. Whole-runtime disposal also
    // resolves their invalidation promises and prevents stale child subscriptions.
    notebook.runtime.dispose();
    for (const state of states.values()) {state.root.remove(); state.code.remove();}
    states.clear();
    notebook = new NotebookRuntime(builtins);
    notebook.main.define('FileAttachment', [], () => name => nativeAttachment(name, base));
    themeVariable = notebook.main.variable(); currentTheme = undefined;
    legacyModules = createLegacyModuleRegistry(moduleBundle, {
      readAttachment: name => nativeAttachment(name, base), mutable: library.Mutable()
    });
    moduleSignature = signature;
  }
  if (['light', 'dark', 'auto'].includes(theme) && theme !== currentTheme) {
    currentTheme = theme; document.documentElement.dataset.notebookTheme = theme;
    themeVariable.define('dark', [], theme === 'auto' ? library.dark : () => theme === 'dark');
  }
  const ids = new Set(cells.map(cell => cell.id));
  for (const [id, state] of states) if (!ids.has(id)) {state.variables.forEach(v => v.delete()); state.root.remove(); state.code.remove(); states.delete(id);}
  const changes = [];
  for (const cell of cells) {
    let state = states.get(cell.id);
    if (!state) {
      state = {root: document.createElement('section'), code: document.createElement('pre'), variables: [], expanded: []};
      state.root.className = 'notebook-cell'; state.root.dataset.cellId = cell.id; states.set(cell.id, state);
    }
    main.append(state.root, state.code); state.code.hidden = !cell.pinned; state.code.textContent = cell.source;
    const signature = JSON.stringify(cell);
    if (state.signature === signature && !cell.files.some(name => changedFiles.has(name))) continue;
    const bindingSignature = cell.legacyImports ? JSON.stringify([cell.legacyImports, cell.legacyDerivations ?? null]) : null;
    if (bindingSignature && state.bindingSignature === bindingSignature) {
      // Editing import whitespace or pinning its source must not clone a new
      // derived module or abandon the existing module's reactive state.
      state.signature = signature; continue;
    }
    state.variables.forEach(v => v.delete()); state.variables.length = 0; state.signature = signature;
    state.bindingSignature = bindingSignature;
    changes.push([cell, state]);
  }
  for (const [cell, state] of changes) {
    try {
      if (cell.legacyImports) {
        let module = notebook.runtime.module(legacyModules[cell.legacyImports[0].path].default);
        if (cell.legacyDerivations) module = module.derive(cell.legacyDerivations, notebook.main);
        for (const binding of cell.legacyImports) state.variables.push(notebook.main.import(binding.imported, binding.local,
          module));
      } else notebook.define(state, {...cell, body: new Function(`return (${cell.body});`)()});
    }
    catch (error) {state.root.replaceChildren(); const message = document.createElement('pre'); message.className = 'notebook-error'; message.textContent = error.message; state.root.append(message);}
  }
}
const initial = document.querySelector('#notebook-payload');
if (initial) {const data = JSON.parse(initial.textContent); initial.remove(); update(data);}
else window.addEventListener('message', function connect(event) {
  if (event.source !== parent || event.data !== 'opengeo-notebook-connect' || !event.ports[0] || port) return;
  port = event.ports[0]; port.onmessage = event => update(event.data); port.postMessage('ready');
});
window.addEventListener('pagehide', () => {
  notebook.runtime.dispose(); port?.close();
  for (const file of files.values()) URL.revokeObjectURL(file.url);
});
