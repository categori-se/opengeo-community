import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {PublicDemoPublication, DEMO_PUBLICATIONS, DEMO_PUBLICATION_IDLE_MS} from '../src/components/PublicDemoPublication.js';

function fixture() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: 'https://demo.studio.opengeo.tools/?publication=framework'});
  const previous = new Map();
  for (const [name, value] of Object.entries({document: dom.window.document, location: dom.window.location,
    MutationObserver: dom.window.MutationObserver, DOMParser: dom.window.DOMParser})) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  }
  let clock = 0, timer, editorDisposed = false;
  const editor = () => ({element: dom.window.document.createElement('div'), tabs: dom.window.document.createElement('div'),
    cells: dom.window.document.createElement('div'), status: dom.window.document.createElement('div'),
    reset() {}, open() {}, onSelect() {}, dispose() {editorDisposed = true;}});
  const previews = [];
  const root = PublicDemoPublication({createEditor: editor, now: () => clock,
    createFrameworkPreview: frame => ({dispose() {frame.removeAttribute('srcdoc');}, async render(html) {frame.srcdoc = html;}}),
    setTimer: callback => {timer = callback; return 1;}, clearTimer: () => {timer = null;},
    loadPreview: async key => ({async renderFrameworkPreview(value) {previews.push(value); return {html: '<h1>Draft</h1>'};},
      async renderJupyterNotebookWithFiles(source) {previews.push(JSON.parse(source)); return '<pre>290</pre>';},
      async renderNotebookDocument(source) {previews.push(source); return '<h1>Notebook</h1>';}})});
  dom.window.document.body.append(root);
  const find = label => [...root.querySelectorAll('button')].find(button => button.textContent === label);
  const input = (element, value) => {element.value = value; element.dispatchEvent(new dom.window.Event('input', {bubbles: true}));};
  const select = value => {const element = root.querySelector('select[aria-label="Demo publication"]'); element.value = value; element.dispatchEvent(new dom.window.Event('change'));};
  return {root, dom, previews, find, input, select,
    get disposed() {return editorDisposed;},
    expire() {clock += DEMO_PUBLICATION_IDLE_MS; timer();},
    cleanup() {root.dispose(); for (const [name, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; dom.window.close();}};
}
const settle = async () => {for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));};

test('all four formats keep independent memory drafts and add a page in a selected folder', async () => {
  const f = fixture();
  try {
    await f.root.ready;
    assert.equal(f.root.querySelectorAll('select[aria-label="Demo publication"] option').length, 4);
    const source = f.root.querySelector('textarea'); f.input(source, '# Changed Framework draft');
    f.select('jupyter'); assert.equal(JSON.parse(source.value).nbformat, 4);
    f.select('html'); assert.match(source.value, /standalone HTML publication/); assert.doesNotMatch(source.value, /Changed Framework/);
    f.select('framework'); assert.equal(source.value, '# Changed Framework draft');
    f.root.querySelector('button[aria-label="New page in chapters"]').click();
    const path = f.root.querySelector('input[aria-label="Page source path"]'); assert.equal(path.value, 'chapters/page.md');
    f.input(path, 'chapters/new-page.md');
    path.closest('form').dispatchEvent(new f.dom.window.Event('submit', {bubbles: true, cancelable: true}));
    await settle();
    assert.ok(f.root.querySelector('button[data-source-path="chapters/new-page.md"]'));
    assert.match(source.value, /# New page/);
    assert.match(f.root.textContent, /5 minutes/);
    assert.deepEqual(DEMO_PUBLICATIONS.map(item => item.format), ['framework', 'notebook', 'jupyter', 'html']);
  } finally {f.cleanup();}
});

test('idle reset discards edited and newly created publications, then disposal releases the editor', async () => {
  const f = fixture();
  try {
    await f.root.ready; f.input(f.root.querySelector('textarea'), '# Temporary');
    f.find('New publication…').click();
    const form = f.root.querySelector('dialog form'); f.input(form.querySelector('input'), 'A browser-only project');
    form.dispatchEvent(new f.dom.window.Event('submit', {bubbles: true, cancelable: true})); await settle();
    assert.equal(f.root.querySelectorAll('select[aria-label="Demo publication"] option').length, 5);
    f.expire(); await settle();
    assert.equal(f.root.querySelectorAll('select[aria-label="Demo publication"] option').length, 4);
    assert.doesNotMatch(f.root.querySelector('textarea').value, /Temporary/);
    assert.match(f.root.textContent, /Drafts reset after inactivity/);
    f.root.dispose(); assert.equal(f.disposed, true); assert.equal(f.root.querySelector('textarea').value, '');
  } finally {f.cleanup();}
});

test('release review binds source and address, requires consent, and denies duplicate simulated destinations', async () => {
  const f = fixture();
  try {
    await f.root.ready;
    f.find('Publish').click(); f.find('Prepare simulated release review').click(); await settle();
    const approve = f.root.querySelector('input[type="checkbox"]'), publish = f.find('Complete simulated release');
    assert.equal(publish.disabled, true);
    approve.checked = true; approve.dispatchEvent(new f.dom.window.Event('change')); publish.click();
    assert.match(f.root.textContent, /Simulated release complete/); assert.match(f.root.textContent, /No endpoint was created/);
    f.input(f.root.querySelector('textarea'), '# Revision changed');
    assert.equal(publish.disabled, true); assert.equal(approve.checked, false);
    f.find('Prepare simulated release review').click(); await settle();
    assert.match(f.root.textContent, /Save the browser draft before reviewing/);
    f.select('html'); f.find('Settings').click();
    f.input(f.root.querySelector('input[aria-label="Simulated public path"]'), '/examples/framework/');
    f.find('Publish').click(); f.find('Prepare simulated release review').click(); await settle();
    assert.match(f.root.textContent, /Another simulated release already uses this path/);
    assert.equal(publish.disabled, true);
  } finally {f.cleanup();}
});

test('Jupyter preview explains saved output and uses an opaque network-disabled document', async () => {
  const f = fixture();
  try {
    await f.root.ready; f.select('jupyter'); f.find('Preview').click(); await settle();
    assert.equal(f.previews[0].cells[1].outputs[0].text, '290\n');
    const frame = f.root.querySelector('iframe'); assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
    assert.match(frame.getAttribute('srcdoc'), /connect-src data: blob:/); assert.doesNotMatch(frame.getAttribute('srcdoc'), /https:/);
    assert.match(f.root.textContent, /no Python kernel/);
  } finally {f.cleanup();}
});
