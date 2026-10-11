let compiler;
async function loadCompiler() {
  compiler ??= (async () => {
    const response = await fetch('/editor-assets/manifest.json', {credentials: 'omit'});
    if (!response.ok) throw Error('Notebook preview assets are unavailable.');
    const {notebookPreview} = await response.json();
    if (!/^notebook-preview-[\w-]+\.js$/.test(notebookPreview ?? '')) throw Error('Notebook preview is unavailable in this release.');
    return import(new URL('/editor-assets/' + notebookPreview, location.origin).href);
  })().catch(error => {compiler = null; throw error;});
  return compiler;
}

export async function exportObservableNotebook(options) {
  return (await loadCompiler()).renderNotebookDocument(options);
}

export async function inspectObservableNotebookImport(options) {
  return (await loadCompiler()).inspectObservableNotebookImport(options);
}

export async function inspectNotebookImport(options) {
  const module = await loadCompiler();
  return /\.ipynb$/i.test(options.path)
    ? module.inspectJupyterNotebookImport(options)
    : module.inspectObservableNotebookImport(options);
}

export async function loadNotebookCellTools() {
  const {parseNotebookCells, changeNotebookCell, parseJupyterCells, changeJupyterCell} = await loadCompiler();
  if (typeof parseNotebookCells !== 'function' || typeof changeNotebookCell !== 'function') {
    throw Error('Cell editing is unavailable in this release. Use Source to edit this notebook.');
  }
  return {parseNotebookCells, changeNotebookCell, parseJupyterCells, changeJupyterCell};
}

export async function convertLegacyNotebook(options) {
  const compiler = await loadCompiler();
  if (typeof compiler.convertLegacyNotebook !== 'function') throw Error('Legacy notebook conversion is unavailable in this release.');
  return compiler.convertLegacyNotebook(options);
}

export function createObservableNotebookPreview(frame) {
  let session, generation = 0;
  function clearSession() {
    if (session) {session.port.close(); session.finish(); frame.removeEventListener('load', session.onLoad); session = null;}
    frame.removeAttribute('srcdoc');
  }
  function dispose() {generation++; clearSession();}
  return {dispose, async render({source, path, readFile, theme = 'auto', isCurrent = () => true}) {
    const token = ++generation;
    const current = () => token === generation && frame.isConnected && isCurrent();
    const kit = await loadCompiler();
    if (!current()) return;
    const payload = await kit.compileNotebookPreview({source, path, readFile});
    if (!current()) return;
    if (session?.path !== path) {
      clearSession(); // Replace the virtual notebook, never reuse another file's state.
      const channel = new MessageChannel();
      const next = session = {path, port: channel.port1, revision: 0};
      next.ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('The notebook runtime did not start.')), 12000);
        next.finish = () => {clearTimeout(timer); resolve();};
        next.port.onmessage = event => {if (event.data === 'ready') next.finish();};
      });
      next.onLoad = () => frame.contentWindow.postMessage('opengeo-notebook-connect', '*', [channel.port2]);
      frame.addEventListener('load', next.onLoad, {once: true});
      frame.setAttribute('sandbox', 'allow-scripts'); frame.srcdoc = kit.documentHtml();
    }
    const active = session;
    await active.ready;
    if (!current() || active !== session) return;
    active.port.postMessage({...payload, theme, revision: ++active.revision});
  }};
}
