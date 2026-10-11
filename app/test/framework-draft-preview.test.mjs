import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import {test} from 'node:test';
import {createFrameworkDraftPreview, FRAMEWORK_DRAFT_URL, FRAMEWORK_DRAFT_MAX_BYTES} from '../src/components/FrameworkDraftPreview.js';
import {frameworkDraftPreviewEnabled} from '../src/lib/publicationDrafts.js';
import {restoreFrameworkStandaloneFiles} from '../scripts/build-framework-preview.mjs';

// The compiler entry imports browser virtual modules. Evaluate only its exported
// budget/provenance functions here; the existing browser fixture exercises output.
const compilerSource = await readFile(new URL('../scripts/framework-preview.mjs', import.meta.url), 'utf8');
const helpers = new Set(['FRAMEWORK_STANDALONE_DEFAULT_BYTES', 'FRAMEWORK_STANDALONE_ARCHIVE_BYTES',
  'frameworkBase64Size', 'frameworkStandaloneLimit', 'frameworkStandaloneProvenance']);
const declarations = parse(compilerSource, {ecmaVersion: 'latest', sourceType: 'module'}).body
  .filter(node => node.type === 'ExportNamedDeclaration' && node.declaration
    && helpers.has(node.declaration.id?.name ?? node.declaration.declarations?.[0]?.id?.name))
  .map(node => compilerSource.slice(node.declaration.start, node.declaration.end)).join('\n');
const standaloneHelpers = vm.runInNewContext(`${declarations}; ({frameworkBase64Size,frameworkStandaloneLimit,frameworkStandaloneProvenance})`, {URL});

test('standalone budget preserves 32 MiB and admits the original TIFF only with explicit 96 MiB consent', () => {
  const {frameworkBase64Size, frameworkStandaloneLimit} = standaloneHelpers;
  const encodedBytes = frameworkBase64Size(64_912_721);
  assert.equal(encodedBytes, 86_550_296);
  assert.equal(frameworkStandaloneLimit(), FRAMEWORK_DRAFT_MAX_BYTES);
  assert(encodedBytes > frameworkStandaloneLimit());
  assert.equal(frameworkStandaloneLimit('archive-96m', 'allow-up-to-96-mib-output'), 100_663_296);
  assert.equal(100_663_296 - encodedBytes, 14_113_000, 'Runtime and page count against the same single HTML limit');
  for (const [profile, consent] of [['archive-96m', null], ['default-32m', 'allow-up-to-96-mib-output'], ['unlimited', null]]) {
    assert.throws(() => frameworkStandaloneLimit(profile, consent), /acknowledge/);
  }
  assert.throws(() => frameworkBase64Size(-1), /Invalid file size/);
});

test('standalone provenance retains exact known pins without copying authorization or download credentials', () => {
  const {frameworkStandaloneProvenance} = standaloneHelpers;
  const checksum = 'a'.repeat(64), facts = {path: 'data/a.tif', sizeBytes: 4, checksumSha256: checksum, contentType: 'image/tiff'};
  const pins = {attachmentId: '00000000-0000-4000-8000-000000000001', datasetVersionId: '00000000-0000-4000-8000-000000000002',
    sizeBytes: 4, checksumSha256: checksum, contentType: 'image/tiff', license: 'CC-BY-4.0', attribution: 'Source agency',
    canPublish: true, downloadUrl: 'https://private.invalid/?X-Amz-Signature=secret', token: 'private'};
  const result = frameworkStandaloneProvenance(pins, facts);
  assert.equal(result.attachmentId, pins.attachmentId); assert.equal(result.datasetVersionId, pins.datasetVersionId);
  assert.equal(result.license, 'CC-BY-4.0'); assert.equal(result.attribution, 'Source agency');
  assert.equal(result.downloadUrl, undefined); assert.equal(result.token, undefined); assert.equal(result.canPublish, undefined);
  assert.throws(() => frameworkStandaloneProvenance({...pins, sizeBytes: 5}, facts), /registered file changed/);
  assert.throws(() => frameworkStandaloneProvenance({...pins, checksumSha256: 'b'.repeat(64)}, facts), /registered file changed/);
  assert.throws(() => frameworkStandaloneProvenance({...pins, attribution: 'https://source.invalid/?X-Amz-Signature=secret'}, facts), /credential-free/);
  assert.throws(() => frameworkStandaloneProvenance({...pins, attribution: 'https://user:secret@source.invalid/'}, facts), /credential-free/);
  assert.throws(() => frameworkStandaloneProvenance({...pins, license: 'https://source.invalid/?token=secret'}, facts), /credential-free/);
});

function standaloneFileFixture(bytes = Uint8Array.from([1, 3, 5, 9])) {
  const info = {name: 'https://studio-preview.invalid/tiny.tif', path: '/attachment/0', mimeType: 'image/tiff', size: bytes.length,
    payloadId: 'opengeo-framework-file-0', checksumSha256: createHash('sha256').update(bytes).digest('hex')};
  const node = {tagName: 'SCRIPT', textContent: Buffer.from(bytes).toString('base64'), getAttribute: () => 'application/octet-stream'};
  return {info, node, config: {mode: 'standalone', outputProfile: 'default-32m', sizeAcknowledgment: null, files: [info]},
    document: {getElementById: id => id === info.payloadId ? node : null}};
}
test('standalone restores original file bytes before runtime registration and rejects tampering', async () => {
  const f = standaloneFileFixture();
  const restored = await restoreFrameworkStandaloneFiles(f.config, f.document);
  assert.equal(restored.length, 1); assert.equal(restored[0].path, '/attachment/0'); assert.equal(restored[0].blob.type, 'image/tiff');
  assert.deepEqual(Array.from(new Uint8Array(await restored[0].blob.arrayBuffer())), [1, 3, 5, 9]);
  f.node.textContent = Buffer.from([1, 3, 5, 8]).toString('base64');
  await assert.rejects(restoreFrameworkStandaloneFiles(f.config, f.document), /checksum changed/);
  f.node.textContent = 'AQ==';
  await assert.rejects(restoreFrameworkStandaloneFiles(f.config, f.document), /size or encoding changed/);
});
test('standalone rejects invalid mode, unacknowledged sizes and oversized file inventories without reading payloads', async () => {
  const f = standaloneFileFixture(), neverRead = {getElementById() {throw Error('Payload must not be read');}};
  for (const mutation of [{mode: 'preview'}, {outputProfile: 'archive-96m'}, {outputProfile: 'unlimited'}, {files: Array(129).fill(f.info)},
    {files: [{...f.info, size: 64 * 1024 * 1024 + 1}]}]) {
    await assert.rejects(restoreFrameworkStandaloneFiles({...f.config, ...mutation}, neverRead), /Invalid standalone/);
  }
  await assert.rejects(restoreFrameworkStandaloneFiles({...f.config, files: [{...f.info, payloadId: 'other'}]}, neverRead), /inventory/);
});

class Port {
  messages = []; closed = false;
  postMessage(value) {this.messages.push(value);}
  close() {this.closed = true;}
  emit(data) {this.onmessage?.({data});}
}
class Frame extends EventTarget {
  isConnected = true; attributes = new Map(); sent = [];
  contentWindow = {postMessage: (...args) => this.sent.push(args)};
  setAttribute(key, value) {this.attributes.set(key, value);}
  removeAttribute(key) {this.attributes.delete(key);}
  set src(value) {this.setAttribute('src', value);}
}
function setup(t) {
  const channels = [];
  t.mock.method(globalThis, 'MessageChannel', function () {
    this.port1 = new Port(); this.port2 = new Port(); channels.push(this);
  });
  const frame = new Frame(), preview = createFrameworkDraftPreview(frame);
  t.after(() => preview.dispose());
  return {frame, preview, channels};
}
test('ordinary source builds retain draft preview through the exact opaque frame port', async t => {
  assert.equal(frameworkDraftPreviewEnabled, true);
  const {frame, preview, channels} = setup(t);
  const pending = preview.render('<h1>Private unsaved text</h1>');
  assert.equal(frame.attributes.get('src'), FRAMEWORK_DRAFT_URL);
  assert.equal(frame.attributes.get('sandbox'), 'allow-scripts');
  assert.equal(frame.referrerPolicy, 'no-referrer');
  assert.deepEqual(channels[0].port1.messages, []);
  frame.dispatchEvent(new Event('load'));
  assert.deepEqual(frame.sent[0], ['opengeo-framework-draft-connect', '*', [channels[0].port2]]);
  channels[0].port1.emit('ready'); channels[0].port1.emit('ready');
  assert.deepEqual(channels[0].port1.messages, [{kind:'render', revision:1, html:'<h1>Private unsaved text</h1>'}]);
  channels[0].port1.emit({kind:'rendered', revision:1}); await pending;
  assert(channels[0].port1.closed);
  preview.dispose(); assert.equal(frame.attributes.has('src'), false);
});
test('stale replies cannot send source or dispose a newer draft', async t => {
  const {frame, preview, channels} = setup(t);
  const old = preview.render('old'); frame.dispatchEvent(new Event('load'));
  const fresh = preview.render('new'); await old;
  channels[0].port1.emit('ready');
  assert.equal(frame.attributes.get('src'), FRAMEWORK_DRAFT_URL);
  assert.deepEqual(channels[0].port1.messages, []);
  frame.dispatchEvent(new Event('load')); channels[1].port1.emit('ready');
  channels[1].port1.emit({kind:'rendered',revision:1}); await fresh;
  assert.equal(channels[1].port1.messages[0].html, 'new');
});
test('oversize and stale source never load the shell', async t => {
  const {frame, preview, channels} = setup(t);
  await assert.rejects(preview.render('é'.repeat(FRAMEWORK_DRAFT_MAX_BYTES / 2 + 1)), /32 MiB/);
  await preview.render('stale', () => false);
  assert.equal(channels.length, 0); assert.equal(frame.attributes.has('src'), false);
});
test('a missing shell times out without leaving a live channel or frame', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const {frame, preview, channels} = setup(t);
  const pending = assert.rejects(preview.render('draft'), /did not start/);
  t.mock.timers.tick(12001); await pending;
  assert(channels[0].port1.closed); assert.equal(frame.attributes.has('src'), false);
});

const shell = await readFile(new URL('../../services/observable-preview/authorize/draft.html', import.meta.url), 'utf8');
function bootstrap() {
  const frame = new Frame(), parent = {}, listeners = new Map();
  const context = {parent, TextEncoder, document:{querySelector:()=>frame}, window:{addEventListener:(name,handler)=>listeners.set(name,handler)}};
  vm.runInNewContext(shell.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return {frame, parent, connect: event => listeners.get('message')(event)};
}
for (const origin of ['https://studio.opengeo.tools', 'https://demo.studio.opengeo.tools']) test(`bootstrap accepts ${origin} and rejects other handoffs; accepts only one channel`, () => {
  const {frame,parent,connect} = bootstrap();
  const port = new Port(), valid = {source:parent,origin,data:'opengeo-framework-draft-connect',ports:[port]};
  for (const mutation of [{source:{}},{origin:'null'},{origin:'https://evil.invalid'},{origin:'https://demo.studio.opengeo.tools.evil.invalid'},{data:'wrong'},{ports:[]}]) connect({...valid,...mutation});
  assert.deepEqual(port.messages, []);
  connect(valid); assert.deepEqual(port.messages, ['ready']);
  const second = new Port(); connect({...valid,ports:[second]}); assert.deepEqual(second.messages, []);
  port.emit({kind:'render',revision:1,html:'<h1>Draft</h1>'});
  assert.equal(frame.srcdoc, '<h1>Draft</h1>');
  port.emit({kind:'render',revision:2,html:'replacement'}); assert.equal(frame.srcdoc, '<h1>Draft</h1>');
  frame.dispatchEvent(new Event('load')); assert.equal(port.messages[1].kind, 'rendered'); assert(port.closed);
});
test('bootstrap rejects unsupported revisions and excessive UTF-8 bytes before rendering', () => {
  for (const payload of [{kind:'render',revision:2,html:'bad'}, {kind:'render',revision:1,html:'é'.repeat(FRAMEWORK_DRAFT_MAX_BYTES / 2 + 1)}]) {
    const {frame,parent,connect} = bootstrap(), port = new Port();
    connect({source:parent,origin:'https://studio.opengeo.tools',data:'opengeo-framework-draft-connect',ports:[port]});
    port.emit(payload); assert.equal(frame.srcdoc, undefined); assert.equal(port.messages[1].kind, 'error'); assert(port.closed);
  }
});
