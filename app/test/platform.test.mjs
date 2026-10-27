import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {describe, it} from "node:test";

import {FixturePlatformAdapter, FIXTURE_PROJECTS} from "../src/lib/fixturePlatform.js";
import {
  createPlatformAdapter,
  loadDirectory,
  loadDirectoryCore,
  loadDirectorySupplements,
  loadProjectContext,
  loadTeamAdministration
} from "../src/lib/platform.js";
import {emptyMapDefinition} from "../src/lib/mapDefinition.js";
import {retainedProjectScope, retainedPublicationIdentity} from "../src/lib/retainedProjectScope.js";
import {sha256Hex} from "../src/components/ProjectDatasets.js";
import {
  appendCalloutBlockDraft,
  appendChartBlockDraft,
  appendCitationBlockDraft,
  appendHeadingBlockDraft,
  metadataCanonicalJson,
  metadataSourceSha256,
  appendResourceReferenceBlockDraft,
  appendNavigationBlockDraft,
  appendSiteAssetBlockDraft,
  appendTableBlockDraft,
  boundedLineDiff,
  pinCurrentResourceReferences,
  parseContentDraft,
  parseMetadataExtensionsDraft,
  parseTranslationDraft
} from "../src/components/ProjectResources.js";

const catalog = JSON.parse(
  await readFile(new URL("../src/data/catalog.json", import.meta.url), "utf8")
);

function fixtureMapLayer(dataset, layerId, stroke) {
  return {
    layerId,
    datasetId: dataset.id,
    title: dataset.name,
    sourceType: "governed-dataset",
    geometryType: dataset.geometryType ?? "LineString",
    visible: true,
    opacity: 1,
    order: 1,
    style: {stroke, strokeWidth: 3},
    labels: {enabled: false, field: null}
  };
}

function loadingProbeAdapter(calls) {
  const record = (name, value) => async () => {
    calls.push(name);
    return value;
  };
  return {
    kind: "api",
    selectOrganization() {},
    getSession: record("session", {
      userId: "user-fast",
      displayName: "Fast user",
      memberships: [{organizationId: "organization-fast", role: "admin"}],
      selectedOrganizationId: "organization-fast"
    }),
    getCurrentOrganization: record("organization", {
      id: "organization-fast",
      name: "Fast organization",
      callerRole: "admin"
    }),
    listProjects: record("projects", [{id: "project-fast", name: "Fast project", status: "active"}]),
    listClients: record("clients", [{id: "client-fast", name: "Research client"}]),
    listTeams: record("teams", [{id: "team-fast", name: "Mapping team"}]),
    listMyDatasetConnections: record("dataset-connections", []),
    listMyBasemapConnections: record("basemap-connections", []),
    listPublicSites: record("publications", {
      schemaVersion: "opengeo.public-site-directory.1.0.0",
      numberReturned: 1,
      numberMatched: 1,
      limit: 100,
      offset: 0,
      nextOffset: null,
      records: [{listedSlug: "fast-site", title: "Fast site"}]
    }),
    getProject: record("project", {id: "project-fast", name: "Fast project", status: "active"}),
    listMaps: record("maps", [{id: "map-fast", name: "Fast map", status: "active", version: 1}]),
    listDatasets: record("datasets", []),
    listSources: record("sources", []),
    listResources: record("resources", []),
    listMetadataProfiles: record("metadata-profiles", []),
    listSpatialServices: record("services", []),
    listSites: record("sites", [{id: "site-fast", title: "Fast site"}]),
    listObservableSourceProjects: record("source-projects", []),
    listProjectDatasetConnectionBindings: record("project-dataset-connections", []),
    listProjectBasemapConnectionBindings: record("project-basemap-connections", [])
  };
}

describe("platform state loader", () => {
  it("cancels the selected-map fallback read when navigation leaves the workspace", async () => {
    const adapter = loadingProbeAdapter([]);
    const controller = new AbortController();
    let started;
    const readStarted = new Promise(resolve => {started = resolve;});
    adapter.getMap = async (projectId, mapId, {signal} = {}) => {
      assert.equal(projectId, "project-fast");
      assert.equal(mapId, "map-not-in-page");
      assert.equal(signal, controller.signal);
      started();
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => {
        reject(signal.reason);
      }, {once: true}));
    };
    const pending = loadProjectContext(adapter, "project-fast", "map-not-in-page", {
      surface: "maps", signal: controller.signal
    });
    await readStarted;
    controller.abort();
    assert.notEqual((await pending).status, "ready");
  });

  it("opens an exact publication without unrelated workspace or site inventories", async () => {
    const calls = [];
    const adapter = loadingProbeAdapter(calls);
    const authority = Promise.withResolvers();
    const controller = new AbortController();
    adapter.listProjects = async () => {throw Error("Unrelated workspace inventory must not block publication");};
    adapter.listSites = async () => {throw Error("The exact publication has already been resolved");};
    adapter.getPublication = async (id, {signal}) => {
      assert.equal(signal, controller.signal); calls.push("publication");
      return {id, resourceType: "publication", accessContainerId: "project-fast"};
    };
    adapter.getProject = () => {calls.push("project"); return authority.promise;};
    for (const [method, name] of [["listResources", "resources"], ["listObservableSourceProjects", "source-projects"]]) {
      adapter[method] = async (id, {signal}) => {
        assert.equal(id, "project-fast"); assert.equal(signal, controller.signal);
        calls.push(name); return [];
      };
    }
    const pending = loadProjectContext(adapter, null, null, {publicationId: "publication-fast", signal: controller.signal});
    await new Promise(setImmediate);
    assert.deepEqual(calls, ["session", "organization", "publication", "project"]);
    authority.resolve({id: "project-fast", callerRole: "owner"});
    const state = await pending;
    assert.equal(state.status, "ready");
    assert.equal(state.sites[0].id, "publication-fast");
    assert.deepEqual(state.projects.map(({id}) => id), ["project-fast"]);
    assert.deepEqual(calls, ["session", "organization", "publication", "project", "resources", "source-projects"]);
  });

  it("passes navigation cancellation to every workspace supplemental HTTP read", async () => {
    const {OpenGeoApiClient} = await import("../src/lib/apiClient.js");
    const projectId = "50000000-0000-4000-8000-000000000001";
    const controller = new AbortController(), calls = [];
    const client = new OpenGeoApiClient({tokenProvider: () => "test-token",
      organizationProvider: () => "10000000-0000-4000-8000-000000000001",
      fetchImplementation: async (url, options) => {calls.push({url, options}); return new Response("[]", {status: 200});}});
    await Promise.all([
      client.listSources(projectId, {limit: 100, signal: controller.signal}),
      client.listResources(projectId, {limit: 100, signal: controller.signal}),
      client.listMetadataProfiles({signal: controller.signal}),
      client.listSpatialServices(projectId, {signal: controller.signal}),
      client.listSites(projectId, {signal: controller.signal}),
      client.listObservableSourceProjects(projectId, {signal: controller.signal}),
      client.listProjectDatasetConnectionBindings(projectId, {signal: controller.signal}),
      client.listProjectBasemapConnectionBindings(projectId, {signal: controller.signal})
    ]);
    assert.equal(calls.length, 8);
    for (const {url, options} of calls) {
      assert.equal(options.signal, controller.signal); assert.equal(options.method, "GET");
      assert.ok(!url.includes("signal="));
    }
  });

  it("initial session 403 repairs the selected account without widening access", async () => {
    for (const status of [403]) {
      const calls = [], reads = [], progress = [];
      const adapter = loadingProbeAdapter(calls);
      const getSession = adapter.getSession;
      const controller = new AbortController();
      let selected = "organization-fast", clears = 0;
      adapter.clearOrganization = () => {clears++; selected = null;};
      adapter.selectOrganization = id => {selected = id;};
      adapter.getSession = async function ({signal}) {
        assert.equal(this, adapter);
        reads.push({signal, selected});
        if (reads.length === 1) throw Object.assign(new Error("Initial session unavailable"), {status});
        return getSession({signal});
      };
      const state = await loadDirectoryCore(adapter, {signal: controller.signal, onProgress: event => progress.push(event)});
      assert.equal(state.status, "ready");
      assert.equal(reads.length, 2);
      assert.ok(reads.every(read => read.signal === controller.signal));
      assert.deepEqual(reads.map(read => read.selected), ["organization-fast", null]);
      assert.equal(clears, 1);
      assert.equal(selected, "organization-fast");
      assert.deepEqual(calls, ["session", "organization", "projects"]);
      assert.deepEqual(progress.filter(event => event.step === "session"), [
        {step: "session", state: "loading"}, {step: "session", state: "complete"}
      ]);
    }
  });

  it("initial session 503 does not repeat the SDK read or clear the account", async () => {
    const calls = [], signals = [], progress = [];
    const adapter = loadingProbeAdapter(calls);
    const controller = new AbortController();
    let clears = 0;
    adapter.clearOrganization = () => {clears++;};
    adapter.getSession = async ({signal}) => {
      signals.push(signal);
      throw Object.assign(new Error("Session unavailable"), {status: 503, requestId: `attempt-${signals.length}`});
    };
    const state = await loadDirectoryCore(adapter, {signal: controller.signal, onProgress: event => progress.push(event)});
    assert.equal(state.status, "error");
    assert.equal(state.requestId, "attempt-1");
    assert.deepEqual(signals, [controller.signal]);
    assert.equal(clears, 0);
    assert.deepEqual(calls, []);
    assert.deepEqual(progress, [{step: "session", state: "loading"}]);
  });

  it("initial session 503 does not retry after navigation aborts", async () => {
    const calls = [], signals = [], progress = [];
    const adapter = loadingProbeAdapter(calls);
    const controller = new AbortController();
    let clears = 0;
    adapter.clearOrganization = () => {clears++;};
    adapter.getSession = async ({signal}) => {
      signals.push(signal);
      controller.abort();
      throw Object.assign(new Error("Session unavailable"), {status: 503});
    };
    const state = await loadDirectoryCore(adapter, {signal: controller.signal, onProgress: event => progress.push(event)});
    assert.equal(state.status, "error");
    assert.deepEqual(signals, [controller.signal]);
    assert.equal(clears, 0);
    assert.deepEqual(calls, []);
    assert.deepEqual(progress, [{step: "session", state: "loading"}]);
  });

  it("loads authorized map connections while the dataset inventory is pending", async () => {
    const calls = [];
    const adapter = loadingProbeAdapter(calls);
    const authority = Promise.withResolvers();
    const inventory = Promise.withResolvers();
    adapter.getProject = () => authority.promise;
    adapter.listDatasets = () => inventory.promise;
    const loading = loadProjectContext(adapter, "project-fast", null, {surface: "maps"});
    await new Promise(setImmediate);
    assert.ok(!calls.includes("sources"));
    assert.ok(!calls.includes("project-basemap-connections"));
    authority.resolve({id: "project-fast", status: "active"});
    await new Promise(setImmediate);
    assert.ok(calls.includes("sources"));
    assert.ok(calls.includes("project-dataset-connections"));
    assert.ok(calls.includes("project-basemap-connections"));
    inventory.resolve([{id: "dataset-fast"}]);
    const state = await loading;
    assert.equal(state.status, "ready");
    assert.equal(state.datasets[0].id, "dataset-fast");
    assert.equal(state.selectedMap.id, "map-fast");
    assert.equal(new Set(calls).size, calls.length);
  });

  it("does not start map supplements after denied authority or aborted navigation", async () => {
    for (const abort of [false, true]) {
      const calls = [];
      const adapter = loadingProbeAdapter(calls);
      const authority = Promise.withResolvers();
      const controller = new AbortController();
      adapter.getProject = () => authority.promise;
      const loading = loadProjectContext(adapter, "project-fast", null, {
        surface: "maps", signal: controller.signal
      });
      await new Promise(setImmediate);
      if (abort) {
        controller.abort();
        authority.resolve({id: "project-fast", status: "active"});
      } else {
        authority.reject(Object.assign(new Error("revoked"), {status: 403}));
      }
      const state = await loading;
      assert.notEqual(state.status, "ready");
      assert.ok(!calls.includes("sources"));
      assert.ok(!calls.includes("project-basemap-connections"));
    }
  });

  it("opens and revalidates a canonical Project without loading switcher inventories", async () => {
    const calls = [];
    const adapter = loadingProbeAdapter(calls);
    adapter.getComposition = async () => {
      calls.push("composition");
      return {id: "map-fast", resourceType: "project", accessContainerId: "project-fast", version: 1};
    };
    const options = {compositionId: "map-fast", surface: "maps"};
    const full = await loadProjectContext(adapter, null, null, options);
    const originalCalls = [...calls];
    assert.equal(full.selectedMap.id, "map-fast");
    assert.deepEqual(full.maps.map(({id}) => id), ["map-fast"]);
    assert.deepEqual(full.projects.map(({id}) => id), ["project-fast"]);
    assert.ok(!originalCalls.includes("projects") && !originalCalls.includes("maps"));
    calls.length = 0;
    const checked = await loadProjectContext(adapter, null, null, {...options, revalidateOnly: true});
    assert.equal(checked.status, "ready");
    assert.notEqual(retainedProjectScope(full), null);
    assert.equal(retainedProjectScope(checked), retainedProjectScope(full));
    assert.deepEqual(calls, originalCalls);
    assert.ok(calls.includes("session") && calls.includes("organization") && calls.includes("project"));
    let token = 'mounted-editor-token', account = 'organization-fast';
    adapter.tokenProvider = () => token;
    adapter.organizationProvider = () => account;
    const identity = await retainedPublicationIdentity(adapter);
    const retainedOptions = {...options, revalidateOnly: true, retainedDirectory: full, retainedIdentity: identity};
    calls.length = 0;
    const resumed = await loadProjectContext(adapter, null, null, retainedOptions);
    assert.equal(retainedProjectScope(resumed), retainedProjectScope(full));
    assert.deepEqual(calls, originalCalls.filter(name => name !== 'session'), 'Mounted return must keep fresh account and resource reads without repeating session startup');
    const originalComposition = adapter.getComposition;
    adapter.getComposition = async () => ({...await originalComposition(), version: 2});
    const changed = await loadProjectContext(adapter, null, null, retainedOptions);
    assert.notEqual(retainedProjectScope(changed), retainedProjectScope(full), 'Changed map versions must prevent retained editor reuse');
    adapter.getComposition = originalComposition;
    calls.length = 0; token = 'another-login';
    assert.equal((await loadProjectContext(adapter, null, null, retainedOptions)).status, 'forbidden');
    assert.deepEqual(calls, []);
    token = 'mounted-editor-token'; account = 'another-account';
    assert.equal((await loadProjectContext(adapter, null, null, retainedOptions)).status, 'forbidden');
    assert.deepEqual(calls, []);
    account = 'organization-fast';
    adapter.getProject = async () => {throw Object.assign(new Error("revoked"), {status: 403});};
    assert.equal(retainedProjectScope(await loadProjectContext(adapter, null, null, retainedOptions)), null);
    const revoked = await loadProjectContext(adapter, null, null, {...options, revalidateOnly: true});
    assert.equal(retainedProjectScope(revoked), null);
    await assert.rejects(loadProjectContext(adapter, "project-fast", null, {revalidateOnly: true}), /composition identity/);
  });

  it("renders the authorized project directory before optional account catalogs", async () => {
    const calls = [];
    const adapter = loadingProbeAdapter(calls);

    const core = await loadDirectoryCore(adapter);

    assert.equal(core.status, "ready");
    assert.deepEqual(calls, ["session", "organization", "projects"]);
    assert.deepEqual(core.projects.map(({name}) => name), ["Fast project"]);
    assert.deepEqual(core.directorySupplementsLoaded, []);

    const hydrated = await loadDirectorySupplements(adapter, core, {view: "projects"});

    assert.deepEqual(calls, ["session", "organization", "projects", "clients", "teams"]);
    assert.deepEqual(hydrated.directorySupplementsLoaded.sort(), ["clients", "teams"]);
    assert.equal(hydrated.clients[0].name, "Research client");
    assert.equal(hydrated.teams[0].name, "Mapping team");
    assert.equal(calls.includes("dataset-connections"), false);
  });

  it("loads only the project records required by the active application surface", async () => {
    const calls = [];
    const adapter = loadingProbeAdapter(calls);

    const state = await loadProjectContext(adapter, "project-fast", null, {surface: "print"});

    assert.equal(state.status, "ready");
    assert.equal(state.projectSurfaceLoaded, "print");
    assert.deepEqual(calls, [
      "session",
      "organization",
      "projects",
      "project",
      "sites"
    ]);
    assert.deepEqual(state.datasets, []);
    assert.deepEqual(state.resources, []);
    assert.deepEqual(state.spatialServices, []);
    assert.equal(calls.includes("dataset-connections"), false);
  });

  it("loads the bounded account publication registry only for the publishing view", async () => {
    const calls = [];
    const adapter = loadingProbeAdapter(calls);
    const core = await loadDirectoryCore(adapter);

    const state = await loadDirectorySupplements(adapter, core, {view: "publishing"});

    assert.deepEqual(calls, ["session", "organization", "projects", "publications"]);
    assert.deepEqual(state.directorySupplementsLoaded, ["publications"]);
    assert.equal(state.publicSiteDirectory.numberMatched, 1);
    assert.equal(state.publicSiteDirectory.records[0].listedSlug, "fast-site");
  });

  it("resolves publication records for a default project URL with no maps", async () => {
    const calls = [];
    const adapter = loadingProbeAdapter(calls);
    adapter.listMaps = async () => {
      calls.push("maps");
      return [];
    };
    adapter.listObservableSourceProjects = async () => {
      calls.push("source-projects");
      return [{id: "source-project-fast", name: "Framework source"}];
    };

    const state = await loadProjectContext(adapter, "project-fast", null, {surface: "maps"});

    assert.equal(state.status, "ready");
    assert.equal(state.selectedMap, null);
    assert.deepEqual(state.sites, [{id: "site-fast", title: "Fast site"}]);
    assert.deepEqual(state.observableSourceProjects, [{
      id: "source-project-fast",
      name: "Framework source"
    }]);
    assert.equal(calls.includes("sites"), true);
    assert.equal(calls.includes("source-projects"), true);
  });

  it("keeps publication records out of the initial default load when a map exists", async () => {
    const calls = [];
    const adapter = loadingProbeAdapter(calls);

    const state = await loadProjectContext(adapter, "project-fast", null, {surface: "maps"});

    assert.equal(state.status, "ready");
    assert.equal(state.selectedMap.id, "map-fast");
    assert.equal(calls.includes("sites"), false);
    assert.equal(calls.includes("source-projects"), false);
  });
  it("keeps the same-origin NetworkLink adapter capability-gated and abortable", async () => {
    const values = new Map([
      ["opengeo.accessToken", "header.payload.signature"],
      ["opengeo.accessTokenExpiresAt", String(Date.now() + 60_000)],
      ["opengeo.organizationId", "10000000-0000-4000-8000-000000000001"]
    ]);
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key)
    };
    const calls = [];
    const fetchImplementation = async (url, options) => {
      calls.push({url, options});
      return new Response(JSON.stringify({
        request_url: "https://data.opengeo.tools/live.kml",
        final_url: "https://data.opengeo.tools/live.kml",
        status: 200,
        redirects: 0,
        dns_pinned: true,
        all_addresses_public: true,
        tls_verified: true,
        credentials_sent: false,
        media_type: "application/vnd.google-earth.kml+xml",
        byte_length: 7,
        fetched_at: "2026-08-24T12:00:01Z",
        expires_at: null,
        etag: '"v1"',
        last_modified: null,
        body_text: "<kml/>"
      }), {status: 200, headers: {"content-type": "application/json"}});
    };
    const disabled = await createPlatformAdapter({
      url: "https://studio.opengeo.tools/workspaces",
      storage,
      fetchImplementation
    });
    assert.equal(typeof disabled.refreshKmlNetworkLink, "undefined");

    const enabled = await createPlatformAdapter({
      url: "https://studio.opengeo.tools/workspaces",
      storage,
      fetchImplementation,
      capabilities: {kmlNetworkLinkFetch: true}
    });
    const controller = new AbortController();
    const receipt = await enabled.refreshKmlNetworkLink(
        "50000000-0000-4000-8000-000000000001",
        {
          schemaVersion: "1.0.0",
          linkId: "live-sites",
          reason: "manual",
          sourceHref: "https://data.opengeo.tools/live.kml",
          requestUrl: "https://data.opengeo.tools/live.kml",
          requestedAt: "2026-08-24T12:00:00Z",
          maximumBytes: 262_144,
          timeoutMilliseconds: 10_000,
          accept: ["application/vnd.google-earth.kml+xml"],
          conditional: {etag: null, lastModified: null},
          transport: {credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store"},
          securityContract: "public-https-dns-pinned-no-redirect-no-credentials-v1"
        },
        {signal: controller.signal}
    );
    const body = JSON.parse(calls[0].options.body);
    assert.equal(calls[0].url, "/api/projects/50000000-0000-4000-8000-000000000001/kml-network-links/refresh");
    assert.equal(calls[0].options.signal, controller.signal);
    assert.equal(calls[0].options.credentials, "omit");
    assert.equal(calls[0].options.redirect, "error");
    assert.equal(body.security_contract, "public-https-dns-pinned-no-redirect-no-credentials-v1");
    assert.equal(receipt.dnsPinned, true);
    assert.equal(receipt.credentialsSent, false);
    assert.equal(receipt.bodyText, "<kml/>");
    await assert.rejects(
      enabled.refreshKmlNetworkLink("../other-project", {}),
      /project id is invalid/
    );
  });

  it("requires explicit organization selection for multiple memberships", async () => {
    const adapter = {
      kind: "api",
      async getSession() {
        return {
          userId: "20000000-0000-4000-8000-000000000001",
          memberships: [
            {organizationId: "10000000-0000-4000-8000-000000000001", role: "admin"},
            {organizationId: "10000000-0000-4000-8000-000000000002", role: "member"}
          ],
          selectedOrganizationId: null
        };
      }
    };

    const state = await loadDirectory(adapter);

    assert.equal(state.status, "organization_required");
    assert.equal(state.session.memberships.length, 2);
  });

  it("offers bound invitations before a principal has organization access", async () => {
    const adapter = {
      kind: "api",
      async getSession() {
        return {
          userId: "20000000-0000-4000-8000-000000000002",
          memberships: [],
          selectedOrganizationId: null
        };
      },
      async listMyInvitations() {
        return [{
          invitationId: "70000000-0000-4000-8000-000000000001",
          organizationId: "10000000-0000-4000-8000-000000000001",
          organizationName: "Inviting organization"
        }];
      }
    };

    const state = await loadDirectory(adapter);

    assert.equal(state.status, "invitation_required");
    assert.equal(state.invitations[0].organizationName, "Inviting organization");
  });

  it("retains the signed-in identity when no membership or pending invitation exists", async () => {
    const session = {userId: "reviewer", email: "reviewer@example.com", memberships: [], selectedOrganizationId: null};
    const calls = [];
    const adapter = {
      kind: "api",
      async getSession() { calls.push("session"); return session; },
      async listMyInvitations() { calls.push("invitations"); return []; }
    };
    const state = await loadDirectoryCore(adapter);
    assert.equal(state.status, "forbidden");
    assert.equal(state.code, "organization_membership_required");
    assert.equal(state.session, session);
    assert.deepEqual(calls, ["session", "invitations"]);
    assert.equal(state.projects, undefined);
  });

  it("loads organization and projects while tolerating client-list denial", async () => {
    let selected;
    const adapter = {
      kind: "api",
      selectOrganization(value) { selected = value; },
      async getSession() {
        return {
          userId: "20000000-0000-4000-8000-000000000001",
          memberships: [{organizationId: "10000000-0000-4000-8000-000000000001", role: "guest"}],
          selectedOrganizationId: null
        };
      },
      async getCurrentOrganization() { return {id: selected, name: "Guest org"}; },
      async listProjects() { return [{id: "50000000-0000-4000-8000-000000000001"}]; },
      async listClients() { throw Object.assign(new Error("denied"), {status: 403}); }
    };

    const state = await loadDirectory(adapter);

    assert.equal(state.status, "ready");
    assert.equal(selected, "10000000-0000-4000-8000-000000000001");
    assert.equal(state.clientsRestricted, true);
    assert.deepEqual(state.clients, []);
  });

  it("keeps core projects visible when optional directory supplements fail", async () => {
    const adapter = {
      kind: "api",
      selectOrganization() {},
      async getSession() {
        return {
          userId: "20000000-0000-4000-8000-000000000001",
          memberships: [{organizationId: "10000000-0000-4000-8000-000000000001", role: "admin"}],
          selectedOrganizationId: null
        };
      },
      async getCurrentOrganization() {
        return {id: "10000000-0000-4000-8000-000000000001", name: "OpenGeo Development"};
      },
      async listProjects() {
        return [{id: "50000000-0000-4000-8000-000000000001", name: "Retained project"}];
      },
      async listClients() { throw Object.assign(new Error("missing route"), {status: 404, code: "http_404"}); },
      async listTeams() { throw Object.assign(new Error("temporarily unavailable"), {status: 503, code: "team_store_unavailable"}); },
      async listMyDatasetConnections() { throw Object.assign(new Error("denied"), {status: 403, code: "action_forbidden"}); },
      async listMyBasemapConnections() { throw Object.assign(new Error("offline"), {code: "network_unavailable"}); }
    };

    const state = await loadDirectory(adapter);

    assert.equal(state.status, "ready");
    assert.equal(state.projects[0].name, "Retained project");
    assert.deepEqual(state.clients, []);
    assert.deepEqual(state.teams, []);
    assert.deepEqual(state.userConnections, []);
    assert.deepEqual(state.userBasemapConnections, []);
    assert.deepEqual(state.directoryWarnings.map(({label, code}) => [label, code]), [
      ["clients", "http_404"],
      ["teams", "team_store_unavailable"],
      ["dataset connections", "action_forbidden"],
      ["basemap connections", "network_unavailable"]
    ]);
  });

  it("retains the authorized directory when a saved project URL is stale", async () => {
    const visible = {
      id: "50000000-0000-4000-8000-000000000001",
      name: "MassGIS demonstration",
      status: "active"
    };
    const adapter = {
      kind: "api",
      selectOrganization() {},
      async getSession() {
        return {
          userId: "20000000-0000-4000-8000-000000000001",
          memberships: [{organizationId: "10000000-0000-4000-8000-000000000001", role: "admin"}],
          selectedOrganizationId: "10000000-0000-4000-8000-000000000001"
        };
      },
      async getCurrentOrganization() {
        return {
          id: "10000000-0000-4000-8000-000000000001",
          name: "OpenGeo Development",
          callerRole: "admin"
        };
      },
      async listProjects() { return [visible]; },
      async listClients() { return []; },
      async getProject() {
        throw Object.assign(new Error("missing"), {status: 404, code: "project_not_found"});
      },
      async listMaps() { return []; },
      async listDatasets() { return []; }
    };

    const state = await loadProjectContext(
      adapter,
      "50000000-0000-4000-8000-000000000099"
    );

    assert.equal(state.status, "not_found");
    assert.equal(state.scope, "project");
    assert.equal(state.organization.callerRole, "admin");
    assert.deepEqual(state.projects, [visible]);
  });

  it("keeps the project and maps visible when a supplemental catalog fails", async () => {
    const project = {
      id: "50000000-0000-4000-8000-000000000001",
      name: "Visible private project",
      status: "active"
    };
    const map = {id: "60000000-0000-4000-8000-000000000001", status: "active"};
    const adapter = {
      kind: "api",
      selectOrganization() {},
      async getSession() {
        return {
          userId: "20000000-0000-4000-8000-000000000001",
          memberships: [{organizationId: "10000000-0000-4000-8000-000000000001", role: "admin"}],
          selectedOrganizationId: "10000000-0000-4000-8000-000000000001"
        };
      },
      async getCurrentOrganization() {
        return {id: "10000000-0000-4000-8000-000000000001", name: "OpenGeo", callerRole: "admin"};
      },
      async listProjects() { return [project]; },
      async listClients() { return []; },
      async getProject() { return project; },
      async listMaps() { return [map]; },
      async listDatasets() { return []; },
      async listResources() {
        throw Object.assign(new Error("database rejected optional filter"), {
          status: 503,
          code: "resource_store_unavailable",
          requestId: "request-resource-list"
        });
      }
    };

    const state = await loadProjectContext(adapter, project.id);

    assert.equal(state.status, "ready");
    assert.equal(state.project.name, "Visible private project");
    assert.equal(state.selectedMap.id, map.id);
    assert.deepEqual(state.resources, []);
    assert.deepEqual(state.projectWarnings, [{
      label: "documents and stories",
      code: "resource_store_unavailable",
      requestId: "request-resource-list"
    }]);
  });

  it("keeps fixture use explicit and fixture saves memory-only", async () => {
    const adapter = await createPlatformAdapter({catalog, url: "https://studio.opengeo.tools/workspaces?adapter=fixture"});
    const binding = FIXTURE_PROJECTS[0];

    const state = await loadProjectContext(adapter, binding.projectId);
    const saved = await adapter.updateMap(binding.projectId, binding.mapId, {
      expectedVersion: state.selectedMap.version,
      changes: {name: "Fixture rename"}
    });

    assert.equal(adapter.kind, "fixture");
    assert.equal(state.status, "ready");
    assert.equal(state.project.name, "Nepal Energy Access");
    assert.equal(state.datasets.length, 2);
    assert.equal(state.datasets[0].projectId, binding.projectId);
    assert.equal(state.resources.length, 1);
    assert.equal(state.resources[0].kind, "story");
    assert.equal(state.resources[0].originNamespace, "geonode");
    assert.equal(saved.version, 2);
    assert.equal((await adapter.getMap(binding.projectId, binding.mapId)).name, "Fixture rename");
  });

  it("models an exact reviewed, sealed, and revocable site lifecycle in the memory-only fixture", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const {projectId} = FIXTURE_PROJECTS[0];
    const resource = (await adapter.listResources(projectId))[0];
    const draft = {
      slug: "nepal-energy-report",
      title: "Nepal energy report",
      description: "A governed fixture publication.",
      language: "en",
      theme: "paper",
      themeOptions: {accentColor: "#176b87"},
      printLayout: {schemaVersion: "opengeo.print-layout.1.1.0", pages: []},
      pages: [{
        slug: "energy-access",
        navigationLabel: "Energy access",
        resourceId: resource.id,
        resourceVersion: resource.versionNumber,
        isHome: true
      }]
    };
    const created = await adapter.createSite(projectId, draft);
    assert.equal(created.state, "draft");
    assert.equal(created.pages[0].resourceState, "review");
    assert.equal((await adapter.listSites(projectId)).length, 1);

    const destination = await adapter.configureSitePublicationDestination(
      projectId,
      created.id,
      {
        expectedRevision: created.publicationDestination.revision,
        reach: "listed",
        listedSlug: "nepal-energy",
        isPrimary: true
      }
    );
    assert.equal(destination.publicationDestination.revision, 2);
    assert.equal(destination.publicationDestination.isPrimary, true);
    await assert.rejects(
      adapter.configureSitePublicationDestination(projectId, created.id, {
        expectedRevision: 1,
        reach: "listed",
        listedSlug: "stale-nepal-energy",
        isPrimary: false
      }),
      (error) => error.code === "site_publication_destination_conflict"
        && error.currentVersion === 2
    );

    const review = await adapter.submitSiteForReview(projectId, created.id, {
      expectedVersion: created.versionNumber,
      reason: "Ready for a separate publication decision"
    });
    assert.equal(review.state, "review");
    await assert.rejects(
      adapter.publishSite(projectId, created.id, {
        expectedVersion: review.versionNumber,
        reason: "Not public yet"
      }),
      (error) => error.code === "site_page_not_public"
    );

    await adapter.transitionResource(projectId, resource.id, {
      expectedVersion: resource.versionNumber,
      targetState: "published",
      visibility: "public",
      reason: "Approve the governed page"
    });
    const published = await adapter.publishSite(projectId, created.id, {
      expectedVersion: review.versionNumber,
      reason: "Approve the exact reviewed revision"
    });
    assert.equal(published.state, "published");
    assert.equal(published.activeEdition.editionNumber, 1);
    assert.equal(published.activeEdition.publicationReach, "listed");
    assert.equal(published.activeEdition.listedSlug, "nepal-energy");
    assert.match(published.activeEdition.manifestChecksumSha256, /^[0-9a-f]{64}$/);
    assert.equal(published.activeEdition.manifest.pages[0].resourceVersionNumber, 1);

    const editions = await adapter.listSiteEditions(projectId, created.id);
    assert.equal(editions.length, 1);
    const revoked = await adapter.revokeSiteEdition(
      projectId,
      created.id,
      published.activeEdition.id
    );
    assert.equal(revoked.revokedBy, (await adapter.getSession()).userId);
    assert.ok(revoked.revokedAt);
    assert.equal((await adapter.getSite(projectId, created.id)).activeEdition, null);
    await assert.rejects(
      adapter.revokeSiteEdition(projectId, created.id, published.activeEdition.id),
      (error) => error.code === "site_edition_already_revoked"
    );
  });

  it("models reusable user connections and explicit team project grants without retaining secrets", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const directory = await loadDirectory(adapter);
    const connection = directory.userConnections[0];
    const team = directory.teams[0];
    const project = await adapter.createProject({name: "Shared research atlas"});
    const grant = await adapter.createProjectTeamGrant(project.id, team.id, "editor");
    const binding = await adapter.createProjectDatasetConnectionBinding(
      project.id,
      connection.id,
      "Geospatial data reuse"
    );
    const rotated = await adapter.replaceMyDatasetConnectionCredentials(
      connection.id,
      connection.credentialRevision,
      {externalId: "fixture-secret-must-not-persist"}
    );

    assert.equal(connection.bucketName, "example-geodata");
    assert.equal(grant.role, "editor");
    assert.equal(binding.connection.id, connection.id);
    assert.deepEqual(rotated.configuredSecretFields, ["external_id"]);
    assert.equal(rotated.credentialRevision, 1);
    assert.doesNotMatch(JSON.stringify(adapter), /fixture-secret-must-not-persist/);
  });

  it("models attributed project discussions without erasing comment history", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const projectId = FIXTURE_PROJECTS[0].projectId;
    const participants = await adapter.listProjectDiscussionParticipants(projectId);
    const map = (await adapter.listMaps(projectId))[0];
    const created = await adapter.createProjectDiscussion(projectId, {
      discussionId: "94000000-0000-4000-8000-000000000099",
      initialCommentId: "95000000-0000-4000-8000-000000000099",
      title: "Confirm review status",
      body: "Is this source ready to publish?",
      target: {kind: "map", objectId: map.id, version: map.version},
      assignedTo: participants[1].userId,
      mentionedUserIds: [participants[1].userId]
    });
    await adapter.createProjectDiscussionComment(projectId, created.discussion.id, {
      commentId: "96000000-0000-4000-8000-000000000099",
      body: "The provenance record is complete."
    });
    const subscribed = await adapter.setProjectDiscussionSubscription(
      projectId,
      created.discussion.id,
      {subscribed: true, expectedVersion: null}
    );
    const moderated = await adapter.moderateProjectDiscussionComment(
      projectId,
      created.discussion.id,
      created.discussion.initialCommentId,
      {
        moderationId: "98000000-0000-4000-8000-000000000099",
        reason: "Contains a private review detail"
      }
    );
    const resolved = await adapter.transitionProjectDiscussion(
      projectId,
      created.discussion.id,
      {state: "resolved", expectedVersion: 1}
    );
    const comments = await adapter.listProjectDiscussionComments(
      projectId,
      created.discussion.id
    );
    const notifications = await adapter.listProjectDiscussionNotifications(
      projectId,
      {unreadOnly: true}
    );
    const acknowledged = await adapter.markProjectDiscussionNotificationRead(
      projectId,
      notifications[0].id,
      {expectedVersion: notifications[0].versionNumber}
    );
    const resource = (await adapter.listResources(projectId))[0];
    const rated = await adapter.setResourceRating(
      projectId,
      resource.id,
      {score: 4, expectedVersion: null}
    );
    const withdrawn = await adapter.setResourceRating(
      projectId,
      resource.id,
      {score: null, expectedVersion: rated.summary.callerVersion}
    );

    assert.equal(created.created, true);
    assert.deepEqual(created.discussion.target, {
      kind: "map", objectId: map.id, version: map.version
    });
    assert.equal(created.discussion.assignedTo, participants[1].userId);
    assert.equal(resolved.discussion.state, "resolved");
    assert.equal(resolved.discussion.versionNumber, 2);
    assert.equal(subscribed.subscription.subscribed, true);
    assert.equal(subscribed.subscription.versionNumber, 1);
    assert.equal(comments.length, 2);
    assert.equal(comments[0].mentions[0].userId, participants[1].userId);
    assert.equal(comments[0].body, "[Comment redacted]");
    assert.equal(moderated.comment.moderation.reason, "Contains a private review detail");
    assert.equal(
      adapter.projectDiscussionOriginalBodies.get(created.discussion.initialCommentId),
      "Is this source ready to publish?"
    );
    assert.match(comments[1].body, /provenance/);
    assert.equal(acknowledged.changed, true);
    assert.ok(acknowledged.notification.readAt);
    assert.equal(rated.summary.ratingAverage, 4);
    assert.equal(withdrawn.summary.ratingCount, 0);
    assert.equal(withdrawn.summary.callerWithdrawn, true);
    await assert.rejects(
      adapter.createProjectDiscussionComment(projectId, created.discussion.id, {
        commentId: "97000000-0000-4000-8000-000000000099",
        body: "This must reopen first."
      }),
      (error) => error.code === "discussion_resolved"
    );
  });

  it("models a client-visible Protomaps key through account, project, and style resolution", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const project = await adapter.createProject({name: "Connected basemap atlas"});
    const connection = await adapter.createMyBasemapConnection({
      displayName: "Protomaps hosted API",
      allowedOrigins: ["http://localhost:3000"]
    });
    const configured = await adapter.replaceMyBasemapConnectionBrowserKey(
      connection.id,
      0,
      "fixture-client-visible-browser-key"
    );
    const binding = await adapter.createProjectBasemapConnectionBinding(
      project.id,
      configured.id,
      "Project basemap"
    );
    const style = await adapter.resolveProjectBasemapStyle(
      project.id,
      binding.id,
      "grayscale"
    );
    const context = await loadProjectContext(adapter, project.id);

    assert.equal(configured.status, "configured");
    assert.equal(configured.browserKeyExposure, "client_visible");
    assert.equal(context.basemapConnectionBindings.length, 1);
    assert.equal(style.flavor, "grayscale");
    assert.equal(style.resourceKind, "maplibre-style");
    assert.match(style.resourceUrl, /key=fixture-client-visible-browser-key$/);
    assert.equal(Object.hasOwn(configured, "apiKey"), false);

    const disabled = await adapter.updateMyBasemapConnection(configured.id, {enabled: false});
    const renamed = await adapter.updateMyBasemapConnection(disabled.id, {
      displayName: "Renamed while disabled"
    });
    assert.equal(renamed.status, "disabled");
  });

  it("reuses one dataset in two projects while keeping map presentation independent", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const sourceProject = FIXTURE_PROJECTS[0];
    const dataset = (await adapter.listDatasets(sourceProject.projectId))[0];
    const sourceMap = await adapter.getMap(sourceProject.projectId, sourceProject.mapId);
    const sourceDefinition = emptyMapDefinition({
      layers: [fixtureMapLayer(dataset, "source-roads", "#b91c1c")],
      activeLayerId: "source-roads"
    });
    await adapter.updateMap(sourceProject.projectId, sourceMap.id, {
      expectedVersion: sourceMap.version,
      changes: {definition: sourceDefinition}
    });

    const targetProject = await adapter.createProject({name: "Alternate roads presentation"});
    const attached = await adapter.attachDataset(targetProject.id, dataset.id);
    const targetMap = await adapter.createMap(targetProject.id, {
      name: "Blue roads",
      definition: emptyMapDefinition({
        layers: [fixtureMapLayer(dataset, "target-roads", "#1d4ed8")],
        activeLayerId: "target-roads"
      })
    });

    const reloadedSource = await adapter.getMap(sourceProject.projectId, sourceMap.id);
    const reloadedTarget = await adapter.getMap(targetProject.id, targetMap.id);
    assert.equal(attached.id, dataset.id);
    assert.equal(reloadedSource.definition.layers[0].datasetId, dataset.id);
    assert.equal(reloadedTarget.definition.layers[0].datasetId, dataset.id);
    assert.equal(reloadedSource.definition.layers[0].style.stroke, "#b91c1c");
    assert.equal(reloadedTarget.definition.layers[0].style.stroke, "#1d4ed8");

    await assert.rejects(
      adapter.detachDataset(targetProject.id, dataset.id),
      (error) => error.code === "project_dataset_in_use"
    );
    await adapter.updateMap(targetProject.id, targetMap.id, {
      expectedVersion: reloadedTarget.version,
      changes: {definition: emptyMapDefinition()}
    });
    await adapter.detachDataset(targetProject.id, dataset.id);
    assert.equal((await adapter.listDatasets(targetProject.id)).length, 0);
    assert.ok((await adapter.listDatasets(sourceProject.projectId)).some(({id}) => id === dataset.id));
  });

  it("creates one canonical governed identity for a project dataset", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const binding = FIXTURE_PROJECTS[0];
    const dataset = (await adapter.listDatasets(binding.projectId))[0];
    const draft = {
      kind: "dataset",
      slug: "canonical-research-dataset",
      datasetId: dataset.id,
      visibility: "restricted",
      metadata: {
        title: dataset.name,
        abstract: dataset.description,
        language: "en",
        license: "CC-BY-4.0",
        attribution: "OpenGeo.Tools fixture research team",
        keywords: dataset.tags,
        spatialExtent: dataset.extent,
        profile: "opengeo.core.v1",
        extensions: {},
        translations: {}
      },
      content: {blocks: []},
      provenance: {source: "project_dataset", datasetId: dataset.id}
    };

    const created = await adapter.createResource(binding.projectId, draft);

    assert.equal(created.datasetId, dataset.id);
    assert.equal(created.state, "draft");
    assert.equal(created.license, "CC-BY-4.0");
    assert.deepEqual(created.provenance, {source: "project_dataset", datasetId: dataset.id});
    await assert.rejects(
      adapter.createResource(binding.projectId, {...draft, slug: "competing-dataset"}),
      (error) => error.code === "resource_conflict"
    );
  });

  it("creates one canonical governed identity for a durable project map", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const binding = FIXTURE_PROJECTS[0];
    const map = await adapter.createMap(binding.projectId, {
      name: "Canonical research map",
      definition: emptyMapDefinition()
    });
    const draft = {
      kind: "map",
      slug: "canonical-research-map",
      mapId: map.id,
      visibility: "restricted",
      metadata: {
        title: map.name,
        abstract: "A publication-ready map identity",
        language: "en",
        license: "CC-BY-4.0",
        attribution: "OpenGeo.Tools fixture research team",
        keywords: ["map"],
        spatialExtent: null,
        profile: "opengeo.core.v1",
        extensions: {},
        translations: {}
      },
      content: {blocks: []},
      provenance: {source: "studio_native_resource", mapId: map.id}
    };

    const created = await adapter.createResource(binding.projectId, draft);

    assert.equal(created.kind, "map");
    assert.equal(created.mapId, map.id);
    assert.deepEqual(created.provenance, draft.provenance);
    await assert.rejects(
      adapter.createResource(binding.projectId, {...draft, slug: "competing-map"}),
      (error) => error.code === "resource_conflict"
    );
  });

  it("keeps exact fixture page source versions, history, and bounded text diffs", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const binding = FIXTURE_PROJECTS[0];
    const resource = (await adapter.listResources(binding.projectId))[0];
    const sourceMarkdown = "# Nepal energy access\n\nVerified source.";
    const content = structuredClone(resource.content);
    content.blocks[0].markdown = sourceMarkdown;
    const working = await adapter.savePageWorkingDraft(
      binding.projectId,
      resource.id,
      {
        expectedVersion: resource.versionNumber,
        expectedDraftRevision: 0,
        visibility: "organization",
        metadata: {
          title: resource.title,
          abstract: resource.abstract,
          language: resource.language,
          license: resource.license,
          attribution: resource.attribution,
          keywords: resource.keywords,
          spatialExtent: resource.spatialExtent,
          temporalStart: resource.temporalStart,
          temporalEnd: resource.temporalEnd,
          profile: resource.metadataProfile,
          extensions: resource.metadataExtensions,
          translations: resource.translations
        },
        content,
        provenance: resource.provenance,
        changeMessage: "Recover exact source"
      },
      {sourceBlockId: "introduction", sourceMarkdown: "# Unapplied private edit"}
    );
    const idempotent = await adapter.savePageWorkingDraft(
      binding.projectId,
      resource.id,
      {
        expectedVersion: resource.versionNumber,
        expectedDraftRevision: working.revisionNumber,
        visibility: working.visibility,
        metadata: working.metadata,
        content: working.content,
        provenance: working.provenance,
        changeMessage: working.changeSummary
      },
      {sourceBlockId: working.sourceBlockId, sourceMarkdown: working.sourceMarkdown}
    );
    assert.equal(working.revisionNumber, 1);
    assert.equal(idempotent.revisionNumber, 1);
    assert.equal((await adapter.getPageWorkingDraft(binding.projectId, resource.id)).sourceMarkdown, "# Unapplied private edit");
    const committed = await adapter.savePageVersion(
      binding.projectId,
      resource.id,
      {
        expectedVersion: resource.versionNumber,
        visibility: "organization",
        metadata: {
          title: resource.title,
          abstract: resource.abstract,
          language: resource.language,
          license: resource.license,
          attribution: resource.attribution,
          keywords: resource.keywords,
          spatialExtent: resource.spatialExtent,
          temporalStart: resource.temporalStart,
          temporalEnd: resource.temporalEnd,
          profile: resource.metadataProfile,
          extensions: resource.metadataExtensions,
          translations: resource.translations
        },
        content,
        provenance: resource.provenance,
        changeMessage: "Verify exact source"
      },
      {sourceBlockId: "introduction", sourceMarkdown}
    );
    const history = await adapter.listPageVersions(binding.projectId, resource.id);
    const exact = await adapter.getPageSource(binding.projectId, resource.id, 2);

    assert.equal(committed.resource.versionNumber, 2);
    assert.match(committed.source.checksumSha256, /^[0-9a-f]{64}$/);
    assert.equal(history[0].sourceMarkdown, null);
    assert.equal(exact.sourceMarkdown, sourceMarkdown);
    assert.equal(exact.compilerVersion, "opengeo-page-renderer-1.1.0");
    assert.equal(await adapter.getPageWorkingDraft(binding.projectId, resource.id), null);
    assert.equal(
      boundedLineDiff("# Old\n\nSame", "# New\n\nSame"),
      "- # Old\n+ # New\n  \n  Same"
    );
  });

  it("models explicit project creation, first-map creation, Save As, and activity recents", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const project = await adapter.createProject({
      name: "Field atlas",
      description: "New governed work",
      projectCode: "FIELD-ATLAS"
    });
    const first = await adapter.createMap(project.id, {
      name: "Field atlas map",
      definition: {layers: [], bookmarks: []}
    });
    const savedAs = await adapter.createMap(project.id, {
      name: "Field atlas publication",
      definition: {layers: [{layerId: "roads"}], bookmarks: []}
    });
    const maps = await adapter.listMaps(project.id);
    const recents = await adapter.listRecentProjects({limit: 10});

    assert.equal(project.callerRole, "owner");
    assert.notEqual(first.id, savedAs.id);
    assert.equal(maps.length, 2);
    assert.deepEqual((await adapter.getMap(project.id, first.id)).definition.layers, []);
    assert.deepEqual((await adapter.getMap(project.id, savedAs.id)).definition.layers, [{layerId: "roads"}]);
    assert.ok(recents.some((record) => record.id === project.id));
    assert.ok(recents.every((record) => record.lastEventType === "fixture.project.opened"));
  });

  it("simulates stable feature ids, optimistic edits, and immutable history", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const binding = FIXTURE_PROJECTS[0];
    const dataset = (await adapter.listDatasets(binding.projectId)).find(
      (candidate) => candidate.geometryType === "Point"
    );
    const initialized = await adapter.createFeatureCollection(
      binding.projectId,
      dataset.id,
      {
        geometryType: "Point",
        fields: [{name: "name", type: "string", required: true}],
        features: []
      }
    );
    const created = await adapter.createFeature(binding.projectId, dataset.id, {
      geometry: {type: "Point", coordinates: [85.32, 27.71]},
      properties: {name: "Survey station"}
    }, "Field capture");
    const updated = await adapter.updateFeature(
      binding.projectId,
      dataset.id,
      created.id,
      {
        expectedVersion: 1,
        geometry: {type: "Point", coordinates: [85.33, 27.72]},
        properties: {name: "Survey station corrected"},
        changeMessage: "GNSS correction"
      }
    );

    assert.equal(initialized.collection.generation, 1);
    assert.equal(created.version, 1);
    assert.equal(updated.version, 2);
    await assert.rejects(
      adapter.updateFeature(binding.projectId, dataset.id, created.id, {
        expectedVersion: 1,
        geometry: created.geometry,
        properties: created.properties
      }),
      (error) => error.code === "feature_version_conflict" && error.currentVersion === 2
    );
    const history = await adapter.listFeatureHistory(
      binding.projectId,
      dataset.id,
      created.id
    );
    assert.deepEqual(history.revisions.map((revision) => revision.operation), [
      "update",
      "create"
    ]);
  });

  it("keeps deleted features discoverable and restores one historical snapshot", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const binding = FIXTURE_PROJECTS[0];
    const dataset = (await adapter.listDatasets(binding.projectId)).find(
      (candidate) => candidate.geometryType === "Point"
    );
    const featureId = "90000000-0000-4000-8000-000000000278";
    await adapter.createFeatureCollection(binding.projectId, dataset.id, {
      geometryType: "Point",
      fields: [{name: "name", type: "string", required: true}],
      features: [{
        id: featureId,
        geometry: {type: "Point", coordinates: [85.32, 27.71]},
        properties: {name: "Original survey station"}
      }]
    });
    await adapter.updateFeature(binding.projectId, dataset.id, featureId, {
      expectedVersion: 1,
      geometry: {type: "Point", coordinates: [85.33, 27.72]},
      properties: {name: "Incorrect replacement"}
    });
    const deleted = await adapter.deleteFeature(
      binding.projectId, dataset.id, featureId, 2, "Remove duplicate"
    );

    const listed = await adapter.listFeatureTombstones(
      binding.projectId, dataset.id, {limit: 20, offset: 0}
    );
    const restored = await adapter.restoreFeature(
      binding.projectId,
      dataset.id,
      featureId,
      {
        expectedVersion: deleted.deletedVersion,
        revisionVersion: 1,
        changeMessage: "Recover original capture"
      }
    );

    assert.equal(listed.numberMatched, 1);
    assert.deepEqual(listed.tombstones.map(({featureId, deletedVersion}) => ({
      featureId,
      deletedVersion
    })), [{featureId, deletedVersion: 3}]);
    assert.equal(restored.id, featureId);
    assert.equal(restored.version, 4);
    assert.deepEqual(restored.geometry.coordinates, [85.32, 27.71]);
    assert.deepEqual(restored.properties, {name: "Original survey station"});
    assert.equal(
      (await adapter.listFeatureTombstones(binding.projectId, dataset.id)).numberMatched,
      0
    );
    assert.equal(
      (await adapter.listFeatures(binding.projectId, dataset.id)).collection.featureCount,
      1
    );
    assert.deepEqual(
      (await adapter.listFeatureHistory(binding.projectId, dataset.id, featureId))
        .revisions.map(({operation}) => operation),
      ["restore", "delete", "update", "create"]
    );
  });

  it("uses optional expiring feature reservations without replacing optimistic versions", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const binding = FIXTURE_PROJECTS[0];
    const dataset = (await adapter.listDatasets(binding.projectId)).find(
      (candidate) => candidate.geometryType === "Point"
    );
    const featureId = "90000000-0000-4000-8000-000000000176";
    const lockToken = "a0000000-0000-4000-8000-000000000176";
    await adapter.createFeatureCollection(binding.projectId, dataset.id, {
      geometryType: "Point",
      fields: [{name: "name", type: "string", required: true}],
      features: [{
        id: featureId,
        geometry: {type: "Point", coordinates: [85.32, 27.71]},
        properties: {name: "Survey station"}
      }]
    });

    const acquired = await adapter.acquireFeatureLock(
      binding.projectId,
      dataset.id,
      featureId,
      {expectedVersion: 1, lockToken, leaseSeconds: 120}
    );
    assert.equal(acquired.heldByCurrentUser, true);
    assert.equal((await adapter.listFeatureLocks(binding.projectId, dataset.id)).length, 1);
    await assert.rejects(
      adapter.updateFeature(binding.projectId, dataset.id, featureId, {
        expectedVersion: 1,
        geometry: {type: "Point", coordinates: [85.33, 27.72]},
        properties: {name: "Unsafe replacement"}
      }),
      (error) => error.code === "feature_locked" && error.currentVersion === 1
    );
    await assert.rejects(
      adapter.acquireFeatureLock(binding.projectId, dataset.id, featureId, {
        expectedVersion: 1,
        lockToken: "a0000000-0000-4000-8000-000000000177"
      }),
      (error) => error.code === "feature_locked"
    );

    const changed = await adapter.updateFeature(
      binding.projectId,
      dataset.id,
      featureId,
      {
        expectedVersion: 1,
        lockToken,
        geometry: {type: "Point", coordinates: [85.33, 27.72]},
        properties: {name: "Reserved replacement"}
      }
    );
    assert.equal(changed.version, 2);
    assert.equal(
      (await adapter.listFeatureLocks(binding.projectId, dataset.id))[0].featureVersion,
      2
    );
    assert.deepEqual(
      await adapter.releaseFeatureLock(binding.projectId, dataset.id, featureId, lockToken),
      {featureId, released: true}
    );
    assert.deepEqual(
      await adapter.releaseFeatureLock(binding.projectId, dataset.id, featureId, lockToken),
      {featureId, released: false}
    );

    const afterRelease = await adapter.updateFeature(
      binding.projectId,
      dataset.id,
      featureId,
      {
        expectedVersion: 2,
        geometry: {type: "Point", coordinates: [85.34, 27.73]},
        properties: {name: "Optimistic replacement"}
      }
    );
    assert.equal(afterRelease.version, 3);
  });

  it("separates and merges MultiPolygon features with one generation per transaction", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const projectId = FIXTURE_PROJECTS[0].projectId;
    const upload = await adapter.requestUpload(projectId, {
      name: "Multipart survey areas",
      description: "Topology structure fixture",
      classification: "internal",
      format: "geojson",
      tags: ["survey"]
    });
    const featureId = "90000000-0000-4000-8000-000000000231";
    await adapter.createFeatureCollection(projectId, upload.dataset.id, {
      geometryType: "MultiPolygon",
      fields: [{name: "name", type: "string", required: true}],
      features: [{
        id: featureId,
        geometry: {
          type: "MultiPolygon",
          coordinates: [
            [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
            [[[2, 0], [3, 0], [3, 1], [2, 1], [2, 0]]]
          ]
        },
        properties: {name: "Survey area"}
      }]
    });

    const separated = await adapter.separateMultipolygonParts(
      projectId,
      upload.dataset.id,
      {
        featureId,
        expectedVersion: 1,
        retainedPartIndex: 1,
        changeMessage: "Separate survey areas"
      }
    );
    const created = separated.createdFeatures[0];

    assert.equal(separated.collectionGeneration, 2);
    assert.equal(separated.featureCount, 2);
    assert.equal(separated.retainedFeature.id, featureId);
    assert.equal(separated.retainedFeature.version, 2);
    assert.deepEqual(separated.retainedFeature.geometry.coordinates[0][0][0], [2, 0]);
    assert.equal(created.version, 1);
    assert.deepEqual(created.properties, {name: "Survey area"});
    const beforeDissolve = await adapter.listFeatures(projectId, upload.dataset.id, {limit: 100});
    const retainedHistory = await adapter.listFeatureHistory(projectId, upload.dataset.id, featureId);
    const donorHistory = await adapter.listFeatureHistory(projectId, upload.dataset.id, created.id);
    const lockToken = "a0000000-0000-4000-8000-000000000231";
    await adapter.acquireFeatureLock(projectId, upload.dataset.id, featureId, {
      expectedVersion: 2, lockToken, leaseSeconds: 120
    });
    const dissolveRequest = {
      retainedFeatureId: featureId,
      geometryOperation: "dissolve",
      features: [
        {featureId, expectedVersion: 2, lockToken},
        {featureId: created.id, expectedVersion: 1}
      ]
    };
    await assert.rejects(
      adapter.mergeMultipolygonFeatures(projectId, upload.dataset.id, {
        ...dissolveRequest,
        features: [{featureId, expectedVersion: 1, lockToken}, dissolveRequest.features[1]]
      }),
      (error) => error.code === "feature_version_conflict" && error.currentVersion === 2
    );
    await assert.rejects(
      adapter.mergeMultipolygonFeatures(projectId, upload.dataset.id, {
        ...dissolveRequest,
        features: [{featureId, expectedVersion: 2}, dissolveRequest.features[1]]
      }),
      (error) => error.code === "feature_locked"
    );
    await assert.rejects(
      adapter.mergeMultipolygonFeatures(projectId, upload.dataset.id, dissolveRequest),
      (error) => error.code === "geometry_operation_unsupported"
        && /unavailable in this fixture workspace/.test(error.message)
    );
    await assert.rejects(
      adapter.mergeMultipolygonFeatures(projectId, upload.dataset.id, {
        ...dissolveRequest, geometryOperation: "union"
      }),
      /geometryOperation must be collect or dissolve/
    );
    assert.deepEqual(await adapter.listFeatures(projectId, upload.dataset.id, {limit: 100}), beforeDissolve);
    assert.deepEqual(await adapter.listFeatureHistory(projectId, upload.dataset.id, featureId), retainedHistory);
    assert.deepEqual(await adapter.listFeatureHistory(projectId, upload.dataset.id, created.id), donorHistory);
    assert.equal((await adapter.listFeatureTombstones(projectId, upload.dataset.id)).numberMatched, 0);
    await adapter.releaseFeatureLock(projectId, upload.dataset.id, featureId, lockToken);
    await assert.rejects(
      adapter.mergeMultipolygonFeatures(projectId, upload.dataset.id, {
        retainedFeatureId: featureId,
        features: [
          {featureId, expectedVersion: 1},
          {featureId: created.id, expectedVersion: 1}
        ]
      }),
      (error) => error.code === "feature_version_conflict" && error.currentVersion === 2
    );

    const merged = await adapter.mergeMultipolygonFeatures(projectId, upload.dataset.id, {
      retainedFeatureId: featureId,
      features: [
        {featureId, expectedVersion: 2},
        {featureId: created.id, expectedVersion: 1}
      ],
      changeMessage: "Merge survey areas"
    });

    assert.equal(merged.collectionGeneration, 3);
    assert.equal(merged.featureCount, 1);
    assert.equal(merged.retainedFeature.version, 3);
    assert.equal(merged.retainedFeature.geometry.coordinates.length, 2);
    assert.deepEqual(merged.deletedFeatures, [{
      featureId: created.id,
      deletedVersion: 2,
      collectionGeneration: 3
    }]);
    assert.equal(
      (await adapter.listFeatures(projectId, upload.dataset.id, {limit: 100})).numberMatched,
      1
    );
    assert.deepEqual(
      (await adapter.listFeatureHistory(projectId, upload.dataset.id, created.id))
        .revisions.map(({operation}) => operation),
      ["delete", "create"]
    );
  });

  it("promotes an exact-base field update without replacing its feature identity", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const binding = FIXTURE_PROJECTS[0];
    const dataset = (await adapter.listDatasets(binding.projectId)).find(
      (candidate) => candidate.geometryType === "Point"
    );
    const featureId = "90000000-0000-4000-8000-000000000174";
    await adapter.createFeatureCollection(binding.projectId, dataset.id, {
      geometryType: "Point",
      fields: [{name: "name", type: "string", required: true}],
      features: [{
        id: featureId,
        geometry: {type: "Point", coordinates: [85.32, 27.71]},
        properties: {name: "Survey station"}
      }]
    });
    const form = await adapter.createFieldForm(binding.projectId, dataset.id, {
      title: "Station inspection"
    });
    const submissionId = "b0000000-0000-4000-8000-000000000174";
    await adapter.createFieldSubmission(
      binding.projectId,
      dataset.id,
      form.id,
      form.version,
      {
        submissionId,
        operation: "update",
        targetFeatureId: featureId,
        targetFeatureVersion: 1,
        feature: {
          type: "Feature",
          id: featureId,
          geometry: {type: "Point", coordinates: [85.33, 27.72]},
          properties: {name: "Survey station inspected"}
        }
      }
    );
    await adapter.reviewFieldSubmission(
      binding.projectId,
      dataset.id,
      submissionId,
      {expectedVersion: 1, decision: "start_review"}
    );
    const accepted = await adapter.reviewFieldSubmission(
      binding.projectId,
      dataset.id,
      submissionId,
      {expectedVersion: 2, decision: "accept", message: "Verified"}
    );

    assert.equal(accepted.submission.promotedFeatureId, featureId);
    assert.equal(accepted.promotedFeature.id, featureId);
    assert.equal(accepted.promotedFeature.version, 2);
    assert.equal((await adapter.listFeatures(binding.projectId, dataset.id)).numberMatched, 1);
  });

  it("exposes a deterministic governed query dataset through the ordinary project catalog", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const projectId = FIXTURE_PROJECTS[0].projectId;
    const dataset = (await adapter.listDatasets(projectId)).find(
      (candidate) => candidate.geometryType === "LineString"
    );

    await adapter.createFeatureCollection(projectId, dataset.id, {
      geometryType: "LineString",
      fields: [
        {name: "name", type: "string", required: true},
        {name: "priority", type: "integer", required: true}
      ],
      features: [
        {
          id: "90000000-0000-4000-8000-000000000201",
          geometry: {type: "LineString", coordinates: [[85.28, 27.66], [85.34, 27.7]]},
          properties: {name: "River service road", priority: 2}
        },
        {
          id: "90000000-0000-4000-8000-000000000202",
          geometry: {type: "LineString", coordinates: [[85.34, 27.7], [85.4, 27.73]]},
          properties: {name: "East construction road", priority: 3}
        },
        {
          id: "90000000-0000-4000-8000-000000000203",
          geometry: {type: "LineString", coordinates: [[85.24, 27.61], [85.29, 27.66]]},
          properties: {name: "North access road", priority: 1}
        }
      ]
    });

    const page = await adapter.listFeatures(projectId, dataset.id, {limit: 100});
    const result = await adapter.queryFeatures(projectId, dataset.id, {
      expectedGeneration: page.collection.generation,
      steps: [
        {kind: "attribute", field: "name", operator: "contains", value: "road"},
        {kind: "attribute", field: "priority", operator: "greater_than_or_equal", value: 2},
        {
          kind: "spatial",
          relation: "intersects",
          geometry: {
            type: "Polygon",
            coordinates: [[[85.25, 27.63], [85.41, 27.63], [85.41, 27.75], [85.25, 27.63]]]
          },
          bufferMeters: 0
        }
      ]
    });

    assert.equal(page.numberReturned, 3);
    assert.equal(result.generation, 1);
    assert.deepEqual(result.features.map((feature) => feature.properties.name), [
      "River service road",
      "East construction road"
    ]);
    assert.match(result.querySha256, /^[0-9a-f]{64}$/);
    await assert.rejects(
      adapter.queryFeatures(projectId, dataset.id, {
        expectedGeneration: 2,
        steps: [{kind: "attribute", field: "name", operator: "contains", value: "road"}]
      }),
      (error) => error.code === "feature_collection_generation_conflict"
    );
  });

  it("hashes canonical standards JSON and simulates immutable metadata source imports", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const projectId = FIXTURE_PROJECTS[0].projectId;
    const document = JSON.parse(await readFile(
      new URL("../../parity/fixtures/data/metadata-001-stac11.json", import.meta.url),
      "utf8"
    ));
    const sourceSha256 = await metadataSourceSha256(document);
    assert.equal(
      await metadataSourceSha256("<x />\n"),
      "d06f1fca878fac98ee38a37c577f611753634aa24684a8117f332c6d41b6b581"
    );
    assert.equal(
      metadataCanonicalJson({"\u{10000}": 84, "\ue000": 1e21, small: [1e-7, -0]}),
      '{"small":[0.0000001,0],"\ue000":1000000000000000000000,"\u{10000}":84}'
    );
    const draft = {
      sourceNamespace: "example.catalog",
      slug: "road-access-import",
      visibility: "restricted",
      document,
      sourceSha256,
      managedProfileId: null,
      managedProfileVersion: null
    };

    const imported = await adapter.importResourceMetadata(projectId, "stac_1_1", draft);
    const replayed = await adapter.importResourceMetadata(projectId, "stac_1_1", draft);
    const source = await adapter.getResourceMetadataSource(projectId, imported.resource.id);

    assert.equal(sourceSha256, "b2ddedd2dfc8e6e1304d071de44c5addb147e6212faf07dbe64f4fd7e0fd73c3");
    assert.equal(imported.idempotent, false);
    assert.equal(replayed.idempotent, true);
    assert.deepEqual(source.document, document);
    assert.equal(source.canonicalJsonSha256, sourceSha256);
    assert.equal((await adapter.listResources(projectId)).at(-1).state, "review");
  });

  it("simulates language-negotiated OGC records and validates translation drafts", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const projectId = FIXTURE_PROJECTS[0].projectId;

    const collection = await adapter.listProjectRecords(projectId, {
      language: "ne",
      query: "ऊर्जा",
      limit: 20
    });
    const exported = await adapter.exportResourceMetadata(
      projectId,
      collection.features[0].id,
      "ogc_records_1_0",
      {language: "ne"}
    );
    const translations = parseTranslationDraft(
      '{"FR":{"title":"Réseau routier","keywords":["routes"]}}',
      "en"
    );

    assert.equal(collection.numberMatched, 1);
    assert.deepEqual(collection.features[0].properties.language, {code: "ne"});
    assert.equal(exported.document.properties.title, "नेपाल ऊर्जा पहुँच कथा");
    assert.equal(exported.report.conformanceClaimed, false);
    assert.equal(translations.fr.title, "Réseau routier");
    assert.throws(
      () => parseTranslationDraft('{"en":{"title":"Duplicate"}}', "en"),
      /must not be duplicated/
    );
  });

  it("validates editable native catalog metadata before sending it", () => {
    const extensions = parseMetadataExtensionsDraft(JSON.stringify({
      opengeo: {
        schemaVersion: "1.0.0",
        contacts: [{name: "Researcher", role: "creator"}],
        distributions: [{downloadUrl: "https://data.example.test/roads.geojson"}],
        referenceSystems: [{identifier: "EPSG:4326"}],
        lineage: {statement: "Survey observations were quality controlled."},
        quality: [{measure: "completeness", result: 0.98}],
        updateFrequency: "annual",
        sensitivity: "public"
      }
    }));

    assert.equal(extensions.opengeo.quality[0].result, 0.98);
    const extended = parseMetadataExtensionsDraft(JSON.stringify({
      opengeo: {
        schemaVersion: "1.1.0",
        funding: [{funderName: "Research Foundation"}],
        acquisition: {
          instruments: [{identifier: "gps-1", type: "GNSS receiver"}]
        }
      }
    }));
    assert.equal(extended.opengeo.acquisition.instruments[0].identifier, "gps-1");
    const planned = parseMetadataExtensionsDraft(JSON.stringify({
      opengeo: {
        schemaVersion: "1.2.0",
        acquisition: {
          plans: [{identifier: "plan-01", status: "planned"}]
        }
      }
    }));
    assert.equal(planned.opengeo.acquisition.plans[0].identifier, "plan-01");
    const eventGraph = parseMetadataExtensionsDraft(JSON.stringify({
      opengeo: {
        schemaVersion: "1.3.0",
        acquisition: {
          platformPasses: [{identifier: "pass-01"}],
          events: [{
            identifier: "event-01",
            trigger: "automatic",
            context: "acquisition",
            sequence: "start",
            time: "2026-07-01T09:00:00Z",
            passIdentifier: "pass-01"
          }]
        }
      }
    }));
    assert.equal(eventGraph.opengeo.acquisition.events[0].passIdentifier, "pass-01");
    assert.throws(
      () => parseMetadataExtensionsDraft('{"OpenGeo":{"schemaVersion":"1.0.0"}}'),
      /namespace is invalid/
    );
    assert.throws(
      () => parseMetadataExtensionsDraft('{"opengeo":{"schemaVersion":"2.0.0"}}'),
      /must be 1.0.0, 1.1.0, 1.2.0, or 1.3.0/
    );
    assert.throws(
      () => parseMetadataExtensionsDraft(
        '{"opengeo":{"schemaVersion":"1.0.0","unexpected":true}}'
      ),
      /unknown field/
    );
    assert.throws(
      () => parseMetadataExtensionsDraft(
        '{"opengeo":{"schemaVersion":"1.0.0","funding":[]}}'
      ),
      /unknown field/
    );
  });

  it("accepts bounded mixed-content drafts for governed table and chart authoring", () => {
    const content = parseContentDraft(JSON.stringify({blocks: [
      {
        id: "survey-table",
        type: "table",
        caption: "Survey results",
        columns: ["District", "Coverage"],
        rows: [["East", 0.75], ["West", 0.5]]
      },
      {
        id: "coverage-chart",
        type: "chart",
        chart_type: "bar",
        title: "Coverage by district",
        alt_text: "East coverage is 75 percent and West coverage is 50 percent.",
        table_block_id: "survey-table",
        x_column: "District",
        y_columns: ["Coverage"]
      }
    ]}));

    assert.equal(content.blocks[0].rows.length, 2);
    assert.equal(content.blocks[1].alt_text.startsWith("East coverage"), true);
    assert.throws(() => parseContentDraft("not-json"), /valid JSON/);
    assert.throws(
      () => parseContentDraft(JSON.stringify({blocks: Array.from({length: 25}, () => ({}))})),
      /at most 24 blocks/
    );
  });

  it("adds exact governed asset identities to a mixed-content draft", () => {
    const candidate = {
      kind: "image",
      datasetId: "80000000-0000-4000-8000-000000000001",
      datasetVersionId: "90000000-0000-4000-8000-000000000001",
      objectId: "a0000000-0000-4000-8000-000000000001",
      filename: "coverage.png"
    };
    const first = appendSiteAssetBlockDraft(
      JSON.stringify({blocks: []}),
      candidate,
      "Survey coverage by district"
    );
    const second = appendSiteAssetBlockDraft(
      JSON.stringify(first),
      candidate,
      "Survey coverage detail"
    );

    assert.deepEqual(first.blocks[0], {
      id: "image-a0000000",
      type: "image",
      datasetId: candidate.datasetId,
      datasetVersionId: candidate.datasetVersionId,
      objectId: candidate.objectId,
      altText: "Survey coverage by district",
      caption: null
    });
    assert.equal(second.blocks[1].id, "image-a0000000-2");
    const document = appendSiteAssetBlockDraft(
      JSON.stringify({blocks: []}),
      {...candidate, kind: "document", filename: "accessible-preview.json"},
      "Read the field report"
    );
    assert.deepEqual(document.blocks[0], {
      id: "document-a0000000",
      type: "document",
      datasetId: candidate.datasetId,
      datasetVersionId: candidate.datasetVersionId,
      objectId: candidate.objectId,
      label: "Read the field report"
    });
    assert.throws(
      () => appendSiteAssetBlockDraft(JSON.stringify(first), candidate, ""),
      /accessible label/
    );
  });

  it("adds and preserves immutable governed map/data version pins", () => {
    const candidate = {
      id: "60000000-0000-4000-8000-000000000001",
      kind: "map",
      title: "Access map",
      versionNumber: 4
    };
    const content = appendResourceReferenceBlockDraft(
      JSON.stringify({blocks: []}),
      candidate,
      "Verified road access"
    );

    assert.deepEqual(content.blocks[0], {
      id: "map-60000000",
      type: "map",
      resourceId: candidate.id,
      resourceVersionNumber: 4,
      caption: "Verified road access"
    });
    assert.equal(
      pinCurrentResourceReferences(content, [{...candidate, versionNumber: 5}])
        .blocks[0].resourceVersionNumber,
      4
    );
    assert.equal(
      pinCurrentResourceReferences(
        {blocks: [{id: "legacy", type: "map", resourceId: candidate.id}]},
        [candidate]
      ).blocks[0].resourceVersionNumber,
      4
    );
    const withDataset = appendResourceReferenceBlockDraft(
      JSON.stringify(content),
      {
        id: "60000000-0000-4000-8000-000000000002",
        kind: "dataset",
        title: "Access observations",
        versionNumber: 7
      }
    );
    assert.deepEqual(withDataset.blocks[1], {
      id: "dataset-60000000",
      type: "dataset",
      resourceId: "60000000-0000-4000-8000-000000000002",
      resourceVersionNumber: 7,
      caption: null
    });
    assert.throws(
      () => appendResourceReferenceBlockDraft(JSON.stringify(content), {...candidate, versionNumber: 0}),
      /identity/
    );
  });

  it("adds portable citations, bounded tables, and accessible table-backed charts", () => {
    const citation = appendCitationBlockDraft(JSON.stringify({blocks: []}), {
      title: "Road access study",
      doi: "10.1234/road-access",
      url: "https://evidence.example.test/road-access"
    });
    const table = appendTableBlockDraft(JSON.stringify(citation), {
      caption: "Coverage by district",
      columns: "District, Coverage, Verified",
      rows: "East, 0.75, true\nWest, 0.5, false\nUnknown, , false"
    });
    const chart = appendChartBlockDraft(JSON.stringify(table), {
      tableBlockId: "table-1",
      chartType: "bar",
      title: "Coverage",
      altText: "East coverage is 75 percent and West coverage is 50 percent.",
      xColumn: "district",
      yColumns: "coverage"
    });

    assert.deepEqual(citation.blocks[0], {
      id: "citation-1",
      type: "citation",
      title: "Road access study",
      doi: "10.1234/road-access",
      url: "https://evidence.example.test/road-access"
    });
    assert.deepEqual(table.blocks[1].rows, [
      ["East", 0.75, true],
      ["West", 0.5, false],
      ["Unknown", null, false]
    ]);
    assert.deepEqual(chart.blocks[2], {
      id: "chart-1",
      type: "chart",
      chartType: "bar",
      title: "Coverage",
      altText: "East coverage is 75 percent and West coverage is 50 percent.",
      tableBlockId: "table-1",
      xColumn: "District",
      yColumns: ["Coverage"]
    });
    assert.throws(
      () => appendChartBlockDraft(JSON.stringify(table), {
        tableBlockId: "table-1",
        chartType: "line",
        title: "Invalid",
        altText: "Invalid Boolean series",
        xColumn: "District",
        yColumns: "Verified"
      }),
      /only numbers/
    );
    assert.throws(
      () => appendCitationBlockDraft(JSON.stringify(chart), {title: "No locator"}),
      /DOI or URL/
    );
  });

  it("adds ordered structural headings, safe callouts, and exact in-page navigation", () => {
    const overview = appendHeadingBlockDraft(JSON.stringify({blocks: []}), {
      level: 2,
      text: "Overview"
    });
    const method = appendHeadingBlockDraft(JSON.stringify(overview), {
      level: 3,
      text: "Method"
    });
    const callout = appendCalloutBlockDraft(JSON.stringify(method), {
      tone: "warning",
      title: "Check the source",
      markdown: "Confirm the [evidence](https://evidence.example.test/source)."
    });
    const navigation = appendNavigationBlockDraft(JSON.stringify(callout), {
      label: "On this page",
      headingBlockIds: ["heading-1", "heading-2"]
    });

    assert.deepEqual(navigation.blocks.slice(0, 2), [
      {id: "heading-1", type: "heading", level: 2, text: "Overview"},
      {id: "heading-2", type: "heading", level: 3, text: "Method"}
    ]);
    assert.equal(navigation.blocks[2].tone, "warning");
    assert.deepEqual(navigation.blocks[3], {
      id: "navigation-1",
      type: "navigation",
      label: "On this page",
      headingBlockIds: ["heading-1", "heading-2"]
    });
    assert.throws(
      () => appendHeadingBlockDraft(JSON.stringify({blocks: []}), {level: 3, text: "Skipped"}),
      /first structural heading/
    );
    assert.throws(
      () => appendNavigationBlockDraft(JSON.stringify(method), {
        label: "Wrong order",
        headingBlockIds: ["heading-2", "heading-1"]
      }),
      /document order/
    );
    assert.throws(
      () => appendCalloutBlockDraft(JSON.stringify(method), {
        tone: "danger",
        title: "Unsupported",
        markdown: "No"
      }),
      /tone/
    );
  });

  it("simulates the complete managed upload lifecycle only in explicit fixture mode", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const projectId = FIXTURE_PROJECTS[0].projectId;
    const file = new Blob([JSON.stringify({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {name: "Pilot site", score: 7},
        geometry: {type: "Point", coordinates: [85.32, 27.71]}
      }]
    })], {type: "application/geo+json"});
    const ticket = await adapter.requestUpload(projectId, {
      name: "Browser upload",
      classification: "internal",
      format: "geojson",
      tags: ["browser"]
    });

    await adapter.uploadFile(ticket.upload, file);
    const completion = await adapter.completeUpload(projectId, ticket.uploadId);

    assert.equal(completion.dataset.status, "active");
    assert.equal(completion.processingJobState, "completed");
    assert.equal((await adapter.listDatasets(projectId))[0].name, "Browser upload");
    assert.equal((await adapter.getFeatureCollection(projectId, completion.dataset.id)).featureCount, 1);
    const lineage = await adapter.getDatasetVersionLineage(
      projectId, completion.dataset.id, completion.datasetVersionId
    );
    assert.equal(lineage.schemaVersion, "opengeo.dataset-version-lineage.1.0.0");
    assert.deepEqual(lineage.origins.map(({kind}) => kind), ["managed_upload"]);
    assert.equal(lineage.origins[0].operationId, ticket.uploadId);
    assert.equal(lineage.derivatives.length, 0);
    const versions = await adapter.listDatasetVersions(projectId, completion.dataset.id);
    assert.equal(lineage.origins[0].inputObjectId, versions[0].objects[0].id);
    assert.equal(await sha256Hex(file), versions[0].objects[0].checksumSha256);
    assert.equal((await adapter.completeUpload(projectId, ticket.uploadId)).processingJobId,
      completion.processingJobId);
  });

  it("binds concurrent fixture upload bodies to their exact tickets", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const projectId = FIXTURE_PROJECTS[0].projectId;
    const firstTicket = await adapter.requestUpload(projectId, {
      name: "First concurrent upload",
      classification: "internal",
      format: "geojson"
    });
    const secondTicket = await adapter.requestUpload(projectId, {
      name: "Second concurrent upload",
      classification: "internal",
      format: "geojson"
    });
    const firstFile = new Blob([JSON.stringify({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {ticket: "first"},
        geometry: {type: "Point", coordinates: [1, 1]}
      }]
    })], {type: "application/geo+json"});
    const secondFile = new Blob([JSON.stringify({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {ticket: "second"},
        geometry: {type: "Point", coordinates: [2, 2]}
      }]
    })], {type: "application/geo+json"});

    await adapter.uploadFile(secondTicket.upload, secondFile);
    await adapter.uploadFile(firstTicket.upload, firstFile);
    const second = await adapter.completeUpload(projectId, secondTicket.uploadId);
    const first = await adapter.completeUpload(projectId, firstTicket.uploadId);

    assert.equal(
      (await adapter.listFeatures(projectId, first.dataset.id)).features[0].properties.ticket,
      "first"
    );
    assert.equal(
      (await adapter.listFeatures(projectId, second.dataset.id)).features[0].properties.ticket,
      "second"
    );
    await assert.rejects(
      adapter.uploadFile(firstTicket.upload, firstFile),
      (error) => error.code === "upload_already_received"
    );
  });

  it("simulates governed external source revisions separately from upload versions", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const projectId = FIXTURE_PROJECTS[0].projectId;
    const source = await adapter.createSource(projectId, {
      name: "Public tiles",
      classification: "public",
      tags: ["basemap"],
      source: {
        type: "xyz",
        url: "https://tiles.example.test/{z}/{x}/{y}.png",
        minZoom: 0,
        maxZoom: 20,
        tileSize: 256,
        scheme: "xyz"
      }
    });
    const updated = await adapter.updateSource(projectId, source.datasetId, {
      expectedVersion: 1,
      changeMessage: "Move to v2 tiles",
      source: {
        type: "xyz",
        url: "https://tiles.example.test/v2/{z}/{x}/{y}.png",
        minZoom: 0,
        maxZoom: 20,
        tileSize: 256,
        scheme: "xyz"
      }
    });
    const state = await loadProjectContext(adapter, projectId);
    const revisions = await adapter.listSourceRevisions(projectId, source.datasetId);

    assert.equal(updated.versionNumber, 2);
    assert.deepEqual(revisions.map((revision) => revision.versionNumber), [2, 1]);
    assert.equal(state.sources[0].datasetId, source.datasetId);
    assert.equal(state.datasets.find((dataset) => dataset.id === source.datasetId).currentVersionId, null);
  });

  it("maps authentication, authorization, not-found, and retryable failures", async () => {
    for (const [status, expected] of [[401, "unauthenticated"], [403, "forbidden"], [404, "not_found"], [503, "error"]]) {
      const adapter = {
        kind: "api",
        async getSession() {
          throw Object.assign(new Error("safe"), {status, code: `http_${status}`, retryable: status === 503});
        }
      };
      assert.equal((await loadDirectory(adapter)).status, expected);
    }
  });

  it("loads every invitation lifecycle state in explicit fixture administration", async () => {
    const adapter = new FixturePlatformAdapter(catalog);

    const state = await loadTeamAdministration(adapter);

    assert.equal(state.status, "ready");
    assert.deepEqual(
      new Set(state.invitations.map((invitation) => invitation.status)),
      new Set(["pending", "accepted", "expired", "revoked"])
    );
    assert.equal(state.organizationMembers.length, 2);
    assert.equal(state.projectMembers.length, 2);

    await assert.rejects(
      adapter.revokeOrganizationMember(state.session.userId),
      (error) => error.code === "last_organization_admin"
    );
  });

  it("loads access administration without waiting for unrelated data and publication catalogs", async () => {
    const calls = [];
    const adapter = loadingProbeAdapter(calls);
    adapter.listOrganizationMembers = async () => { calls.push("members"); return []; };
    adapter.listInvitations = async () => { calls.push("invitations"); return []; };
    adapter.listProjectMembers = async (id) => { calls.push(`project-members:${id}`); return []; };
    const state = await loadTeamAdministration(adapter, "project-fast");
    assert.equal(state.status, "ready");
    assert.deepEqual(calls, ["session", "organization", "projects", "members", "invitations", "project-members:project-fast"]);
    assert.equal(state.selectedProjectId, "project-fast");
  });

  it("keeps team administration organization-admin only", async () => {
    const adapter = {
      kind: "api",
      selectOrganization() {},
      async getSession() {
        return {
          userId: "20000000-0000-4000-8000-000000000001",
          memberships: [{organizationId: "10000000-0000-4000-8000-000000000001", role: "member"}],
          selectedOrganizationId: "10000000-0000-4000-8000-000000000001"
        };
      },
      async getCurrentOrganization() {
        return {id: "10000000-0000-4000-8000-000000000001", name: "Member org", callerRole: "member"};
      },
      async listProjects() { return []; },
      async listClients() { return []; }
    };

    const state = await loadTeamAdministration(adapter);

    assert.equal(state.status, "forbidden");
    assert.equal(state.code, "organization_admin_required");
  });
});

it("does not load unrelated directory supplements when opening Collections", async () => {
  const calls = [], adapter = loadingProbeAdapter(calls);
  const core = await loadDirectoryCore(adapter);
  calls.length = 0;
  const result = await loadDirectorySupplements(adapter, core, {view: "collections"});
  assert.equal(result.status, "ready");
  assert.deepEqual(calls, []);
});
