import {build} from 'esbuild';
import {mkdir, copyFile, writeFile, realpath} from 'node:fs/promises';
import {resolve, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildFrameworkPreview} from './build-framework-preview.mjs';
import {buildNotebookPreview} from './build-notebook-preview.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
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
  const entries = {editor: 'scripts/editor-runtime.mjs',
    'editor.worker': 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js'};
  const result = await build({absWorkingDir: root, entryPoints: entries, outdir,
    bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022',
    minify: true, entryNames: '[name]-[hash]', chunkNames: 'chunk-[hash]',
    assetNames: 'asset-[hash]', loader: {'.ttf': 'file'}, metafile: true, legalComments: 'linked'});
  const manifest = {};
  for (const [name, entry] of Object.entries(entries)) {
    const [path, info] = await findEditorEntryOutput(result.metafile.outputs, entry);
    manifest[name] = basename(path);
    if (name === 'editor') manifest.css = basename(info.cssBundle);
  }
  manifest.frameworkPreview = await buildFrameworkPreview(outdir);
  manifest.notebookPreview = await buildNotebookPreview(outdir);
  await writeFile(resolve(outdir, 'manifest.json'), JSON.stringify(manifest));
  await copyFile(resolve(root, 'node_modules/monaco-editor/LICENSE'), resolve(outdir, 'LICENSE.txt'));
}
