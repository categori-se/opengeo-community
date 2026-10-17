const DIRECTORY_VIEWS = new Set(["projects", "data", "sources", "publishing", "teams", "collections", "locations", "access", "styles"]);
export const PROJECT_SURFACES = Object.freeze([
  "data",
  "discussions",
  "resources",
  "services",
  "publishing",
  "print",
  "settings"
]);
const MANAGEMENT_TARGETS = new Set(PROJECT_SURFACES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LAYER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export function directoryHref({
  view = "projects",
  adapterKind = null,
  create = null,
  projectContext = null,
  publicResourceTarget = null
} = {}) {
  const normalizedView = create === "publication" ? "publishing" : DIRECTORY_VIEWS.has(view) ? view : "projects";
  const query = new URLSearchParams();
  if (normalizedView !== "projects") query.set("view", normalizedView);
  if (adapterKind === "fixture") query.set("adapter", "fixture");
  if (create === "map" || create === "publication") query.set("new", create);
  if (normalizedView === "publishing" && UUID.test(projectContext ?? "")) query.set("projectContext", projectContext);
  if (
    normalizedView === "data"
    && UUID.test(publicResourceTarget?.projectId ?? "")
    && UUID.test(publicResourceTarget?.resourceId ?? "")
  ) {
    query.set("publicProject", publicResourceTarget.projectId);
    query.set("publicResource", publicResourceTarget.resourceId);
  }
  const suffix = query.toString();
  return `/workspaces${suffix ? `?${suffix}` : ""}`;
}

export function publicResourceRouteTarget(searchParameters) {
  if (searchParameters?.get?.("view") !== "data") return null;
  const projectId = searchParameters.get("publicProject");
  const resourceId = searchParameters.get("publicResource");
  if (!UUID.test(projectId ?? "") || !UUID.test(resourceId ?? "")) return null;
  return {projectId, resourceId};
}

// Collection identity is independent of the current account and its member workspaces.
export function collectionHref(collectionId, {adapterKind = null} = {}) {
  if (!UUID.test(collectionId ?? "")) throw new TypeError("Invalid Collection identity");
  const query = new URLSearchParams({view: "collections", collection: collectionId});
  if (adapterKind === "fixture") query.set("adapter", "fixture");
  return `/workspaces?${query}`;
}

export function collectionRouteTarget(searchParameters) {
  const id = searchParameters?.get?.("collection");
  return searchParameters?.get?.("view") === "collections" && UUID.test(id ?? "") ? id : null;
}

// Publication identity is its editable site, never a build or published edition.
export function publicationHref(publicationId, {adapterKind = null} = {}) {
  if (!UUID.test(publicationId ?? "")) throw new TypeError("Invalid publication identity");
  const query = new URLSearchParams({publication: publicationId});
  if (adapterKind === "fixture") query.set("adapter", "fixture");
  return `/workspaces?${query}`;
}

// Authored Project identity. The legacy project parameter remains access context.
export function compositionHref(compositionId, {adapterKind = null, management = null} = {}) {
  if (!UUID.test(compositionId ?? "")) throw new TypeError("Invalid composition identity");
  const query = new URLSearchParams({composition: compositionId});
  if (adapterKind === "fixture") query.set("adapter", "fixture");
  if (management === "print") query.set("manage", "print");
  return `/workspaces?${query}${management === "print" ? "#project-print" : ""}`;
}

export function projectHref(projectId, {
  adapterKind = null,
  mapId = null,
  management = null,
  datasetId = null,
  mapDatasetTarget = null,
  siteResourceTarget = null,
  featureTarget = null,
  fragment = null
} = {}) {
  const query = new URLSearchParams({project: String(projectId)});
  if (adapterKind === "fixture") query.set("adapter", "fixture");
  const selectedMapId = featureTarget?.mapId ?? mapDatasetTarget?.mapId ?? mapId;
  if (selectedMapId) query.set("map", String(selectedMapId));
  if (MANAGEMENT_TARGETS.has(management)) query.set("manage", management);
  if (featureTarget && ["data", "discussions"].includes(management)) {
    query.set("dataset", String(featureTarget.datasetId));
    query.set("feature", String(featureTarget.featureId));
    query.set("layer", String(featureTarget.layerId));
    query.set("mapVersion", String(featureTarget.mapVersion));
  } else if (datasetId && management === "data") {
    query.set("dataset", String(datasetId));
  } else if (mapDatasetTarget && management === null) {
    query.set("intent", "add-dataset");
    query.set("dataset", String(mapDatasetTarget.datasetId));
    query.set("datasetVersion", String(mapDatasetTarget.datasetVersionId));
  } else if (siteResourceTarget && management === "publishing") {
    query.set("intent", "add-resource");
    query.set("resource", String(siteResourceTarget.resourceId));
    query.set("resourceVersion", String(siteResourceTarget.resourceVersion));
  }
  const hash = fragment ?? (MANAGEMENT_TARGETS.has(management) ? `project-${management}` : null);
  return `/workspaces?${query}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
}

export function siteResourceRouteTarget(searchParameters) {
  if (searchParameters?.get?.("intent") !== "add-resource"
    || searchParameters?.get?.("manage") !== "publishing") return null;
  const resourceId = searchParameters.get("resource");
  const resourceVersion = Number(searchParameters.get("resourceVersion"));
  if (!UUID.test(resourceId ?? "")
    || !Number.isSafeInteger(resourceVersion)
    || resourceVersion < 1) return null;
  return {resourceId, resourceVersion};
}

export function mapDatasetRouteTarget(searchParameters) {
  if (searchParameters?.get?.("intent") !== "add-dataset"
    || searchParameters?.get?.("manage") !== null) return null;
  const mapId = searchParameters.get("map");
  const datasetId = searchParameters.get("dataset");
  const datasetVersionId = searchParameters.get("datasetVersion");
  if (![mapId, datasetId, datasetVersionId].every((value) => UUID.test(value ?? ""))) {
    return null;
  }
  return {mapId, datasetId, datasetVersionId};
}

export function featureRouteTarget(searchParameters) {
  const mapId = searchParameters?.get?.("map") ?? null;
  const datasetId = searchParameters?.get?.("dataset") ?? null;
  const featureId = searchParameters?.get?.("feature") ?? null;
  const layerId = searchParameters?.get?.("layer") ?? null;
  const mapVersionText = searchParameters?.get?.("mapVersion") ?? null;
  const mapVersion = Number(mapVersionText);
  if (![mapId, datasetId, featureId].every((value) => UUID.test(value ?? ""))
    || !LAYER_ID.test(layerId ?? "")
    || !Number.isSafeInteger(mapVersion)
    || mapVersion < 1) return null;
  return {mapId, mapVersion, layerId, datasetId, featureId};
}

export function fixtureAdapterKind(persistenceMode) {
  return persistenceMode === "fixture" ? "fixture" : null;
}

// The dataset UUID is the reusable layer identity. No project is part of it.
export function layerHref(datasetId, {adapterKind = null} = {}) {
  const query = new URLSearchParams({id: String(datasetId)});
  if (adapterKind === "fixture") query.set("adapter", "fixture");
  return `/layers?${query}`;
}

export function layerRouteTarget(parameters) {
  const id = parameters?.get?.("id");
  return UUID.test(id ?? "") && parameters.getAll("id").length === 1
    ? {datasetId: id.toLowerCase()} : null;
}

export function locationHref(id, {adapterKind = null} = {}) {
  if (!UUID.test(id ?? "")) throw new TypeError("Invalid Location identity");
  const query = new URLSearchParams({view: "locations", location: id});
  if (adapterKind === "fixture") query.set("adapter", "fixture");
  return `/workspaces?${query}`;
}
