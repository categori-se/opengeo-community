import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {ProjectResources} from "../src/components/ProjectResources.js";

const IDS = Object.freeze({
  organization: "10000000-0000-4000-8000-000000000082",
  user: "20000000-0000-4000-8000-000000000082",
  project: "50000000-0000-4000-8000-000000000082",
  map: "60000000-0000-4000-8000-000000000082",
  dataset: "80000000-0000-4000-8000-000000000082",
  resource: "90000000-0000-4000-8000-000000000082"
});

let harness;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: `https://studio.opengeo.tools/workspaces?project=${IDS.project}&manage=resources`
  });
  const previous = new Map();
  for (const [name, value] of Object.entries({
    document: dom.window.document,
    location: dom.window.location,
    HTMLElement: dom.window.HTMLElement
  })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  }
  harness = {
    dom,
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
      dom.window.close();
    }
  };
});

afterEach(() => {
  harness?.restore();
  harness = null;
});

describe("resource discovery filters", () => {
  it("submits spatial and UTC temporal coverage filters with existing project facets and rejects invalid ranges before the API", async () => {
    const calls = [];
    const match = resource({kind: "document", visibility: "organization", metadata: {title: "Recorded observations"}, content: {blocks: []}, provenance: {}});
    const root = ProjectResources({state: projectState({listResources: async (projectId, filters) => {
      calls.push({projectId, filters}); return [match];
    }})});
    const form = root.querySelector(".project-resource-filters");
    const field = label => form.querySelector(`[aria-label="${label}"]`);
    field("Search project resources").value = "observations";
    field("Filter resource kind").value = "document";
    field("Filter resource visibility").value = "organization";
    field("Filter resource state").value = "review";
    field("Resource bounds west,south,east,north").value = "-73,40,-69,44";
    field("Resource time from (UTC)").value = "2025-01-01T00:00";
    field("Resource time through (UTC)").value = "2026-01-01T00:00";
    const submit = () => form.dispatchEvent(new harness.dom.window.Event("submit", {cancelable: true}));
    submit(); await waitFor(() => calls.length === 1);
    assert.deepEqual(calls[0], {projectId: IDS.project, filters: {
      limit: 100, query: "observations", kind: "document", visibility: "organization", state: "review",
      bbox: [-73,40,-69,44], temporalStart: "2025-01-01T00:00Z", temporalEnd: "2026-01-01T00:00Z"
    }});
    assert.equal(root.querySelector(".project-resource-card").dataset.resourceId, IDS.resource);
    field("Resource bounds west,south,east,north").value = "170,0,-170,10";
    submit(); await waitFor(() => form.textContent.includes("resource_bbox_invalid"));
    assert.equal(calls.length, 1);
    field("Resource bounds west,south,east,north").value = "";
    field("Resource time from (UTC)").value = "2027-01-01T00:00";
    submit(); await waitFor(() => form.textContent.includes("resource_time_invalid"));
    assert.equal(calls.length, 1);
    field("Resource time from (UTC)").value = "";
    field("Resource time through (UTC)").value = "";
    submit(); await waitFor(() => calls.length === 2);
    assert.equal(calls[1].filters.bbox, null);
    assert.equal(calls[1].filters.temporalStart, null);
    assert.equal(calls[1].filters.temporalEnd, null);
  });
});

describe("published resource audience", () => {
  it("withdraws and restores the audience through the publisher action without changing content or version", async () => {
    const published = resource({kind: "dataset", visibility: "public", metadata: {title: "Public observations"}, content: {blocks: []}, provenance: {source: "retained"}});
    published.state = "published";
    const calls = [];
    const adapter = {
      kind: "api", async getResource() { return published; },
      async getResourceCapabilities() { return {canRead: true, canUpdate: false, canPublish: true, canManagePermissions: false}; },
      async setResourcePublicationVisibility(projectId, resourceId, input) {
        calls.push({projectId, resourceId, input}); published.visibility = input.visibility; return published;
      }
    };
    const state = projectState(adapter); state.resources = [published];
    const root = ProjectResources({state});
    clickButton(root, "Open resource"); await waitFor(() => findButton(root, "Change publication audience"));
    assert.equal(findButton(root, "Change publication audience").disabled, true);
    for (const visibility of ["organization", "public"]) {
      const control = root.querySelector('[aria-label="Current publication audience"]');
      control.value = visibility; control.dispatchEvent(new harness.dom.window.Event("change"));
      clickButton(root, "Change publication audience");
      assert.equal(findButton(root, "Archive").disabled, true);
      await waitFor(() => root.querySelector('[aria-label="Current publication audience"]') !== control);
      assert.equal(published.versionNumber, 1); assert.equal(published.state, "published");
      assert.deepEqual(published.provenance, {source: "retained"});
    }
    assert.deepEqual(calls.map(call => call.input), [
      {expectedVersion: 1, expectedVisibility: "public", visibility: "organization"},
      {expectedVersion: 1, expectedVisibility: "organization", visibility: "public"}
    ]);
  });

  it("reloads a concurrent audience decision before another action and hides controls from editors", async () => {
    const published = resource({kind: "dataset", visibility: "public", metadata: {title: "Public observations"}, content: {blocks: []}, provenance: {}});
    published.state = "published"; let publisher = true, calls = 0;
    const adapter = {
      kind: "api", async getResource() { return published; },
      async getResourceCapabilities() { return {canRead: true, canUpdate: true, canPublish: publisher, canManagePermissions: false}; },
      async setResourcePublicationVisibility() { calls++; published.visibility = "organization"; throw Object.assign(Error("conflict"), {code: "resource_visibility_conflict"}); }
    };
    const state = projectState(adapter); state.resources = [published];
    const root = ProjectResources({state}); clickButton(root, "Open resource");
    await waitFor(() => findButton(root, "Change publication audience"));
    const control = root.querySelector('[aria-label="Current publication audience"]');
    control.value = "organization"; control.dispatchEvent(new harness.dom.window.Event("change"));
    clickButton(root, "Change publication audience");
    await waitFor(() => root.textContent.includes("Review the current audience before applying another change."));
    assert.equal(calls, 1); assert.equal(findButton(root, "Change publication audience").disabled, true);
    publisher = false; clickButton(root, "Open resource");
    await waitFor(() => root.textContent.includes("required to archive this publication"));
    assert.equal(findButton(root, "Change publication audience"), null);
  });
});

describe("native governed resource creation", () => {
  it("curates coverage in one versioned save and retains invalid drafts without sending them", async () => {
    let current = resource({kind: "dataset", slug: "observations", datasetId: IDS.dataset,
      visibility: "restricted", metadata: {title: "Observations"}, content: {blocks: []}, provenance: {source: "managed_upload"}});
    const writes = [];
    const adapter = {
      async getResource() { return current; },
      async getResourceCapabilities() { return {canRead: true, canUpdate: true, canPublish: false, canManagePermissions: false}; },
      async updateResource(projectId, resourceId, update) {
        writes.push({projectId, resourceId, update});
        current = {...current, ...update.metadata, versionNumber: 2};
        return current;
      }
    };
    const state = projectState(adapter);
    state.resources = [current];
    const root = ProjectResources({state});
    document.body.append(root);
    clickButton(root, "Open resource");
    const form = await waitFor(() => root.querySelector(".project-resource-metadata-editor form"));
    for (const [label, value] of Object.entries({"West boundary": "-72", "South boundary": "41", "East boundary": "-71", "North boundary": "42",
      "Coverage start": "2026-09-08T14:00:00.000002Z", "Coverage end": "2026-09-08T14:00:00.000001Z"})) {
      form.querySelector(`[aria-label="${label}"]`).value = value;
    }
    form.dispatchEvent(new harness.dom.window.Event("submit", {bubbles: true, cancelable: true}));
    await waitFor(() => form.textContent.includes("Coverage end must not be earlier"));
    assert.equal(writes.length, 0);
    assert.equal(form.querySelector(".resource-coverage-editor").open, true);
    assert.equal(form.querySelector('[aria-label="West boundary"]').value, "-72");
    const end = form.querySelector('[aria-label="Coverage end"]');
    end.value = "2026-09-08T10:00:00.000003-04:00";
    end.dispatchEvent(new harness.dom.window.Event("input", {bubbles: true}));
    form.dispatchEvent(new harness.dom.window.Event("submit", {bubbles: true, cancelable: true}));
    await waitFor(() => writes.length === 1);
    assert.equal(writes[0].update.expectedVersion, 1);
    assert.deepEqual(writes[0].update.metadata.spatialExtent, [-72, 41, -71, 42]);
    assert.equal(writes[0].update.metadata.temporalStart, "2026-09-08T14:00:00.000002Z");
    assert.equal(writes[0].update.metadata.temporalEnd, end.value);
    assert.deepEqual(writes[0].update.provenance, {source: "managed_upload"});
    await waitFor(() => root.textContent.includes("Version 2"));
  });

  it("uses effective update authority for metadata controls and submission", async () => {
    const current = resource({kind: "dataset", slug: "observations", datasetId: IDS.dataset,
      visibility: "restricted", metadata: {title: "Observations"}, content: {blocks: []}, provenance: {}});
    let writes = 0;
    const state = projectState({
      async getResource() { return current; },
      async getResourceCapabilities() { return {canRead: true, canUpdate: false, canPublish: true, canManagePermissions: false}; },
      async updateResource() { writes++; }
    });
    state.resources = [current];
    const root = ProjectResources({state});
    clickButton(root, "Open resource");
    const form = await waitFor(() => root.querySelector(".project-resource-metadata-editor form"));
    assert.equal(form.querySelector('[aria-label="West boundary"]').readOnly, true);
    assert.equal(findButton(form, "Save new version").disabled, true);
    form.dispatchEvent(new harness.dom.window.Event("submit", {bubbles: true, cancelable: true}));
    assert.equal(writes, 0);
  });

  it("creates a publication-ready page draft and opens its existing editor", async () => {
    const calls = [];
    let created;
    const adapter = {
      async createResource(projectId, draft) {
        calls.push({projectId, draft});
        created = resource(draft);
        return created;
      },
      async listResources() { return [created]; },
      async getResource() { return created; }
    };
    const state = projectState(adapter);
    const root = ProjectResources({state});

    root.querySelector(".project-resource-native-create").open = true;
    root.querySelector('[aria-label="License"]').value = "CC-BY-4.0";
    root.querySelector('[aria-label="Attribution"]').value = "OpenGeo research team";
    root.querySelector(".project-resource-native-form").dispatchEvent(
      new harness.dom.window.Event("submit", {bubbles: true, cancelable: true})
    );

    await waitFor(() => root.querySelector('.project-resource-detail[data-state="ready"]'));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      projectId: IDS.project,
      draft: {
        kind: "document",
        slug: "research-atlas-overview",
        datasetId: null,
        mapId: null,
        visibility: "restricted",
        metadata: {
          title: "Research atlas overview",
          abstract: "A governed spatial publication",
          language: "en",
          license: "CC-BY-4.0",
          attribution: "OpenGeo research team",
          keywords: ["document"],
          spatialExtent: null,
          profile: "opengeo.core.v1",
          extensions: {},
          translations: {}
        },
        content: {
          blocks: [{
            id: "introduction",
            type: "markdown",
            markdown: "# Research atlas overview"
          }]
        },
        provenance: {
          source: "studio_native_resource",
          projectId: IDS.project
        }
      }
    });
    assert.match(root.textContent, /1 governed resource/);
    assert.match(root.textContent, /Metadata and rights/);
  });

  it("binds a governed map identity to the selected durable map", async () => {
    const calls = [];
    let created;
    const adapter = {
      async createResource(_projectId, draft) {
        calls.push(draft);
        created = resource(draft);
        return created;
      },
      async listResources() { return [created]; },
      async getResource() { return created; }
    };
    const root = ProjectResources({state: projectState(adapter)});
    const kind = root.querySelector('[aria-label="Resource type"]');
    kind.value = "map";
    kind.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    root.querySelector('[aria-label="License"]').value = "CC-BY-4.0";
    root.querySelector('[aria-label="Attribution"]').value = "OpenGeo research team";
    root.querySelector(".project-resource-native-form").dispatchEvent(
      new harness.dom.window.Event("submit", {bubbles: true, cancelable: true})
    );

    await waitFor(() => calls.length === 1);
    assert.equal(calls[0].kind, "map");
    assert.equal(calls[0].mapId, IDS.map);
    assert.equal(calls[0].expectedMapVersion, 3);
    assert.equal(calls[0].datasetId, null);
    assert.deepEqual(calls[0].content, {blocks: []});
    assert.equal(calls[0].provenance.mapId, IDS.map);
    assert.equal(calls[0].provenance.mapVersion, 3);
  });

  it("opens an existing governed map without duplicating its identity or changing metadata and its pinned revision", async () => {
    const existing = resource({
      kind: "map", slug: `map-${IDS.map}`, mapId: IDS.map, visibility: "restricted",
      metadata: {title: "Research atlas map", language: "und"}, content: {blocks: []},
      provenance: {source: "opengeo_map_creation", mapId: IDS.map, mapVersion: 1}
    });
    existing.mapSnapshot = {mapId: IDS.map, mapVersion: 1,
      mapVersionId: "70000000-0000-4000-8000-000000000082", definitionChecksumSha256: "a".repeat(64)};
    const retained = structuredClone(existing);
    const reads = [];
    let creates = 0, updates = 0;
    const state = projectState({
      async createResource() { creates++; throw new Error("Existing identity must be reused"); },
      async updateResource() { updates++; throw new Error("Reuse must not write metadata or select a map revision"); },
      async getResource(projectId, resourceId) { reads.push({projectId, resourceId}); return existing; },
      async getResourceCapabilities() { return {canRead: true, canUpdate: true, canPublish: false, canManagePermissions: false}; }
    });
    state.resources = [existing];
    const root = ProjectResources({state});
    const panel = root.querySelector(".project-resource-native-create");
    panel.open = true;
    const form = panel.querySelector("form");
    const kind = form.querySelector('[aria-label="Resource type"]');
    kind.value = "map";
    kind.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    for (const [label, value] of Object.entries({"Resource title": "Attempted duplicate", "Persistent URL name": "duplicate-map",
      License: "CC-BY-4.0", Attribution: "Attempted replacement attribution"})) {
      form.querySelector(`[aria-label="${label}"]`).value = value;
    }
    form.dispatchEvent(new harness.dom.window.Event("submit", {bubbles: true, cancelable: true}));

    const detail = await waitFor(() => root.querySelector('.project-resource-detail[data-state="ready"]'));
    assert.equal(creates, 0);
    assert.equal(updates, 0);
    assert.deepEqual(reads, [{projectId: IDS.project, resourceId: existing.id}]);
    assert.deepEqual(existing, retained);
    assert.deepEqual(state.resources, [retained]);
    assert.match(detail.querySelector(".project-resource-detail-heading").textContent, /Research atlas map/);
    assert.equal(detail.querySelector('[aria-label="License"]').value, "");
    assert.equal(detail.querySelector('[aria-label="Attribution"]').value, "");
    assert.equal(detail.querySelector(".project-resource-map-version").dataset.state, "stale");
    assert.match(detail.textContent, /Resource v1 uses map v1\. Saved map: v3\./);
    assert.match(panel.textContent, /already governed as map-/);
    assert.equal(panel.open, false);
  });

  it("recovers a simultaneous map registration by opening the winner", async () => {
    const winner = resource({
      kind: "map",
      slug: "research-atlas-map",
      mapId: IDS.map,
      datasetId: null,
      visibility: "restricted",
      metadata: {title: "Research atlas map"},
      content: {blocks: []},
      provenance: {source: "studio_native_resource", mapId: IDS.map}
    });
    let lists = 0;
    const adapter = {
      async createResource() {
        throw Object.assign(new Error("conflict"), {code: "resource_conflict"});
      },
      async listResources() { lists += 1; return [winner]; },
      async getResource() { return winner; }
    };
    const state = projectState(adapter);
    const root = ProjectResources({state});
    const kind = root.querySelector('[aria-label="Resource type"]');
    kind.value = "map";
    kind.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    root.querySelector('[aria-label="License"]').value = "CC-BY-4.0";
    root.querySelector('[aria-label="Attribution"]').value = "OpenGeo research team";
    root.querySelector(".project-resource-native-form").dispatchEvent(
      new harness.dom.window.Event("submit", {bubbles: true, cancelable: true})
    );

    await waitFor(() => root.querySelector('.project-resource-detail[data-state="ready"]'));
    assert.equal(lists, 1);
    assert.equal(state.resources[0].id, winner.id);
    assert.match(root.textContent, /Research atlas map/);
  });

  it("does not expose resource creation to a viewer", () => {
    const state = projectState({createResource() {}});
    state.project.callerRole = "viewer";
    const root = ProjectResources({state});
    assert.equal(root.querySelector(".project-resource-native-create"), null);
  });

  it("hands a reviewed resource to a publisher without exposing a doomed publish action", async () => {
    const reviewed = resource({
      kind: "document",
      slug: "research-atlas-overview",
      datasetId: null,
      mapId: null,
      visibility: "organization",
      metadata: {title: "Research atlas overview"},
      content: {blocks: [{id: "introduction", type: "markdown", markdown: "# Overview"}]},
      provenance: {source: "studio_native_resource"}
    });
    reviewed.state = "review";
    const adapter = {
      kind: "api",
      async getResource() { return reviewed; },
      async getResourceCapabilities() {
        return {
          canRead: true,
          canUpdate: true,
          canPublish: false,
          canManagePermissions: false
        };
      },
      async listResourceWorkflow() { return []; },
      async listResourcePermissions() {
        throw Object.assign(new Error("forbidden"), {code: "action_forbidden"});
      }
    };
    const state = projectState(adapter);
    state.project.callerRole = "editor";
    state.resources = [reviewed];
    const root = ProjectResources({state});

    clickButton(root, "Open resource");
    await waitFor(() => root.querySelector('.project-resource-detail[data-state="ready"]'));

    assert.equal(findButton(root, "Publish"), null);
    assert.equal(findButton(root, "Archive"), null);
    assert.match(root.textContent, /Review is pending.*resource publish access/s);
    assert.match(root.textContent, /Only the resource owner.*resource manage access/s);
  });

  it("archives drafts and reviews with publisher authority without publishing or changing provenance", async () => {
    for (const initialState of ["draft", "review"]) {
      const draft = resource({kind: "document", visibility: "restricted",
        metadata: {title: "Private draft"}, content: {blocks: []}, provenance: {source: "retained"}});
      draft.state = initialState;
      draft.versionNumber = 3;
      const retained = structuredClone({content: draft.content, provenance: draft.provenance});
      const transitions = [];
      let acknowledge;
      const adapter = {
        kind: "api", async getResource() { return draft; },
        async getResourceCapabilities() {
          return {canRead: true, canUpdate: true, canPublish: true, canManagePermissions: false};
        },
        async listResourceWorkflow() { return []; },
        async transitionResource(projectId, resourceId, update) {
          transitions.push({projectId, resourceId, update});
          await new Promise(resolve => {acknowledge = resolve;});
          draft.state = update.targetState;
          return draft;
        }
      };
      const state = projectState(adapter);
      state.resources = [draft];
      const root = ProjectResources({state});
      clickButton(root, "Open resource");
      const archiveLabel = initialState === "draft" ? "Archive draft" : "Archive";
      const otherLabel = initialState === "draft" ? "Submit for review" : "Publish";
      await waitFor(() => findButton(root, archiveLabel));
      clickButton(root, archiveLabel);
      await waitFor(() => acknowledge);
      assert.equal(findButton(root, archiveLabel).disabled, true);
      assert.equal(findButton(root, otherLabel).disabled, true);
      acknowledge();
      await waitFor(() => root.textContent.includes("This resource is archived"));
      assert.deepEqual(transitions, [{projectId: IDS.project, resourceId: IDS.resource,
        update: {expectedVersion: 3, targetState: "archived", visibility: null, reason: null}}]);
      assert.equal(draft.visibility, "restricted");
      assert.equal(draft.versionNumber, 3);
      assert.deepEqual({content: draft.content, provenance: draft.provenance}, retained);

      draft.state = initialState;
      adapter.getResourceCapabilities = async () => ({canRead: true, canUpdate: true,
        canPublish: false, canManagePermissions: false});
      state.project.callerRole = "editor";
      const editor = ProjectResources({state});
      clickButton(editor, "Open resource");
      await waitFor(() => editor.querySelector('.project-resource-detail[data-state="ready"]'));
      assert.equal(findButton(editor, archiveLabel), null);
      assert.equal(transitions.length, 1);
    }
  });

  it("publishes with effective authority and continues directly to site assembly", async () => {
    const reviewed = resource({
      kind: "document",
      slug: "research-atlas-overview",
      datasetId: null,
      mapId: null,
      visibility: "organization",
      metadata: {title: "Research atlas overview"},
      content: {blocks: [{id: "introduction", type: "markdown", markdown: "# Overview"}]},
      provenance: {source: "studio_native_resource"}
    });
    reviewed.state = "review";
    const transitions = [];
    const adapter = {
      kind: "api",
      async getResource() { return reviewed; },
      async getResourceCapabilities() {
        return {
          canRead: true,
          canUpdate: false,
          canPublish: true,
          canManagePermissions: false
        };
      },
      async listResourceWorkflow() { return []; },
      async transitionResource(projectId, resourceId, update) {
        transitions.push({projectId, resourceId, update});
        reviewed.state = "published";
        reviewed.visibility = update.visibility;
        return reviewed;
      }
    };
    const state = projectState(adapter);
    state.project.callerRole = "reviewer";
    state.resources = [reviewed];
    const root = ProjectResources({state});

    clickButton(root, "Open resource");
    await waitFor(() => findButton(root, "Publish"));
    root.querySelector('[aria-label="Publication visibility"]').value = "public";
    clickButton(root, "Publish");
    await waitFor(() => root.querySelector('a[href*="manage=publishing"]'));

    assert.deepEqual(transitions, [{
      projectId: IDS.project,
      resourceId: IDS.resource,
      update: {
        expectedVersion: 1,
        targetState: "published",
        visibility: "public",
        reason: null
      }
    }]);
    assert.match(
      root.querySelector('a[href*="manage=publishing"]').textContent,
      /Add to a site/
    );
    assert.equal(
      root.querySelector('a[href*="manage=publishing"]').getAttribute("href"),
      `/workspaces?project=${IDS.project}&manage=publishing&intent=add-resource`
        + `&resource=${IDS.resource}&resourceVersion=1#project-sites`
    );
  });

  it("reloads the current resource when a competing editorial decision wins", async () => {
    const reviewed = resource({
      kind: "document",
      slug: "research-atlas-overview",
      datasetId: null,
      mapId: null,
      visibility: "organization",
      metadata: {title: "Research atlas overview"},
      content: {blocks: [{id: "introduction", type: "markdown", markdown: "# Overview"}]},
      provenance: {source: "studio_native_resource"}
    });
    reviewed.state = "review";
    let reads = 0;
    const adapter = {
      kind: "api",
      async getResource() {
        reads += 1;
        return {...reviewed, versionNumber: reads === 1 ? 1 : 2};
      },
      async getResourceCapabilities() {
        return {
          canRead: true,
          canUpdate: false,
          canPublish: true,
          canManagePermissions: false
        };
      },
      async transitionResource() {
        throw Object.assign(new Error("conflict"), {
          code: "resource_version_conflict",
          currentVersion: 2
        });
      }
    };
    const state = projectState(adapter);
    state.resources = [reviewed];
    const root = ProjectResources({state});

    clickButton(root, "Open resource");
    await waitFor(() => findButton(root, "Publish"));
    clickButton(root, "Publish");
    await waitFor(() => root.textContent.includes("Studio reloaded the current version"));

    assert.equal(reads, 2);
    assert.match(root.textContent, /Version 2 · review/);
  });
});

function projectState(adapter) {
  return {
    adapter,
    session: {userId: IDS.user},
    organization: {id: IDS.organization, callerRole: "member"},
    project: {
      id: IDS.project,
      name: "Research atlas",
      description: "A governed spatial publication",
      callerRole: "owner"
    },
    maps: [{
      id: IDS.map,
      projectId: IDS.project,
      name: "Research atlas map",
      description: null,
      status: "active",
      version: 3
    }],
    datasets: [{
      id: IDS.dataset,
      name: "Research observations",
      format: "geojson"
    }],
    resources: [],
    metadataProfiles: []
  };
}

function resource(draft) {
  return {
    id: IDS.resource,
    projectId: IDS.project,
    kind: draft.kind,
    slug: draft.slug,
    datasetId: draft.datasetId ?? null,
    mapId: draft.mapId ?? null,
    visibility: draft.visibility,
    state: "draft",
    versionNumber: 1,
    title: draft.metadata.title,
    abstract: draft.metadata.abstract ?? null,
    language: draft.metadata.language ?? "en",
    license: draft.metadata.license ?? null,
    attribution: draft.metadata.attribution ?? null,
    keywords: draft.metadata.keywords ?? [],
    spatialExtent: draft.metadata.spatialExtent ?? null,
    temporalStart: null,
    temporalEnd: null,
    ownerUserId: IDS.user,
    originNamespace: null,
    originIdentifier: null,
    relationshipCount: 0,
    metadataProfile: "opengeo.core.v1",
    metadataExtensions: {},
    translations: {},
    managedMetadataProfileId: null,
    managedMetadataProfileVersion: null,
    metadataValidation: null,
    content: draft.content,
    provenance: draft.provenance,
    changeMessage: null,
    versionCreatedBy: IDS.user,
    versionCreatedAt: "2026-09-02T12:00:00Z",
    externalIdentifiers: [],
    relationships: [],
    createdAt: "2026-09-02T12:00:00Z",
    updatedAt: "2026-09-02T12:00:00Z"
  };
}

async function waitFor(callback, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = callback();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition was not reached");
}

function findButton(root, label) {
  return [...root.querySelectorAll("button")].find(
    (button) => button.textContent.trim() === label
  ) ?? null;
}

function clickButton(root, label) {
  const button = findButton(root, label);
  assert.ok(button, `button ${label} is present`);
  button.click();
}
