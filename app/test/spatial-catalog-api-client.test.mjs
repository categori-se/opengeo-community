import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  ApiContractError,
  OpenGeoApiClient,
  parseSpatialServiceCatalog,
  parseSpatialServiceCollectionStyle,
  parseSpatialServiceLayerGroup,
  parseSpatialServiceMetadata,
  parseSpatialServiceStore
} from "../src/lib/apiClient.js";

const ID = {
  organization: "10000000-0000-4000-8000-000000000168",
  project: "50000000-0000-4000-8000-000000000168",
  service: "60000000-0000-4000-8000-000000000168",
  store: "61000000-0000-4000-8000-000000000168",
  collection: "70000000-0000-4000-8000-000000000168",
  style: "a2000000-0000-4000-8000-000000000168",
  styleVersion: "a3000000-0000-4000-8000-000000000168",
  profile: "a4000000-0000-4000-8000-000000000168",
  profileVersion: "a5000000-0000-4000-8000-000000000168",
  metadataVersion: "a8000000-0000-4000-8000-000000000168",
  group: "a9000000-0000-4000-8000-000000000168",
  groupVersion: "aa000000-0000-4000-8000-000000000168",
  styleBinding: "ab000000-0000-4000-8000-000000000168",
  user: "20000000-0000-4000-8000-000000000168"
};

function metadataPayload() {
  return {
    version_id: ID.metadataVersion,
    service_id: ID.service,
    version_number: 1,
    title: "Research atlas",
    abstract: "Project service metadata",
    namespace_uri: "https://example.test/ns/research",
    keywords: ["roads"],
    fees: null,
    access_constraints: ["none"],
    contact: {name: "Catalog Admin"},
    enabled_protocols: ["wms_1_3", "wfs_2_0"],
    change_message: null,
    created_by: ID.user,
    created_at: "2026-09-01T14:00:00Z"
  };
}

function storePayload() {
  return {
    id: ID.store,
    project_id: ID.project,
    service_id: ID.service,
    slug: "managed",
    title: "Managed project datasets",
    description: null,
    kind: "managed_project",
    dataset_id: null,
    external_connection_id: null,
    sealed_source_revision_number: null,
    sealed_connection_revision_number: null,
    configuration: {},
    created_by: ID.user,
    created_at: "2026-09-01T14:00:00Z",
    disabled_by: null,
    disabled_at: null
  };
}

function groupPayload() {
  return {
    id: ID.group,
    project_id: ID.project,
    service_id: ID.service,
    slug: "transport",
    version_id: ID.groupVersion,
    version_number: 1,
    title: "Transport",
    description: null,
    mode: "named",
    member_collection_ids: [ID.collection],
    change_message: null,
    created_by: ID.user,
    created_at: "2026-09-01T14:00:00Z",
    updated_by: ID.user,
    updated_at: "2026-09-01T14:00:00Z",
    disabled_by: null,
    disabled_at: null
  };
}

function stylePayload() {
  return {
    id: ID.styleBinding,
    project_id: ID.project,
    service_id: ID.service,
    collection_id: ID.collection,
    style_name: "roads-default",
    style_id: ID.style,
    sealed_style_version_id: ID.styleVersion,
    sealed_style_version_number: 1,
    current_style_version_id: ID.styleVersion,
    current_style_version_number: 1,
    render_profile_id: ID.profile,
    sealed_profile_version_id: ID.profileVersion,
    sealed_profile_version_number: 1,
    current_profile_version_id: ID.profileVersion,
    current_profile_version_number: 1,
    consumable: true,
    stale: false,
    is_default: true,
    created_by: ID.user,
    created_at: "2026-09-01T14:00:00Z",
    withdrawn_by: null,
    withdrawn_at: null
  };
}

function catalogPayload() {
  return {
    metadata: metadataPayload(),
    stores: [storePayload()],
    layer_groups: [groupPayload()],
    styles: [stylePayload()],
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
}

function json(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {"Content-Type": "application/json"}
  });
}

describe("spatial catalog API client", () => {
  it("parses one compact catalog read with exact store, group, style, and metadata facts", () => {
    const result = parseSpatialServiceCatalog(catalogPayload());
    assert.equal(result.metadata.versionNumber, 1);
    assert.equal(result.stores[0].kind, "managed_project");
    assert.deepEqual(result.layerGroups[0].memberCollectionIds, [ID.collection]);
    assert.equal(result.styles[0].stale, false);
    assert.equal(result.styles[0].consumable, true);
    assert.equal(result.semantics.layerOrder, "the first layer-group member draws on top");
  });

  it("rejects inconsistent style freshness and duplicate group members", () => {
    assert.throws(
      () => parseSpatialServiceCollectionStyle({...stylePayload(), stale: true}),
      ApiContractError
    );
    assert.throws(
      () => parseSpatialServiceLayerGroup({
        ...groupPayload(),
        member_collection_ids: [ID.collection, ID.collection]
      }),
      ApiContractError
    );
    assert.throws(
      () => parseSpatialServiceStore({...storePayload(), dataset_id: ID.collection}),
      ApiContractError
    );
    assert.throws(
      () => parseSpatialServiceMetadata({...metadataPayload(), keywords: ["roads", "roads"]}),
      ApiContractError
    );
  });

  it("serializes metadata and ordered group writes with API field names", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "token",
      organizationProvider: () => ID.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return url.endsWith("/metadata") ? json(metadataPayload()) : json(groupPayload());
      }
    });
    await client.updateSpatialServiceMetadata(ID.project, ID.service, {
      expectedVersion: 1,
      title: "Research atlas",
      abstract: "Project service metadata",
      namespaceUri: "https://example.test/ns/research",
      keywords: ["roads"],
      fees: null,
      accessConstraints: ["none"],
      contact: {name: "Catalog Admin"},
      enabledProtocols: ["wms_1_3", "wfs_2_0"],
      changeMessage: "Review metadata"
    });
    await client.putSpatialServiceLayerGroup(ID.project, ID.service, "transport", {
      expectedVersion: 1,
      title: "Transport",
      description: null,
      mode: "named",
      memberCollectionIds: [ID.collection],
      changeMessage: "Roads draw first"
    });
    assert.equal(
      calls[0].url,
      `/api/projects/${ID.project}/spatial-services/${ID.service}/catalog/metadata`
    );
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      expected_version: 1,
      title: "Research atlas",
      abstract: "Project service metadata",
      namespace_uri: "https://example.test/ns/research",
      keywords: ["roads"],
      fees: null,
      access_constraints: ["none"],
      contact: {name: "Catalog Admin"},
      enabled_protocols: ["wms_1_3", "wfs_2_0"],
      change_message: "Review metadata"
    });
    assert.equal(calls[1].options.method, "PUT");
    assert.deepEqual(JSON.parse(calls[1].options.body).member_collection_ids, [ID.collection]);
  });

  it("bounds bulk automation before issuing a request", async () => {
    let called = false;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "token",
      organizationProvider: () => ID.organization,
      fetchImplementation: async () => {
        called = true;
        return json({});
      }
    });
    await assert.rejects(
      client.applySpatialServiceCatalogBulk(
        ID.project,
        ID.service,
        Array.from({length: 65}, () => ({operation: "disable_store", store_id: ID.store}))
      ),
      TypeError
    );
    assert.equal(called, false);
  });

  it("requires and serializes an exact render-profile seal for style assignment", async () => {
    let request;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "token",
      organizationProvider: () => ID.organization,
      fetchImplementation: async (url, options) => {
        request = {url, options};
        return json(stylePayload());
      }
    });
    await client.assignSpatialServiceCollectionStyle(
      ID.project,
      ID.service,
      ID.collection,
      {
        styleName: "roads-default",
        styleId: ID.style,
        expectedStyleVersion: 1,
        renderProfileId: ID.profile,
        expectedProfileVersion: 1,
        isDefault: true
      }
    );
    assert.deepEqual(JSON.parse(request.options.body), {
      style_name: "roads-default",
      style_id: ID.style,
      expected_style_version: 1,
      render_profile_id: ID.profile,
      expected_profile_version: 1,
      is_default: true
    });
    await assert.rejects(
      client.assignSpatialServiceCollectionStyle(
        ID.project,
        ID.service,
        ID.collection,
        {
          styleName: "roads-default",
          styleId: ID.style,
          expectedStyleVersion: 1,
          renderProfileId: "not-a-uuid",
          expectedProfileVersion: 1,
          isDefault: true
        }
      ),
      TypeError
    );
  });
});
