import * as kit from '@observablehq/notebook-kit';
import {runtime, styles} from 'studio:notebook-runtime';
import {compileObservableNotebook, inspectObservableNotebookImport as inspectNotebook, notebookAttachmentPath, observableNotebookDocument} from '../../services/observable-builder/src/observable-notebook.mjs';
import {inspectJupyterNotebookImport as inspectJupyter} from '../../services/observable-builder/src/jupyter-notebook.mjs';
import {convertLegacyObservable} from '../../services/observable-builder/src/legacy-observable.mjs';
export {parseNotebookCells, changeNotebookCell} from '../src/lib/notebookCells.js';
export {parseJupyterCells, changeJupyterCell} from '../src/lib/jupyterCells.js';

export function inspectObservableNotebookImport({source, path, availablePaths}) {
  const parser = {parseFromString(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    return template.content;
  }};
  return inspectNotebook(source, {kit, parser, path, availablePaths});
}

export function inspectJupyterNotebookImport({source, path, availablePaths}) {
  return inspectJupyter(source, {path, availablePaths});
}

export function convertLegacyNotebook({source, ...options}) {
  return convertLegacyObservable(source, {...options, kit, document});
}

export const documentHtml = () => observableNotebookDocument({runtime, styles});
export async function renderNotebookDocument(options) {
  const payload = await compileNotebookPreview(options);
  for (const file of payload.attachments) {
    let text = '';
    for (let offset = 0; offset < file.bytes.length; offset += 32768) text += String.fromCharCode(...file.bytes.subarray(offset, offset + 32768));
    file.bytes = btoa(text);
  }
  return observableNotebookDocument({runtime, styles, title: payload.title, payload: {...payload, revision: 1}});
}
export async function compileNotebookPreview({source, path, readFile}) {
  const compiled = compileObservableNotebook(source, {kit, parser: new DOMParser()});
  const attachments = [];
  let total = 0;
  for (const name of compiled.files) {
    const file = await readFile(notebookAttachmentPath(path, name));
    if (!(file instanceof Blob) || file.size > 4_194_304 || (total += file.size) > 16_777_216) throw Error('Notebook attachments exceed preview limits.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const checksum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    attachments.push({name, type: file.type, checksum, bytes});
  }
  return {title: compiled.title, cells: compiled.cells, attachments,
    ...(compiled.legacyModules ? {legacyModules: compiled.legacyModules} : {})};
}
