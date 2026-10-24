import {readProviderJson} from "./providerJson.js";
import {itemBounds, publicItemUrl} from "./staticItemSearch.js";
import {canonicalJson} from "./artifactCanonicalJson.js";
import {sha256Hex} from "./managedUpload.js";

export const STAC_ITEM_ADAPTER = "opengeo.stac-api-items.1";
export const STAC_ITEM_LIMITS = Object.freeze({requests: 3, bytes: 3 * 1024 * 1024,
  milliseconds: 30_000, items: 60, itemBytes: 128 * 1024, nodes: 200_000, itemNodes: 20_000, depth: 32});
const secretKey = /^(?:authorization|proxy-authorization|password|passwd|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|secret[_-]?key|credentials?|signature|x-amz-(?:signature|credential|security-token))$/i;
const secretQuery = /[?&](?:[^=&\s]*(?:token|secret|signature|credential|password|api.?key)[^=&\s]*)=/i;
const plain = value => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const error = (message, code = "stac_item_invalid") => Object.assign(new Error(message), {code});
const frozen = value => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
};
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

function instant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) throw error("Use known ISO observation dates.");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || value.slice(0, 10) !== new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)))).toISOString().slice(0, 10)) throw error("Use valid ISO observation dates.");
  return new Date(timestamp).toISOString();
}

function safeReference(href, base) {
  if (typeof href !== "string" || !href || href.length > 8192 || /[\u0000-\u0020]/.test(href) || secretQuery.test(href)) throw error("Credential-bearing or invalid source references are unavailable.");
  let url;
  try {url = new URL(href, base);} catch {throw error("A source reference is invalid.");}
  if (url.username || url.password || !["https:", "http:", "s3:"].includes(url.protocol)
    || [...url.searchParams.keys()].some(key => /token|secret|signature|credential|password|api.?key/i.test(key))) throw error("Credential-bearing or unsupported source references are unavailable.");
  if (["https:", "http:"].includes(url.protocol)) {
    try {publicItemUrl(url.href.replace(/^http:/, "https:"));} catch {throw error("A public source reference is required.");}
  }
  return url.href;
}

function assertJson(value, limits, nodeLimit = limits.nodes, checkCredentials = true) {
  const stack = [[value, 0]]; let nodes = 0;
  while (stack.length) {
    const [current, depth] = stack.pop();
    if (++nodes > nodeLimit || depth > limits.depth) throw error("STAC metadata exceeds the bounded JSON structure.");
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "number") {if (!Number.isFinite(current)) throw error("STAC metadata contains a nonfinite value."); continue;}
    if (typeof current === "string") {
      if (checkCredentials && (secretQuery.test(current) || /[a-z][a-z0-9+.-]*:\/\/[^\s/]*@/i.test(current))) throw error("Credential-bearing source metadata is unavailable.");
      continue;
    }
    if (!Array.isArray(current) && !plain(current)) throw error("STAC metadata must be plain JSON.");
    for (const [key, child] of Object.entries(current)) {
      if (key.length > 256 || ["__proto__", "prototype", "constructor"].includes(key) || checkCredentials && secretKey.test(key)) throw error("Credential-bearing or unsupported source metadata is unavailable.");
      stack.push([child, depth + 1]);
    }
  }
}

function queryOf(draft, limits) {
  if (!plain(draft)) throw error("Enter an endpoint, collections, bounds and observation dates.");
  let endpoint;
  try {endpoint = publicItemUrl(draft.endpoint);} catch {throw error("Enter a public credential-free HTTPS STAC search endpoint.");}
  const url = new URL(endpoint);
  if (url.search || !/\/search\/?$/.test(url.pathname)) throw error("Use an explicit HTTPS /search endpoint without query parameters.");
  const collections = draft.collections;
  if (!Array.isArray(collections) || collections.length < 1 || collections.length > 4
    || collections.some(value => typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
    || new Set(collections).size !== collections.length) throw error("Choose one to four distinct collection IDs.");
  const bbox = itemBounds(draft.bbox), start = instant(draft.start), end = instant(draft.end), limit = draft.limit ?? 20;
  if (bbox[2] - bbox[0] > 6 || bbox[3] - bbox[1] > 6) throw error("Search bounds must span at most six degrees on each axis.");
  if (Date.parse(end) < Date.parse(start) || Date.parse(end) - Date.parse(start) > 366 * 86400_000) throw error("Choose an ordered observation period of at most 366 days.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > Math.min(20, limits.items)) throw error("Choose a page limit from 1 to 20 within the remaining item bound.");
  return {endpoint, collections: [...collections], bbox, start, end, limit};
}

function initialUrl(query) {
  const url = new URL(query.endpoint);
  url.searchParams.set("collections", query.collections.join(","));
  url.searchParams.set("bbox", query.bbox.join(","));
  url.searchParams.set("datetime", `${query.start}/${query.end}`);
  url.searchParams.set("limit", String(query.limit));
  return url.href;
}

function pageUrl(href, base, query) {
  const url = new URL(publicItemUrl(href, base)), endpoint = new URL(query.endpoint);
  if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname) throw error("The next page must use the same public search endpoint.");
  const allowed = new Set(["collections", "bbox", "datetime", "limit", "offset", "page", "next", "cursor"]);
  if ([...url.searchParams.keys()].some(key => !allowed.has(key) || url.searchParams.getAll(key).length !== 1)) throw error("The next page has unsupported or repeated query parameters.");
  const dates = (url.searchParams.get("datetime") ?? "").split("/");
  if (!equal((url.searchParams.get("collections") ?? "").split(","), query.collections)
    || !equal((url.searchParams.get("bbox") ?? "").split(",").map(Number), query.bbox)
    || dates.length !== 2 || instant(dates[0]) !== query.start || instant(dates[1]) !== query.end
    || Number(url.searchParams.get("limit")) !== query.limit) throw error("The next page changed the frozen search filters.");
  for (const key of ["offset", "page"]) if (url.searchParams.has(key) && !/^\d{1,12}$/.test(url.searchParams.get(key))) throw error("The next page has an invalid page boundary.");
  for (const key of ["next", "cursor"]) if ((url.searchParams.get(key)?.length ?? 0) > 2048) throw error("The next page cursor exceeds its bound.");
  // Canonical filters also make a reordered/alternately encoded old page a cycle.
  const normalized = new URL(initialUrl(query));
  for (const key of ["offset", "page", "next", "cursor"]) if (url.searchParams.has(key)) normalized.searchParams.set(key, url.searchParams.get(key));
  return normalized.href;
}

function normalizedAssets(item, base) {
  if (!plain(item.assets) || Object.keys(item.assets).length > 128) throw error("The Item must contain a bounded asset object.");
  return Object.entries(item.assets).map(([key, original]) => {
    if (!key || key.length > 256 || !plain(original)) throw error("An Item asset is invalid.");
    const href = safeReference(original.href, base), url = new URL(href), type = original.type ?? null;
    if (type !== null && typeof type !== "string" || original.roles !== undefined
      && (!Array.isArray(original.roles) || original.roles.some(role => typeof role !== "string"))) throw error("An Item asset has invalid type or roles.");
    const bands = original["raster:bands"] ?? original["eo:bands"] ?? original.bands ?? [];
    if (!Array.isArray(bands) || bands.length > 64 || bands.some(band => !plain(band))) throw error("An Item asset has invalid band metadata.");
    const unsupportedReasons = [];
    if (url.protocol !== "https:") unsupportedReasons.push("This asset is not a public HTTPS reference.");
    if (url.search || url.hash) unsupportedReasons.push("TIFF loading requires a query-free object URL.");
    if (!/\.tiff?$/i.test(url.pathname) || !/^image\/tiff(?:;|$)/i.test(type ?? "")) unsupportedReasons.push("Only TIFF assets enter the existing raster reader.");
    return {key, href, type, roles: structuredClone(original.roles ?? []), bands: structuredClone(bands),
      license: original.license ?? null, rights: structuredClone(original.rights ?? null),
      original: structuredClone(original), cogCompatible: !unsupportedReasons.length, unsupportedReasons};
  });
}

function normalizeItem(item, query, snapshot, inventory, limits) {
  assertJson(item, limits, limits.itemNodes);
  if (new TextEncoder().encode(JSON.stringify(item)).byteLength > limits.itemBytes) throw error("The original Item exceeds 128 KiB; it was not retained partially.");
  if (!plain(item) || item.type !== "Feature" || !["1.0.0", "1.1.0"].includes(item.stac_version)
    || typeof item.id !== "string" || !item.id || item.id.length > 512 || !query.collections.includes(item.collection)
    || !plain(item.properties) || !Object.hasOwn(item, "geometry") || item.geometry !== null && !plain(item.geometry)
    || !Array.isArray(item.links)) throw error("The provider returned an invalid or out-of-scope STAC Item.");
  const bbox = itemBounds(item.bbox);
  const datetime = item.properties.datetime == null ? null : instant(item.properties.datetime);
  const start = datetime ?? instant(item.properties.start_datetime), end = datetime ?? instant(item.properties.end_datetime);
  if (start > end) throw error("An Item has an invalid observation period.");
  for (const link of item.links) {
    if (!plain(link) || typeof link.rel !== "string") throw error("An Item link is invalid.");
    safeReference(link.href, snapshot.url);
    if (link.headers != null || link.body != null) throw error("Item links with headers or request bodies are unsupported.");
  }
  const assets = normalizedAssets(item, snapshot.url);
  if (!overlaps(bbox, query.bbox) || start > query.end || end < query.start) throw error("An Item falls outside the frozen bounding extent or observation period.");
  return {adapter: STAC_ITEM_ADAPTER, custody: "referenced", id: item.id, collectionId: item.collection,
    datetime, start, end, bbox, spatialMatch: "bounding-extent-candidate",
    cloudCover: Number.isFinite(item.properties["eo:cloud_cover"]) ? item.properties["eo:cloud_cover"] : null,
    license: item.license ?? item.properties.license ?? null, assets, original: structuredClone(item),
    query: structuredClone(query), snapshot: structuredClone(snapshot), inventory: structuredClone(inventory)};
}

// Recheck provenance/asset bindings at deliberate registration, including copied references.
export function assertStacItemReference(reference) {
  if (!plain(reference) || reference.adapter !== STAC_ITEM_ADAPTER || reference.custody !== "referenced") throw error("Select a current public STAC Item reference first.");
  const query = queryOf(reference.query, STAC_ITEM_LIMITS), snapshot = reference.snapshot, inventory = reference.inventory;
  if (!equal(query, reference.query) || !plain(snapshot) || !/^[a-f0-9]{64}$/.test(snapshot.sha256 ?? "")
    || !Number.isSafeInteger(snapshot.bytes) || snapshot.bytes < 1 || snapshot.bytes > STAC_ITEM_LIMITS.bytes
    || instant(snapshot.readAt) !== snapshot.readAt || snapshot.etag !== null && (typeof snapshot.etag !== "string" || snapshot.etag.length > 1024)
    || !plain(inventory) || inventory.reader !== "STAC-API-GET/1" || inventory.adapter !== STAC_ITEM_ADAPTER
    || inventory.endpoint !== query.endpoint || !equal(inventory.query, query) || !Array.isArray(inventory.searchedPages)
    || !inventory.searchedPages.length || inventory.searchedPages.length > STAC_ITEM_LIMITS.requests) throw error("The STAC reference snapshot is invalid.");
  pageUrl(snapshot.url, query.endpoint, query);
  if (!inventory.searchedPages.some(page => equal(page, snapshot))) throw error("The STAC reference is missing its searched-page identity.");
  const rebuilt = normalizeItem(reference.original, query, snapshot, inventory, STAC_ITEM_LIMITS);
  for (const key of Object.keys(rebuilt)) if (!equal(reference[key], rebuilt[key])) throw error("The selected STAC reference changed; search and review it again.");
  return reference;
}

export function createStacItemClient({fetchImplementation = globalThis.fetch, limits = {}, now = () => new Date()} = {}) {
  if (!plain(limits) || Object.keys(limits).some(key => !Object.hasOwn(STAC_ITEM_LIMITS, key))) throw error("Invalid STAC search limits.");
  limits = {...STAC_ITEM_LIMITS, ...limits};
  for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > STAC_ITEM_LIMITS[key]) throw error(`Invalid STAC ${key} limit.`);
  let active = null;

  async function readPage(state, url, {signal, onStatus = () => {}} = {}) {
    if (state !== active || state.busy || state.failed) throw error("Search again before requesting another page.", "stac_item_stale");
    if (state.usage.requests >= limits.requests || state.usage.bytes >= limits.bytes || state.usage.items >= limits.items
      || state.usage.milliseconds >= limits.milliseconds) throw error("The cumulative search bound was reached. Narrow the query before searching again.", "stac_item_limit");
    signal?.throwIfAborted();
    state.busy = true; state.controller = new AbortController();
    const begin = performance.now(), priorMilliseconds = state.usage.milliseconds, chunks = [], abort = () => state.controller.abort(signal.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, {once: true});
    const timer = setTimeout(() => state.controller.abort(error("The cumulative search time limit was reached.", "stac_item_limit")), Math.max(1, limits.milliseconds - state.usage.milliseconds));
    const check = () => {
      state.controller.signal.throwIfAborted();
      if (active !== state) throw error("This search was replaced.", "stac_item_stale");
      if (priorMilliseconds + performance.now() - begin >= limits.milliseconds) throw error("The cumulative search time limit was reached.", "stac_item_limit");
    };
    let etag = null;
    try {
      check(); onStatus(`Reading public STAC Item page ${state.usage.requests + 1}…`);
      const remaining = limits.bytes - state.usage.bytes;
      const trackedFetch = async (href, options) => {
        check(); state.usage.requests++;
        const response = await fetchImplementation(href, {...options, method: "GET"}); check();
        etag = response.headers.get("etag"); if (etag?.length > 1024) etag = null;
        if (!response.body) throw error("The provider returned no metadata body.");
        return {ok: response.ok, status: response.status, headers: response.headers, body: {
          cancel: reason => response.body.cancel(reason),
          getReader() {
            const reader = response.body.getReader();
            return {async read() {
              const part = await reader.read(); check();
              if (!part.done) {
                state.usage.bytes += part.value.byteLength;
                if (state.usage.bytes > limits.bytes) throw error("The cumulative metadata byte limit was reached.", "stac_item_limit");
                chunks.push(part.value.slice());
              }
              return part;
            }, cancel: reason => reader.cancel(reason), releaseLock: () => reader.releaseLock()};
          }
        }};
      };
      const response = await readProviderJson(url, {fetchImplementation: trackedFetch, signal: state.controller.signal, maxBytes: remaining, label: "STAC Item page"});
      check(); assertJson(response.data, limits, limits.nodes, false);
      const data = response.data;
      if (data.type !== "FeatureCollection" || !Array.isArray(data.features) || data.features.length > state.query.limit
        || data.stac_version != null && !["1.0.0", "1.1.0"].includes(data.stac_version)
        || data.links != null && !Array.isArray(data.links)) throw error("The provider did not return a bounded STAC FeatureCollection.");
      if (state.processed + data.features.length > limits.items) throw error("The cumulative Item limit was reached.", "stac_item_limit");
      state.processed += data.features.length;
      const readAt = new Date(now()).toISOString(), snapshot = {url, sha256: await sha256Hex(new Blob(chunks)), bytes: response.bytes, readAt, etag};
      check();
      const pages = [...state.pages, snapshot], inventory = {reader: "STAC-API-GET/1", adapter: STAC_ITEM_ADAPTER,
        endpoint: state.query.endpoint, query: structuredClone(state.query), searchedPages: structuredClone(pages)};
      const issues = [...state.issues], items = [...state.items];
      for (const [index, item] of data.features.entries()) {
        try {
          const normalized = normalizeItem(item, state.query, snapshot, inventory, limits), identity = `${normalized.collectionId}/${normalized.id}`;
          if (state.identities.has(identity)) {issues.push(`Page ${pages.length}, Item ${index + 1}: duplicate identity omitted; its earlier source reference is retained.`); continue;}
          state.identities.add(identity); items.push(frozen(normalized));
        } catch {issues.push(`Page ${pages.length}, Item ${index + 1}: invalid, unsafe, oversized or out-of-scope Item omitted; no partial reference was retained.`);}
      }
      let next = null;
      const nextLinks = (data.links ?? []).filter(link => plain(link) && link.rel === "next");
      if (nextLinks.length > 1) issues.push("Multiple next-page links are unsupported; the search is incomplete.");
      else if (nextLinks.length === 1) {
        try {
          const link = nextLinks[0];
          if (link.method != null && link.method !== "GET" || link.body != null || link.headers != null || link.merge != null) throw error("Only anonymous GET next pages are supported.");
          const candidate = pageUrl(link.href, url, state.query);
          if (state.visited.has(candidate)) throw error("The next-page link repeats an already read page.");
          next = candidate;
        } catch {issues.push("The next page is unsafe, cyclic or changes the frozen filters; unsupported paging remains incomplete.");}
      }
      if (next && (state.usage.requests >= limits.requests || state.usage.bytes >= limits.bytes || state.processed >= limits.items)) {
        next = null; issues.push("The cumulative page, byte or Item bound was reached; remaining provider results were not read.");
      }
      state.pages = pages; state.items = items; state.issues = issues;
      state.usage.pages = pages.length; state.usage.items = items.length;
      state.next = next;
      check(); state.usage.milliseconds = priorMilliseconds + Math.ceil(performance.now() - begin);
      const result = frozen({items: [...items], query: structuredClone(state.query), usage: {...state.usage},
        snapshot: structuredClone(snapshot), complete: !nextLinks.length && !issues.length, issues: [...issues], next});
      state.result = result;
      return result;
    } catch (failure) {
      state.failed = true;
      state.usage.milliseconds = priorMilliseconds + Math.ceil(performance.now() - begin);
      if (state.controller.signal.aborted) throw state.controller.signal.reason;
      if (failure?.code?.startsWith("stac_item")) throw failure;
      throw error("The public STAC page could not be read within its bounds. Narrow the query or check the provider before searching again.", "stac_item_unavailable");
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", abort); state.busy = false;
    }
  }

  return {
    async search(draft, options) {
      active?.controller?.abort(error("This search was replaced.", "stac_item_stale")); active = null;
      const query = queryOf(draft, limits), url = initialUrl(query);
      const state = {query, usage: {requests: 0, bytes: 0, milliseconds: 0, pages: 0, items: 0},
        items: [], issues: [], pages: [], processed: 0, identities: new Set(), visited: new Set([url]), busy: false, failed: false};
      active = state;
      return readPage(state, url, options);
    },
    async next(result, options) {
      const state = active;
      if (!state || state.result !== result || !state.next || state.busy || state.failed) throw error("Search again before requesting another page.", "stac_item_stale");
      const url = state.next; state.next = null; state.visited.add(url);
      return readPage(state, url, options);
    }
  };
}
