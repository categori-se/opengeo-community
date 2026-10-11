import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {it} from "node:test";
import {unzipSync, strFromU8} from "fflate";
import {planAccountSavedPublicationDownload, createAccountSavedPublicationDownload} from "../src/lib/accountWorkDownload.js";
import {readPublicationSourceArchive} from "../src/lib/publicationSourceArchive.js";
import {identifyProjectFileFormat} from "../src/lib/projectFileFormat.js";
import {collectionDefinitionFromApi} from "../src/lib/collectionReferences.js";
import {serializeSavedCollection} from "../src/lib/collectionExport.js";

const id = number => `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const accountId = id(1), ownerUserId = id(2), projectId = id(3), sourceId = id(4), revisionId = id(5);
const exactText = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("# Original\r\n")]);
const binary = new Uint8Array([0, 255, 13, 10, 128]);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const calls = [], bytes = {"index.md": exactText, "images/map.png": binary};
  const source = {id: sourceId, projectId, siteId: id(6), routeNamespace: "research", title: "Research",
    ownerUserId, currentRevisionId: revisionId, currentRevisionNumber: 2,
    buildPolicy: {networkPolicy: "deny_all"}};
  const revision = {id: revisionId, sourceProjectId: sourceId, revisionNumber: 2, parentRevisionId: id(7),
    title: "Saved original", rightsStatus: "unreviewed", entryPath: "index.md", lockfilePath: null,
    changeSummary: "Original source", manifestChecksumSha256: "a".repeat(64), manifest: {}, dataAttachments: [],
    createdBy: id(8), createdAt: "2026-10-07T12:00:00Z", files: Object.entries(bytes).map(([relativePath, contents]) => ({
      relativePath, contentType: relativePath.endsWith(".png") ? "image/png" : "text/markdown",
      sizeBytes: contents.length, checksumSha256: sha(contents), sourceObjectId: id(9),
      bucket: "private-bucket", objectKey: `sources/${relativePath}`, s3VersionId: "immutable-version", etag: "etag"}))};
  let account = accountId, token = "session-1", currentSource = source;
  const adapter = {baseUrl: "/api", organizationProvider: () => account, tokenProvider: () => token,
    listProjects: async options => {calls.push(["projects", options.offset, options.status]); return options.offset ? [] : [{id: projectId, callerRole: "owner"}];},
    listObservableSourceProjects: async project => {calls.push(["sources", project]); return [currentSource,
      {...source, id: id(10), ownerUserId: id(11), canManage: true}];},
    listObservableSourceRevisions: async (project, source) => {calls.push(["revisions", source]); return [revision];},
    listCompositions: async options => {calls.push(["compositions", options.status, options.offset]); return options.status !== "archived" ? [{id: id(12), createdBy: ownerUserId}] : [];},
    readObservableSourceRevisionFile: async (project, source, retained, path, options) => {
      calls.push(["bytes", source, retained, path, Boolean(options.signal)]);
      return {blob: new Blob([bytes[path]], {type: revision.files.find(file => file.relativePath === path).contentType})};
    }};
  return {adapter, calls, source, revision, bytes, changeAccount: value => {account = value;}, changeToken: value => {token = value;},
    changeSource: value => {currentSource = value;}};
}
const plan = (f, extra = {}) => planAccountSavedPublicationDownload({adapter: f.adapter, accountId, ownerUserId, ...extra});
const create = (f, reviewed, extra = {}) => createAccountSavedPublicationDownload({adapter: f.adapter, plan: reviewed, ...extra});

function metadataFixture() {
  const f = fixture(), catalogId = id(30), collectionId = id(31), calls = [];
  f.adapter.baseUrl = "https://studio.example.invalid/api";
  f.adapter.listProjects = async () => [];
  f.adapter.listCompositions = async () => [];
  f.record = {id: catalogId, projectId, ownerUserId, name: "Owned Catalog Layer", updatedAt: "2026-10-07T12:00:00Z",
    status: "active", currentVersionId: id(32), currentVersionNumber: 1, sourceType: "upload", format: "geojson",
    capabilities: {read: true, edit: true}, createdBy: id(99)};
  f.knowledge = {datasetId: catalogId, version: 2, document: {schemaVersion: "1.0.0", distributions: [], context: [],
    metadata: {source: [{nested: {unknown: null, values: [1, "Original"]}}], normalized: [], curated: [], inferred: []}}};
  const wire = {id: collectionId, title: "Owned Collection", description: "Saved grouping", revision: 3,
    owner: {principal_type: "user", principal_id: ownerUserId}, owner_user_id: ownerUserId, created_by: id(99),
    visibility: "private", role: "owner", members: [
      {entry_id: id(33), available: true, kind: "project", target_id: id(34), workspace_id: projectId, title: "Private member display title"},
      {entry_id: id(35), available: false}]};
  f.collection = {...wire, definition: collectionDefinitionFromApi(wire, {baseUrl: f.adapter.baseUrl, organizationId: accountId})};
  f.adapter.searchDatasets = async options => {calls.push(["catalog", options]); return [f.record,
    {...f.record, id: id(36), ownerUserId: id(99), createdBy: ownerUserId}];};
  f.adapter.getCatalogDataset = async value => {calls.push(["catalog-detail", value]); return structuredClone(f.record);};
  f.adapter.getDatasetKnowledge = async value => {calls.push(["knowledge", value]); return structuredClone(f.knowledge);};
  f.adapter.listCollections = async options => {calls.push(["collections", options]); return [f.collection,
    {...wire, id: id(37), owner: {principal_type: "team", principal_id: id(38)}, owner_user_id: null},
    {...wire, id: id(39), owner: {principal_type: "organization", principal_id: accountId}, owner_user_id: null},
    {...wire, id: id(40), owner: {principal_type: "user", principal_id: id(99)}, created_by: ownerUserId},
    {id: id(41), title: "Owner unavailable", revision: 1, created_by: ownerUserId, role: "owner"}];};
  f.adapter.getCollection = async value => {calls.push(["collection-detail", value]); return structuredClone(f.collection);};
  f.metadataCalls = calls;
  return f;
}
it("keeps metadata off by default and exports owned current Catalog knowledge and shared Collection definitions without GIS reads", async t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("No provider, ticket or object request"));
  const f = metadataFixture();
  assert.equal((await plan(f)).items.length, 0); assert.deepEqual(f.metadataCalls, []);
  const reviewed = await plan(f, {includeOwnedMetadata: true});
  assert.deepEqual(reviewed.items.map(item => item.kind), ["catalog-record", "collection"]);
  const options = f.metadataCalls.find(([kind]) => kind === "catalog")[1];
  assert.equal(options.ownerUserId, ownerUserId); assert.equal(options.limit, 25); assert.equal(options.offset, 0);
  assert.equal(reviewed.estimate.downloadMetadataRequests, 6);
  assert.deepEqual(reviewed.unresolved.map(item => item.reason), ["non-user-owner", "non-user-owner", "canonical-owner-unavailable"]);
  assert.equal(reviewed.exclusions.catalogHistory, true); assert.equal(reviewed.exclusions.nonUserOwnedCollections, true);
  const output = await create(f, reviewed), zip = unzipSync(new Uint8Array(await output.blob.arrayBuffer()));
  const catalog = JSON.parse(strFromU8(zip[`catalog/${f.record.id}/catalog-record.json`]));
  assert.deepEqual(catalog.knowledge.document, f.knowledge.document); assert.equal(catalog.record.ownerUserId, ownerUserId);
  assert.equal(Object.hasOwn(catalog.record, "capabilities"), false);
  const collectionText = strFromU8(zip[`collections/${f.collection.id}/saved-collection.json`]);
  assert.equal(collectionText, serializeSavedCollection(f.collection).text);
  assert.doesNotMatch(collectionText, /Private member display title|created_by|owner_user_id|"role"/);
  assert.equal(JSON.parse(collectionText).entries[1].reference, null);
  assert.match(strFromU8(zip["README.txt"]), /Current metadata only.*reference URLs\/configuration/s);
  assert.equal(output.manifest.exported.length, 2); assert.equal(output.manifest.includeOwnedMetadata, true);
  for (const entry of output.manifest.exported) assert.equal(entry.checksumSha256, sha(zip[entry.path]));
  assert.equal(f.metadataCalls.filter(([kind]) => kind === "catalog-detail").length, 3);
  assert.equal(f.metadataCalls.filter(([kind]) => kind === "knowledge").length, 3);
  assert.equal(f.metadataCalls.filter(([kind]) => kind === "collection-detail").length, 3);
  assert.equal(f.calls.some(([kind]) => kind === "bytes"), false);
});
function sourceMetadataFixture(repository = false) {
  const f = metadataFixture(); f.record.sourceType = repository ? "repository" : "wms";
  f.reference = repository ? {datasetId: f.record.id, connectionId: id(90), connectionTargetRevision: 7,
    provider: "s3", bucketName: "recorded-private-bucket", regionName: "us-east-1", objectPrefix: "archive/",
    relativePath: "roads.geojson", providerVersionId: "immutable-provider-version", sizeBytes: 7954,
    lastModified: "2026-10-07T12:00:00Z", contentType: "application/geo+json", etag: "retained-etag",
    storageClass: null, providerChecksumSha256: null, createdBy: id(99), createdAt: "2026-10-07T12:00:00Z"}
    : {datasetId: f.record.id, projectId, ownerUserId, name: f.record.name, description: null,
      classification: "internal", status: "active", sourceType: "wms", accessMode: "direct_browser", credentialMode: "none",
      versionNumber: 7, sourceUrl: "https://provider.example/wms", configuration: {layers: ["roads"], attribution: null},
      verificationState: "syntax_only", createdAt: "2026-10-07T12:00:00Z", updatedAt: "2026-10-07T12:00:00Z", capabilities: {read: true}};
  f.referenceReads = 0;
  f.adapter[repository ? "getRepositoryObjectSource" : "getSource"] = async (project, dataset) => {
    assert.equal(project, projectId); assert.equal(dataset, f.record.id); f.referenceReads++;
    return structuredClone(f.reference);
  };
  return f;
}
it("exports current registered remote and repository metadata with exact independent source/provider pins and six reserved reads", async t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("No provider, credentials or data request"));
  for (const repository of [false, true]) {
    const f = sourceMetadataFixture(repository), reviewed = await plan(f, {includeOwnedMetadata: true});
    assert.equal(f.referenceReads, 1); assert.equal(reviewed.estimate.downloadMetadataRequests, 8);
    assert.equal(reviewed.exclusions.sourceConnections, true);
    assert.equal(reviewed.exclusions.registeredSourceReferences, false);
    const output = await create(f, reviewed), zip = unzipSync(new Uint8Array(await output.blob.arrayBuffer()));
    const entry = output.manifest.exported.find(item => item.kind === "catalog-record");
    assert.equal(entry.checksumSha256, sha(zip[entry.path]));
    const source = JSON.parse(strFromU8(zip[entry.path])).registeredSource;
    assert.equal(source.state, "registered"); assert.equal(source.descriptor.datasetId, f.record.id);
    if (repository) {assert.equal(source.descriptor.providerVersionId, f.reference.providerVersionId); assert.equal(source.descriptor.connectionTargetRevision, 7);}
    else {assert.equal(source.descriptor.versionNumber, 7); assert.equal(f.record.currentVersionNumber, 1);
      assert.equal(source.descriptor.sourceUrl, f.reference.sourceUrl); assert.deepEqual(source.descriptor.configuration, f.reference.configuration);}
    assert.equal(Object.hasOwn(source.descriptor, "capabilities"), false); assert.equal(f.referenceReads, 3);
  }
});
it("retains explicit missing source metadata and rejects its changed presence, source revision or owner", async () => {
  const missing = sourceMetadataFixture(); let absent = true;
  const original = missing.adapter.getSource;
  missing.adapter.getSource = (...args) => {if (absent) {missing.referenceReads++; throw {status: 404};} return original(...args);};
  const reviewed = await plan(missing, {includeOwnedMetadata: true});
  assert.ok(reviewed.unresolved.some(item => item.reason === "registered-source-unavailable"));
  const output = await create(missing, reviewed), zip = unzipSync(new Uint8Array(await output.blob.arrayBuffer()));
  assert.equal(JSON.parse(strFromU8(zip[`catalog/${missing.record.id}/catalog-record.json`])).registeredSource.state, "unavailable");
  assert.equal(missing.referenceReads, 3); absent = false; await assert.rejects(create(missing, reviewed), /changed/);
  for (const change of [f => {f.reference.versionNumber++;}, f => {f.reference.ownerUserId = id(99);},
    f => {f.reference.sourceUrl = "https://provider.example/other";}]) {
    const f = sourceMetadataFixture(), next = await plan(f, {includeOwnedMetadata: true}); change(f);
    await assert.rejects(create(f, next), /changed/);
  }
});
it("excludes unsafe or denied registered descriptors without widening limits or requesting upload sources", async () => {
  const uploaded = metadataFixture(); uploaded.adapter.getSource = () => assert.fail("Uploads make zero source reads");
  await create(uploaded, await plan(uploaded, {includeOwnedMetadata: true}));
  for (const repository of [false, true]) {
    const f = sourceMetadataFixture(repository);
    if (repository) f.reference.secretArn = "forbidden-connection-material";
    else f.reference.sourceUrl = "https://provider.example/wms?X-Amz-Signature=private";
    const reviewed = await plan(f, {includeOwnedMetadata: true});
    assert.equal(reviewed.items.some(item => item.kind === "catalog-record"), false);
    assert.ok(reviewed.unresolved.some(item => item.reason === "metadata-definition-unavailable"));
  }
  const denied = sourceMetadataFixture(); denied.adapter.getSource = async () => {throw {status: 403};};
  assert.equal((await plan(denied, {includeOwnedMetadata: true})).items.some(item => item.kind === "catalog-record"), false);
  const capped = sourceMetadataFixture(); capped.adapter.listCollections = async () => [];
  const reviewed = await plan(capped, {includeOwnedMetadata: true, limits: {maxMetadataRequests: 5}});
  assert.equal(capped.referenceReads, 0); assert.equal(reviewed.items.length, 0);
  assert.ok(reviewed.unresolved.some(item => item.reason === "metadata-read-limit"));
});
it("reserves metadata rereads and item limits before accepting metadata and advances the raw Catalog page", async () => {
  const f = metadataFixture(), offsets = [];
  f.adapter.searchDatasets = async options => {
    offsets.push(options.offset);
    return options.offset ? [{...f.record, id: id(80)}] : Array.from({length: 25}, (_, n) => ({...f.record, id: n ? id(50 + n) : f.record.id}));
  };
  const reviewed = await plan(f, {includeOwnedMetadata: true, limits: {maxItems: 1}});
  assert.deepEqual(offsets, [0, 25]); assert.equal(reviewed.items.length, 1);
  assert.equal(f.metadataCalls.filter(([kind]) => kind === "catalog-detail").length, 1);
  assert.equal(f.metadataCalls.some(([kind]) => kind === "collection-detail"), false);
  assert.ok(reviewed.unresolved.some(item => item.reason === "item-limit"));
  const limited = metadataFixture();
  limited.adapter.searchDatasets = async () => Array.from({length: 8}, (_, n) => ({...limited.record, id: id(50 + n)}));
  limited.adapter.getCatalogDataset = async value => ({...limited.record, id: value});
  limited.adapter.getDatasetKnowledge = async value => ({...limited.knowledge, datasetId: value});
  const capped = await plan(limited, {includeOwnedMetadata: true, limits: {maxMetadataRequests: 25}});
  assert.equal(capped.items.length, 6); assert.equal(capped.estimate.downloadMetadataRequests, 24);
  assert.ok(capped.unresolved.some(item => item.reason === "metadata-read-limit"));
  assert.equal(limited.metadataCalls.some(([kind]) => kind === "collection-detail"), false);
});
it("rejects changed Catalog owners, heads and metadata and typed Collection owners or revisions before and after ZIP packing", async () => {
  for (const change of [f => {f.record.ownerUserId = id(99);}, f => {f.record.currentVersionId = id(99);},
    f => {f.knowledge.version++;}, f => {f.collection.owner = {principal_type: "team", principal_id: id(99)};},
    f => {f.collection.revision++;}, f => {f.changeAccount(id(99));}]) {
    const f = metadataFixture(), reviewed = await plan(f, {includeOwnedMetadata: true}); change(f);
    await assert.rejects(create(f, reviewed), /owner|metadata|revision|changed/i);
  }
  const late = metadataFixture(), reviewed = await plan(late, {includeOwnedMetadata: true});
  const original = late.adapter.getDatasetKnowledge; let reads = 0;
  late.adapter.getDatasetKnowledge = async value => {if (++reads === 2) late.knowledge.version++; return original(value);};
  await assert.rejects(create(late, reviewed), /changed/);
  assert.equal(reads, 2, "metadata is checked again after ZIP packing");
});
it("discloses incomplete Collection definitions and suppresses a late metadata detail after cancellation", async () => {
  const incomplete = metadataFixture(); delete incomplete.collection.definition;
  const partial = await plan(incomplete, {includeOwnedMetadata: true});
  assert.deepEqual(partial.items.map(item => item.kind), ["catalog-record"]);
  assert.ok(partial.unresolved.some(item => item.reason === "metadata-definition-unavailable"));
  const f = metadataFixture(), reviewed = await plan(f, {includeOwnedMetadata: true}), controller = new AbortController();
  let finish, started;
  const begun = new Promise(resolve => {started = resolve;});
  f.adapter.getCollection = () => {started(); return new Promise(resolve => {finish = resolve;});};
  const downloading = create(f, reviewed, {signal: controller.signal}); await begun;
  controller.abort(); await assert.rejects(downloading, error => error.name === "AbortError");
  finish(f.collection); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.calls.some(([kind]) => kind === "bytes"), false);
});

it("reviews metadata only, excludes managed teammate content and exports exact saved source bytes with explicit gaps", async t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("No provider or direct storage request"));
  const f = fixture(), reviewed = await plan(f);
  assert.equal(reviewed.items.length, 1);
  assert.deepEqual(f.calls.filter(call => call[0] === "revisions"), [["revisions", sourceId]]);
  assert.equal(f.calls.some(call => call[0] === "bytes"), false);
  assert.equal(reviewed.estimate.sourceBytes, exactText.length + binary.length);
  assert.equal(reviewed.estimate.fileReads, 2);
  assert.equal(reviewed.estimate.savedPublicationVersions, 1);
  assert.equal(reviewed.estimate.publicationArchiveCount, 1);
  assert.deepEqual(reviewed.items[0].savedRevisions, [f.revision]);
  assert.equal(reviewed.exclusions.publicationSavedHistory, true);
  assert.equal(reviewed.estimate.downloadMetadataRequests, 2);
  assert.deepEqual(reviewed.unresolved, [{kind: "project", id: id(12), reason: "canonical-project-owner-unavailable"}]);
  assert.equal(reviewed.complete, false);
  const exported = await create(f, reviewed), outer = unzipSync(new Uint8Array(await exported.blob.arrayBuffer()));
  const manifest = JSON.parse(strFromU8(outer["opengeo-account-download.json"]));
  assert.equal(manifest.complete, false);
  assert.equal(manifest.exported.length, 1);
  assert.equal(manifest.costs.kmsRequests, "unknown");
  assert.equal(manifest.exclusions.unsavedBuffers, true);
  const nested = await readPublicationSourceArchive(new Blob([outer[manifest.exported[0].path]]));
  assert.equal(nested.manifest.metadata.exportedContent, "saved-source-files");
  assert.equal(nested.manifest.metadata.savedRevisionId, revisionId);
  for (const [path, bytes] of Object.entries(f.bytes)) {
    assert.deepEqual(new Uint8Array(await nested.files.find(file => file.relativePath === path).blob.arrayBuffer()), bytes);
  }
  assert.equal(f.calls.filter(call => call[0] === "bytes").length, 2);
  assert.equal(f.calls.some(call => call[0] === "bytes" && call[1] === id(10)), false);
});

it("uses bounded pagination and records discovery, item and byte limits without fetching definitions or source bodies", async () => {
  const f = fixture(), offsets = [];
  f.adapter.listProjects = async options => {offsets.push(options.offset); return options.offset === 0
    ? Array.from({length: 25}, (_, index) => ({id: id(100 + index)})) : [{id: projectId}];};
  const original = f.adapter.listObservableSourceProjects;
  f.adapter.listObservableSourceProjects = project => project === projectId ? original(project) : [];
  const reviewed = await plan(f);
  assert.deepEqual(offsets, [0, 25]);
  assert.equal(reviewed.items.length, 1);
  const short = await plan(f, {limits: {maxDiscoveryRecords: 2}});
  assert.equal(short.items.length, 0);
  assert.ok(short.unresolved.some(item => item.reason === "discovery-limit"));
  const small = await plan(f, {limits: {maxSourceBytes: 1}});
  assert.equal(small.items.length, 0);
  assert.ok(small.unresolved.some(item => item.reason === "byte-or-read-limit"));
  await assert.rejects(create(f, small), /Review saved content/);
  assert.equal(f.calls.some(call => call[0] === "bytes"), false);
});

function publicationHistoryFixture() {
  const f = fixture(), earlierBytes = {"index.md": new Uint8Array([0xef, 0xbb, 0xbf,
    ...new TextEncoder().encode("# Earlier 田\r\n")]), "images/map.png": new Uint8Array([128, 0, 10, 13, 255])};
  const earlier = {...structuredClone(f.revision), id: id(7), revisionNumber: 1, parentRevisionId: null,
    title: "Earlier saved original", changeSummary: "Earlier source", createdBy: id(16),
    createdAt: "2026-10-06T12:00:00Z", manifestChecksumSha256: "b".repeat(64),
    files: f.revision.files.map(file => ({...file, sizeBytes: earlierBytes[file.relativePath].length,
      checksumSha256: sha(earlierBytes[file.relativePath]), sourceObjectId: id(17),
      objectKey: `earlier/${file.relativePath}`, s3VersionId: "earlier-immutable-version"}))};
  const latest = structuredClone(f.revision), known = [latest, earlier];
  for (const revision of known) {
    const pin = {path: "data/known.csv", attachmentId: id(90), datasetId: id(91),
      datasetVersionId: id(92 + revision.revisionNumber), dataObjectId: id(96 + revision.revisionNumber),
      s3VersionId: `data-version-${revision.revisionNumber}`, checksumSha256: "c".repeat(64),
      sizeBytes: 500, contentType: "text/csv"};
    revision.dataAttachments = [{attachmentId: pin.attachmentId, relativePath: pin.path}];
    revision.manifest = {schemaVersion: "opengeo.observable-source-revision.2.0.0", dataAttachments: [pin],
      artifactReferences: {revision: revision.revisionNumber,
        references: [{projectId, artifactId: id(100 + revision.revisionNumber), checksumSha256: "d".repeat(64)}]}};
  }
  let revisions = [earlier, latest];
  const bytesByRevision = new Map([[latest.id, f.bytes], [earlier.id, earlierBytes]]);
  f.adapter.listCompositions = async options => {f.calls.push(["compositions", options.status, options.offset]); return [];};
  f.adapter.listObservableSourceRevisions = async (project, source, options) => {
    f.calls.push(["revisions", source, Boolean(options.signal)]); return structuredClone(revisions);
  };
  f.adapter.listObservableSourceRevisionsPage = async (project, source, options) => {
    f.calls.push(["revision-page", source, options.limit, options.beforeRevision, Boolean(options.signal)]);
    return structuredClone(revisions.slice().sort((left, right) => right.revisionNumber - left.revisionNumber)
      .filter(revision => options.beforeRevision === undefined || revision.revisionNumber < options.beforeRevision)
      .slice(0, options.limit));
  };
  f.adapter.readObservableSourceRevisionFile = async (project, source, retained, path, options) => {
    f.calls.push(["bytes", source, retained, path, Boolean(options.signal)]);
    const revision = known.find(value => value.id === retained);
    return {blob: new Blob([bytesByRevision.get(retained)[path]],
      {type: revision.files.find(file => file.relativePath === path).contentType})};
  };
  return {...f, latest, earlier, bytesByRevision, setRevisions: value => {revisions = value;}};
}

it("deliberately packages exact Publication revisions as separate nested ZIPs with retained pins and references", async t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Publication history never fetches linked data or Artifact bytes"));
  const f = publicationHistoryFixture(), reviewed = await plan(f, {includeSavedPublicationVersions: true});
  assert.equal(reviewed.items.length, 1);
  assert.equal(reviewed.items[0].revisionId, f.latest.id);
  assert.deepEqual(reviewed.items[0].revision, f.latest);
  assert.deepEqual(reviewed.items[0].savedRevisions, [f.latest, f.earlier]);
  assert.equal(reviewed.estimate.savedPublicationVersions, 2);
  assert.equal(reviewed.estimate.publicationArchiveCount, 2);
  assert.equal(reviewed.estimate.fileReads, 4);
  const sourceBytes = [f.latest, f.earlier].flatMap(revision => revision.files)
    .reduce((sum, file) => sum + file.sizeBytes, 0);
  assert.equal(reviewed.estimate.publicationSourceBytes, sourceBytes);
  assert.equal(reviewed.estimate.archiveBytesUpperBound, sourceBytes + 2 * 2_097_152 + 524_288);
  assert.equal(reviewed.exclusions.publicationSavedHistory, false);
  assert.equal(reviewed.exclusions.projectSavedHistory, true);
  assert.equal(reviewed.exclusions.savedHistory, true);
  assert.deepEqual(f.calls.filter(call => call[0] === "revision-page"), [
    ["revision-page", sourceId, 1, undefined, true], ["revision-page", sourceId, 25, 2, true]]);
  assert.equal(f.calls.some(call => call[0] === "revisions"), false);
  assert.equal(f.calls.some(call => call[0] === "bytes"), false);
  const exported = await create(f, reviewed), outer = unzipSync(new Uint8Array(await exported.blob.arrayBuffer()));
  assert.equal(exported.manifest.exported.length, 2);
  for (const record of exported.manifest.exported) {
    const revision = record.revisionId === f.latest.id ? f.latest : f.earlier;
    assert.equal(record.revisionNumber, revision.revisionNumber);
    assert.equal(record.path, revision === f.latest ? `publications/${sourceId}/saved-source.zip`
      : `publications/${sourceId}/versions/v1.saved-source.zip`);
    const nested = await readPublicationSourceArchive(new Blob([outer[record.path]]));
    assert.equal(nested.manifest.metadata.savedRevisionId, revision.id);
    assert.equal(nested.manifest.metadata.savedRevisionNumber, revision.revisionNumber);
    assert.equal(nested.manifest.metadata.title, revision.title);
    assert.equal(nested.manifest.metadata.changeSummary, revision.changeSummary);
    assert.deepEqual(nested.manifest.baseRevision, {purpose: "original-context-only", revision});
    assert.deepEqual(nested.manifest.artifactReferences, {bundled: false, references: revision.manifest.artifactReferences});
    assert.deepEqual(nested.manifest.dataAttachments, [{...revision.dataAttachments[0], bundled: false,
      pinDetails: "retained-base-revision", pin: revision.manifest.dataAttachments[0]}]);
    assert.equal(nested.files.length, 2);
    for (const file of nested.files) {
      assert.deepEqual(new Uint8Array(await file.blob.arrayBuffer()), f.bytesByRevision.get(revision.id)[file.relativePath]);
    }
  }
  assert.deepEqual(f.calls.filter(call => call[0] === "bytes").map(call => call[2]),
    [f.latest.id, f.latest.id, f.earlier.id, f.earlier.id]);
});

it("keeps Publication and map history selections independent and discloses incomplete map ownership", async () => {
  const f = publicationHistoryFixture();
  const latestOnly = await plan(f);
  assert.deepEqual(latestOnly.items[0].savedRevisions, [f.latest]);
  assert.equal(latestOnly.estimate.savedPublicationVersions, 1);
  const mapsOnly = await plan(f, {includeSavedMapVersions: true});
  assert.deepEqual(mapsOnly.items[0].savedRevisions, [f.latest]);
  assert.equal(mapsOnly.exclusions.publicationSavedHistory, true);
  assert.equal(mapsOnly.exclusions.projectSavedHistory, false);
  assert.equal(mapsOnly.exclusions.savedHistory, true);
  const both = await plan(f, {includeSavedMapVersions: true, includeSavedPublicationVersions: true});
  assert.equal(both.exclusions.publicationSavedHistory, false);
  assert.equal(both.exclusions.projectSavedHistory, false);
  assert.equal(both.exclusions.savedHistory, false);
  f.adapter.listCompositions = async () => [{id: id(12), ownerUserId: null}];
  const incomplete = await plan(f, {includeSavedMapVersions: true, includeSavedPublicationVersions: true});
  assert.equal(incomplete.exclusions.publicationSavedHistory, false);
  assert.equal(incomplete.exclusions.projectSavedHistory, true);
  assert.equal(incomplete.exclusions.savedHistory, true);
  assert.ok(incomplete.unresolved.some(item => item.reason === "canonical-project-owner-unavailable"));
});

it("preserves the latest Publication and reports duplicate, foreign or malformed older revision metadata", async () => {
  for (const older of [f => [f.earlier, structuredClone(f.earlier)],
    f => [f.earlier, {...f.earlier, id: id(110)}],
    f => [{...f.earlier, sourceProjectId: id(111)}],
    f => [{...f.earlier, id: "invalid-revision"}],
    f => [{...f.earlier, manifest: {notes: "x".repeat(262_144)}}]]) {
    const f = publicationHistoryFixture(); f.setRevisions([f.latest, ...older(f)]);
    const reviewed = await plan(f, {includeSavedPublicationVersions: true});
    assert.equal(reviewed.items.length, 1);
    assert.deepEqual(reviewed.items[0].savedRevisions[0], f.latest);
    const selected = reviewed.items[0].savedRevisions;
    assert.equal(new Set(selected.map(revision => revision.id)).size, selected.length);
    assert.equal(new Set(selected.map(revision => revision.revisionNumber)).size, selected.length);
    assert.ok(selected.every(revision => revision.sourceProjectId === sourceId
      && revision.revisionNumber <= f.source.currentRevisionNumber));
    assert.ok(reviewed.unresolved.some(item => item.id === sourceId && item.reason === "saved-history-unavailable"));
    assert.equal(reviewed.exclusions.publicationSavedHistory, true);
    assert.equal(f.calls.some(call => call[0] === "bytes"), false);
  }
  const oversized = publicationHistoryFixture();
  oversized.setRevisions([oversized.latest, {...oversized.earlier, manifest: {notes: "x".repeat(2_097_152)}}]);
  const reviewed = await plan(oversized, {includeSavedPublicationVersions: true});
  assert.deepEqual(reviewed.items[0].savedRevisions, [oversized.latest]);
  assert.ok(reviewed.unresolved.some(item => item.reason === "saved-history-over-limit"));
  assert.equal(oversized.calls.some(call => call[0] === "bytes"), false);
});

it("bounds Publication history pagination and preserves known revisions when an older page fails", async () => {
  const makeHistory = (count = 27) => {
    const f = publicationHistoryFixture(), latest = {...f.latest, revisionNumber: count};
    const revisions = [latest, ...Array.from({length: count - 1}, (_, index) => ({...structuredClone(f.earlier),
      id: id(200 + index), revisionNumber: count - 1 - index}))];
    f.setRevisions(revisions);
    f.changeSource({...f.source, currentRevisionNumber: count});
    return {...f, latest, revisions};
  };
  const f = makeHistory(), reviewed = await plan(f, {includeSavedPublicationVersions: true});
  assert.deepEqual(reviewed.items[0].savedRevisions, f.revisions);
  assert.equal(reviewed.estimate.savedPublicationVersions, 27);
  assert.equal(reviewed.estimate.fileReads, 54);
  assert.deepEqual(f.calls.filter(call => call[0] === "revision-page"), [
    ["revision-page", sourceId, 1, undefined, true], ["revision-page", sourceId, 25, 27, true],
    ["revision-page", sourceId, 25, 2, true]]);
  const exactPage = makeHistory(26), exact = await plan(exactPage, {includeSavedPublicationVersions: true});
  assert.deepEqual(exact.items[0].savedRevisions, exactPage.revisions);
  assert.deepEqual(exactPage.calls.filter(call => call[0] === "revision-page"), [
    ["revision-page", sourceId, 1, undefined, true], ["revision-page", sourceId, 25, 26, true],
    ["revision-page", sourceId, 25, 1, true]]);
  const failed = makeHistory(), read = failed.adapter.listObservableSourceRevisionsPage;
  failed.adapter.listObservableSourceRevisionsPage = (project, source, options) => {
    if (options.beforeRevision === 2) throw new Error("Earlier metadata unavailable");
    return read(project, source, options);
  };
  const partial = await plan(failed, {includeSavedPublicationVersions: true});
  assert.deepEqual(partial.items[0].savedRevisions, failed.revisions.slice(0, 26));
  assert.ok(partial.unresolved.some(item => item.id === sourceId && item.reason === "saved-history-unavailable"));
  assert.equal(partial.exclusions.publicationSavedHistory, true);
  assert.equal(failed.calls.some(call => call[0] === "bytes" || call[0] === "revisions"), false);
});

it("preserves the exact current Publication when the older metadata page exceeds the server byte limit", async () => {
  const f = publicationHistoryFixture(), read = f.adapter.listObservableSourceRevisionsPage;
  f.adapter.listObservableSourceRevisionsPage = (project, source, options) => {
    if (options.beforeRevision !== undefined) throw Object.assign(new Error("Page exceeds 512 KiB"), {status: 409});
    assert.equal(options.limit, 1);
    return read(project, source, options);
  };
  const reviewed = await plan(f, {includeSavedPublicationVersions: true});
  assert.deepEqual(reviewed.items[0].savedRevisions, [f.latest]);
  assert.equal(reviewed.estimate.savedPublicationVersions, 1);
  assert.ok(reviewed.unresolved.some(item => item.reason === "saved-history-over-limit"));
  assert.equal(reviewed.exclusions.publicationSavedHistory, true);
  assert.equal(f.calls.some(call => call[0] === "bytes" || call[0] === "revisions"), false);
  const exported = await create(f, reviewed);
  assert.deepEqual(exported.manifest.exported.map(item => item.revisionNumber), [2]);
});

it("requires bounded Publication history metadata without invoking a legacy unbounded inventory", async () => {
  const f = publicationHistoryFixture();
  delete f.adapter.listObservableSourceRevisionsPage;
  f.adapter.listObservableSourceRevisions = () => assert.fail("History cannot use the unbounded legacy inventory");
  const reviewed = await plan(f, {includeSavedPublicationVersions: true});
  assert.equal(reviewed.items.length, 0);
  assert.ok(reviewed.unresolved.some(item => item.id === sourceId && item.reason === "saved-history-unavailable"));
  assert.equal(reviewed.exclusions.publicationSavedHistory, true);
  assert.equal(f.calls.some(call => call[0] === "bytes"), false);
  const pageFailure = publicationHistoryFixture();
  pageFailure.adapter.listObservableSourceRevisionsPage = () => {throw new Error("Bounded metadata unavailable");};
  pageFailure.adapter.listObservableSourceRevisions = () => assert.fail("Page failure cannot fall back to the legacy inventory");
  const failed = await plan(pageFailure);
  assert.equal(failed.items.length, 0);
  assert.ok(failed.unresolved.some(item => item.id === sourceId && item.reason === "revision-metadata-unavailable"));
});

it("preserves the latest Publication when older sources exceed body-read, byte or per-revision ZIP bounds", async () => {
  for (const chooseLimits of [() => ({maxFileReads: 2}),
    latestBytes => ({maxSourceBytes: latestBytes}),
    latestBytes => ({maxArchiveBytes: latestBytes + 2_097_152 + 524_288})]) {
    const f = publicationHistoryFixture(), latestBytes = f.latest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
    const reviewed = await plan(f, {includeSavedPublicationVersions: true, limits: chooseLimits(latestBytes)});
    assert.deepEqual(reviewed.items[0].savedRevisions, [f.latest]);
    assert.equal(reviewed.estimate.savedPublicationVersions, 1);
    assert.equal(reviewed.estimate.publicationArchiveCount, 1);
    assert.equal(reviewed.estimate.fileReads, 2);
    assert.ok(reviewed.estimate.sourceBytes <= reviewed.limits.maxSourceBytes);
    assert.ok(reviewed.estimate.archiveBytesUpperBound <= reviewed.limits.maxArchiveBytes);
    assert.ok(reviewed.unresolved.some(item => item.id === sourceId && item.reason === "saved-history-over-limit"));
    assert.equal(reviewed.exclusions.publicationSavedHistory, true);
    assert.equal(f.calls.some(call => call[0] === "bytes"), false);
  }
  const large = publicationHistoryFixture();
  large.setRevisions([large.latest, {...large.earlier,
    files: large.earlier.files.map((file, index) => index ? file : {...file, sizeBytes: 4_194_305})}]);
  const reviewed = await plan(large, {includeSavedPublicationVersions: true});
  assert.deepEqual(reviewed.items[0].savedRevisions, [large.latest]);
  assert.ok(reviewed.unresolved.some(item => item.reason === "saved-history-over-limit"));
});

it("cancels an older Publication source read and rejects its delayed result without a partial ZIP", async () => {
  const f = publicationHistoryFixture(), controller = new AbortController();
  const reviewed = await plan(f, {includeSavedPublicationVersions: true}), read = f.adapter.readObservableSourceRevisionFile;
  let started, finish, activeSignal;
  const active = new Promise(resolve => {started = resolve;});
  f.adapter.readObservableSourceRevisionFile = (project, source, revision, path, options) => {
    if (revision !== f.earlier.id) return read(project, source, revision, path, options);
    f.calls.push(["bytes", source, revision, path]); activeSignal = options.signal; started();
    return new Promise(resolve => {finish = resolve;});
  };
  const download = create(f, reviewed, {signal: controller.signal});
  await active; controller.abort(new DOMException("Cancelled", "AbortError"));
  await assert.rejects(download, error => error.name === "AbortError");
  assert.equal(activeSignal.aborted, true);
  finish({blob: new Blob([f.bytesByRevision.get(f.earlier.id)["index.md"]], {type: "text/markdown"})});
  assert.equal(f.calls.filter(call => call[0] === "bytes" && call[2] === f.earlier.id).length, 1);
});

it("checks current account, ownership and head for Publication history and verifies older saved bytes", async () => {
  for (const change of [f => f.changeAccount(id(112)), f => f.changeToken("replacement-session"),
    f => f.changeSource({...f.source, ownerUserId: id(113)}),
    f => f.changeSource({...f.source, currentRevisionId: id(114), currentRevisionNumber: 3})]) {
    const f = publicationHistoryFixture(), reviewed = await plan(f, {includeSavedPublicationVersions: true}); change(f);
    await assert.rejects(create(f, reviewed), /changed/);
    assert.equal(f.calls.some(call => call[0] === "bytes"), false);
  }
  const late = publicationHistoryFixture(), reviewed = await plan(late, {includeSavedPublicationVersions: true});
  const read = late.adapter.readObservableSourceRevisionFile;
  late.adapter.readObservableSourceRevisionFile = async (...args) => {
    const result = await read(...args);
    if (args[2] === late.earlier.id) late.changeSource({...late.source, currentRevisionId: id(115)});
    return result;
  };
  await assert.rejects(create(late, reviewed), /ownership or version changed/);
  const corrupt = publicationHistoryFixture(), next = await plan(corrupt, {includeSavedPublicationVersions: true});
  const load = corrupt.adapter.readObservableSourceRevisionFile;
  corrupt.adapter.readObservableSourceRevisionFile = (...args) => args[2] !== corrupt.earlier.id ? load(...args)
    : {blob: new Blob([new Uint8Array(corrupt.earlier.files.find(file => file.relativePath === args[3]).sizeBytes)],
      {type: corrupt.earlier.files.find(file => file.relativePath === args[3]).contentType})};
  await assert.rejects(create(corrupt, next), /checksum changed/);
});

function projectFixture({onlyProjects = false} = {}) {
  const f = fixture(), compositionId = id(12), archivedId = id(13);
  const definition = {schemaVersion: "opengeo.map-definition.1.0.0", renderer: "maplibre",
    view: {center: [85.3, 27.7], zoom: 8.25, bearing: 14},
    layers: [{id: id(20), datasetId: id(21), visible: false, opacity: 0.4,
      styleReference: {id: id(22), version: 3}, sourceSnapshot: {url: "https://example.test/wfs", version: 6}}],
    extension: {unknown: null, label: "Retain 田\r\n", nested: [{flag: true, zero: 0}]}};
  const composition = {id: compositionId, resourceType: "project", accessContainerId: projectId,
    name: "Saved composition", description: "Private source", ownerUserId, status: "active", version: 4,
    updatedAt: "2026-10-07T12:05:00Z"};
  // The saved version's creator may be a teammate; the authoritative current owner is separate.
  const saved = {version: 4, definitionBytes: new TextEncoder().encode(JSON.stringify(definition)).length + 32,
    createdBy: id(30), createdAt: composition.updatedAt, changeMessage: "Retain source"};
  let compositions = [composition, {...composition, id: archivedId, status: "archived", name: "Archived composition"},
    {...composition, id: id(14), ownerUserId: id(31), createdBy: ownerUserId, canManage: true},
    {...composition, id: id(15), ownerUserId: null, createdBy: ownerUserId, canManage: true}];
  f.adapter.listCompositions = async options => {
    f.calls.push(["compositions", options.status, options.offset, Boolean(options.signal)]);
    return compositions.slice(options.offset, options.offset + options.limit);
  };
  f.adapter.listCompositionVersions = async (composition, options) => {
    f.calls.push(["project-versions", composition, options.limit, Boolean(options.signal)]); return [saved];
  };
  f.adapter.getCompositionVersion = async (composition, version, options) => {
    f.calls.push(["definition", composition, version, Boolean(options.signal)]);
    return structuredClone({...saved, definition});
  };
  f.adapter.getComposition = () => assert.fail("Do not repeatedly read full current definitions for head checks");
  if (onlyProjects) f.adapter.listObservableSourceProjects = async () => [];
  return {...f, composition, definition, saved, compositionId, archivedId,
    setCompositions: value => {compositions = value;},
    changeComposition: changes => {compositions = compositions.map(value => value.id === compositionId ? {...value, ...changes} : value);}};
}

it("exports owned active and archived saved Projects beside exact Publication sources without linked data reads", async t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("No GIS capture, provider or direct storage requests"));
  const f = projectFixture(), reviewed = await plan(f);
  assert.deepEqual(reviewed.items.map(item => item.kind), ["publication-source", "project", "project"]);
  assert.equal(reviewed.estimate.projectDefinitionBytes, f.saved.definitionBytes * 2);
  assert.equal(reviewed.estimate.publicationSourceBytes, exactText.length + binary.length);
  assert.equal(reviewed.estimate.sourceBytes, exactText.length + binary.length + f.saved.definitionBytes * 2);
  assert.equal(reviewed.estimate.fileReads, 2);
  assert.equal(reviewed.estimate.projectDefinitionReads, 2);
  assert.equal(reviewed.estimate.savedMapVersions, 2);
  assert.equal(reviewed.estimate.downloadMetadataRequests, 6);
  assert.equal(reviewed.exclusions.projectDefinitions, false);
  assert.equal(reviewed.exclusions.projectSavedHistory, true);
  assert.deepEqual(reviewed.items.filter(item => item.kind === "project").map(item => item.savedVersions), [[f.saved], [f.saved]]);
  assert.equal(reviewed.complete, false);
  assert.deepEqual(reviewed.unresolved, [{kind: "project", id: id(15), title: "Saved composition", reason: "canonical-project-owner-unavailable"}]);
  assert.deepEqual(f.calls.filter(call => call[0] === "project-versions").map(call => call.slice(1)), [
    [f.compositionId, 1, true], [f.archivedId, 1, true]]);
  assert.equal(f.calls.some(call => call[0] === "definition" || call[0] === "bytes"), false);
  const exported = await create(f, reviewed), outer = unzipSync(new Uint8Array(await exported.blob.arrayBuffer()));
  assert.equal(exported.filename, `opengeo-saved-content-${accountId}.zip`);
  assert.equal(exported.manifest.exported.length, 3);
  for (const record of exported.manifest.exported.filter(item => item.kind === "project")) {
    const text = strFromU8(outer[record.path]), snapshot = JSON.parse(text);
    assert.equal(record.path, `projects/${record.id}/saved-project.json`);
    assert.equal(identifyProjectFileFormat(text), "opengeo-managed");
    assert.equal(snapshot.schemaVersion, "opengeo.project-version.1.0.0");
    assert.equal(snapshot.resourceType, "project");
    assert.equal(snapshot.projectId, record.id);
    assert.equal(snapshot.version, 4);
    assert.deepEqual(snapshot.history, {createdAt: f.saved.createdAt, createdBy: f.saved.createdBy, changeMessage: f.saved.changeMessage});
    assert.equal(snapshot.content, "saved-definition");
    assert.equal(snapshot.accessIncluded, false);
    assert.equal(snapshot.dependenciesBundled, false);
    assert.deepEqual(snapshot.definition, f.definition);
    assert.deepEqual(snapshot.savedVersion, f.saved);
    assert.equal(snapshot.project.ownerUserId, ownerUserId);
    assert.equal(snapshot.project.version, 4);
    assert.equal(snapshot.grantsIncluded, false);
    assert.equal(snapshot.linkedBytesIncluded, false);
    assert.equal(snapshot.definitionChecksumSha256, sha(new TextEncoder().encode(JSON.stringify(f.definition))));
    assert.equal(record.checksumSha256, sha(outer[record.path]));
  }
  assert.equal(f.calls.filter(call => call[0] === "definition").length, 2);
  assert.equal(f.calls.filter(call => call[0] === "bytes").length, 2);
  assert.equal(f.calls.some(call => call[0] === "definition" && [id(14), id(15)].includes(call[1])), false);
  assert.equal(exported.manifest.exclusions.linkedBytes, true);
  assert.equal(exported.manifest.exclusions.savedHistory, true);
});

it("downloads Project-only saved work and keeps ownerless or editable teammate maps unresolved or outside the owner selection", async () => {
  const f = projectFixture({onlyProjects: true}), reviewed = await plan(f);
  assert.equal(reviewed.items.length, 2);
  assert.equal(reviewed.estimate.fileReads, 0);
  assert.equal(reviewed.estimate.downloadMetadataRequests, 4);
  const exported = await create(f, reviewed);
  assert.deepEqual(exported.manifest.exported.map(item => item.kind), ["project", "project"]);
  assert.equal(f.calls.some(call => call[0] === "bytes" || call[0] === "revisions"), false);
});

function projectHistoryFixture({count = 27, withPublication = false} = {}) {
  const f = projectFixture({onlyProjects: !withPublication});
  const definitions = new Map(), versions = Array.from({length: count}, (_, index) => {
    const version = count - index, definition = structuredClone(f.definition);
    definition.view.zoom = version / 2;
    definition.layers[0].styleReference.version = version % 3 + 1;
    definition.extension.savedAtVersion = version;
    definitions.set(version, definition);
    return {...f.saved, version, createdAt: `2026-10-07T12:${String(version).padStart(2, "0")}:00Z`,
      definitionBytes: new TextEncoder().encode(JSON.stringify(definition)).length + 32,
      changeMessage: `Saved change ${version}`};
  });
  const composition = {...f.composition, version: count, updatedAt: versions[0].createdAt};
  f.setCompositions([composition]);
  f.adapter.listCompositionVersions = async (compositionId, options) => {
    f.calls.push(["project-versions", compositionId, options.limit, options.beforeVersion, Boolean(options.signal)]);
    return structuredClone(versions.filter(value => options.beforeVersion === undefined || value.version < options.beforeVersion)
      .slice(0, options.limit));
  };
  f.adapter.getCompositionVersion = async (compositionId, version, options) => {
    f.calls.push(["definition", compositionId, version, Boolean(options.signal)]);
    return structuredClone({...versions.find(value => value.version === version), definition: definitions.get(version)});
  };
  return {...f, composition, versions, definitions, saved: versions[0], definition: definitions.get(count)};
}

it("deliberately paginates saved map history and exports distinct exact-version snapshots with pinned references", async t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Saved history never reads linked GIS or provider data"));
  const f = projectHistoryFixture(), reviewed = await plan(f, {includeSavedMapVersions: true});
  assert.equal(reviewed.items.length, 1);
  assert.deepEqual(reviewed.items[0].savedVersions, f.versions);
  assert.equal(reviewed.items[0].version, 27);
  assert.deepEqual(reviewed.items[0].savedVersion, f.saved);
  assert.equal(reviewed.estimate.projectDefinitionReads, 27);
  assert.equal(reviewed.estimate.savedMapVersions, 27);
  assert.equal(reviewed.estimate.fileReads, 0);
  assert.equal(reviewed.estimate.projectDefinitionBytes, f.versions.reduce((sum, value) => sum + value.definitionBytes, 0));
  assert.equal(reviewed.exclusions.projectSavedHistory, false);
  assert.equal(reviewed.exclusions.savedHistory, true);
  assert.deepEqual(reviewed.unresolved, []);
  assert.deepEqual(f.calls.filter(call => call[0] === "project-versions").map(call => call.slice(1)), [
    [f.compositionId, 25, undefined, true], [f.compositionId, 25, 3, true]]);
  assert.equal(f.calls.some(call => call[0] === "definition" || call[0] === "bytes"), false);
  const exported = await create(f, reviewed), outer = unzipSync(new Uint8Array(await exported.blob.arrayBuffer()));
  assert.equal(exported.manifest.exported.length, 27);
  for (const record of exported.manifest.exported) {
    const retained = f.versions.find(value => value.version === record.version), text = strFromU8(outer[record.path]);
    const snapshot = JSON.parse(text), definition = f.definitions.get(record.version);
    assert.equal(record.path, record.version === 27 ? `projects/${f.compositionId}/saved-project.json`
      : `projects/${f.compositionId}/versions/v${record.version}.opengeo-project.json`);
    assert.equal(identifyProjectFileFormat(text), "opengeo-managed");
    assert.equal(snapshot.projectId, f.compositionId);
    assert.equal(snapshot.version, retained.version);
    assert.deepEqual(snapshot.savedVersion, retained);
    assert.deepEqual(snapshot.history, {createdAt: retained.createdAt, createdBy: retained.createdBy, changeMessage: retained.changeMessage});
    assert.deepEqual(snapshot.definition, definition);
    assert.equal(snapshot.definitionChecksumSha256, sha(new TextEncoder().encode(JSON.stringify(definition))));
    assert.equal(record.checksumSha256, sha(outer[record.path]));
    assert.equal(snapshot.grantsIncluded, false);
    assert.equal(snapshot.linkedBytesIncluded, false);
  }
  assert.deepEqual(f.calls.filter(call => call[0] === "definition").map(call => call[2]), f.versions.map(value => value.version));
  assert.equal(exported.manifest.exclusions.projectSavedHistory, false);
  assert.equal(exported.manifest.exclusions.savedHistory, true);
});

it("preserves the reviewed latest map when older history exceeds shared read, byte or metadata limits", async () => {
  for (const limit of [f => ({maxFileReads: 2}), f => ({maxSourceBytes: f.saved.definitionBytes}),
    f => ({maxMetadataRequests: 4})]) {
    const f = projectHistoryFixture(), limits = limit(f);
    const reviewed = await plan(f, {includeSavedMapVersions: true, limits});
    assert.equal(reviewed.items.length, 1);
    assert.deepEqual(reviewed.items[0].savedVersions[0], f.saved);
    assert.ok(reviewed.items[0].savedVersions.length < f.versions.length);
    assert.ok(reviewed.unresolved.some(item => item.id === f.compositionId && item.reason === "saved-history-over-limit"));
    assert.equal(reviewed.exclusions.projectSavedHistory, true);
    assert.ok(reviewed.estimate.fileReads + reviewed.estimate.projectDefinitionReads <= reviewed.limits.maxFileReads);
    assert.ok(reviewed.estimate.sourceBytes <= reviewed.limits.maxSourceBytes);
    assert.ok(reviewed.estimate.metadataRequests <= reviewed.limits.maxMetadataRequests);
    assert.ok(reviewed.estimate.downloadMetadataRequests <= reviewed.limits.maxMetadataRequests);
    assert.equal(f.calls.some(call => call[0] === "definition" || call[0] === "bytes"), false);
  }
  const shared = projectHistoryFixture({count: 3, withPublication: true});
  const reviewed = await plan(shared, {includeSavedMapVersions: true, limits: {maxFileReads: 3}});
  assert.equal(reviewed.estimate.fileReads, 2);
  assert.equal(reviewed.estimate.projectDefinitionReads, 1);
  assert.deepEqual(reviewed.items.find(item => item.kind === "project").savedVersions, [shared.saved]);
  assert.ok(reviewed.unresolved.some(item => item.id === shared.compositionId && item.reason === "saved-history-over-limit"));
});

it("retains known latest and earlier metadata when another history page is unavailable or invalid", async () => {
  for (const olderPage of [() => {throw new Error("Older history is unavailable");},
    f => [f.versions[24], f.versions[25]]]) {
    const f = projectHistoryFixture(), read = f.adapter.listCompositionVersions;
    f.adapter.listCompositionVersions = (compositionId, options) => options.beforeVersion === undefined
      ? read(compositionId, options) : olderPage(f);
    const reviewed = await plan(f, {includeSavedMapVersions: true});
    assert.deepEqual(reviewed.items[0].savedVersions, f.versions.slice(0, 25));
    assert.deepEqual(reviewed.items[0].savedVersion, f.saved);
    assert.ok(reviewed.unresolved.some(item => item.id === f.compositionId && item.reason === "saved-history-unavailable"));
    assert.equal(reviewed.exclusions.projectSavedHistory, true);
    assert.equal(f.calls.some(call => call[0] === "definition"), false);
  }
});

it("checks current ownership and head for history and rejects altered older immutable metadata", async () => {
  for (const change of [{ownerUserId: id(45)}, {version: 4}]) {
    const f = projectHistoryFixture({count: 3}), reviewed = await plan(f, {includeSavedMapVersions: true});
    f.changeComposition(change);
    await assert.rejects(create(f, reviewed), /ownership or version changed/);
    assert.equal(f.calls.some(call => call[0] === "definition"), false);
  }
  const changed = projectHistoryFixture({count: 3}), reviewed = await plan(changed, {includeSavedMapVersions: true});
  const read = changed.adapter.getCompositionVersion;
  changed.adapter.getCompositionVersion = async (...args) => {
    const saved = await read(...args);
    return args[1] === 2 ? {...saved, createdBy: id(46)} : saved;
  };
  await assert.rejects(create(changed, reviewed), /version changed/);
  assert.deepEqual(changed.calls.filter(call => call[0] === "definition").map(call => call[2]), [3, 2]);
  const late = projectHistoryFixture({count: 3}), next = await plan(late, {includeSavedMapVersions: true});
  const load = late.adapter.getCompositionVersion;
  late.adapter.getCompositionVersion = async (...args) => {
    const saved = await load(...args);
    if (args[1] === 1) late.changeComposition({ownerUserId: id(47)});
    return saved;
  };
  await assert.rejects(create(late, next), /ownership or version changed/);
});

it("cancels an older saved map definition and stops remaining version reads and archive delivery", async () => {
  const f = projectHistoryFixture({count: 3}), controller = new AbortController();
  const reviewed = await plan(f, {includeSavedMapVersions: true});
  const read = f.adapter.getCompositionVersion;
  let started, finish, activeSignal;
  const active = new Promise(resolve => {started = resolve;});
  f.adapter.getCompositionVersion = (compositionId, version, options) => {
    if (version !== 2) return read(compositionId, version, options);
    f.calls.push(["definition", compositionId, version]); activeSignal = options.signal; started();
    return new Promise(resolve => {finish = resolve;});
  };
  const download = create(f, reviewed, {signal: controller.signal});
  await active; controller.abort(new DOMException("Cancelled", "AbortError"));
  await assert.rejects(download, error => error.name === "AbortError");
  assert.equal(activeSignal.aborted, true);
  finish({...f.versions[1], definition: f.definitions.get(2)});
  assert.deepEqual(f.calls.filter(call => call[0] === "definition").map(call => call[2]), [3, 2]);
});

it("cancels pending history pagination without accepting its delayed older metadata", async () => {
  const f = projectHistoryFixture(), controller = new AbortController(), read = f.adapter.listCompositionVersions;
  let started, finish, activeSignal;
  const active = new Promise(resolve => {started = resolve;});
  f.adapter.listCompositionVersions = (compositionId, options) => {
    if (options.beforeVersion === undefined) return read(compositionId, options);
    activeSignal = options.signal; started();
    return new Promise(resolve => {finish = resolve;});
  };
  const reviewed = plan(f, {includeSavedMapVersions: true, signal: controller.signal});
  await active; controller.abort(new DOMException("Cancelled", "AbortError"));
  await assert.rejects(reviewed, error => error.name === "AbortError");
  assert.equal(activeSignal.aborted, true);
  finish(f.versions.slice(25));
  assert.equal(f.calls.some(call => call[0] === "definition" || call[0] === "bytes"), false);
});

it("stops before saved Project reads when its owner, head, status, access container or reviewed account changes", async () => {
  for (const change of [f => f.changeComposition({ownerUserId: id(40)}), f => f.changeComposition({ownerUserId: null}),
    f => f.changeComposition({version: 5}), f => f.changeComposition({status: "archived"}),
    f => f.changeComposition({accessContainerId: id(41)}), f => f.changeComposition({updatedAt: "2026-10-07T12:06:00Z"}),
    f => f.setCompositions([]), f => f.changeAccount(id(42)), f => f.changeToken("new-session")]) {
    const f = projectFixture({onlyProjects: true}), reviewed = await plan(f); change(f);
    await assert.rejects(create(f, reviewed), /changed/);
    assert.equal(f.calls.some(call => call[0] === "definition"), false);
  }
});

it("rejects late Project ownership changes, mismatched immutable metadata and bodies exceeding the reviewed bound", async () => {
  const late = projectFixture({onlyProjects: true}), reviewed = await plan(late), read = late.adapter.getCompositionVersion;
  late.adapter.getCompositionVersion = async (...args) => {
    const loaded = await read(...args); late.changeComposition({ownerUserId: id(43)}); return loaded;
  };
  await assert.rejects(create(late, reviewed), /ownership or version changed/);
  for (const changed of [{version: 5}, {createdBy: id(44)}, {definitionBytes: 524_289},
    {definition: {oversized: "x".repeat(524_288)}}, {definition: {content: "x".repeat(1000)}}]) {
    const f = projectFixture({onlyProjects: true}), next = await plan(f);
    f.adapter.getCompositionVersion = async () => ({...f.saved, definition: f.definition, ...changed});
    await assert.rejects(create(f, next), /version changed|definition exceeds/);
  }
});

it("records unavailable or over-limit saved Project metadata without fetching its definition", async () => {
  for (const versions of [[], [{version: 3}], [{version: 4, definitionBytes: 524_289}],
    Array.from({length: 2}, () => ({version: 4}))]) {
    const f = projectFixture({onlyProjects: true}); f.adapter.listCompositionVersions = async () => versions;
    const reviewed = await plan(f);
    assert.equal(reviewed.items.length, 0);
    assert.ok(reviewed.unresolved.some(item => item.reason === "saved-head-unavailable"));
    assert.equal(f.calls.some(call => call[0] === "definition"), false);
  }
  const unavailable = projectFixture({onlyProjects: true});
  unavailable.adapter.listCompositionVersions = async () => {throw new Error("Not available");};
  const unresolved = await plan(unavailable);
  assert.ok(unresolved.unresolved.some(item => item.reason === "revision-metadata-unavailable"));
  const small = projectFixture({onlyProjects: true}), limit = await plan(small, {limits: {maxSourceBytes: 1}});
  assert.equal(limit.items.length, 0);
  assert.ok(limit.unresolved.some(item => item.reason === "byte-or-read-limit"));
  const fewer = await plan(small, {limits: {maxItems: 1}});
  assert.equal(fewer.items.length, 1);
  assert.ok(fewer.unresolved.some(item => item.id === small.archivedId && item.reason === "item-limit"));
});

it("cancels an active saved Project request and rejects its delayed result without delivering an archive", async () => {
  const f = projectFixture({onlyProjects: true}), controller = new AbortController(), reviewed = await plan(f);
  let started, finish, activeSignal;
  const active = new Promise(resolve => {started = resolve;});
  f.adapter.getCompositionVersion = (composition, version, {signal}) => {
    f.calls.push(["definition", composition]); activeSignal = signal; started();
    return new Promise(resolve => {finish = resolve;});
  };
  const download = create(f, reviewed, {signal: controller.signal});
  await active; controller.abort(new DOMException("Cancelled", "AbortError"));
  await assert.rejects(download, error => error.name === "AbortError");
  assert.equal(activeSignal.aborted, true);
  finish({...f.saved, definition: f.definition});
  assert.equal(f.calls.filter(call => call[0] === "definition").length, 1);
});

it("bounds changed Project inventory pagination to the reviewed application-read estimate", async () => {
  const f = projectFixture({onlyProjects: true}), reviewed = await plan(f);
  f.setCompositions(Array.from({length: 150}, (_, index) => ({...f.composition, id: id(1000 + index)})));
  await assert.rejects(create(f, reviewed), /metadata request limit reached/);
  assert.equal(f.calls.filter(call => call[0] === "compositions").length, 5);
  assert.equal(f.calls.some(call => call[0] === "definition"), false);
});

it("stops before transfer when ownership, account, session or saved head changes", async () => {
  for (const change of [f => f.changeAccount(id(80)), f => f.changeToken("session-2"),
    f => f.changeSource({...f.source, ownerUserId: id(81)}),
    f => f.changeSource({...f.source, currentRevisionId: id(82)})]) {
    const f = fixture(), reviewed = await plan(f); change(f);
    await assert.rejects(create(f, reviewed), /changed/);
    assert.equal(f.calls.some(call => call[0] === "bytes"), false);
  }
});

it("cancel aborts the active source request and stops subsequent reads and archive delivery", async () => {
  const f = fixture(), controller = new AbortController(), reviewed = await plan(f);
  let started, activeSignal;
  const active = new Promise(resolve => {started = resolve;});
  f.adapter.readObservableSourceRevisionFile = (project, source, retained, path, {signal}) => {
    f.calls.push(["bytes", path]); activeSignal = signal; started();
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once: true}));
  };
  const download = create(f, reviewed, {signal: controller.signal});
  await active; controller.abort(new DOMException("Cancelled", "AbortError"));
  await assert.rejects(download, error => error.name === "AbortError");
  assert.equal(activeSignal.aborted, true);
  assert.equal(f.calls.filter(call => call[0] === "bytes").length, 1);
});

it("rejects corrupted saved bytes and a late ownership change without returning a partial archive", async () => {
  const corrupt = fixture(), reviewed = await plan(corrupt);
  corrupt.adapter.readObservableSourceRevisionFile = async () => ({blob: new Blob([new Uint8Array(exactText.length)], {type: "text/markdown"})});
  await assert.rejects(create(corrupt, reviewed), /checksum/);
  const late = fixture(), next = await plan(late), original = late.adapter.readObservableSourceRevisionFile;
  late.adapter.readObservableSourceRevisionFile = async (...args) => {
    const loaded = await original(...args); late.changeSource({...late.source, ownerUserId: id(83)}); return loaded;
  };
  await assert.rejects(create(late, next), /ownership or version changed/);
});

it("retains excessive source and revision inventories as unresolved before any source-body read", async () => {
  const sources = fixture();
  sources.adapter.listObservableSourceProjects = async () => Array.from({length: 201}, (_, index) => ({
    ...sources.source, id: id(1000 + index)}));
  const oversizedSources = await plan(sources);
  assert.equal(oversizedSources.items.length, 0);
  assert.ok(oversizedSources.unresolved.some(item => item.reason === "source-inventory-over-limit"));
  const revisions = fixture();
  revisions.adapter.listObservableSourceRevisions = async () => Array.from({length: 101}, () => revisions.revision);
  const oversizedRevisions = await plan(revisions);
  assert.equal(oversizedRevisions.items.length, 0);
  assert.ok(oversizedRevisions.unresolved.some(item => item.reason === "revision-inventory-over-limit"));
  assert.equal(revisions.calls.some(call => call[0] === "bytes"), false);
});

it("cancels pending metadata discovery and rejects stale page results without any source-body read", async () => {
  const f = fixture(), controller = new AbortController();
  let started, finish;
  const active = new Promise(resolve => {started = resolve;});
  f.adapter.listProjects = () => {started(); return new Promise(resolve => {finish = resolve;});};
  const reviewed = plan(f, {signal: controller.signal});
  await active; controller.abort(new DOMException("Cancelled", "AbortError"));
  await assert.rejects(reviewed, error => error.name === "AbortError");
  finish([{id: projectId}]);
  assert.equal(f.calls.some(call => call[0] === "sources" || call[0] === "bytes"), false);
});
