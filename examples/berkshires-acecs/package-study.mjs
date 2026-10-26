import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, join} from 'node:path';
import {zipSync, strToU8} from '../../app/node_modules/fflate/esm/browser.js';
import {emptyMapDefinition} from '../../app/src/lib/mapDefinition.js';
import {LocalProjectStore} from '../../app/src/lib/localProjectStore.js';
import {createPublicationSourceArchive, readPublicationSourceArchive} from '../../app/src/lib/publicationSourceArchive.js';
import {exportGeoLibreProject} from '../../app/src/lib/geolibreProject.js';
import {summarizeArchive} from './analysis.js';

// Produce ordinary Studio input packages. No provider reads, storage or account writes.
const directory = fileURLToPath(new URL('.', import.meta.url));
const output = resolve(process.argv[2] ?? '/tmp/opengeo-berkshires-study');
assert.notEqual(output, resolve(directory), 'Choose a separate output directory.');
const bytes = await readFile(join(directory, 'data/acecs.geojson'));
const checksum = createHash('sha256').update(bytes).digest('hex');
assert.equal(checksum, '1a436462c200365cce9235e79815e1458aabb22d4add893057172817d2e9663f');
const archive = JSON.parse(bytes), summary = summarizeArchive(archive);
assert.deepEqual([summary.recordCount, summary.designationCount, summary.municipalityCount], [16, 5, 11]);
const provenance = JSON.parse(await readFile(join(directory, 'provenance.json')));
const layerId = 'berkshires-acecs';
const title = 'Berkshire conservation designations';
const definition = emptyMapDefinition({
  colorMode: 'light',
  mapViews: [{id: 'default', title: 'Berkshire archive', center: [-73.28, 42.28], zoom: 8.4, pitch: 0, bearing: 0}],
  basemaps: [{basemapId: 'blank', title: 'Blank canvas', visible: true, opacity: 1, order: 0}],
  activeLayerId: layerId,
  persistence: {mode: 'browser-personal', uploaded: false, published: false},
  layers: [{layerId, datasetId: 'example-berkshires-acecs', title, sourceType: 'geojson-object',
    geometryType: 'MultiPolygon', visible: true, order: 0, opacity: 1,
    style: {renderer: 'category', categoryField: 'NAME', fill: '#3b8b75',
      palette: ['#3b8b75', '#8771a6', '#b57b38', '#4489a8', '#a45a72'],
      stroke: '#344b49', strokeWidth: 1.25, fillOpacityFactor: 0.62},
    labels: {enabled: false, field: 'NAME'}, attribution: provenance.provider.name,
    metadata: {source: provenance.source, archive: provenance.archive,
      curated: {description: 'Historical planning inventory: 16 municipal records, five designations, eleven town attributes.',
        attribution: provenance.provider.name, license: 'MassGIS provider public-domain determination; archive-specific statement absent',
        rights: provenance.provider.rights, inputSha256: checksum}}}]
});
// Preserve the original file bytes, including formatting, as one checked asset.
const references = [{layerId, checksum}];
const project = zipSync({
  'project.json': strToU8(JSON.stringify(definition)),
  [`assets/${checksum}.geojson`]: bytes,
  'manifest.json': strToU8(JSON.stringify({schemaVersion: 'opengeo.local-project-bundle.1.0.0', title,
    references, dependencies: [{layerId, mode: 'included', attribution: provenance.provider.name,
      license: 'MassGIS provider public-domain determination; archive-specific statement absent'},
      {kind: 'basemap', id: 'blank', mode: 'included'}, {kind: 'viewer-software', mode: 'excluded'}],
    completeness: 'Editable Project with original local data and a blank background; Studio software is not bundled.'}))
}, {level: 6, mtime: new Date(1980, 0, 1)});
const restored = await new LocalProjectStore().inspectBackup(project);
assert.deepEqual(restored.geojsonByLayerId.get(layerId), archive);
assert.equal(restored.definition.layers[0].style.categoryField, 'NAME');
const media = {'index.md': 'text/markdown', 'analysis.js': 'text/javascript',
  'provenance.json': 'application/json', 'data/acecs.geojson': 'application/geo+json'};
const files = await Promise.all(Object.entries(media).map(async ([relativePath, type]) => ({relativePath,
  blob: new Blob([await readFile(join(directory, relativePath))], {type})})));
const publication = await createPublicationSourceArchive({files,
  metadata: {title, entryPath: 'index.md', lockfilePath: null, rightsStatus: 'unreviewed'}});
const reopened = await readPublicationSourceArchive(publication.blob);
const retained = reopened.files.find(file => file.relativePath === 'data/acecs.geojson');
assert.equal(createHash('sha256').update(Buffer.from(await retained.blob.arrayBuffer())).digest('hex'), checksum);
const geolibre = exportGeoLibreProject({name: title, definition},
  {embeddedDataByLayerId: new Map([[layerId, {complete: true, data: archive}]])});
assert.deepEqual(geolibre.project.layers[0].geojson, archive);
assert.deepEqual(geolibre.project.layers[0].metadata.opengeo.layer.style, definition.layers[0].style);
assert.equal(geolibre.project.layers[0].style.vectorStyleMode, 'categorized');
assert.equal(geolibre.project.layers[0].style.vectorStyleProperty, 'NAME');
assert.equal(geolibre.project.layers[0].style.vectorStyleStops.length, 5);
assert.equal(geolibre.project.layers[0].style.fillOpacity, 0.62);
geolibre.report.warnings.push('Category colors and fill opacity use the pinned GeoLibre 3.0.0 renderer fields. Full desktop rendering, current upstream parity and independent operator acceptance remain unverified.');
const outputs = new Map([
  ['berkshires-acecs.opengeo-project.zip', Buffer.from(project)],
  ['berkshires-acecs.publication-source.zip', Buffer.from(await publication.blob.arrayBuffer())],
  ['berkshires-acecs.geolibre.json', Buffer.from(geolibre.json + '\n')],
  ['berkshires-acecs.geolibre-conversion.json', Buffer.from(JSON.stringify(geolibre.report, null, 2) + '\n')]
]);
// Check every existing destination before creating anything. Repeated handover
// preparation reuses exact bytes and never replaces an operator's changed file.
const reused = new Set();
for (const [filename, content] of outputs) {
  const path = join(output, filename);
  let info;
  try {info = await lstat(path);} catch (error) {if (error.code === 'ENOENT') continue; throw error;}
  assert.ok(info.isFile() && !info.isSymbolicLink(), `Existing ${filename} must be a regular file.`);
  assert.ok(content.equals(await readFile(path)), `Existing ${filename} differs; choose a new output directory.`);
  reused.add(filename);
}
await mkdir(output, {recursive: true});
for (const [filename, content] of outputs) {
  if (!reused.has(filename)) await writeFile(join(output, filename), content, {flag: 'wx'});
}
console.log(JSON.stringify({output, projectBytes: project.length, publicationBytes: publication.blob.size,
  inputSha256: checksum, records: summary.recordCount, designations: summary.designationCount,
  municipalities: summary.municipalityCount, publicationRights: 'unreviewed', networkRequests: 0,
  files: [...outputs].map(([filename, content]) => ({filename, bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'), reused: reused.has(filename)}))}));
