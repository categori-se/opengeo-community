import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import {simple} from 'acorn-walk';
import {parseHtml, rewriteHtml} from '@observablehq/framework/dist/html.js';
import {rewriteNpmImports} from '@observablehq/framework/dist/npm.js';
import {parseProgram} from '@observablehq/framework/dist/javascript/parse.js';
import {findImports} from '@observablehq/framework/dist/javascript/imports.js';
import {getStringLiteralValue, isStringLiteral} from '@observablehq/framework/dist/javascript/source.js';
import {Sourcemap} from '@observablehq/framework/dist/sourcemap.js';

const MiB = 1024 * 1024;
const assetSymbol = 'opengeo.framework.localized-assets.1';
const readySymbol = 'opengeo.framework.localized-ready.1';
const json = value => JSON.stringify(value).replaceAll('<', '\\u003c');
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const fail = code => {throw Error(`framework_standalone_${code}`);};
const safePath = path => typeof path === 'string' && path.length <= 512
  && /^dist\/[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*$/.test(path)
  && path.split('/').every(part => part !== '.' && part !== '..');
// Framework's generated client declares these built-in samples even when the
// page does not consume them and the native output omits their files.
const unavailableClientSample = (path, assetPath) => /^dist\/_observablehq\/client\.[a-f0-9]{8}\.js$/.test(path)
  && /^dist\/_npm\/@observablehq\/sample-datasets@1\.0\.1\/(?:(?:aapl|alphabet|cars|citywages|diamonds|flare|industries|olympians|penguins|pizza|weather)\.csv|miserables\.json)$/.test(assetPath);

// This is a postprocessor for exact native Framework output, not an authoring
// compiler or a publication operation. Callers still own invocation admission,
// distribution review, output sealing and delivery-header acceptance.
export function localizeFrameworkOutput({files, entryPath = 'dist/index.html',
  maximumOutputBytes = 32 * MiB, archivePins = []}) {
  if (![32 * MiB, 96 * MiB].includes(maximumOutputBytes) || !safePath(entryPath)
    || !entryPath.endsWith('.html') || !Array.isArray(files)
    || !files.length || files.length > 512 || !Array.isArray(archivePins)) fail('manifest_invalid');
  const inventory = new Map(), reads = new Map();
  let inputBytes = 0;
  for (const file of files) {
    if (!safePath(file.path) || inventory.has(file.path.toLowerCase())
      || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1 || file.sizeBytes > 64 * MiB
      || !/^[a-f0-9]{64}$/.test(file.checksumSha256 ?? '') || typeof file.contentType !== 'string'
      || !Buffer.isBuffer(file.bytes) || file.bytes.length !== file.sizeBytes) fail('manifest_invalid');
    inputBytes += file.sizeBytes;
    inventory.set(file.path.toLowerCase(), file);
  }
  if (inputBytes > 96 * MiB) fail('input_limit');
  if (inventory.get(entryPath.toLowerCase())?.contentType !== 'text/html') fail('entry_invalid');
  const read = path => {
    if (reads.has(path)) return reads.get(path);
    const file = inventory.get(path.toLowerCase());
    if (!file || file.path !== path) fail('asset_missing');
    const bytes = file.bytes;
    if (bytes.length !== file.sizeBytes || checksum(bytes) !== file.checksumSha256) fail('asset_changed');
    reads.set(path, bytes);
    return bytes;
  };
  const localPath = (from, specifier) => {
    if (typeof specifier !== 'string' || !specifier || /[\\%?#\u0000-\u0020]/.test(specifier)
      || specifier.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) fail('external_asset');
    const path = 'dist/' + posix.normalize(specifier.startsWith('/') ? specifier.slice(1) : posix.join(posix.dirname(from.slice(5)), specifier));
    if (!safePath(path)) fail('unsafe_path');
    return path;
  };
  const pending = new Map(), modules = new Map(), assets = new Map(), missing = new Set();
  const moduleAlias = path => {
    const file = inventory.get(path.toLowerCase());
    if (!file || file.path !== path || !/\.(m?js)$/.test(path) || file.contentType !== 'text/javascript') fail('module_missing');
    if (!pending.has(path)) pending.set(path, `@opengeo-localized/${pending.size}`);
    return pending.get(path);
  };
  const asset = (path, mimeType) => {
    const file = inventory.get(path.toLowerCase());
    if (!file || file.path !== path || /\.(?:html|m?js|css)$/i.test(path)) fail('unsupported_asset');
    if (assets.has(path)) {
      const prior = assets.get(path);
      if (mimeType && prior.mimeType !== mimeType) fail('asset_type_changed');
      return prior;
    }
    const type = mimeType ?? file.contentType;
    if (!/^(?:image\/(?:tiff|geotiff|png|jpeg|svg\+xml)|font\/(?:woff2?|ttf|otf)|application\/(?:json|geo\+json|octet-stream)|text\/(?:plain|csv))$/.test(type)) fail('unsupported_asset');
    const bytes = read(path);
    const item = {path, payloadId: `opengeo-localized-file-${assets.size}`, mimeType: type,
      sizeBytes: bytes.length, checksumSha256: file.checksumSha256};
    const pins = archivePins.filter(pin => pin.sizeBytes === bytes.length && pin.checksumSha256 === file.checksumSha256
      && posix.extname(pin.path ?? '').toLowerCase() === posix.extname(path).toLowerCase());
    if (pins.length) item.archivePaths = pins.map(pin => pin.path);
    assets.set(path, item);
    return item;
  };
  const assetExpression = path => `globalThis[Symbol.for(${json(assetSymbol)})][${json(path)}]`;
  const rewriteModule = (source, path) => {
    const program = parseProgram(source), edits = new Sourcemap(source), attachmentNames = new Set(['registerFile', 'FileAttachment']);
    for (const node of program.body) if (node.type === 'ImportDeclaration') {
      for (const specifier of node.specifiers) if (['FileAttachment', 'registerFile'].includes(specifier.imported?.name)) attachmentNames.add(specifier.local.name);
    }
    const methods = new Map();
    for (const ref of findImports(program, '/' + path.slice(5), source)) {
      const resolved = localPath(path, ref.name);
      if (ref.method === 'static') methods.set(resolved, 'static');
      else if (!methods.has(resolved)) methods.set(resolved, ref.method);
    }
    simple(program, {
      ImportExpression(node) {if (!isStringLiteral(node.source)) fail('computed_import');},
      MemberExpression(node) {
        if (node.object.type === 'MetaProperty' && node.object.meta.name === 'import' && node.property.name === 'url' && !node.computed) {
          edits.replaceLeft(node.start, node.end, json(`https://opengeo-localized.invalid/${path.slice(5)}`));
        }
      },
      CallExpression(node) {
        const value = node.arguments[0];
        if (node.callee.type === 'MemberExpression' && node.callee.object.type === 'MetaProperty'
          && node.callee.property.name === 'resolve' && value && isStringLiteral(value)) {
          const resolved = localPath(path, getStringLiteralValue(value));
          if (inventory.has(resolved.toLowerCase()) && !/\.(m?js)$/.test(resolved)) {
            edits.replaceLeft(node.start, node.end, assetExpression(asset(resolved).path));
          } else if (!inventory.has(resolved.toLowerCase()) && !/\.(m?js)$/.test(resolved)) {
            if (!/^dist\/_observablehq\/stdlib\.[a-f0-9]{8}\.js$/.test(path)
              && !unavailableClientSample(path, resolved)) fail('asset_missing');
            missing.add(resolved);
            edits.replaceLeft(node.start, node.end, `(()=>{throw Error(${json('Unavailable lazy asset in this retained Framework output: ' + resolved)})})()`);
          }
        }
        if (node.callee.type === 'Identifier' && node.callee.name === 'fetch' && value && isStringLiteral(value)
          && /^(?:https?:)?\/\//i.test(getStringLiteralValue(value))) fail('external_request');
        if (node.callee.type !== 'Identifier' || !attachmentNames.has(node.callee.name)) return;
        const info = node.arguments.find(argument => argument.type === 'ObjectExpression');
        if (!info) return;
        const properties = new Map(info.properties.filter(property => property.type === 'Property').map(property => [property.key.name ?? property.key.value, property.value]));
        const filePath = properties.get('path'), type = properties.get('mimeType'), size = properties.get('size');
        if (!filePath || !isStringLiteral(filePath) || !type || !isStringLiteral(type) || size?.type !== 'Literal') fail('attachment_invalid');
        const resolved = localPath(path, getStringLiteralValue(filePath)), retained = asset(resolved, getStringLiteralValue(type));
        if (size.value !== retained.sizeBytes) fail('attachment_changed');
        edits.replaceLeft(filePath.start, filePath.end, assetExpression(resolved));
      }
    });
    return rewriteNpmImports(String(edits), specifier => {
      const resolved = localPath(path, specifier), file = inventory.get(resolved.toLowerCase());
      if (!file) {
        if (methods.get(resolved) === 'static' || !/^dist\/_observablehq\/(?:stdlib|client)\.[a-f0-9]{8}\.js$/.test(path)) fail('module_missing');
        // Native stdlib and client declare unused lazy built-ins that the output
        // omits. A local throwing module records that limitation without a
        // network read. Static and authored missing imports still fail above.
        const alias = `@opengeo-unavailable/${Buffer.from(resolved).toString('base64url')}`;
        missing.add(resolved);
        modules.set(alias, moduleUrl(`throw Error(${json('Unavailable in this retained Framework output: ' + resolved)});`));
        return alias;
      }
      if (/\.(m?js)$/.test(resolved)) return moduleAlias(resolved);
      fail('unsupported_module_asset');
    });
  };
  const window = parseHtml(''), document = window.document;
  document.open(); document.write(read(entryPath).toString('utf8')); document.close();
  const unsafeMeta = [...document.getElementsByTagName('meta')].some(meta =>
    ['refresh','content-security-policy'].includes(meta.getAttribute('http-equiv')?.trim().toLowerCase()));
  if (!document.documentElement || !document.head || unsafeMeta || document.querySelector('base,iframe,frame,frameset,object,embed')) fail('unsupported_document');
  const fontFallbacks = [], styles = [];
  const css = (source, from) => {
    if (/@import\b/i.test(source)) fail('unsupported_css_import');
    return source.replace(/url\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/gi, (match, quote, quoted, unquoted) => {
      const specifier = (quoted ?? unquoted).trim();
      if (specifier.startsWith('data:')) return match;
      const item = asset(localPath(from, specifier));
      return `url("__opengeo_localized_${item.payloadId}__")`;
    });
  };
  for (const link of [...document.querySelectorAll('link[href]')]) {
    const href = link.getAttribute('href'), rel = link.getAttribute('rel')?.toLowerCase();
    if (/^https:\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com)(?:\/|$)/.test(href)
      && ['preconnect', 'preload', 'stylesheet'].includes(rel)) {
      fontFallbacks.push(href); link.remove(); continue;
    }
    if (['modulepreload', 'preload', 'preconnect', 'dns-prefetch'].includes(rel)) {
      localPath(entryPath, href); link.remove(); continue;
    }
    if (rel !== 'stylesheet') fail('unsupported_link');
    const path = localPath(entryPath, href), file = inventory.get(path.toLowerCase());
    if (file?.contentType !== 'text/css') fail('unsupported_stylesheet');
    styles.push(css(read(path).toString('utf8'), path)); link.remove();
  }
  for (const style of [...document.querySelectorAll('style')]) {styles.push(css(style.textContent, entryPath)); style.remove();}
  for (const element of [...document.querySelectorAll('img[src],audio[src],video[src],source[src],a[download][href]')]) {
    const attribute = element.tagName === 'A' ? 'href' : 'src', original = element.getAttribute(attribute);
    if (original.startsWith('data:')) continue;
    // Apply upstream attribute/path semantics to a clone, leaving compiled
    // headings, loading markers and the full document structure untouched.
    const rewritten = parseHtml(rewriteHtml(element.outerHTML, {resolveFile: value => {
      const item = asset(localPath(entryPath, value)); return `opengeo-localized:${item.payloadId}`;
    }, resolveLink: value => value})).document.querySelector(element.tagName.toLowerCase());
    if (element.tagName === 'A') asset(localPath(entryPath, original));
    else if (!rewritten?.getAttribute(attribute)?.startsWith('opengeo-localized:')) fail('unsupported_asset');
    element.setAttribute(`data-opengeo-${attribute}`, localPath(entryPath, original)); element.removeAttribute(attribute);
  }
  if (document.querySelector('[srcset],[poster],[style],[background],[manifest],[ping],[formaction],form[action],input[src],track[src],script:not([type="module"])')
    || [...document.querySelectorAll('svg *')].some(element => ['image','use','feImage'].includes(element.localName)
      && (element.hasAttribute('href') || element.hasAttributeNS('http://www.w3.org/1999/xlink','href')))) fail('unsupported_document_asset');
  for (const script of [...document.querySelectorAll('script[type="module"]')]) {
    if (script.hasAttribute('src') && inventory.get(localPath(entryPath, script.getAttribute('src')).toLowerCase())?.contentType !== 'text/javascript') fail('module_missing');
    const source = script.hasAttribute('src') ? read(localPath(entryPath, script.getAttribute('src'))).toString('utf8') : script.textContent;
    const path = script.hasAttribute('src') ? localPath(entryPath, script.getAttribute('src')) : entryPath;
    const rewritten = rewriteModule(source, path);
    script.removeAttribute('src');
    script.textContent = `await globalThis[Symbol.for(${json(readySymbol)})]; await import(${json(moduleUrl(rewritten))});`;
  }
  for (const [path, alias] of pending) modules.set(alias, moduleUrl(rewriteModule(read(path).toString('utf8'), path)));
  if ([...assets.values()].reduce((sum, file) => sum + file.sizeBytes, 0) > 64 * MiB) fail('asset_limit');
  const records = [...assets.values()];
  for (const item of records) {
    const payload = document.createElement('script'); payload.type = 'application/octet-stream'; payload.id = item.payloadId;
    payload.textContent = read(item.path).toString('base64'); document.head.prepend(payload);
  }
  const bootstrap = document.createElement('script');
  bootstrap.textContent = `globalThis[Symbol.for(${json(readySymbol)})]=(async()=>{
    const urls=Object.create(null),records=${json(records)},styles=${json(styles)};
    for(const record of records){const encoded=document.getElementById(record.payloadId).textContent;
      if(encoded.length!==4*Math.ceil(record.sizeBytes/3)||/[^A-Za-z0-9+/=]/.test(encoded))throw Error('Localized file encoding changed');
      const chunks=[];for(let start=0;start<encoded.length;start+=32768){const chunk=encoded.slice(start,start+32768),binary=atob(chunk);if(btoa(binary)!==chunk)throw Error('Localized file encoding changed');chunks.push(Uint8Array.from(binary,c=>c.charCodeAt(0)));}
      const blob=new Blob(chunks,{type:record.mimeType});if(blob.size!==record.sizeBytes)throw Error('Localized file size changed');
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),v=>v.toString(16).padStart(2,'0')).join('');
      if(digest!==record.checksumSha256)throw Error('Localized file checksum changed');urls[record.path]=URL.createObjectURL(blob);
    }
    Object.defineProperty(globalThis,Symbol.for(${json(assetSymbol)}),{value:Object.freeze(urls)});
    for(let text of styles){for(const record of records)text=text.replaceAll('__opengeo_localized_'+record.payloadId+'__',urls[record.path]);const style=document.createElement('style');style.textContent=text;document.head.append(style);}
    for(const attr of ['src','href'])for(const element of document.querySelectorAll('[data-opengeo-'+attr+']')){element.setAttribute(attr,urls[element.getAttribute('data-opengeo-'+attr)]);element.removeAttribute('data-opengeo-'+attr);}
    addEventListener('pagehide',()=>{for(const url of Object.values(urls))URL.revokeObjectURL(url);},{once:true});
  })();`;
  const importmap = document.createElement('script'); importmap.type = 'importmap'; importmap.textContent = json({imports: Object.fromEntries(modules)});
  const payloadNodes = [...document.head.querySelectorAll('script[type="application/octet-stream"]')];
  if (payloadNodes.length) payloadNodes.at(-1).after(bootstrap);
  else document.head.prepend(bootstrap);
  bootstrap.after(importmap);
  const policy = document.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; script-src 'unsafe-inline' data:; script-src-attr 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data: blob:; connect-src data: blob:; worker-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'";
  document.head.prepend(policy);
  const html = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
  if (Buffer.byteLength(html) > maximumOutputBytes) fail('output_limit');
  window.close();
  return {html, manifest: {schemaVersion: 'opengeo.framework-localized-output.1.0.0', entryPath,
    inputFiles: [...reads.keys()].map(path => {const file=inventory.get(path.toLowerCase()); return {
      path:file.path, contentType:file.contentType, sizeBytes:file.sizeBytes, checksumSha256:file.checksumSha256};}), assets: records,
    fontFallback: fontFallbacks.length ? 'system-fonts' : null,
    unsupportedLazyImports: [...missing], outputBytes: Buffer.byteLength(html), publicationAuthorized: false}};
}
