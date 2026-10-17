import assert from 'node:assert/strict';
import {it} from 'node:test';
import {zipSync, unzipSync, strToU8} from 'fflate';
import {createPublicationSourceArchive, readPublicationSourceArchive} from '../src/lib/publicationSourceArchive.js';

const manifestPath = 'opengeo-source-project.json';
const id = '11111111-1111-4111-8111-111111111111';
const file = (relativePath = 'index.md', bytes = '# Source\n', contentType = 'text/markdown') => ({relativePath, blob: new Blob([bytes], {type: contentType}), contentType});
const pack = entries => new Blob([zipSync(entries, {level: 0, mtime: new Date(1980, 0, 1)})], {type: 'application/zip'});
async function fixture() {
  const exported = await createPublicationSourceArchive({files: [file()], metadata: {title: 'Research', entryPath: 'index.md', lockfilePath: null}});
  return {bytes: new Uint8Array(await exported.blob.arrayBuffer()), entries: unzipSync(new Uint8Array(await exported.blob.arrayBuffer())), manifest: exported.manifest};
}
function rewrite(entries, change) {
  const updated = {...entries}, manifest = JSON.parse(new TextDecoder().decode(updated[manifestPath]));
  change(manifest, updated); updated[manifestPath] = strToU8(JSON.stringify(manifest));
  return pack(updated);
}
function headers(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), end = bytes.length - 22;
  let central = view.getUint32(end + 16, true);
  const entries = [];
  for (let index = 0; index < view.getUint16(end + 10, true); index++) {
    const length = view.getUint16(central + 28, true), local = view.getUint32(central + 42, true);
    entries.push({central, local, length, data: local + 30 + length}); central += 46 + length;
  }
  return {view, end, entries};
}

it('reimports exact source bytes and complete inert manifest context without fetching or rebinding dependencies', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Source-project import must not fetch dependencies'));
  const original = [file('src/index.md', '\uFEFF# Exact source\r\n'), file('src/plot.png', new Uint8Array([137, 80, 78, 71, 0, 255]), 'image/png'),
    file('package-lock.json', '{"lockfileVersion":3}\n', 'application/json')];
  const pin = {attachmentId: id, path: 'src/data.csv', datasetVersionId: id, checksumSha256: 'a'.repeat(64)};
  const exported = await createPublicationSourceArchive({files: original,
    metadata: {title: 'Research', entryPath: 'src/index.md', lockfilePath: 'package-lock.json', rightsStatus: 'approved', projectId: 'original-workspace'},
    baseRevision: {id, manifest: {dataAttachments: [pin]}},
    dataAttachments: [{attachmentId: id, relativePath: 'src/data.csv'}],
    artifactReferences: {revision: 3, references: [{path: 'src/map.html', artifact_id: id, mode: 'current', version: null}]}});
  const imported = await readPublicationSourceArchive(exported.blob);
  assert.deepEqual(imported.manifest, exported.manifest);
  assert.deepEqual(Object.keys(imported).sort(), ['files', 'manifest'], 'No authority or automatically applied settings are returned');
  assert.deepEqual(imported.files.map(item => item.relativePath), ['package-lock.json', 'src/index.md', 'src/plot.png']);
  for (const restored of imported.files) {
    const saved = original.find(item => item.relativePath === restored.relativePath);
    assert.equal(restored.contentType, saved.contentType);
    assert.deepEqual(new Uint8Array(await restored.blob.arrayBuffer()), new Uint8Array(await saved.blob.arrayBuffer()));
  }
  assert.equal(imported.manifest.dataAttachments[0].bundled, false);
  assert.equal(imported.manifest.artifactReferences.bundled, false);
  assert.equal(imported.manifest.baseRevision.purpose, 'original-context-only');
});

it('rejects corrupt CRC, inconsistent local headers, lying sizes, overlaps and trailing ZIP records', async () => {
  const {bytes} = await fixture();
  const mutations = [
    (copy, h) => {copy[h.entries[0].data] ^= 1;},
    (copy, h) => {copy[h.entries[0].local + 30] ^= 1;},
    (_copy, h) => h.view.setUint32(h.entries[0].local + 18, 1, true),
    (_copy, h) => {for (const offset of [h.entries[0].central + 20, h.entries[0].central + 24, h.entries[0].local + 18, h.entries[0].local + 22]) h.view.setUint32(offset, 1, true);},
    (_copy, h) => h.view.setUint32(h.entries[1].central + 42, 0, true),
    (_copy, h) => h.view.setUint32(h.end + 16, 0xffffffff, true),
    (_copy, h) => h.view.setUint32(h.entries[0].central, 0, true),
    (_copy, h) => h.view.setUint32(h.entries[0].local, 0, true)
  ];
  for (const [index, mutate] of mutations.entries()) {
    const copy = bytes.slice(); mutate(copy, headers(copy));
    await assert.rejects(readPublicationSourceArchive(new Blob([copy])), /OpenGeo Studio source-project export/, `corrupt variant ${index}`);
  }
  await assert.rejects(readPublicationSourceArchive(new Blob([bytes, new Uint8Array([0])])), /end record/);
  await assert.rejects(readPublicationSourceArchive(new Blob([bytes.subarray(0, -1)])), /end record/);
});

it('rejects compression, ZIP64, encryption, descriptors, attributes, extras, comments and multiple disks', async () => {
  const {bytes, entries} = await fixture();
  await assert.rejects(readPublicationSourceArchive(new Blob([zipSync(entries, {level: 6})])), /only stored/);
  for (const [field, value] of [[8, 1], [8, 8], [10, 8], [30, 1], [32, 1], [34, 1], [36, 1], [4, 0x0314], [6, 45]]) {
    const copy = bytes.slice(), h = headers(copy);
    h.view.setUint16(h.entries[0].central + field, value, true);
    await assert.rejects(readPublicationSourceArchive(new Blob([copy])), /only stored/, `central field ${field}`);
  }
  const symlink = bytes.slice(), h = headers(symlink);
  h.view.setUint32(h.entries[0].central + 38, 0o120777 << 16, true);
  await assert.rejects(readPublicationSourceArchive(new Blob([symlink])), /only stored/);
  for (const field of [4, 6, 20]) {
    const copy = bytes.slice(), h = headers(copy); h.view.setUint16(h.end + field, 1, true);
    await assert.rejects(readPublicationSourceArchive(new Blob([copy])), /directory bounds|comments/);
  }
});

it('rejects traversal, secret and generated paths, duplicate names, case collisions and file-prefix collisions', async () => {
  const {entries} = await fixture();
  for (const name of ['source/../index.md', 'source/a\\index.md', '/source/index.md', 'source/credentials.json', 'source/dist/index.md',
    'source/folder/', 'unexpected.txt', 'source/INDEX.md', 'source/index.md/child.txt']) {
    await assert.rejects(readPublicationSourceArchive(pack({...entries, [name]: strToU8('bad')})), /invalid|unsupported|unexpected|duplicate|manifest|collide/i, name);
  }
  const duplicate = new Uint8Array(await pack({...entries, 'source/other.md': strToU8('other')}).arrayBuffer());
  const h = headers(duplicate), entry = h.entries.at(-1);
  assert.equal(entry.length, 'source/index.md'.length);
  duplicate.set(strToU8('source/index.md'), entry.local + 30); duplicate.set(strToU8('source/index.md'), entry.central + 46);
  await assert.rejects(readPublicationSourceArchive(new Blob([duplicate])), /duplicate/);
  await assert.rejects(readPublicationSourceArchive(rewrite(entries, (manifest, entries) => {
    const child = strToU8('child'); entries['source/index.md/child.txt'] = child;
    manifest.files.push({path: 'index.md/child.txt', archivePath: 'source/index.md/child.txt', contentType: 'text/plain', sizeBytes: child.length, checksumSha256: 'a'.repeat(64)});
  })), /collide/);
});

it('requires an exact supported manifest, complete file set, matching media/size and every SHA-256', async () => {
  const {entries} = await fixture();
  const mutations = [
    manifest => {manifest.schemaVersion = 'unknown';}, manifest => {manifest.content = 'saved-revision';},
    manifest => {manifest.extra = true;}, manifest => {manifest.files = [];},
    manifest => {manifest.files[0].sizeBytes++;}, manifest => {manifest.files[0].contentType = 'image/png';},
    manifest => {manifest.files[0].archivePath = 'README.txt';}, manifest => {manifest.files[0].checksumSha256 = '0'.repeat(64);},
    manifest => {manifest.files[0].extra = true;}, manifest => {manifest.files[0].path = '../index.md';},
    (_manifest, entries) => {delete entries['source/index.md'];},
    (_manifest, entries) => {delete entries['README.txt'];},
    (_manifest, entries) => {entries['source/extra.md'] = strToU8('extra');}
  ];
  for (const [index, mutate] of mutations.entries()) {
    await assert.rejects(readPublicationSourceArchive(rewrite(entries, mutate)), /OpenGeo Studio source-project export|content type/, `manifest variant ${index}`);
  }
  await assert.rejects(readPublicationSourceArchive(pack({...entries, [manifestPath]: new Uint8Array([255])})), /UTF-8 JSON/);
});

it('validates settings and bounded inert reference context without trusting archived rights or workspace identities', async () => {
  const {entries} = await fixture();
  for (const mutate of [
    manifest => {manifest.metadata.title = 123;}, manifest => {manifest.metadata.title = 'x'.repeat(301);},
    manifest => {manifest.metadata.entryPath = 123;}, manifest => {manifest.metadata.lockfilePath = 'x'.repeat(513);},
    manifest => {manifest.metadata.notes = 'x'.repeat(256 * 1024);},
    manifest => {manifest.baseRevision = {purpose: 'authority', revision: {}};},
    manifest => {manifest.artifactReferences = {bundled: true, references: {}};},
    manifest => {manifest.dataAttachments = [{attachmentId: id, relativePath: 'data.csv', bundled: true, pinDetails: 'unknown', pin: null}];},
    manifest => {manifest.metadata.provenance = ['https://example.test/?%74oken=private'];},
    manifest => {manifest.baseRevision = {purpose: 'original-context-only', revision: {url: 'https://user:secret@example.test/'}};}
  ]) await assert.rejects(readPublicationSourceArchive(rewrite(entries, mutate)), /OpenGeo Studio source-project export|256 KiB|Credential-bearing/);
  const minimal = await readPublicationSourceArchive(rewrite(entries, manifest => {
    manifest.metadata = {rightsStatus: 'approved', projectId: 'untrusted', custom: {retained: true}, entryPath: '../old-draft.md', lockfilePath: 'missing.json'};
  }));
  assert.deepEqual(minimal.manifest.metadata, {rightsStatus: 'approved', projectId: 'untrusted', custom: {retained: true}, entryPath: '../old-draft.md', lockfilePath: 'missing.json'});
  assert.equal(minimal.rightsStatus, undefined);
  assert.equal(minimal.projectId, undefined);
});

it('bounds archive, sidecars, source bytes, entry counts and combined external bindings', async () => {
  const {entries} = await fixture();
  await assert.rejects(readPublicationSourceArchive(new Blob([new Uint8Array(18 * 1024 * 1024 + 1)])), /18 MiB/);
  await assert.rejects(readPublicationSourceArchive(pack({...entries, 'README.txt': new Uint8Array(16_385)})), /sidecar/);
  await assert.rejects(readPublicationSourceArchive(pack({...entries, [manifestPath]: new Uint8Array(1024 * 1024 + 1)})), /sidecar/);
  await assert.rejects(readPublicationSourceArchive(pack({...entries, 'source/index.md': new Uint8Array(4_194_305)})), /4 MiB/);
  const large = {...entries};
  for (let index = 0; index < 4; index++) large[`source/large${index}.txt`] = new Uint8Array(4_194_304);
  await assert.rejects(readPublicationSourceArchive(pack(large)), /16 MiB/);
  const many = {...entries};
  for (let index = 0; index < 128; index++) many[`source/file${index}.txt`] = strToU8('x');
  await assert.rejects(readPublicationSourceArchive(pack(many)), /entry count/);
  const full = await createPublicationSourceArchive({files: Array.from({length: 128}, (_, index) => file(`file${index}.md`, 'x'))});
  const fullEntries = unzipSync(new Uint8Array(await full.blob.arrayBuffer()));
  await assert.rejects(readPublicationSourceArchive(rewrite(fullEntries, manifest => {
    manifest.dataAttachments = [{attachmentId: id, relativePath: 'external.csv', bundled: false, pinDetails: 'unknown', pin: null}];
  })), /128/);
});

it('applies the raw manifest limit to exports as well as imports', async () => {
  let nested = Array.from({length: 10000}, () => 'x');
  for (let depth = 0; depth < 64; depth++) nested = {nested};
  await assert.rejects(createPublicationSourceArchive({files: [file()], metadata: {nested}}), /manifest exceeds 1 MiB/);
  const metadata = {title: '', entryPath: 'missing.md', lockfilePath: 'old-lock.json'};
  const draft = await createPublicationSourceArchive({files: [file()], metadata});
  assert.deepEqual((await readPublicationSourceArchive(draft.blob)).manifest.metadata, metadata,
    'Temporary source settings remain exportable and return only as review context');
});
