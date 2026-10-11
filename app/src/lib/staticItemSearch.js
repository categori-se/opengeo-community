// Public metadata only. No session headers, owned index, imagery reads or background work.
import {readProviderJson} from "./providerJson.js";

export const STATIC_ITEM_CATALOG = "https://data.source.coop/tge-labs/s2-stac-geoparquet/catalog.json";
export const STATIC_ITEM_COLLECTION = "sentinel-2-c1-l2a";
export const STATIC_ITEM_ADAPTER = "opengeo.s2-geoparquet.1";
export const STATIC_ITEM_LIMITS = Object.freeze({requests: 32, bytes: 8 * 1024 * 1024,
  milliseconds: 30_000, partitions: 4, groups: 8, rows: 25_000,
  decodedBytes: 64 * 1024 * 1024, results: 30});
const searchColumns = ["id", "datetime", "bbox", "eo:cloud_cover", "_tile"];
const locations = new WeakMap();
let readerPromise;
const loadReader = () => readerPromise ??= Promise.all([
  import("hyparquet/src/index.js"), import("hyparquet-compressors")
]).then(([reader, codecs]) => ({...reader, compressors: codecs.compressors}));

function problem(message, code = "static_item_invalid") {return Object.assign(new Error(message), {code});}
function count(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw problem(`Invalid ${label}.`);
  return number;
}
export function publicItemUrl(href, base) {
  const url = new URL(href, base);
  if (url.protocol !== "https:" || url.username || url.password || url.hash
    || /^(localhost|.*\.localhost|.*\.local|\[.*\]|\d+(?:\.\d+){3})$/i.test(url.hostname)
    || [...url.searchParams.keys()].some(key => /token|secret|signature|credential|password|api.?key/i.test(key))) {
    throw problem("A public HTTPS reference without credentials is required.");
  }
  return url.href;
}
function inventoryUrl(href, base) {
  const url = new URL(publicItemUrl(href, base)), parent = new URL(base);
  if (url.origin !== parent.origin || !url.pathname.startsWith(parent.pathname.slice(0, parent.pathname.lastIndexOf("/") + 1))) {
    throw problem("The partition reference is outside the published collection.");
  }
  return url.href;
}
export function itemBounds(value) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)
    || value[0] < -180 || value[2] > 180 || value[1] < -90 || value[3] > 90
    || value[0] >= value[2] || value[1] >= value[3]) throw problem("Enter west, south, east, north in longitude/latitude; crossing the date line is not supported.");
  return [...value];
}
function overlaps(a, b) {return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];}
function time(value) {
  if (value === null || value === undefined || value === "") return NaN;
  return value instanceof Date ? value.getTime() : Date.parse(value);
}
function within(properties, start, end) {
  const a = time(properties?.start_datetime ?? properties?.datetime), b = time(properties?.end_datetime ?? properties?.datetime);
  // Unknown coverage cannot exclude a partition.
  return !Number.isFinite(a) || !Number.isFinite(b) || a <= end && b >= start;
}
function queryOf(draft) {
  const year = Number(draft.year), start = time(draft.start), end = time(draft.end);
  const maxCloud = Number(draft.maxCloud ?? 100), tile = draft.tile?.trim() || null;
  if (!Number.isInteger(year) || year < 2015 || year > 2100 || !Number.isFinite(start) || !Number.isFinite(end)
    || start > end || new Date(start).getUTCFullYear() !== year || new Date(end).getUTCFullYear() !== year
    || !Number.isFinite(maxCloud) || maxCloud < 0 || maxCloud > 100 || tile && !/^\d{2}[C-HJ-NP-X][A-HJ-NP-Z]{2}$/.test(tile)) {
    throw problem("Choose one year, a valid UTC time range, cloud cover from 0 to 100 and an optional MGRS tile.");
  }
  return {year, start, end, bbox: itemBounds(draft.bbox), maxCloud, tile};
}

function operation(fetchImplementation, signal, limits) {
  const controller = new AbortController(), usage = {requests: 0, bytes: 0, requestedBytes: 0, groups: 0, rows: 0, decodedBytes: 0};
  const begin = performance.now(), abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, {once: true});
  const timer = setTimeout(() => controller.abort(problem("Search time limit reached.", "static_item_limit")), limits.milliseconds);
  function check(bytes = 0) {
    controller.signal.throwIfAborted();
    if (usage.requests >= limits.requests || usage.requestedBytes + bytes > limits.bytes) throw problem("Search request or byte limit reached. Narrow the area, time range or tile.", "static_item_limit");
    usage.requests++; usage.requestedBytes += bytes;
  }
  const fetcher = async (url, options) => {check(); return fetchImplementation(url, {...options, signal: controller.signal});};
  return {usage, signal: controller.signal,
    async json(url) {
      const maxBytes = Math.min(2 * 1024 * 1024, limits.bytes - usage.bytes);
      if (maxBytes < 1) throw problem("Search byte limit reached.", "static_item_limit");
      const result = await readProviderJson(url, {fetchImplementation: fetcher, signal: controller.signal, maxBytes, label: "Published inventory"});
      usage.bytes += result.bytes; usage.requestedBytes += result.bytes;
      return result.data;
    },
    async range(part, start, end) {
      start = count(start, "range start"); end = count(end, "range end");
      if (start >= end || end > part.size) throw problem("Invalid partition byte range.");
      check(end - start);
      const response = await fetchImplementation(part.url, {signal: controller.signal, credentials: "omit", redirect: "error",
        referrerPolicy: "no-referrer", cache: "no-store", headers: {Range: `bytes=${start}-${end - 1}`}});
      const expectedRange = `bytes ${start}-${end - 1}/${part.size}`;
      if (response.status !== 206 || response.headers.get("content-range") !== expectedRange) {
        await response.body?.cancel(); throw problem(`Partition range unavailable (HTTP ${response.status}). No whole-file fallback was used.`);
      }
      const etag = response.headers.get("etag");
      if (!etag || part.etag && etag !== part.etag) {await response.body?.cancel(); throw problem("Partition snapshot changed or its ETag is unavailable. Search again.");}
      part.etag = etag;
      const reader = response.body.getReader(), chunks = []; let received = 0;
      try {
        while (true) {
          const {done, value} = await reader.read(); if (done) break;
          received += value.byteLength; usage.bytes += value.byteLength;
          if (received > end - start || usage.bytes > limits.bytes) throw problem("Partition byte limit reached.", "static_item_limit");
          chunks.push(value);
        }
      } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
      if (received !== end - start) throw problem("Partition range was truncated.");
      const bytes = new Uint8Array(received); let offset = 0;
      for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
      return bytes.buffer;
    },
    close() {clearTimeout(timer); signal?.removeEventListener("abort", abort); usage.milliseconds = Math.round(performance.now() - begin);}
  };
}

async function metadataFor(part, reader, op) {
  const offset = Math.max(0, part.size - 64 * 1024), tail = await op.range(part, offset, part.size);
  if (tail.byteLength < 8) throw problem("Invalid Parquet trailer.");
  const view = new DataView(tail), length = view.getUint32(tail.byteLength - 8, true) + 8;
  if (view.getUint32(tail.byteLength - 4, true) !== 0x31524150 || length > part.size || length < 8) throw problem("Invalid Parquet footer.");
  const footerStart = part.size - length;
  const footer = length <= tail.byteLength ? tail.slice(tail.byteLength - length) : await op.range(part, footerStart, part.size);
  const metadata = reader.parquetMetadata(footer);
  const schema = new Set(metadata.schema.map(field => field.name));
  if (!["id", "datetime", "bbox", "assets"].every(column => schema.has(column))) throw problem("This partition does not match the supported STAC-GeoParquet schema.");
  // External column files are never followed.
  if (metadata.row_groups.some(group => group.columns.some(column => column.file_path))) throw problem("External Parquet column files are unsupported.");
  return {...part, metadata, schema, footer, footerStart};
}
function groupsOf(part) {
  let offset = 0;
  return part.metadata.row_groups.map(group => {
    const rowStart = offset; offset += count(group.num_rows, "row count");
    return {group, rowStart, rowEnd: offset};
  });
}
function groupMatches(group, query) {
  const tile = group.columns.find(column => column.meta_data?.path_in_schema?.[0] === "_tile")?.meta_data?.statistics;
  const decode = value => typeof value === "string" ? value : value instanceof Uint8Array ? new TextDecoder().decode(value) : null;
  const minTile = decode(tile?.min_value), maxTile = decode(tile?.max_value);
  if (query.tile && minTile !== null && maxTile !== null && (query.tile < minTile || query.tile > maxTile)) return false;
  const dates = group.columns.find(column => column.meta_data?.path_in_schema?.[0] === "datetime")?.meta_data?.statistics;
  const start = time(dates?.min_value), end = time(dates?.max_value);
  if (Number.isFinite(start) && Number.isFinite(end) && (start > query.end || end < query.start)) return false;
  return true;
}
async function rowsFor(part, selected, columns, reader, op, limits) {
  const chunks = selected.group.columns.filter(column => columns.includes(column.meta_data?.path_in_schema?.[0]));
  const decodedBytes = chunks.reduce((total, column) => total + count(column.meta_data.total_uncompressed_size, "decoded column size"), 0);
  if (op.usage.decodedBytes + decodedBytes > limits.decodedBytes) throw problem("Decoded column limit reached.", "static_item_limit");
  op.usage.decodedBytes += decodedBytes;
  // Four workers bound in-flight reads; decoding sees only the requested column chunks.
  const regions = [{start: part.footerStart, bytes: part.footer}]; let next = 0;
  const reads = await Promise.allSettled(Array.from({length: Math.min(4, chunks.length)}, async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++].meta_data;
      const start = count(chunk.dictionary_page_offset ?? chunk.data_page_offset, "column offset");
      const length = count(chunk.total_compressed_size, "column length");
      regions.push({start, bytes: await op.range(part, start, start + length)});
    }
  }));
  const failed = reads.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  const file = {byteLength: part.size, async slice(start, end) {
    const region = regions.find(region => start >= region.start && end <= region.start + region.bytes.byteLength);
    if (!region) throw problem("Reader requested an unplanned column range.");
    return region.bytes.slice(start - region.start, end - region.start);
  }};
  op.signal.throwIfAborted();
  const rows = await reader.parquetReadObjects({file, metadata: part.metadata, compressors: reader.compressors,
    columns, rowStart: selected.rowStart, rowEnd: selected.rowEnd, includeRowIndex: true});
  op.signal.throwIfAborted();
  return rows;
}

export function normalizeStaticAssets(original, base, license) {
  const assets = typeof original === "string" ? JSON.parse(original) : original;
  if (!assets || typeof assets !== "object" || Array.isArray(assets)) throw problem("The selected scene has invalid assets.");
  return Object.entries(assets).map(([key, asset]) => {
    if (!asset || typeof asset !== "object" || typeof asset.href !== "string") throw problem("An asset reference is invalid.");
    return {key, href: publicItemUrl(asset.href, base), type: asset.type ?? null, roles: asset.roles ?? [],
      bands: structuredClone(asset["eo:bands"] ?? asset.bands ?? []), license: asset.license ?? license,
      rights: structuredClone(asset.rights ?? null), original: structuredClone(asset)};
  });
}

export function createStaticItemClient({fetchImplementation = globalThis.fetch, readerLoader = loadReader, limits = STATIC_ITEM_LIMITS} = {}) {
  limits = {...STATIC_ITEM_LIMITS, ...limits};
  for (const key of Object.keys(STATIC_ITEM_LIMITS)) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > STATIC_ITEM_LIMITS[key]) throw problem(`Invalid ${key} limit.`);
  return {
    async search(draft, {signal, onStatus = () => {}} = {}) {
      const query = queryOf(draft), op = operation(fetchImplementation, signal, limits);
      const items = new Map(), issues = []; let inventory, partitionCount = 0, inspectedPartitions = 0;
      try {
        onStatus("Reading the published partition inventory…");
        const catalog = await op.json(STATIC_ITEM_CATALOG);
        const collectionLink = catalog.links?.find(link => link.rel === "child" && new URL(link.href, STATIC_ITEM_CATALOG).pathname.endsWith(`/${STATIC_ITEM_COLLECTION}/collection.json`));
        if (!collectionLink) throw problem("The satellite collection is unavailable in the published catalog.");
        const collectionUrl = inventoryUrl(collectionLink.href, STATIC_ITEM_CATALOG);
        const collection = await op.json(collectionUrl);
        if (collection.id !== STATIC_ITEM_COLLECTION) throw problem("Collection identity changed.");
        const yearLink = collection.links?.find(link => link.rel === "item" && new URL(link.href, collectionUrl).pathname.endsWith(`/year=${query.year}/${query.year}.json`));
        if (!yearLink) throw problem("The requested year has no published partition inventory.");
        const itemUrl = inventoryUrl(yearLink.href, collectionUrl), item = await op.json(itemUrl);
        if (item.id !== String(query.year)) throw problem("Year inventory identity changed.");
        inventory = {catalogUrl: STATIC_ITEM_CATALOG, collectionUrl, itemUrl, collectionId: collection.id,
          license: collection.license ?? null, upstreamUpdatedAt: item.properties?.updated ?? collection["portolan:updated"] ?? null,
          readAt: new Date().toISOString(), adapter: STATIC_ITEM_ADAPTER, reader: "hyparquet@1.31.1"};
        const assets = Object.values(item.assets ?? {}).filter(asset => asset.type === "application/vnd.apache.parquet"
          && within(asset, query.start, query.end));
        partitionCount = assets.length;
        if (!within(item.properties, query.start, query.end) || item.bbox && !overlaps(itemBounds(item.bbox), query.bbox)) return {items: [], complete: true, issues: [], inventory, usage: op.usage, partitionCount, inspectedPartitions};
        if (!assets.length) throw problem("The published inventory has no matching Parquet assets.");
        const reader = await readerLoader(); op.signal.throwIfAborted();
        for (const asset of assets.slice(0, limits.partitions)) {
          try {
            onStatus(`Searching partition ${inspectedPartitions + 1} of ${partitionCount}…`);
            const part = await metadataFor({url: inventoryUrl(asset.href, itemUrl), size: count(asset["file:size"], "published file size")}, reader, op);
            const columns = searchColumns.filter(column => part.schema.has(column));
            if (query.tile && !part.schema.has("_tile")) throw problem("This partition cannot apply the requested tile filter.");
            for (const group of groupsOf(part).filter(({group}) => groupMatches(group, query))) {
              const rows = group.rowEnd - group.rowStart;
              if (op.usage.groups >= limits.groups || op.usage.rows + rows > limits.rows) throw problem("Search row or group limit reached. Narrow the time range or tile.", "static_item_limit");
              op.usage.groups++; op.usage.rows += rows;
              for (const row of await rowsFor(part, group, columns, reader, op, limits)) {
                const date = time(row.datetime), cloud = row["eo:cloud_cover"];
                if (!Number.isFinite(date) || date < query.start || date > query.end || query.tile && row._tile !== query.tile
                  || !Array.isArray(row.bbox) || !overlaps(itemBounds(row.bbox), query.bbox)
                  || query.maxCloud < 100 && (!Number.isFinite(cloud) || cloud > query.maxCloud)) continue;
                if (typeof row.id !== "string" || !row.id) throw problem("Scene identity is missing.");
                const key = `${collection.id}/${row.id}`;
                const candidate = {id: row.id, collectionId: collection.id, datetime: new Date(date).toISOString(),
                  bbox: [...row.bbox], cloudCover: Number.isFinite(cloud) ? cloud : null, tile: row._tile ?? null,
                  spatialMatch: "bounding-extent-candidate", inventory};
                // Archive/tail duplicates resolve only after reading their authoritative generation times.
                if (items.has(key)) {locations.get(items.get(key)).alternates.push({part, group, row: row[reader.rowIndex]}); continue;}
                locations.set(candidate, {part, group, row: row[reader.rowIndex], alternates: []}); items.set(key, candidate);
              }
            }
            inspectedPartitions++;
          } catch (error) {
            if (signal?.aborted) throw error;
            issues.push(error.code === "static_item_limit" ? error.message : "A published partition could not be read consistently. Results are incomplete.");
            break;
          }
        }
        if (assets.length > limits.partitions) issues.push("Partition limit reached; remaining published assets were not searched.");
        const sorted = [...items.values()].sort((a, b) => b.datetime.localeCompare(a.datetime) || a.id.localeCompare(b.id));
        if (sorted.length > limits.results) issues.push(`Showing the first ${limits.results} matches; narrow your search for the remaining scenes.`);
        return {items: sorted.slice(0, limits.results), complete: !issues.length, issues, inventory, usage: op.usage, partitionCount, inspectedPartitions};
      } finally {op.close();}
    },
    async select(item, {signal, onStatus = () => {}} = {}) {
      const location = locations.get(item);
      if (!location) throw problem("Search again before selecting this scene.");
      const op = operation(fetchImplementation, signal, limits);
      try {
        onStatus("Reading the selected scene’s asset references…");
        const reader = await readerLoader(), candidates = [];
        for (const position of [location, ...location.alternates]) {
          const columns = ["id", "assets", "geometry", "datetime", "s2:generation_time", "license", "links"].filter(column => position.part.schema.has(column));
          const rows = await rowsFor(position.part, {...position.group, rowStart: position.row, rowEnd: position.row + 1}, columns, reader, op, limits);
          const row = rows[0];
          if (!row || row.id !== item.id) throw problem("Selected scene identity changed. Search again.");
          candidates.push({row, part: position.part});
        }
        candidates.sort((a, b) => (time(b.row["s2:generation_time"]) || 0) - (time(a.row["s2:generation_time"]) || 0));
        if (candidates.length > 1 && candidates.some(candidate => !Number.isFinite(time(candidate.row["s2:generation_time"])))) throw problem("Overlapping scene revisions lack generation times; select a narrower published partition.");
        const {row, part} = candidates[0], license = row.license ?? item.inventory.license;
        return {...item, adapter: STATIC_ITEM_ADAPTER, custody: "referenced", license,
          assets: normalizeStaticAssets(row.assets, part.url, license), original: row,
          snapshot: {url: part.url, etag: part.etag, size: part.size}, usage: op.usage};
      } finally {op.close();}
    }
  };
}
