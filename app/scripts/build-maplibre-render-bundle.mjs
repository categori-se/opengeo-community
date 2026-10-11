import {build, version as esbuildVersion} from "esbuild";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import {readFile, mkdir, writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {createHash} from "node:crypto";
import {buildMapWorker} from "../src/assets/maplibre-worker.js.js";

const installedRoot = fileURLToPath(new URL('../node_modules/maplibre-gl/', import.meta.url));

export async function prepareMapWorkerAsset(sourceRoot, {packageRoot = installedRoot} = {}) {
  const {version} = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  const hash = createHash('sha256').update(version).update(esbuildVersion);
  hash.update(await readFile(new URL('../src/assets/maplibre-worker.js.js', import.meta.url)));
  if (version === '6.4.1') {
    for (const name of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) hash.update(await readFile(resolve(packageRoot, 'dist', name)));
  }
  const fingerprint = hash.digest('hex');
  const cache = resolve(sourceRoot, '.observablehq/cache/assets');
  const marker = resolve(cache, 'maplibre-worker.inputs');
  const asset = resolve(cache, 'maplibre-worker.js');
  const [previousInput, previousOutput] = (await readFile(marker, 'utf8').catch(() => '')).split(':');
  const cached = await readFile(asset).catch(() => null);
  if (previousInput === fingerprint && cached && createHash('sha256').update(cached).digest('hex') === previousOutput) return false;
  const bytes = await buildMapWorker(packageRoot);
  await mkdir(cache, {recursive: true});
  await writeFile(asset, bytes);
  await writeFile(marker, fingerprint + ':' + createHash('sha256').update(bytes).digest('hex'));
  return true;
}

// v6 ships ESM and a separate worker. Embed a bundled worker so native renders
// and standalone HTML never need a CDN or a relative worker request.
export async function buildMaplibre6Bundle({packageRoot, globalName = 'opengeoMapLibre'}) {
  if (!['opengeoMapLibre', 'maplibregl'].includes(globalName)) throw Error('Unsupported runtime global');
  const metadata = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  if (metadata.version !== '6.4.1' || esbuildVersion !== '0.28.2') throw Error('Expected reviewed MapLibre 6.4.1 and esbuild 0.28.2');
  // Source comments must not encode the installation/cache directory: the same
  // reviewed package must produce identical bytes in either location.
  const options = {absWorkingDir: resolve(packageRoot), legalComments: 'inline', bundle: true, platform: 'browser', write: false, logLevel: 'silent'};
  // Portable HTML also opens from file: (an opaque origin). Bundle a classic
  // worker for that surface; module workers can fail there without map errors.
  // The pinned v6 loader selects classic workers for URLs ending in .cjs.
  // A fragment preserves the Blob resource identity while selecting that path.
  const portable = globalName === 'maplibregl';
  const worker = await build({...options, entryPoints: [resolve(packageRoot, 'dist/maplibre-gl-worker.mjs')], format: portable ? 'iife' : 'esm'});
  const contents = `import * as maplibregl from ${JSON.stringify(resolve(packageRoot, 'dist/maplibre-gl.mjs'))};
const workerUrl = URL.createObjectURL(new Blob([${JSON.stringify(worker.outputFiles[0].text)}], {type: 'text/javascript'}));
maplibregl.setWorkerUrl(workerUrl${portable ? ' + "#opengeo-worker.cjs"' : ''});
window.${globalName} = maplibregl;`;
  const result = await build({...options, stdin: {contents, resolveDir: packageRoot}, format: 'iife'});
  return result.outputFiles[0].contents;
}

export async function writeMaplibreExportAssets(outputRoot, {packageRoot = installedRoot} = {}) {
  const metadata = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  if (!['5.24.0', '6.4.1'].includes(metadata.version)) throw Error('Unreviewed MapLibre export runtime');
  const runtime = metadata.version === '6.4.1'
    ? await buildMaplibre6Bundle({packageRoot, globalName: 'maplibregl'})
    : await readFile(resolve(packageRoot, 'dist/maplibre-gl.js'));
  const destination = resolve(outputRoot, 'export-runtime');
  await mkdir(destination, {recursive: true});
  await writeFile(resolve(destination, 'maplibre-gl.js'), runtime);
  for (const [source, target] of [['dist/maplibre-gl.css', 'maplibre-gl.css'], ['LICENSE.txt', 'LICENSE.txt']]) {
    await writeFile(resolve(destination, target), await readFile(resolve(packageRoot, source)));
  }
}

// Both package creation and source-binding verification use this exact wrapper.
// No generated artifact is written into the source tree.
export async function buildMaplibreRenderBundle({packageRoot = installedRoot} = {}) {
  const metadata = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  if (metadata.version === '6.4.1') return buildMaplibre6Bundle({packageRoot});
  const require = createRequire(import.meta.url);
  if (packageRoot !== installedRoot || esbuildVersion !== "0.28.2" || require("maplibre-gl/package.json").version !== "5.24.0") {
    throw new Error("Canonical renderer bundle requires esbuild 0.28.2 and MapLibre 5.24.0");
  }
  const result = await build({
    stdin: {
      contents: "import maplibregl from 'maplibre-gl'; window.opengeoMapLibre=maplibregl;",
      resolveDir: fileURLToPath(new URL("../", import.meta.url))
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    logLevel: "silent"
  });
  return result.outputFiles[0].contents;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(await buildMaplibreRenderBundle());
}
