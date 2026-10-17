import {AuthoredResourceMetadata, guardAuthoredMetadata} from "./AuthoredResourceMetadata.js";
import {StudioNavigation} from "./StudioNavigation.js";
import {modeBanner, platformStatePanel} from "./PlatformDirectory.js";
import {loadProjectContext} from "../lib/platform.js";
import {retainedProjectScope, retainedPublicationScope, retainedPublicationIdentity, retainedEditorIdentityStatus, revalidateRetainedPublication} from "../lib/retainedProjectScope.js";
import {mapServerTileUrl} from "../lib/mapServer.js";
import {imageServerTileUrl} from "../lib/imageServer.js";
import {executeGeoLibreImport} from "../lib/geolibreImport.js";
import {createGeoLibreHandoff, reviewGeoLibreReturn} from "../lib/geolibreHandoff.js";
import {loadManagedVectorData} from "../lib/managedVectorRead.js";
import {ingestManagedFile} from "../lib/managedUpload.js";
import {createManagedAnalysisRegistration} from "../lib/managedAnalysisRegistration.js";
import {emptyMapDefinition} from "../lib/mapDefinition.js";
import {definitionForPrintFrame, projectPrintLayouts} from "../lib/printLayouts.js";
import {
  loadWithWakeRetry,
  platformStartupMessage
} from "../lib/platformLoadRetry.js";
import {
  directoryHref,
  compositionHref,
  projectHref,
  PROJECT_SURFACES
} from "../lib/applicationRoutes.js";

const PROJECT_SECTIONS = [
  ["maps", "Maps"],
  ["data", "Data"],
  ["discussions", "Discussions"],
  ["resources", "Resources"],
  ["services", "Services"],
  ["print", "Print"],
  ["settings", "Settings"]
];

function loadProjectSurfaceModule(surface) {
  switch (surface) {
    case "data": return import("./ProjectDatasets.js");
    case "discussions": return import("./ProjectDiscussions.js");
    case "resources": return import("./ProjectResources.js");
    case "services": return import("./ProjectServices.js");
    case "publishing": return import("./ProjectSites.js");
    case "print": return Promise.all([import("./ProjectPrintStudio.js"), import("./WorkbenchView.js")])
      .then(([print, workbench]) => ({...print, ...workbench}));
    case "settings": return import("./ProjectLifecycleSettings.js");
    default: return import("./WorkbenchView.js");
  }
}

export function ProjectWorkspacePage({
  adapter,
  projectId,
  compositionId = null,
  publicationId = null,
  mapId = null,
  catalog = null,
  previewSources = new Map(),
  mapFontAttachments = null,
  auth = null,
  startPanel = null,
  startBlank = false,
  managementTarget = null,
  selectedDatasetId = null,
  featureTarget = null,
  mapDatasetTarget = null,
  siteResourceTarget = null,
  onPublicationMapExport = null,
  isCancelled = () => false
}) {
  const root = document.createElement("section");
  root.className = "platform-workspace";
  // Narrow status regions announce progress without reading the entire editor.
  const metadataGuard = guardAuthoredMetadata(root);
  const projectMetadata = new Map();
  const activeProjectSurface = publicationId ? "publishing" : PROJECT_SURFACES.includes(managementTarget)
    ? managementTarget
    : null;
  let importNotice = null;
  let workbench = null;
  let workbenchKey = null;
  let readyState = null;
  let publicationIdentity = null;
  let disposed = false;
  let startup = null;
  let startupNotice = null;
  let startupDeadline = null;
  let workbenchModule = null;
  let durableJobGeneration = 0;
  let durableJobRequest = null;
  root.dispose = () => {
    disposed = true;
    publicationIdentity = null;
    durableJobGeneration++;
    startup?.abort();
    clearTimeout(startupNotice);
    clearTimeout(startupDeadline);
    root.querySelector(".project-print-studio")?.dispose?.();
    root.querySelector(".project-lifecycle-settings")?.dispose?.();
    workbench?.dispose?.();
    metadataGuard.dispose();
  };
  root.openPublicationMapExport = () => root.isPublicationMapExportReady()
    && workbench?.openPublicationMapExport?.() === true;
  root.isPublicationMapExportReady = () => !disposed && !metadataGuard.check()
    && workbench?.isPublicationMapExportReady?.() === true;
  root.saveDraftForSignIn = () => !disposed && !metadataGuard.check()
    && workbench?.saveDraftForNavigation?.() === true;
  const checkRetainedAccess = async ({signal}) => {
    root.resumeStatus = null;
    if (publicationId) {
      const expected = retainedPublicationScope(readyState);
      if (disposed || !expected) return false;
      const state = await revalidateRetainedPublication(adapter, readyState, publicationIdentity, {signal});
      if (!disposed && !signal.aborted) root.resumeStatus = state.status;
      return !disposed && !signal.aborted && expected === retainedPublicationScope(state);
    }
    const expected = retainedProjectScope(readyState);
    if (disposed || !compositionId || !workbench || !expected) return false;
    if (publicationIdentity) {
      const mismatch = await retainedEditorIdentityStatus(adapter, publicationIdentity);
      if (mismatch) {root.resumeStatus = mismatch; workbench.releaseRendererCredentials?.(); return false;}
    }
    const state = await loadProjectContext(adapter, projectId, mapId, {
      surface: "maps", compositionId, signal, revalidateOnly: true,
      ...(publicationIdentity ? {retainedDirectory: readyState, retainedIdentity: publicationIdentity} : {})
    });
    const mismatch = publicationIdentity && await retainedEditorIdentityStatus(adapter, publicationIdentity);
    if (mismatch) {
      root.resumeStatus = mismatch; workbench.releaseRendererCredentials?.(); return false;
    }
    if (!disposed && !signal.aborted) root.resumeStatus = state.status;
    const allowed = !disposed && !signal.aborted && expected === retainedProjectScope(state);
    if (!disposed && !signal.aborted && !allowed) workbench.releaseRendererCredentials?.();
    return allowed;
  };
  root.canResume = async options => await checkRetainedAccess(options)
    && (publicationId || await workbench.resumeRenderer?.() !== false);
  root.retainedDirectoryContext = () => !disposed && readyState?.status === "ready" && publicationIdentity
    ? {directory: readyState, identity: publicationIdentity} : null;
  const protectedCopyJobs = [];
  const pmtilesDerivativeJobs = [];
  let protectedCopyJobScope = null;
  let pmtilesDerivativeJobScope = null;
  let durableJobsMessage = null;
  renderLoading();
  void refresh();
  return root;

  async function refresh() {
    if (disposed || isCancelled() || metadataGuard.check()) return;
    durableJobGeneration++;
    durableJobRequest = null;
    startup?.abort();
    clearTimeout(startupNotice);
    clearTimeout(startupDeadline);
    const controller = new AbortController();
    startup = controller;
    const cancelled = () => disposed || isCancelled() || controller.signal.aborted;
    // Download only the selected surface, alongside its authorization reads.
    // Importing code does not construct tools or load private/provider content.
    const surfaceModule = loadProjectSurfaceModule(activeProjectSurface).catch(() => null);
    const showBlockingLoading = !workbench?.isConnected;
    if (showBlockingLoading) renderLoading();
    else root.dataset.refreshState = "loading";
    const slowNotice = startupNotice = showBlockingLoading
      ? setTimeout(() => renderLoading(
          startupMessage()
        ), 1_200)
      : null;
    startupDeadline = setTimeout(() => {
      if (cancelled()) return;
      controller.abort();
      clearTimeout(slowNotice);
      root.replaceChildren(
        projectRouteBar(adapter?.kind, activeProjectSurface === "publishing" ? "publishing" : "projects"),
        platformStatePanel({status: "error", code: "workspace_load_timeout", retryable: true, adapter}, refresh, {auth})
      );
    }, 90_000);
    const publicationOpeningIdentity = publicationId || compositionId ? await retainedPublicationIdentity(adapter) : null;
    if (cancelled()) return;
    const state = await loadWithWakeRetry(
      () => loadProjectContext(adapter, projectId, mapId, {
        surface: activeProjectSurface ?? "maps", compositionId, publicationId, signal: controller.signal
      }),
      {
        signal: controller.signal,
        onRetry: () => {
          if (!cancelled() && !workbench?.isConnected) renderLoading(startupMessage());
        }
      }
    );
    const module = await surfaceModule;
    if (slowNotice) clearTimeout(slowNotice);
    clearTimeout(startupDeadline);
    if (cancelled()) return;
    delete root.dataset.refreshState;
    if (state.status !== "ready") {
      readyState = null;
      workbench = null;
      workbenchKey = null;
      root.replaceChildren(
        projectRouteBar(adapter?.kind, activeProjectSurface === "publishing" ? "publishing" : "projects"),
        modeBanner(adapter),
        platformStatePanel(state, refresh, {auth, autoSignIn: true, resourceKind: publicationId ? "publication" : "project"})
      );
      return;
    }
    if (publicationId || compositionId) {
      publicationIdentity = await retainedPublicationIdentity(adapter);
      if (cancelled()) return;
      if (publicationOpeningIdentity && (publicationOpeningIdentity.token !== publicationIdentity?.token
        || publicationOpeningIdentity.tokenProvider !== publicationIdentity?.tokenProvider
        || publicationOpeningIdentity.organizationProvider !== publicationIdentity?.organizationProvider
        || publicationOpeningIdentity.baseUrl !== publicationIdentity?.baseUrl
        || publicationIdentity?.organization !== state.organization.id)) {
        publicationIdentity = null;
        root.replaceChildren(projectRouteBar(adapter?.kind, publicationId ? 'publishing' : 'projects'),
          platformStatePanel({status: 'forbidden', code: 'editor_context_changed', adapter}, refresh, {auth}));
        return;
      }
    }
    projectId = state.project.id;
    if (!module) {
      root.replaceChildren(projectRouteBar(adapter?.kind, activeProjectSurface === "publishing" ? "publishing" : "projects"),
        platformStatePanel({status: "error", code: "workspace_interface_unavailable", retryable: true, adapter}, refresh, {auth}));
      return;
    }
    if (activeProjectSurface === "print" && (compositionId || mapId) && state.selectedMap) {
      readyState = state;workbenchModule = module;
      const makeWorkbench = frame => {
        workbench?.dispose?.();
        const definition = frame ? definitionForPrintFrame(state.selectedMap, frame) : structuredClone(state.selectedMap.definition);
        definition.extensions = {...definition.extensions, opengeoRenderer: {id: "maplibre"}};
        const printState = {...state, selectedMap: {...state.selectedMap, definition}};
        const input = prepareWorkbenchInput(printState);
        input.savedProjectOrigin = {id: state.selectedMap.id, version: state.selectedMap.version, definition: structuredClone(state.selectedMap.definition)};
        // A new layout starts with the saved Layers' current browser presentation.
        // Keep Print edits in their own draft; saved frame settings stay authoritative.
        input.restoreDraftScopeId = input.draftScopeId;
        input.restoreBrowserDraft = frame ? false : "presentation";input.draftScopeId += ":print";
        workbench = buildWorkbench(printState, input, true);
        workbench.style.height = "100%";workbench.style.minHeight = "0";
        return workbench;
      };
      let initialFrame = null;
      try {initialFrame = projectPrintLayouts(state.selectedMap).layouts[0]?.frames[0] ?? null;} catch { /* The editor retains and reports unsupported saved layout metadata. */ }
      const print = module.ProjectPrintStudio({state, workbench: makeWorkbench(initialFrame), editFrame: makeWorkbench,
        canSave: canEdit(state) && typeof adapter.updateMap === "function", onSaved: saved => {
          state.selectedMap = saved;
          const index = state.maps.findIndex(map => map.id === saved.id);if (index >= 0) state.maps.splice(index, 1, saved);
        }});
      root.replaceChildren(projectRouteBar(adapter.kind), ...[adapter.kind === "fixture" ? modeBanner(adapter) : null].filter(Boolean), projectSections(state, "print"), print);
      revealProjectTarget();return;
    }
    if (activeProjectSurface) {
      readyState = state;
      workbench = null;
      workbenchKey = null;
      root.replaceChildren(
        projectRouteBar(adapter?.kind, activeProjectSurface === "publishing" ? "publishing" : "projects"),
        modeBanner(adapter),
        ...[projectWarningNotice(state)].filter(Boolean),
        projectApplicationSurface(
          state,
          refresh,
          activeProjectSurface,
          featureTarget,
          siteResourceTarget,
          module
        )
      );
      revealProjectTarget();
      return;
    }
    if (!state.selectedMap) {
      readyState = state;
      workbench = null;
      workbenchKey = null;
      root.replaceChildren(
        projectRouteBar(adapter?.kind),
        modeBanner(adapter),
        ...[projectWarningNotice(state)].filter(Boolean),
        projectHeader(state),
        projectSections(state, "maps"),
        emptyMaps(state, refresh)
      );
      revealProjectTarget();
      return;
    }
    readyState = state;
    workbenchModule = module;
    const input = prepareWorkbenchInput(state);
    const initialJobs = onPublicationMapExport ? null
      : hydrateDurableJobs(state, activeDurableJobSelection(input, state.sources, workbenchModule));
    if (cancelled()) return;
    const nextWorkbenchKey = [
      state.project.id,
      state.selectedMap.id,
      state.selectedMap.version,
      adapter.kind,
      state.organization.callerRole,
      state.project.callerRole,
      startBlank ? "blank" : "persistent",
      state.datasets
        .map(({id, sourceType, format, status, currentVersionId, currentVersionState}) => (
          `${id}@${sourceType}:${format}:${status}:${currentVersionId ?? "none"}:${currentVersionState ?? "none"}`
        ))
        .sort()
        .join(","),
      state.sources.map(({datasetId, versionNumber}) => `${datasetId}@${versionNumber}`).sort().join(","),
      state.basemapConnectionBindings
        .map(({id, connection}) => `${id}@${connection.credentialRevision}:${connection.status}`)
        .sort()
        .join(","),
      mapDatasetTarget
        ? `${mapDatasetTarget.mapId}@${mapDatasetTarget.datasetId}@${mapDatasetTarget.datasetVersionId}`
        : "no-dataset-handoff"
    ].join(":");
    const preserveWorkbench = workbench?.isConnected && workbenchKey === nextWorkbenchKey;
    if (!preserveWorkbench) {
      workbench = buildWorkbench(state, input);
      workbench.id = "map-workspace";
      workbenchKey = nextWorkbenchKey;
    }
    const banner = modeBanner(adapter);
    const projectWarning = projectWarningNotice(state);
    if (onPublicationMapExport) {
      root.replaceChildren(...[projectWarning].filter(Boolean), workbench);
      return;
    }
    const notice = importNotice ? text("p", importNotice, "platform-import-notice") : null;
    const sections = projectSections(state, "maps");
    let metadataPanel = null;
    if (compositionId && typeof adapter.getAuthoredKnowledge === "function") {
      const id = state.selectedMap.id;
      if (!projectMetadata.has(id)) projectMetadata.set(id, AuthoredResourceMetadata({adapter, kind:"project", id}));
      metadataPanel = projectMetadata.get(id);
      const savedLayers = state.selectedMap.definition?.layers;
      const referenced = new Set((Array.isArray(savedLayers) ? savedLayers : []).map(layer => layer.datasetId));
      metadataPanel.updateProjectContext({map: state.selectedMap,
        datasets: state.datasets.filter(dataset => referenced.has(dataset.id)),
        sources: state.sources.filter(source => referenced.has(source.datasetId))});
    }
    if (preserveWorkbench) {
      for (const child of [...root.children]) {
        if (child !== workbench) child.remove();
      }
      root.insertBefore(banner, workbench);
      if (projectWarning) root.insertBefore(projectWarning, workbench);
      root.insertBefore(sections, workbench);
      if (metadataPanel) root.insertBefore(metadataPanel, workbench);
      if (notice) root.append(notice);
      if (typeof workbench.__opengeoRefreshDurableJobsView === "function") {
        workbench.__opengeoRefreshDurableJobsView({message: durableJobsMessage});
      } else {
        workbench.dispatchEvent(new workbench.ownerDocument.defaultView.Event("workbench:render"));
      }
    } else {
      root.replaceChildren(
        banner,
        ...[projectWarning].filter(Boolean),
        sections,
        ...[metadataPanel].filter(Boolean),
        workbench,
        ...[notice].filter(Boolean)
      );
    }
    revealProjectTarget();
    if (initialJobs) {
      const initialWorkbench = workbench;
      const generation = durableJobGeneration;
      void initialJobs.then(({message}) => {
        if (cancelled() || generation !== durableJobGeneration || workbench !== initialWorkbench) return;
        workbench.__opengeoRefreshDurableJobsView?.({message});
      });
    }
  }

  function projectWarningNotice(state) {
    if (!state.projectWarnings?.length) return null;
    const labels = state.projectWarnings.map(({label}) => label).join(", ");
    const notice = document.createElement("aside");
    notice.className = "platform-project-warning";
    notice.dataset.state = "partial";
    notice.setAttribute("role", "status");
    notice.append(
      text("strong", "Some project tools are temporarily unavailable."),
      text("span", ` Your project and maps remain available. Retry later to load: ${labels}.`)
    );
    return notice;
  }

  function revealProjectTarget() {
    const explicit = selectedDatasetId && activeProjectSurface === "data"
      ? `.project-dataset-card[data-dataset-id="${cssEscape(selectedDatasetId)}"]`
      : siteResourceTarget && activeProjectSurface === "publishing"
        ? "#project-sites"
      : activeProjectSurface
        ? `#project-${activeProjectSurface}`
        : globalThis.location?.hash;
    if (!explicit || explicit === "#map-workspace") return;
    queueMicrotask(() => {
      const target = root.querySelector(explicit);
      if (!target) return;
      if (selectedDatasetId || siteResourceTarget) {
        target.classList.add("project-route-target");
        target.tabIndex = -1;
        target.focus({preventScroll: true});
      }
      target.scrollIntoView?.({block: "start"});
    });
  }

  function startupMessage() {
    return publicationId ? "Loading your publication and saved draft…" : platformStartupMessage("project");
  }

  function renderLoading(message = publicationId ? "Checking access to your publication…" : "Resolving membership, project, and persistent maps…") {
    const loading = document.createElement("section");
    loading.className = "platform-state platform-state-loading";
    loading.dataset.state = "loading";
    loading.setAttribute("aria-busy", "true");
    const title = text("h2", publicationId ? "Loading publication" : "Loading project");
    const progress = document.createElement("progress");
    progress.setAttribute("aria-label", title.textContent);
    progress.style.width = "100%";
    const status = text("p", message);
    status.setAttribute("role", "status");
    loading.append(title, progress, status);
    root.replaceChildren(projectRouteBar(adapter?.kind, activeProjectSurface === "publishing" ? "publishing" : "projects"), loading);
  }

  function prepareWorkbenchInput(state) {
    const input = adapter.kind === "fixture"
      ? fixtureWorkbenchInput(state, catalog, previewSources)
      : apiWorkbenchInput(state);
    input.savedProjectOrigin = {id: state.selectedMap.id, version: state.selectedMap.version, definition: structuredClone(state.selectedMap.definition)};
    input.project = {...input.project, mapId: state.selectedMap.id, name: state.selectedMap.name};
    input.draftScopeId = `${state.organization.id}:${state.session.userId}:${state.selectedMap.id}`;
    if (startBlank) {
      input.layers = [];
      input.geojsonByLayerId = new Map();
      input.project = {
        ...input.project,
        activeLayerId: null,
        layers: [],
        bookmarks: [],
        mapViews: [{id: "default", title: "Default", center: [0, 20], zoom: 2, pitch: 0, bearing: 0}]
      };
    }
    return input;
  }

  function buildWorkbench(state, input = prepareWorkbenchInput(state), printPreview = false) {
    const {WorkbenchView} = workbenchModule;
    if (onPublicationMapExport) return WorkbenchView({
      ...input, role: "viewer", persistenceMode: adapter.kind, styleAdapter: adapter,
      canResumeRenderer: () => checkRetainedAccess({signal: AbortSignal.timeout(20_000)}),
      restoreBrowserDraft: false,
      project: {...input.project, name: state.selectedMap.name ?? state.project.name},
      mapVersion: state.selectedMap.version, mapFontAttachments, onPublicationMapExport,
      canRequestProjectCompute: false,
      connectionBindings: state.datasetConnectionBindings,
      basemapConnectionBindings: state.basemapConnectionBindings,
      resolveBasemapStyle: typeof adapter.resolveProjectBasemapStyle === "function"
        ? (id, flavor) => adapter.resolveProjectBasemapStyle(state.project.id, id, flavor) : null,
      loadDatasetFeatures: typeof adapter.listFeatures === "function"
        ? id => adapter.listFeatures(state.project.id, id, {limit: 100}) : null,
      loadDatasetVersionPreview: typeof adapter.getDatasetSpatialPreview === "function"
        ? (id, version) => adapter.getDatasetSpatialPreview(state.project.id, id, version) : null,
      queryDatasetFeatures: typeof adapter.queryFeatures === "function"
        ? (id, query, options) => adapter.queryFeatures(state.project.id, id, query, options) : null
    });
    let currentMap = state.selectedMap;
    const durableRoutes = durableJobRoutes(state);
    const archiveScope = [state.session.userId, state.organization.id, state.project.id];
    const assertArchiveScope = async () => {
      if (!root.isConnected || await adapter.organizationProvider() !== archiveScope[1]
        || state.session.userId !== archiveScope[0]) throw Error("The signed-in account or workspace changed.");
    };
    const authorizeArchive = async () => {
      await assertArchiveScope();
      if ((await adapter.getSession()).userId !== archiveScope[0]) throw Error("The signed-in account or workspace changed.");
      await assertArchiveScope();
    };
    const archiveCall = async task => {await authorizeArchive(); const value = await task(); await authorizeArchive(); return value;};
    // Metadata endpoints authorize each request. Check editor scope around them
    // and revalidate the session at action boundaries instead of twice per row.
    const geoLibreCall = async task => {await assertArchiveScope(); const value = await task(); await assertArchiveScope(); return value;};
    const managedDatasetMetadataReads = new Map();
    const readDatasetMetadata = async (datasetId, signal) => {
      let dataset = state.datasets.find(item => item.id === datasetId);
      if (!dataset) {
        let pending = managedDatasetMetadataReads.get(datasetId);
        if (!pending) {
          pending = geoLibreCall(() => adapter.getDataset(state.project.id, datasetId, {signal: AbortSignal.timeout(20_000)}))
            .then(value => {
              if (disposed || value.id !== datasetId || value.projectId !== state.project.id)
                throw Error("The selected Layer's dataset metadata changed.");
              if (!state.datasets.some(item => item.id === datasetId)) state.datasets.push(value);
              return value;
            });
          managedDatasetMetadataReads.set(datasetId, pending);
          pending.catch(() => managedDatasetMetadataReads.delete(datasetId));
        }
        dataset = await pending;
      }
      signal?.throwIfAborted();
      return dataset;
    };
    // Reuse complete exact-version reads already made by this editor. Preview
    // subsets never qualify as analysis inputs for a round trip.
    const completeVectorReads = new Map();
    const readVector = async (datasetId, versionId, geometryType, signal) => {
      const key = `${datasetId}:${versionId}`;
      await assertArchiveScope();
      let dataset = state.datasets.find(item => item.id === datasetId);
      if (!dataset && typeof adapter.getDataset === "function") dataset = await readDatasetMetadata(datasetId, signal);
      if (!dataset) throw Error("Dataset metadata is required before loading its raw map preview.");
      if (dataset?.currentVersionState === "preserved" && dataset.currentVersionId === versionId)
        throw Error("This original is preserved without a raw map preview. Use its reviewed tiled display.");
      if (completeVectorReads.has(key)) {
        // Current metadata authorization also covers withdrawn historical pins;
        // never reread encrypted bytes merely to refresh this decision.
        let version;
        for (let offset = 0; offset < 1000; offset += 100) {
          const versions = await geoLibreCall(() => adapter.listDatasetVersions(state.project.id, datasetId, {limit: 100, offset}));
          version = versions.find(candidate => candidate.id === versionId);
          if (version || versions.length < 100) break;
        }
        if (version?.state !== "active") throw Error("The selected dataset version is unavailable.");
        return completeVectorReads.get(key);
      }
      const value = await loadManagedVectorData({adapter, projectId: state.project.id,
        datasetId, versionId, geometryType, signal,
        assertScope: assertArchiveScope, authorize: authorizeArchive});
      if (value.datasetVersionId === versionId && value.mayBeTruncated === false
        && value.numberReturned === value.numberMatched) completeVectorReads.set(key, value);
      return value;
    };
    const handoffInputs = async map => {
      const inputs = new Map();
      const layers = map.definition.layers.filter(layer => ["governed-dataset", "geojson-object"].includes(layer.sourceType));
      if (layers.length > 20) throw Error("Choose a Project with at most 20 managed vector Layers for this GeoLibre workflow.");
      const signal = AbortSignal.timeout(60_000);
      for (const layer of layers) {
        signal.throwIfAborted();
        if (!layer.datasetVersionId) throw Error("Save an exact dataset version for each managed vector Layer before opening GeoLibre.");
        const dataset = await geoLibreCall(() => adapter.getDataset(state.project.id, layer.datasetId));
        if (dataset.capabilities?.download !== true) throw Error("Download access is required for each managed vector input opened in GeoLibre.");
        const value = await readVector(layer.datasetId, layer.datasetVersionId, layer.geometryType, signal);
        if (value.datasetVersionId !== layer.datasetVersionId || value.mayBeTruncated !== false
          || value.numberReturned !== value.numberMatched) throw Error("GeoLibre requires the complete selected vector version; a preview cannot be used.");
        inputs.set(layer.layerId, {data: value.geojson, complete: true});
      }
      return inputs;
    };
    let geoLibreReview = null;
    let geoLibreReviewGeneration = 0;
    return WorkbenchView({
      ...input,
      canResumeRenderer: () => checkRetainedAccess({signal: AbortSignal.timeout(20_000)}),
      projectSwitcher: {
        initial: state.maps,
        load: () => adapter.listCompositions({limit: 100, signal: AbortSignal.timeout(20_000)})
      },
      styleAdapter: adapter,
      layerArchiveAccess: typeof adapter.listLayerArchives === "function" || typeof adapter.listManagedDisplays === "function" ? {
        assertScope: assertArchiveScope, authorize: authorizeArchive,
        list: (layer, signal) => archiveCall(() => layer.sourceType === "governed-dataset"
          ? adapter.listManagedDisplays(archiveScope[2], layer.datasetId, layer.datasetVersionId, {signal})
          : adapter.listLayerArchives(archiveScope[2], layer.datasetId, {signal})),
        read: (layer, id, signal) => archiveCall(() => layer.sourceType === "governed-dataset"
          ? adapter.readManagedDisplay(archiveScope[2], layer.datasetId, layer.datasetVersionId, id, {signal})
          : adapter.readLayerArchive(archiveScope[2], layer.datasetId, id, {signal}))
      } : null,
      onPublicationMapExport,
      mapFontAttachments,
      connectionBindings: state.datasetConnectionBindings,
      basemapConnectionBindings: state.basemapConnectionBindings,
      resolveBasemapStyle: typeof adapter.resolveProjectBasemapStyle === "function"
        ? (bindingId, flavor) => adapter.resolveProjectBasemapStyle(
            state.project.id,
            bindingId,
            flavor
          )
        : null,
      initialPanel: startPanel,
      initialDatasetTarget: mapDatasetTarget,
      startBlank,
      persistenceMode: adapter.kind,
      mapVersion: currentMap.version,
      canRequestProjectCompute: canEdit(state),
      protectedCopyJobs,
      pmtilesDerivativeJobs,
      initialDurableJobsMessage: durableJobsMessage,
      refreshDurableJobs: async (selection) => {
        if (!readyState) throw new Error("project_state_unavailable");
        return hydrateDurableJobs(readyState, selection);
      },
      registerSource: canEdit(state) && typeof adapter.createSource === "function"
        ? (metadata) => adapter.createSource(state.project.id, metadata)
        : null,
      startSourceDiscovery: canEdit(state) && typeof adapter.createSourceDiscovery === "function"
        ? (request) => adapter.createSourceDiscovery(state.project.id, request)
        : null,
      getSourceDiscovery: typeof adapter.getSourceDiscovery === "function"
        ? (jobId) => adapter.getSourceDiscovery(state.project.id, jobId)
        : null,
      estimateProtectedCopy: canEdit(state)
        && typeof adapter.createExternalSourceCopyEstimate === "function"
        ? (source, scope) => adapter.createExternalSourceCopyEstimate(
            state.project.id,
            source.datasetId,
            source.versionNumber,
            {sourceType: source.sourceType, scope}
          )
        : null,
      requestProtectedCopy: canEdit(state) && typeof adapter.createProtectedCopy === "function"
        ? (source, request) => adapter.createProtectedCopy(
            state.project.id,
            source.datasetId,
            source.versionNumber,
            request
          )
        : null,
      listProtectedCopies: durableRoutes.listProtectedCopies,
      cancelProtectedCopy: durableRoutes.cancelProtectedCopy,
      requestPmtilesDerivative: canEdit(state)
        && typeof adapter.createPmtilesDerivative === "function"
        ? (dataset, request) => adapter.createPmtilesDerivative(
            state.project.id,
            dataset.datasetId,
            dataset.currentVersionId,
            request
          )
        : null,
      listPmtilesDerivatives: durableRoutes.listPmtilesDerivatives,
      getPmtilesConversionCapabilities: typeof adapter.getPmtilesConversionCapabilities==='function'
        ? ()=>adapter.getPmtilesConversionCapabilities() : null,
      cancelPmtilesDerivative: durableRoutes.cancelPmtilesDerivative,
      reviewPmtilesDisplay: canEdit(state) && typeof adapter.getPmtilesDisplayReview === "function"
        ? job => archiveCall(() => adapter.getPmtilesDisplayReview(state.project.id, job.datasetId, job.datasetVersionId, job.jobId)) : null,
      admitPmtilesDisplay: canEdit(state) && typeof adapter.admitPmtilesDisplayReview === "function"
        ? (job, request) => archiveCall(() => adapter.admitPmtilesDisplayReview(state.project.id, job.datasetId, job.datasetVersionId, job.jobId, request)) : null,
      loadManagedDatasetMetadata: typeof adapter.getDataset === "function"
        ? async (datasetId, signal) => {
          const dataset = await readDatasetMetadata(datasetId, signal);
          signal.throwIfAborted();
          if (disposed || dataset.id !== datasetId || dataset.projectId !== state.project.id) throw Error("The selected Layer's dataset metadata changed.");
          if (!state.datasets.some(item => item.id === dataset.id)) state.datasets.push(dataset);
          return managedWorkbenchDataset(dataset);
        } : null,
      loadDatasetFeatures: typeof adapter.listFeatures === "function"
        ? (datasetId) => adapter.listFeatures(state.project.id, datasetId, {limit: 100})
        : null,
      loadDatasetVersionPreview: typeof adapter.getDatasetSpatialPreview === "function"
        ? (datasetId, versionId, geometryType) => readVector(datasetId, versionId, geometryType)
        : null,
      queryDatasetFeatures: typeof adapter.queryFeatures === "function"
        ? (datasetId, query, options) => adapter.queryFeatures(state.project.id, datasetId, query, options)
        : null,
      listQueryLocations: typeof adapter.listLocations === "function"
        ? page => archiveCall(() => adapter.listLocations(page)) : null,
      getQueryLocation: typeof adapter.getLocation === "function"
        ? (id, revision) => archiveCall(() => adapter.getLocation(id, revision)) : null,
      previewVectorAnalysis: typeof adapter.previewVectorAnalysis === "function"
        ? (datasetId, request, options) => adapter.previewVectorAnalysis(state.project.id, datasetId, request, options)
        : null,
      cancelVectorAnalysis: typeof adapter.cancelVectorAnalysis === "function"
        ? (datasetId, previewId, options) => adapter.cancelVectorAnalysis(state.project.id, datasetId, previewId, options)
        : null,
      createAnalysisRegistration: adapter.kind === "api" && canEdit(state)
        ? ({collection, review, onStage, assertCurrentScope}) => createManagedAnalysisRegistration({
            adapter, projectId: state.project.id, collection, review, onStage,
            assertCurrentScope: async () => {await assertCurrentScope(); await authorizeArchive();}
          })
        : null,
      getAnalysisCollection: typeof adapter.getFeatureCollection === "function"
        ? (datasetId, options) => adapter.getFeatureCollection(state.project.id, datasetId, options)
        : null,
      onProjectSaved: (savedMap) => {
        const mapIndex = state.maps.findIndex(({id}) => id === savedMap.id);
        if (mapIndex >= 0) state.maps.splice(mapIndex, 1, savedMap);
        const existingManagement = root.querySelector(".project-management");
        if (existingManagement) existingManagement.replaceWith(projectManagement(state, refresh));
      },
      refreshKmlNetworkLink: typeof adapter.refreshKmlNetworkLink === "function"
        ? (request, options) => adapter.refreshKmlNetworkLink(state.project.id, request, options)
        : null,
      prepareGeoLibreHandoff: adapter.kind === "api" && typeof adapter.getCompositionVersion === "function"
        ? async ({map}) => {
            await authorizeArchive();
            const retained = await geoLibreCall(() => adapter.getCompositionVersion(map.id, map.version));
            const baseMap = {...map, definition: retained.definition};
            const result = await createGeoLibreHandoff({projectId: state.project.id, map: baseMap,
              embeddedDataByLayerId: await handoffInputs(baseMap)});
            await authorizeArchive();
            return result;
          }
        : null,
      reviewGeoLibreReturn: adapter.kind === "api" && typeof adapter.getCompositionVersion === "function"
        ? async ({conversion}) => {
            await authorizeArchive();
            const generation = ++geoLibreReviewGeneration;
            const handoff = conversion.map.definition.extensions?.geolibre?.project?.metadata?.opengeo?.handoff;
            if (handoff?.projectId !== state.project.id || handoff.mapId !== currentMap.id
              || !Number.isSafeInteger(handoff.mapVersion) || handoff.mapVersion < 1) {
              throw Error("Open the originating OpenGeo Project to review these GeoLibre results.");
            }
            const [retained, latest] = await geoLibreCall(() => Promise.all([
              adapter.getCompositionVersion(handoff.mapId, handoff.mapVersion),
              adapter.getMap(state.project.id, currentMap.id)
            ]));
            const baseMap = {...latest, version: retained.version, definition: retained.definition};
            const result = await reviewGeoLibreReturn({conversion, projectId: state.project.id,
              baseMap, currentMap: latest, embeddedDataByLayerId: await handoffInputs(baseMap)});
            await authorizeArchive();
            if (generation !== geoLibreReviewGeneration) throw Error("A newer GeoLibre file is being reviewed.");
            geoLibreReview = {...result, baseMap, creationKey: crypto.randomUUID(), newMap: null};
            return result;
          }
        : null,
      applyGeoLibreImport: adapter.kind === "api"
        ? async ({conversion, sourceText, review = null, asNewMapName = null}) => {
            await authorizeArchive();
            let targetMap = currentMap;
            if (review) {
              if (!geoLibreReview || geoLibreReview.conversion !== conversion || geoLibreReview.review !== review) {
                throw Error("Review this return file again before saving its results.");
              }
              const latest = await geoLibreCall(() => adapter.getMap(state.project.id, currentMap.id));
              if (latest.version !== review.current.mapVersion || review.conflict && !asNewMapName) {
                throw Object.assign(Error("The Project has changed. Review the return file again or save the reviewed results as a new map."), {code: "map_version_conflict"});
              }
              if (asNewMapName) {
                geoLibreReview.newMap ??= await geoLibreCall(() => adapter.createMap(state.project.id, {
                  name: asNewMapName, definition: geoLibreReview.baseMap.definition,
                  creationKey: geoLibreReview.creationKey
                }));
                targetMap = geoLibreReview.newMap;
              } else targetMap = latest;
            }
            const result = await executeGeoLibreImport({
              adapter,
              projectId: state.project.id,
              mapId: targetMap.id,
              expectedMapVersion: targetMap.version,
              conversion,
              sourceText
            });
            if (targetMap.id !== currentMap.id) return {...result, mapId: targetMap.id};
            currentMap = await adapter.getMap(state.project.id, currentMap.id);
            await refresh();
            return result;
          }
        : null,
      saveProject: startBlank ? null : async (definition) => {
        currentMap = await adapter.updateMap(state.project.id, currentMap.id, {
          expectedVersion: currentMap.version,
          changes: {definition},
          changeMessage: "Browser map save"
        });
        return currentMap;
      },
      saveProjectAs: canEdit(state)
        ? ({name, definition, creationKey}) => adapter.createMap(state.project.id, {name, definition, ...(creationKey ? {creationKey} : {})})
        : null,
      importLocalFile: adapter.kind === "api" && canEdit(state)
        ? async (file, onStage, metadata = {}) => {
            const completion = await ingestManagedFile({
              adapter,
              projectId: state.project.id,
              file,
              ...metadata,
              onStage: (stage, message) => {
                root.dataset.importState = stage;
                onStage(stage, message);
              }
            });
            root.dataset.importState = "queued";
            importNotice = `${completion.dataset.name} is now a governed dataset queued at version ${completion.versionNumber}; the local file was not added as an untracked scratch layer.`;
            await refresh();
            return completion;
          }
        : null,
      ...(printPreview ? {restoreBrowserDraft: input.restoreBrowserDraft, saveProject: null, saveProjectAs: null, importLocalFile: null,
        registerSource: null, startSourceDiscovery: null, requestProtectedCopy: null, requestPmtilesDerivative: null,
        createAnalysisRegistration: null, applyGeoLibreImport: null, prepareGeoLibreHandoff: null,
        reviewGeoLibreReturn: null, projectSwitcher: null, onPublicationMapExport: null,
        canRequestProjectCompute: false} : {})
    });
  }

  function durableJobRoutes(state) {
    return {
      listProtectedCopies: typeof adapter.listProtectedCopies === "function"
        ? (source) => adapter.listProtectedCopies(
            state.project.id,
            source.datasetId,
            {limit: 100}
          )
        : null,
      cancelProtectedCopy: canEdit(state) && typeof adapter.cancelProtectedCopy === "function"
        ? (source, jobId) => adapter.cancelProtectedCopy(
            state.project.id,
            source.datasetId,
            jobId
          )
        : null,
      listPmtilesDerivatives: typeof adapter.listPmtilesDerivatives === "function"
        ? (dataset) => adapter.listPmtilesDerivatives(
            state.project.id,
            dataset.datasetId,
            dataset.currentVersionId,
            {limit: 100}
          )
        : null,
      cancelPmtilesDerivative: canEdit(state)
        && typeof adapter.cancelPmtilesDerivative === "function"
        ? (dataset, jobId) => adapter.cancelPmtilesDerivative(
            state.project.id,
            dataset.datasetId,
            dataset.currentVersionId,
            jobId
          )
        : null
    };
  }

  function hydrateDurableJobs(state, selection) {
    const routes = durableJobRoutes(state);
    const protectedScope = selection?.source
      ? `${selection.source.datasetId}@${selection.source.versionNumber}`
      : null;
    const pmtilesScope = selection?.dataset
      ? `${selection.dataset.datasetId}@${selection.dataset.currentVersionId}`
      : null;
    const scope = JSON.stringify([state.project.id, protectedScope, pmtilesScope]);
    // A manual refresh during initial loading reuses the same authorized read.
    if (durableJobRequest?.state === state && durableJobRequest.scope === scope) {
      return durableJobRequest.promise;
    }
    const generation = ++durableJobGeneration;
    const controller = startup;
    const current = () => !disposed && !isCancelled() && !controller?.signal.aborted
      && startup === controller && readyState === state && generation === durableJobGeneration;
    const result = () => ({protectedCopyJobs, pmtilesDerivativeJobs, message: durableJobsMessage});
    if (protectedScope !== protectedCopyJobScope) {
      protectedCopyJobScope = protectedScope;
      protectedCopyJobs.splice(0);
    }
    if (pmtilesScope !== pmtilesDerivativeJobScope) {
      pmtilesDerivativeJobScope = pmtilesScope;
      pmtilesDerivativeJobs.splice(0);
    }

    root.dataset.durableJobState = "loading";
    durableJobsMessage = "Loading saved jobs…";
    const promise = (async () => {
      const failures = [];
      let protectedRecords, pmtilesRecords;
      if (selection?.source && routes.listProtectedCopies) {
        try {
          protectedRecords = await routes.listProtectedCopies(selection.source);
        } catch {
          failures.push("protected copies");
        }
      }
      if (!current()) return result();
      if (selection?.dataset && routes.listPmtilesDerivatives) {
        try {
          pmtilesRecords = await routes.listPmtilesDerivatives(selection.dataset);
        } catch {
          failures.push("PMTiles derivatives");
        }
      }
      if (!current()) return result();
      if (protectedRecords !== undefined) replaceRecords(protectedCopyJobs, protectedRecords);
      if (pmtilesRecords !== undefined) replaceRecords(pmtilesDerivativeJobs, pmtilesRecords);
      root.dataset.durableJobState = failures.length ? "degraded" : "ready";
      durableJobsMessage = failures.length
        ? `Could not refresh ${failures.join(" and ")}; retained records remain visible.`
        : "Durable jobs refreshed from the server.";
      return result();
    })();
    durableJobRequest = {state, scope, promise};
    void promise.finally(() => {
      if (durableJobRequest?.promise === promise) durableJobRequest = null;
    });
    return promise;
  }

}

function projectApplicationSurface(
  state,
  refresh,
  activeSurface,
  featureTarget = null,
  siteResourceTarget = null,
  module
) {
  const shell = document.createElement("section");
  shell.className = "project-application-surface";
  shell.dataset.projectSurface = activeSurface;
  shell.append(projectHeader(state));
  if (activeSurface !== "publishing") shell.append(projectSections(state, activeSurface));

  const content = document.createElement("div");
  content.className = "project-application-content";
  content.id = `project-${activeSurface}`;
  content.dataset.studioSkipTarget = "";
  content.tabIndex = -1;
  content.setAttribute("role", "region");
  content.setAttribute("aria-label", activeSurface === "publishing" ? "Publication content" : "Project content");
  if (activeSurface === "data") {
    content.append(module.ProjectDatasets({state, refresh, featureTarget}));
  } else if (activeSurface === "discussions") {
    content.append(module.ProjectDiscussions({state, featureTarget}));
  } else if (activeSurface === "resources") {
    content.append(module.ProjectResources({state}));
  } else if (activeSurface === "services") {
    content.append(module.ProjectServices({state, refresh}));
  } else if (activeSurface === "publishing") {
    content.append(
      module.ProjectPublishingWorkspace({state, refresh, initialResourceTarget: siteResourceTarget})
    );
  } else if (activeSurface === "print") {
    content.append(module.ProjectPrintStudio({state}));
  } else {
    content.append(projectVisibilityPanel(state, refresh), module.ProjectLifecycleSettings({state, refresh}));
  }
  shell.append(content);
  return shell;
}

function projectHeader(state) {
  const header = document.createElement("header");
  header.className = "platform-project-header";
  const identity = document.createElement("div");
  identity.append(
    text("p", state.organization.name, "platform-eyebrow"),
    text("h1", state.publication?.title ?? state.project.name),
    text("p", state.publication ? state.publication.description ?? "No publication description"
      : state.project.description ?? "No project description", "platform-subtitle")
  );
  const controls = document.createElement("div");
  controls.className = "platform-project-controls";
  controls.append(
    badge(state.project.visibility ?? "internal"),
    badge(state.project.callerRole ?? state.organization.callerRole)
  );
  if (state.maps.length) {
    const select = document.createElement("select");
    select.ariaLabel = "Active map";
    for (const map of state.maps) {
      const option = document.createElement("option");
      option.value = map.id;
      option.textContent = `${map.name} · v${map.version}`;
      option.selected = map.id === state.selectedMap?.id;
      select.append(option);
    }
    select.addEventListener("change", () => {
      location.href = compositionHref(select.value, {adapterKind: state.adapter?.kind});
    });
    controls.append(select);
  }
  header.append(identity, controls);
  return header;
}

function projectVisibilityPanel(state, refresh) {
  const section = document.createElement("section");
  section.className = "project-visibility-settings";
  section.append(
    text("h2", "Access workspace visibility"),
    text(
      "p",
      "Workspace members keep their existing roles. This workspace marker does not publish its Projects or Publications; public delivery uses their reviewed editions or exports.",
      "platform-subtitle"
    )
  );
  const current = state.project.visibility ?? "internal";
  if (!(state.organization.callerRole === "admin" || state.project.callerRole === "owner")) {
    section.append(text("p", current === "published" ? "Published" : "Internal", `badge ${current}`));
    return section;
  }
  const form = document.createElement("form");
  form.className = "platform-inline-admin-form";
  const visibility = document.createElement("select");
  visibility.ariaLabel = "Access workspace visibility";
  for (const [value, label] of [["internal", "Internal"], ["published", "Published"]]) {
    const choice = document.createElement("option");
    choice.value = value;
    choice.textContent = label;
    choice.selected = value === current;
    visibility.append(choice);
  }
  const save = text("button", "Save visibility", "platform-button");
  save.type = "submit";
  const feedback = text(
    "p",
    current === "published"
      ? `Published${state.project.publishedAt ? ` ${new Date(state.project.publishedAt).toLocaleDateString()}` : ""}.`
      : "This project is visible only through its authorized organization and project roles.",
    "platform-note"
  );
  feedback.ariaLive = "polite";
  form.append(visibility, save, feedback);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    feedback.textContent = "Saving workspace visibility…";
    try {
      await state.adapter.updateProject(state.project.id, {visibility: visibility.value});
      await refresh();
    } catch (error) {
      feedback.textContent = `Workspace visibility was not saved (${error?.code ?? "unexpected_error"}).`;
      save.disabled = false;
    }
  });
  section.append(form);
  return section;
}

function projectSections(state, activeSurface = "maps") {
  const nav = document.createElement("nav");
  nav.className = "platform-project-sections";
  nav.ariaLabel = "Access workspace sections";
  for (const [id, label] of PROJECT_SECTIONS) {
    const href = id === "maps" && state.selectedMap
      ? compositionHref(state.selectedMap.id, {adapterKind: state.adapter?.kind})
      : id === "maps" ? projectHref(state.project.id, {
          adapterKind: state.adapter?.kind,
          mapId: state.selectedMap?.id ?? null,
          fragment: "map-workspace"
        })
      : projectHref(state.project.id, {adapterKind: state.adapter?.kind, management: id});
    const item = link(label, href, "project-section-link");
    if (id === activeSurface) item.setAttribute("aria-current", "page");
    nav.append(item);
  }
  return nav;
}

export function projectRouteBar(adapterKind = null, active = "projects") {
  return StudioNavigation({adapterKind, active});
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value));
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function emptyMaps(state, refresh) {
  const publicationProject = Boolean(state.sites?.length || state.observableSourceProjects?.length);
  const panel = document.createElement("section");
  panel.className = "platform-state platform-state-empty";
  panel.dataset.state = "empty";
  panel.dataset.projectUse = publicationProject ? "publication" : "unconfigured";
  panel.append(
    text("h2", publicationProject ? "Publication project" : "No maps yet"),
    text(
      "p",
      publicationProject
        ? "This durable project contains a publication workspace. Open Publishing to manage its source and sites, or add a Studio map when the publication needs one."
        : "This project is durable, but it does not have a persistent map or publication record."
    )
  );
  if (publicationProject) {
    panel.append(link(
      "Open publication workspace",
      projectHref(state.project.id, {
        adapterKind: state.adapter?.kind,
        management: "publishing"
      }),
      "platform-button secondary"
    ));
  }
  if (canEdit(state)) {
    const create = text("button", "Create first map", "platform-button");
    create.type = "button";
    create.addEventListener("click", async () => {
      create.disabled = true;
      create.textContent = "Creating…";
      try {
        await state.adapter.createMap(state.project.id, {
          name: `${state.project.name} map`,
          definition: emptyMapDefinition()
        });
        await refresh();
      } catch {
        create.disabled = false;
        create.textContent = "Retry map creation";
      }
    });
    panel.append(create);
  }
  return panel;
}

function canEdit(state) {
  return state.organization.callerRole === "admin"
    || ["owner", "editor"].includes(state.project.callerRole);
}

function activeDurableJobSelection(input, sources, {isProtectedCopySourceEligible, pmtilesJobDatasetForLayer}) {
  const activeLayer = input.layers.find(({layerId}) => layerId === input.project.activeLayerId)
    ?? input.layers[0]
    ?? null;
  const source = sources.find(({datasetId}) => datasetId === activeLayer?.datasetId);
  const dataset = input.datasets.find(({datasetId}) => datasetId === activeLayer?.datasetId);
  return {
    source: isProtectedCopySourceEligible(source) ? source : null,
    dataset: pmtilesJobDatasetForLayer(dataset, activeLayer)
  };
}

function replaceRecords(target, records) {
  const replacements = Array.isArray(records) ? [...records] : [];
  target.splice(0, target.length, ...replacements);
}

function fixtureWorkbenchInput(state, catalog, previewSources) {
  const binding = state.adapter.bindingForProject(state.project.id);
  if (!binding || !catalog) return apiWorkbenchInput(state);
  const fixtureWorkspace = catalog.workspaces.find((workspace) => workspace.workspaceId === binding.workspaceId);
  const definition = state.selectedMap.definition;
  const layerIds = new Set(
    Array.isArray(definition.layers)
      ? definition.layers.map((layer) => typeof layer === "string" ? layer : layer?.layerId).filter(Boolean)
      : []
  );
  const catalogLayers = catalog.layers.filter((layer) => layerIds.has(layer.layerId));
  const catalogLayerIds = new Set(catalogLayers.map((layer) => layer.layerId));
  const savedLayers = Array.isArray(definition.layers)
    ? definition.layers.filter((layer) => layer && typeof layer === "object" && !catalogLayerIds.has(layer.layerId))
    : [];
  const fixtureDatasets = catalog.datasets.filter(
    (dataset) => dataset.workspaceId === binding.workspaceId
  );
  const managedDatasets = state.datasets.map(managedWorkbenchDataset);
  const managedDatasetId = new Map(fixtureDatasets.map((dataset) => [
    dataset.datasetId,
    state.datasets.find((candidate) => candidate.name === dataset.title)?.id ?? dataset.datasetId
  ]));
  const layers = [...catalogLayers, ...savedLayers]
    .map((layer) => ({
      ...layer,
      datasetId: managedDatasetId.get(layer.datasetId) ?? layer.datasetId
    }))
    .map((layer) => resolveExternalSourceLayer(layer, state.sources ?? []));
  const datasets = managedDatasets;
  const objects = catalog.objects.filter((object) => object.workspaceId === binding.workspaceId);
  const workspace = {
    ...fixtureWorkspace,
    workspaceId: state.project.id,
    tenantId: state.organization.id,
    title: state.project.name,
    description: state.project.description,
    updatedAt: state.project.updatedAt
  };
  return {
    workspace,
    role: state.organization.callerRole === "admin" ? "admin" : state.project.callerRole ?? state.organization.callerRole,
    project: {...definition, workspaceId: state.project.id, updatedAt: state.selectedMap.updatedAt},
    workspaces: state.projects.map((project) => projectWorkspace(project, state.organization.id)),
    layers,
    datasets,
    allDatasets: managedDatasets,
    objects,
    allObjects: catalog.objects,
    layouts: catalog.layouts.filter((layout) => layout.workspaceId === binding.workspaceId),
    jobs: catalog.processingJobs.filter((job) => job.workspaceId === binding.workspaceId),
    storage: catalog.storage,
    sources: state.sources ?? [],
    geojsonByLayerId: new Map([...previewSources].filter(([layerId]) => layerIds.has(layerId)))
  };
}

function apiWorkbenchInput(state) {
  const definition = state.selectedMap.definition ?? {};
  const sources = state.sources ?? [];
  const layers = Array.isArray(definition.layers)
    ? definition.layers
      .filter((layer) => layer && typeof layer === "object")
      .map((layer) => resolveExternalSourceLayer(layer, sources))
    : [];
  return {
    workspace: projectWorkspace(state.project, state.organization.id),
    role: state.organization.callerRole === "admin" ? "admin" : state.project.callerRole ?? state.organization.callerRole,
    project: {
      ...definition,
      workspaceId: state.project.id,
      mapViews: Array.isArray(definition.mapViews) ? definition.mapViews : [],
      basemaps: Array.isArray(definition.basemaps) ? definition.basemaps : [],
      bookmarks: Array.isArray(definition.bookmarks) ? definition.bookmarks : [],
      updatedAt: state.selectedMap.updatedAt
    },
    workspaces: state.projects.map((project) => projectWorkspace(project, state.organization.id)),
    layers,
    datasets: state.datasets.map(managedWorkbenchDataset),
    allDatasets: state.datasets.map(managedWorkbenchDataset),
    objects: [],
    allObjects: [],
    layouts: [],
    jobs: [],
    sources,
    geojsonByLayerId: new Map()
  };
}

function resolveExternalSourceLayer(layer, sources) {
  const source = sources.find((candidate) => candidate.datasetId === layer.datasetId);
  if (!source) return layer;
  const useSavedRevision = layer.sourceVersion
    && layer.sourceVersion !== source.versionNumber
    && layer.sourceUrl
    && layer.sourceConfiguration;
  const sourceUrl = useSavedRevision ? layer.sourceUrl : source.sourceUrl;
  const configuration = useSavedRevision ? layer.sourceConfiguration : source.configuration;
  const sourceType = source.sourceType === "pmtiles"
    ? `pmtiles-${configuration.tileType}`
    : source.sourceType === "geojson" ? "geojson-archive"
    : ["arcgis", "wfs"].includes(source.sourceType) ? "external-feature-reference"
    : `${source.sourceType}-raster`;
  return {
    ...layer,
    sourceType,
    sourceVersion: useSavedRevision ? layer.sourceVersion : source.versionNumber,
    sourceUrl,
    sourceConfiguration: configuration,
    tileUrl: source.sourceType === "wms"
      ? wmsTileUrl(sourceUrl, configuration)
      : source.sourceType === "mapserver" ? mapServerTileUrl(sourceUrl, configuration)
    : source.sourceType === "imageserver" ? imageServerTileUrl(sourceUrl, configuration)
      : ["xyz", "pmtiles"].includes(source.sourceType) ? sourceUrl : undefined,
    sourceLayer: configuration.sourceLayer ?? layer.sourceLayer,
    tileSize: configuration.tileSize,
    scheme: configuration.scheme,
    attribution: configuration.attribution,
    minZoom: configuration.minZoom,
    maxZoom: configuration.maxZoom,
    geometryType: configuration.geometryType ?? layer.geometryType ?? "Raster",
    bbox: configuration.bounds ?? layer.bbox,
    governedSource: true
  };
}

function wmsTileUrl(endpoint, configuration) {
  const parameters = new URLSearchParams({
    SERVICE: "WMS",
    REQUEST: "GetMap",
    VERSION: configuration.version,
    LAYERS: configuration.layers.join(","),
    STYLES: configuration.styles.join(","),
    FORMAT: configuration.imageFormat,
    TRANSPARENT: configuration.transparent ? "TRUE" : "FALSE",
    WIDTH: String(configuration.tileSize),
    HEIGHT: String(configuration.tileSize),
    BBOX: "{bbox-epsg-3857}",
    [configuration.version === "1.3.0" ? "CRS" : "SRS"]: configuration.crs
  });
  return `${endpoint}?${parameters}`.replaceAll("%7B", "{").replaceAll("%7D", "}");
}

function managedWorkbenchDataset(dataset) {
  return {
    datasetId: dataset.id,
    workspaceId: dataset.projectId,
    title: dataset.name,
    description: dataset.description,
    sourceType: dataset.sourceType,
    format: dataset.format,
    datasetType: ["csv"].includes(dataset.format) ? "table" : "spatial",
    geometryType: dataset.geometryType,
    status: dataset.status,
    currentVersionState: dataset.currentVersionState,
    capabilities: dataset.capabilities,
    classification: dataset.classification,
    currentVersion: dataset.currentVersionNumber ? `v${dataset.currentVersionNumber}` : null,
    currentVersionNumber: dataset.currentVersionNumber,
    currentVersionId: dataset.currentVersionId,
    bbox: dataset.extent,
    featureCount: dataset.featureCount,
    crs: dataset.crs,
    tags: dataset.tags,
    createdBy: dataset.ownerUserId,
    createdAt: dataset.createdAt,
    updatedAt: dataset.updatedAt
  };
}

function projectWorkspace(project, organizationId = null) {
  return {
    workspaceId: project.id,
    tenantId: organizationId,
    title: project.name,
    description: project.description,
    status: project.status,
    classification: "internal",
    updatedAt: project.updatedAt
  };
}

function badge(value) {
  return text("span", value, `badge ${value}`);
}

function text(tag, value, className = "") {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

function link(label, href, className = "") {
  const element = text("a", label, className);
  element.href = href;
  return element;
}
