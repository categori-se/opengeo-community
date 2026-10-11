import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {ProjectDatasets} from "../src/components/ProjectDatasets.js";

const IDS = Object.freeze({
  organization: "10000000-0000-4000-8000-000000000081",
  project: "50000000-0000-4000-8000-000000000081",
  dataset: "80000000-0000-4000-8000-000000000081",
  version: "81000000-0000-4000-8000-000000000081",
  resource: "90000000-0000-4000-8000-000000000081",
  map: "60000000-0000-4000-8000-000000000081",
  secondMap: "60000000-0000-4000-8000-000000000082"
});

let harness;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: `https://studio.opengeo.tools/workspaces?project=${IDS.project}&manage=data`
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

describe("dataset governance handoff", () => {
  it("shows source details and access controls through reopen and reload without reading provider data", async () => {
    let calls = 0;
    const current = state({kind: "api", updateSource: async () => {calls++;}, getSession: async () => {calls++;}});
    current.datasets[0].sourceType = "xyz";
    current.sources = [{datasetId: IDS.dataset, projectId: IDS.project, name: "Public tiles",
      sourceType: "xyz", sourceUrl: "https://example.test/{z}/{x}/{y}.png", versionNumber: 1,
      classification: "internal", configuration: {attribution: "Provider"}, capabilities: {manageClassification: true}}];
    const root = ProjectDatasets({state: current, refresh: async () => {}}); document.body.append(root);
    const visibleAccess = () => {
      const access = root.querySelector('[aria-label="Source access"]'); assert.ok(access);
      for (let node = access; node && node !== root; node = node.parentElement) assert.equal(node.hidden, false);
      assert.ok(findButton(root, "Apply access")); return access;
    };
    click(root, "Source details"); await waitFor(() => root.querySelector('.source-access-editor select'));
    const original = visibleAccess(), view = original.closest('.project-dataset-inspection-view');
    click(view, "Hide view"); assert.equal(view.hidden, true);
    click(root, "Source details"); assert.equal(visibleAccess(), original);
    click(view, "Reload view"); await waitFor(() => root.querySelector('.source-access-editor select') !== original);
    assert.notEqual(visibleAccess(), original); assert.equal(calls, 0);
  });

  it("isolates late history/catalog responses and retains metadata drafts across view changes", async () => {
    let resolveCatalog, resolveHistory;
    let catalogReads = 0;
    const adapter = {
      kind: "api",
      listResources() { catalogReads += 1; return new Promise((resolve) => { resolveCatalog = resolve; }); },
      listDatasetVersions() { return new Promise((resolve) => { resolveHistory = resolve; }); },
      async createResource() { throw new Error("Switching must not save"); }
    };
    const root = ProjectDatasets({state: state(adapter), refresh: async () => {}});
    document.body.append(root);
    click(root, "Metadata & publishing");
    click(root, "Version history");
    resolveCatalog([]);
    const form = await waitFor(() => root.querySelector(".project-dataset-governance-form"));
    const governanceView = form.closest(".project-dataset-inspection-view");
    assert.equal(governanceView.hidden, true);
    assert.match(root.querySelector(".project-dataset-inspection-view:not([hidden])").textContent, /Loading authorized logical versions/);
    resolveHistory([]);
    await waitFor(() => root.querySelector(".project-version-history"));
    click(root, "Metadata & publishing");
    const title = form.querySelector('[aria-label="Governed dataset title"]');
    title.value = "Unfinished curation";
    click(root, "Version history");
    assert.equal(governanceView.hidden, true);
    click(root, "Metadata & publishing");
    assert.equal(root.querySelector(".project-dataset-governance-form"), form);
    assert.equal(title.value, "Unfinished curation");
    assert.equal(catalogReads, 1);
    const govern = findButton(root, "Metadata & publishing");
    assert.equal(govern.getAttribute("aria-expanded"), "true");
    assert.equal(govern.getAttribute("aria-controls"), governanceView.id);
    assert.equal(findButton(root, "Version history").getAttribute("aria-expanded"), "false");
    findButton(governanceView, "Hide view").click();
    assert.equal(document.activeElement, govern);
    assert.equal(govern.getAttribute("aria-expanded"), "false");
    govern.click();
    assert.equal(title.value, "Unfinished curation");
  });

  it("requires confirmation to reload an editor and keeps a detach error out of its draft", async () => {
    let reads = 0;
    const adapter = {
      kind: "api",
      async listResources() { reads += 1; return []; },
      async createResource() {},
      async detachDataset() { throw Object.assign(new Error("used"), {code: "project_dataset_in_use"}); }
    };
    const root = ProjectDatasets({state: state(adapter), refresh: async () => {}});
    document.body.append(root);
    click(root, "Metadata & publishing");
    const form = await waitFor(() => root.querySelector(".project-dataset-governance-form"));
    const title = form.querySelector('[aria-label="Governed dataset title"]');
    title.value = "Keep this draft";
    click(root, "Remove from project");
    await waitFor(() => root.querySelector(".project-dataset-detach-error"));
    assert.equal(title.value, "Keep this draft");
    assert.equal(form.isConnected, true);
    harness.dom.window.confirm = () => false;
    click(form.closest(".project-dataset-inspection-view"), "Reload view");
    assert.equal(reads, 1);
    assert.equal(title.value, "Keep this draft");
    harness.dom.window.confirm = () => true;
    click(form.closest(".project-dataset-inspection-view"), "Reload view");
    const replacement = await waitFor(() => {
      const candidate = root.querySelector(".project-dataset-governance-form");
      return candidate !== form && candidate;
    });
    assert.equal(reads, 2);
    assert.equal(replacement.querySelector('[aria-label="Governed dataset title"]').value, "MassGIS Risk Index");
  });

  it("creates one dataset-bound resource and links directly to its curation surface", async () => {
    const calls = [];
    const adapter = {
      kind: "api",
      async listResources(projectId, filters) {
        calls.push({method: "list", projectId, filters});
        return [];
      },
      async createResource(projectId, draft) {
        calls.push({method: "create", projectId, draft});
        return resource(draft);
      }
    };
    const root = ProjectDatasets({state: state(adapter), refresh: async () => {}});

    click(root, "Metadata & publishing");
    const form = await waitFor(() => root.querySelector(".project-dataset-governance-form"));
    assert.equal(form.querySelector('[aria-label="Governed dataset slug"]').value, "massgis-risk-index");
    form.querySelector('[aria-label="Governed dataset license"]').value = "CC-BY-4.0";
    form.querySelector('[aria-label="Governed dataset attribution"]').value = "MassGIS";
    form.dispatchEvent(new harness.dom.window.Event("submit", {bubbles: true, cancelable: true}));

    const link = await waitFor(() => root.querySelector(".project-dataset-version-panel a"));
    assert.equal(link.textContent, "Open metadata, styles & publishing");
    assert.equal(
      link.getAttribute("href"),
      `/workspaces?project=${IDS.project}&manage=resources#resource-${IDS.resource}`
    );
    const creation = calls.find(({method}) => method === "create");
    assert.equal(creation.projectId, IDS.project);
    assert.deepEqual(creation.draft, {
      kind: "dataset",
      slug: "massgis-risk-index",
      datasetId: IDS.dataset,
      visibility: "restricted",
      metadata: {
        title: "MassGIS Risk Index",
        abstract: "Reviewed statewide indicators",
        language: "en",
        license: "CC-BY-4.0",
        attribution: "MassGIS",
        keywords: ["massgis", "risk"],
        spatialExtent: [-73.6, 41.2, -69.8, 42.9],
        profile: "opengeo.core.v1",
        extensions: {},
        translations: {}
      },
      content: {blocks: []},
      provenance: {
        source: "project_dataset",
        datasetId: IDS.dataset,
        datasetVersionId: IDS.version,
        datasetVersionNumber: 3,
        sourceType: "upload",
        format: "geojson"
      }
    });
  });

  it("reuses the canonical catalog identity instead of offering a duplicate", async () => {
    let creates = 0;
    const existing = resource({slug: "massgis-risk-index", datasetId: IDS.dataset});
    const adapter = {
      kind: "api",
      async listResources() { return [existing]; },
      async createResource() { creates += 1; }
    };
    const root = ProjectDatasets({state: state(adapter), refresh: async () => {}});

    click(root, "Metadata & publishing");
    const ready = await waitFor(() => root.querySelector(".project-dataset-version-panel a"));

    assert.match(root.textContent, /Governed catalog record ready/);
    assert.equal(ready.getAttribute("href").endsWith(`#resource-${IDS.resource}`), true);
    assert.equal(creates, 0);
  });

  it("recovers a concurrent-create conflict by opening the winning identity", async () => {
    const existing = resource({slug: "massgis-risk-index", datasetId: IDS.dataset});
    let lists = 0;
    const adapter = {
      kind: "api",
      async listResources() {
        lists += 1;
        return lists === 1 ? [] : [existing];
      },
      async createResource() {
        throw Object.assign(new Error("conflict"), {code: "resource_conflict"});
      }
    };
    const root = ProjectDatasets({state: state(adapter), refresh: async () => {}});

    click(root, "Metadata & publishing");
    const form = await waitFor(() => root.querySelector(".project-dataset-governance-form"));
    form.querySelector('[aria-label="Governed dataset license"]').value = "CC-BY-4.0";
    form.querySelector('[aria-label="Governed dataset attribution"]').value = "MassGIS";
    form.dispatchEvent(new harness.dom.window.Event("submit", {bubbles: true, cancelable: true}));

    await waitFor(() => root.querySelector(".project-dataset-version-panel a"));
    assert.equal(lists, 2);
    assert.match(root.textContent, /Governed catalog record ready/);
  });

  it("does not expose catalog mutation to a viewer", () => {
    const current = state({listResources() {}, createResource() {}});
    current.project.callerRole = "viewer";
    current.organization.callerRole = "member";
    const root = ProjectDatasets({state: current, refresh: async () => {}});
    assert.equal(findButton(root, "Metadata & publishing"), null);
    assert.equal(root.querySelector(".project-dataset-map-handoff"), null);
  });

  it("carries the exact current version into a chosen map without changing data", () => {
    const current = state({kind: "api", getDatasetSpatialPreview() {}});
    current.maps = [
      {
        id: IDS.secondMap,
        name: "Existing use",
        status: "active",
        definition: {layers: [{datasetId: IDS.dataset}]}
      },
      {
        id: IDS.map,
        name: "Environmental review",
        status: "active",
        definition: {layers: []}
      }
    ];
    const root = ProjectDatasets({state: current, refresh: async () => {}});
    const disclosure = root.querySelector(".project-dataset-map-handoff");
    assert.ok(disclosure);
    assert.match(disclosure.textContent, /Nothing changes until you confirm Add in the map and then Save/);

    const add = disclosure.querySelector(`[data-map-id="${IDS.map}"]`);
    assert.equal(add.dataset.handoff, "add");
    assert.equal(
      add.getAttribute("href"),
      `/workspaces?project=${IDS.project}&map=${IDS.map}&intent=add-dataset`
        + `&dataset=${IDS.dataset}&datasetVersion=${IDS.version}#map-workspace`
    );
    const existing = disclosure.querySelector(`[data-map-id="${IDS.secondMap}"]`);
    assert.equal(existing.dataset.handoff, "open");
    assert.equal(
      existing.getAttribute("href"),
      `/workspaces?project=${IDS.project}&map=${IDS.secondMap}#map-workspace`
    );
  });

  it("reveals exact version lineage without exposing storage coordinates", async () => {
    const adapter = {
      kind: "api",
      async listDatasetVersions() {
        return [{
          id: IDS.version,
          versionNumber: 3,
          parentVersionId: null,
          state: "active",
          changeMessage: "Reviewed MassGIS snapshot",
          featureCount: 5_109,
          extent: [-73.6, 41.2, -69.8, 42.9],
          crs: "EPSG:4326",
          geometryType: "Polygon",
          schemaDefinition: {},
          qualityResults: {valid: true, checks: [], warnings: [], errors: []},
          createdBy: "20000000-0000-4000-8000-000000000081",
          createdAt: "2026-09-02T12:00:00Z",
          current: true,
          objects: [{
            id: "82000000-0000-4000-8000-000000000081",
            role: "original",
            filename: "massenviroscreen.geojson",
            contentType: "application/geo+json",
            sizeBytes: 12_345,
            checksumSha256: "a".repeat(64),
            createdAt: "2026-09-02T12:00:00Z"
          }]
        }];
      },
      async getDatasetVersionLineage(projectId, datasetId, versionId) {
        assert.deepEqual([projectId, datasetId, versionId], [IDS.project, IDS.dataset, IDS.version]);
        return {
          schemaVersion: "opengeo.dataset-version-lineage.1.0.0",
          datasetId,
          versionId,
          versionNumber: 3,
          origins: [{
            kind: "external_source_archive",
            operationId: "83000000-0000-4000-8000-000000000081",
            sourceDatasetId: "84000000-0000-4000-8000-000000000081",
            sourceDatasetName: "MassGIS source service",
            sourceRevisionNumber: 7,
            inputObjectId: "82000000-0000-4000-8000-000000000081",
            acquiredAt: "2026-09-02T12:00:00Z"
          }],
          derivatives: [],
          derivativesTruncated: false
        };
      }
    };
    const root = ProjectDatasets({state: state(adapter), refresh: async () => {}});

    click(root, "Version history");
    await waitFor(() => findButton(root, "Inspect lineage"));
    click(root, "Inspect lineage");
    const region = await waitFor(() => root.querySelector(".project-dataset-lineage[data-loaded='true']"));

    assert.match(region.textContent, /Protected snapshot of MassGIS source service · source revision 7/);
    assert.match(region.textContent, /No derived objects are recorded/);
    assert.doesNotMatch(region.textContent, /bucket|object_key|s3_version|etag/i);
    assert.equal(findButton(root, "Hide lineage").getAttribute("aria-expanded"), "true");
  });
});

function state(adapter) {
  return {
    adapter,
    session: {userId: "20000000-0000-4000-8000-000000000081"},
    organization: {id: IDS.organization, callerRole: "member"},
    project: {id: IDS.project, callerRole: "owner"},
    datasets: [{
      id: IDS.dataset,
      projectId: IDS.project,
      name: "MassGIS Risk Index",
      description: "Reviewed statewide indicators",
      classification: "internal",
      sourceType: "upload",
      format: "geojson",
      status: "active",
      ownerUserId: "20000000-0000-4000-8000-000000000081",
      currentVersionId: IDS.version,
      currentVersionNumber: 3,
      currentVersionState: "active",
      featureCount: 5_109,
      extent: [-73.6, 41.2, -69.8, 42.9],
      crs: "EPSG:4326",
      geometryType: "Polygon",
      qualityResults: {checks: [], warnings: [], errors: []},
      processingJobState: "completed",
      processingErrorCode: null,
      tags: ["massgis", "risk", "massgis"],
      capabilities: {read: true, edit: true, download: true, managePermissions: true}
    }],
    sources: [],
    maps: [],
    resources: [],
    metadataProfiles: [],
    datasetConnectionBindings: [],
    basemapConnectionBindings: []
  };
}

function resource(draft) {
  return {
    id: IDS.resource,
    projectId: IDS.project,
    kind: "dataset",
    slug: draft.slug,
    datasetId: draft.datasetId,
    mapId: null,
    visibility: draft.visibility ?? "restricted",
    state: "draft",
    versionNumber: 1,
    title: draft.metadata?.title ?? "MassGIS Risk Index",
    abstract: draft.metadata?.abstract ?? null,
    language: "en",
    license: draft.metadata?.license ?? "CC-BY-4.0",
    attribution: draft.metadata?.attribution ?? "MassGIS",
    keywords: draft.metadata?.keywords ?? [],
    spatialExtent: draft.metadata?.spatialExtent ?? null,
    temporalStart: null,
    temporalEnd: null,
    ownerUserId: "20000000-0000-4000-8000-000000000081",
    originNamespace: null,
    originIdentifier: null,
    relationshipCount: 0,
    createdAt: "2026-09-02T12:00:00Z",
    updatedAt: "2026-09-02T12:00:00Z"
  };
}

function click(root, label) {
  const button = findButton(root, label);
  assert.ok(button, `${label} button is missing`);
  button.click();
}

function findButton(root, label) {
  return [...root.querySelectorAll("button")].find(({textContent}) => textContent === label) ?? null;
}

async function waitFor(callback, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = callback();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition was not reached");
}
