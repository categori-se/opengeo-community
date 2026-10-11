import {PublicationCodeEditor} from './PublicationCodeEditor.js';
import {PublicationCommands} from './PublicationCommands.js';
import {PublicationPanels} from './PublicationPanels.js';
import {SourceFileExplorer} from './SourceFileExplorer.js';
import {createFrameworkDraftPreview} from './FrameworkDraftPreview.js';
import {publicationStarter} from '../lib/publicationDrafts.js';

export const DEMO_PUBLICATION_IDLE_MS = 5 * 60 * 1000;
export const DEMO_PUBLICATIONS = Object.freeze([
  {id: 'framework', format: 'framework', title: 'Framework project', summary: 'Write pages in folders and preview reactive Markdown.'},
  {id: 'notebook', format: 'notebook', title: 'Observable Notebook', summary: 'Edit reactive cells and preview a notebook with a live input.'},
  {id: 'jupyter', format: 'jupyter', title: 'Jupyter / IPython notebook', summary: 'Edit Python and Markdown cells; preview retained outputs without running a kernel.'},
  {id: 'html', format: 'html', title: 'HTML publication', summary: 'Edit a standalone page and preview its local interaction.'}
]);
const PREVIEW_POLICY = "default-src 'none'; script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data:; img-src data: blob:; connect-src data: blob:; font-src data:; frame-src 'none'; worker-src blob:; form-action 'none'; base-uri 'none'";
let assets;
async function previewKit(key) {
  assets ??= fetch('/editor-assets/manifest.json', {credentials: 'omit'}).then(async response => {
    if (!response.ok) throw Error('Local publication assets are unavailable.');
    return response.json();
  }).catch(error => {assets = null; throw error;});
  const name = (await assets)[key];
  if (!/^[a-zA-Z0-9][\w.-]*\.js$/.test(name ?? '')) throw Error('Local preview asset is unavailable.');
  return import(new URL('/editor-assets/' + name, location.origin).href);
}
const bytes = value => new TextEncoder().encode(value).byteLength;
const validPath = value => typeof value === 'string' && value.length <= 180
  && value.split('/').every(part => /^[\w][\w .-]*$/.test(part) && !['.', '..'].includes(part));
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));

/** Anonymous authoring uses the native editor, with an in-memory source tree.
 * No adapter, authentication, uploads, provider calls or publication API. */
export function PublicDemoPublication({format = 'framework', idleMs = DEMO_PUBLICATION_IDLE_MS,
  now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
  loadPreview = previewKit, createEditor = PublicationCodeEditor,
  createFrameworkPreview = createFrameworkDraftPreview} = {}) {
  const root = document.createElement('section'); root.className = 'public-demo-publication-workspace';
  const node = (tag, value = '') => {const element = document.createElement(tag); element.textContent = value; return element;};
  const button = (value, action) => {const element = node('button', value); element.type = 'button'; element.onclick = action; return element;};
  const status = node('p', 'Opening the browser draft…'); status.setAttribute('role', 'status');
  const title = node('h1', 'Try publishing');
  const selector = node('select'); selector.ariaLabel = 'Demo publication';
  const notice = node('p', 'Browser-only practice. Drafts and simulated releases reset after 5 minutes without activity, on leaving, or on reload. Download your source before they reset.');
  notice.className = 'public-demo-publication-notice';
  const header = node('header'); header.append(title, selector);
  const textarea = node('textarea'); textarea.ariaLabel = 'Publication source'; textarea.spellcheck = false;
  const selectedPath = node('span'); selectedPath.className = 'public-demo-publication-path';
  const save = button('Save browser draft', () => {if (!selected) return; stash(); selected.revision++; selected.dirty = false; invalidate(); status.textContent = `Browser draft saved · revision ${selected.revision}. Nothing was uploaded.`;});
  const downloadSource = button('Download source', () => downloadTree());
  const editor = createEditor({textarea, onSave: () => save.click(), preview: node('section'), draftPreviewEnabled: false,
    getSourceContext: () => ({sourceRoot: '', readFile: readFile})});
  const explorer = SourceFileExplorer({onSelect: path => openFile(path), onNewPage: folder => newPage(folder)});
  editor.onSelect(path => openFile(path));
  const files = node('div'); files.className = 'public-demo-publication-files';
  const sidebar = node('aside'); sidebar.append(node('h2', 'Explorer'), button('New page', () => newPage(explorer.folder ?? '')), explorer.element);
  const source = node('section'); source.append(selectedPath, editor.tabs, editor.cells, textarea, editor.element, editor.status);
  files.append(sidebar, source);
  const frame = node('iframe'); frame.title = 'Demo publication preview'; frame.setAttribute('sandbox', 'allow-scripts'); frame.referrerPolicy = 'no-referrer';
  const frameworkPreview = createFrameworkPreview(frame);
  const previewNotice = node('p', 'Preview uses local assets. External connections are blocked.');
  const downloadHtml = button('Download preview HTML', () => {
    if (!compiled) {status.textContent = 'Render a preview first.'; return;}
    try {download(compiled, 'publication.html', 'text/html'); status.textContent = 'Preview HTML download requested · entry page only. Nothing was published.';}
    catch (error) {status.textContent = `Preview HTML download unavailable: ${error.message}`;}
  }); downloadHtml.disabled = true;
  const previewTools = node('div'); previewTools.className = 'public-demo-publication-preview-tools';
  previewTools.append(button('Refresh preview', () => void renderPreview()), downloadHtml);
  const preview = node('section'); preview.append(previewTools, previewNotice, frame);
  const destination = node('input'); destination.ariaLabel = 'Simulated public path'; destination.placeholder = '/examples/my-publication/';
  const addressLabel = node('label', 'Simulated public path'); addressLabel.append(destination);
  const settings = node('section'); settings.append(node('h2', 'Public address'), addressLabel,
    node('p', 'Practice a distinct destination for each Publication. This setting creates no hosted URL. In Studio, an owner chooses a destination and approves the exact build.'));
  destination.addEventListener('input', () => {if (selected) {selected.path = destination.value; invalidate();}});
  const releaseStatus = node('p'); releaseStatus.setAttribute('role', 'status');
  const reviewBody = node('div');
  const consent = node('input'); consent.type = 'checkbox'; consent.ariaLabel = 'Approve this simulated release';
  const consentLabel = node('label'); consentLabel.className = 'public-demo-publication-consent'; consentLabel.append(consent, node('span', 'I reviewed this browser-only simulated release.'));
  const publish = button('Complete simulated release', () => {
    if (!review || !consent.checked || review.document !== selected || review.revision !== selected.revision || review.signature !== signature()) {
      releaseStatus.textContent = 'Review the current source and address, then approve this simulated release.'; return;
    }
    selected.release = review; releaseStatus.textContent = `Simulated release complete · ${review.path} · revision ${review.revision}. No endpoint was created. Download the HTML to keep this result.`;
    publish.disabled = true;
  }); publish.disabled = true;
  consent.addEventListener('change', () => {publish.disabled = !review || !consent.checked;});
  const release = node('section'); release.append(node('h2', 'Release review'),
    node('p', 'Review a local snapshot, its files and destination. Publishing is simulated here; real owner publication requires Studio.'),
    node('p', 'The demo compiles the entry page for review. Download source includes all pages; Studio builds the complete project.'),
    button('Prepare simulated release review', () => void prepareReview()), reviewBody, consentLabel, publish, releaseStatus);
  const panels = PublicationPanels({panels: [
    {id: 'files', label: 'Files', render: () => files},
    {id: 'preview', label: 'Preview', render: () => {void renderPreview(); return preview;}},
    {id: 'publish', label: 'Publish', render: () => release},
    {id: 'settings', label: 'Settings', render: () => settings}
  ]});
  const commands = PublicationCommands({menus: [
    {label: 'File', commands: [{label: 'New publication…', run: newPublication}, {label: 'New page…', run: () => newPage(explorer.folder ?? '')},
      {label: 'Save browser draft', run: () => save.click()}, {label: 'Download source', run: downloadTree}, {label: 'Reset demo', run: () => void reset('Demo reset.')} ]},
    {label: 'View', commands: [{label: 'Files', run: () => panels.selectPanel('files')}, {label: 'Preview', run: () => {panels.selectPanel('preview'); void renderPreview();}},
      {label: 'Release review', run: () => panels.selectPanel('publish')}, {label: 'Public address', run: () => panels.selectPanel('settings')} ]}
  ]});
  const actions = node('div'); actions.className = 'public-demo-publication-actions'; actions.append(save, downloadSource);
  root.append(header, notice, commands, actions, panels, status);
  let documents = [], selected = null, currentPath = null, review = null, compiled = null, epoch = 0, disposed = false, timer, lastActivity = now(), observer;
  const dialogs = new Set(), downloadUrls = new Set();
  selector.addEventListener('change', () => {stash(); select(documents.find(item => item.id === selector.value));});
  textarea.addEventListener('input', () => {
    if (!selected || !currentPath) return;
    const size = bytes(textarea.value) + [...selected.files].reduce((sum, [path, value]) => sum + (path === currentPath ? 0 : bytes(value)), 0);
    if (size > 2 * 1024 * 1024) {
      textarea.value = selected.files.get(currentPath); void editor.open(currentPath, textarea.value);
      status.textContent = 'Edit exceeds this demo’s 2 MiB source limit. The previous source was retained.'; return;
    }
    stash(); selected.dirty = true; invalidate(); status.textContent = 'Edited browser draft · save or download to keep a local copy.';
  });
  function invalidate() {epoch++; compiled = null; downloadHtml.disabled = true; review = null; consent.checked = false; publish.disabled = true; reviewBody.replaceChildren(); releaseStatus.textContent = '';}
  function signature() {return JSON.stringify([...selected.files]) + destination.value;}
  function stash() {if (selected && currentPath) selected.files.set(currentPath, textarea.value);}
  function readFile(path) {const value = selected?.files.get(path); if (value === undefined) throw Error(`Source file is missing: ${path}`); return Promise.resolve(new Blob([value], {type: /\.md$/.test(path) ? 'text/markdown' : 'text/plain'}));}
  function select(value) {
    if (!value || disposed) return;
    stash(); currentPath = null;
    selected = value; selector.value = value.id; destination.value = value.path; editor.reset(); invalidate();
    frameworkPreview.dispose(); frame.removeAttribute('srcdoc');
    title.textContent = value.title; explorer.update([...value.files.keys()]); openFile(value.entry);
    status.textContent = `Browser draft · ${DEMO_PUBLICATIONS.find(item => item.format === value.format).title}.`;
  }
  function openFile(path) {
    if (!selected?.files.has(path)) return;
    stash(); currentPath = path; textarea.value = selected.files.get(path); selectedPath.textContent = path;
    explorer.select(path); void editor.open(path, textarea.value);
  }
  function formDialog(label, render) {
    const dialog = node('dialog'); dialog.className = 'public-demo-publication-dialog'; dialog.ariaLabel = label;
    const form = node('form'); form.append(node('h2', label)); dialog.append(form);
    render(form, () => {if (typeof dialog.close === 'function') dialog.close(); else dialog.remove();});
    dialog.addEventListener('close', () => {dialogs.delete(dialog); dialog.remove();}, {once: true});
    dialogs.add(dialog); root.append(dialog); if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.open = true;
  }
  function newPage(folder) {
    if (!selected) return;
    formDialog('New page', (form, close) => {
      const path = node('input'); path.required = true; path.ariaLabel = 'Page source path';
      path.value = folder + (selected.format === 'framework' ? 'page.md' : selected.format === 'jupyter' ? 'page.ipynb' : 'page.html');
      const error = node('p'); error.setAttribute('role', 'alert'); const add = node('button', 'Create page'); add.type = 'submit';
      form.append(node('p', 'Enter a source path, including a folder when needed. Public addresses are separate.'), path, error, add, button('Cancel', close));
      form.addEventListener('submit', async event => {
        event.preventDefault(); const target = path.value.trim();
        const extension = selected.format === 'framework' ? '.md' : selected.format === 'jupyter' ? '.ipynb' : '.html';
        if (!validPath(target) || !target.endsWith(extension)) {error.textContent = `Use a local source path ending in ${extension}.`; return;}
        if (selected.files.has(target)) {error.textContent = 'That source path already exists. Choose another name.'; return;}
        if (selected.files.size >= 32) {error.textContent = 'This demo allows 32 files per Publication.'; return;}
        const document = selected;
        const starter = publicationStarter({format: document.format, title: 'New page', sourceProject: {}});
        const content = await starter.files[0].blob.text();
        if (disposed || document !== selected || !dialogConnected(form)) return;
        stash(); document.files.set(target, content); document.dirty = true; invalidate(); explorer.update([...document.files.keys()]);
        openFile(target); panels.selectPanel('files'); close();
      });
    });
  }
  function dialogConnected(form) {return root.contains(form);}
  function newPublication() {
    formDialog('New publication', (form, close) => {
      const name = node('input'); name.ariaLabel = 'Publication title'; name.required = true; name.maxLength = 100; name.value = 'My publication';
      const type = node('select'); type.ariaLabel = 'Publication format';
      for (const item of DEMO_PUBLICATIONS) {const option = node('option', item.title); option.value = item.format; type.append(option);}
      const error = node('p'); error.setAttribute('role', 'alert'); const create = node('button', 'Create browser publication'); create.type = 'submit';
      form.append(name, type, error, create, button('Cancel', close));
      form.addEventListener('submit', async event => {
        event.preventDefault(); if (documents.length >= 8) {error.textContent = 'This demo allows eight Publications. Reset to start again.'; return;}
        const token = epoch; create.disabled = true;
        const document = await starterDocument(type.value, name.value.trim(), `draft-${crypto.randomUUID()}`);
        if (disposed || token !== epoch || !dialogConnected(form)) return;
        stash(); documents.push(document); updateChoices(); select(document); panels.selectPanel('files'); close();
      });
    });
  }
  function updateChoices() {selector.replaceChildren(...documents.map(item => {const option = node('option', item.title); option.value = item.id; return option;}));}
  async function reset(message) {
    const token = ++epoch; editor.reset(); frameworkPreview.dispose(); frame.removeAttribute('srcdoc');
    for (const dialog of dialogs) dialog.remove(); dialogs.clear();
    for (const url of downloadUrls) URL.revokeObjectURL(url); downloadUrls.clear();
    selected = null; currentPath = null; documents = [];
    const next = await Promise.all(DEMO_PUBLICATIONS.map(item => starterDocument(item.format, item.title, item.id)));
    if (disposed || token !== epoch) return;
    documents = next; updateChoices(); select(documents.find(item => item.format === format) ?? documents[0]);
    status.textContent = message || 'Browser draft ready. Nothing is saved to an account.'; lastActivity = now(); schedule();
  }
  async function renderPreview() {
    if (!selected) return;
    stash(); const token = ++epoch, document = selected, path = currentPath, content = textarea.value;
    const snapshot = new Map(document.files);
    const readSnapshot = relativePath => {
      const value = snapshot.get(relativePath); if (value === undefined) throw Error(`Source file is missing: ${relativePath}`);
      return Promise.resolve(new Blob([value], {type: /\.md$/.test(relativePath) ? 'text/markdown' : 'text/plain'}));
    };
    compiled = null; downloadHtml.disabled = true; previewNotice.textContent = 'Rendering in this browser…'; frameworkPreview.dispose(); frame.removeAttribute('srcdoc');
    try {
      if (bytes(signature()) > 2 * 1024 * 1024) throw Error('This demo supports at most 2 MiB of source per Publication.');
      let html;
      if (path.endsWith('.md')) {
        const kit = await loadPreview('frameworkPreview');
        const result = await kit.renderFrameworkPreview({path, content, sourceRoot: '', readFile: readSnapshot, theme: 'dark'}); html = result.html;
      } else if (path.endsWith('.ipynb')) {
        const kit = await loadPreview('editor'); html = await kit.renderJupyterNotebookWithFiles(content, {document: root.ownerDocument, renderMarkdown: kit.renderMarkdown, dark: true, path, readFile: readSnapshot});
      } else if (/<notebook(?:\s|>)/i.test(content)) {
        const kit = await loadPreview('notebookPreview'); html = await kit.renderNotebookDocument({source: content, path, readFile: readSnapshot});
      } else if (path.endsWith('.html')) {
        const parsed = new DOMParser().parseFromString(content, 'text/html');
        for (const element of parsed.querySelectorAll('base,meta[http-equiv]')) element.remove();
        html = '<!doctype html>' + parsed.documentElement.outerHTML;
      } else throw Error('Open a page or notebook to preview its content.');
      if (disposed || token !== epoch || selected !== document) return;
      // Add the stricter policy before any authored nodes. Opaque origin and
      // CSP keep imported scripts, URL images and source fetches off the network.
      const policy = document.format === 'notebook' ? PREVIEW_POLICY.replace("script-src 'unsafe-inline'", "script-src 'unsafe-inline' 'unsafe-eval'") : PREVIEW_POLICY;
      compiled = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">${html}`;
      if (path.endsWith('.md')) {
        await frameworkPreview.render(compiled, () => !disposed && token === epoch && selected === document);
        if (disposed || token !== epoch || selected !== document) return;
      } else frame.srcdoc = compiled;
      downloadHtml.disabled = false;
      previewNotice.textContent = path.endsWith('.ipynb') ? 'Saved outputs only · no Python kernel. Outputs may be stale after edits.'
        : path.endsWith('.md') ? 'Reactive draft · initial preview loads the public isolated shell; source stays in this tab. Dependencies are limited to local files and the bundled runtime. Studio performs the production build.'
        : 'Local preview · network disabled. Studio performs the reviewed production build.';
    } catch (error) {if (!disposed && token === epoch) {compiled = null; downloadHtml.disabled = true; previewNotice.textContent = `Preview unavailable: ${error.message}`; frameworkPreview.dispose(); frame.removeAttribute('srcdoc');}}
  }
  async function prepareReview() {
    if (!selected) return;
    stash(); const path = destination.value.trim();
    if (!/^\/(?:[a-z0-9][a-z0-9-]*\/)*$/.test(path)) {releaseStatus.textContent = 'Choose a path such as /examples/my-publication/ or /.'; return;}
    if (selected.dirty) {releaseStatus.textContent = 'Save the browser draft before reviewing its exact source revision.'; return;}
    if (documents.some(item => item !== selected && item.release?.path === path)) {releaseStatus.textContent = 'Another simulated release already uses this path. Choose a different destination.'; return;}
    const document = selected, revision = document.revision, sourceSignature = signature();
    if (currentPath !== document.entry) openFile(document.entry);
    await renderPreview();
    if (disposed || selected !== document || revision !== document.revision || signature() !== sourceSignature || !compiled) return;
    review = {document, revision, signature: sourceSignature, path, html: compiled}; consent.checked = false; publish.disabled = true;
    const list = node('ul'); for (const [path, source] of document.files) list.append(node('li', `${path} · ${bytes(source)} bytes`));
    reviewBody.replaceChildren(node('p', `${document.title} · revision ${revision} · ${path}`), list);
    releaseStatus.textContent = 'Source snapshot ready for review. This release stays in this tab.';
  }
  function download(content, filename, type) {
    const url = URL.createObjectURL(new Blob([content], {type})); downloadUrls.add(url);
    const link = node('a'); link.href = url; link.download = filename; link.hidden = true;
    // Keep the native download anchor attached through browser dispatch. HTML
    // blobs must be downloaded, never navigated in the authoring workspace.
    root.append(link); link.click();
    setTimeout(() => {link.remove(); URL.revokeObjectURL(url); downloadUrls.delete(url);}, 1000);
  }
  function downloadTree() {
    if (!selected) return; stash();
    download(JSON.stringify({schema: 'opengeo.demo-publication-source.1', format: selected.format,
      title: selected.title, entryPath: selected.entry, files: [...selected.files].map(([relativePath, content]) => ({relativePath, content}))}, null, 2),
    'publication-source.json', 'application/json');
    status.textContent = 'Source downloaded · this file contains every page in the browser draft.';
  }
  function schedule() {clearTimer(timer); timer = setTimer(expire, Math.max(1, idleMs - (now() - lastActivity)));}
  function expire() {if (disposed) return; if (now() - lastActivity >= idleMs) void reset('Drafts reset after inactivity. Download your source before leaving.'); else schedule();}
  function activity() {if (now() - lastActivity >= idleMs) {expire(); return;} lastActivity = now(); schedule();}
  for (const event of ['input', 'click', 'keydown']) root.addEventListener(event, activity, true);
  const visibility = () => {if (!root.ownerDocument.hidden) expire();}; root.ownerDocument.addEventListener('visibilitychange', visibility);
  root.dispose = () => {
    if (disposed) return; disposed = true; epoch++; clearTimer(timer); editor.dispose(); frameworkPreview.dispose(); observer?.disconnect();
    root.ownerDocument.removeEventListener('visibilitychange', visibility); frame.removeAttribute('srcdoc');
    for (const dialog of dialogs) dialog.remove(); dialogs.clear();
    for (const url of downloadUrls) URL.revokeObjectURL(url); downloadUrls.clear();
    for (const event of ['input', 'click', 'keydown']) root.removeEventListener(event, activity, true);
    documents = []; selected = null; review = null; compiled = null; textarea.value = '';
  };
  let attached = false;
  observer = new MutationObserver(() => {if (root.isConnected) attached = true; else if (attached) root.dispose();});
  observer.observe(root.ownerDocument.body, {childList: true, subtree: true});
  root.ready = reset();
  return root;
}

async function starterDocument(format, title, id) {
  const starter = publicationStarter({format, title, sourceProject: {}});
  const files = new Map(await Promise.all(starter.files.map(async file => [file.relativePath, await file.blob.text()])));
  const example = DEMO_PUBLICATIONS.some(item => item.id === id);
  if (example && format === 'framework') {
    files.set('index.md', `---\ntitle: ${JSON.stringify(title)}\n---\n\n# A browser publication\n\nThis example uses three invented facilities to explain a reusable data story. Edit the heading or input and preview it.\n\n\x60\x60\x60js\nconst facilities = [{name: "Library", visitors: 140}, {name: "Clinic", visitors: 90}, {name: "Shelter", visitors: 60}];\nconst minimum = view(Inputs.range([0, 150], {label: "Minimum daily visitors", value: 50}));\n\x60\x60\x60\n\n\x60\x60\x60js\nInputs.table(facilities.filter(facility => facility.visitors >= minimum))\n\x60\x60\x60\n\n[Read the method](chapters/method.md).\n`);
    files.set('chapters/method.md', '# Method and limits\n\nThe three facilities and visitor counts are fictional. The slider filters their embedded records in this browser. No external data or service is queried.\n');
  } else if (example && format === 'jupyter') {
    const notebook = JSON.parse(files.get(starter.entryPath));
    notebook.cells[0].source = '# A Python publication\n\nEdit cells and preview their retained outputs. Python is not executed in this demo.\n';
    notebook.cells[1].source = 'facilities = {"Library": 140, "Clinic": 90, "Shelter": 60}\nprint(sum(facilities.values()))';
    notebook.cells[1].execution_count = 1; notebook.cells[1].outputs = [{output_type: 'stream', name: 'stdout', text: '290\n'}];
    files.set(starter.entryPath, JSON.stringify(notebook, null, 2));
  } else if (example && format === 'html') {
    files.set(starter.entryPath, `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(title)}</title><style>body{font:16px/1.6 system-ui;margin:2rem;color-scheme:dark light}label{display:block}table{border-collapse:collapse}th,td{padding:.5rem 1rem;text-align:left}</style><body><h1>A standalone HTML publication</h1><p>These invented facilities demonstrate a local page interaction.</p><label>Minimum visitors <input type="range" min="0" max="150" value="0" id="minimum"><output id="threshold">0</output></label><table><thead><tr><th>Facility</th><th>Daily visitors</th></tr></thead><tbody><tr data-count="140"><td>Library</td><td>140</td></tr><tr data-count="90"><td>Clinic</td><td>90</td></tr><tr data-count="60"><td>Shelter</td><td>60</td></tr></tbody></table><p>No external data or service is queried.</p><script>document.querySelector('#minimum').addEventListener('input',event=>{document.querySelector('#threshold').value=event.target.value;for(const row of document.querySelectorAll('[data-count]'))row.hidden=Number(row.dataset.count)<Number(event.target.value);});</script></body></html>`);
  }
  return {id, format, title, entry: starter.entryPath, files, revision: 1, dirty: false, path: `/examples/${id}/`, release: null};
}
