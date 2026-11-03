import assert from "node:assert/strict";
import {it} from "node:test";
import {setImmediate} from "node:timers/promises";
import {ASSISTANT_LIMITS, createAssistantProvider, validateAssistantEndpoint} from "../src/lib/assistantProvider.js";

const endpoint = "http://127.0.0.1:11434", model = "local-example:small";
const conversation = [{role: "user", content: "Explain this map."}];
const catalog = (name = model) => ({models: [{name, size: 1234,
  details: {parameter_size: "1B", quantization_level: "Q4_K_M"}}]});
const draft = (content = "A text draft.", name = model) => ({model: name, done: true,
  message: {role: "assistant", content}});
const json = value => new Response(JSON.stringify(value), {headers: {"content-type": "application/json; charset=utf-8"}});
function fixture(responses = [catalog(), draft()]) {
  const calls = [];
  const client = createAssistantProvider({endpoint, fetchImplementation: async (url, init) => {
    calls.push({url, init});
    const response = responses[calls.length - 1];
    return typeof response === "function" ? response(url, init) : response instanceof Response ? response : json(response);
  }});
  return {client, calls};
}

it("requires an explicit loopback origin and makes no connection on construction", () => {
  for (const origin of [endpoint, "https://localhost:11434", "http://[::1]:11434/"]) {
    assert.equal(validateAssistantEndpoint(origin), origin.replace(/\/$/, ""));
  }
  for (const origin of [undefined, "", "127.0.0.1:11434", "http://192.168.1.1:11434",
    "https://provider.example", "http://localhost.example", "http://127.0.0.1.example",
    "http://user:password@localhost:11434", "http://localhost:11434/api", "http://localhost/?token=fixture",
    "http://localhost/#fragment", "file:///tmp/service", ` ${endpoint}`]) {
    assert.throws(() => createAssistantProvider({endpoint: origin}), {code: "assistant_request_invalid"});
  }
  const f = fixture(); assert.equal(f.calls.length, 0); f.client.dispose();
});

it("lists anonymously only on request and sends one bounded chat to the explicitly listed model", async () => {
  const f = fixture();
  await assert.rejects(f.client.chat({model, messages: conversation}), {code: "assistant_request_invalid"});
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.client.listModels(), [{name: model, size: 1234, parameterSize: "1B", quantizationLevel: "Q4_K_M"}]);
  await assert.rejects(f.client.chat({model: "not-listed:small", messages: conversation}), {code: "assistant_request_invalid"});
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await f.client.chat({model, messages: conversation, maxOutputTokens: 96}), {model, content: "A text draft.", truncated: false});
  assert.equal(f.calls.length, 2);
  for (const [index, {url, init}] of f.calls.entries()) {
    assert.equal(url, `${endpoint}/api/${index ? "chat" : "tags"}`);
    assert.equal(init.method, index ? "POST" : "GET");
    assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error");
    assert.equal(init.referrerPolicy, "no-referrer"); assert.equal(init.mode, "cors"); assert.equal(init.cache, "no-store");
    assert.deepEqual(Object.keys(init.headers).sort(), index ? ["accept", "content-type"] : ["accept"]);
  }
  assert.equal(f.calls[0].init.body, undefined);
  assert.deepEqual(JSON.parse(f.calls[1].init.body), {model, messages: conversation, stream: false, think: false,
    options: {num_ctx: 2048, num_predict: 96}});
});

it("rejects unbounded or nontext input before a generation request", async () => {
  const f = fixture(); await f.client.listModels();
  const invalid = [[], [{role: "tool", content: "result"}], [{role: "user", content: "", images: []}],
    [{role: "user", content: "text", tool_calls: []}], [{role: "system", content: "no user question"}],
    [{role: "user", content: "a\0b"}], Array.from({length: 9}, () => conversation[0]),
    [{role: "user", content: "a".repeat(8001)}], [{role: "user", content: "漢".repeat(6000)}]];
  for (const messages of invalid) {
    await assert.rejects(f.client.chat({model, messages}), {code: "assistant_request_invalid"});
  }
  for (const maxOutputTokens of [0, -1, 257, 1.5, "32"]) {
    await assert.rejects(f.client.chat({model, messages: conversation, maxOutputTokens}), {code: "assistant_request_invalid"});
  }
  for (const options of [{contextTokens: 0}, {contextTokens: 4097}, {timeoutMs: 0}, {timeoutMs: 45001}]) {
    await assert.rejects(f.client.chat({model, messages: conversation, ...options}), {code: "assistant_request_invalid"});
  }
  assert.equal(f.calls.length, 1);
});

it("rejects malformed, duplicate or oversized model catalogs without permitting generation", async () => {
  for (const models of [null, [{}], [{name: model}, {name: model}], [{name: "bad name"}],
    [{name: model, size: -1}], Array.from({length: 65}, (_, index) => ({name: `local:${index}`}))]) {
    const f = fixture([{models}]);
    await assert.rejects(f.client.listModels(), {code: "assistant_models_invalid"});
    await assert.rejects(f.client.chat({model, messages: conversation}), {code: "assistant_request_invalid"});
    assert.equal(f.calls.length, 1);
  }
});

it("requires a completed text reply from the selected model and refuses tool instructions", async () => {
  const invalid = [draft("text", "other:model"), {...draft(), done: false}, {...draft(), tool_calls: []},
    {...draft(), message: {...draft().message, tool_calls: [{function: {name: "execute", arguments: {}}}]}},
    {...draft(), message: {...draft().message, tool_calls: {malformed: true}}},
    {...draft(), message: {...draft().message, function_call: null}},
    {...draft(), message: {role: "tool", content: "text"}}, draft("   ")];
  for (const response of invalid) {
    const f = fixture([catalog(), response]); await f.client.listModels();
    await assert.rejects(f.client.chat({model, messages: conversation}), {code: "assistant_response_invalid"});
    assert.equal(f.calls.length, 2);
  }
});

it("caps actual UTF-8 response bytes and cancels oversized streams", async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream({start(controller) {
    controller.enqueue(encoder.encode('{"models":['));
    controller.enqueue(encoder.encode("漢".repeat(22_000)));
  }, cancel() { cancelled = true; }});
  const f = fixture([new Response(body, {headers: {"content-type": "application/json"}})]);
  await assert.rejects(f.client.listModels(), {code: "assistant_response_too_large"});
  assert.equal(cancelled, true);
  const g = fixture([catalog(), draft("漢".repeat(22_000))]); await g.client.listModels();
  await assert.rejects(g.client.chat({model, messages: conversation}), {code: "assistant_response_too_large"});
});

it("rejects excessive declared size without reading or awaiting an uncooperative body cancellation", async () => {
  let read = false, cancelled = false;
  const body = new ReadableStream({pull() { read = true; }, cancel() { cancelled = true; return new Promise(() => {}); }},
    {highWaterMark: 0});
  const f = fixture([new Response(body, {headers: {"content-type": "application/json", "content-length": "65537"}})]);
  await assert.rejects(f.client.listModels(), {code: "assistant_response_too_large"});
  assert.equal(read, false); assert.equal(cancelled, true);
});

it("refuses invalid JSON, UTF-8 and response types", async () => {
  for (const response of [new Response("not JSON", {headers: {"content-type": "application/json"}}),
    new Response(new Uint8Array([0xc3, 0x28]), {headers: {"content-type": "application/json"}}),
    new Response("<html>error</html>", {headers: {"content-type": "text/html"}})]) {
    await assert.rejects(fixture([response]).client.listModels(), {code: "assistant_response_invalid"});
  }
});

it("rejects redirect responses and changed destinations without following or exposing server error bodies", async () => {
  for (const properties of [{redirected: true}, {url: "https://elsewhere.example/api/tags"}]) {
    const response = json(catalog());
    for (const [key, value] of Object.entries(properties)) Object.defineProperty(response, key, {value});
    const f = fixture([response]);
    await assert.rejects(f.client.listModels(), {code: "assistant_redirect_rejected"});
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init.redirect, "error");
  }
  const f = fixture([new Response("private server diagnostic", {status: 403})]);
  await assert.rejects(f.client.listModels(), error => error.code === "assistant_http_error"
    && error.status === 403 && !error.message.includes("private server diagnostic"));
});

it("honors cancellation before dispatch and while a response body is pending", async () => {
  const before = new AbortController(); before.abort();
  const f = fixture(); await assert.rejects(f.client.listModels({signal: before.signal}), {name: "AbortError"});
  assert.equal(f.calls.length, 0);
  let cancelled = false;
  const body = new ReadableStream({start(controller) { controller.enqueue(new TextEncoder().encode('{"models":')); },
    cancel() { cancelled = true; }});
  const g = fixture([new Response(body, {headers: {"content-type": "application/json"}})]);
  const external = new AbortController(), pending = g.client.listModels({signal: external.signal});
  const rejected = assert.rejects(pending, {name: "AbortError"});
  await setImmediate(); external.abort(); await rejected;
  assert.equal(cancelled, true); assert.equal(g.calls[0].init.signal.aborted, true);
});

it("cancels an ignored transport immediately and never lets an old model list replace a new list", async () => {
  let finishOld;
  const f = fixture([() => new Promise(resolve => { finishOld = resolve; }), catalog("new:small"), draft("new draft", "new:small")]);
  const old = f.client.listModels(), rejected = assert.rejects(old, {name: "AbortError"});
  assert.deepEqual((await f.client.listModels()).map(item => item.name), ["new:small"]);
  await rejected; finishOld(json(catalog("old:small"))); await setImmediate();
  await assert.rejects(f.client.chat({model: "old:small", messages: conversation}), {code: "assistant_request_invalid"});
  assert.equal((await f.client.chat({model: "new:small", messages: conversation})).content, "new draft");
  assert.equal(f.calls.length, 3);
});

it("invalidates selection and cancels a pending chat when the model list refreshes", async () => {
  const f = fixture([catalog(), () => new Promise(() => {}), catalog("new:small")]); await f.client.listModels();
  const pending = f.client.chat({model, messages: conversation}), rejected = assert.rejects(pending, {name: "AbortError"});
  await f.client.listModels(); await rejected;
  assert.equal(f.calls[1].init.signal.aborted, true);
  await assert.rejects(f.client.chat({model, messages: conversation}), {code: "assistant_request_invalid"});
  assert.equal(f.calls.length, 3);
});

it("supports explicit cancellation and permanent disposal without retrying or sending more requests", async () => {
  const f = fixture([() => new Promise(() => {}), catalog()]);
  const pending = f.client.listModels(), rejected = assert.rejects(pending, {name: "AbortError"});
  f.client.cancel(); await rejected; assert.equal(f.calls[0].init.signal.aborted, true);
  await f.client.listModels(); f.client.dispose();
  await assert.rejects(f.client.listModels(), {code: "assistant_request_invalid"});
  await assert.rejects(f.client.chat({model, messages: conversation}), {code: "assistant_request_invalid"});
  assert.equal(f.calls.length, 2);
});

it("enforces list and chat timeouts even when fetch ignores AbortSignal", async t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  const f = fixture([() => new Promise(() => {})]);
  const list = f.client.listModels(), listRejected = assert.rejects(list, {code: "assistant_timeout"});
  t.mock.timers.tick(ASSISTANT_LIMITS.listTimeoutMs); await listRejected;
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init.signal.aborted, true);
  const g = fixture([catalog(), () => new Promise(() => {})]); await g.client.listModels();
  const chat = g.client.chat({model, messages: conversation}), chatRejected = assert.rejects(chat, {code: "assistant_timeout"});
  t.mock.timers.tick(ASSISTANT_LIMITS.chatTimeoutMs); await chatRejected;
  assert.equal(g.calls.length, 2); assert.equal(g.calls[1].init.signal.aborted, true);
});

it("preserves the output-limit signal without discarding the reviewable partial draft", async () => {
  const f = fixture([catalog(), {...draft("Partial guidance"), done_reason: "length"}]);
  await f.client.listModels();
  assert.deepEqual(await f.client.chat({model, messages: conversation}),
    {model, content: "Partial guidance", truncated: true});
  f.client.dispose();
});


it("prepares only an explicitly listed installed model with an empty, bounded anonymous load request", async () => {
  const ready = {model, done: true, response: "", done_reason: "load"};
  const f = fixture([catalog(), ready]);
  await assert.rejects(f.client.prepareModel({model}), {code: "assistant_request_invalid"});
  assert.equal(f.calls.length, 0); await f.client.listModels();
  for (const options of [{model: "not-listed:small"}, {contextTokens: 4097}, {contextTokens: 0},
    {timeoutMs: 75001}, {timeoutMs: 0}]) {
    await assert.rejects(f.client.prepareModel({model, ...options}), {code: "assistant_request_invalid"});
  }
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await f.client.prepareModel({model, contextTokens: 2048, prompt: "must not be sent", keep_alive: -1}),
    {model, prepared: true});
  assert.equal(f.calls.length, 2);
  const {url, init} = f.calls[1]; assert.equal(url, `${endpoint}/api/generate`); assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(init.body), {model, stream: false, think: false, options: {num_ctx: 2048}});
  assert.deepEqual(init.headers, {accept: "application/json", "content-type": "application/json"});
  assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error"); assert.equal(init.referrerPolicy, "no-referrer");
  for (const done_reason of [undefined, "stop"]) {
    const g = fixture([catalog(), {model, done: true, response: "", done_reason, eval_count: 0, prompt_eval_count: 0}]);
    await g.client.listModels(); assert.deepEqual(await g.client.prepareModel({model}), {model, prepared: true});
  }
});

it("rejects generated text, unloads, evaluations, tools and oversized model-load responses", async () => {
  const ready = {model, done: true, response: ""};
  for (const change of [{model: "other:model"}, {done: false}, {response: "generated text"}, {done_reason: "unload"},
    {done_reason: "length"}, {thinking: "generated reasoning"}, {eval_count: 1}, {prompt_eval_count: 1}, {eval_count: -1}, {eval_count: "0"},
    {tool_calls: []}, {function_call: null}, {message: {role: "assistant", content: "unexpected"}}]) {
    const f = fixture([catalog(), {...ready, ...change}]); await f.client.listModels();
    await assert.rejects(f.client.prepareModel({model}), {code: "assistant_response_invalid"});
    assert.equal(f.calls.length, 2);
  }
  const f = fixture([catalog(), {...ready, response: "x".repeat(65536)}]); await f.client.listModels();
  await assert.rejects(f.client.prepareModel({model}), {code: "assistant_response_too_large"});
});

it("cancels stale model preparation, refreshes and disposal, and enforces the separate 75-second load ceiling", async t => {
  const ready = {model, done: true, response: ""};
  for (const stop of ["signal", "cancel", "dispose", "refresh"]) {
    let finish;
    const f = fixture([catalog(), () => new Promise(resolve => { finish = resolve; }), catalog("new:small")]);
    await f.client.listModels(); const signal = new AbortController();
    const work = f.client.prepareModel({model, signal: signal.signal}), rejected = assert.rejects(work, {name: "AbortError"});
    if (stop === "signal") signal.abort();
    if (stop === "cancel") f.client.cancel();
    if (stop === "dispose") f.client.dispose();
    if (stop === "refresh") await f.client.listModels();
    await rejected; assert.equal(f.calls[1].init.signal.aborted, true);
    finish(json(ready)); await setImmediate();
    assert.ok(f.calls.every(call => /\/api\/(tags|generate)$/.test(call.url)));
    f.client.dispose();
  }
  let finish;
  const f = fixture([catalog(), () => new Promise(resolve => { finish = resolve; }), ready]); await f.client.listModels();
  const old = f.client.prepareModel({model}), rejected = assert.rejects(old, {name: "AbortError"});
  assert.deepEqual(await f.client.prepareModel({model}), {model, prepared: true}); await rejected;
  finish(json(ready)); await setImmediate(); assert.equal(f.calls.length, 3); f.client.dispose();
  t.mock.timers.enable({apis: ["setTimeout"]});
  const g = fixture([catalog(), () => new Promise(() => {})]); await g.client.listModels();
  const work = g.client.prepareModel({model}), timeout = assert.rejects(work, {code: "assistant_timeout"});
  t.mock.timers.tick(74999); assert.equal(g.calls[1].init.signal.aborted, false);
  t.mock.timers.tick(1); await timeout; assert.equal(g.calls[1].init.signal.aborted, true);
  assert.equal(ASSISTANT_LIMITS.chatTimeoutMs, 30000); assert.equal(ASSISTANT_LIMITS.maximumChatTimeoutMs, 45000);
  assert.equal(g.calls.length, 2);
});
