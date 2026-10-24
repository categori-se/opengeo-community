import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {it} from 'node:test';
import {fileURLToPath} from 'node:url';
import {zipSync, unzipSync, strFromU8, strToU8} from 'fflate';
import {createPublicationSourceArchive, createPublicationSourceBackup, readPublicationSourceArchive,
  choosePublicationBackupContextPath} from '../src/lib/publicationSourceArchive.js';
import {readPublicationSourceBackupInputs, readPublicFileDependency} from '../src/lib/publicationSourceBackupInputs.js';
import {validateStaticPublicationTree, validateJupyterPublicationTree} from '../src/lib/apiClient.js';

const attachmentId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const file = (relativePath = 'index.html', bytes = '<notebook></notebook>') => ({relativePath, blob: new Blob([bytes])});
const exportSource = options => createPublicationSourceArchive({files: [file()], metadata: {title: 'Research'}, ...options});
const unzip = async blob => unzipSync(new Uint8Array(await blob.arrayBuffer()));

it('keeps the unminified public source-package bundle within its local-only boundary', async () => {
  const {build} = await import('esbuild');
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/lib/publicationSourceArchive.js', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', write: false, treeShaking: true, external: ['fflate']
  });
  const code = result.outputFiles[0].text;
  assert.ok(Buffer.byteLength(code) <= 65536, 'Public source-package bundle exceeds 64 KiB');
  assert.doesNotMatch(code, /class OpenGeoApiClient|class CognitoBrowserAuth|\/oauth2\/token|\bfetch\(/);
});

it('exports exact BOM, CRLF, binary and nested source bytes with matching manifest checksums', async () => {
  const text = new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8('<notebook data-original="yes">\r\n</notebook>\r\n')]);
  const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0x80, 0x0d, 0x0a]);
  const metadata = {title: 'Research', entryPath: 'notebooks/index.html', rights: {status: 'unknown', evidence: [null, 'Retained']}};
  const {blob, manifest} = await exportSource({metadata, files: [file('notebooks/index.html', text), file('notebooks/images/plot.png', binary)]});
  assert.equal(blob.type, 'application/zip');
  const entries = await unzip(blob);
  assert.deepEqual(entries['source/notebooks/index.html'], text);
  assert.deepEqual(entries['source/notebooks/images/plot.png'], binary);
  assert.deepEqual(JSON.parse(strFromU8(entries['opengeo-source-project.json'])), manifest);
  assert.equal(manifest.schemaVersion, 'opengeo.publication-source-export.1.0.0');
  assert.equal(manifest.content, 'working-draft');
  assert.deepEqual(manifest.metadata, metadata);
  assert.equal(manifest.baseRevision, null);
  for (const entry of manifest.files) {
    assert.equal(entry.archivePath, 'source/' + entry.path);
    assert.equal(entry.sizeBytes, entries[entry.archivePath].byteLength);
    assert.equal(entry.checksumSha256, createHash('sha256').update(entries[entry.archivePath]).digest('hex'));
  }
  assert.deepEqual(manifest.files.map(entry => entry.contentType), ['image/png', 'text/html']);
  assert.match(strFromU8(entries['README.txt']), /extract source\/.*select that folder/s);
  assert.match(strFromU8(entries['README.txt']), /not a complete offline, workspace, or account backup/);
});

it('retains exact external pins as unbundled context without fetching or inventing draft pins', async t => {
  t.mock.method(globalThis, 'fetch', () => {assert.fail('Source export must not fetch references');});
  const pin = {path: 'data/known.csv', attachmentId, datasetId: otherId, datasetVersionId: otherId,
    dataObjectId: otherId, s3VersionId: 'original-object-version', checksumSha256: 'a'.repeat(64), sizeBytes: 500, contentType: 'text/csv'};
  const baseRevision = {id: otherId, manifest: {schemaVersion: 'opengeo.observable-source-revision.2.0.0', dataAttachments: [pin]}};
  const artifactReferences = {revision: 3, references: [{projectId: otherId, artifactId: attachmentId, checksumSha256: 'b'.repeat(64)}]};
  const dataAttachments = [{attachmentId, relativePath: 'data/known.csv'},
    {attachmentId, relativePath: 'data/moved.csv'}, {attachmentId: otherId, relativePath: 'data/new.csv'}];
  const {blob, manifest} = await exportSource({baseRevision, artifactReferences, dataAttachments});
  assert.deepEqual(manifest.baseRevision, {purpose: 'original-context-only', revision: baseRevision});
  assert.deepEqual(manifest.artifactReferences, {bundled: false, references: artifactReferences});
  assert.deepEqual(manifest.dataAttachments[0], {...dataAttachments[0], bundled: false, pinDetails: 'retained-base-revision', pin});
  for (const binding of manifest.dataAttachments.slice(1)) {
    assert.equal(binding.bundled, false); assert.equal(binding.pinDetails, 'unknown'); assert.equal(binding.pin, null);
  }
  assert.deepEqual(Object.keys(await unzip(blob)).sort(), ['README.txt', 'opengeo-source-project.json', 'source/index.html']);
  assert.deepEqual(baseRevision.manifest.dataAttachments, [pin], 'Caller metadata is not mutated');
});

it('produces identical ZIP bytes for the same input without rewriting credential-like source content', async () => {
  const options = {files: [file('index.html', '<a href="https://example.test/?token=source-text">retained</a>')]};
  const first = await exportSource(options), second = await exportSource(options);
  assert.deepEqual(new Uint8Array(await first.blob.arrayBuffer()), new Uint8Array(await second.blob.arrayBuffer()));
  assert.equal(strFromU8((await unzip(first.blob))['source/index.html']), await options.files[0].blob.text());
});

it('rejects unsafe, case-colliding and file-prefix paths before creating an archive', async () => {
  for (const path of ['../index.html', '/index.html', 'a\\index.html', 'a/../index.html', 'node_modules/index.html', 'credentials.json']) {
    await assert.rejects(exportSource({files: [file(path)]}), /invalid/i, path);
  }
  await assert.rejects(exportSource({files: [file('index.html'), file('INDEX.html')]}), /unique/);
  await assert.rejects(exportSource({files: [file('data.json'), file('data.json/child.txt')]}), /collide/);
  await assert.rejects(exportSource({files: [file('data.csv')], dataAttachments: [{attachmentId, relativePath: 'DATA.csv'}]}), /collide/);
  await assert.rejects(exportSource({dataAttachments: [{attachmentId, relativePath: '../data.csv'}]}), /invalid/);
});

it('enforces existing file, tree and combined binding limits', async () => {
  await assert.rejects(exportSource({files: [file('index.html', '')]}), /non-empty/);
  await assert.rejects(exportSource({files: [file('index.html', new Uint8Array(4 * 1024 * 1024 + 1))]}), /4 MiB/);
  const chunk = new Uint8Array(4 * 1024 * 1024);
  await assert.rejects(exportSource({files: Array.from({length: 5}, (_, index) => file(`${index}.txt`, chunk))}), /16 MiB/);
  await assert.rejects(exportSource({files: Array.from({length: 129}, (_, index) => file(`${index}.txt`, 'x'))}), /128/);
  await assert.rejects(exportSource({files: Array.from({length: 128}, (_, index) => file(`${index}.txt`, 'x')),
    dataAttachments: [{attachmentId, relativePath: 'external.csv'}]}), /128/);
});

it('fails closed for oversized or non-JSON metadata and nested credential URLs', async () => {
  await assert.rejects(exportSource({metadata: {notes: 'x'.repeat(256 * 1024)}}), /256 KiB/);
  await assert.rejects(exportSource({metadata: {notes: 'x'.repeat(128 * 1024)}, baseRevision: {notes: 'x'.repeat(128 * 1024)}}), /256 KiB/);
  await assert.rejects(exportSource({metadata: {value: NaN}}), /JSON values/);
  await assert.rejects(exportSource({metadata: {value: new Blob(['hidden'])}}), /JSON values/);
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(exportSource({metadata: cyclic}), /circular/i);
  for (const url of ['https://example.test/file?X-Amz-Signature=private', 'https://example.test/?%74oken=private',
    'https://user:password@example.test/file', 'https://example.test/file#cap=private']) {
    await assert.rejects(exportSource({baseRevision: {manifest: {nested: [url]}}}), /credentials|Credential-bearing/, url);
  }
});

const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const publicTiffBytes = new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]);
const publicTiffRecord = () => ({available: true, kind: 'referenced-public-file', custody: 'referenced',
  url: 'https://data.example.org/exact.tiff', contentType: 'image/tiff', sizeBytes: publicTiffBytes.length,
  checksumSha256: checksum(publicTiffBytes)});

it('reads public TIFF dependencies directly with anonymous bounded transport and exact checksum', async () => {
  let calls = 0;
  const record = publicTiffRecord();
  const blob = await readPublicFileDependency(record, async (url, options) => {
    calls++;
    assert.equal(url, record.url);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.method, 'GET');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(publicTiffBytes, {headers: {'content-length': String(publicTiffBytes.length)}});
  }, () => true);
  assert.equal(calls, 1);
  assert.equal(blob.type, 'image/tiff');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), publicTiffBytes);
});

it('rejects unsafe public TIFF metadata before fetching and rejects changed or oversized streamed bytes', async () => {
  const record = publicTiffRecord(), neverFetch = () => assert.fail('Invalid reference must not fetch');
  for (const changes of [{available: false}, {custody: 'hosted'}, {kind: 'archive'}, {sizeBytes: 67_108_865},
    {contentType: 'text/plain'}, {url: 'https://data.example.org/exact.tiff?token=secret'},
    {url: 'https://user:secret@data.example.org/exact.tiff'}, {url: 'http://data.example.org/exact.tiff'},
    {url: 'https://127.0.0.1/exact.tiff'}, {checksumSha256: 'unknown'}]) {
    await assert.rejects(readPublicFileDependency({...record, ...changes}, neverFetch, () => true), Error);
  }
  await assert.rejects(readPublicFileDependency(record, neverFetch, () => true, undefined, record.sizeBytes - 1), /unavailable|64 MiB/);
  await assert.rejects(readPublicFileDependency({...record, checksumSha256: '0'.repeat(64)},
    async () => new Response(publicTiffBytes), () => true), /checksum or size changed/);
  let cancelled = false;
  await assert.rejects(readPublicFileDependency(record, async () => new Response(new ReadableStream({
    start(controller) {controller.enqueue(publicTiffBytes); controller.enqueue(new Uint8Array([0]));},
    cancel() {cancelled = true;}
  })), () => true), /exceeds its declared size/);
  assert.equal(cancelled, true);
});

it('reports public TIFF CORS and provider denial once without a relay or retry', async () => {
  for (const response of [() => {throw new TypeError('Failed to fetch');}, () => new Response(null, {status: 403})]) {
    let calls = 0;
    await assert.rejects(readPublicFileDependency(publicTiffRecord(), async () => {calls++; return response();},
      () => true), /provider.*anonymous browser access.*CORS/);
    assert.equal(calls, 1);
  }
});

function backupFixture() {
  const data = strToU8('name,value\r\nA,2\r\n'), artifact = strToU8('<!doctype html><h1>Retained compiled map</h1>');
  const dataPin = {path: 'src/data/survey.csv', attachmentId, datasetId: otherId, datasetVersionId: otherId,
    dataObjectId: otherId, s3VersionId: 'immutable-storage-version', checksumSha256: checksum(data), sizeBytes: data.length, contentType: 'text/csv'};
  const artifactPin = {artifactId: otherId, version: 7, outputObjectId: attachmentId, manifestChecksumSha256: 'a'.repeat(64),
    checksumSha256: checksum(artifact), sizeBytes: artifact.length, contentType: 'text/html'};
  return {files: [file('src/index.html', '\uFEFF<iframe src="maps/survey.html"></iframe>\r\n')],
    metadata: {title: 'Selected input backup', entryPath: 'src/index.html', rightsStatus: 'approved'},
    baseRevision: {id: attachmentId}, dataAttachments: [{attachmentId, relativePath: dataPin.path}],
    artifactReferences: {revision: 4, references: [{path: 'src/maps/survey.html', artifact_id: otherId, mode: 'current', version: null}]},
    dependencies: [{kind: 'data', relativePath: dataPin.path, pin: dataPin, blob: new Blob([data])},
      {kind: 'artifact', relativePath: 'src/maps/survey.html', pin: artifactPin, blob: new Blob([artifact])}]};
}
async function rewriteBackup(blob, mutate) {
  const entries = await unzip(blob), manifest = JSON.parse(strFromU8(entries['opengeo-source-project.json']));
  mutate(manifest, entries);
  entries['opengeo-source-project.json'] = strToU8(JSON.stringify(manifest));
  return new Blob([zipSync(entries, {level: 0, mtime: new Date(1980, 0, 1)})], {type: 'application/zip'});
}

it('backs up every exact source/data/Artifact input and restores persistent inert provenance without fetching or execution', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Complete input backup cannot fetch dependency URLs'));
  const options = backupFixture(), exported = await createPublicationSourceBackup(options);
  const second = await createPublicationSourceBackup({...options, dependencies: [...options.dependencies].reverse()});
  assert.deepEqual(new Uint8Array(await exported.blob.arrayBuffer()), new Uint8Array(await second.blob.arrayBuffer()));
  const restored = await readPublicationSourceArchive(exported.blob);
  assert.deepEqual(restored.manifest, exported.manifest);
  assert.equal(restored.manifest.schemaVersion, 'opengeo.publication-source-backup.1.0.0');
  assert.equal(restored.manifest.content, 'complete-input-tree');
  assert.equal(restored.manifest.contextPath, 'src/opengeo-source-backup-context.json');
  assert.deepEqual(restored.files.map(item => item.relativePath),
    ['src/data/survey.csv', 'src/index.html', 'src/maps/survey.html', 'src/opengeo-source-backup-context.json']);
  validateStaticPublicationTree(options.metadata.entryPath, null, restored.files);
  for (const input of [...options.files, ...options.dependencies]) {
    const output = restored.files.find(item => item.relativePath === input.relativePath);
    assert.deepEqual(new Uint8Array(await output.blob.arrayBuffer()), new Uint8Array(await input.blob.arrayBuffer()));
  }
  const contextFile = restored.files.find(item => item.relativePath === restored.manifest.contextPath);
  const context = JSON.parse(await contextFile.blob.text());
  assert.equal(context.grantsAuthority, false);
  assert.equal(context.rightsStatus, 'unreviewed');
  assert.equal(context.custody, 'explicit-restoration-copy');
  assert.equal(context.dependencyRights, 'unknown-not-inherited');
  assert.deepEqual(context.original.metadata, options.metadata);
  assert.deepEqual(context.original.baseRevision, {purpose: 'original-context-only', revision: options.baseRevision});
  assert.deepEqual(context.original.dependencies, exported.manifest.dependencies);
  assert.deepEqual(context.original.files.map(item => item.path), ['src/data/survey.csv', 'src/index.html', 'src/maps/survey.html']);
  assert.equal(restored.manifest.artifactReferences.bundled, true);
  assert.equal(restored.manifest.dataAttachments[0].pinDetails, 'frozen-backup');
  assert.equal(restored.rightsStatus, undefined);
  assert.equal(restored.projectId, undefined);
  assert.equal(restored.artifactReferences, undefined);
  // Context is an ordinary exact file in the returned tree, so the existing
  // source-only archive path retains it through another explicit round trip.
  const reexported = await createPublicationSourceArchive({files: restored.files});
  const reopened = await readPublicationSourceArchive(reexported.blob);
  assert.equal(await reopened.files.find(item => item.relativePath === contextFile.relativePath).blob.text(), await contextFile.blob.text());
  const notebook = await createPublicationSourceBackup({files: [file('books/reports/index.ipynb', '{"cells":[]}')],
    metadata: {entryPath: 'books/reports/index.ipynb'}, dependencies: [], artifactReferences: {revision: 0, references: []}});
  const notebookTree = await readPublicationSourceArchive(notebook.blob);
  assert.equal(notebookTree.manifest.contextPath, 'books/reports/opengeo-source-backup-context.json');
  validateJupyterPublicationTree('books/reports/index.ipynb', null, notebookTree.files);
});

it('requires complete materialized dependency coverage and immutable bytes/pins, including current and pinned editions', async () => {
  const options = backupFixture();
  for (const dependencies of [[], options.dependencies.slice(0, 1), [...options.dependencies, options.dependencies[0]],
    options.dependencies.map((item, index) => index ? {...item, blob: null} : item),
    options.dependencies.map((item, index) => index ? {...item, blob: new Blob(['changed bytes'])} : item),
    options.dependencies.map((item, index) => index ? {...item, pin: {...item.pin, version: null}} : item),
    options.dependencies.map((item, index) => index ? item : {...item, pin: {...item.pin, s3VersionId: 'null'}})]) {
    await assert.rejects(createPublicationSourceBackup({...options, dependencies}), /OpenGeo Studio source-project export/);
  }
  await assert.rejects(createPublicationSourceBackup({...options, artifactReferences: null}), /inventory/);
  const pinned = {...options, artifactReferences: {revision: 4, references: [{...options.artifactReferences.references[0], mode: 'pinned', version: 3}]}};
  await assert.rejects(createPublicationSourceBackup(pinned), /frozen edition/);
  pinned.artifactReferences.references[0].version = 7;
  assert.equal((await createPublicationSourceBackup(pinned)).manifest.dependencies[1].pin.version, 7);
  const empty = await createPublicationSourceBackup({files: options.files, dependencies: [], artifactReferences: {revision: 0, references: []}});
  assert.equal((await readPublicationSourceArchive(empty.blob)).files.length, 2);
});

it('backs up a restored complete input tree again without replacing earlier provenance or granting authority', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Repeat backup cannot fetch undeclared dependencies'));
  const options = backupFixture(), first = await createPublicationSourceBackup(options);
  const restored = await readPublicationSourceArchive(first.blob);
  const adapter = {readPublicationArtifactBackupInputs: async () => ({projectId: attachmentId,
    sourceProjectId: otherId, referenceRevision: 0, pins: []})};
  const artifactReferences = {revision: 0, references: []};
  const dependencies = await readPublicationSourceBackupInputs({adapter, projectId: attachmentId,
    sourceProjectId: otherId, files: restored.files, entryPath: options.metadata.entryPath,
    dataAttachments: [], artifactReferences});
  const second = await createPublicationSourceBackup({files: restored.files,
    metadata: {...options.metadata, rightsStatus: 'unreviewed'}, dataAttachments: [], artifactReferences, dependencies});
  assert.equal(second.manifest.contextPath, 'src/opengeo-source-backup-context-2.json');
  const reopened = await readPublicationSourceArchive(second.blob);
  for (const original of restored.files) {
    const kept = reopened.files.find(item => item.relativePath === original.relativePath);
    assert.deepEqual(new Uint8Array(await kept.blob.arrayBuffer()), new Uint8Array(await original.blob.arrayBuffer()));
  }
  const fresh = JSON.parse(await reopened.files.find(item => item.relativePath === second.manifest.contextPath).blob.text());
  assert.equal(fresh.contextPath, second.manifest.contextPath);
  assert.equal(fresh.rightsStatus, 'unreviewed');
  assert.equal(fresh.grantsAuthority, false);
  assert.equal(fresh.dependencyRights, 'unknown-not-inherited');
  assert.ok(fresh.original.files.some(item => item.path === first.manifest.contextPath));
  assert.equal(reopened.rightsStatus, undefined);
  assert.equal(reopened.projectId, undefined);
  assert.equal(choosePublicationBackupContextPath('src/index.html', reopened.files.map(item => item.relativePath)),
    'src/opengeo-source-backup-context-3.json');
  assert.equal(choosePublicationBackupContextPath('src/index.html', ['SRC/OPENGEO-SOURCE-BACKUP-CONTEXT.JSON',
    'src/opengeo-source-backup-context-3.json/child.txt']), 'src/opengeo-source-backup-context-2.json');
  assert.throws(() => choosePublicationBackupContextPath('src.json/index.html', ['src.json']), /collides/);
});

it('rejects dependency/source collisions before reading any bytes and counts the generated sidecar in existing caps', async t => {
  const options = backupFixture();
  for (const input of [...options.files, ...options.dependencies]) t.mock.method(input.blob, 'arrayBuffer', () => assert.fail('Collisions must fail before reading bytes'));
  for (const files of [file('src/data/survey.csv', 'collision'), file('SRC/maps/survey.html', 'collision'),
    file('src/maps/survey.html/child.txt', 'collision')]) {
    await assert.rejects(createPublicationSourceBackup({...options, files: [...options.files, files]}), /collide|unique/i);
  }
  await assert.rejects(createPublicationSourceBackup({files: Array.from({length: 128}, (_, index) => file(`${index}.txt`, 'x')),
    dependencies: [], artifactReferences: {revision: 0, references: []}}), /128/);
  const chunk = new Uint8Array(4 * 1024 * 1024);
  await assert.rejects(createPublicationSourceBackup({files: Array.from({length: 4}, (_, index) => file(`${index}.txt`, chunk)),
    dependencies: [], artifactReferences: {revision: 0, references: []}}), /16 MiB/);
  await assert.rejects(createPublicationSourceBackup({...options, metadata: {notes: 'x'.repeat(256 * 1024)}}), /256 KiB/);
});

it('rejects incomplete/tampered backup provenance, aliases, frozen facts and generated context before returning any restored files', async () => {
  const {blob} = await createPublicationSourceBackup(backupFixture());
  for (const mutate of [
    manifest => {manifest.dependencies.pop();},
    manifest => {manifest.dependencies[0].relativePath = 'src/other.csv';},
    manifest => {manifest.dependencies[0].pin.checksumSha256 = '0'.repeat(64);},
    manifest => {manifest.dependencies[1].pin.version = 0;},
    manifest => {manifest.dependencies[1].pin.extra = 'unreviewed';},
    manifest => {manifest.dataAttachments[0].pin.dataObjectId = attachmentId;},
    manifest => {manifest.metadata.title = 'Tampered original metadata';},
    manifest => {manifest.artifactReferences.bundled = false;},
    manifest => {manifest.artifactReferences = null;},
    manifest => {manifest.contextPath = 'opengeo-source-backup-context.json';},
    (manifest, entries) => {delete entries['source/' + manifest.contextPath];
      manifest.files = manifest.files.filter(item => item.path !== manifest.contextPath);},
    (manifest, entries) => {const path = 'source/' + manifest.contextPath; entries[path] = strToU8('{}');
      Object.assign(manifest.files.find(item => item.archivePath === path), {sizeBytes: 2, checksumSha256: checksum(entries[path])});}
  ]) await assert.rejects(readPublicationSourceArchive(await rewriteBackup(blob, mutate)), TypeError);
});

it('refuses credential-bearing backup metadata and frozen pins while retaining legacy v1 export semantics', async () => {
  const options = backupFixture();
  await assert.rejects(createPublicationSourceBackup({...options, metadata: {url: 'https://files.example/?X-Amz-Signature=secret'}}), /credentials/);
  await assert.rejects(createPublicationSourceBackup({...options, baseRevision: {url: 'https://user:secret@example.test/'}}), /Credential-bearing/);
  await assert.rejects(createPublicationSourceBackup({...options, dependencies: options.dependencies.map((item, index) =>
    index ? item : {...item, pin: {...item.pin, s3VersionId: 'https://files.example/#token=secret'}})}), /Credential-bearing/);
  const legacy = await createPublicationSourceArchive({files: options.files, dataAttachments: options.dataAttachments,
    artifactReferences: options.artifactReferences});
  assert.equal(legacy.manifest.schemaVersion, 'opengeo.publication-source-export.1.0.0');
  assert.equal(legacy.manifest.artifactReferences.bundled, false);
  assert.equal((await readPublicationSourceArchive(legacy.blob)).files.length, 1);
});
