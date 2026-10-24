import {assertPublicArtifactBoundary} from './release-utils.mjs';
import {assertSurfaceReleaseManifest} from './static-release-aws.mjs';
import {sha256} from './release-utils.mjs';
import {CESIUM_RUNTIME, CESIUM_FRAME_PATH} from '../src/lib/cesiumRuntime.js';
import {CESIUM_FONT_ROOT, CESIUM_FONT_SHA256} from '../src/lib/cesiumLabels.js';
import {MAPBOX_RUNTIME} from '../src/lib/mapboxRuntime.js';
import {withoutRendererFrameBehavior} from './studio-edge-boundary.mjs';

// Shared Workbench adapters are part of the core; optional SDKs have a separate,
// exact source inventory. The shared publication editor/compilers add 29 files;
// Local developer/figure/publishing exports add five files; cached COG Identify adds one.
// Saved-profile line of sight adds one shared component. These allowances
// do not change the byte or PWA/startup cache budgets. Bounded Ozi import adds one file.
// Public credits and seven local licensing records add eight core artifacts.
// The completed source list adds seventeen existing shared-workbench modules.
// The measured 304-file core also includes their emitted dependency artifacts;
// the byte budget and exact optional-renderer inventory remain unchanged.
export const BROWSER_DEMO_LIMITS = Object.freeze({
  coreFiles: 304, coreBytes: 20 * 1024 * 1024,
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

// Shared rollback policy; operator identities and execution stay in the private CLI.
export function assertDemoRollbackDistribution({config, staticOrigin, managed = false, apiOriginDomain}) {
  const origins = config?.Origins?.Items ?? [];
  const behaviors = withoutRendererFrameBehavior({config, staticOrigin});
  if (config?.DefaultCacheBehavior?.TargetOriginId !== staticOrigin.Id) {
    throw new Error('Demo rollback root is outside its reviewed static origin');
  }
  if (!managed) {
    if (origins.length !== 1 || behaviors.length !== 0) {
      throw new Error('Demo rollback edge is outside its static boundary');
    }
    return;
  }
  if (!/^[a-z0-9]{10}\.execute-api\.us-east-1\.amazonaws\.com$/.test(apiOriginDomain ?? '')) {
    throw new Error('Managed demo rollback requires its exact API Gateway origin domain');
  }
  const apiOrigins = origins.filter(({DomainName}) => DomainName === apiOriginDomain);
  const authBehaviors = behaviors.filter(({PathPattern}) => PathPattern === 'auth-config.json');
  const apiBehaviors = behaviors.filter(({PathPattern}) => PathPattern === 'api/*');
  if (origins.length !== 2
    || behaviors.length !== 2
    || apiOrigins.length !== 1
    || authBehaviors.length !== 1
    || authBehaviors[0].TargetOriginId !== staticOrigin.Id
    || apiBehaviors.length !== 1
    || apiBehaviors[0].TargetOriginId !== apiOrigins[0].Id) {
    throw new Error('Managed demo rollback edge is outside its reviewed static, auth, and API paths');
  }
}

export function assertBrowserDemoRelease(manifest) {
  assertSurfaceReleaseManifest(manifest, 'demo');
  const files = manifest.artifactTree.files;
  const renderers = files.filter(file => file.path.startsWith('renderer-runtime/'));
  const core = files.filter(file => !file.path.startsWith('renderer-runtime/'));
  assertRendererInventory(renderers);
  if (manifest.schemaVersion !== 'opengeo.demo-build.1.0.0'
      || manifest.demoOrigin !== 'https://demo.studio.opengeo.tools'
      || manifest.aliases.length !== manifest.routes.length - 1 || manifest.authConfig
      || ![1, 2].includes(manifest.routes.length) || manifest.routes[0].path !== '/'
      || (manifest.routes.length === 2 && (manifest.routes[1].path !== '/credits'
        || manifest.routes[1].htmlPath !== 'credits.html'
        || !files.some(file => file.path === 'credits.html')
        || manifest.aliases[0]?.key !== 'credits'
        || manifest.aliases[0]?.sourcePath !== 'credits.html'))
      || core.length > BROWSER_DEMO_LIMITS.coreFiles
      || core.reduce((sum, f) => sum + f.bytes, 0) > BROWSER_DEMO_LIMITS.coreBytes
      || renderers.length > BROWSER_DEMO_LIMITS.rendererFiles
      || renderers.reduce((sum, f) => sum + f.bytes, 0) > BROWSER_DEMO_LIMITS.rendererBytes) {
    throw Error('Browser Demo must contain only its bounded anonymous workbench and optional public credits');
  }
  assertPublicArtifactBoundary(files.map(file => file.path), 'Browser Demo', {allowWorkbenchDemo: true});
}
