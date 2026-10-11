import {createObservableNotebookPreview, exportObservableNotebook, loadNotebookCellTools} from './ObservableNotebookPreview.js';
import {NotebookCellEditor} from './NotebookCellEditor.js';
import {createFrameworkDraftPreview} from './FrameworkDraftPreview.js';
import {frameworkDraftPreviewEnabled} from '../lib/publicationDrafts.js';

let runtime;
let frameworkCompiler;
async function loadFrameworkCompiler() {
  if (!frameworkCompiler) frameworkCompiler = (async () => {
    const response = await fetch('/editor-assets/manifest.json', {credentials: 'omit'});
    if (!response.ok) throw Error('Framework preview assets unavailable');
    const {frameworkPreview} = await response.json();
    if (!/^framework-preview-[\w-]+\.js$/.test(frameworkPreview ?? '')) throw Error('Framework preview is not available in this release');
    return import(new URL('/editor-assets/' + frameworkPreview, location.origin).href);
  })().catch(error => {frameworkCompiler = null; throw error;});
  return frameworkCompiler;
}
export const publicationLanguage = path => ({md: 'markdown', html: 'html', css: 'css', js: 'javascript',
  mjs: 'javascript', json: 'json', ipynb: 'json', geojson: 'json', svg: 'xml', yaml: 'yaml', yml: 'yaml'}[String(path).split('.').pop().toLowerCase()] ?? 'plaintext');

async function loadRuntime() {
  if (!runtime) runtime = (async () => {
    const response = await fetch('/editor-assets/manifest.json', {credentials: 'omit'});
    if (!response.ok) throw Error('Editor assets unavailable');
    const manifest = await response.json();
    const asset = key => {
      if (!/^[a-zA-Z0-9][\w.-]*$/.test(manifest[key] ?? '')) throw Error('Invalid editor asset');
      return new URL('/editor-assets/' + manifest[key], location.origin).href;
    };
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = asset('css');
    const ready = new Promise((resolve, reject) => {css.onload = resolve; css.onerror = () => {css.remove(); reject(Error('Editor styles unavailable'));};});
    document.head.append(css);
    globalThis.MonacoEnvironment = {getWorker: () => new Worker(asset('editor.worker'), {type: 'module', name: 'studio-editor'})};
    const [module] = await Promise.all([import(asset('editor')), ready]);
    return module;
  })().catch(error => {runtime = null; throw error;});
  return runtime;
}

/** Keep the existing exact-byte/save contract; Monaco edits only its text buffer. */
export function PublicationCodeEditor({textarea, onSave, getFrameworkContext, getSourceContext, preview: previewOverride,
  onDispose = () => {}, draftPreviewEnabled = frameworkDraftPreviewEnabled, loadEditor = loadRuntime,
  loadFramework = loadFrameworkCompiler, loadCellTools = loadNotebookCellTools}) {
  const element = document.createElement('div'); element.className = 'publication-code-editor'; element.hidden = true;
  const status = document.createElement('div'); status.className = 'publication-editor-status'; status.setAttribute('role', 'status');
  const tabs = document.createElement('div'); tabs.className = 'publication-file-tabs'; tabs.setAttribute('aria-label', 'Open files');
  const preview = document.createElement('section');
  const modeLabel = document.createElement('label'); modeLabel.className = 'publication-preview-mode'; modeLabel.textContent = 'Preview '; modeLabel.hidden = true;
  const mode = document.createElement('select'); mode.ariaLabel = 'Preview mode';
  for (const [value, label] of [['draft','Live draft'],['saved','Saved build']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; mode.append(option);
  }
  mode.value = 'draft';
  modeLabel.append(mode); preview.append(modeLabel);
  mode.addEventListener('change', () => {void renderPreview();});
  const localPreview = document.createElement('section'); localPreview.className = 'publication-document-preview';
  // Construct saved-build controls only when deliberately selected. Opening a
  // live draft must not list compiler jobs or obtain a one-use capability.
  let savedPreview = typeof previewOverride === 'function' ? null : previewOverride;
  if (savedPreview) {preview.append(savedPreview); savedPreview.hidden = true;}
  preview.append(localPreview);
  const previewPath = document.createElement('p'); previewPath.className = 'source-editor-path';
  preview.prepend(previewPath);
  const heading = document.createElement('h4'); heading.textContent = 'Document preview';
  const note = document.createElement('p'); note.textContent = 'Open a page to preview its current draft.';
  note.setAttribute('role', 'status');
  const download = document.createElement('button'); download.type = 'button'; download.textContent = 'Download HTML'; download.hidden = true;
  const downloadOptions = document.createElement('label'); downloadOptions.className = 'publication-preview-mode'; downloadOptions.hidden = true;
  const allowLargeHtml = document.createElement('input'); allowLargeHtml.type = 'checkbox'; allowLargeHtml.name = 'allow-up-to-96-mib-standalone-html';
  downloadOptions.append(allowLargeHtml, document.createTextNode('Allow HTML up to 96 MiB'));
  downloadOptions.title = 'Includes selected file bytes. Larger exports use more browser memory and download/storage space.';
  const frame = document.createElement('iframe'); frame.title = 'Local document preview'; frame.setAttribute('sandbox', ''); frame.referrerPolicy = 'no-referrer';
  localPreview.append(heading, download, downloadOptions, note, frame);
  const notebookPreview = createObservableNotebookPreview(frame);
  const draftPreview = createFrameworkDraftPreview(frame);
  const notebookPaths = new Set();
  const models = new Map();
  let view, kit, currentPath, epoch = 0, previewEpoch = 0, disposed = false, timer, observer, themeObserver, changing = false, dark = false;
  let downloading = false, downloadSource = null;
  let cellsVisible = false;
  const cells = NotebookCellEditor({textarea, loadTools: loadCellTools,
    onViewChange: visible => {cellsVisible = visible; lock();}});
  cells.element.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); if (!textarea.disabled) onSave();
    }
  });
  const session = globalThis.crypto?.randomUUID?.() ?? String(Date.now());
  let selectFile = () => {};
  download.onclick = async () => {
    if (downloading || disposed || !currentPath) return;
    const token = previewEpoch, path = currentPath, source = textarea.value;
    const isCurrent = () => !disposed && token === previewEpoch && path === currentPath && source === textarea.value;
    downloading = true; download.disabled = true; allowLargeHtml.disabled = true;
    const large = allowLargeHtml.checked;
    try {
      const context = (getSourceContext ?? getFrameworkContext)?.();
      context?.assertStandaloneExport?.();
      let html;
      if (publicationLanguage(path) === 'markdown' && context) {
        const {exportFrameworkStandalone} = await loadFramework();
        if (!isCurrent()) return;
        html = await exportFrameworkStandalone({...context, path, content: source, theme: dark ? 'dark' : 'light',
          outputProfile: large ? 'archive-96m' : 'default-32m', sizeAcknowledgment: large ? 'allow-up-to-96-mib-output' : null,
          isCurrent: () => isCurrent() && (context.isCurrent?.() ?? true)});
      } else {
        html = await exportObservableNotebook({source, path, readFile: context?.readFile ?? (() => {throw Error('Open the notebook attachments with its source files.');})});
      }
      if (!isCurrent() || context?.isCurrent && !context.isCurrent()) return;
      const url = URL.createObjectURL(new Blob([html], {type: 'text/html'}));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = path.split('/').pop().replace(/\.md$/i, '.html');
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      note.textContent = 'Offline HTML downloaded · nothing was published';
    } catch (error) {
      if (isCurrent()) note.textContent = `Download unavailable: ${error.message}`;
    } finally {downloading = false; download.disabled = false; allowLargeHtml.disabled = false;}
  };
  const emit = () => {textarea.dispatchEvent(new textarea.ownerDocument.defaultView.Event('input', {bubbles: true}));};
  function renderTabs() {
    tabs.replaceChildren();
    for (const [path, record] of models) {
      const tab = document.createElement('button'); tab.type = 'button'; tab.title = path;
      tab.textContent = path.split('/').pop() + (record.model.getValue() === record.initial ? '' : ' •');
      tab.setAttribute('aria-pressed', String(path === currentPath)); tab.onclick = () => selectFile(path); tabs.append(tab);
    }
  }
  async function renderPreview() {
    clearTimeout(timer);
    const token = ++previewEpoch;
    draftPreview.dispose();
    const path = currentPath, language = publicationLanguage(path), value = textarea.value;
    const jupyter = /\.ipynb$/i.test(path ?? '');
    const notebook = language === 'html' && (/<notebook(?:\s|>)/i.test(value) || notebookPaths.has(path));
    const context = language === 'markdown' ? (getSourceContext ?? getFrameworkContext)?.() : null;
    modeLabel.hidden = !previewOverride || !path;
    const saved = Boolean(previewOverride && mode.value === 'saved');
    if (saved && !savedPreview) {
      savedPreview = previewOverride();
      preview.insertBefore(savedPreview, localPreview);
    }
    download.hidden = !(notebook || context);
    downloadOptions.hidden = !context;
    const nextDownloadSource = path + '\n' + value;
    if (downloadSource !== nextDownloadSource) {allowLargeHtml.checked = false; downloadSource = nextDownloadSource;}
    if (notebook) notebookPaths.add(path);
    localPreview.hidden = saved;
    if (savedPreview) {
      if (!saved && !savedPreview.hidden) savedPreview.closePreview?.();
      savedPreview.hidden = !saved;
    }
    if (saved) {notebookPreview.dispose(); frame.removeAttribute('srcdoc'); return;}
    if (notebook) {
      heading.textContent = 'Observable Notebook preview'; frame.title = 'Observable Notebook live preview';
      note.textContent = 'Updating notebook…';
      try {
        const context = (getSourceContext ?? getFrameworkContext)?.();
        await notebookPreview.render({source: value, path, readFile: context?.readFile ?? (() => {throw Error('Open the notebook attachments with its source files.');}),
          theme: dark ? 'dark' : 'light', isCurrent: () => !disposed && token === previewEpoch});
        if (!disposed && token === previewEpoch) note.textContent = 'Local draft · reactive cells · network disabled';
      } catch (error) {
        if (disposed || token !== previewEpoch) return;
        notebookPreview.dispose(); note.textContent = `Preview unavailable: ${error.message}`;
      }
      return;
    }
    notebookPreview.dispose();
    if (language === 'html' && draftPreviewEnabled) {
      heading.textContent = 'HTML preview'; frame.title = 'HTML draft preview';
      note.textContent = 'Rendering draft…';
      try {
        await draftPreview.render(value, () => !disposed && token === previewEpoch);
        if (!disposed && token === previewEpoch) note.textContent = 'Live draft · local scripts · network disabled';
      } catch (error) {
        if (!disposed && token === previewEpoch) note.textContent = `Preview unavailable: ${error.message}`;
      }
      return;
    }
    if (jupyter) {
      heading.textContent = 'Jupyter preview';
      frame.title = 'Jupyter saved-output preview';
      frame.setAttribute('sandbox', '');
      if (!kit) {note.textContent = 'Loading notebook preview…'; return;}
      try {
        const context = (getSourceContext ?? getFrameworkContext)?.();
        const html = await kit.renderJupyterNotebookWithFiles(value, {document: textarea.ownerDocument, renderMarkdown: kit.renderMarkdown, dark,
          path, sourceRoot: context?.sourceRoot, readFile: context?.readFile});
        if (disposed || token !== previewEpoch) return;
        frame.srcdoc = html;
        note.textContent = 'Saved outputs may be stale after edits · editing does not run a kernel';
      } catch (error) {
        if (disposed || token !== previewEpoch) return;
        frame.removeAttribute('srcdoc'); note.textContent = `Preview unavailable: ${error.message}`;
      }
      return;
    }
    if (context && draftPreviewEnabled) {
      heading.textContent = 'Framework preview';
      note.textContent = 'Rendering draft…';
      frame.title = 'Framework draft preview';
      frame.setAttribute('sandbox', 'allow-scripts');
      try {
        const {renderFrameworkPreview} = await loadFramework();
        const result = await renderFrameworkPreview({...context, path, content: value, theme: dark ? 'dark' : 'light'});
        if (disposed || token !== previewEpoch) return;
        await draftPreview.render(result.html, () => !disposed && token === previewEpoch, result.attachments);
        if (disposed || token !== previewEpoch) return;
        note.textContent = result.warnings.length ? result.warnings.join(' · ') : 'Live draft · edits appear here · nothing is published';
      } catch (error) {
        if (disposed || token !== previewEpoch) return;
        draftPreview.dispose();
        frame.removeAttribute('srcdoc');
        note.textContent = `Preview unavailable: ${error.message}`;
      }
      return;
    }
    heading.textContent = 'Document preview';
    note.textContent = 'Local draft · scripts are not executed';
    frame.title = 'Local document preview';
    frame.setAttribute('sandbox', '');
    let body;
    if (language === 'markdown') {
      if (!kit) {note.textContent = 'Loading document preview…'; return;}
      body = kit.renderMarkdown(value.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ''));
    }
    else if (language === 'html' || language === 'xml') {
      const parsed = new DOMParser().parseFromString(value, 'text/html');
      for (const node of parsed.querySelectorAll('script,iframe,object,embed,base,meta,link,form')) node.remove();
      for (const node of parsed.querySelectorAll('*')) for (const attr of [...node.attributes]) {
        if (/^on/i.test(attr.name) || ['href','srcdoc','action','formaction'].includes(attr.name)) node.removeAttribute(attr.name);
      }
      body = parsed.body.innerHTML;
    } else body = '<p>Open a Markdown or HTML page to preview its content.</p>';
    // No scripts, network fetches or submission. This is not a built Framework preview.
    frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'"><style>body{font:16px/1.6 system-ui;margin:24px;color:${dark ? '#ddd' : '#222'};background:${dark ? '#1e1e1e' : '#fff'}}pre{overflow:auto;font-size:13px}img{max-width:100%}h1,h2{line-height:1.2}</style>${body}`;
  }
  function theme() {
    if (!kit) return;
    const bg = getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.map(Number);
    dark = bg?.length >= 3 && bg.slice(0,3).reduce((a,b) => a+b,0) < 384;
    kit.monaco.editor.setTheme(dark ? 'vs-dark' : 'vs');
    frame.style.colorScheme = dark ? 'dark' : 'light';
    renderPreview();
  }
  function lock() {
    view?.updateOptions({readOnly: textarea.disabled || textarea.readOnly});
    element.hidden = textarea.hidden || !view || cellsVisible;
    if (view || cellsVisible) textarea.style.display = 'none';
    else textarea.style.removeProperty('display');
  }
  function dispose() {
    if (disposed) return; disposed = true; epoch++; previewEpoch++; clearTimeout(timer);
    onDispose();
    notebookPreview.dispose();
    draftPreview.dispose();
    cells.dispose();
    observer?.disconnect(); themeObserver?.disconnect(); view?.dispose();
    for (const record of models.values()) record.model.dispose(); models.clear();
    textarea.style.removeProperty('display');
  }
  textarea.addEventListener('input', () => {
    if (view?.getModel() && !changing && view.getValue() !== textarea.value) {
      view.executeEdits('source-input', [{range: view.getModel().getFullModelRange(), text: textarea.value}]);
    }
    // Cells and the accessible plain-text editor use the same draft buffer.
    // They must refresh even while Monaco is loading or unavailable.
    if (!changing) {previewEpoch++; clearTimeout(timer); timer = setTimeout(renderPreview, 250);}
  });
  return {element, tabs, status, preview, cells: cells.element, dispose,
    refreshPreview() {previewEpoch++; void renderPreview();},
    onSelect(callback) {selectFile = callback;},
    showDraft() {
      if (mode.value === 'draft') return;
      mode.value = 'draft'; void renderPreview();
    },
    loading(path) {
      epoch++; previewEpoch++; clearTimeout(timer);
      allowLargeHtml.checked = false; downloadSource = null; download.hidden = true; downloadOptions.hidden = true;
      notebookPreview.dispose(); draftPreview.dispose(); savedPreview?.closePreview?.();
      mode.value = 'draft'; if (savedPreview) savedPreview.hidden = true;
      localPreview.hidden = false; previewPath.textContent = path ?? '';
      note.textContent = `Opening ${path ?? 'page'}…`;
    },
    reset() {epoch++; previewEpoch++; clearTimeout(timer); allowLargeHtml.checked = false; downloadSource = null; download.hidden = true; downloadOptions.hidden = true; currentPath = null; previewPath.textContent = ''; cells.hide(); notebookPreview.dispose(); draftPreview.dispose(); savedPreview?.closePreview?.(); notebookPaths.clear(); view?.setModel(null); for (const record of models.values()) record.model.dispose(); models.clear(); tabs.replaceChildren(); frame.removeAttribute('srcdoc');},
    hide() {epoch++; previewEpoch++; clearTimeout(timer); allowLargeHtml.checked = false; downloadSource = null; download.hidden = true; downloadOptions.hidden = true; currentPath = null; previewPath.textContent = ''; cells.hide(); notebookPreview.dispose(); draftPreview.dispose(); savedPreview?.closePreview?.(); element.hidden = true; frame.removeAttribute('srcdoc'); note.textContent = 'Choose a Markdown, HTML or notebook page in the Explorer to preview it.';},
    insert(text, offset) {
      if (textarea.disabled || textarea.hidden) throw Error('Open an editable page first');
      if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || offset > textarea.value.length)) throw Error('Invalid insertion position');
      if (view && !element.hidden) {
        const position = offset === undefined ? null : view.getModel().getPositionAt(offset);
        const range = position ? {startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column} : view.getSelection();
        view.executeEdits('insert-map', [{range, text, forceMoveMarkers: true}]); view.focus();
      } else {textarea.setRangeText(text, offset ?? textarea.selectionStart, offset ?? textarea.selectionEnd, 'end'); emit();}
    },
    async open(path, value) {
      const token = ++epoch; previewEpoch++; currentPath = path;
      previewPath.textContent = path;
      if (!observer && textarea.isConnected) {
        observer = new MutationObserver(changes => {if (!textarea.isConnected) dispose(); else if (changes.some(change => change.target === textarea)) lock();});
        observer.observe(document.body, {childList: true, subtree: true});
        observer.observe(textarea, {attributes: true, attributeFilter: ['disabled', 'readonly', 'hidden']});
      }
      if (globalThis.Worker) void cells.open(path);
      else cells.hide();
      if (textarea.isConnected) void renderPreview();
      if (!textarea.isConnected || !globalThis.Worker) return; // Accessible fallback in non-browser environments.
      try {
        kit = await loadEditor();
        if (disposed || token !== epoch || !textarea.isConnected) return;
        if (!view) {
          element.hidden = false;
          view = kit.monaco.editor.create(element, {model: null, automaticLayout: true, fontSize: 13, lineHeight: 21,
            minimap: {enabled: false}, lineNumbers: 'on', wordWrap: 'on', scrollBeyondLastLine: false,
            tabSize: 2, padding: {top: 12}, ariaLabel: 'Publication code editor', fixedOverflowWidgets: true});
          view.addCommand(kit.monaco.KeyMod.CtrlCmd | kit.monaco.KeyCode.KeyS, () => onSave());
          view.onDidChangeModelContent(() => {
            if (changing) return;
            previewEpoch++;
            changing = true; textarea.value = view.getValue(); emit(); changing = false;
            renderTabs(); clearTimeout(timer); timer = setTimeout(renderPreview, 250);
          });
          view.onDidChangeCursorPosition(() => {const p = view.getPosition(); status.textContent = `Ln ${p.lineNumber}, Col ${p.column} · ${publicationLanguage(currentPath)}`;});
          themeObserver = new MutationObserver(theme); themeObserver.observe(document.documentElement, {attributes: true});
        }
        const previous = models.get(view.getModel()?.uri.path.slice(1));
        if (previous) previous.position = view.saveViewState();
        if (!models.has(path)) models.set(path, {initial: value, model: kit.monaco.editor.createModel(textarea.value, publicationLanguage(path), kit.monaco.Uri.from({scheme: 'studio', authority: session, path: '/' + path}))});
        const record = models.get(path);
        changing = true;
        if (record.model.getValue() !== textarea.value) record.model.setValue(textarea.value);
        view.setModel(record.model); changing = false;
        if (record.position) view.restoreViewState(record.position);
        textarea.style.display = 'none'; lock(); renderTabs(); theme();
      } catch {
        if (disposed || token !== epoch || !textarea.isConnected) return;
        status.textContent = 'Code editor unavailable. Plain-text editing remains available.';
        if (!cellsVisible) textarea.style.removeProperty('display');
        element.hidden = true;
      }
    }
  };
}
