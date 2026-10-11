// Compiles source only. Authored code runs exclusively in the opaque iframe.
import {createMarkdownIt, parseMarkdown} from '@observablehq/framework/dist/markdown.js';
import {transpileJavaScript, transpileModule} from '@observablehq/framework/dist/javascript/transpile.js';
import {parseProgram} from '@observablehq/framework/dist/javascript/parse.js';
import {findFiles} from '@observablehq/framework/dist/javascript/files.js';
import {simple} from 'acorn-walk';
import {runtime, styles, themes, packages} from 'studio:framework-runtime';
import {parseNpmSpecifier} from '@observablehq/framework/dist/npm.js';
import satisfies from 'semver/functions/satisfies.js';

const virtual = 'https://studio-preview.invalid';
const md = createMarkdownIt();
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
export const FRAMEWORK_STANDALONE_DEFAULT_BYTES = 32 * 1024 * 1024;
export const FRAMEWORK_STANDALONE_ARCHIVE_BYTES = 96 * 1024 * 1024;
export function frameworkBase64Size(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw TypeError('Invalid file size');
  return 4 * Math.ceil(bytes / 3);
}
export function frameworkStandaloneLimit(outputProfile = 'default-32m', sizeAcknowledgment = null) {
  if (outputProfile === 'default-32m' && sizeAcknowledgment === null) return FRAMEWORK_STANDALONE_DEFAULT_BYTES;
  if (outputProfile === 'archive-96m' && sizeAcknowledgment === 'allow-up-to-96-mib-output') return FRAMEWORK_STANDALONE_ARCHIVE_BYTES;
  throw TypeError('Choose a supported HTML size limit and acknowledge the larger export');
}
const base64 = bytes => {
  const parts = [];
  // Multiples of three avoid intermediate padding and a second full binary string.
  for (let start = 0; start < bytes.length; start += 24576) parts.push(btoa(String.fromCharCode(...bytes.subarray(start, start + 24576))));
  return parts.join('');
};
const dataUrl = (bytes, type) => {
  return `data:${type};base64,${base64(bytes)}`;
};
const moduleUrl = code => dataUrl(new TextEncoder().encode(code), 'text/javascript');
const local = name => /^(\.?\.?\/)/.test(name);
export function resolvePreviewPath(from, name) {
  if (typeof name !== 'string' || !name || /[\\%?#\u0000-\u001f]/.test(name) || name.startsWith('//') || /^[\w+.-]+:/.test(name)) throw Error(`Invalid project path: ${name}`);
  const parts = name.startsWith('/') ? [] : from.split('/').slice(0, -1).filter(Boolean);
  for (const part of name.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {if (!parts.length) throw Error('Preview dependency escapes its source directory'); parts.pop();}
    else parts.push(part);
  }
  return '/' + parts.join('/');
}

export async function exportFrameworkStandalone(options) {
  return (await renderFrameworkPreview({...options, mode: 'standalone'})).html;
}
export function frameworkStandaloneProvenance(metadata, {path, sizeBytes, checksumSha256, contentType}) {
  const result = {path, sizeBytes, checksumSha256, contentType};
  if (metadata == null) return result;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) throw TypeError('Invalid file provenance');
  if (metadata.sizeBytes !== undefined && metadata.sizeBytes !== sizeBytes
    || metadata.checksumSha256 !== undefined && metadata.checksumSha256 !== checksumSha256
    || metadata.contentType !== undefined && metadata.contentType !== contentType) throw TypeError('The exact registered file changed');
  for (const key of ['attachmentId', 'datasetId', 'datasetVersionId', 'dataObjectId', 'resourceId', 'resourceVersionId',
    'organizationId', 'projectId', 'sourceProjectId', 'sourceRevisionId', 'sourceObjectId']) {
    if (metadata[key] == null) continue;
    if (typeof metadata[key] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(metadata[key])) throw TypeError('Invalid file identity');
    result[key] = metadata[key];
  }
  for (const key of ['s3VersionId', 'license', 'attribution', 'rightsStatus', 'sourceManifestChecksumSha256']) {
    if (metadata[key] == null) continue;
    const value = metadata[key];
    if (typeof value !== 'string' || !value || value.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
      || /X-Amz-|AWS4-HMAC-SHA256|\bBearer\s|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/i.test(value)) throw TypeError('Invalid credential-free file provenance');
    for (const link of value.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
      const url = new URL(link[0]);
      if (url.username || url.password || [...url.searchParams.keys()].some(name => /^(?:token|access_token|key|api_key|password|signature|auth|authorization)$/i.test(name))
        || /(?:access_token|token|password|signature)=/i.test(url.hash)) throw TypeError('Invalid credential-free file provenance');
    }
    if (key === 'sourceManifestChecksumSha256' && !/^[0-9a-f]{64}$/.test(value)) throw TypeError('Invalid source checksum');
    result[key] = value;
  }
  return result;
}
export async function renderFrameworkPreview({path, content, sourceRoot = '', readFile, readFileMetadata, theme = 'auto',
  mode = 'preview', outputProfile = 'default-32m', sizeAcknowledgment = null, isCurrent = () => true}) {
  if (!['preview', 'standalone'].includes(mode)) throw TypeError('Unsupported Framework output mode');
  const outputLimit = frameworkStandaloneLimit(outputProfile, sizeAcknowledgment);
  if (mode === 'preview' && outputProfile !== 'default-32m') throw TypeError('Live preview keeps its 32 MiB HTML limit');
  const current = () => {if (!isCurrent()) throw Error('The publication draft or account changed');};
  current();
  if (!path.endsWith('.md')) throw Error('Open a Markdown page for Framework preview');
  if (sourceRoot && !path.startsWith(sourceRoot + '/')) throw Error('Page is outside the Framework source directory');
  const pagePath = '/' + path.slice(sourceRoot ? sourceRoot.length + 1 : 0).replace(/\.md$/, '');
  const modules = new Map(), assets = new Map(), loaded = new Map(), warnings = new Set();
  const attachments = [];
  let total = 0;
  const sourcePath = name => (sourceRoot ? sourceRoot + '/' : '') + name.replace(/^\//, '');
  const read = async name => {
    if (!loaded.has(name)) {
      if (loaded.size >= 128) throw Error('Preview exceeds 128 referenced files');
      loaded.set(name, (async () => {
        const blob = await readFile(sourcePath(name));
        current();
        if (!(blob instanceof Blob) || blob.size < 1) throw TypeError('Referenced files must be non-empty Blobs');
        total += blob.size;
        if (total > 64 * 1024 * 1024) throw Error('Preview exceeds 64 MiB of referenced files');
        return blob;
      })());
    }
    return loaded.get(name);
  };
  const runtimeUrl = moduleUrl(runtime);
  const imports = {'observablehq:stdlib': runtimeUrl, 'npm:@observablehq/stdlib': runtimeUrl,
    'npm:htl': runtimeUrl, 'htl': runtimeUrl, 'npm:@observablehq/inputs': runtimeUrl};
  function resolveImport(from, name) {
    if (local(name)) {
      const target = resolvePreviewPath(from, name);
      if (!modules.has(target)) modules.set(target, null);
      return '@project' + target;
    }
    if (Object.hasOwn(imports, name)) return name;
    const specifier = parseNpmSpecifier(name.startsWith('npm:') ? name.slice(4) : name);
    const dependency = Object.hasOwn(packages, specifier.name) ? packages[specifier.name] : null;
    if (dependency && (!specifier.path || specifier.path === '+esm')
      && (!specifier.range || satisfies(dependency.version, specifier.range))) {
      const resolved = `@npm/${specifier.name}@${dependency.version}`;
      if (!Object.hasOwn(imports, resolved)) imports[resolved] = moduleUrl(dependency.code);
      return resolved;
    }
    // Installed, locked browser packages are bundled with this compiler. Never
    // fetch a missing package or silently replace an explicitly requested version.
    throw Error(`Module ${name} needs the built Framework preview`);
  }
  async function asset(from, name) {
    if (/^https:/.test(name)) {
      if (mode === 'standalone') throw Error('Offline HTML requires local files for remote assets');
      warnings.add('Remote assets need a connected file or Saved build'); return name;
    }
    if (/^data:/.test(name)) return name;
    const target = resolvePreviewPath(from, name);
    if (!assets.has(target)) assets.set(target, (async () => {
      const blob = await read(target);
      const key = '/attachment/' + attachments.length;
      attachments.push({path: key, blob, sourcePath: sourcePath(target)});
      return {name: virtual + target, path: key, mimeType: blob.type, size: blob.size};
    })());
    return (await assets.get(target)).path;
  }
  const page = parseMarkdown(content, {md, path: pagePath, style: null});
  if (page.code.length > 256) throw Error('Preview exceeds 256 reactive cells');
  const cells = [];
  for (const cell of page.code) {
    for (const file of cell.node.files) await asset(pagePath, file.name);
    cells.push(transpileJavaScript(cell.node, {id: cell.id, path: pagePath, mode: cell.mode,
      resolveImport: name => resolveImport(pagePath, name), resolveFile: name => virtual + resolvePreviewPath(pagePath, name)}));
  }
  for (const [modulePath] of modules) {
    if (modules.size > 128) throw Error('Preview exceeds 128 modules');
    const input = await (await read(modulePath)).text();
    for (const file of findFiles(parseProgram(input), modulePath, input)) await asset(modulePath, file.name);
    let output = await transpileModule(input, {root: '/', path: modulePath, servePath: modulePath,
      resolveImport: name => resolveImport(modulePath, name), resolveFile: name => virtual + resolvePreviewPath(modulePath, name)});
    const replacements = [];
    simple(parseProgram(output), {MemberExpression(node) {
      if (node.object.type === 'MetaProperty' && node.object.meta.name === 'import' && node.property.name === 'url' && !node.computed) replacements.push([node.start, node.end]);
    }});
    for (const [start,end] of replacements.sort((a,b) => b[0]-a[0])) output = output.slice(0,start) + json(virtual + modulePath) + output.slice(end);
    imports['@project' + modulePath] = moduleUrl(output);
  }
  // Template content is inert while resolving assets; it is never mounted in Studio.
  const template = document.createElement('template');
  template.innerHTML = [page.head ?? '', page.header ?? '', page.body, page.footer ?? ''].join('\n');
  for (const node of template.content.querySelectorAll('script,iframe,object,embed,base,meta,form')) node.remove();
  for (const node of template.content.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
    for (const attribute of ['src', 'poster', 'href']) {
      const name = node.getAttribute(attribute);
      if (!name || node.tagName === 'A' || name.startsWith('#')) continue;
      node.setAttribute(attribute, await asset(pagePath, name));
    }
    node.removeAttribute('srcset');
  }
  let customStyle = '';
  if (page.style && !page.style.startsWith('observablehq:')) customStyle = `<link rel="stylesheet" href="${await asset(pagePath, page.style)}">`;
  const files = await Promise.all(assets.values());
  const payloads = [], provenance = [];
  if (mode === 'standalone') {
    if (attachments.reduce((sum, file) => sum + frameworkBase64Size(file.blob.size), 0) > outputLimit) throw Error(`HTML exceeds ${outputLimit / 1024 / 1024} MiB; explicitly allow a larger export or use fewer files`);
    for (let index = 0; index < attachments.length; index++) {
      const file = attachments[index], info = files.find(item => item.path === file.path);
      const bytes = new Uint8Array(await file.blob.arrayBuffer()); current();
      const checksumSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
      const metadata = readFileMetadata ? await readFileMetadata(file.sourcePath) : null; current();
      provenance.push(frameworkStandaloneProvenance(metadata, {path: file.sourcePath, sizeBytes: bytes.length, checksumSha256, contentType: file.blob.type}));
      info.payloadId = 'opengeo-framework-file-' + index; info.checksumSha256 = checksumSha256;
      payloads.push(`<script type="application/octet-stream" id="${info.payloadId}">${base64(bytes)}</script>`);
    }
  }
  const config = {base: virtual + pagePath, files, ...(mode === 'standalone' ? {mode, outputProfile, sizeAcknowledgment} : {})};
  const code = `import {define,configurePreview} from ${json(runtimeUrl)}; await configurePreview(${json(config)});\n${cells.join('\n')}`;
  const themeStyle = themes[theme] ?? `${themes.light}\n@media(prefers-color-scheme:dark){${themes.dark}}`;
  const manifest = mode === 'standalone' ? `<script type="application/json" id="opengeo-framework-export">${json({schemaVersion: 1, mode: 'private-standalone', outputProfile, pagePath: path, files: provenance, notice: 'Private download. File metadata does not grant public distribution rights.'})}</script>` : '';
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:${mode === 'standalone' ? ' blob:' : ''}; img-src data: blob:; connect-src data: blob:; font-src data:; frame-src 'none'; worker-src blob:; form-action 'none'; base-uri 'none'"><style>${styles}\n${themeStyle}\n#observablehq-main{margin:16px;max-width:none}pre{overflow:auto}</style>${customStyle}<script type="importmap">${json({imports})}</script>${payloads.join('')}${manifest}<main id="observablehq-main">${template.innerHTML}</main><script type="module" src="${moduleUrl(code)}"></script>`;
  current();
  if (new Blob([html]).size > outputLimit) throw Error(`HTML exceeds ${outputLimit / 1024 / 1024} MiB including data and runtime; explicitly allow a larger export or use fewer files`);
  return {html, attachments, warnings: [...warnings]};
}
