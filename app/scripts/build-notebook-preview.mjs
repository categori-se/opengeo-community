import {build} from 'esbuild';
import {writeFile} from 'node:fs/promises';
import {join, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildNotebookAssets} from '../../services/observable-builder/scripts/notebook-assets.mjs';

export async function buildNotebookPreview(outdir) {
  const app = fileURLToPath(new URL('..', import.meta.url));
  const assets = await buildNotebookAssets(app);
  const result = await build({absWorkingDir: app, entryPoints: ['scripts/notebook-compiler.mjs'], outdir,
    entryNames: 'notebook-preview-[hash]', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, metafile: true,
    plugins: [{name: 'notebook-preview-runtime', setup(builder) {
      builder.onResolve({filter: /^studio:notebook-runtime$/}, () => ({path: 'runtime', namespace: 'notebook'}));
      builder.onLoad({filter: /.*/, namespace: 'notebook'}, () => ({contents: `export const runtime=${JSON.stringify(assets.runtime)}; export const styles=${JSON.stringify(assets.styles)};`, loader: 'js'}));
    }}]});
  await writeFile(join(outdir, 'NOTEBOOK-KIT-LICENSE.txt'), assets.license);
  return basename(Object.keys(result.metafile.outputs).find(path => path.endsWith('.js')));
}
