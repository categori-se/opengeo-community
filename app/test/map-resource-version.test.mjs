import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";
import {ProjectResources} from "../src/components/ProjectResources.js";
import {ApiContractError, OpenGeoApiClient, parseGovernedResource} from "../src/lib/apiClient.js";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000084",
  user: "20000000-0000-4000-8000-000000000084",
  project: "50000000-0000-4000-8000-000000000084",
  map: "60000000-0000-4000-8000-000000000084",
  resource: "90000000-0000-4000-8000-000000000084",
  profile: "a0000000-0000-4000-8000-000000000084"
};
const time = "2026-09-08T14:00:00Z";
function snapshot(version = 3) {
  return {map_id: IDS.map, map_version_id: `70000000-0000-4000-8000-${String(version).padStart(12, "0")}`,
    map_version: version, definition_checksum_sha256: "a".repeat(64)};
}
function payload(overrides = {}) {
  return {
    id: IDS.resource, project_id: IDS.project, kind: "map", slug: "watershed-map",
    dataset_id: null, map_id: IDS.map, visibility: "organization", state: "draft",
    version_number: 2, title: "Watershed map", abstract: "Survey boundaries", language: "en",
    license: "CC-BY-4.0", attribution: "Watershed survey team", keywords: ["water", "survey"],
    spatial_extent: [-72, 41, -71, 42], temporal_start: time, temporal_end: time,
    owner_user_id: IDS.user, origin_namespace: null, origin_identifier: null,
    relationship_count: 0, created_at: time, updated_at: time,
    metadata_profile: "survey.profile", metadata_extensions: {survey: {season: "fall"}},
    translations: {fr: {title: "Carte", abstract: "Limites", attribution: "Équipe", keywords: ["eau"]}},
    managed_metadata_profile_id: IDS.profile, managed_metadata_profile_version: 2,
    metadata_validation: null, content: {blocks: [{id: "note", type: "markdown", markdown: "Survey methods."}]},
    provenance: {source: "studio_native_resource", mapVersion: 99, method: "reviewed"},
    change_message: null, version_created_by: IDS.user, version_created_at: time,
    external_identifiers: [], relationships: [], map_snapshot: snapshot(), ...overrides
  };
}
function metadata(resource) {
  return {
    title: resource.title, abstract: resource.abstract, language: resource.language,
    license: resource.license, attribution: resource.attribution, keywords: resource.keywords,
    spatialExtent: resource.spatialExtent, temporalStart: resource.temporalStart, temporalEnd: resource.temporalEnd,
    profile: resource.metadataProfile, extensions: resource.metadataExtensions, translations: resource.translations,
    managedProfileId: resource.managedMetadataProfileId, managedProfileVersion: resource.managedMetadataProfileVersion
  };
}
function client(calls) {
  return new OpenGeoApiClient({baseUrl: "/api", tokenProvider: () => "local-test",
    organizationProvider: () => IDS.organization,
    fetchImplementation: async (url, options) => {
      calls.push({url, ...options, body: options.body ? JSON.parse(options.body) : null});
      return new Response(JSON.stringify(payload()), {status: 200, headers: {"content-type": "application/json"}});
    }});
}

describe("map resource version client contract", () => {
  it("reads authoritative exact map identity and treats absent older-server bindings as unknown", () => {
    assert.deepEqual(parseGovernedResource(payload()).mapSnapshot, {
      mapId: IDS.map, mapVersionId: snapshot().map_version_id, mapVersion: 3, definitionChecksumSha256: "a".repeat(64)
    });
    assert.equal(parseGovernedResource(payload({map_snapshot: undefined})).mapSnapshot, null);
    assert.equal(parseGovernedResource(payload({map_snapshot: null})).mapSnapshot, null);
    for (const map_snapshot of [
      {...snapshot(), map_id: IDS.project}, {...snapshot(), map_version_id: "invalid"},
      {...snapshot(), map_version: 0}, {...snapshot(), map_version: 1.5},
      {...snapshot(), map_version: Number.MAX_SAFE_INTEGER + 1},
      {...snapshot(), definition_checksum_sha256: "invalid"}
    ]) assert.throws(() => parseGovernedResource(payload({map_snapshot})), ApiContractError);
    assert.throws(() => parseGovernedResource(payload({kind: "dataset"})), ApiContractError);
    assert.throws(() => parseGovernedResource(payload({map_id: null})), ApiContractError);
  });

  it("sends an optional expected map revision only on deliberate creation/update and validates it before transport", async () => {
    const calls = [];
    const adapter = client(calls);
    const resource = parseGovernedResource(payload());
    const draft = {kind: "map", slug: resource.slug, mapId: IDS.map, metadata: metadata(resource)};
    const update = {expectedVersion: 2, visibility: "organization", metadata: metadata(resource),
      content: resource.content, provenance: resource.provenance};
    await adapter.createResource(IDS.project, {...draft, expectedMapVersion: 4});
    await adapter.updateResource(IDS.project, IDS.resource, {...update, expectedMapVersion: 4});
    await adapter.updateResource(IDS.project, IDS.resource, update);
    await adapter.createResource(IDS.project, draft);
    assert.equal(calls[0].body.expected_map_version, 4);
    assert.equal(calls[1].body.expected_map_version, 4);
    assert.equal(calls[1].body.expected_version, 2);
    assert.equal(Object.hasOwn(calls[2].body, "expected_map_version"), false);
    assert.equal(Object.hasOwn(calls[3].body, "expected_map_version"), false);
    for (const expectedMapVersion of [null, 0, -1, 1.5, "4", Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(adapter.createResource(IDS.project, {...draft, expectedMapVersion}), TypeError);
      await assert.rejects(adapter.updateResource(IDS.project, IDS.resource, {...update, expectedMapVersion}), TypeError);
    }
    await assert.rejects(adapter.createResource(IDS.project, {...draft, kind: "dataset", expectedMapVersion: 4}), TypeError);
    assert.equal(calls.length, 4);
  });
});

let dom, previous;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.local/workspaces"});
  previous = new Map();
  for (const [name, value] of Object.entries({document: dom.window.document, location: dom.window.location, HTMLElement: dom.window.HTMLElement})) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, value});
  }
});
afterEach(() => {
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  dom.window.close();
});
function button(root, label) {
  const result = [...root.querySelectorAll("button")].find((node) => node.textContent === label);
  assert.ok(result, `Missing button ${label}`);
  return result;
}
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Map version interaction did not settle");
}
async function open({overrides = {}, resourceOverrides = {}, savedVersion = 4, canUpdate = true} = {}) {
  let current = parseGovernedResource(payload(resourceOverrides));
  const original = structuredClone(current);
  const writes = [], reads = [];
  const map = {id: IDS.map, projectId: IDS.project, name: "Watershed map", status: "active", version: savedVersion};
  const adapter = {
    async getResource() { return current; },
    async getResourceCapabilities() { return {canRead: true, canUpdate, canPublish: true, canManagePermissions: false}; },
    async getMap(...args) { reads.push(args); return {...map}; },
    async updateResource(projectId, resourceId, update) {
      writes.push({projectId, resourceId, update});
      current = {...current, versionNumber: current.versionNumber + 1,
        mapSnapshot: {...current.mapSnapshot, mapId: IDS.map, mapVersion: update.expectedMapVersion}};
      return current;
    },
    ...overrides
  };
  const state = {adapter, session: {userId: IDS.user}, organization: {id: IDS.organization, callerRole: "member"},
    project: {id: IDS.project, name: "Survey", callerRole: "owner"}, maps: [map], datasets: [],
    resources: [current], metadataProfiles: []};
  const root = ProjectResources({state});
  document.body.append(root);
  button(root, "Open resource").click();
  await until(() => root.querySelector('.project-resource-detail[data-state="ready"]'));
  return {root, writes, reads, original, map,
    panel: () => root.querySelector(".project-resource-map-version"),
    form: () => root.querySelector(".project-resource-metadata-editor form")};
}

describe("deliberate map resource revision selection", () => {
  it("shows pinned/current versions without trusting provenance or writing during inspection", async () => {
    const view = await open();
    assert.match(view.panel().textContent, /Resource v2 uses map v3\. Saved map: v4/);
    assert.equal(view.panel().textContent.includes("v99"), false);
    assert.equal(view.panel().dataset.state, "stale");
    assert.equal(view.writes.length, 0);
    assert.equal(view.reads.length, 0);
    button(view.panel(), "Refresh saved map version").click();
    await until(() => view.panel().textContent.includes("Saved map checked"));
    assert.deepEqual(view.reads, [[IDS.project, IDS.map]]);
    assert.equal(view.writes.length, 0);
  });

  it("creates only the selected exact version and preserves all metadata, content, and provenance", async () => {
    const view = await open();
    button(view.panel(), "Use saved map v4 in a new resource version").click();
    await until(() => view.panel().textContent.includes("Resource v3 uses map v4"));
    assert.equal(view.writes.length, 1);
    assert.deepEqual(view.writes[0], {projectId: IDS.project, resourceId: IDS.resource, update: {
      expectedVersion: 2, expectedMapVersion: 4, visibility: "organization", metadata: metadata(view.original),
      content: view.original.content, provenance: view.original.provenance, changeMessage: "Use saved map v4"
    }});
    assert.equal(button(view.panel(), "Use saved map v4 in a new resource version").disabled, true);
  });

  it("keeps metadata drafts through inspection and blocks a revision change while they are dirty", async () => {
    const view = await open();
    const title = view.form().querySelector('[aria-label="Title"]');
    title.value = "Unsaved field notes";
    title.dispatchEvent(new dom.window.Event("input", {bubbles: true}));
    assert.equal(button(view.panel(), "Use saved map v4 in a new resource version").disabled, true);
    button(view.panel(), "Refresh saved map version").click();
    await until(() => !button(view.panel(), "Refresh saved map version").disabled);
    assert.equal(view.form().querySelector('[aria-label="Title"]'), title);
    assert.equal(title.value, "Unsaved field notes");
    assert.match(view.panel().textContent, /Save your metadata edits/);
    assert.equal(view.writes.length, 0);
  });

  it("locks metadata while a revision write is in flight and restores it after failure", async () => {
    let reject;
    const view = await open({overrides: {updateResource: () => new Promise((_, fail) => { reject = fail; })}});
    const title = view.form().querySelector('[aria-label="Title"]');
    button(view.panel(), "Use saved map v4 in a new resource version").click();
    assert.equal(title.disabled, true);
    assert.equal(button(view.form(), "Save new version").disabled, true);
    reject(Object.assign(new Error("unavailable"), {code: "http_503"}));
    await until(() => view.panel().textContent.includes("http_503"));
    assert.equal(title.disabled, false);
    assert.equal(title.value, "Watershed map");
    assert.equal(button(view.form(), "Save new version").disabled, false);
  });

  it("recovers from a changed saved map only after refreshing and selecting its new version", async () => {
    const writes = [];
    const view = await open({overrides: {
      async updateResource(_project, _resource, update) {
        writes.push(update);
        throw Object.assign(new Error("changed"), {code: "map_version_conflict"});
      },
      async getMap() { return {id: IDS.map, status: "active", version: 5}; }
    }});
    button(view.panel(), "Use saved map v4 in a new resource version").click();
    await until(() => view.panel().textContent.includes("The saved map changed"));
    assert.equal(button(view.panel(), "Use saved map in a new resource version").disabled, true);
    button(view.panel(), "Refresh saved map version").click();
    await until(() => view.panel().textContent.includes("Saved map: v5"));
    assert.equal(writes.length, 1);
    button(view.panel(), "Use saved map v5 in a new resource version").click();
    await until(() => writes.length === 2);
    assert.deepEqual(writes.map(({expectedVersion, expectedMapVersion}) => [expectedVersion, expectedMapVersion]), [[2, 4], [2, 5]]);
  });

  it("requires a permission recheck after 403 and preserves fields on resource-version conflict", async () => {
    let attempts = 0;
    const view = await open({overrides: {async updateResource() {
      throw Object.assign(new Error("denied"), {code: ++attempts === 1 ? "http_403" : "resource_version_conflict"});
    }}});
    const title = view.form().querySelector('[aria-label="Title"]');
    button(view.panel(), "Use saved map v4 in a new resource version").click();
    await until(() => view.panel().textContent.includes("http_403"));
    assert.equal(button(view.panel(), "Use saved map v4 in a new resource version").disabled, true);
    button(view.panel(), "Refresh saved map version").click();
    await until(() => !button(view.panel(), "Use saved map v4 in a new resource version").disabled);
    button(view.panel(), "Use saved map v4 in a new resource version").click();
    await until(() => view.panel().textContent.includes("The resource changed"));
    assert.equal(view.form().querySelector('[aria-label="Title"]'), title);
    assert.equal(title.value, "Watershed map");
    assert.equal(button(view.panel(), "Use saved map v4 in a new resource version").disabled, true);
  });

  it("reports missing legacy pins and permits only explicit selection", async () => {
    const view = await open({resourceOverrides: {map_snapshot: null}});
    assert.equal(view.panel().dataset.state, "missing");
    assert.match(view.panel().textContent, /no recorded exact map revision/);
    assert.equal(view.writes.length, 0);
    button(view.panel(), "Use saved map v4 in a new resource version").click();
    await until(() => view.panel().textContent.includes("Resource v3 uses map v4"));
    assert.equal(view.writes[0].update.expectedMapVersion, 4);
  });

  it("disables unchanged revisions, absent authority, and published/archived versions", async () => {
    for (const options of [{savedVersion: 3}, {canUpdate: false},
      {resourceOverrides: {state: "published", visibility: "public"}}, {resourceOverrides: {state: "archived"}}]) {
      const view = await open(options);
      const action = [...view.panel().querySelectorAll("button")].find(({textContent}) => textContent.startsWith("Use saved map"));
      assert.equal(action.disabled, true);
      action.click();
      assert.equal(view.writes.length, 0);
      view.root.remove();
    }
  });
});
