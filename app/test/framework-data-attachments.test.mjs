import assert from "node:assert/strict";
import {afterEach, beforeEach, it} from "node:test";
import {JSDOM} from "jsdom";
import {FrameworkDataAttachments} from "../src/components/FrameworkDataAttachments.js";
import {FrameworkRevisionData} from "../src/components/FrameworkRevisionData.js";
import {OpenGeoApiClient, parseObservableDataAttachment, normalizeObservableRevisionAttachments, observablePublicFileCandidates} from "../src/lib/apiClient.js";

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const wire = () => ({id: id(1), source_project_id: id(2), dataset_id: id(3), dataset_version_id: id(4),
  data_object_id: id(5), s3_version_id: "exact-storage-version", checksum_sha256: "a".repeat(64),
  size_bytes: 18930972, content_type: "application/geo+json", created_by: id(6), created_at: "2026-09-09T10:00:00Z",
  available: true, revision_bound: false, build_input: false, publication_authorized: false});
const versionRecord = (number = 4) => ({id: id(number), state: "active", versionNumber: number,
  createdAt: "2026-09-09T10:00:00Z", objects: [{id: id(5), filename: "water.geojson", contentType: "application/geo+json",
    sizeBytes: 18930972, checksumSha256: "a".repeat(64)}]});
let dom, previous;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>");
  previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {configurable: true, value: dom.window.document});
});
afterEach(() => {
  if (previous) Object.defineProperty(globalThis, "document", previous);
  else delete globalThis.document;
  dom.window.close();
});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };

it('uses explicit reload metadata for preview recovery without changing draft paths', async () => {
  const pin = parseObservableDataAttachment(wire());
  const bindings = [{attachmentId: pin.id, relativePath: 'src/data/water.geojson'}];
  let inventories = 0, reloads = 0, changes = 0;
  const state = {project: {id: id(7)}, datasets: [], adapter: {
    listObservableDataAttachments: async () => {inventories++; return [pin];}
  }};
  const component = FrameworkRevisionData({state, sourceProject: {id: id(2)},
    getBindings: () => bindings, getFiles: () => [], isLocked: () => false,
    onChange: () => {changes++;}, onReload: async records => {reloads++; assert.deepEqual(records, [pin]);}});
  document.body.append(component.element);
  component.element.open = true;
  await tick(); await tick();
  assert.deepEqual({inventories, reloads, changes}, {inventories: 1, reloads: 0, changes: 0});
  click(component.element, 'Reload registered files');
  await tick(); await tick();
  assert.deepEqual({inventories, reloads, changes}, {inventories: 2, reloads: 1, changes: 0});
  assert.equal(component.element.querySelector('[aria-label="Archive file path 1"]').value, bindings[0].relativePath);
});

for (const [filename, contentType, expected] of [
  ["population.pdf", "application/pdf", /page references.*accessible text preview.*notebook table/i],
  ["population.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", /sheets, units, dates.*not parsed.*CSV or JSON/i],
  ["census.png", "image/png", /description or transcription.*machine-readable values/i]
]) {
  it(`reviews nonspatial ${filename} without connecting or fetching its contents`, async () => {
    let objectReads = 0;
    const version = versionRecord();
    version.objects[0] = {...version.objects[0], filename, contentType};
    const {root, registrations} = setup({adapter: {
      listDatasetVersions: async () => [version],
      requestDatasetDownload: async () => { objectReads++; throw Error("unexpected source read"); }
    }});
    change(root, "Dataset", id(3)); await tick();
    change(root, "Dataset version", id(4));
    change(root, "Archived file", id(5));
    const review = root.querySelector('a');
    assert.equal(review.textContent, "Review in Catalog (new tab)");
    assert.equal(review.getAttribute("href"), `/layers?id=${id(3)}`);
    assert.equal(review.target, "_blank");
    assert.equal(review.rel, "noopener noreferrer");
    assert.match(root.textContent, expected);
    assert.equal(registrations.length, 0);
    assert.equal(objectReads, 0);
    change(root, "Archived file", "");
    assert.equal(root.querySelector('a'), null);
  });
}
function setup({adapter = {}, canManage = true, datasets} = {}) {
  const registrations = [], reads = [], bodyReads = [];
  const state = {project: {id: id(7)}, datasets: datasets ?? [{id: id(3), name: "Water", status: "active", classification: "internal", capabilities: {download: true}}],
    adapter: {listObservableDataAttachments: async () => { reads.push(true); return []; },
      listDatasetVersions: async () => [versionRecord()],
      requestDatasetDownload: async (...args) => { bodyReads.push(args); throw Error("unexpected source read"); },
      registerObservableDataAttachment: async (...args) => { registrations.push(args); return parseObservableDataAttachment(wire()); }, ...adapter}};
  const root = FrameworkDataAttachments({state, sourceProject: {id: id(2)}, canManage});
  document.body.append(root);
  return {root, registrations, reads, bodyReads};
}
function change(root, label, value) {
  const control = root.querySelector(`[aria-label="${label}"]`);
  control.value = value;
  control.dispatchEvent(new dom.window.Event("change"));
}
function click(root, label) { [...root.querySelectorAll("button")].find(item => item.textContent === label).click(); }
async function choose(root) {
  change(root, "Dataset", id(3)); await tick();
  change(root, "Dataset version", id(4));
  change(root, "Archived file", id(5));
}

it("parses immutable facts and rejects forged authority, storage fields and invalid pins", () => {
  assert.equal(parseObservableDataAttachment(wire()).sizeBytes, 18930972);
  for (const change of [{revision_bound: true}, {build_input: true}, {publication_authorized: true}, {bucket: "private"},
    {s3_version_id: "null"}, {s3_version_id: ""}, {checksum_sha256: "not-a-hash"}, {size_bytes: Number.MAX_SAFE_INTEGER + 1}]) {
    assert.throws(() => parseObservableDataAttachment({...wire(), ...change}));
  }
});

it("validates archived paths before upload and detects nonadjacent directory collisions", async () => {
  const binding = path => ({attachmentId: id(1), relativePath: path});
  assert.deepEqual(normalizeObservableRevisionAttachments([binding("data/z.csv"), binding("data/a.csv")]), [binding("data/a.csv"), binding("data/z.csv")]);
  for (const path of ["package.json", "src/package-lock.json", "data/run.js", "../water.geojson"]) {
    assert.throws(() => normalizeObservableRevisionAttachments([binding(path)]));
  }
  assert.throws(() => normalizeObservableRevisionAttachments([binding("data/a.csv")], [
    {relativePath: "data/a.csv-extra"}, {relativePath: "DATA/a.csv/child.csv"}
  ]), /collide/);
  let calls = 0;
  const client = new OpenGeoApiClient({tokenProvider: () => "test", organizationProvider: () => id(9),
    fetchImplementation: async () => { calls++; throw new Error("unexpected network"); }});
  await assert.rejects(client.saveObservableSourceRevision(id(7), id(2), {
    files: [{relativePath: "src/index.md", contentType: "text/markdown", blob: new Blob(["# Source"])}],
    dataAttachments: [binding("src/index.md")]
  }));
  assert.equal(calls, 0);
});

it("sends only identity fields and checks response source and object identities", async () => {
  const calls = [];
  let response = wire();
  const client = new OpenGeoApiClient({tokenProvider: () => "test-token", organizationProvider: () => id(8), fetchImplementation: async (url, init) => {
    calls.push({url, init});
    return new Response(JSON.stringify(init.method === "POST" ? response : [response]), {status: 200, headers: {"Content-Type": "application/json"}});
  }});
  const selection = {datasetId: id(3), datasetVersionId: id(4), dataObjectId: id(5), bucket: "ignored", sizeBytes: 1};
  await client.registerObservableDataAttachment(id(7), id(2), selection);
  assert.deepEqual(JSON.parse(calls[0].init.body), {dataset_id: id(3), dataset_version_id: id(4), data_object_id: id(5)});
  assert.match(calls[0].url, /source-projects\/00000000-0000-4000-8000-000000000002\/data-attachments$/);
  assert.equal((await client.listObservableDataAttachments(id(7), id(2))).length, 1);
  response = {...wire(), source_project_id: id(99)};
  await assert.rejects(client.listObservableDataAttachments(id(7), id(2)), /scope/);
  response = {...wire(), data_object_id: id(99)};
  await assert.rejects(client.registerObservableDataAttachment(id(7), id(2), selection), /identity/);
});

it("performs no read until opened and no registration until the explicit action", async () => {
  const {root, registrations, reads, bodyReads} = setup();
  assert.equal(reads.length, 0);
  assert.equal(bodyReads.length, 0);
  root.open = true; await tick(); await tick();
  assert.equal(reads.length, 1);
  await choose(root);
  assert.equal(registrations.length, 0);
  assert.match(root.textContent, /18,930,972 bytes/);
  assert.match(root.textContent, /application\/geo\+json/);
  assert.match(root.textContent, new RegExp("a".repeat(64)));
  assert.equal(root.querySelector('a').getAttribute('href'), `/layers?id=${id(3)}`);
  click(root, "Connect file"); await tick();
  assert.deepEqual(registrations[0], [id(7), id(2), {datasetId: id(3), datasetVersionId: id(4), dataObjectId: id(5)}]);
  assert.equal(registrations.length, 1);
  assert.match(root.textContent, /File connected\. Its existing archive is reused/);
  assert.equal(bodyReads.length, 0);
});

it("reopens registered facts with current unavailable status, without hiding the history", async () => {
  const {root} = setup({canManage: false, adapter: {listObservableDataAttachments: async () => [parseObservableDataAttachment({...wire(), available: false})]}});
  click(root, "Reload references"); await tick();
  assert.match(root.textContent, /18,930,972 bytes · Unavailable/);
  assert.match(root.textContent, /exact-storage-version/);
  assert.equal(root.querySelector("fieldset"), null);
});

it("does not offer unavailable datasets or an empty successful list when the server fails", async () => {
  const {root, registrations, bodyReads} = setup({datasets: [{id: id(3), status: "active", capabilities: {download: false}}],
    adapter: {listObservableDataAttachments: async () => { throw new Error("404"); }}});
  click(root, "Reload references"); await tick();
  assert.match(root.textContent, /server may need the archive-reference update/);
  assert.doesNotMatch(root.textContent, /No archived files registered/);
  assert.deepEqual([...root.querySelector('[aria-label="Dataset"]').options].map(item => item.value), [""]);
  assert.equal(root.querySelector('[aria-label="Dataset version"]').disabled, true);
  assert.equal(root.querySelector('[aria-label="Archived file"]').disabled, true);
  assert.equal([...root.querySelectorAll("button")].find(item => item.textContent === "Connect file").disabled, true);
  assert.equal(registrations.length, 0);
  assert.equal(bodyReads.length, 0);
});

it("ignores late version responses after changing datasets", async () => {
  const pending = deferred();
  const datasets = [3, 8].map(number => ({id: id(number), name: String(number), status: "active", capabilities: {download: true}}));
  const {root} = setup({datasets, adapter: {listDatasetVersions: async (_, datasetId) => datasetId === id(3) ? pending.promise : [versionRecord(9)]}});
  change(root, "Dataset", id(3));
  change(root, "Dataset", id(8)); await tick();
  pending.resolve([versionRecord(4)]); await tick();
  const versions = [...root.querySelector('[aria-label="Dataset version"]').options].map(item => item.value);
  assert.deepEqual(versions, ["", id(9)]);
});

it("pages versions explicitly and retains choices from earlier pages", async () => {
  const pages = [];
  const {root} = setup({adapter: {listDatasetVersions: async (_, __, page) => {
    pages.push(page);
    return page.offset ? [versionRecord(90)] : Array.from({length: 50}, (_, index) => versionRecord(index + 10));
  }}});
  change(root, "Dataset", id(3)); await tick();
  click(root, "Load more versions"); await tick();
  assert.deepEqual(pages.map(page => page.offset), [0, 50]);
  assert.equal(root.querySelector('[aria-label="Dataset version"]').options.length, 52);
});

it("locks selection and suppresses duplicate registration while awaiting the response", async () => {
  const pending = deferred(); let writes = 0;
  const {root} = setup({adapter: {registerObservableDataAttachment: async () => { writes++; return pending.promise; }}});
  await choose(root);
  click(root, "Connect file"); click(root, "Connect file");
  assert.equal(writes, 1);
  assert.equal(root.querySelector("fieldset").disabled, true);
  pending.resolve(parseObservableDataAttachment(wire())); await tick();
  assert.equal(root.querySelector("fieldset").disabled, false);
});

it("preserves confirmed registration when explicit list refresh fails and reloads without another write", async () => {
  let reads = 0;
  const {root, registrations} = setup({adapter: {listObservableDataAttachments: async () => {
    if (++reads === 1) throw new Error("offline");
    return [parseObservableDataAttachment(wire())];
  }}});
  await choose(root);
  click(root, "Connect file"); await tick();
  assert.match(root.textContent, /File connected\. Its existing archive is reused/);
  assert.match(root.textContent, /exact-storage-version/);
  assert.equal(reads, 0, "Connecting preserves the confirmed record without automatically listing references");
  click(root, "Reload references"); await tick();
  assert.match(root.textContent, /References could not be loaded/);
  assert.match(root.textContent, /File connected\. Its existing archive is reused/);
  assert.equal(registrations.length, 1);
  click(root, "Reload references"); await tick();
  assert.equal(registrations.length, 1);
  assert.match(root.textContent, /1 registered reference/);
});

it("keeps the selection after an uncertain registration without claiming success", async () => {
  let writes = 0;
  const {root, bodyReads} = setup({adapter: {registerObservableDataAttachment: async () => { writes++; throw new Error("offline"); }}});
  await choose(root);
  click(root, "Connect file"); await tick();
  assert.match(root.textContent, /File connection could not be confirmed.*Reload references to check/);
  assert.doesNotMatch(root.textContent, /File connected/);
  assert.equal(root.querySelector('[aria-label="Dataset"]').value, id(3));
  assert.equal(root.querySelector('[aria-label="Dataset version"]').value, id(4));
  assert.equal(root.querySelector('[aria-label="Archived file"]').value, id(5));
  assert.equal(root.querySelector("fieldset").disabled, false);
  assert.equal(writes, 1);
  assert.equal(bodyReads.length, 0);
});

function publicResource({datasetId = id(3), resourceId = id(20), projectId = id(9)} = {}) {
  return {id: resourceId, projectId, datasetId, kind: "dataset", state: "published", title: "Exact public elevation",
    versionNumber: 4, currentVersionId: id(21), provenance: {externalSourceVersion: 2, externalSourceUrl: "https://public.example.test/elevation.tif"},
    metadataExtensions: {opengeo: {schemaVersion: "1.3.0", distributions: [{identifier: "distribution-1",
      downloadUrl: "https://public.example.test/elevation.tif", mediaType: "image/tiff", byteSize: 8, checksumSha256: "a".repeat(64)}]}}};
}
function publicRegistryRecord(resource = publicResource()) {
  const candidate = observablePublicFileCandidates(resource).candidates[0];
  return {id: id(22), sourceProjectId: id(2), ...candidate.selection,
    resourceVersionNumber: candidate.resourceVersionNumber, url: candidate.url, contentType: candidate.contentType,
    sizeBytes: candidate.sizeBytes, checksumSha256: candidate.checksumSha256, available: true,
    kind: "referenced-public-file", custody: "referenced", revisionBound: false, buildInput: false, publicationAuthorized: false};
}
function publicSetup({adapter = {}, unlinked = false, download = false, resource = publicResource(), isLocked = () => false,
  onRegisteredPublic, onRegistered} = {}) {
  const dataset = {id: id(3), projectId: id(9), name: "Elevation", status: "active", sourceType: "cog", format: "cog",
    capabilities: {read: true, download}};
  const calls = {search: [], metadata: [], resource: [], register: [], attach: [], list: [], archived: [], publicCallback: [], archiveCallback: [], bodies: 0};
  const state = {project: {id: id(7)}, organization: {id: id(8)}, session: {userId: id(6)}, datasets: unlinked ? [] : [dataset], adapter: {
    listObservableDataAttachments: async () => [], listDatasetVersions: async () => [versionRecord()],
    registerObservableDataAttachment: async (...args) => {calls.archived.push(args); return parseObservableDataAttachment(wire());},
    searchDatasets: async filters => {calls.search.push(filters); return [dataset];},
    listDatasetResources: async (...args) => {calls.metadata.push(args); return [{...resource}];},
    getResource: async (...args) => {calls.resource.push(args); return resource;},
    attachDataset: async (...args) => {calls.attach.push(args); return dataset;},
    registerObservablePublicFileReference: async (...args) => {calls.register.push(args); return publicRegistryRecord(resource);},
    listObservablePublicFileReferences: async (...args) => {calls.list.push(args); return [];},
    requestDatasetDownload: async () => {calls.bodies++; throw Error("Unexpected public body read");},
    requestObservableBuild: async () => {throw Error("Unexpected build");}, ...adapter
  }};
  const root = FrameworkDataAttachments({state, sourceProject: {id: id(2)}, canManage: true, isLocked,
    onRegistered: onRegistered ?? (record => {calls.archiveCallback.push(record);}),
    onRegisteredPublic: onRegisteredPublic ?? (record => {calls.publicCallback.push(record);})});
  document.body.append(root);
  return {root, state, calls, dataset, resource};
}
async function choosePublic(root, {search = false, resourceId = id(20)} = {}) {
  if (search) {click(root, "Search Catalog"); await tick();}
  change(root, "Dataset", id(3)); await tick();
  change(root, "Catalog metadata record", resourceId); await tick();
  change(root, "Public source file", "distribution-1");
}
function connect(root) {
  [...root.querySelectorAll("button")].find(button => ["Connect file", "Link dataset and use file"].includes(button.textContent)).click();
}

it("public file picker reviews a COG without download permission and registers only after Connect file", async () => {
  const {root, calls} = publicSetup();
  assert.deepEqual([calls.metadata.length, calls.resource.length, calls.register.length, calls.list.length, calls.bodies], [0, 0, 0, 0, 0]);
  change(root, "Dataset", id(3)); await tick();
  assert.deepEqual(calls.metadata, [[id(3), {limit: 25, offset: 0}]]);
  assert.equal(calls.resource.length, 0);
  assert.equal(root.querySelector('[aria-label="File location"]').value, "public");
  assert.equal(root.querySelector('[aria-label="File location"] [value="archive"]').disabled, true);
  change(root, "Catalog metadata record", id(20)); await tick();
  assert.deepEqual(calls.resource, [[id(9), id(20)]]);
  change(root, "Public source file", "distribution-1");
  assert.match(root.textContent, /Public source.*8 bytes/);
  assert.match(root.textContent, /does not create an archived copy or grant publication rights/);
  assert.equal(calls.register.length, 0);
  connect(root); await tick();
  assert.deepEqual(calls.register, [[id(7), id(2), {datasetId: id(3), sourceVersion: 2, resourceId: id(20), resourceVersionId: id(21), distributionId: "distribution-1"}]]);
  assert.equal(calls.attach.length, 0);
  assert.equal(calls.publicCallback[0].filename, "elevation.tif");
  assert.equal(calls.publicCallback[0].datasetName, "Elevation");
  assert.equal(calls.publicCallback[0].custody, "referenced");
  assert.equal(calls.archiveCallback.length, 0);
  assert.equal(calls.bodies, 0);
});

it("public file picker searches and links an existing Catalog dataset while reading metadata in its original workspace", async () => {
  const {root, calls} = publicSetup({unlinked: true});
  await choosePublic(root, {search: true});
  assert.deepEqual(calls.search, [{query: undefined, limit: 25, offset: 0}]);
  assert.deepEqual(calls.resource, [[id(9), id(20)]]);
  assert.equal(calls.attach.length, 0);
  connect(root); await tick();
  assert.deepEqual(calls.attach, [[id(7), id(3)]]);
  assert.equal(calls.register.length, 1);
  assert.equal(calls.publicCallback.length, 1);
  assert.equal(calls.bodies, 0);
});

it("public file picker refuses incomplete exact metadata and preserves the archived-copy choice", async () => {
  const resource = publicResource(); delete resource.metadataExtensions.opengeo.distributions[0].checksumSha256;
  const {root, calls} = publicSetup({resource, download: true});
  change(root, "Dataset", id(3)); await tick();
  change(root, "Catalog metadata record", id(20)); await tick();
  assert.match(root.textContent, /metadata needs.*byte size.*SHA-256/i);
  assert.equal(root.querySelector('[aria-label="Public source file"]').disabled, true);
  assert.equal([...root.querySelectorAll("button")].find(button => button.textContent === "Connect file").disabled, true);
  change(root, "File location", "archive"); await tick();
  change(root, "Dataset version", id(4)); change(root, "Archived file", id(5));
  connect(root); await tick();
  assert.equal(calls.archived.length, 1);
  assert.equal(calls.archiveCallback.length, 1);
  assert.equal(calls.register.length, 0);
  assert.equal(calls.publicCallback.length, 0);
  assert.equal(calls.bodies, 0);
});

it("public file picker readback recovers an uncertain registry response without replaying the registration", async () => {
  let writes = 0, reads = 0;
  const {root, calls} = publicSetup({adapter: {
    registerObservablePublicFileReference: async () => {writes++; throw Error("Response lost after commit");},
    listObservablePublicFileReferences: async () => {reads++; return [publicRegistryRecord()];}
  }});
  await choosePublic(root); connect(root); await tick();
  assert.match(root.textContent, /could not be confirmed.*Reload public references/);
  connect(root); await tick();
  assert.equal(writes, 1);
  assert.equal(calls.publicCallback.length, 0);
  click(root, "Reload public references"); await tick();
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  assert.equal(calls.publicCallback.length, 1);
  assert.equal(calls.publicCallback[0].id, id(22));
  assert.match(root.textContent, /reference confirmed/);
});

it("public file picker keeps an unconfirmed dataset link blocked across reload and repeated selections", async () => {
  let links = 0, writes = 0;
  const {root} = publicSetup({unlinked: true, adapter: {
    attachDataset: async () => {links++; throw Error("Unknown committed link");},
    registerObservablePublicFileReference: async () => {writes++; return publicRegistryRecord();}
  }});
  await choosePublic(root, {search: true}); connect(root); await tick();
  assert.match(root.textContent, /linking could not be confirmed/);
  click(root, "Reload public references"); await tick();
  await choosePublic(root); connect(root); await tick();
  assert.equal(links, 1); assert.equal(writes, 0);
  assert.match(root.textContent, /linking remains unconfirmed/);
});

it("public file picker discards stale metadata after dataset changes, account changes or editor closure", async () => {
  for (const mode of ["selection", "account", "closed"]) {
    const pending = deferred(), {root, state, calls} = publicSetup({adapter: {getResource: async () => pending.promise}});
    change(root, "Dataset", id(3)); await tick();
    change(root, "Catalog metadata record", id(20));
    if (mode === "selection") change(root, "Dataset", "");
    if (mode === "account") state.organization = {id: id(99)};
    if (mode === "closed") root.remove();
    pending.resolve(publicResource()); await tick();
    assert.equal(root.querySelector('[aria-label="Public source file"]').options.length, 0, mode);
    assert.equal(calls.register.length, 0, mode);
    root.remove();
  }
});

it("public file picker ignores late registration completions for changed account, selection, lock or editor closure", async () => {
  for (const mode of ["account", "user", "selection", "locked", "closed"]) {
    const pending = deferred(); let locked = false;
    const {root, state, calls} = publicSetup({isLocked: () => locked, adapter: {registerObservablePublicFileReference: async () => pending.promise}});
    await choosePublic(root); connect(root);
    if (mode === "account") state.organization = {id: id(99)};
    if (mode === "user") state.session = {userId: id(99)};
    if (mode === "selection") root.querySelector('[aria-label="Public source file"]').value = "";
    if (mode === "locked") locked = true;
    if (mode === "closed") root.remove();
    pending.resolve(publicRegistryRecord()); await tick();
    assert.equal(calls.publicCallback.length, 0, mode);
    assert.equal(calls.archiveCallback.length, 0, mode);
    assert.equal(calls.bodies, 0, mode);
    root.remove();
  }
});

it("public file picker bounds metadata paging to two explicit pages without loading file bodies", async () => {
  const pages = [];
  const {root, calls} = publicSetup({adapter: {listDatasetResources: async (_, page) => {
    pages.push(page);
    return Array.from({length: 25}, (__, index) => ({...publicResource({resourceId: id(30 + page.offset + index)}), title: `Record ${index}`}));
  }}});
  change(root, "Dataset", id(3)); await tick();
  click(root, "Load more metadata records"); await tick();
  click(root, "Load more metadata records"); await tick();
  assert.deepEqual(pages, [{limit: 25, offset: 0}, {limit: 25, offset: 25}]);
  assert.equal(root.querySelector('[aria-label="Catalog metadata record"]').options.length, 51);
  assert.equal(calls.resource.length, 0);
  assert.equal(calls.register.length, 0);
  assert.equal(calls.bodies, 0);
});
