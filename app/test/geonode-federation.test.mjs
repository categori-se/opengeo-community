import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {ProjectFederations} from "../src/components/ProjectFederations.js";
import {
  ApiContractError,
  OpenGeoApiClient,
  parseGeoNodeFederatedResource,
  parseGeoNodeFederationSource
} from "../src/lib/apiClient.js";

const IDS = Object.freeze({
  organization: "10000000-0000-4000-8000-000000000067",
  user: "20000000-0000-4000-8000-000000000067",
  project: "50000000-0000-4000-8000-000000000067",
  source: "60000000-0000-4000-8000-000000000067",
  job: "70000000-0000-4000-8000-000000000067",
  idempotency: "80000000-0000-4000-8000-000000000067",
  resource: "90000000-0000-4000-8000-000000000067"
});
const COMMIT = "a1db97e81dfc26c16bb4ee1a5d2b408877af66c9";

describe("GeoNode federation API contract", () => {
  it("registers only exact anonymous GeoNode 5.1 configuration", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(sourcePayload());
      }
    });

    const source = await client.createGeoNodeFederation(IDS.project, configuration());
    assert.equal(source.configuration.harvester.credential_mode, "anonymous");
    assert.equal(source.configuration.source.commit, COMMIT);
    assert.equal(calls[0].options.credentials, "omit");
    assert.deepEqual(JSON.parse(calls[0].options.body), {configuration: configuration()});
    assert.doesNotMatch(calls[0].options.body, /authorization|password|secret|token/i);

    await assert.rejects(
      client.createGeoNodeFederation(IDS.project, {
        ...configuration(),
        harvester: {...configuration().harvester, credential_mode: "bearer"}
      }),
      TypeError
    );
    await assert.rejects(
      client.createGeoNodeFederation(IDS.project, {
        ...configuration(),
        harvester: {
          ...configuration().harvester,
          remote_url: "https://geonode.example.org?token=not-allowed"
        }
      }),
      TypeError
    );
    assert.equal(calls.length, 1);
    assert.throws(
      () => parseGeoNodeFederationSource({...sourcePayload(), unexpected: true}),
      ApiContractError
    );
  });

  it("parses bounded harvest and resource history routes", async () => {
    const calls = [];
    const responses = [harvestPayload(), resourcePayload(), versionPayload()];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse([responses.shift()]);
      }
    });

    const jobs = await client.listGeoNodeHarvests(IDS.project, IDS.source, {limit: 20});
    const resources = await client.listGeoNodeFederatedResources(
      IDS.project, IDS.source, {limit: 100}
    );
    const versions = await client.listGeoNodeFederatedResourceVersions(
      IDS.project, IDS.source, IDS.resource, {limit: 100}
    );

    assert.equal(jobs[0].state, "completed");
    assert.equal(resources[0].remoteIdentifier, IDS.resource);
    assert.equal(versions[0].action, "added");
    assert.match(calls[2].url, new RegExp(`${IDS.resource}/versions\\?limit=100&offset=0$`));
    assert.throws(
      () => parseGeoNodeFederatedResource({...resourcePayload(), status: "unknown"}),
      ApiContractError
    );
  });
});

let harness;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: `https://studio.opengeo.tools/workspaces?project=${IDS.project}`
  });
  const previous = new Map();
  for (const [name, value] of Object.entries({
    document: dom.window.document,
    location: dom.window.location,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event
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

describe("project federation UI", () => {
  it("loads lazily, exposes freshness and history, and never implies an automatic timer", async () => {
    const calls = [];
    const source = sourceRecord();
    const state = {
      adapter: {
        async listGeoNodeFederations(projectId, page) {
          calls.push(["sources", projectId, page]);
          return [source];
        },
        async listGeoNodeFederatedResources() {
          calls.push(["resources"]);
          return [resourceRecord()];
        },
        async listGeoNodeHarvests() {
          calls.push(["harvests"]);
          return [harvestRecord()];
        },
        async listGeoNodeFederatedResourceVersions() {
          calls.push(["versions"]);
          return [versionRecord()];
        },
        async createGeoNodeHarvest() {
          calls.push(["refresh"]);
          return harvestRecord({state: "queued", result: null, finishedAt: null});
        },
        async createGeoNodeFederation() {},
        async disableGeoNodeFederation() {}
      },
      organization: {callerRole: "member"},
      project: {id: IDS.project, callerRole: "owner"}
    };

    const panel = ProjectFederations({state});
    assert.equal(calls.length, 0);
    assert.match(panel.textContent, /Federated catalogs/);
    assert.doesNotMatch(panel.textContent, /Browser|Places/);

    panel.open = true;
    panel.dispatchEvent(new Event("toggle"));
    await tick();
    assert.deepEqual(calls[0], ["sources", IDS.project, {limit: 100}]);
    assert.match(panel.textContent, /anonymous/);
    assert.match(panel.textContent, /manual trigger required/i);
    assert.match(panel.textContent, /does not create a timer or always-on compute/i);

    findButton(panel, "Inspect catalog").click();
    await tick();
    assert.equal(calls.some(([name]) => name === "resources"), true);
    assert.match(panel.textContent, /PM2.5 concentration/);
    assert.match(panel.textContent, /fresh until/i);

    findButton(panel, "History").click();
    await tick();
    assert.match(panel.textContent, /v1 · added/);
    assert.match(panel.textContent, /sha256:/);
  });
});

function configuration() {
  return {
    schema_version: "opengeo.geonode-federation-configuration.1.0.0",
    source: {product: "geonode", version: "5.1.0", commit: COMMIT},
    harvester: {
      name: "Regional GeoNode",
      remote_url: "https://geonode.example.org",
      scheduling_enabled: true,
      refresh_interval_minutes: 1440,
      maximum_resources: 100,
      credential_mode: "anonymous"
    }
  };
}

function sourcePayload() {
  return {
    schema_version: "opengeo.geonode-federation-source.1.0.0",
    source_id: IDS.source,
    project_id: IDS.project,
    configuration: configuration(),
    conversion_report: {
      schema_version: "opengeo.geonode-federation-conversion-report.1.0.0",
      summary: {mapped: 6, preserved: 0, unsupported: 0, credentials: 0}
    },
    configuration_checksum_sha256: "a".repeat(64),
    status: "active",
    created_by: IDS.user,
    created_at: "2026-08-31T12:00:00Z",
    disabled_at: null
  };
}

function harvestPayload() {
  return {
    schema_version: "opengeo.geonode-harvest-job.1.0.0",
    job_id: IDS.job,
    source_id: IDS.source,
    project_id: IDS.project,
    source_configuration_checksum_sha256: "a".repeat(64),
    request_checksum_sha256: "b".repeat(64),
    idempotency_key: IDS.idempotency,
    state: "completed",
    result: {counts: {added: 1, updated: 0, unchanged: 0, withdrawn: 0}},
    error_code: null,
    attempt_count: 1,
    created_by: IDS.user,
    created_at: "2026-08-31T12:01:00Z",
    started_at: "2026-08-31T12:01:01Z",
    finished_at: "2026-08-31T12:01:02Z",
    cancellable: false
  };
}

function resourcePayload() {
  return {
    schema_version: "opengeo.geonode-federated-resource.1.0.0",
    source_id: IDS.source,
    remote_identifier: IDS.resource,
    resource_type: "dataset",
    title: "PM2.5 concentration",
    status: "current",
    current_version_number: 1,
    current_payload_sha256: "c".repeat(64),
    remote_modified_at: "2026-08-31T11:00:00Z",
    first_seen_at: "2026-08-31T12:01:02Z",
    last_refreshed_at: "2026-08-31T12:01:02Z",
    fresh_until: "2099-08-31T12:01:02Z",
    withdrawn_at: null
  };
}

function versionPayload() {
  return {
    schema_version: "opengeo.geonode-federated-resource-version.1.0.0",
    source_id: IDS.source,
    remote_identifier: IDS.resource,
    version_number: 1,
    harvest_job_id: IDS.job,
    action: "added",
    resource_type: "dataset",
    title: "PM2.5 concentration",
    payload_sha256: "c".repeat(64),
    payload: {pk: IDS.resource, title: "PM2.5 concentration"},
    remote_modified_at: "2026-08-31T11:00:00Z",
    observed_at: "2026-08-31T12:01:02Z"
  };
}

function sourceRecord() {
  return {
    sourceId: IDS.source,
    projectId: IDS.project,
    configuration: configuration(),
    configurationChecksumSha256: "a".repeat(64),
    status: "active"
  };
}

function resourceRecord() {
  return {
    sourceId: IDS.source,
    remoteIdentifier: IDS.resource,
    resourceType: "dataset",
    title: "PM2.5 concentration",
    status: "current",
    currentVersionNumber: 1,
    currentPayloadSha256: "c".repeat(64),
    firstSeenAt: "2026-08-31T12:01:02Z",
    lastRefreshedAt: "2026-08-31T12:01:02Z",
    freshUntil: "2099-08-31T12:01:02Z",
    withdrawnAt: null
  };
}

function harvestRecord(overrides = {}) {
  return {
    jobId: IDS.job,
    state: "completed",
    result: {counts: {added: 1, updated: 0, unchanged: 0, withdrawn: 0}},
    attemptCount: 1,
    createdAt: "2026-08-31T12:01:00Z",
    finishedAt: "2026-08-31T12:01:02Z",
    cancellable: false,
    ...overrides
  };
}

function versionRecord() {
  return {
    versionNumber: 1,
    action: "added",
    observedAt: "2026-08-31T12:01:02Z",
    payloadSha256: "c".repeat(64)
  };
}

function findButton(root, label) {
  const candidate = [...root.querySelectorAll("button")]
    .find(({textContent}) => textContent === label);
  assert.ok(candidate, `button ${label} exists`);
  return candidate;
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {"content-type": "application/json"}
  });
}
