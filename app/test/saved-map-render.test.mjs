import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";
import {ApiContractError, OpenGeoApiClient, parseRenderJob} from "../src/lib/apiClient.js";
import {ProjectResources} from "../src/components/ProjectResources.js";
import {ProjectSites} from "../src/components/ProjectSites.js";

const IDS = Object.fromEntries(["organization", "project", "resource", "map", "version", "job", "profile", "dataset", "style", "user", "key"]
  .map((name, index) => [name, `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`]));
const timestamp = "2026-09-08T12:00:00Z";
function rawSnapshot(overrides = {}) {
  return {resource_version_id: IDS.version, resource_version_number: 2, map_id: IDS.map,
    map_version: 3, definition_checksum_sha256: "a".repeat(64), recipe_checksum_sha256: "b".repeat(64), ...overrides};
}
function rawJob(overrides = {}) {
  return {id: IDS.job, project_id: IDS.project, resource_id: IDS.resource,
    profile_id: IDS.profile, profile_version_id: IDS.version, profile_version_number: 1,
    dataset_id: IDS.dataset, dataset_version_id: IDS.version, style_id: IDS.style, style_version_id: IDS.version,
    bbox: [-72, 41, -71, 42], crs: "CRS:84", width: 800, height: 600, format: "png",
    background_color: null, transparent: false, request_checksum_sha256: "c".repeat(64),
    state: "queued", attempt_count: 0, output_object_id: null, output_content_type: null,
    output_size_bytes: null, output_checksum_sha256: null, error_code: null,
    created_by: IDS.user, created_at: timestamp, started_at: null, finished_at: null,
    saved_map_snapshot: rawSnapshot(), ...overrides};
}
function completed(overrides = {}) {
  return parseRenderJob(rawJob({state: "completed", started_at: timestamp, finished_at: timestamp,
    output_object_id: IDS.version, output_content_type: "image/png", output_size_bytes: 1234,
    output_checksum_sha256: "d".repeat(64), ...overrides}));
}
function api(fetchImplementation) {
  return new OpenGeoApiClient({baseUrl: "/api", tokenProvider: () => "local-test",
    organizationProvider: () => IDS.organization, fetchImplementation});
}
const request = {idempotencyKey: IDS.key, expectedResourceVersion: 2, expectedMapVersion: 3,
  width: 800, height: 600, format: "png"};
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {status, headers: {"content-type": "application/json"}});
}

describe("saved map image client contract", () => {
  it("submits only dimensions and exact revision expectations, and lists the actual map resource jobs", async () => {
    const calls = [];
    const client = api(async (url, options) => {
      calls.push({url, options});
      return json(options.method === "GET" ? [rawJob()] : rawJob());
    });
    const job = await client.requestSavedMapRender(IDS.project, IDS.resource, request);
    assert.equal(calls[0].url, `/api/projects/${IDS.project}/resources/${IDS.resource}/saved-map-renders`);
    assert.equal(calls[0].options.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      idempotency_key: IDS.key, expected_resource_version: 2, expected_map_version: 3,
      width: 800, height: 600, format: "png"
    });
    assert.deepEqual(job.savedMapSnapshot, {resourceVersionId: IDS.version, resourceVersionNumber: 2,
      mapId: IDS.map, mapVersion: 3, definitionChecksumSha256: "a".repeat(64), recipeChecksumSha256: "b".repeat(64)});
    assert.deepEqual(await client.listResourceRenders(IDS.project, IDS.resource), [job]);
    assert.equal(calls[1].url, `/api/projects/${IDS.project}/resources/${IDS.resource}/renders`);
    assert.equal(calls[1].options.body, undefined);
  });

  it("reads an Artifact manifest deliberately and rejects a different identity", async () => {
    const manifest = {schemaVersion: "opengeo.project-artifact.1.0.0", artifactId: IDS.job,
      accessContainerId: IDS.project, build: {resourceId: IDS.resource}};
    const calls = [];
    const client = api(async (url, options) => { calls.push({url, options}); return json(manifest); });
    assert.deepEqual(await client.getProjectArtifactManifest(IDS.project, IDS.resource, IDS.job), manifest);
    assert.equal(calls[0].options.method, "GET");
    assert.ok(calls[0].url.endsWith(`/renders/${IDS.job}/artifact-manifest`));
    await assert.rejects(api(async () => json({...manifest, artifactId: IDS.map}))
      .getProjectArtifactManifest(IDS.project, IDS.resource, IDS.job), ApiContractError);
  });

  it("rejects unsupported request overrides and invalid dimensions/versions before transport", async () => {
    let calls = 0;
    const client = api(async (_url, options) => {
      calls++;
      const {width, height} = JSON.parse(options.body);
      return json(rawJob({width, height}));
    });
    for (const patch of [{width: 63}, {height: 2049}, {width: 64.5}, {height: "64"},
      {expectedMapVersion: 0}, {expectedResourceVersion: Number.MAX_SAFE_INTEGER + 1},
      {format: "svg"}, {bbox: [-72, 41, -71, 42]}, {backgroundColor: "#ffffff"}, {profileId: IDS.profile}]) {
      await assert.rejects(client.requestSavedMapRender(IDS.project, IDS.resource, {...request, ...patch}));
    }
    assert.equal(calls, 0);
    await client.requestSavedMapRender(IDS.project, IDS.resource, {...request, width: 2048, height: 2048});
    await client.requestSavedMapRender(IDS.project, IDS.resource, {...request, width: 64, height: 64});
    assert.equal(calls, 2);
  });

  it("validates additive snapshot identities and treats absent legacy fields as unknown", () => {
    assert.equal(parseRenderJob(rawJob({saved_map_snapshot: undefined})).savedMapSnapshot, null);
    assert.equal(parseRenderJob(rawJob({saved_map_snapshot: null})).savedMapSnapshot, null);
    for (const patch of [{resource_version_id: "invalid"}, {resource_version_number: 0},
      {map_id: "invalid"}, {map_version: Number.MAX_SAFE_INTEGER + 1},
      {definition_checksum_sha256: "invalid"}, {recipe_checksum_sha256: "invalid"}]) {
      assert.throws(() => parseRenderJob(rawJob({saved_map_snapshot: rawSnapshot(patch)})), ApiContractError);
    }
  });

  it("accepts projected Mercator meters for render responses and requests without weakening CRS84 bounds", async () => {
    const bbox = [-8_100_000, 5_100_000, -8_000_000, 5_200_000];
    assert.deepEqual(parseRenderJob(rawJob({bbox, crs: "EPSG:3857"})).bbox, bbox);
    assert.throws(() => parseRenderJob(rawJob({bbox, crs: "CRS:84"})), ApiContractError);
    assert.throws(() => parseRenderJob(rawJob({bbox: [-21_000_000, 0, 0, 1], crs: "EPSG:3857"})), ApiContractError);
    const calls = [];
    const client = api(async (_url, options) => { calls.push(JSON.parse(options.body)); return json(rawJob({bbox, crs: "EPSG:3857"})); });
    await client.requestResourceRender(IDS.project, IDS.resource, IDS.profile,
      {idempotencyKey: IDS.key, bbox, crs: "EPSG:3857", width: 800, height: 600, format: "png"});
    assert.deepEqual(calls[0].bbox, bbox);
    await assert.rejects(client.requestResourceRender(IDS.project, IDS.resource, IDS.profile,
      {idempotencyKey: IDS.key, bbox, crs: "CRS:84", width: 800, height: 600}));
    assert.equal(calls.length, 1);
  });

  it("rejects foreign or oversized job listings", async () => {
    for (const payload of [[rawJob({resource_id: IDS.map})], [rawJob({project_id: IDS.map})], Array(101).fill(rawJob())]) {
      await assert.rejects(api(async () => json(payload)).listResourceRenders(IDS.project, IDS.resource), ApiContractError);
    }
  });

  it("refuses a render response for another resource, revision, or output size", async () => {
    for (const patch of [{resource_id: IDS.map}, {project_id: IDS.map}, {width: 640}, {format: "svg"},
      {saved_map_snapshot: null}, {saved_map_snapshot: rawSnapshot({map_version: 7})},
      {saved_map_snapshot: rawSnapshot({resource_version_number: 1})}]) {
      await assert.rejects(api(async () => json(rawJob(patch)))
        .requestSavedMapRender(IDS.project, IDS.resource, request), ApiContractError);
    }
  });

  it("preserves bounded actionable unsupported-composition errors and conflict status", async () => {
    const client = api(async () => json({detail: {code: "saved_map_background_unsupported",
      message: "Choose Blank canvas.\n" + "x".repeat(1200)}}, 409));
    await assert.rejects(client.requestSavedMapRender(IDS.project, IDS.resource, request), (error) => {
      assert.equal(error.code, "saved_map_background_unsupported");
      assert.equal(error.status, 409);
      assert.equal(error.message.length, 1000);
      assert.match(error.message, /^Choose Blank canvas\. x/);
      return true;
    });
  });
});

let dom, previousDocument;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>");
  previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {configurable: true, value: dom.window.document});
});
afterEach(() => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
  else delete globalThis.document;
  dom.window.close();
});
function resource(overrides = {}) {
  return {id: IDS.resource, projectId: IDS.project, mapId: IDS.map, datasetId: null,
    kind: "map", slug: "watershed", title: "Watershed", state: "published", visibility: "public",
    versionNumber: 2, spatialExtent: [-72, 41, -71, 42], language: "en", license: "CC-BY-4.0",
    attribution: "Survey team", keywords: [], metadataProfile: "opengeo.core.v1", metadataExtensions: {},
    translations: {}, externalIdentifiers: [], relationships: [], content: {blocks: []}, provenance: {mapVersion: 99},
    mapSnapshot: {mapId: IDS.map, mapVersionId: IDS.version, mapVersion: 3, definitionChecksumSha256: "a".repeat(64)}, ...overrides};
}
function state(adapter, current = resource()) {
  return {adapter, session: {userId: IDS.user}, organization: {id: IDS.organization, callerRole: "member"},
    project: {id: IDS.project, name: "Survey", callerRole: "owner"}, resources: [current], datasets: [],
    maps: [{id: IDS.map, name: "Watershed", version: 7, status: "active"}], metadataProfiles: []};
}
function button(root, label) {
  const result = [...root.querySelectorAll("button")].find((node) => node.textContent === label);
  assert.ok(result, `Missing button: ${label}`);
  return result;
}
function field(root, label) {
  const result = root.querySelector(`[aria-label="${label}"]`);
  assert.ok(result, `Missing field: ${label}`);
  return result;
}
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Saved map interaction did not settle");
}
async function openResource(overrides = {}, current = resource()) {
  const adapter = {async getResource() { return current; },
    async getResourceCapabilities() { return {canRead: true, canUpdate: true, canPublish: true, canManagePermissions: false}; },
    async requestSavedMapRender() { return parseRenderJob(rawJob()); }, ...overrides};
  const root = ProjectResources({state: state(adapter, current)});
  document.body.append(root);
  button(root, "Open resource").click();
  await until(() => root.querySelector('.project-resource-detail[data-state="ready"]'));
  const panel = [...root.querySelectorAll(".project-resource-editor-panel")]
    .find((node) => node.textContent.includes("Deterministic map renders"));
  assert.ok(panel);
  return {root, panel};
}

describe("deliberate pinned-map image interaction", () => {
  it("does not create work on inspection and renders the pin, not the latest map or metadata draft", async () => {
    const requests = [], reads = [], downloads = [], manifests = [];
    let resolveRequest;
    const {root, panel} = await openResource({
      requestSavedMapRender(...args) { requests.push(args); return new Promise((resolve) => { resolveRequest = resolve; }); },
      async getResourceRender(...args) { reads.push(args); return completed({width: 640, height: 480}); },
      async downloadResourceRender(...args) { downloads.push(args); return {url: "https://download.invalid/exact.png"}; },
      async getProjectArtifactManifest(...args) {
        manifests.push(args);
        throw Object.assign(new Error("revoked"), {code: "action_forbidden"});
      },
      async createRenderProfile() { assert.fail("map rendering must not create a profile in the browser"); }
    }, resource({state: "draft"}));
    assert.match(panel.textContent, /resource v2, bound map v3/);
    assert.doesNotMatch(panel.textContent, /v7|v99/);
    assert.equal(panel.querySelector('[aria-label="Render profile"]'), null);
    assert.equal(panel.querySelector('[aria-label="Render extent (west, south, east, north)"]'), null);
    const title = field(root.querySelector(".project-resource-metadata-editor form"), "Title");
    title.value = "Unsaved metadata";
    title.dispatchEvent(new dom.window.Event("input", {bubbles: true}));
    field(panel, "Render width").value = "640";
    field(panel, "Render height").value = "480";
    assert.equal(requests.length, 0);
    const create = button(panel, "Create map image");
    create.click();
    create.click();
    assert.equal(create.disabled, true);
    assert.equal(requests.length, 1);
    const [projectId, resourceId, sent] = requests[0];
    assert.deepEqual([projectId, resourceId], [IDS.project, IDS.resource]);
    assert.deepEqual({...sent, idempotencyKey: "checked"}, {...request, idempotencyKey: "checked", width: 640, height: 480});
    field(panel, "Render width").value = "320";
    assert.equal(sent.width, 640);
    resolveRequest(parseRenderJob(rawJob({width: 640, height: 480})));
    await until(() => panel.textContent.includes("State queued"));
    assert.equal(reads.length, 0);
    assert.equal(downloads.length, 0);
    button(panel, "Refresh render status").click();
    await until(() => panel.textContent.includes("State completed"));
    assert.deepEqual(reads, [[IDS.project, IDS.resource, IDS.job]]);
    assert.match(panel.textContent, /resource v2 · map v3/);
    assert.match(panel.textContent, /Creating or downloading it does not publish it/);
    assert.equal(manifests.length, 0);
    button(panel, "Download Artifact manifest").click();
    await until(() => panel.textContent.includes("Artifact manifest unavailable"));
    assert.deepEqual(manifests, [[IDS.project, IDS.resource, IDS.job]]);
    assert.equal(button(panel, "Download Artifact manifest").disabled, false);

    button(panel, "Authorize exact PNG download").click();
    await until(() => panel.querySelector('a[href="https://download.invalid/exact.png"]'));
    assert.deepEqual(downloads, [[IDS.project, IDS.resource, IDS.job]]);
    assert.equal(title.value, "Unsaved metadata");
    assert.equal(field(panel, "Render width").value, "320");
    assert.equal(requests.length, 1);
  });

  it("shows actionable unsupported errors as text and preserves dimensions and metadata for explicit retry", async () => {
    let calls = 0;
    const {root, panel} = await openResource({async requestSavedMapRender() {
      calls++;
      throw Object.assign(new Error("Choose Blank canvas <img src=x> for this saved revision."), {code: "saved_map_background_unsupported"});
    }}, resource({state: "draft"}));
    const title = field(root.querySelector(".project-resource-metadata-editor form"), "Title");
    title.value = "Keep this edit";
    field(panel, "Render width").value = "1024";
    button(panel, "Create map image").click();
    await until(() => panel.textContent.includes("Choose Blank canvas"));
    assert.equal(panel.querySelector("img"), null);
    assert.equal(title.value, "Keep this edit");
    assert.equal(field(panel, "Render width").value, "1024");
    assert.equal(button(panel, "Create map image").disabled, false);
    assert.equal(calls, 1);
    button(panel, "Create map image").click();
    await until(() => calls === 2);
  });

  it("blocks invalid dimensions locally and explains missing bindings and unavailable adapters", async () => {
    let writes = 0;
    const {panel} = await openResource({async requestSavedMapRender() { writes++; }});
    field(panel, "Render height").value = "63";
    button(panel, "Create map image").click();
    await until(() => panel.textContent.includes("Choose whole-number dimensions"));
    assert.equal(writes, 0);
    const missing = await openResource({}, resource({mapSnapshot: null}));
    assert.match(missing.panel.textContent, /no recorded map revision/);
    assert.equal(missing.panel.querySelector("button"), null);
    const unavailable = await openResource({requestSavedMapRender: undefined});
    assert.match(unavailable.panel.textContent, /unavailable in this adapter/);
  });

  it("recovers status refresh after permission rejection without creating another image", async () => {
    let writes = 0, reads = 0;
    const {panel} = await openResource({async requestSavedMapRender() { writes++; return parseRenderJob(rawJob()); },
      async getResourceRender() {
        if (++reads === 1) throw Object.assign(new Error("Access changed"), {code: "action_forbidden"});
        return completed();
      }});
    button(panel, "Create map image").click();
    await until(() => panel.textContent.includes("State queued"));
    button(panel, "Refresh render status").click();
    await until(() => panel.textContent.includes("Status refresh failed safely"));
    assert.equal(button(panel, "Refresh render status").disabled, false);
    button(panel, "Refresh render status").click();
    await until(() => panel.textContent.includes("State completed"));
    assert.equal(writes, 1);
  });

  it("reuses the key after an ambiguous response and starts a new request only after confirmed creation", async () => {
    const sent = [];
    const {panel} = await openResource({async requestSavedMapRender(_project, _resource, request) {
      sent.push(request);
      if (sent.length === 1) throw new TypeError("Connection closed before a response arrived");
      return parseRenderJob(rawJob());
    }});
    button(panel, "Create map image").click();
    await until(() => panel.textContent.includes("Image creation could not be confirmed"));
    assert.match(panel.textContent, /An image may already be queued/);
    assert.doesNotMatch(panel.textContent, /Map image was not created/);
    button(panel, "Create map image").click();
    await until(() => panel.textContent.includes("State queued"));
    assert.equal(sent[1].idempotencyKey, sent[0].idempotencyKey);
    button(panel, "Create map image").click();
    await until(() => sent.length === 3);
    assert.notEqual(sent[2].idempotencyKey, sent[0].idempotencyKey);
  });

  it("preserves ambiguous keys per dimension choice and when the resource detail is reopened", async () => {
    const sent = [];
    const view = await openResource({async requestSavedMapRender(_project, _resource, request) {
      sent.push(request);
      throw Object.assign(new Error("Service response unavailable"), {status: 503});
    }});
    for (const width of [640, 320, 640]) {
      field(view.panel, "Render width").value = String(width);
      button(view.panel, "Create map image").click();
      await until(() => !button(view.panel, "Create map image").disabled);
    }
    assert.equal(sent[2].idempotencyKey, sent[0].idempotencyKey);
    assert.notEqual(sent[1].idempotencyKey, sent[0].idempotencyKey);
    button(view.root, "Close").click();
    button(view.root, "Open resource").click();
    await until(() => view.root.querySelector('.project-resource-detail[data-state="ready"] [aria-label="Render width"]'));
    field(view.root, "Render width").value = "640";
    button(view.root, "Create map image").click();
    await until(() => sent.length === 4);
    assert.equal(sent[3].idempotencyKey, sent[0].idempotencyKey);
  });

  it("reopens queued and older completed jobs read-only without changing metadata or new image parameters", async () => {
    const calls = [], reads = [], downloads = [];
    const older = completed({id: IDS.style, saved_map_snapshot: rawSnapshot({resource_version_number: 1, map_version: 2})});
    const {root, panel} = await openResource({
      async listResourceRenders(...args) { reads.push(args); return [parseRenderJob(rawJob()), older,
        {...completed(), resourceId: IDS.map}, {...completed(), savedMapSnapshot: null}]; },
      async requestSavedMapRender(...args) { calls.push(args); },
      async getResourceRender() { return completed(); },
      async downloadResourceRender(...args) { downloads.push(args); return {url: "https://download.invalid/resumed.png"}; }
    }, resource({state: "draft"}));
    const title = field(root.querySelector(".project-resource-metadata-editor form"), "Title");
    title.value = "Unsaved notes";
    field(panel, "Render width").value = "640";
    assert.equal(reads.length, 0);
    button(panel, "Refresh map images").click();
    await until(() => !field(panel, "Existing map image").disabled);
    assert.deepEqual(reads, [[IDS.project, IDS.resource]]);
    const chooser = field(panel, "Existing map image");
    assert.equal(chooser.options.length, 3);
    assert.equal(chooser.value, "");
    assert.match(chooser.options[2].textContent, /resource v1 \/ map v2.*different revision/);
    chooser.value = IDS.style;
    chooser.dispatchEvent(new dom.window.Event("change", {bubbles: true}));
    const history = panel.querySelector(".project-render-history-result");
    assert.match(history.textContent, /State completed · resource v1 · map v2/);
    button(history, "Authorize exact PNG download").click();
    await until(() => history.querySelector("a"));
    assert.deepEqual(downloads, [[IDS.project, IDS.resource, IDS.style]]);
    chooser.value = IDS.job;
    chooser.dispatchEvent(new dom.window.Event("change", {bubbles: true}));
    button(history, "Refresh render status").click();
    await until(() => history.textContent.includes("State completed"));
    assert.equal(title.value, "Unsaved notes");
    assert.equal(field(panel, "Render width").value, "640");
    assert.equal(calls.length, 0);
  });

  it("recovers history reads after permission failure without creating jobs or discarding drafts", async () => {
    let denied = true, reads = 0;
    const {root, panel} = await openResource({
      async listResourceRenders() {
        reads++;
        if (denied) throw Object.assign(new Error("Access denied"), {code: "action_forbidden", status: 403});
        return [completed()];
      }, async requestSavedMapRender() { assert.fail("History must not create work"); }
    }, resource({state: "draft"}));
    const title = field(root.querySelector(".project-resource-metadata-editor form"), "Title");
    title.value = "Keep this draft";
    button(panel, "Refresh map images").click();
    await until(() => panel.textContent.includes("Existing images could not be refreshed"));
    assert.equal(field(panel, "Existing map image").disabled, true);
    assert.equal(button(panel, "Refresh map images").disabled, false);
    denied = false;
    button(panel, "Refresh map images").click();
    await until(() => !field(panel, "Existing map image").disabled);
    assert.equal(reads, 2);
    assert.equal(title.value, "Keep this draft");
  });
});

function openSite(overrides = {}, siteOverrides = {}) {
  const current = resource();
  const writes = [], reads = [];
  const adapter = {async listSites() { return []; },
    async getResource(...args) { reads.push(["resource", ...args]); return current; },
    async listResourceRenders(...args) { reads.push(["jobs", ...args]); return [completed()]; },
    async publishSite(...args) { writes.push(args); }, ...overrides};
  const site = {id: IDS.profile, title: "Survey atlas", slug: "atlas", state: "review", versionNumber: 4,
    description: "Watershed report", theme: "atlas", themeOptions: {}, printLayout: {pages: []}, activeEdition: null,
    publicationDestination: {revision: 1, reach: "listed", listedSlug: "atlas", isPrimary: false},
    pages: [{slug: "watershed", navigationLabel: "Watershed", resourceId: IDS.resource,
      resourceKind: "map", resourceTitle: "Watershed", resourceVersionNumber: 2,
      resourceState: "published", resourceVisibility: "public", content: {blocks: []}}], ...siteOverrides};
  const root = ProjectSites({state: {...state(adapter), sites: [site]}, refresh: async () => {}});
  document.body.append(root);
  return {root, reads, writes};
}

describe("reviewed-site completed map image selection", () => {
  it("loads existing images read-only, excludes stale/ordinary/incomplete jobs, and seals only deliberate selection", async () => {
    const ordinary = {...completed(), id: IDS.style, savedMapSnapshot: null};
    const stale = {...completed(), id: IDS.dataset, savedMapSnapshot: {...completed().savedMapSnapshot, mapVersion: 7}};
    const oldResource = {...completed(), id: IDS.key, savedMapSnapshot: {...completed().savedMapSnapshot, resourceVersionNumber: 1}};
    const foreign = {...completed(), id: IDS.map, resourceId: IDS.map};
    const wrongChecksum = {...completed(), id: IDS.version, savedMapSnapshot: {...completed().savedMapSnapshot, definitionChecksumSha256: "e".repeat(64)}};
    const view = openSite({async listResourceRenders() {
      return [completed(), ordinary, stale, oldResource, foreign, wrongChecksum, parseRenderJob(rawJob())];
    }});
    assert.equal(view.reads.length, 0);
    assert.equal(view.writes.length, 0);
    button(view.root, "Refresh completed map images").click();
    await until(() => view.root.querySelector('[aria-label="Map image for Watershed"]'));
    const chooser = field(view.root, "Map image for Watershed");
    assert.equal(chooser.options.length, 2);
    assert.equal(chooser.value, "");
    assert.match(chooser.options[1].textContent, /resource v2 \/ map v3 · 800 × 600 PNG/);
    assert.match(chooser.options[1].textContent, new RegExp(IDS.job));
    assert.equal(view.writes.length, 0);
    chooser.value = IDS.job;
    button(view.root, "Publish reviewed edition").click();
    await until(() => view.writes.length === 1);
    assert.deepEqual(view.writes[0], [IDS.project, IDS.profile, {expectedVersion: 4,
      reason: "Approved from the project publishing workspace", mapSnapshots: [{resourceId: IDS.resource, renderJobId: IDS.job}]}]);
  });

  it("finds map blocks on mixed-content pages and never substitutes a newer page resource revision", async () => {
    const block = {id: "map", type: "map", resource_id: IDS.resource, resource_version_number: 2};
    const view = openSite({}, {pages: [{resourceId: IDS.style, resourceKind: "story", resourceVersionNumber: 1,
      resourceState: "published", resourceVisibility: "public", content: {blocks: [block, block]}}]});
    button(view.root, "Refresh completed map images").click();
    await until(() => view.root.querySelector('[aria-label="Map image for Watershed"]'));
    assert.equal(view.reads.length, 2, "duplicate block references are read once");
    assert.equal(field(view.root, "Map image for Watershed").options.length, 2);
    const stale = openSite({}, {pages: [{resourceId: IDS.resource, resourceKind: "map", resourceVersionNumber: 1,
      resourceState: "published", resourceVisibility: "public", content: {blocks: []}}]});
    button(stale.root, "Refresh completed map images").click();
    await until(() => stale.root.querySelector('[aria-label="Map image for Watershed"]'));
    assert.equal(field(stale.root, "Map image for Watershed").options.length, 1);
    assert.equal(field(stale.root, "Map image for Watershed").disabled, true);
    assert.match(field(stale.root, "Map image for Watershed").textContent, /Revise the site before selecting/);
  });

  it("retains selection after publication conflict and requires retry after a failed image refresh", async () => {
    let failRead = false, attempts = 0;
    const view = openSite({async listResourceRenders() {
      if (failRead) throw Object.assign(new Error("denied"), {code: "action_forbidden"});
      return [completed()];
    }, async publishSite() { attempts++; throw Object.assign(new Error("changed"), {code: "site_snapshot_version_conflict"}); }});
    button(view.root, "Refresh completed map images").click();
    await until(() => view.root.querySelector('[aria-label="Map image for Watershed"]'));
    field(view.root, "Map image for Watershed").value = IDS.job;
    button(view.root, "Publish reviewed edition").click();
    await until(() => view.root.textContent.includes("site_snapshot_version_conflict"));
    assert.equal(field(view.root, "Map image for Watershed").value, IDS.job);
    failRead = true;
    button(view.root, "Refresh completed map images").click();
    await until(() => view.root.textContent.includes("Images could not be refreshed"));
    button(view.root, "Publish reviewed edition").click();
    await until(() => view.root.textContent.includes("site_action_failed"));
    assert.equal(attempts, 1, "unverified prior selection is not published");
    assert.equal(field(view.root, "Map image for Watershed").value, IDS.job);
    failRead = false;
    button(view.root, "Refresh completed map images").click();
    await until(() => !field(view.root, "Map image for Watershed").disabled);
    assert.equal(field(view.root, "Map image for Watershed").value, IDS.job);
  });

  it("clears a selection that no longer matches and rejects duplicate advanced bindings", async () => {
    let available = true;
    const view = openSite({async listResourceRenders() { return available ? [completed()] : []; }});
    button(view.root, "Refresh completed map images").click();
    await until(() => view.root.querySelector('[aria-label="Map image for Watershed"]'));
    field(view.root, "Map image for Watershed").value = IDS.job;
    const advanced = [...view.root.querySelectorAll("details")]
      .find((node) => node.querySelector("summary")?.textContent === "Advanced image bindings");
    advanced.open = true;
    advanced.querySelector("textarea").value = `${IDS.resource} = ${IDS.job}`;
    button(view.root, "Publish reviewed edition").click();
    await until(() => view.root.textContent.includes("site_action_failed"));
    assert.equal(view.writes.length, 0);
    advanced.querySelector("textarea").value = "";
    available = false;
    button(view.root, "Refresh completed map images").click();
    await until(() => view.root.textContent.includes("previously selected image no longer matches"));
    assert.equal(field(view.root, "Map image for Watershed").value, "");
    assert.equal(view.writes.length, 0);
  });
});
