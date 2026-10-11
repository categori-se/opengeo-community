import {build} from 'esbuild';
import {readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {parse} from 'acorn';

const require = createRequire(import.meta.url);
const framework = dirname(require.resolve('@observablehq/framework/package.json'));
const dist = join(framework, 'dist');
const client = join(dist, 'client');
// Serialized into the existing runtime, and independently exercised without a build.
export async function restoreFrameworkStandaloneFiles(config, document = globalThis.document) {
  if (config.mode !== 'standalone' || !Array.isArray(config.files) || config.files.length > 128
    || !(config.outputProfile === 'default-32m' && config.sizeAcknowledgment === null
      || config.outputProfile === 'archive-96m' && config.sizeAcknowledgment === 'allow-up-to-96-mib-output')) {
    throw TypeError('Invalid standalone HTML mode or size acknowledgment');
  }
  let total = 0;
  const bodies = [];
  for (let index = 0; index < config.files.length; index++) {
    const info = config.files[index];
    if (!Number.isSafeInteger(info.size) || info.size < 1 || (total += info.size) > 64 * 1024 * 1024
      || info.path !== '/attachment/' + index || info.payloadId !== 'opengeo-framework-file-' + index
      || typeof info.checksumSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(info.checksumSha256)) throw TypeError('Invalid standalone file inventory');
    const node = document.getElementById(info.payloadId);
    const encoded = node?.textContent;
    if (node?.tagName !== 'SCRIPT' || node.getAttribute('type') !== 'application/octet-stream'
      || typeof encoded !== 'string' || encoded.length !== 4 * Math.ceil(info.size / 3)
      || /[^A-Za-z0-9+/=]/.test(encoded) || encoded.slice(0, -2).includes('=')) throw TypeError('Standalone file size or encoding changed');
    const chunks = [];
    for (let start = 0; start < encoded.length; start += 32768) {
      const chunk = encoded.slice(start, start + 32768), binary = atob(chunk);
      if (btoa(binary) !== chunk) throw TypeError('Standalone file encoding changed');
      chunks.push(Uint8Array.from(binary, character => character.charCodeAt(0)));
    }
    const blob = new Blob(chunks, {type: info.mimeType});
    if (blob.size !== info.size) throw TypeError('Standalone file size changed');
    if (!globalThis.crypto?.subtle) throw TypeError('This browser cannot verify offline file integrity');
    const checksum = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), value => value.toString(16).padStart(2, '0')).join('');
    if (checksum !== info.checksumSha256) throw TypeError('Standalone file checksum changed');
    bodies.push({path: info.path, blob});
  }
  return bodies;
}
// Take pure functions from the pinned upstream compiler, not a second parser.
async function declarations(file, names) {
  const source = await readFile(join(dist, file), 'utf8');
  const nodes = parse(source, {ecmaVersion: 'latest', sourceType: 'module'}).body;
  return names.map(name => {
    const node = nodes.find(node => node.id?.name === name);
    if (!node) throw Error(`Framework declaration changed: ${file}:${name}`);
    return source.slice(node.start, node.end);
  }).join('\n');
}

export async function buildFrameworkPreview(outdir) {
  const version = JSON.parse(await readFile(join(framework, 'package.json'), 'utf8')).version;
  if (version !== '1.13.4') throw Error('Review the browser compiler before updating Framework');
  // The connected land-cover pages use these packages. Package versions and
  // transitive dependencies come from the existing application lock; preview
  // never downloads dependencies or installs a publication's package.json.
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const packages = {}, packageLicenses = [];
  const notebook = dirname(dirname(require.resolve('@observablehq/notebook-kit/index.css')));
  const notebookRoot = join(notebook, '../..');
  if (JSON.parse(await readFile(join(notebookRoot, 'package.json'), 'utf8')).version !== '2.5.6') throw Error('Review legacy DOM compatibility before updating Notebook Kit');
  packageLicenses.push(`@observablehq/notebook-kit@2.5.6\n${await readFile(join(notebookRoot, 'LICENSE'), 'utf8')}`);
  for (const name of ['geotiff', 'jszip', 'd3']) {
    const entry = require.resolve(name);
    let directory = dirname(entry), pkg;
    while (true) {
      try {pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));} catch {}
      if (pkg?.name === name) break;
      const parent = dirname(directory);
      if (parent === directory) throw Error(`Preview package metadata missing: ${name}`);
      directory = parent;
    }
    const pinned = lock.packages[`node_modules/${name}`];
    if (!pinned?.integrity || pinned.version !== pkg.version) throw Error(`Preview package differs from lock: ${name}`);
    const bundled = await build({stdin: {contents: `export * from ${JSON.stringify(name)};${name === 'jszip' ? `export {default} from ${JSON.stringify(name)};` : ''}`,
      resolveDir: dirname(framework), loader: 'js'}, bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
      write: false, minify: true, metafile: true, legalComments: 'inline'});
    if (Object.values(bundled.metafile.outputs).some(output => output.imports.length)) throw Error(`Preview package has unbundled imports: ${name}`);
    packages[name] = {version: pkg.version, integrity: pinned.integrity, code: bundled.outputFiles[0].text};
    const licensePath = name === 'jszip' ? 'LICENSE.markdown' : 'LICENSE';
    packageLicenses.push(`${name}@${pkg.version}\n${await readFile(join(directory, licensePath), 'utf8')}`);
  }
  const runtimePlugin = {name: 'framework-browser-runtime', setup(builder) {
    builder.onResolve({filter: /^observablehq:/}, ({path}) => {
      if (path === 'observablehq:runtime') return {path: join(client, 'runtime.js')};
      if (path === 'observablehq:stdlib') return {path: join(client, 'stdlib.js')};
      return {path, external: true};
    });
    builder.onResolve({filter: /^npm:/}, ({path}) => {
      const name = path.slice(4);
      if (['@observablehq/runtime', '@observablehq/inspector', '@observablehq/inputs', 'htl', 'd3-dsv'].includes(name)) return {path: require.resolve(name)};
      return {path, external: true};
    });
  }};
  const runtime = await build({stdin: {contents: `
    import {define, main} from ${JSON.stringify(join(client, 'main.js'))};
    import {FileAttachment as native, registerFile, Generators, Mutable, resize} from 'observablehq:stdlib';
    import {html, svg} from 'htl';
    import * as Inputs from 'npm:@observablehq/inputs';
    import * as DOM from ${JSON.stringify(join(notebook, 'runtime/stdlib/dom/index.js'))};
    let base;
    export function FileAttachment(name, origin = base) {return native(name, /^(data:|blob:|about:)/.test(String(origin)) ? base : origin);}
    FileAttachment.prototype = native.prototype;
    const restoreStandaloneFiles = ${restoreFrameworkStandaloneFiles.toString()};
    export async function configurePreview(config) {
      base = config.base;
      let bodies = [];
      if (config.mode === 'standalone') bodies = await restoreStandaloneFiles(config);
      else if (config.mode !== undefined && config.mode !== 'preview') throw new TypeError('Unsupported Framework output mode');
      else if (config.outputProfile !== undefined || config.sizeAcknowledgment !== undefined) throw new TypeError('Live preview size settings changed');
      else if (config.files.length) bodies = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {window.removeEventListener('message', receive); reject(new TypeError('Preview attachments did not arrive'));}, 12000);
        function receive(event) {
          if (event.source !== parent || event.data?.kind !== 'opengeo-framework-files' || !Array.isArray(event.data.files)) return;
          window.removeEventListener('message', receive); clearTimeout(timer); resolve(event.data.files);
        }
        window.addEventListener('message', receive);
        parent.postMessage('opengeo-framework-files-ready', '*');
      });
      if (bodies.length !== config.files.length) throw new TypeError('Preview attachment inventory changed');
      const urls = new Map();
      for (const {name, ...info} of config.files) {
        const records = bodies.filter(file => file.path === info.path);
        const blob = records[0]?.blob;
        if (records.length !== 1 || !(blob instanceof Blob) || blob.size !== info.size) throw new TypeError('Preview attachment bytes changed');
        const url = URL.createObjectURL(blob); urls.set(info.path, url);
        registerFile(name, {...info, path:url}, base);
      }
      for (const node of document.querySelectorAll('[src],[href],[poster]')) for (const key of ['src','href','poster']) {
        const url = urls.get(node.getAttribute(key));
        if (url) node.setAttribute(key, url);
      }
      main.define('FileAttachment', [], () => FileAttachment);
      main.define('Inputs', [], () => Inputs);
      main.define('DOM', [], () => DOM);
    }
    export {define, html, svg, Inputs, DOM, Generators, Mutable, resize};`, resolveDir: dirname(framework), loader: 'js'},
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, minify: true, plugins: [runtimePlugin]});
  const css = async contents => (await build({stdin: {contents, resolveDir: join(dist, 'style'), loader: 'css'},
    bundle: true, write: false, minify: true})).outputFiles[0].text;
  const [styles, light, dark] = await Promise.all([
    css(`@import "./default.css"; @import ${JSON.stringify(require.resolve('@observablehq/inputs/dist/index.css'))};`),
    css('@import "./theme-air.css";'), css('@import "./theme-near-midnight.css";')
  ]);
  const config = await declarations('config.js', ['mergeStyle', 'stringOrNull', 'normalizeArray', 'normalizeTheme']);
  const frontmatter = await declarations('frontMatter.js', ['normalizeFrontMatter', 'normalizeToc', 'normalizeKeywords', 'normalizeSql']);
  const html = await declarations('html.js', ['Html', 'html']);
  const npmSpecifier = await declarations('npm.js', ['parseNpmSpecifier']);
  const shim = {
    'config.js': `import {resolvePath} from '${join(dist, 'path.js')}'; import {resolveTheme} from '${join(dist, 'theme.js')}'; ${config}; export {mergeStyle,stringOrNull,normalizeTheme};`,
    'frontMatter.js': `import {load} from 'js-yaml'; import {normalizeTheme,stringOrNull} from '${join(dist, 'config.js')}'; ${frontmatter}; export function readFrontMatter(input) {const m=input.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---(?:\\r?\\n|$)/); return m ? {content:input.slice(m[0].length),data:normalizeFrontMatter(load(m[1]))} : {content:input,data:{}};}`,
    'html.js': `import he from 'he'; ${html}; html.unsafe=Html.unsafe; export {html}; export const rewriteHtmlPaths = value => value;`,
    'files.js': 'export const getStylePath = name => name;',
    'tty.js': 'export const red=String, yellow=String;',
    'resolvers.js': 'export function getModuleResolver(){throw Error("Preview requires explicit module resolution");}',
    'javascript/module.js': 'export function transformJavaScriptSync(){throw SyntaxError("TypeScript and JSX require the built Framework preview");}',
    'npm.js': `${npmSpecifier}; export {parseNpmSpecifier};`,
  };
  const plugin = {name: 'framework-browser-compiler', setup(builder) {
    builder.onResolve({filter: /^studio:framework-runtime$/}, () => ({path: 'runtime', namespace: 'preview'}));
    builder.onLoad({filter: /.*/, namespace: 'preview'}, () => ({contents: `export const runtime=${JSON.stringify(runtime.outputFiles[0].text)}; export const styles=${JSON.stringify(styles)}; export const themes=${JSON.stringify({light,dark})}; export const packages=${JSON.stringify(packages)};`, loader: 'js'}));
    builder.onResolve({filter: /^node:path(?:\/posix)?$/}, () => ({path: require.resolve('path-browserify')}));
    builder.onResolve({filter: /^node:(crypto|fs\/promises)$/}, ({path}) => ({path, namespace: 'browser-node'}));
    builder.onLoad({filter: /.*/, namespace: 'browser-node'}, ({path}) => ({contents: path === 'node:crypto'
      // Used by Framework solely for DOM cell IDs; never for source integrity.
      ? `export function createHash(){let h=2166136261;return {update(s){for(const c of s)h=Math.imul(h^c.charCodeAt(0),16777619);return this},digest(){return (h>>>0).toString(16).padStart(8,'0')}}}`
      : `export function readFile(){throw Error('Filesystem access is not available in browser preview')}`, loader: 'js'}));
    builder.onLoad({filter: /\.js$/}, ({path}) => {
      const value = shim[path.slice(dist.length + 1)];
      if (path.startsWith(dist + '/') && value) return {contents: value, resolveDir: dist, loader: 'js'};
    });
  }};
  const result = await build({entryPoints: [new URL('./framework-preview.mjs', import.meta.url).pathname],
    outdir, entryNames: 'framework-preview-[hash]', bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
    write: true, minify: true, metafile: true, plugins: [plugin], legalComments: 'linked',
    define: {'process.env.OBSERVABLE_ANNOTATE_FILES':'undefined'}, banner: {js:'const process = {cwd: () => "/"};'}});
  const filename = Object.keys(result.metafile.outputs).find(path => path.endsWith('.js'));
  await writeFile(join(outdir, 'FRAMEWORK-LICENSE.txt'), await readFile(join(framework, 'LICENSE')));
  await writeFile(join(outdir, 'PREVIEW-PACKAGES-LICENSES.txt'), packageLicenses.join('\n\n'));
  return filename.split('/').pop();
}
