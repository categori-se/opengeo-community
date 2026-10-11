import assert from "node:assert/strict";
import {afterEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {ProjectServices} from "../src/components/ProjectServices.js";

const ID = {
  project: "50000000-0000-4000-8000-000000000168",
  service: "60000000-0000-4000-8000-000000000168",
  collectionA: "70000000-0000-4000-8000-000000000168",
  collectionB: "70000000-0000-4000-8000-000000000169",
  resourceA: "80000000-0000-4000-8000-000000000168",
  resourceB: "80000000-0000-4000-8000-000000000169",
  store: "90000000-0000-4000-8000-000000000168",
  user: "20000000-0000-4000-8000-000000000168"
};

let previousDocument;
let previousWindow;

afterEach(() => {
  globalThis.document = previousDocument;
  globalThis.window = previousWindow;
});

describe("spatial catalog administration UI", () => {
  for (const status of [403, 503]) {
    it(`does not turn a ${status} cache-policy read into an empty configuration`, async () => {
      const harness = setup();
      harness.state.adapter.getTileCachePolicy = async () => { throw Object.assign(new Error(), {status, code:"policy_unavailable"}); };
      document.body.append(ProjectServices({state:harness.state,refresh:async()=>{}}));
      await waitFor(()=>document.querySelector(".project-service-catalog")?.dataset.state === "ready");
      assert.match(document.body.textContent,/Collection catalog failed safely/);
      assert.equal(document.querySelector(".tile-seed-plan-catalog"),null);
    });
  }

  it("treats only a missing policy as initial tile-cache setup", async () => {
    const harness = setup();
    harness.state.adapter.getTileCachePolicy = async () => { throw Object.assign(new Error(), {status:404}); };
    document.body.append(ProjectServices({state:harness.state,refresh:async()=>{}}));
    await waitFor(()=>document.querySelector(".tile-seed-plan-catalog"));
    assert.match(document.body.textContent,/Save tile cache settings above/);
    assert.doesNotMatch(document.body.textContent,/Collection catalog failed safely/);
  });

  it("keeps operational detail collapsed while exposing compact metadata, stores, groups, and styles", async () => {
    const harness = setup();
    const component = ProjectServices({state: harness.state, refresh: async () => {}});
    document.body.append(component);
    await waitFor(() => document.querySelector(".spatial-catalog-admin"));

    assert.equal(document.querySelector(".project-service-card-heading h3").textContent, "Research atlas");
    assert.deepEqual(
      [...document.querySelectorAll(".spatial-catalog-sections > details > summary")]
        .map((item) => item.textContent.split(" · ")[0]),
      ["Metadata", "Stores", "Layer groups", "Styles"]
    );
    const topLevel = [...document.querySelectorAll(".project-service-card > details:not(.service-connection)")];
    assert.equal(topLevel[0].open, true);
    assert.equal(topLevel[1].open, false);
    assert.equal(topLevel[2].open, false);
    assert.match(topLevel[1].querySelector("summary").textContent, /Published objects/);
    assert.match(document.querySelector(".spatial-catalog-admin").textContent, /top-to-bottom/);
  });

  it("submits explicit top-to-bottom collection order", async () => {
    const harness = setup();
    document.body.append(ProjectServices({state: harness.state, refresh: async () => {}}));
    await waitFor(() => document.querySelector(".spatial-catalog-member-order"));

    const create = [...document.querySelectorAll("details")].find(
      (item) => item.querySelector(":scope > summary")?.textContent === "Create layer group"
    );
    assert.ok(create);
    create.open = true;
    const memberRows = [...create.querySelectorAll(".spatial-catalog-member")];
    memberRows[0].querySelector("button").click();
    memberRows[1].querySelector("button").click();
    await Promise.resolve();
    const selectedRows = [...create.querySelectorAll('.spatial-catalog-member[data-selected="true"]')];
    selectedRows[1].querySelector('button[title="Draw one position higher"]').click();
    const save = [...create.querySelectorAll("button")].find(
      (item) => item.textContent === "Create group"
    );
    save.click();
    await waitFor(() => harness.groupDraft !== null);

    assert.deepEqual(
      harness.groupDraft.memberCollectionIds,
      [ID.collectionB, ID.collectionA]
    );
    assert.equal(harness.groupDraft.expectedVersion, 0);
    await waitFor(() => [...document.querySelectorAll("details")].some(
      (item) => item.open
        && item.querySelector(":scope > summary")?.textContent === "Create layer group"
    ));
  });
});

function setup() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://studio.example.test"
  });
  previousDocument = globalThis.document;
  previousWindow = globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const harness = {groupDraft: null};
  const bindings = [
    binding(ID.collectionA, ID.resourceA, "Roads"),
    binding(ID.collectionB, ID.resourceB, "Parcels")
  ];
  const catalog = {
    metadata: {
      versionId: crypto.randomUUID(),
      serviceId: ID.service,
      versionNumber: 2,
      title: "Research atlas",
      abstract: "Governed project service",
      namespaceUri: "https://example.test/ns/research",
      keywords: ["research"],
      fees: null,
      accessConstraints: ["none"],
      contact: {name: "Catalog Admin"},
      enabledProtocols: ["ogc_api_features", "wms_1_3"],
      changeMessage: null,
      createdBy: ID.user,
      createdAt: "2026-09-01T12:00:00Z"
    },
    stores: [{
      id: ID.store,
      projectId: ID.project,
      serviceId: ID.service,
      slug: "managed",
      title: "Managed project datasets",
      description: null,
      kind: "managed_project",
      datasetId: null,
      externalConnectionId: null,
      sealedSourceRevisionNumber: null,
      sealedConnectionRevisionNumber: null,
      configuration: {},
      createdBy: ID.user,
      createdAt: "2026-09-01T12:00:00Z",
      disabledBy: null,
      disabledAt: null
    }],
    layerGroups: [],
    styles: [],
    limits: {
      storesPerService: 16,
      layerGroupsPerService: 64,
      membersPerLayerGroup: 64,
      stylesPerCollection: 8,
      keywordsPerService: 32,
      accessConstraintsPerService: 16,
      bulkOperations: 64,
      bulkRequestBytes: 262144
    },
    semantics: {
      namespace: "one project-scoped service identifier",
      layerOrder: "the first layer-group member draws on top",
      styleHistory: "style assignments seal exact governed style revisions",
      bulk: "all operations commit together or none commit"
    }
  };
  const state = {
    project: {id: ID.project, name: "Research", callerRole: "owner"},
    organization: {callerRole: "admin"},
    spatialServices: [{
      id: ID.service,
      projectId: ID.project,
      slug: "research",
      title: "Original title",
      description: null,
      disabledAt: null
    }],
    datasets: [],
    resources: [],
    adapter: {
      kind: "api",
      baseUrl: "/api",
      listSpatialServiceCollections: async () => structuredClone(bindings),
      listSpatialServiceCoverages: async () => [],
      getCoverageProcessingPolicy: async () => null,
      getSpatialServiceCatalog: async () => structuredClone(catalog),
      listRetiredTileCacheVersions: async () => [],
      getTileCachePolicy: async () => null,
      listTileSeedPlans: async () => [],
      listResourceStyles: async () => [],
      listRenderProfiles: async () => [],
      putSpatialServiceLayerGroup: async (_projectId, _serviceId, _slug, draft) => {
        harness.groupDraft = structuredClone(draft);
        return {};
      }
    }
  };
  harness.state = state;
  return harness;
}

function binding(id, resourceId, collectionName) {
  return {
    id,
    collectionName,
    resourceId,
    withdrawnAt: null,
    stale: false,
    sealedFeatureGeneration: 1,
    sealedProfileVersionNumber: 1
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}
