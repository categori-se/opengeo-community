import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';

const BUILD_SHA256 = '19ce08245432b9ccd6b1fdc667c6f0f4f377f08eb1c8046072b03d56527a41cd';
const BUILD_CALL = 'await renderPage(page, { ...config, path, resolvers })';
const RESOLVER_METHODS = ['resolveFile', 'resolveImport', 'resolveStylesheet', 'resolveScript', 'resolveLink'];
const OPTIONS = ['base', 'path', 'title', 'preview', 'sidebar', 'toc', 'home', 'pages', 'pager', 'search'];
const digest = value => createHash('sha256').update(value).digest('hex');

function fingerprint(value) {
  const seen = new Set();
  const encode = item => {
    if (typeof item === 'function' || typeof item === 'symbol') {
      throw new TypeError('Unsupported cache fingerprint value');
    }
    if (item === null) return ['null'];
    if (typeof item !== 'object') return [typeof item, String(item)];
    if (seen.has(item)) throw new TypeError('Cyclic cache fingerprint');
    seen.add(item);
    let result;
    if (Array.isArray(item)) result = ['array', item.map(encode)];
    else if (item instanceof Date) result = ['date', item.toISOString()];
    else if (item instanceof Set) result = ['set', [...item].map(encode)];
    else if (item instanceof Map) result = ['map', [...item].map(([key, value]) => [encode(key), encode(value)])];
    else result = ['object', Object.entries(item).map(([key, value]) => [key, encode(value)])];
    seen.delete(item);
    return result;
  };
  return digest(JSON.stringify(encode(value)));
}

/** In-process cache of rendered pages, isolated by compiler/project scope.
 * Observe the pinned renderer's actual resolver reads; changed output aliases,
 * attachment metadata and links invalidate only the consumers that read them.
 * Snapshot restoration requires a checksum supplied by trusted build storage,
 * not by authored source files. Integrity is not a substitute for that authority.
 */
export function incrementalPageRenderer({scope, renderPage, maximumEntries = 128, maximumBytes = 32 * 1024 * 1024}) {
  if (typeof scope !== 'string' || !scope || scope.length > 1024 || typeof renderPage !== 'function' ||
      !Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 128 ||
      !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 32 * 1024 * 1024) throw new TypeError('Invalid page cache configuration');
  const cache = new Map();
  let bytes = 0;
  const stats = {rendered: 0, reused: 0};
  const render = async (page, options) => {
    if (options.preview) throw new TypeError('Live reactive preview is not a static page build');
    const key = fingerprint({schema: 1, scope, page,
      options: Object.fromEntries(OPTIONS.map(name => [name, options[name]]))});
    const methods = Object.fromEntries(RESOLVER_METHODS.map(name => [name,
      (...args) => options.resolvers[name](...args)]));
    methods.getOutputInfo = (...args) => options.loaders.getOutputInfo(...args);
    const cached = cache.get(key);
    if (cached && cached.reads.every(({name, args, hash}) => fingerprint(methods[name](...args)) === hash)) {
      cache.delete(key); cache.set(key, cached);
      stats.reused++;
      return cached.html;
    }
    if (cached) {bytes -= cached.bytes; cache.delete(key);}
    const reads = [];
    const observe = name => (argument) => {
      // The pinned resolver methods take one argument. Array callbacks may
      // additionally pass their index and collection; those are not inputs.
      const args = [argument];
      const value = methods[name](...args);
      reads.push({name, args: structuredClone(args), hash: fingerprint(value)});
      return value;
    };
    const resolvers = {...options.resolvers, ...Object.fromEntries(RESOLVER_METHODS.map(name => [name, observe(name)]))};
    // Preserve LoaderResolver's other methods and prototype without modifying it.
    const loaders = new Proxy(options.loaders, {get(target, name) {
      if (name === 'getOutputInfo') return observe(name);
      const value = Reflect.get(target, name, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    const html = await renderPage(page, {...options, resolvers, loaders});
    stats.rendered++;
    const size = Buffer.byteLength(html) + Buffer.byteLength(JSON.stringify(reads));
    if (size <= maximumBytes) {
      while (cache.size && (cache.size >= maximumEntries || bytes + size > maximumBytes)) {
        const oldest = cache.keys().next().value; bytes -= cache.get(oldest).bytes; cache.delete(oldest);
      }
      cache.set(key, {html, reads, bytes: size}); bytes += size;
    }
    return html;
  };
  function snapshot() {
    const entries = [...cache].map(([key,{html,reads}])=>({key,html,reads}));
    let body;
    while (true) {
      body = Buffer.from(JSON.stringify({schema:'opengeo.framework-page-cache.1',scope,entries}));
      if (body.length <= 32 * 1024 * 1024) break;
      entries.shift();
    }
    return {body,checksumSha256:digest(body)};
  }
  function restore(body, expectedChecksumSha256) {
    // Treat every invalid cache as a miss. Never leave a partially admitted cache.
    if (!Buffer.isBuffer(body) || body.length > 32 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(expectedChecksumSha256 ?? '') || digest(body) !== expectedChecksumSha256) return false;
    try {
      const value = JSON.parse(body);
      if (value.schema !== 'opengeo.framework-page-cache.1' || value.scope !== scope ||
          Object.keys(value).sort().join() !== 'entries,schema,scope' ||
          !Array.isArray(value.entries) || value.entries.length > maximumEntries) return false;
      const accepted = new Map(); let acceptedBytes = 0;
      for (const entry of value.entries) {
        if (!entry || Object.keys(entry).sort().join() !== 'html,key,reads' ||
            !/^[a-f0-9]{64}$/.test(entry.key) || accepted.has(entry.key) || typeof entry.html !== 'string' ||
            !Array.isArray(entry.reads) || entry.reads.length > 4096) return false;
        for (const read of entry.reads) {
          if (!read || Object.keys(read).sort().join() !== 'args,hash,name' ||
              ![...RESOLVER_METHODS,'getOutputInfo'].includes(read.name) ||
              !Array.isArray(read.args) || read.args.length !== 1 ||
              typeof read.args[0] !== 'string' || read.args[0].length > 4096 ||
              !/^[a-f0-9]{64}$/.test(read.hash)) return false;
        }
        const size = Buffer.byteLength(entry.html) + Buffer.byteLength(JSON.stringify(entry.reads));
        acceptedBytes += size;
        if (acceptedBytes > maximumBytes) return false;
        accepted.set(entry.key,{html:entry.html,reads:entry.reads,bytes:size});
      }
      cache.clear(); for (const [key,entry] of accepted) cache.set(key,entry);
      bytes = acceptedBytes; return true;
    } catch {return false;}
  }
  return {render, stats, snapshot, restore, clear() {cache.clear(); bytes = 0;}};
}

/** Add one optional effects hook to the exact pinned Framework build module.
 * No source files, installed dependencies or source-authored config are edited.
 * Refuse a different compiler instead of silently applying a brittle patch.
 */
export function installIncrementalPageHook(buildModuleUrl) {
  if (!(buildModuleUrl instanceof URL) || buildModuleUrl.protocol !== 'file:' ||
      !buildModuleUrl.pathname.endsWith('/@observablehq/framework/dist/build.js')) {
    throw new TypeError('Expected the pinned Framework build module URL');
  }
  return registerHooks({load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== buildModuleUrl.href) return result;
    const source = Buffer.from(result.source).toString('utf8');
    if (digest(source) !== BUILD_SHA256 || source.split(BUILD_CALL).length !== 2) {
      throw new Error('Framework build module differs from the reviewed 1.13.4 compiler');
    }
    return {...result, source: source.replace(BUILD_CALL,
      'await (effects.renderPage ?? renderPage)(page, { ...config, path, resolvers })')};
  }});
}
