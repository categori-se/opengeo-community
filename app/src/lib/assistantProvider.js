export const ASSISTANT_LIMITS = Object.freeze({
  modelListBytes: 65_536, responseBytes: 65_536, models: 64,
  listTimeoutMs: 5_000, prepareTimeoutMs: 75_000, chatTimeoutMs: 30_000, maximumChatTimeoutMs: 45_000,
  messages: 8, contextCharacters: 8_000, contextBytes: 16_384,
  contextTokens: 4_096, outputTokens: 256
});

export class AssistantProviderError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "AssistantProviderError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

const invalid = (message) => new AssistantProviderError("assistant_request_invalid", message);
const aborted = () => new DOMException("Local assistant request cancelled.", "AbortError");

export function validateAssistantEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw invalid("Enter a complete local assistant URL."); }
  if (typeof value !== "string" || value !== value.trim()
    || !["http:", "https:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw invalid("Use a loopback HTTP or HTTPS origin without credentials, a path, or a query.");
  }
  return url.origin;
}

function modelName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200
    && value === value.trim() && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => { signal.removeEventListener("abort", stop); reject(signal.reason); };
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, {once: true});
    Promise.resolve(promise).then(
      value => { signal.removeEventListener("abort", stop); resolve(value); },
      error => { signal.removeEventListener("abort", stop); reject(error); }
    );
  });
}

async function boundedJson(response, maximumBytes, signal) {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximumBytes) {
    void response.body?.cancel().catch(() => {});
    throw new AssistantProviderError("assistant_response_too_large", "Local assistant response exceeded its byte limit.");
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
    || !response.body?.getReader) {
    void response.body?.cancel().catch(() => {});
    throw new AssistantProviderError("assistant_response_invalid", "Local assistant returned an invalid JSON response.");
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", {fatal: true});
  let bytes = 0, text = "";
  try {
    for (;;) {
      const {done, value} = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        throw new AssistantProviderError("assistant_response_too_large", "Local assistant response exceeded its byte limit.");
      }
      text += decoder.decode(value, {stream: true});
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (signal.aborted || error instanceof AssistantProviderError) throw error;
    throw new AssistantProviderError("assistant_response_invalid", "Local assistant returned an invalid JSON response.");
  } finally { reader.releaseLock(); }
}

export function createAssistantProvider({endpoint, fetchImplementation = globalThis.fetch} = {}) {
  endpoint = validateAssistantEndpoint(endpoint);
  if (typeof fetchImplementation !== "function") throw invalid("Fetch is unavailable.");
  const active = {list: null, prepare: null, chat: null}, versions = {list: 0, prepare: 0, chat: 0};
  let knownModels = new Set(), disposed = false;

  function cancelKind(kind) {
    versions[kind]++;
    active[kind]?.abort(aborted());
    active[kind] = null;
  }

  async function request(kind, path, body, externalSignal, timeoutMs) {
    if (disposed) throw invalid("This local assistant connection is closed.");
    if (externalSignal?.aborted) throw aborted();
    if (externalSignal && typeof externalSignal.addEventListener !== "function") throw invalid("Invalid cancellation signal.");
    cancelKind(kind);
    const version = versions[kind], controller = new AbortController();
    active[kind] = controller;
    const stop = () => controller.abort(aborted());
    externalSignal?.addEventListener("abort", stop, {once: true});
    const timer = setTimeout(() => controller.abort(new AssistantProviderError(
      "assistant_timeout", "Local assistant request timed out."
    )), timeoutMs);
    const current = () => {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (disposed || versions[kind] !== version) throw aborted();
    };
    try {
      const url = `${endpoint}${path}`;
      const response = await abortable(fetchImplementation(url, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? {accept: "application/json"}
          : {accept: "application/json", "content-type": "application/json"},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        signal: controller.signal, credentials: "omit", redirect: "error",
        referrerPolicy: "no-referrer", mode: "cors", cache: "no-store"
      }), controller.signal);
      current();
      if (response.redirected || (response.url && response.url !== url)) {
        void response.body?.cancel().catch(() => {});
        throw new AssistantProviderError("assistant_redirect_rejected", "Local assistant redirects are not allowed.");
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new AssistantProviderError("assistant_http_error", `Local assistant returned HTTP ${response.status}.`, response.status);
      }
      const result = await boundedJson(response,
        kind === "list" ? ASSISTANT_LIMITS.modelListBytes : ASSISTANT_LIMITS.responseBytes,
        controller.signal);
      current();
      return {result, current};
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof AssistantProviderError || error?.name === "AbortError") throw error;
      throw new AssistantProviderError("assistant_unavailable",
        "Could not reach the local assistant. Check its address, browser access and allowed origins.");
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", stop);
      if (active[kind] === controller) active[kind] = null;
    }
  }

  return {
    endpoint,
    async listModels({signal} = {}) {
      knownModels = new Set();
      cancelKind("prepare");
      cancelKind("chat");
      const {result, current} = await request("list", "/api/tags", undefined, signal, ASSISTANT_LIMITS.listTimeoutMs);
      if (!Array.isArray(result?.models) || result.models.length > ASSISTANT_LIMITS.models) {
        throw new AssistantProviderError("assistant_models_invalid", "Local assistant returned an invalid model list.");
      }
      const names = new Set();
      const models = result.models.map(item => {
        if (!modelName(item?.name) || names.has(item.name)
          || (item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size < 0))) {
          throw new AssistantProviderError("assistant_models_invalid", "Local assistant returned an invalid model list.");
        }
        names.add(item.name);
        const detail = value => typeof value === "string" && value.length <= 80 ? value : null;
        return {name: item.name, size: item.size ?? null,
          parameterSize: detail(item.details?.parameter_size),
          quantizationLevel: detail(item.details?.quantization_level)};
      });
      current();
      knownModels = names;
      return models;
    },
    async prepareModel({model, signal, contextTokens = 2_048,
      timeoutMs = ASSISTANT_LIMITS.prepareTimeoutMs} = {}) {
      if (!modelName(model) || !knownModels.has(model)) throw invalid("Explicitly choose a model from the current local model list.");
      if (!Number.isInteger(contextTokens) || contextTokens < 1 || contextTokens > ASSISTANT_LIMITS.contextTokens
        || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ASSISTANT_LIMITS.prepareTimeoutMs) {
        throw invalid("Provide a bounded local model preparation request.");
      }
      // An empty generate request loads an installed model without generating a prompt response.
      const {result, current} = await request("prepare", "/api/generate", {model, stream: false, think: false,
        options: {num_ctx: contextTokens}}, signal, timeoutMs);
      if (result?.model !== model || result.done !== true || result.response !== ""
        || ![undefined, ""].includes(result.thinking)
        || ![undefined, "load", "stop"].includes(result.done_reason)
        || [result.eval_count, result.prompt_eval_count].some(value => value !== undefined && value !== 0)
        || ["tool_calls", "function_call", "message"].some(key => key in result)) {
        throw new AssistantProviderError("assistant_response_invalid", "Local assistant must confirm model preparation without generating text or tool calls.");
      }
      current();
      return {model, prepared: true};
    },
    async chat({model, messages, signal, maxOutputTokens = 128, contextTokens = 2_048,
      timeoutMs = ASSISTANT_LIMITS.chatTimeoutMs} = {}) {
      if (!modelName(model) || !knownModels.has(model)) throw invalid("Explicitly choose a model from the current local model list.");
      if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > ASSISTANT_LIMITS.outputTokens
        || !Number.isInteger(contextTokens) || contextTokens < 1 || contextTokens > ASSISTANT_LIMITS.contextTokens
        || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ASSISTANT_LIMITS.maximumChatTimeoutMs
        || !Array.isArray(messages) || !messages.length || messages.length > ASSISTANT_LIMITS.messages
        || messages.some(item => !item || Object.keys(item).some(key => !["role", "content"].includes(key))
          || !["system", "user", "assistant"].includes(item.role) || typeof item.content !== "string"
          || !item.content.trim() || item.content.includes("\0"))
        || !messages.some(item => item.role === "user")) throw invalid("Provide a bounded text conversation and output limit.");
      const characters = messages.reduce((sum, item) => sum + item.content.length, 0);
      const bytes = new TextEncoder().encode(messages.map(item => item.content).join("\n")).byteLength;
      if (characters > ASSISTANT_LIMITS.contextCharacters || bytes > ASSISTANT_LIMITS.contextBytes) {
        throw invalid("The local assistant context is too large; reduce the supplied text.");
      }
      const {result, current} = await request("chat", "/api/chat", {model,
        messages: messages.map(({role, content}) => ({role, content})), stream: false, think: false,
        options: {num_ctx: contextTokens, num_predict: maxOutputTokens}},
      signal, timeoutMs);
      if (result?.model !== model || result.done !== true || result.message?.role !== "assistant"
        || typeof result.message.content !== "string" || !result.message.content.trim()
        || [result, result.message].some(item => "tool_calls" in item || "function_call" in item)) {
        throw new AssistantProviderError("assistant_response_invalid", "Local assistant must return a completed text draft without tool calls.");
      }
      current();
      return {model, content: result.message.content, truncated: result.done_reason === "length"};
    },
    cancel() { cancelKind("list"); cancelKind("prepare"); cancelKind("chat"); },
    dispose() { disposed = true; knownModels.clear(); cancelKind("list"); cancelKind("prepare"); cancelKind("chat"); }
  };
}
