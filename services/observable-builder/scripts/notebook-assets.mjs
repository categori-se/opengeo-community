import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {dirname, join, basename, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export async function buildNotebookAssets(dependencyRoot) {
  const require = createRequire(join(resolve(dependencyRoot), 'package.json'));
  const {build} = require('esbuild');
  const kit = dirname(dirname(require.resolve('@observablehq/notebook-kit/index.css')));
  const packageRoot = join(kit, '../..');
  if (JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version !== '2.5.6') throw Error('Review the notebook compiler before changing its version.');
  const runtime = await build({entryPoints: [fileURLToPath(new URL('../src/notebook-runtime.mjs', import.meta.url))], bundle: true, format: 'esm',
    nodePaths: [join(resolve(dependencyRoot), 'node_modules')], platform: 'browser', target: 'es2022', outfile: 'notebook-runtime.js', write: false, metafile: true, minify: true, legalComments: 'inline', plugins: [{name: 'local-notebook-libraries', setup(builder) {
      builder.onResolve({filter: /^@observablehq\/notebook-kit\/runtime$/}, () => ({path: join(kit, 'runtime/index.js')}));
      builder.onResolve({filter: /^(?:htl|d3|@observablehq\/inputs|@observablehq\/plot)$/}, ({path}) => ({path: require.resolve(path)}));
      // These optional adapters contain static CDN imports. Bundling their lazy
      // entry points would hoist those imports into the runtime's startup graph.
      // Keep them lazy and report missing offline dependencies only on use.
      builder.onResolve({filter: /\/(?:xlsx|duckdb|mermaid|dot|leaflet|mapboxgl|tex|vega-lite)\.js$/}, ({path, importer, kind}) => {
        if (kind !== 'dynamic-import' || !resolve(dirname(importer), path).startsWith(join(kit, 'runtime') + '/')) return;
        return {path: 'opengeo:notebook-optional/' + basename(path, '.js'), external: true};
      });
      builder.onResolve({filter: /^https:\/\/cdn\.jsdelivr\.net\/npm\/(?:htl|d3-dsv|jszip|@observablehq\/inputs)\/\+esm$/}, ({path}) => {
        const name = path.slice('https://cdn.jsdelivr.net/npm/'.length, -'/+esm'.length);
        return {path: require.resolve(name === 'jszip' ? 'jszip/dist/jszip.min.js' : name)};
      });
    }}]});
  for (const [path, output] of Object.entries(runtime.metafile.outputs)) {
    if (!path.endsWith('.js')) continue;
    const eager = output.imports.filter(item => item.external && item.kind !== 'dynamic-import');
    if (eager.length) throw Error(`Notebook runtime must not load external dependencies on startup: ${eager.map(item => item.path).join(', ')}`);
  }
  const runtimeCode = runtime.outputFiles.find(file => file.path.endsWith('.js')).text.replace(
    /import\("opengeo:notebook-optional\/([\w-]+)"\)/g,
    (_, name) => `Promise.reject(new Error(${JSON.stringify(`The ${name} adapter is not bundled for offline notebooks yet.`)}))`);
  const styles = await build({stdin: {contents: '@import "./index.css"; @import "./theme-air.css"; @import "./theme-near-midnight.css" (prefers-color-scheme: dark);', resolveDir: join(kit, 'styles'), loader: 'css'},
    bundle: true, write: false, minify: true, loader: {'.woff2': 'dataurl'}});
  const themeOverrides = await Promise.all([['light', 'air'], ['dark', 'near-midnight']].map(async ([mode, theme]) => {
    const result = await build({entryPoints: [join(kit, 'styles', `theme-${theme}.css`)], bundle: true, write: false, minify: true});
    return result.outputFiles[0].text.replace(/:root/g, `:root[data-notebook-theme="${mode}"]`);
  }));
  return {runtime: runtimeCode, styles: styles.outputFiles[0].text + themeOverrides.join('') + (runtime.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? ''),
    license: await readFile(join(packageRoot, 'LICENSE'), 'utf8')};
}
