import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {PublicationPanels} from "../src/components/PublicationPanels.js";
import {SourceFileExplorer} from "../src/components/SourceFileExplorer.js";
import {PublicationCommands} from '../src/components/PublicationCommands.js';

it("mounts requested panels once and retains editor drafts across keyboard navigation", () => {
  const dom = new JSDOM("<!doctype html><body></body>"), previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const calls = [];
    const root = PublicationPanels({panels: ["files", "preview", "publish", "settings"].map(id => ({
      id, label: id, render: () => {calls.push(id); return document.createElement("textarea");}
    }))});
    document.body.append(root);
    assert.deepEqual(calls, ["files"]);
    const editor = root.querySelector("textarea"); editor.value = "Unsaved page";
    const tabs = root.querySelectorAll('[role="tab"]');
    tabs[0].dispatchEvent(new dom.window.KeyboardEvent("keydown", {key: "ArrowRight", bubbles: true}));
    assert.equal(document.activeElement, tabs[1]);
    assert.deepEqual(calls, ["files", "preview"]);
    tabs[0].click(); tabs[1].click(); tabs[0].click();
    assert.equal(root.querySelector("textarea"), editor);
    assert.equal(editor.value, "Unsaved page");
    assert.deepEqual(calls, ["files", "preview"]);
    assert.equal(root.querySelectorAll('[role="tabpanel"]:not([hidden])').length, 1);
    assert.equal(tabs[0].getAttribute("aria-controls"), root.querySelector('[role="tabpanel"]').id);
  } finally {globalThis.document = previous; dom.window.close();}
});

it("shares the Files and Preview surface without moving its editor or iframe", () => {
  const dom = new JSDOM("<!doctype html><body></body>"), previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const events = [];
    let textarea, frame;
    const renderDraft = id => {
      events.push(`mount:${id}`);
      const draft = document.createElement("div");
      textarea = document.createElement("textarea");
      frame = document.createElement("iframe"); frame.srcdoc = "<p>Current draft</p>";
      draft.append(textarea, frame);
      return draft;
    };
    const root = PublicationPanels({panels: [
      {id: "files", label: "Files", surface: "draft", render: () => renderDraft("files")},
      {id: "preview", label: "Preview", surface: "draft", render: () => renderDraft("preview")},
      {id: "publish", label: "Publish", render: () => {events.push("mount:publish"); return document.createElement("div");}}
    ], onSelect(id) {
      assert(textarea.parentNode, "Selection runs after mounting the shared source editor");
      events.push(`select:${id}`);
    }});
    document.body.append(root);
    const retainedText = textarea, retainedFrame = frame, retainedWindow = frame.contentWindow;
    textarea.value = "Unsaved draft";
    const tabs = root.querySelectorAll('[role="tab"]');
    const draftPanel = root.querySelector('[data-publication-panel="files"]');
    const observer = new dom.window.MutationObserver(() => {});
    observer.observe(draftPanel, {childList: true, subtree: true});
    assert.equal(root.querySelectorAll('[role="tabpanel"]').length, 2);
    assert.equal(tabs[0].getAttribute("aria-controls"), tabs[1].getAttribute("aria-controls"));
    assert.notEqual(tabs[0].id, tabs[1].id);
    tabs[1].click(); tabs[1].click();
    assert.equal(draftPanel.hidden, false);
    assert.equal(draftPanel.getAttribute("aria-labelledby"), tabs[1].id);
    assert.equal(tabs[0].getAttribute("aria-selected"), "false");
    assert.equal(tabs[1].getAttribute("aria-selected"), "true");
    tabs[0].click(); tabs[2].click();
    assert.equal(draftPanel.hidden, true);
    tabs[2].dispatchEvent(new dom.window.KeyboardEvent("keydown", {key: "Home", bubbles: true}));
    tabs[0].dispatchEvent(new dom.window.KeyboardEvent("keydown", {key: "ArrowRight", bubbles: true}));
    assert.equal(document.activeElement, tabs[1]);
    assert.equal(root.querySelector("textarea"), retainedText);
    assert.equal(root.querySelector("iframe"), retainedFrame);
    assert.equal(frame.contentWindow, retainedWindow);
    assert.equal(textarea.value, "Unsaved draft");
    assert.equal(frame.srcdoc, "<p>Current draft</p>");
    assert.deepEqual(observer.takeRecords(), [], "Tab changes must not reparent or replace the shared preview");
    observer.disconnect();
    assert.deepEqual(events, ["mount:files", "select:files", "select:preview", "select:preview",
      "select:files", "mount:publish", "select:publish", "select:files", "select:preview"]);
    assert.equal(root.querySelectorAll('[role="tabpanel"]:not([hidden])').length, 1);
    assert.equal(draftPanel.getAttribute("aria-labelledby"), tabs[1].id);
  } finally {globalThis.document = previous; dom.window.close();}
});

it('supports keyboard command navigation and creates a page in the chosen folder', () => {
  const dom = new JSDOM('<body></body>'), previous = globalThis.document; globalThis.document = dom.window.document;
  try {
    const created = [], tree = SourceFileExplorer({onSelect:()=>{}, onNewPage:folder=>created.push(folder)});
    tree.update(['src/index.md','src/methods/notes.md']); document.body.append(tree.element);
    tree.element.querySelector('[aria-label="New page in src/methods"]').click();
    assert.deepEqual(created,['src/methods/']); assert.equal(tree.folder,'src/methods/');
    tree.search('methods'); tree.search(''); assert.equal(tree.folder,'src/methods/');
    let called = 0;
    const menus = PublicationCommands({menus:[{label:'File',commands:[{label:'New publication…',run:()=>called++}]},
      {label:'View',commands:[{label:'Show files',run:()=>{}}]}]}); document.body.append(menus);
    const file = menus.querySelector('summary'); file.focus();
    file.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
    assert.equal(document.activeElement.textContent,'New publication…');
    document.activeElement.click(); assert.equal(called,1); assert.equal(file.parentElement.open,false);
    file.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
    assert.equal(document.activeElement.textContent,'View');
  } finally {globalThis.document=previous;dom.window.close();}
});

it("shows a nested source tree, filters paths, and preserves the selected file", () => {
  const dom = new JSDOM("<!doctype html>"), previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const selected = [], tree = SourceFileExplorer({onSelect: path => selected.push(path)});
    tree.update(["src/index.md", "src/components/map.js", "package.json"]);
    tree.select("src/index.md");
    assert.equal(tree.element.querySelector('[aria-current="true"]').textContent, "index.md");
    tree.element.querySelector('[data-source-path="src/components/map.js"]').click();
    assert.deepEqual(selected, ["src/components/map.js"]);
    tree.search("components");
    assert.equal(tree.element.querySelectorAll("button").length, 1);
    tree.search("");
    assert.equal(tree.element.querySelector('[aria-current="true"]').textContent, "index.md");
  } finally {globalThis.document = previous; dom.window.close();}
});
