import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {it} from "node:test";
import {prepareObservableArchiveBrowserFiles, prepareObservableBrowserFiles} from "../src/components/ProjectSites.js";
import {createFrameworkAttachmentReader, publicationFileAttachmentSnippet} from "../src/lib/frameworkArchiveInputs.js";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const fixtureTicket = version => {
  const url = new URL('https://s3.us-east-1.amazonaws.com/opengeo-fixture/land-cover.tif');
  for (const [key, value] of Object.entries({'X-Amz-Algorithm':'AWS4-HMAC-SHA256',
    'X-Amz-Credential':'fixture/20261009/us-east-1/s3/aws4_request', 'X-Amz-Date':'20261009T000000Z',
    'X-Amz-Expires':'900', 'X-Amz-SignedHeaders':'host', 'X-Amz-Signature':'a'.repeat(64),
    'response-content-disposition':'attachment; filename="land-cover.tif"', versionId:version})) url.searchParams.set(key, value);
  return {url:url.href, method:'GET', expiresAt:new Date(Date.now()+600000).toISOString()};
};
const file = (path, content) => {
  const blob = new Blob([content]);
  Object.defineProperties(blob, {name: {value: path.split("/").at(-1)}, webkitRelativePath: {value: `atlas/${path}`}});
  return blob;
};
const binding = {attachmentId: "00000000-0000-4000-8000-000000000087", relativePath: "src/data/water.geojson"};
const archive = bytes => ({id: binding.attachmentId, available: true, sizeBytes: Buffer.byteLength(bytes), contentType: "application/geo+json", checksumSha256: sha(bytes)});

it("previews a connected public TIFF once, rechecks refreshed authority and keeps account isolation", async () => {
  const bytes = new Uint8Array([73, 73, 42, 0]), path = 'src/data/source.tif';
  const reference = {id: '00000000-0000-4000-8000-000000000090', sourceProjectId: 'source',
    datasetId: 'dataset', resourceId: 'resource', resourceVersionId: 'edition', sourceVersion: 1,
    distributionId: 'tiff', url: 'https://source.example/landcover.tif', contentType: 'image/tiff',
    sizeBytes: bytes.length, checksumSha256: sha(bytes), available: true,
    kind: 'referenced-public-file', custody: 'referenced'};
  let organization = 'owner', inventories = 0, bodies = 0;
  const adapter = {tokenProvider: () => 'session', organizationProvider: () => organization,
    listObservablePublicFileReferences: async () => {inventories++; return [reference];},
    listObservableDataAttachments: async () => {throw Error('No archive inventory needed');},
    requestDatasetDownload: async () => {throw Error('Public sources need no S3 ticket');},
    fetchImplementation: async (url, options) => {
      bodies++; assert.equal(url, reference.url);
      assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
      assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.headers, undefined);
      return new Response(bytes);
    }};
  const references = [{referenceId: reference.id, relativePath: path},
    {referenceId: reference.id, relativePath: 'src/data/alias.tif'}];
  const reader = createFrameworkAttachmentReader({adapter, projectId: 'publication', sourceProjectId: 'source',
    getBindings: () => [], getReferencedFiles: () => references});
  const [first, second] = await Promise.all([reader.read(path), reader.read(references[1].relativePath)]);
  assert.equal(first, second); assert.equal(await reader.read(path), first);
  assert.deepEqual({inventories, bodies}, {inventories: 1, bodies: 1});
  const metadata = await reader.metadata(path);
  assert.equal(metadata.referenceId, reference.id); assert.equal(metadata.resourceVersionId, 'edition');
  assert.equal(metadata.url, undefined, 'Provider coordinates are not an attachment capability');
  await reader.reload([], [{...reference, available: false}]);
  await assert.rejects(reader.read(path), /unavailable/, 'Refreshed withdrawal denies cached bytes');
  await reader.reload([], [reference]); assert.equal(await reader.read(path), first);
  assert.equal(bodies, 1, 'Deliberate metadata refresh preserves unchanged verified bytes');
  organization = 'other'; await assert.rejects(reader.read(path), /account changed/);
  reader.dispose();
});

it("settles public TIFF failures until explicit reload and enforces a shared archive/source byte budget", async () => {
  const bytes = new Uint8Array([73, 73, 42, 0]), path = 'src/data/source.tif';
  const reference = {id: '00000000-0000-4000-8000-000000000090', sourceProjectId: 'source',
    datasetId: 'dataset', resourceId: 'resource', resourceVersionId: 'edition', sourceVersion: 1,
    distributionId: 'tiff', url: 'https://source.example/landcover.tif', contentType: 'image/tiff',
    sizeBytes: bytes.length, checksumSha256: sha(bytes), available: true,
    kind: 'referenced-public-file', custody: 'referenced'};
  let bodies = 0, fail = true, archives = [];
  const pin = {...archive(bytes), sourceProjectId: 'source', sizeBytes: 64 * 1024 * 1024 - 2};
  const adapter = {listObservablePublicFileReferences: async () => [reference],
    listObservableDataAttachments: async () => [pin], fetchImplementation: async () => {
      bodies++; if (fail) throw TypeError('CORS blocked'); return new Response(bytes);
    }};
  const reader = createFrameworkAttachmentReader({adapter, projectId: 'publication', sourceProjectId: 'source',
    getBindings: () => archives, getReferencedFiles: () => [{referenceId: reference.id, relativePath: path}]});
  for (let i = 0; i < 3; ++i) await assert.rejects(reader.read(path), /CORS/);
  await reader.invalidateInventory(); await assert.rejects(reader.read(path), /CORS/);
  assert.equal(bodies, 1, 'Typing or new metadata never retries the failed body');
  fail = false; await reader.reload([], [reference]); await reader.read(path);
  assert.equal(bodies, 2, 'Only deliberate reload retries');
  archives = [binding]; await reader.reload([pin], [reference]);
  await assert.rejects(reader.read(path), /64 MiB/, 'Source and archive paths share one data ceiling');
  assert.equal(bodies, 2); reader.dispose();
});

it("keeps a public-first preview usable when an existing archive is added, without refetching verified bytes or renamed paths", async () => {
  const bytes = new Uint8Array([73, 73, 42, 0]), publicPath = 'src/data/source.tif';
  const reference = {id: '00000000-0000-4000-8000-000000000090', sourceProjectId: 'source',
    sourceVersion: 1, resourceVersionId: 'edition', distributionId: 'tiff',
    url: 'https://source.example/landcover.tif', contentType: 'image/tiff', sizeBytes: bytes.length,
    checksumSha256: sha(bytes), available: true, kind: 'referenced-public-file', custody: 'referenced'};
  const pin = {...archive(bytes), sourceProjectId: 'source', datasetId: 'dataset', datasetVersionId: 'version',
    dataObjectId: 'object', contentType: 'image/tiff', s3VersionId: 'exact-version'};
  let bindings = [], archiveLists = 0, publicLists = 0, sourceBodies = 0, archiveBodies = 0, tickets = 0;
  const adapter = {listObservablePublicFileReferences: async () => {publicLists++; return [reference];},
    listObservableDataAttachments: async () => {archiveLists++; return [pin];},
    requestDatasetDownload: async () => {tickets++; return fixtureTicket('exact-version');},
    fetchImplementation: async url => {
      if (url === reference.url) sourceBodies++; else archiveBodies++;
      return new Response(bytes);
    }};
  const reader = createFrameworkAttachmentReader({adapter, projectId: 'publication', sourceProjectId: 'source',
    getBindings: () => bindings, getReferencedFiles: () => [{referenceId: reference.id, relativePath: publicPath}]});
  const publicBlob = await reader.read(publicPath);
  assert.deepEqual({archiveLists, publicLists, sourceBodies}, {archiveLists: 0, publicLists: 1, sourceBodies: 1});
  bindings = [{attachmentId: pin.id, relativePath: 'src/data/archived.tif'}];
  await reader.invalidateBindings();
  const archiveBlob = await reader.read(bindings[0].relativePath);
  assert.equal(await reader.read(publicPath), publicBlob);
  assert.deepEqual({archiveLists, publicLists, sourceBodies, archiveBodies, tickets},
    {archiveLists: 1, publicLists: 2, sourceBodies: 1, archiveBodies: 1, tickets: 1});
  bindings = [{...bindings[0], relativePath: 'src/data/renamed.tif'},
    {...bindings[0], relativePath: 'src/data/alias.tif'}];
  await reader.invalidateBindings();
  assert.equal(await reader.read(bindings[0].relativePath), archiveBlob);
  assert.equal(await reader.read(bindings[1].relativePath), archiveBlob);
  assert.deepEqual({archiveLists, publicLists, sourceBodies, archiveBodies, tickets},
    {archiveLists: 1, publicLists: 2, sourceBodies: 1, archiveBodies: 1, tickets: 1});
  await assert.rejects(reader.read('src/data/archived.tif'), /not found/);
  reader.dispose();
});

it("discards an in-flight public TIFF when its draft binding is removed", async () => {
  const bytes = new Uint8Array([73, 73, 42, 0]), path = 'src/data/source.tif';
  const reference = {id: '00000000-0000-4000-8000-000000000090', sourceProjectId: 'source',
    sourceVersion: 1, resourceVersionId: 'edition', distributionId: 'tiff', url: 'https://source.example/landcover.tif',
    contentType: 'image/tiff', sizeBytes: bytes.length, checksumSha256: sha(bytes), available: true,
    kind: 'referenced-public-file', custody: 'referenced'};
  let references = [{referenceId: reference.id, relativePath: path}], finish, started;
  const entered = new Promise(resolve => {started = resolve;});
  const adapter = {listObservablePublicFileReferences: async () => [reference],
    fetchImplementation: () => {started(); return new Promise(resolve => {finish = resolve;});}};
  const reader = createFrameworkAttachmentReader({adapter, projectId: 'publication', sourceProjectId: 'source',
    getBindings: () => [], getReferencedFiles: () => references});
  const pending = reader.read(path); await entered; references = [];
  await reader.invalidateBindings(); finish(new Response(bytes));
  await assert.rejects(pending, /abort|changed|reloaded/i);
  await assert.rejects(reader.read(path), /not found/); reader.dispose();
});

it("preserves a complete selected folder while substituting only an exact explicitly bound large archive", async () => {
  const data = JSON.stringify({type: "FeatureCollection", features: [], note: "x".repeat(18_930_900)});
  const page = file("src/index.md", "# Water\n");
  const packageFile = file("package.json", '{"type":"module"}');
  const large = file(binding.relativePath, data);
  const generated = file("node_modules/cache.bin", "generated");
  generated.arrayBuffer = () => { throw new Error("Generated bytes must not be read"); };
  const selection = [page, packageFile, large, generated];
  assert.throws(() => prepareObservableBrowserFiles([], selection), /4 MiB/);
  const result = await prepareObservableArchiveBrowserFiles([], selection, [binding], [archive(data)]);
  assert.deepEqual(result.files.map(item => item.relativePath), ["package.json", "src/index.md"]);
  assert.equal(result.files[0].blob, packageFile);
  assert.equal(result.files[1].blob, page);
  assert.deepEqual(result.archivedFiles, [{...binding, sizeBytes: Buffer.byteLength(data), checksumSha256: sha(data)}]);
  assert.equal(result.excludedCount, 1, "Archive substitution is not a generated-file exclusion");
  assert.equal(large.size, Buffer.byteLength(data));
});

it("rejects changed bytes, size, unavailable records, unsafe paths and media mismatches without guessing a substitute", async () => {
  const bytes = '{"water":true}';
  const files = [file("src/index.md", "# Water"), file(binding.relativePath, bytes)];
  for (const change of [{checksumSha256: "b".repeat(64)}, {sizeBytes: bytes.length + 1}, {available: false}, {contentType: "text/csv"}]) {
    await assert.rejects(prepareObservableArchiveBrowserFiles([], files, [binding], [{...archive(bytes), ...change}]));
  }
  await assert.rejects(prepareObservableArchiveBrowserFiles([], files, [{...binding, relativePath: "../water.geojson"}], [archive(bytes)]));
  await assert.rejects(prepareObservableArchiveBrowserFiles([], [...files, file(binding.relativePath, bytes)], [binding], [archive(bytes)]), /unique/);
  await assert.rejects(prepareObservableArchiveBrowserFiles([], [file("src/index.md", "# Page"), file("src/data/water.geojson/child.txt", "child")], [binding], [archive(bytes)]), /collide/);
});

it("retains bindings absent from a selected folder without claiming a local-byte match", async () => {
  const page = file("src/index.md", "# Water");
  const result = await prepareObservableArchiveBrowserFiles([], [page], [binding], [archive("{}")]);
  assert.equal(result.files[0].blob, page);
  assert.deepEqual(result.archivedFiles, []);
});

it("enforces the total archive budget before reading any selected data body", async () => {
  const large = file(binding.relativePath, "{}");
  large.arrayBuffer = () => { throw new Error("Must not read out-of-budget data"); };
  await assert.rejects(prepareObservableArchiveBrowserFiles([], [file("src/index.md", "# Page"), large],
    [binding], [{...archive("{}"), sizeBytes: 67_108_865}]), /64 MiB/);
});

it("inserts page-relative attachment aliases with distinct JavaScript names", () => {
  const first = publicationFileAttachmentSnippet("src/analysis/index.md", "src/data/land-cover.tif");
  assert.match(first, /FileAttachment\("\.\.\/data\/land-cover\.tif"\)\.arrayBuffer\(\)/);
  assert.match(first, /const data_land_cover =/);
  assert.match(publicationFileAttachmentSnippet("src/analysis/index.md", "src/data/land-cover.tif", "arrayBuffer", first), /const data_land_cover_2 =/);
  assert.throws(() => publicationFileAttachmentSnippet("analysis.ipynb", "data.tif"), /Framework or Observable/);
});

it("never exposes cached registered-file bytes after the publication account changes", async () => {
  const bytes = new Uint8Array([73, 73, 42, 0]), path = "src/data/land-cover.tif";
  const pin = {...archive(bytes), sourceProjectId: "source", datasetId: "dataset", datasetVersionId: "version",
    dataObjectId: "object", contentType: "image/tiff", s3VersionId: "exact-version"};
  let organization = "owner", bodies = 0, tickets = 0;
  const adapter = {tokenProvider: () => "session", organizationProvider: () => organization,
    listObservableDataAttachments: async () => [pin],
    getCatalogDataset: async () => ({id: "dataset", projectId: "original-workspace"}),
    requestDatasetDownload: async project => {assert.equal(project, "original-workspace"); tickets++;
      return fixtureTicket('exact-version');},
    fetchImplementation: async () => {bodies++; return new Response(bytes);}};
  const reader = createFrameworkAttachmentReader({adapter, projectId: "publication", sourceProjectId: "source",
    getBindings: () => [{...binding, relativePath: path}]});
  assert.deepEqual(new Uint8Array(await (await reader.read(path)).arrayBuffer()), bytes);
  organization = "guest";
  await assert.rejects(reader.read(path), /account changed/);
  assert.equal(bodies, 1); assert.equal(tickets, 1);
  reader.dispose();
});

it("rejects a ticket for another storage version before requesting any file body", async () => {
  const bytes = new Uint8Array([73, 73, 42, 0]), path = "src/data/land-cover.tif";
  const pin = {...archive(bytes), sourceProjectId: "source", datasetId: "dataset", datasetVersionId: "version",
    dataObjectId: "object", contentType: "image/tiff", s3VersionId: "exact-version"};
  const adapter = {listObservableDataAttachments: async () => [pin],
    requestDatasetDownload: async () => fixtureTicket('other-version'),
    fetchImplementation: () => {throw Error("Unexpected file body read");}};
  const reader = createFrameworkAttachmentReader({adapter, projectId: "publication", sourceProjectId: "source",
    getBindings: () => [{...binding, relativePath: path}]});
  await assert.rejects(reader.read(path), /exact saved dependency version/);
  reader.dispose();
});

it("returns only exact credential-free archive metadata from the shared cached inventory", async () => {
  const bytes = new Uint8Array([73, 73, 42, 0]), path = "src/data/land-cover.tif";
  const pin = {...archive(bytes), sourceProjectId: "source", datasetId: "dataset", datasetVersionId: "version",
    dataObjectId: "object", contentType: "image/tiff", s3VersionId: "exact-version",
    bucket: "private-bucket", objectKey: "private/key", url: fixtureTicket('exact-version').url,
    token: "private-token", license: "unverified", attribution: "unverified"};
  let inventories = 0, datasets = 0, tickets = 0, bodies = 0;
  const adapter = {tokenProvider: () => "session", organizationProvider: () => "owner",
    listObservableDataAttachments: async () => {inventories++; return [pin];},
    getCatalogDataset: async () => {datasets++; return {id: "dataset", projectId: "original-workspace"};},
    requestDatasetDownload: async () => {tickets++; return fixtureTicket('exact-version');},
    fetchImplementation: async () => {bodies++; return new Response(bytes);}};
  const reader = createFrameworkAttachmentReader({adapter, projectId: "publication", sourceProjectId: "source",
    getBindings: () => [{...binding, relativePath: path}]});
  const expected = {attachmentId: pin.id, datasetId: pin.datasetId, datasetVersionId: pin.datasetVersionId,
    dataObjectId: pin.dataObjectId, sizeBytes: pin.sizeBytes, checksumSha256: pin.checksumSha256,
    contentType: pin.contentType};
  assert.deepEqual(await reader.metadata(path), expected);
  assert.deepEqual(await reader.metadata(path), expected);
  assert.deepEqual({inventories, datasets, tickets, bodies}, {inventories: 1, datasets: 0, tickets: 0, bodies: 0});
  assert.deepEqual(new Uint8Array(await (await reader.read(path)).arrayBuffer()), bytes);
  assert.deepEqual(await reader.metadata(path), expected);
  assert.deepEqual({inventories, datasets, tickets, bodies}, {inventories: 1, datasets: 1, tickets: 1, bodies: 1});
  reader.dispose();
});

it("rejects cached attachment metadata after account change or editor disposal", async () => {
  const pin = {...archive("{}"), sourceProjectId: "source", datasetId: "dataset", datasetVersionId: "version",
    dataObjectId: "object"};
  let organization = "owner", inventories = 0;
  const adapter = {tokenProvider: () => "session", organizationProvider: () => organization,
    listObservableDataAttachments: async () => {inventories++; return [pin];},
    getCatalogDataset: () => {throw Error("Metadata must not resolve Dataset details");},
    requestDatasetDownload: () => {throw Error("Metadata must not request a download ticket");}};
  const reader = createFrameworkAttachmentReader({adapter, projectId: "publication", sourceProjectId: "source",
    getBindings: () => [binding]});
  await reader.metadata(binding.relativePath);
  organization = "guest";
  await assert.rejects(reader.metadata(binding.relativePath), /account changed/);
  assert.equal(inventories, 1);
  organization = "owner";
  reader.dispose();
  await assert.rejects(reader.metadata(binding.relativePath), /account changed|editor is closed/);
});

it("rejects an alias changed while exact attachment metadata is loading", async () => {
  const pin = {...archive("{}"), sourceProjectId: "source", datasetId: "dataset", datasetVersionId: "version",
    dataObjectId: "object"};
  let release, started, bindings = [{...binding}];
  const pending = new Promise(resolve => {release = resolve;});
  const loading = new Promise(resolve => {started = resolve;});
  const adapter = {listObservableDataAttachments: () => {started(); return pending;}};
  const reader = createFrameworkAttachmentReader({adapter, projectId: "publication", sourceProjectId: "source",
    getBindings: () => bindings});
  const metadata = reader.metadata(binding.relativePath);
  await loading;
  bindings[0].attachmentId = "00000000-0000-4000-8000-000000000099";
  release([pin]);
  await assert.rejects(metadata, /draft file reference changed/);
  reader.dispose();
});

it("shares one Dataset lookup across concurrent exact files without sharing their bytes", async () => {
  const bytes = new Uint8Array([73, 73, 42, 0]);
  const other = new Uint8Array([77, 77, 0, 42]);
  const pins = [bytes, other].map((value, index) => ({...archive(value),
    id: index ? '00000000-0000-4000-8000-000000000088' : binding.attachmentId,
    sourceProjectId: 'source', datasetId: 'dataset', datasetVersionId: 'version',
    dataObjectId: `object-${index}`, contentType: 'image/tiff', s3VersionId: 'exact-version'}));
  const bindings = pins.map((pin, index) => ({attachmentId: pin.id, relativePath: `data/${index}.tif`}));
  let lookups = 0, tickets = 0, bodies = 0;
  const adapter = {listObservableDataAttachments: async () => pins,
    getCatalogDataset: async () => {lookups++; await Promise.resolve(); return {id: 'dataset', projectId: 'original'};},
    requestDatasetDownload: async () => {tickets++; return fixtureTicket('exact-version');},
    fetchImplementation: async () => new Response(bodies++ ? other : bytes)};
  const reader = createFrameworkAttachmentReader({adapter, projectId: 'publication', sourceProjectId: 'source', getBindings: () => bindings});
  const result = await Promise.all(bindings.map(pin => reader.read(pin.relativePath)));
  assert.deepEqual(await Promise.all(result.map(async blob => new Uint8Array(await blob.arrayBuffer()))), [bytes, other]);
  assert.deepEqual({lookups, tickets, bodies}, {lookups: 1, tickets: 2, bodies: 2});
  reader.dispose();
});

it("retries failed tickets only after deliberate reload and retains successful exact bytes", async () => {
  const bytes = new Uint8Array([73, 73, 42, 0]), path = 'data/landcover.tif';
  const pin = {...archive(bytes), sourceProjectId: 'source', datasetId: 'dataset', datasetVersionId: 'version',
    dataObjectId: 'object', contentType: 'image/tiff', s3VersionId: 'exact-version'};
  let inventories = 0, tickets = 0, bodies = 0;
  const adapter = {listObservableDataAttachments: async () => {inventories++; return [pin];},
    requestDatasetDownload: async () => {if (++tickets === 1) throw Error('Download temporarily unavailable'); return fixtureTicket('exact-version');},
    fetchImplementation: async () => {bodies++; return new Response(bytes);}};
  const reader = createFrameworkAttachmentReader({adapter, projectId: 'publication', sourceProjectId: 'source',
    getBindings: () => [{...binding, relativePath: path}]});
  for (let i = 0; i < 4; ++i) await assert.rejects(reader.read(path), /temporarily unavailable/);
  assert.deepEqual({inventories, tickets, bodies}, {inventories: 1, tickets: 1, bodies: 0});
  await reader.invalidateInventory();
  await assert.rejects(reader.read(path), /temporarily unavailable/, 'New metadata does not retry a failed body');
  assert.deepEqual({inventories, tickets, bodies}, {inventories: 2, tickets: 1, bodies: 0});
  await reader.reload([pin]);
  const original = await reader.read(path);
  await reader.reload([pin]);
  assert.equal(await reader.read(path), original, 'Explicit reload rechecks metadata without downloading unchanged bytes');
  await reader.reload([{...pin, available: false}]);
  await assert.rejects(reader.read(path), /unavailable/, 'Revoked inventory cannot expose cached bytes');
  assert.deepEqual({inventories, tickets, bodies}, {inventories: 2, tickets: 2, bodies: 1});
  reader.dispose();
});

it("retains a failed inventory without reactive retries or guessing a missing attachment", async () => {
  const pin = {...archive('{}'), sourceProjectId: 'source', datasetId: 'dataset', datasetVersionId: 'version',
    dataObjectId: 'object', s3VersionId: 'exact-version'};
  let inventories = 0, organization = 'owner';
  const adapter = {tokenProvider: () => 'session', organizationProvider: () => organization,
    listObservableDataAttachments: async () => {inventories++; throw Error('Inventory temporarily unavailable');}};
  const reader = createFrameworkAttachmentReader({adapter, projectId: 'publication', sourceProjectId: 'source', getBindings: () => [binding]});
  await assert.rejects(reader.metadata(binding.relativePath), /temporarily unavailable/);
  await assert.rejects(reader.metadata(binding.relativePath), /temporarily unavailable/);
  assert.equal(inventories, 1);
  await reader.reload([]);
  await assert.rejects(reader.metadata(binding.relativePath), /unavailable/);
  await assert.rejects(reader.metadata(binding.relativePath), /unavailable/);
  assert.equal(inventories, 1, 'Missing IDs do not automatically reload the inventory');
  await reader.reload([pin]);
  assert.equal((await reader.metadata(binding.relativePath)).attachmentId, pin.id);
  organization = 'guest';
  await assert.rejects(reader.reload([pin]), /account changed/);
  await assert.rejects(reader.read(binding.relativePath), /account changed/);
  reader.dispose();
});

it("cancels a stale lookup on reload before it can issue a file ticket", async () => {
  const bytes = new Uint8Array([73, 73, 42, 0]), path = 'data/landcover.tif';
  const pin = {...archive(bytes), sourceProjectId: 'source', datasetId: 'dataset', datasetVersionId: 'version',
    dataObjectId: 'object', contentType: 'image/tiff', s3VersionId: 'exact-version'};
  let finish, entered, lookups = 0, tickets = 0;
  const started = new Promise(resolve => {entered = resolve;});
  const pending = new Promise(resolve => {finish = resolve;});
  const adapter = {listObservableDataAttachments: async () => [pin],
    getCatalogDataset: async () => {if (++lookups === 1) {entered(); return pending;} return {id: 'dataset', projectId: 'original'};},
    requestDatasetDownload: async () => {tickets++; return fixtureTicket('exact-version');},
    fetchImplementation: async () => new Response(bytes)};
  const reader = createFrameworkAttachmentReader({adapter, projectId: 'publication', sourceProjectId: 'source',
    getBindings: () => [{...binding, relativePath: path}]});
  const oldRead = reader.read(path);
  const stopped = assert.rejects(oldRead, /reloaded/);
  await started;
  await reader.reload([pin]);
  finish({id: 'dataset', projectId: 'original'});
  await stopped;
  assert.equal(tickets, 0);
  assert.deepEqual(new Uint8Array(await (await reader.read(path)).arrayBuffer()), bytes);
  assert.deepEqual({lookups, tickets}, {lookups: 2, tickets: 1});
  reader.dispose();
});

it('stops an obsolete alias before requesting its ticket or file body', async () => {
  const bytes = new Uint8Array([73, 73, 42, 0]), path = 'data/landcover.tif';
  const pin = {...archive(bytes), sourceProjectId: 'source', datasetId: 'dataset', datasetVersionId: 'version',
    dataObjectId: 'object', contentType: 'image/tiff', s3VersionId: 'exact-version'};
  for (const stage of ['dataset', 'ticket']) {
    let finish, entered, tickets = 0, bodies = 0;
    const bindings = [{...binding, relativePath: path}];
    const started = new Promise(resolve => {entered = resolve;});
    const pending = new Promise(resolve => {finish = resolve;});
    const adapter = {listObservableDataAttachments: async () => [pin],
      getCatalogDataset: async () => {if (stage === 'dataset') {entered(); await pending;} return {id: 'dataset', projectId: 'original'};},
      requestDatasetDownload: async () => {tickets++; if (stage === 'ticket') {entered(); await pending;} return fixtureTicket('exact-version');},
      fetchImplementation: async () => {bodies++; return new Response(bytes);}};
    const reader = createFrameworkAttachmentReader({adapter, projectId: 'publication', sourceProjectId: 'source', getBindings: () => bindings});
    const reading = reader.read(path);
    const stopped = assert.rejects(reading, /draft file reference changed/);
    await started;
    bindings[0].attachmentId = '00000000-0000-4000-8000-000000000088';
    finish();
    await stopped;
    assert.equal(tickets, stage === 'dataset' ? 0 : 1);
    assert.equal(bodies, 0);
    reader.dispose();
  }
});

it('keeps the latest inventory intent when account checks finish out of order', async () => {
  const original = {...archive('{}'), sourceProjectId: 'source', datasetId: 'dataset', datasetVersionId: 'version',
    dataObjectId: 'object', s3VersionId: 'exact-version'};
  const replacement = {...original, id: '00000000-0000-4000-8000-000000000088'};
  for (const first of ['reload', 'invalidate']) {
    let finish, entered, tokenCalls = 0, inventories = 0;
    const pending = new Promise(resolve => {finish = resolve;});
    const started = new Promise(resolve => {entered = resolve;});
    const adapter = {tokenProvider: () => {if (++tokenCalls === 2) {entered(); return pending;} return 'session';},
      organizationProvider: () => 'owner', listObservableDataAttachments: async () => {inventories++; return [replacement];}};
    const reader = createFrameworkAttachmentReader({adapter, projectId: 'publication', sourceProjectId: 'source',
      getBindings: () => [{...binding, attachmentId: replacement.id}]});
    const stale = first === 'reload' ? reader.reload([original]) : reader.invalidateInventory();
    await started;
    assert.equal(await (first === 'reload' ? reader.invalidateInventory() : reader.reload([replacement])), true);
    finish('session');
    assert.equal(await stale, false);
    assert.equal((await reader.metadata(binding.relativePath)).attachmentId, replacement.id);
    assert.equal(inventories, first === 'reload' ? 1 : 0);
    reader.dispose();
  }
});
