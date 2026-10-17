import {DatasetVersionFiles} from "./DatasetVersionFiles.js";
import {DatasetAccess} from "./DatasetAccess.js";
import {CaptureRefresh} from "./CaptureRefresh.js";
import {DatasetRefresh} from "./DatasetRefresh.js";
import {DatasetVersionComparison} from "./DatasetVersionComparison.js";
import {catalogSpatialStatus} from "../lib/catalogSpatialStatus.js";
import {DiscoveryMetadata} from "./DiscoveryMetadata.js";
import {LayerGovernedMetadata} from "./LayerGovernedMetadata.js";
import {ResourceKnowledge} from "./ResourceKnowledge.js";
import {DirectoryLoading} from "./DirectoryLoading.js";
import {platformStatePanel} from "./PlatformStatePanel.js";
import {StudioNavigation} from "./StudioNavigation.js";
import {CatalogResourceMapAction} from "./CatalogResourceMapAction.js";
import {directoryHref, layerHref, projectHref} from "../lib/applicationRoutes.js";
import {LayerMetadataCards, metadataCard, recordedLayerMetadata} from "./LayerMetadataCards.js";
import {CatalogPreservationStatus} from "./CatalogPreservationStatus.js";
import {CatalogArchivePreview, canPreviewCatalogArchive} from "./CatalogArchivePreview.js";
import {SourceDetails} from "./SourceDetails.js";

const REMOTE_SOURCES = new Set(["xyz", "wms", "pmtiles", "geojson", "arcgis", "wfs", "imageserver", "mapserver", "cog", "postgis"]);

// Inspection is read-only; explicit update controls are separate. The returned projectId is an authorization context,
// never the layer identity, an ownership assertion or a newly created project.
export function LayerResourcePage({adapter, target, auth = null}) {
  const root = node("section", "", "platform-surface layer-resource-page");
  let generation = 0, loading, resource;
  root.dispose = () => {generation++; loading?.dispose(); resource?.dispose?.();};
  root.ready = refresh();
  return root;

  async function refresh() {
    const current = ++generation;
    loading?.dispose();
    resource?.dispose?.();
    const navigation = () => StudioNavigation({adapterKind: adapter.kind, active: "data"});
    if (!target) {
      root.replaceChildren(navigation(), node("h1", "Layer not found"),
        node("p", "Choose a resource from the catalog."), link("Open catalog", directoryHref({view: "data", adapterKind: adapter.kind})));
      return;
    }
    loading = DirectoryLoading({adapter, includeProjects: false});
    root.replaceChildren(navigation(), loading.element);
    const state = await loading.result;
    if (current !== generation) return;
    if (state.status !== "ready") {
      root.replaceChildren(navigation(), platformStatePanel(state, refresh, {
        auth, returnTo: layerHref(target.datasetId, {adapterKind: adapter.kind})
      }));
      return;
    }
    root.replaceChildren(navigation(), node("p", "Loading resource…"));
    try {
      const dataset = await adapter.getCatalogDataset(target.datasetId);
      if (current !== generation) return;
      if (dataset.id !== target.datasetId) throw new Error("Resource identity changed");
      const [sourceResult, knowledgeResult] = await Promise.allSettled([
        REMOTE_SOURCES.has(dataset.sourceType) && adapter.getSource ? adapter.getSource(dataset.projectId, dataset.id) : null,
        adapter.getDatasetKnowledge ? adapter.getDatasetKnowledge(dataset.id) : null
      ]);
      if (current !== generation) return;
      const source = sourceResult.status === "fulfilled" ? sourceResult.value : null;
      if (source && (source.datasetId !== dataset.id || source.projectId !== dataset.projectId)) throw new Error("Source identity changed");
      const knowledge = knowledgeResult.status === "fulfilled" ? knowledgeResult.value : null;
      const body = renderLayerResource({dataset, source, knowledge, adapter, projects: state.projects, projectsLoaded: false,
        accountRole: state.organization.callerRole, accountId: state.organization.id});
      resource = body;
      if (sourceResult.status === "rejected" || knowledgeResult.status === "rejected") {
        body.prepend(node("p", "Some recorded metadata could not load. Reload this page to retry.", "platform-status"));
      }
      root.replaceChildren(navigation(), body);
    } catch (error) {
      if (current !== generation) return;
      const missing = [403, 404].includes(error?.status);
      root.replaceChildren(navigation(), node("h1", missing ? "Resource unavailable" : "Resource could not load"),
        node("p", missing ? "This resource is unavailable in the selected account, or you do not have access." : "Try loading this resource again."),
        button("Retry", refresh), link("Open catalog", directoryHref({view: "data", adapterKind: adapter.kind})));
    }
  }
}

export function renderLayerResource({dataset, source: recordedSource = null, knowledge = null, adapter, projects = [], projectsLoaded = true, accountRole = null, accountId = null}) {
  const root = node("article", "", "layer-resource");
  root.style.minWidth = "0";
  root.style.overflowWrap = "anywhere";
  let disposed=false, sourceInspector;
  const resourceKnowledge=ResourceKnowledge({adapter,datasetId:dataset.id,projectId:dataset.projectId});
  root.dataset.resourceId = dataset.id;
  const observed = recordedLayerMetadata(knowledge).metadata;
  const nonSpatial = ["pdf","odt","png","jpeg"].includes(dataset.format)
    || ["table","document","image","none"].includes(dataset.geometryType?.toLowerCase())
    || (dataset.format === "csv" && !dataset.geometryType);
  root.append(node("p", nonSpatial ? "Catalog resource" : "Catalog Layer", "platform-eyebrow"), node("h1", observed?.name || dataset.name),
    node("p", dataset.description || "Description not recorded."));
  if (observed?.name && observed.name !== dataset.name) root.append(node("p", dataset.name, "layer-metadata-note"));
  const mapAction = CatalogResourceMapAction({dataset, adapter});
  if (mapAction) {root.append(mapAction.button, mapAction.panel); root.dispose = mapAction.dispose;}
  if (canPreviewCatalogArchive(dataset, adapter)) {
    const preview = CatalogArchivePreview({dataset, adapter});
    root.append(preview);
    const disposeEarlier = root.dispose;
    root.dispose = () => {disposeEarlier?.(); preview.dispose();};
  }
  root.append(LayerMetadataCards({dataset, source: recordedSource, knowledge}));
  root.append(node("p", nonSpatial ? "Non-spatial resource · review files, columns or document text below. Geometry is not required." : `Catalog spatial search: ${catalogSpatialStatus(dataset)}`, "layer-metadata-note"));
  if (!nonSpatial && dataset.sourceType === "upload" && dataset.currentVersionId && adapter.listManagedDisplays) {
    const displays = lazyPanel("Tiled map displays", async () => {
      const result = await adapter.listManagedDisplays(dataset.projectId, dataset.id, dataset.currentVersionId);
      if (result.dataset_id !== dataset.id || result.dataset_version_id !== dataset.currentVersionId) throw Error("Saved dataset version changed");
      const section = node("section");
      section.append(node("p", "Reviewed tiles of this saved dataset version. Listing them does not read S3. In the map, choose Layer actions → Map display to select a copy and review its download cost."));
      if (!result.archives.length) section.append(node("p", "No reviewed tiled display is available for this saved version."));
      for (const display of result.archives) {
        const card = metadataCard(display.title, [["Format", display.format], ["Features", display.feature_count], ["Stored bytes", display.download_bytes]]);
        card.append(jsonDetails("Display provenance", display.provenance), jsonDetails("Representation rights", display.rights));
        section.append(card);
      }
      return section;
    });
    displays.id = "archives";
    root.append(displays);
  }
  if (recordedSource) {
    const capture = recordedLayerMetadata(knowledge).capture;
    const archiveSection = node("section", "", "layer-archive-inventory");
    archiveSection.id = "archives";
    archiveSection.tabIndex = -1;
    archiveSection.append(node("h2", "Preserved data and metadata"), CatalogPreservationStatus({dataset}));
    const inventories = (knowledge?.document?.metadata?.normalized ?? []).filter(item => item.subject === "resource" && item.property === "https://opengeo.tools/ns/preservedDataInventory");
    const inventory = inventories.at(-1)?.value;
    if (inventory) {
      archiveSection.append(node("p", `Data linked to source revision ${inventory.sourceVersion}. Storage locations, recorded versions and available checksums identify the preserved files; opening this record does not download them.`, "layer-metadata-note"));
      for (const copy of inventory.captures ?? []) {
        const card = metadataCard(copy.kind === "historical-original" ? "Original archive files" : copy.kind === "recovered-provider-data" ? "Recovered provider data" : "Preserved provider copy", [
          ["Files", copy.files], ["Stored bytes", copy.bytes], ["Captured features", copy.featureCount],
          ["Bucket", copy.object?.bucket ?? copy.manifest?.bucket ?? copy.objects?.[0]?.bucket],
          ["Capture date", copy.capturedAt], ["Current provider content equality", "Not established"]
        ]);
        card.append(jsonDetails("Exact storage versions and matching evidence", copy));
        archiveSection.append(card);
      }
    } else archiveSection.append(node("p", "A data preservation inventory is not linked. Captured provider metadata is separate from an archive of the data.", "layer-metadata-note"));
    root.append(archiveSection);
    root.append(metadataCard("Connection and preservation", [
      ["Current endpoint", recordedSource.sourceUrl],
      ["Connection access", recordedSource.credentialMode === "none" ? "No credential configured; public reachability requires a check" : recordedSource.credentialMode],
      ["Connection validation", recordedSource.verificationState === "syntax_only" ? "Address syntax only; not an availability check" : recordedSource.verificationState],
      ["First encounter", "Not established by this record"],
      ["Captured metadata", capture?.original ? `S3 · ${capture.original.bucket} · exact version retained` : null]
    ], "Historical captures, connection revisions and current availability are separate observations. Opening this page does not contact the provider or download an archive."));
    if (adapter.listSourceRevisions) root.append(lazyPanel("Connection history", async () => {
      const revisions = await adapter.listSourceRevisions(dataset.projectId, dataset.id, {limit: 100});
      const section=node("section");section.append(node("p", "Recorded connection changes; earlier first encounters may predate registration. A changed URL is not proof that a provider migrated its hosting."));
      for (const revision of revisions) section.append(metadataCard(`Revision ${revision.versionNumber}`, [["Recorded",revision.createdAt],["Endpoint",revision.sourceUrl],["Change",revision.changeMessage]]));
      return section;
    }));
    if (adapter.listLayerArchives) root.append(lazyPanel("Archive copies and verification", async () => {
      const result=await adapter.listLayerArchives(dataset.projectId,dataset.id);
      if(result.dataset_id!==dataset.id || result.source_version!==recordedSource.versionNumber) throw Error("Archive source identity changed");
      const section=node("section");section.append(node("p", "Reviewed map copies listed from the catalog. This inspection reads no S3 data. Original preservation can exist separately from a map-ready copy."));
      if(!result.archives.length)section.append(node("p", "No reviewed map copy is available for this connection revision."));
      for(const archive of result.archives){const card=metadataCard(archive.title,[["Capture date",archive.captured_at],["Format",archive.format],["Features",archive.feature_count],["Stored bytes",archive.download_bytes]]);card.append(jsonDetails("Capture, matching and verification evidence",archive.provenance),jsonDetails("Representation rights",archive.rights));section.append(card);}
      return section;
    }));
  }
  root.append(link("Manage dataset access and reuse", projectHref(dataset.projectId, {
    adapterKind: adapter.kind, management: "data", datasetId: dataset.id
  })));
  if (dataset.capabilities?.managePermissions && ["listDatasetPermissions", "putDatasetPermission", "deleteDatasetPermission"]
    .every(method => typeof adapter[method] === "function")) {
    const access = DatasetAccess({adapter, dataset, accountId, accountRole});
    const disposeBeforeAccess = root.dispose;
    root.dispose = () => {disposeBeforeAccess?.(); access.dispose();};
    root.append(access);
  }

  const reuse = layerReuse({dataset, adapter, projects, projectsLoaded, accountRole, accountId});
  const disposeBeforeReuse = root.dispose;
  root.dispose = () => {disposeBeforeReuse?.(); reuse.dispose?.();};
  root.append(reuse);

  const rights = node("section");
  rights.append(node("h2", "Rights and source"), node("p", "License, redistribution, cache and mirror permissions belong in the resource knowledge record below. Access alone does not establish them."));
  if (REMOTE_SOURCES.has(dataset.sourceType)) {
    rights.append(node("p", "A registered external connection references its provider. Any hosted copies have their own version lineage."));
    rights.append(lazyPanel("Inspect registered connection", async () => {
      const source = recordedSource ?? await adapter.getSource(dataset.projectId, dataset.id);
      if (disposed) throw new Error("Layer inspection is closed");
      if (source.datasetId !== dataset.id || source.projectId !== dataset.projectId) throw new Error("Source identity changed");
      const section = node("section");
      if (source.sourceType === "postgis") {
        const configuration = source.configuration;
        section.append(node("h3", "Registered database relation"),
          node("p", `${configuration.schema}.${configuration.relation} · ${configuration.geometryColumn} · Key: ${configuration.stableKey}`),
          node("p", `Source revision ${source.versionNumber} · Connection revision ${configuration.connectionRevision}`),
          node("p", `Source identity: ${source.sourceUrl}`),
          node("p", "The database connection supplies authorized bounded views. Its credentials are not available in this page."),
          jsonDetails("Registered relation configuration", configuration));
        return section;
      }
      section.append(node("h3", "Registered source configuration"),
        node("p", "This is the saved connection configuration, not an original provider metadata response."),
        node("p", `Revision ${source.versionNumber} · ${source.verificationState}`),
        node("p", `Current endpoint: ${source.sourceUrl}`),
        node("p", `Recorded attribution: ${source.configuration?.attribution || "Not recorded"}`),
        node("p", recordedLayerMetadata(knowledge).capture?.sourceUrl ? `Endpoint in captured metadata: ${recordedLayerMetadata(knowledge).capture.sourceUrl}` : "Original endpoint: not identified separately in this record."),
        jsonDetails("Connection configuration", source.configuration));
      const url = new URL(source.sourceUrl);
      if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash) {
        const provider = link("Open provider", url.href);
        provider.target = "_blank"; provider.rel = "noopener noreferrer";
        section.append(provider);
      }
      sourceInspector=SourceDetails({source,dataset,
        onRetainMetadata:dataset.capabilities?.edit ? metadata=>resourceKnowledge.stageSourceMetadata(metadata) : undefined});
      section.append(sourceInspector);
      return section;
    }));
  } else {
    rights.append(node("p", "Custody relationship: not classified in this record. Inspect version lineage for recorded uploads, copies and derivatives."));
  }
  if (["arcgis", "wfs"].includes(dataset.sourceType)) {
    rights.append(lazyPanel("Inspect preserved discovery response", () => DiscoveryMetadata({adapter,datasetId:dataset.id})));
  }
  root.append(rights);
  const metadata = node("section");
  metadata.append(node("h2", "Metadata"),
    node("p", "The catalog fields above are recorded OpenGeo Studio facts. Original provider responses, curated assertions and machine inferences are not interchangeable."),
    jsonDetails("Recorded catalog fields", dataset));
  const governedMetadata = LayerGovernedMetadata({adapter, datasetId: dataset.id, accountId});
  root.append(metadata, governedMetadata, resourceKnowledge);
  if (dataset.sourceType === "upload" && dataset.status === "active" && dataset.capabilities?.edit
      && adapter.createDatasetRefreshReview && adapter.acceptDatasetRefreshReview) {
    const capture = ["getDatasetVersionLineage", "getProtectedCopy", "getSource", "createExternalSourceCopyEstimate", "createProtectedCopy"].every(key => typeof adapter[key] === "function")
      ? CaptureRefresh({adapter, dataset}) : null;
    if (capture) root.append(capture);
    const refresh = DatasetRefresh({adapter, dataset});
    const disposeEarlier = root.dispose;
    root.dispose = () => {disposeEarlier?.(); refresh.dispose(); capture?.dispose();};
    root.append(refresh);
  }
  const versionFiles=[];
  const disposeBeforeFiles=root.dispose;
  root.dispose=()=>{disposeBeforeFiles?.();for(const files of versionFiles)files.dispose();};
  root.append(lazyPanel("Inspect versions, schema and provenance", async () => {
    const versions = await adapter.listDatasetVersions(dataset.projectId, dataset.id, {limit: 100});
    const section = node("section");
    section.append(node("h2", "Data versions"), node("p", versions.length === 100
      ? "Showing the first 100 versions. Additional history may exist."
      : `${versions.length} recorded data versions. Connection revisions are tracked separately.`));
    section.append(DatasetVersionComparison({versions}));
    for (const version of versions) {
      const item = node("section");
      item.append(node("h3", `Version ${version.versionNumber}${version.current ? " · current" : ""}`),
        node("p", `${version.state} · ${version.createdAt}`),
        node("p", version.changeMessage || "No change description recorded."),
        jsonDetails("Attribute schema", version.schemaDefinition),
        jsonDetails("Quality observations", version.qualityResults));
      const files=DatasetVersionFiles({adapter,dataset,version});versionFiles.push(files);item.append(files);
      item.append(lazyPanel(`Inspect lineage for version ${version.versionNumber}`, async () => {
        const lineage = await adapter.getDatasetVersionLineage(dataset.projectId, dataset.id, version.id);
        if (lineage.datasetId !== dataset.id || lineage.versionId !== version.id) throw new Error("Lineage identity changed");
        return jsonDetails("Recorded lineage", lineage, true);
      }));
      section.append(item);
    }
    return section;
  }));
  const disposeBeforeMetadata=root.dispose;
  root.dispose=()=>{disposed=true;disposeBeforeMetadata?.();sourceInspector?.dispose();resourceKnowledge.dispose();governedMetadata.dispose();};
  return root;
}

function layerReuse({dataset, adapter, projects, projectsLoaded, accountRole, accountId}) {
  const section = node("section", "", "layer-resource-reuse");
  section.append(node("h2", "Use in a project"));
  if (!dataset.capabilities?.managePermissions || typeof adapter.attachDataset !== "function") {
    section.append(node("p", "Dataset sharing permission is required to add this resource to another project."));
    return section;
  }
  const pageSize = 100, maximumOffset = 10_000;
  const initialProjects = projectsLoaded ? projects : [];
  let offset = initialProjects.length, hasMore = typeof adapter.listProjects === "function"
    && (!projectsLoaded || (projects.length === pageSize && adapter.kind !== "fixture"));
  let loadingMore = false, attaching = false, disposed = false, accountChanged = false;
  const controller = new AbortController();
  section.dispose = () => {disposed = true; controller.abort();};
  const seen = new Set(), targets = [];
  const label = node("label", "Project ");
  const select = node("select");
  appendProjects(initialProjects);
  label.append(select);
  const status = node("p", "Adds a reference to this resource. The project's access rules apply; data and metadata stay shared.");
  status.setAttribute("role", "status");
  const pageStatus = node("p");
  pageStatus.setAttribute("role", "status");
  const destination = node("div");
  const add = button("Add resource to project", async () => {
    if (attaching || disposed || !targets.length || accountChanged) return;
    const projectId = select.value;
    attaching = true;
    updateControls();
    try {
      if (!await inCurrentAccount()) return;
      destination.replaceChildren();
      status.textContent = "Adding resource reference…";
      const result = await adapter.attachDataset(projectId, dataset.id);
      if (!await inCurrentAccount()) return;
      if (result.id !== dataset.id || result.projectId !== projectId) throw new Error("Resource reference changed");
      status.textContent = "Resource available in this project. Its identity, metadata and source are shared; configure its map presentation in the project.";
      destination.append(link("Open project data", projectHref(projectId, {adapterKind: adapter.kind,
        management: "data", datasetId: dataset.id})));
    } catch {
      if (!await inCurrentAccount()) return;
      status.textContent = "The resource could not be attached. Check your dataset sharing and project edit access, then retry.";
    } finally {attaching = false; if (!disposed) updateControls();}
  });
  const more = button(projectsLoaded ? "Load more projects" : "Load projects", async () => {
    if (loadingMore || attaching || disposed || accountChanged || !hasMore || offset > maximumOffset) return;
    loadingMore = true;
    pageStatus.textContent = projectsLoaded ? "Loading more projects…" : "Loading projects…";
    updateControls();
    try {
      if (!await inCurrentAccount()) return;
      const page = await adapter.listProjects({limit: pageSize, offset, signal: controller.signal});
      if (!await inCurrentAccount()) return;
      appendProjects(page);
      projectsLoaded = true;
      if (!targets.length) select.options[0].textContent = "No editable projects loaded";
      offset += page.length;
      hasMore = page.length === pageSize && adapter.kind !== "fixture";
      pageStatus.textContent = projectSummary();
    } catch {
      if (!await inCurrentAccount()) return;
      pageStatus.textContent = projectsLoaded
        ? "More projects could not load. Your selection is kept. Choose Load more projects to retry."
        : "Projects could not load. Choose Load projects to retry.";
    } finally {loadingMore = false; if (!disposed) updateControls();}
  });
  const controls = node("div", "", "platform-controls");
  controls.append(label, add, more);
  section.append(controls, pageStatus, status, destination,
    link("Browse projects", directoryHref({adapterKind: adapter.kind})));
  pageStatus.textContent = projectSummary();
  updateControls();
  return section;

  function appendProjects(page) {
    for (const project of page) {
      if (seen.has(project.id)) continue;
      seen.add(project.id);
      if (project.status !== "active"
          || !(accountRole === "admin" || ["owner", "editor"].includes(project.callerRole))) continue;
      if (!targets.length) select.replaceChildren();
      targets.push(project);
      const option = node("option", project.name); option.value = project.id; select.append(option);
    }
    if (!targets.length && !select.options.length) {
      const option = node("option", projectsLoaded ? "No editable projects loaded" : "Load projects to choose a destination");
      option.value = ""; select.append(option);
    }
  }

  function projectSummary() {
    if (!projectsLoaded) return hasMore ? "Projects have not been loaded. Choose Load projects to pick an editable project."
      : "Projects have not been loaded. Browse projects to choose a destination.";
    const summary = targets.length ? `${targets.length} editable projects loaded.` : "No editable projects are loaded for this account.";
    if (hasMore && offset > maximumOffset) return `${summary} The project list limit has been reached. Open another project's data catalog to add this resource.`;
    return `${summary}${hasMore ? " Load more to see additional projects." : ""}`;
  }

  function updateControls() {
    select.disabled = add.disabled = attaching || accountChanged || !targets.length;
    more.disabled = loadingMore || attaching || accountChanged;
    more.hidden = !hasMore || offset > maximumOffset;
    more.textContent = projectsLoaded ? "Load more projects" : "Load projects";
    more.setAttribute("aria-busy", String(loadingMore));
  }

  async function inCurrentAccount() {
    if (disposed) return false;
    const selected = typeof adapter.organizationProvider === "function" ? await adapter.organizationProvider()
      : adapter.selectedOrganizationId;
    if (disposed) return false;
    if (accountId && selected !== undefined && selected !== accountId) {
      accountChanged = true;
      controller.abort();
      pageStatus.textContent = "The selected account changed. Reload this Layer to choose a project.";
      updateControls();
    }
    return !accountChanged;
  }
}

function lazyPanel(label, load) {
  const section = node("section", "", "layer-resource-inspection");
  const content = node("div"); content.hidden = true;
  let loaded = false;
  const toggle = button(label, async () => {
    content.hidden = !content.hidden;
    toggle.setAttribute("aria-expanded", String(!content.hidden));
    if (content.hidden) return;
    if (loaded) {content.querySelector(".map-frame")?.__resize?.(); return;}
    toggle.disabled = true;
    const status = node("p", "Loading…"); status.setAttribute("role", "status");
    content.replaceChildren(status);
    try {content.replaceChildren(await load()); loaded = true;}
    catch {status.textContent = "This information could not load or is not available to your role. Close and reopen to retry.";}
    finally {toggle.disabled = false;}
  });
  toggle.setAttribute("aria-expanded", "false");
  section.append(toggle, content);
  return section;
}
function node(tag, value = "", className = "") {const result = document.createElement(tag); result.textContent = value; result.className = className; return result;}
function link(label, href) {const result = node("a", label, "platform-button secondary"); result.href = href; return result;}
function button(label, handler) {const result = node("button", label, "platform-button secondary"); result.type = "button"; result.addEventListener("click", handler); return result;}
function jsonDetails(label, value, open = false) {const result = node("details"); result.open = open; result.append(node("summary", label), node("pre", JSON.stringify(value ?? null, null, 2))); return result;}
