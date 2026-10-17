import {assertPublicArtifactBoundary} from './release-utils.mjs';
import {assertSurfaceReleaseManifest} from './static-release-aws.mjs';
import {sha256} from './release-utils.mjs';
import {CESIUM_RUNTIME, CESIUM_FRAME_PATH} from '../src/lib/cesiumRuntime.js';
import {CESIUM_FONT_ROOT, CESIUM_FONT_SHA256} from '../src/lib/cesiumLabels.js';
import {MAPBOX_RUNTIME} from '../src/lib/mapboxRuntime.js';

// Shared Workbench adapters are part of the core; optional SDKs have a separate,
// exact source inventory. The shared publication editor/compilers add 29 files;
// Local developer/figure/publishing exports add five files; cached COG Identify adds one.
// Saved-profile line of sight adds one shared component. These allowances
// do not change the byte or PWA/startup cache budgets. Bounded Ozi import adds one file.
export const BROWSER_DEMO_LIMITS = Object.freeze({
  coreFiles: 269, coreBytes: 20 * 1024 * 1024,
  rendererFiles: 400, rendererBytes: 14 * 1024 * 1024
});

function assertRendererInventory(files) {
  if (!files.length) return; // Retained releases before optional engine support.
  const cesiumRoot = CESIUM_RUNTIME.basePath.slice(1);
  const mapboxRoot = MAPBOX_RUNTIME.basePath.slice(1);
  const additions = new Set([CESIUM_FRAME_PATH.slice(1), ...[
    'OpenSans-Regular.ttf', 'manifest.json', 'LICENSE.txt', 'NOTICE.txt'
  ].map(name => CESIUM_FONT_ROOT.slice(1) + name)]);
  const cesium = files.filter(file => file.path.startsWith(cesiumRoot) && !additions.has(file.path))
    .map(file => ({...file, name: file.path.slice(cesiumRoot.length)}))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const expectedCount = CESIUM_RUNTIME.fileCount + MAPBOX_RUNTIME.assets.length + additions.size;
  if (files.length !== expectedCount || new Set(files.map(file => file.path)).size !== files.length
      || cesium.length !== CESIUM_RUNTIME.fileCount
      || sha256(cesium.map(file => `${file.name}\0${file.sha256}\n`).join('')) !== CESIUM_RUNTIME.treeSha256
      || [...additions].some(path => !files.some(file => file.path === path))
      || !files.some(file => file.path === CESIUM_FONT_ROOT.slice(1) + 'OpenSans-Regular.ttf'
        && file.sha256 === CESIUM_FONT_SHA256)
      || MAPBOX_RUNTIME.assets.some(asset => !files.some(file =>
        file.path === mapboxRoot + asset.name && file.sha256 === asset.sha256))) {
    throw Error('Browser Demo optional renderer inventory differs from the pinned SDKs');
  }
}

export function demoSurface(environment, requested) {
  if (!['dev', 'production'].includes(environment)) throw Error('Unexpected Demo environment');
  const surface = requested ?? (environment === 'production' ? 'managed' : 'browser');
  if (!['browser', 'managed'].includes(surface) || (environment === 'dev' && surface !== 'browser')) {
    throw Error('Demo surface must be browser or production managed');
  }
  return surface;
}

export function assertBrowserDemoRelease(manifest) {
  assertSurfaceReleaseManifest(manifest, 'demo');
  const files = manifest.artifactTree.files;
  const renderers = files.filter(file => file.path.startsWith('renderer-runtime/'));
  const core = files.filter(file => !file.path.startsWith('renderer-runtime/'));
  assertRendererInventory(renderers);
  if (manifest.schemaVersion !== 'opengeo.demo-build.1.0.0'
      || manifest.demoOrigin !== 'https://demo.studio.opengeo.tools'
      || manifest.aliases.length !== 0 || manifest.authConfig
      || manifest.routes.length !== 1 || manifest.routes[0].path !== '/'
      || core.length > BROWSER_DEMO_LIMITS.coreFiles
      || core.reduce((sum, f) => sum + f.bytes, 0) > BROWSER_DEMO_LIMITS.coreBytes
      || renderers.length > BROWSER_DEMO_LIMITS.rendererFiles
      || renderers.reduce((sum, f) => sum + f.bytes, 0) > BROWSER_DEMO_LIMITS.rendererBytes) {
    throw Error('Browser Demo must be a bounded anonymous one-page release');
  }
  assertPublicArtifactBoundary(files.map(file => file.path), 'Browser Demo', {allowWorkbenchDemo: true});
}
