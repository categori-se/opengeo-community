import {build} from 'esbuild';
import {mkdir, copyFile, writeFile, readFile, realpath} from 'node:fs/promises';
import {resolve, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {buildFrameworkPreview} from './build-framework-preview.mjs';
import {buildNotebookPreview} from './build-notebook-preview.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const SANITIZER_VERSION = '3.4.17';
export async function editorSanitizerRemedy(appRoot = root) {
  const officialPath = 'node_modules/dompurify/dist/purify.es.mjs';
  const vendorPath = 'node_modules/monaco-editor/esm/vs/base/browser/dompurify/dompurify.js';
  const official = await realpath(resolve(appRoot, officialPath));
  const vendor = await realpath(resolve(appRoot, vendorPath));
  const [metadata, monaco, source, replaced] = await Promise.all([
    readFile(resolve(appRoot, 'node_modules/dompurify/package.json'), 'utf8').then(JSON.parse),
    readFile(resolve(appRoot, 'node_modules/monaco-editor/package.json'), 'utf8').then(JSON.parse),
    readFile(official), readFile(vendor)
  ]);
  const version = bytes => /\bDOMPurify\.version\s*=\s*['"]([^'"]+)['"]/.exec(bytes.toString())?.[1];
  if (metadata.version !== SANITIZER_VERSION || version(source) !== SANITIZER_VERSION || monaco.version !== '0.56.0') {
    throw Error('Editor sanitizer requires official DOMPurify 3.4.17 and reviewed Monaco 0.56.0');
  }
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const notices = await Promise.all([
    ['node_modules/monaco-editor/LICENSE', 'LICENSE.txt'],
    ['node_modules/monaco-editor/ThirdPartyNotices.txt', 'monaco-ThirdPartyNotices.NOTICE.txt'],
    ['node_modules/dompurify/LICENSE', 'DOMPurify.LICENSE.txt']
  ].map(async ([path, output]) => ({path, output, sha256: hash(await readFile(resolve(appRoot, path)))})));
  const provenance = {package: 'dompurify', version: SANITIZER_VERSION, path: officialPath, sha256: hash(source),
    replaces: {package: 'monaco-editor', version: monaco.version, embeddedVersion: version(replaced), path: vendorPath, sha256: hash(replaced)}, notices};
  let replacements = 0;
  return {
    provenance, notices,
    plugin: {name: 'reviewed-editor-sanitizer', setup(builder) {
      builder.onResolve({filter: /dompurify[\\/]dompurify\.js$/}, async args => {
        const path = await realpath(resolve(args.resolveDir, args.path));
        if (path !== vendor) return;
        replacements++;
        return {path: official};
      });
    }},
    async verify(metafile) {
      const inputs = await Promise.all(Object.keys(metafile.inputs).map(path =>
        realpath(resolve(appRoot, path)).catch(() => resolve(appRoot, path))));
      if (inputs.includes(vendor)) throw Error('Editor retained the vendored Monaco sanitizer');
      if (!inputs.includes(official) || !replacements) throw Error('Editor official sanitizer replacement is missing');
      return provenance;
    }
  };
}
export async function findEditorEntryOutput(outputs, entry, appRoot = root) {
  const expected = await realpath(resolve(appRoot, entry));
  for (const [path, info] of Object.entries(outputs)) {
    if (!info.entryPoint) continue;
    if (await realpath(resolve(appRoot, info.entryPoint)) === expected) return [path, info];
  }
  throw Error(`Editor entry output missing: ${entry}`);
}
export async function buildPublicationEditor(outputRoot) {
  const outdir = resolve(outputRoot, 'editor-assets');
  await mkdir(outdir, {recursive: true});
  const sanitizer = await editorSanitizerRemedy();
  const entries = {editor: 'scripts/editor-runtime.mjs',
    'editor.worker': 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js'};
  const result = await build({absWorkingDir: root, entryPoints: entries, outdir,
    bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022',
    minify: true, entryNames: '[name]-[hash]', chunkNames: 'chunk-[hash]',
    assetNames: 'asset-[hash]', loader: {'.ttf': 'file'}, metafile: true, legalComments: 'linked', plugins: [sanitizer.plugin]});
  const manifest = {sanitizer: await sanitizer.verify(result.metafile)};
  for (const [name, entry] of Object.entries(entries)) {
    const [path, info] = await findEditorEntryOutput(result.metafile.outputs, entry);
    manifest[name] = basename(path);
    if (name === 'editor') manifest.css = basename(info.cssBundle);
  }
  manifest.frameworkPreview = await buildFrameworkPreview(outdir);
  manifest.notebookPreview = await buildNotebookPreview(outdir);
  for (const notice of sanitizer.notices) await copyFile(resolve(root, notice.path), resolve(outdir, notice.output));
  await writeFile(resolve(outdir, 'manifest.json'), JSON.stringify(manifest));
}
