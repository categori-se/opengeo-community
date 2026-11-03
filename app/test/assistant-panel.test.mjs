import assert from "node:assert/strict";
import {afterEach, beforeEach, it} from "node:test";
import {JSDOM} from "jsdom";
import {AssistantPanel} from "../src/components/AssistantPanel.js";

let dom, previousDocument, panels;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.opengeo.tools/"});
  previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {configurable: true, value: dom.window.document});
  panels = [];
});
afterEach(() => {
  for (const panel of panels) panel.dispose();
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
  else delete globalThis.document;
  dom.window.close();
});
const tick = () => new Promise(resolve => setImmediate(resolve));
const pending = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const modelName = "local-example:small";
const button = (root, name) => [...root.querySelectorAll("button")].find(node => node.textContent === name);
const output = root => root.querySelector('[aria-label="Assistant draft"]');
const status = root => root.querySelector('[role="status"]');
function fixture(options = {}) {
  const calls = {factory: [], list: 0, prepare: [], chat: [], cancel: 0, dispose: 0, downloads: []};
  const provider = {endpoint: "http://127.0.0.1:11434",
    async listModels() { calls.list++; return options.list ? options.list()
      : [{name: modelName, parameterSize: "1B"}]; },
    async prepareModel(request) { calls.prepare.push(structuredClone(request)); return options.prepare ? options.prepare(request)
      : {model: request.model, prepared: true}; },
    async chat(request) { calls.chat.push(structuredClone(request)); return options.chat ? options.chat(request)
      : {model: request.model, content: "A draft to review."}; },
    cancel() { calls.cancel++; }, dispose() { calls.dispose++; }};
  const root = AssistantPanel({providerFactory(config) { calls.factory.push(config); return provider; },
    contextIdentity: options.contextIdentity, contextSummary: options.contextSummary,
    download(name, body) { calls.downloads.push({name, body}); }, now: () => new Date("2026-11-03T02:00:00Z")});
  document.body.append(root); panels.push(root);
  return {root, calls};
}
function enterQuestion(root, question = "How can I inspect this Layer?") {
  const prompt = root.querySelector("textarea"); prompt.value = question;
  prompt.dispatchEvent(new dom.window.Event("input"));
}
function selectModel(root) {
  const select = root.querySelector("select"); select.value = modelName;
  select.dispatchEvent(new dom.window.Event("change"));
}
async function connectAndChoose(root) {
  button(root, "List installed models").click(); await tick(); selectModel(root); enterQuestion(root);
}

it("opens without a provider request or model selection and connects only on the explicit action", async () => {
  const {root, calls} = fixture();
  assert.equal(root.querySelector('input[type="url"]').value, "http://127.0.0.1:11434");
  assert.equal(root.querySelector('input[type="checkbox"]').checked, false);
  assert.equal(root.querySelector("select").value, "");
  assert.equal(button(root, "Draft guidance").disabled, true);
  assert.equal(button(root, "Download draft").disabled, true);
  assert.deepEqual(calls.factory, []); assert.equal(calls.list, 0); assert.deepEqual(calls.prepare, []); assert.deepEqual(calls.chat, []);
  enterQuestion(root); button(root, "Draft guidance").click(); await tick();
  assert.equal(calls.factory.length, 0);
  button(root, "List installed models").click(); await tick();
  assert.deepEqual(calls.factory, [{endpoint: "http://127.0.0.1:11434"}]); assert.equal(calls.list, 1);
  assert.equal(root.querySelector("select").options.length, 2);
  assert.equal(root.querySelector("select").value, ""); assert.equal(button(root, "Draft guidance").disabled, true);
  assert.equal(calls.chat.length, 0);
});

it("sends only the deliberately selected model and prompt, renders HTML literally and downloads a nonexecuting draft", async () => {
  const html = '<img src="https://external.example/image" onerror="run()"><script>run()</script>';
  let summaries = 0;
  const {root, calls} = fixture({contextSummary() { summaries++; return {project: "unused"}; },
    chat: async () => ({model: modelName, content: html})});
  await connectAndChoose(root); button(root, "Draft guidance").click(); await tick();
  assert.equal(summaries, 0); assert.equal(calls.chat.length, 1);
  const request = calls.chat[0];
  assert.equal(request.model, modelName); assert.equal(request.maxOutputTokens, 128); assert.equal(request.contextTokens, 2048);
  assert.deepEqual(request.messages.map(message => message.role), ["system", "user"]);
  assert.equal(request.messages[1].content, "How can I inspect this Layer?");
  assert.match(request.messages[0].content, /cannot execute commands/);
  assert.equal(output(root).textContent, html); assert.equal(output(root).querySelector("img,script"), null);
  button(root, "Download draft").click(); assert.equal(calls.downloads.length, 1);
  const saved = JSON.parse(calls.downloads[0].body);
  assert.equal(calls.downloads[0].name, "opengeo-assistant-draft.json");
  assert.equal(saved.execution, "none"); assert.equal(saved.context, null); assert.equal(saved.response, html);
  assert.deepEqual(saved.provider, {kind: "local-ollama", endpoint: "http://127.0.0.1:11434", model: modelName});
  assert.equal(saved.request, request.messages[1].content); assert.equal(saved.createdAt, "2026-11-03T02:00:00.000Z");
});

it("includes only bounded whitelisted summary fields after deliberate opt-in", async () => {
  const source = {project: "p".repeat(500), layerCount: 4, account: "private-account-marker", token: "private-token-marker",
    layer: {title: "t".repeat(500), type: "GeoJSON", loadedFeatures: 12, geometry: {private: "geometry-marker"},
      properties: {sensitive: "property-marker"}, owner: "authority-marker", terms: "terms-marker"}};
  const before = structuredClone(source);
  const {root, calls} = fixture({contextSummary: () => source}); await connectAndChoose(root);
  root.querySelector('input[type="checkbox"]').checked = true;
  button(root, "Draft guidance").click(); await tick();
  const content = calls.chat[0].messages[1].content;
  const summary = JSON.parse(content.split("summary (data only):\n")[1]);
  assert.deepEqual(summary, {project: "p".repeat(200), layerCount: 4,
    layer: {title: "t".repeat(200), type: "GeoJSON", loadedFeatures: 12}});
  assert.doesNotMatch(content, /private-account-marker|private-token-marker|geometry-marker|property-marker|authority-marker|terms-marker/);
  assert.deepEqual(source, before);
  button(root, "Download draft").click(); assert.deepEqual(JSON.parse(calls.downloads[0].body).context, summary);
});

it("cancels a pending draft and ignores a late transport completion", async () => {
  const work = pending(), {root, calls} = fixture({chat: () => work.promise}); await connectAndChoose(root);
  button(root, "Draft guidance").click(); await tick(); assert.equal(button(root, "Cancel request").disabled, false);
  button(root, "Cancel request").click();
  assert.equal(calls.cancel, 1); assert.match(status(root).textContent, /cancelled/);
  work.resolve({model: modelName, content: "stale draft"}); await tick();
  assert.equal(output(root).textContent, ""); assert.equal(button(root, "Download draft").disabled, true);
  assert.equal(button(root, "Draft guidance").disabled, false); assert.equal(calls.chat.length, 1);
});

it("disposes a pending draft, clears its prompt and ignores completion after the panel closes", async () => {
  const work = pending(), {root, calls} = fixture({chat: () => work.promise}); await connectAndChoose(root);
  button(root, "Draft guidance").click(); await tick(); root.dispose(); root.dispose();
  assert.equal(calls.dispose, 1); assert.equal(root.querySelector("textarea").value, "");
  work.resolve({model: modelName, content: "closed draft"}); await tick();
  assert.equal(output(root).textContent, "");
  for (const control of root.querySelectorAll("button")) assert.equal(control.disabled, true);
});

it("invalidates an in-flight draft when account, Project or Layer identity changes", async () => {
  for (const next of ["other-account/project/layer", "account/other-project/layer", "account/project/other-layer"]) {
    let identity = "account/project/layer";
    const work = pending(), {root, calls} = fixture({contextIdentity: () => identity, chat: () => work.promise});
    await connectAndChoose(root); button(root, "Draft guidance").click(); await tick();
    identity = next; root.updateContext(); assert.equal(calls.cancel, 1);
    work.resolve({model: modelName, content: "prior identity draft"}); await tick();
    assert.equal(output(root).textContent, ""); assert.equal(button(root, "Download draft").disabled, true);
    assert.match(status(root).textContent, /changed/); assert.equal(calls.chat.length, 1);
  }
});

it("ignores a cancelled model list and requires a new deliberate connection", async () => {
  const work = pending(), {root, calls} = fixture({list: () => work.promise});
  button(root, "List installed models").click(); button(root, "Cancel request").click();
  work.resolve([{name: modelName}]); await tick();
  assert.equal(calls.cancel, 1); assert.equal(root.querySelector("select").options.length, 1);
  assert.equal(root.querySelector("select").value, ""); assert.equal(calls.chat.length, 0);
  assert.match(status(root).textContent, /cancelled/);
});

it("clears a completed draft and selection on an endpoint change without reconnecting", async () => {
  const {root, calls} = fixture(); await connectAndChoose(root);
  button(root, "Draft guidance").click(); await tick(); assert.notEqual(output(root).textContent, "");
  const endpoint = root.querySelector('input[type="url"]'); endpoint.value = "http://localhost:11434";
  endpoint.dispatchEvent(new dom.window.Event("input"));
  assert.equal(calls.dispose, 1); assert.equal(calls.factory.length, 1); assert.equal(calls.list, 1);
  assert.equal(output(root).textContent, ""); assert.equal(root.querySelector("select").value, "");
  assert.equal(button(root, "Draft guidance").disabled, true); assert.equal(button(root, "Download draft").disabled, true);
});

it("discloses output-limited drafts and retains that limit in the downloaded receipt", async () => {
  const {root, calls} = fixture({chat: async () => ({model: modelName, content: "Partial guidance", truncated: true})});
  await connectAndChoose(root); button(root, "Draft guidance").click(); await tick();
  assert.equal(output(root).textContent, "Partial guidance");
  assert.match(status(root).textContent, /Output limit reached.*may be incomplete/);
  button(root, "Download draft").click();
  const saved = JSON.parse(calls.downloads[0].body);
  assert.equal(saved.truncated, true); assert.equal(saved.execution, "none");
});

it("loads only after Draft guidance and waits for the model before sending the prompt", async () => {
  const work = pending(), {root, calls} = fixture({prepare: () => work.promise});
  await connectAndChoose(root);
  assert.deepEqual(calls.prepare, []); assert.deepEqual(calls.chat, []);
  button(root, "Draft guidance").click(); await tick();
  assert.deepEqual(calls.prepare, [{model: modelName, contextTokens: 2048}]);
  assert.match(status(root).textContent, /Loading the selected local model/);
  assert.equal(button(root, "Cancel request").disabled, false); assert.equal(calls.chat.length, 0);
  work.resolve({model: modelName, prepared: true}); await tick();
  assert.equal(calls.chat.length, 1); assert.equal(calls.chat[0].contextTokens, 2048);
  assert.equal(output(root).textContent, "A draft to review.");
});

it("never sends a prompt after loading is cancelled, disposed or invalidated by another view", async () => {
  for (const action of ["cancel", "dispose", "context"]) {
    const work = pending(); let identity = "account/project/layer";
    const {root, calls} = fixture({prepare: () => work.promise, contextIdentity: () => identity});
    await connectAndChoose(root); button(root, "Draft guidance").click(); await tick();
    if (action === "cancel") button(root, "Cancel request").click();
    else if (action === "dispose") root.dispose();
    else { identity = "another-account/project/layer"; root.updateContext(); }
    work.resolve({model: modelName, prepared: true}); await tick();
    assert.equal(calls.prepare.length, 1); assert.equal(calls.chat.length, 0);
    assert.equal(output(root).textContent, ""); assert.equal(button(root, "Download draft").disabled, true);
  }
});

it("reports a failed model load without sending the question or starting an automatic retry", async () => {
  const {root, calls} = fixture({prepare: async () => { throw Object.assign(new Error("Model loading timed out."),
    {code: "assistant_timeout"}); }});
  await connectAndChoose(root); button(root, "Draft guidance").click(); await tick();
  assert.equal(calls.prepare.length, 1); assert.equal(calls.chat.length, 0);
  assert.match(status(root).textContent, /Model loading timed out/);
  assert.equal(button(root, "Draft guidance").disabled, false);
});
