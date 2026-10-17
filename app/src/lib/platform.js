import {ApiClientError, OpenGeoApiClient} from "./apiClient.js";
import {
  clearBrowserSession,
  clearSelectedOrganization,
  getAccessToken,
  getSelectedOrganization,
  selectOrganization
} from "./auth.js";
import {retainedEditorIdentityStatus} from './retainedProjectScope.js';

export async function createPlatformAdapter({
  catalog = null,
  url = globalThis.location?.href ?? "http://localhost/",
  storage = safeSessionStorage(),
  fetchImplementation = globalThis.fetch?.bind(globalThis),
  capabilities = null,
  previewOrigins
} = {}) {
  const mode = new URL(url).searchParams.get("adapter");
  if (mode === "fixture") {
    const {FixturePlatformAdapter} = await import("./fixturePlatform.js");
    return new FixturePlatformAdapter(catalog);
  }

  let selectedOrganizationId = getSelectedOrganization(storage);
  const client = new OpenGeoApiClient({
    tokenProvider: () => getAccessToken(storage),
    organizationProvider: () => selectedOrganizationId,
    previewOrigins,
    studioOrigin: new URL(url).origin,
    fetchImplementation
  });
  client.kind = "api";
  client.selectOrganization = (organizationId) => {
    selectOrganization(organizationId, storage);
    selectedOrganizationId = organizationId;
  };
  client.clearSession = () => {
    clearBrowserSession(storage);
    selectedOrganizationId = null;
  };
  client.clearOrganization = () => {
    clearSelectedOrganization(storage);
    selectedOrganizationId = null;
  };
  if (capabilities?.kmlNetworkLinkFetch === true) {
    client.refreshKmlNetworkLink = async (projectId, request, {signal} = {}) => {
      const payload = await client.request(
        `/projects/${kmlNetworkLinkProjectId(projectId)}/kml-network-links/refresh`,
        {
          method: "POST",
          signal,
          body: serializeKmlNetworkLinkRequest(request)
        }
      );
      return parseKmlNetworkLinkReceipt(payload);
    };
  }
  return client;
}

function kmlNetworkLinkProjectId(value) {
  if (typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError("KML NetworkLink project id is invalid");
  }
  return value.toLowerCase();
}

function serializeKmlNetworkLinkRequest(value) {
  if (!value || typeof value !== "object") throw new TypeError("KML NetworkLink request is invalid");
  return {
    schema_version: value.schemaVersion,
    link_id: value.linkId,
    reason: value.reason,
    source_href: value.sourceHref,
    request_url: value.requestUrl,
    requested_at: value.requestedAt,
    maximum_bytes: value.maximumBytes,
    timeout_milliseconds: value.timeoutMilliseconds,
    accept: value.accept,
    conditional: {
      etag: value.conditional?.etag ?? null,
      last_modified: value.conditional?.lastModified ?? null
    },
    transport: value.transport,
    security_contract: value.securityContract
  };
}

function parseKmlNetworkLinkReceipt(value) {
  if (!value || typeof value !== "object") throw new TypeError("KML NetworkLink receipt is invalid");
  return {
    requestUrl: value.request_url,
    finalUrl: value.final_url,
    status: value.status,
    redirects: value.redirects,
    dnsPinned: value.dns_pinned,
    allAddressesPublic: value.all_addresses_public,
    tlsVerified: value.tls_verified,
    credentialsSent: value.credentials_sent,
    mediaType: value.media_type,
    byteLength: value.byte_length,
    fetchedAt: value.fetched_at,
    expiresAt: value.expires_at,
    etag: value.etag ?? null,
    lastModified: value.last_modified ?? null,
    ...(typeof value.body_text === "string" ? {bodyText: value.body_text} : {}),
    ...(typeof value.body_base64 === "string" ? {bodyBase64: value.body_base64} : {})
  };
}

export async function loadDirectoryCore(adapter, {signal, onProgress = () => {}, includeProjects = true} = {}) {
  try {
    signal?.throwIfAborted();
    onProgress({step: "session", state: "loading"});
    let session;
    try {
      session = await adapter.getSession({signal});
    } catch (error) {
      // The SDK already retries a temporarily unavailable identity store once.
      // Leave further recovery to the startup backoff instead of repeating it here.
      if (error?.status === 403 && adapter.clearOrganization) {
        signal?.throwIfAborted();
        adapter.clearOrganization();
        session = await adapter.getSession({signal});
      } else {
        throw error;
      }
    }

    signal?.throwIfAborted();
    onProgress({step: "session", state: "complete"});
    const selected = session.selectedOrganizationId
      ?? (session.memberships.length === 1 ? session.memberships[0].organizationId : null);
    if (!selected) {
      if (session.memberships.length) {
        return {status: "organization_required", session, adapter};
      }
      onProgress({step: "access", state: "loading"});
      const invitations = await adapter.listMyInvitations({signal});
      signal?.throwIfAborted();
      return invitations.length
        ? {status: "invitation_required", session, invitations, adapter}
        : {status: "forbidden", code: "organization_membership_required", session, adapter};
    }
    adapter.selectOrganization(selected);
    onProgress({step: "access", state: "loading"});
    if (includeProjects) onProgress({step: "projects", state: "loading"});
    const [organization, projects] = await Promise.all([
      adapter.getCurrentOrganization({signal}).then((value) => {
        signal?.throwIfAborted();
        onProgress({step: "access", state: "complete"});
        return value;
      }),
      includeProjects ? adapter.listProjects({limit: 100, signal}).then((value) => {
        signal?.throwIfAborted();
        onProgress({step: "projects", state: "complete"});
        return value;
      }) : []
    ]);
    return {
      status: "ready",
      adapter,
      session,
      organization,
      projects,
      teams: [],
      userConnections: [],
      userBasemapConnections: [],
      publicSiteDirectory: emptyPublicSiteDirectory(),
      clients: [],
      clientsRestricted: false,
      directoryWarnings: [],
      directorySupplementsLoaded: []
    };
  } catch (error) {
    return failureState(error, adapter, "directory");
  }
}

// A mounted view already knows its login identity. Recheck current account
// membership without rebuilding the session or carrying resource inventories.
// Every area still reads its own authorized resources after this check.
export async function revalidateDirectoryCore(adapter, directory, identity, {signal} = {}) {
  try {
    signal?.throwIfAborted();
    if (directory?.status !== 'ready' || directory.adapter !== adapter || !identity) {
      return {status: 'forbidden', adapter};
    }
    const before = await retainedEditorIdentityStatus(adapter, identity);
    if (before) return {status: before, adapter};
    const organization = await adapter.getCurrentOrganization({signal});
    signal?.throwIfAborted();
    const after = await retainedEditorIdentityStatus(adapter, identity);
    if (after) return {status: after, adapter};
    if (organization.id !== directory.organization.id || organization.id !== identity.organization) {
      return {status: 'forbidden', adapter};
    }
    return {
      status: 'ready', adapter, organization,
      session: {...directory.session, selectedOrganizationId: organization.id,
        selectedOrganizationRole: organization.callerRole,
        memberships: (directory.session.memberships ?? []).map(membership => membership.organizationId === organization.id
          ? {...membership, role: organization.callerRole} : membership)},
      projects: [], teams: [], userConnections: [], userBasemapConnections: [],
      publicSiteDirectory: emptyPublicSiteDirectory(), clients: [], clientsRestricted: false,
      directoryWarnings: [], directorySupplementsLoaded: []
    };
  } catch (error) {
    if (error?.status === 401) adapter.clearSession?.();
    return failureState(error, adapter, 'directory');
  }
}

export async function loadDirectorySupplements(adapter, directory, {view = "all"} = {}) {
  if (directory?.status !== "ready") return directory;
  const requested = directorySupplementNames(view);
  const tasks = [];
  if (requested.has("clients")) tasks.push(["clients", loadClients(adapter)]);
  if (requested.has("teams")) {
    tasks.push(["teams", loadDirectorySupplement(adapter, "listTeams", "teams")]);
  }
  if (requested.has("connections")) {
    tasks.push([
      "datasetConnections",
      loadDirectorySupplement(adapter, "listMyDatasetConnections", "dataset connections")
    ]);
    tasks.push([
      "basemapConnections",
      loadDirectorySupplement(adapter, "listMyBasemapConnections", "basemap connections")
    ]);
  }
  if (requested.has("publications")) {
    tasks.push(["publicationWorkspaces", loadDirectorySupplement(adapter, "listPublicationWorkspaces", "Framework publication workspaces")]);
    tasks.push([
      "publications",
      loadPublicSiteDirectory(adapter, directory.organization.id)
    ]);
  }
  const resolved = await Promise.all(tasks.map(async ([name, promise]) => [name, await promise]));
  const next = {
    ...directory,
    directorySupplementsLoaded: [...new Set([
      ...(directory.directorySupplementsLoaded ?? []),
      ...requested
    ])]
  };
  const warnings = [...(directory.directoryWarnings ?? [])];
  for (const [name, result] of resolved) {
    if (name === "clients") {
      next.clients = result.clients;
      next.clientsRestricted = result.restricted;
    } else if (name === "teams") {
      next.teams = result.records;
    } else if (name === "datasetConnections") {
      next.userConnections = result.records;
    } else if (name === "basemapConnections") {
      next.userBasemapConnections = result.records;
    } else if (name === "publications") {
      next.publicSiteDirectory = result.page;
    } else if (name === "publicationWorkspaces") {
      next.publicationWorkspaces = result.records;
    }
    if (result.warning) warnings.push(result.warning);
  }
  next.directoryWarnings = warnings;
  return next;
}

export async function loadDirectory(adapter, {supplements = "all"} = {}) {
  const directory = await loadDirectoryCore(adapter);
  return directory.status === "ready"
    ? loadDirectorySupplements(adapter, directory, {view: supplements})
    : directory;
}

export async function loadProjectContext(adapter, projectId, mapId = null, {surface = "all", compositionId = null, publicationId = null, signal, revalidateOnly = false, retainedDirectory = null, retainedIdentity = null} = {}) {
  // A retained editor needs current authority and render inputs, not refreshed
  // project/map switcher inventories. Never use this mode to construct a page.
  if (revalidateOnly && (!compositionId || publicationId)) throw new Error("Revalidation requires one composition identity");
  if (retainedDirectory && (!revalidateOnly || !retainedIdentity || retainedDirectory.status !== 'ready' || retainedDirectory.adapter !== adapter)) {
    throw new Error('Retained account context requires same-adapter composition revalidation');
  }
  // A canonical Project already identifies its map and access container. The
  // workbench's lazy Project switcher loads the complete index when requested.
  let directory;
  if (retainedDirectory) {
    try {
      signal?.throwIfAborted();
      const mismatch = await retainedEditorIdentityStatus(adapter, retainedIdentity);
      if (mismatch) return {status: mismatch, adapter};
      const organization = await adapter.getCurrentOrganization({signal});
      signal?.throwIfAborted();
      if (organization.id !== retainedDirectory.organization.id) throw Object.assign(new Error('Account changed'), {status: 403});
      directory = {...retainedDirectory, organization};
    } catch (error) {return failureState(error, adapter, 'directory');}
  } else directory = await loadDirectoryCore(adapter, {signal, includeProjects: !(compositionId || publicationId)});
  if (directory.status !== "ready") return directory;
  try {
    signal?.throwIfAborted();
    if (compositionId && publicationId) throw new Error("Choose one authored identity");
    const publication = publicationId ? await adapter.getPublication(publicationId, {signal}) : null;
    if (publication) {
      if (publication.id !== publicationId || publication.resourceType !== "publication" || !publication.accessContainerId) {
        throw new Error("Publication identity changed");
      }
      projectId = publication.accessContainerId;
      mapId = null;
      surface = "publishing";
    }
    const composition = compositionId ? await adapter.getComposition(compositionId, {signal}) : null;
    if (composition) {
      if (composition.id !== compositionId || composition.resourceType !== "project" || !composition.accessContainerId) {
        throw new Error("Composition identity changed");
      }
      projectId = composition.accessContainerId;
      mapId = composition.id;
      surface = "maps";
    }
    signal?.throwIfAborted();
    const needs = projectContextNeeds(surface);
    const projectPromise = adapter.getProject(projectId, {signal});
    const mapsPromise = Promise.resolve(composition ? [composition]
      : ["publishing", "print", "settings"].includes(surface)
        ? [] : adapter.listMaps(projectId, {limit: 100, signal}));
    const corePromise = Promise.all([
      projectPromise, mapsPromise,
      needs.has("datasets") ? adapter.listDatasets(projectId, {limit: 100, signal}) : []
    ]);
    // A project without a map can still be a complete publication workspace.
    // Resolve that distinction only for the empty-map path so ordinary map
    // workspaces retain the smaller, faster initial request set.
    const supplementDefinitions = [
      ["sources", "listSources", "data sources", [projectId, {limit: 100, signal}]],
      ["resources", "listResources", "documents and stories", [projectId, {limit: 100, signal}]],
      ["metadataProfiles", "listMetadataProfiles", "metadata profiles", [{signal}]],
      ["spatialServices", "listSpatialServices", "spatial services", [projectId, {signal}]],
      ["sites", "listSites", "publication sites", [projectId, {signal}]],
      ["observableSourceProjects", "listObservableSourceProjects", "publication source projects", [projectId, {signal}]],
      ["datasetConnectionBindings", "listProjectDatasetConnectionBindings", "dataset connections", [projectId, {signal}]],
      ["basemapConnectionBindings", "listProjectBasemapConnectionBindings", "basemap connections", [projectId, {signal}]]
    ];
    // Keep supplemental reads behind current workspace authority, but do not
    // serialize independent connection lookups behind the dataset inventory.
    const supplementsPromise = Promise.all([projectPromise, mapsPromise]).then(async ([, maps]) => {
      signal?.throwIfAborted();
      const supplementNeeds = surface === "maps" && maps.length === 0
        ? new Set([...needs, "sites", "observableSourceProjects"])
        : needs;
      return Promise.all(supplementDefinitions.map(async ([name, method, label, args]) => (
        supplementNeeds.has(name) && !(publication && name === "sites")
          ? [name, await loadProjectSupplement(adapter, method, label, args)]
          : [name, {records: [], warning: null}]
      )));
    });
    const [[project, maps, datasets], supplements] = await Promise.all([corePromise, supplementsPromise]);
    signal?.throwIfAborted();
    const supplementRecords = Object.fromEntries(
      supplements.map(([name, {records}]) => [name, records])
    );
    const selectedMap = composition ?? (mapId
      ? maps.find((record) => record.id === mapId) ?? await adapter.getMap(projectId, mapId, {signal})
      : maps.find((record) => record.status === "active") ?? maps[0] ?? null);
    signal?.throwIfAborted();
    return {
      ...directory,
      project,
      projects: composition || publication ? [project] : directory.projects,
      maps,
      datasets,
      ...supplementRecords,
      projectWarnings: supplements.map(([, {warning}]) => warning).filter(Boolean),
      projectSurfaceLoaded: surface,
      selectedMap,
      ...(publication ? {publication, sites: [publication]} : {})
    };
  } catch (error) {
    return {
      ...directory,
      ...failureState(error, adapter, "project")
    };
  }
}

function directorySupplementNames(view) {
  if (view === "collections" || view === "locations" || view === "styles") return new Set();
  if (view === "projects" || view === "access") return new Set(["clients", "teams"]);
  if (view === "data") return new Set(["clients"]);
  if (view === "sources") return new Set(["connections"]);
  if (view === "publishing") return new Set(["publications"]);
  if (view === "teams") return new Set(["teams"]);
  return new Set(["clients", "teams", "connections", "publications"]);
}

function projectContextNeeds(surface) {
  if (surface === "maps") {
    return new Set(["datasets", "sources", "datasetConnectionBindings", "basemapConnectionBindings"]);
  }
  if (surface === "data") {
    return new Set(["datasets", "sources", "datasetConnectionBindings", "basemapConnectionBindings"]);
  }
  if (surface === "resources") {
    return new Set(["datasets", "resources", "metadataProfiles"]);
  }
  if (surface === "services") {
    return new Set(["datasets", "resources", "spatialServices"]);
  }
  if (surface === "publishing") {
    return new Set(["resources", "sites", "observableSourceProjects"]);
  }
  if (surface === "print") return new Set(["sites"]);
  if (surface === "settings") return new Set();
  return new Set([
    "datasets",
    "sources",
    "resources",
    "metadataProfiles",
    "spatialServices",
    "sites",
    "observableSourceProjects",
    "datasetConnectionBindings",
    "basemapConnectionBindings"
  ]);
}

export async function loadTeamAdministration(adapter, projectId = null) {
  const directory = await loadDirectoryCore(adapter);
  if (directory.status !== "ready") return directory;
  if (directory.organization.callerRole !== "admin") {
    return {status: "forbidden", code: "organization_admin_required", adapter};
  }
  const selectedProjectId = projectId
    ?? directory.projects.find((project) => project.status === "active")?.id
    ?? directory.projects[0]?.id
    ?? null;
  try {
    const [organizationMembers, invitations, projectMembers] = await Promise.all([
      adapter.listOrganizationMembers({limit: 100}),
      adapter.listInvitations({limit: 100}),
      selectedProjectId ? adapter.listProjectMembers(selectedProjectId, {limit: 100}) : []
    ]);
    return {
      ...directory,
      organizationMembers,
      invitations,
      selectedProjectId,
      projectMembers
    };
  } catch (error) {
    return failureState(error, adapter);
  }
}

async function loadClients(adapter) {
  try {
    return {clients: await adapter.listClients({limit: 100}), restricted: false, warning: null};
  } catch (error) {
    if (error?.status === 403) return {clients: [], restricted: true, warning: null};
    return {
      clients: [],
      restricted: false,
      warning: directorySupplementWarning("clients", error)
    };
  }
}

async function loadDirectorySupplement(adapter, method, label) {
  if (typeof adapter?.[method] !== "function") return {records: [], warning: null};
  try {
    const records = await adapter[method]();
    return {records: Array.isArray(records) ? records : [], warning: null};
  } catch (error) {
    return {records: [], warning: directorySupplementWarning(label, error)};
  }
}

async function loadPublicSiteDirectory(adapter, organizationId) {
  if (typeof adapter?.listPublicSites !== "function") {
    return {page: emptyPublicSiteDirectory(), warning: null};
  }
  try {
    return {
      page: await adapter.listPublicSites(organizationId, {limit: 100, offset: 0}),
      warning: null
    };
  } catch (error) {
    return {
      page: emptyPublicSiteDirectory(),
      warning: directorySupplementWarning("publications", error)
    };
  }
}

function emptyPublicSiteDirectory() {
  return {
    schemaVersion: "opengeo.public-site-directory.1.0.0",
    numberReturned: 0,
    numberMatched: 0,
    limit: 100,
    offset: 0,
    nextOffset: null,
    records: []
  };
}

async function loadProjectSupplement(adapter, method, label, args = []) {
  if (typeof adapter?.[method] !== "function") return {records: [], warning: null};
  try {
    const records = await adapter[method](...args);
    return {records: Array.isArray(records) ? records : [], warning: null};
  } catch (error) {
    return {records: [], warning: directorySupplementWarning(label, error)};
  }
}

function directorySupplementWarning(label, error) {
  return {
    label,
    code: typeof error?.code === "string" ? error.code : "supplement_unavailable",
    requestId: typeof error?.requestId === "string" ? error.requestId : null
  };
}

export function failureState(error, adapter, scope = "resource") {
  if (error?.status === 401 || error?.code === "authentication_required") {
    return {status: "unauthenticated", code: error.code ?? "authentication_required", scope, adapter};
  }
  if (error?.status === 403) return {status: "forbidden", code: error.code ?? "action_forbidden", scope, adapter};
  if (error?.status === 404) return {status: "not_found", code: error.code ?? "resource_not_found", scope, adapter};
  return {
    status: "error",
    code: error instanceof ApiClientError ? error.code : "unexpected_error",
    requestId: error?.requestId ?? null,
    retryable: error?.retryable ?? true,
    scope,
    adapter
  };
}

function safeSessionStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}
