import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {existsSync, lstatSync, readFileSync, readdirSync} from "node:fs";
import {dirname, join, resolve} from "node:path";

const expectedVersion = "1.13.4";
const packageVersion = JSON.parse(
  readFileSync(new URL("../node_modules/@observablehq/framework/package.json", import.meta.url), "utf8")
).version;
assert.equal(packageVersion, expectedVersion);
const yamlVersion = JSON.parse(readFileSync(new URL('../node_modules/js-yaml/package.json', import.meta.url), 'utf8')).version;
assert.equal(yamlVersion, '3.15.2', 'The YAML parser includes the reviewed merge-budget fix');
const notebookKitVersion = JSON.parse(readFileSync(new URL('../node_modules/@observablehq/notebook-kit/package.json', import.meta.url), 'utf8')).version;
assert.equal(notebookKitVersion, '2.5.6');
const notebookAssets = JSON.parse(readFileSync(new URL('../notebook-assets.json', import.meta.url), 'utf8'));
assert.ok(notebookAssets.runtime.length > 1000 && notebookAssets.styles.length > 1000, 'Notebook browser runtime is prebuilt');

const cacheRoot = process.env.OPEN_GEO_FRAMEWORK_CACHE_ROOT ? resolve(process.env.OPEN_GEO_FRAMEWORK_CACHE_ROOT) : null;
// The final image must not regain the unused system zlib or resolver debug API.
// libc package metadata stays present, so package-level scan findings are not hidden.
for (const architecture of ['x86_64-linux-gnu', 'aarch64-linux-gnu']) {
  const directory = `/usr/lib/${architecture}`;
  if (existsSync(directory)) {
    assert.ok(!readdirSync(directory).some(name => /^lib(?:z|resolv|nss_hesiod)\.so/.test(name)), 'Unused native libraries must stay absent');
    assert.ok(!existsSync(join(directory,'engines-3/padlock.so')), 'Unused system OpenSSL engines must stay absent');
  }
}
assert.ok(existsSync('/var/lib/dpkg/status.d/libc6'), 'Retain the actual libc package inventory');
assert.ok(cacheRoot, "OPEN_GEO_FRAMEWORK_CACHE_ROOT is required");
for (const path of ["_observablehq/client.js", "_observablehq/runtime.js", "_observablehq/stdlib.js"]) {
  assert.ok(existsSync(join(cacheRoot, path)), `${path} is absent from the seed cache`);
}
const npmEntries = readdirSync(join(cacheRoot, "_npm"));
assert.ok(npmEntries.some((entry) => entry.startsWith("react-dom@")));
assert.ok(npmEntries.some((entry) => entry.startsWith("react@")));
for (const name of ['htl@1.0.0','d3@7.9.0','geotiff@3.1.0-beta.0','leaflet@1.9.4','maplibre-gl@5.20.2','mapbox-gl-arcgis-featureserver@0.0.8']) {
  assert.ok(npmEntries.includes(name), `${name} must be available without build-time networking`);
  assert.ok(existsSync(join(cacheRoot,'_npm',name,'_esm.js')), `${name} needs its browser code, not only version metadata`);
}
assert.ok(readFileSync(join(cacheRoot, '_npm/geotiff@3.1.0-beta.0/_esm.js')).length > 0,
  'GeoTIFF requires prewarmed npm browser code; installed packages and _node bundles are insufficient');
const manifestPath = join(cacheRoot, 'opengeo-geotiff-cache-manifest.json');
if (existsSync(manifestPath)) {
  const manifestStat = lstatSync(manifestPath);
  assert.ok(manifestStat.isFile() && manifestStat.nlink === 1 && !(manifestStat.mode & 0o222),
    'GeoTIFF cache manifest must be an immutable regular file');
  assert.ok(manifestStat.size > 0 && manifestStat.size <= 1024 * 1024);
  const browserCache = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(browserCache.schemaVersion, 'opengeo.framework-browser-cache.1.0.0');
  assert.equal(browserCache.rootImport, 'npm:geotiff@3.1.0-beta.0');
  assert.equal(browserCache.frameworkVersion, expectedVersion);
  assert.ok(browserCache.provenance && typeof browserCache.provenance === 'object' &&
    !Array.isArray(browserCache.provenance) && Object.keys(browserCache.provenance).length);
  const expectedPackages = ['geotiff', '@petamoriken/float16', 'lerc', 'pako', 'parse-headers',
    'quick-lru', 'web-worker', 'xml-utils', 'zstddec'];
  assert.ok(Array.isArray(browserCache.packages));
  assert.deepEqual(browserCache.packages.map(pkg => pkg.name).sort(), [...expectedPackages].sort());
  const packagePrefixes = browserCache.packages.map(pkg => {
    assert.match(pkg.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
    if (pkg.name === 'geotiff') assert.equal(pkg.version, '3.1.0-beta.0');
    assert.ok(typeof pkg.license === 'string' && pkg.license.trim());
    assert.ok(Array.isArray(pkg.notices) && pkg.notices.length &&
      pkg.notices.every(notice => typeof notice === 'string' && notice.trim()));
    return `_npm/${pkg.name}@${pkg.version}/`;
  });
  assert.ok(Array.isArray(browserCache.files) && browserCache.files.length > 0 && browserCache.files.length <= 63);
  const cachePaths = new Set();
  let cacheBytes = manifestStat.size;
  for (const file of browserCache.files) {
    assert.deepEqual(Object.keys(file).sort(), ['checksumSha256', 'path', 'sizeBytes']);
    assert.match(file.path, /^[0-9A-Za-z_@./+-]+$/);
    assert.ok(file.path.split('/').every(part => part && part !== '.' && part !== '..'));
    assert.ok(packagePrefixes.some(prefix => file.path.startsWith(prefix)), 'File must belong to the exact GeoTIFF browser graph');
    assert.ok(!cachePaths.has(file.path), 'Duplicate browser cache path');
    assert.ok(Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0 && file.sizeBytes <= 16 * 1024 * 1024);
    assert.match(file.checksumSha256, /^[0-9a-f]{64}$/);
    cacheBytes += file.sizeBytes;
    assert.ok(cacheBytes <= 16 * 1024 * 1024, 'GeoTIFF cache exceeds the existing patch byte budget');
    const path = join(cacheRoot, file.path);
    for (let parent = dirname(path); parent !== cacheRoot; parent = dirname(parent)) {
      assert.ok(lstatSync(parent).isDirectory(), 'Cache parent must be a directory');
    }
    const stat = lstatSync(path);
    assert.ok(stat.isFile() && stat.nlink === 1 && !(stat.mode & 0o222), 'Cache files must be immutable regular files');
    assert.equal(stat.size, file.sizeBytes, `Cache size changed: ${file.path}`);
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), file.checksumSha256,
      `Cache checksum changed: ${file.path}`);
    cachePaths.add(file.path);
  }
  assert.ok(cachePaths.has('_npm/geotiff@3.1.0-beta.0/_esm.js'));
  assert.ok(packagePrefixes.every(prefix => [...cachePaths].some(path => path.startsWith(prefix))),
    'Every declared package must have verified cache bytes');
  for (const pkg of browserCache.packages) {
    const prefix = `_npm/${pkg.name}@${pkg.version}/`;
    assert.ok(pkg.notices.every(path => path.startsWith(prefix) && cachePaths.has(path)),
      'Package notices must be sealed files in that exact package');
  }
}
assert.deepEqual(npmEntries.filter(name=>name.startsWith('leaflet@')),['leaflet@1.9.4'], 'Review any change to the implicit Leaflet version');
for (const asset of ['leaflet.css','images/layers.png','images/layers-2x.png','images/marker-icon.png','images/marker-icon-2x.png','images/marker-shadow.png']) {
  assert.ok(existsSync(join(cacheRoot,'_npm/leaflet@1.9.4/dist',asset)), `Leaflet asset ${asset} must be available offline`);
}
assert.ok(existsSync(join(cacheRoot,'_npm/isoformat@0.2.1/_esm.js')), 'Inputs formatting must work offline');
assert.ok(existsSync(join(cacheRoot,'_npm/@observablehq/plot@0.6.17/_esm.js')), 'Plot must have its complete browser module');

process.stdout.write(`Observable Framework ${packageVersion} and its seed cache are pinned.\n`);
